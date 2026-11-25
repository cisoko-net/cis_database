'use strict';

// oxmysql 2.14.3 parity through the public include: every call shape oxmysql
// accepts, run as a Lua resource runs it (MySQL.* from lib/MySQL.lua under
// stock Lua 5.4) against the real exports of server.js on node:sqlite. Each
// result is checked against what oxmysql returns for the same call.
//
// The shapes come from oxmysql at v2.14.3 (lib/MySQL.lua safeArgs and
// aliases; src/index.ts; src/utils/parseArguments.ts, parseExecute.ts,
// parseResponse.ts, parseTransaction.ts; src/database/rawQuery.ts,
// rawExecute.ts, rawTransaction.ts) and from the calls es_extended, qb-core
// and qbx_core make. The expected values are oxmysql's: parseResponse for
// query, single, scalar, insert and update; rawExecute's unpacking for
// prepare (one set and one row of one column gives the value, one row gives
// the row, several rows give the rows, several sets give one result per set,
// a write gives the insert id or the rows changed) and for rawExecute (the
// rows or the result header); true or false for a transaction, which never
// raises once it has parsed.
//
// The Lua process reaches node over its stdin and stdout: each export call is
// one line out and one reply in, and the callbacks node calls are queued and
// run when the Lua side next pumps, as FiveM runs them on its next tick.
// Values cross as FiveM's msgpack carries them: nil is null, a table with keys
// 1..n is an array, any other table is an object with string keys, and a nil
// in a row is a missing key.
//
// One intentional difference is not checked: oxmysql's prepare answers nil for
// a lowercase insert, update or delete (executeType reads the first word as
// written); cis_database answers the insert id or the rows changed.
// Usage: node tests/repro/oxmysql_parity.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const includePath = path.resolve(path.join(__dirname, '../../lib/MySQL.lua'));

function findLua() {
    const candidates = process.env.LUA ? [process.env.LUA] : ['lua', 'lua5.4'];
    for (const c of candidates) {
        const r = spawnSync(c, ['-v'], { encoding: 'utf8' });
        if (!r.error && r.status === 0) return c;
    }
    return null;
}
const lua = findLua();
if (!lua) {
    console.log('SKIP: no lua');
    process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-parity-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec([
    'CREATE TABLE users (identifier VARCHAR(64) PRIMARY KEY, money INT NOT NULL, job VARCHAR(32), ssn VARCHAR(16))',
    "INSERT INTO users VALUES ('a', 10, 'police', NULL), ('b', 20, 'police', NULL), ('c', 30, 'ems', NULL)",
    'CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, msg VARCHAR(64), n INT)',
    'CREATE TABLE items (name VARCHAR(50) PRIMARY KEY, label VARCHAR(50), weight INT, rare TINYINT, can_remove TINYINT)',
    "INSERT INTO items VALUES ('bread', 'Bread', 1, 0, 1)",
    'CREATE TABLE player_groups (citizenid VARCHAR(50), type VARCHAR(50), `group` VARCHAR(50), grade INT, PRIMARY KEY (citizenid, type, `group`))',
    'CREATE TABLE players (citizenid VARCHAR(50) PRIMARY KEY, license VARCHAR(255), cid INT)',
    "INSERT INTO players VALUES ('C1', 'lic1', 1), ('C2', 'lic1', 2)",
].join(';\n'));
m.close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;
process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: 'mysql://root@127.0.0.1/fake', cis_database_cdc: '0' });

const fx = require('../harness/fx.js');
const r = fx.registry;

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

// JSON with sorted object keys, so equal values print the same.
function canon(v) {
    if (v === undefined) return 'null';
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    return JSON.stringify(v);
}
// want's keys and items only: a result header has more fields than a call checks.
function within(want, got) {
    if (Array.isArray(want)) return Array.isArray(got) && got.length === want.length && want.every((w, i) => within(w, got[i]));
    if (want && typeof want === 'object') return !!got && typeof got === 'object' && Object.keys(want).every((k) => within(want[k], got[k]));
    return canon(want) === canon(got);
}

// ---- Node to Lua: values as Lua literals -----------------------------------

function litStr(s) {
    let out = '"';
    for (const c of Buffer.from(String(s), 'utf8')) out += c < 32 || c > 126 || c === 34 || c === 92 ? '\\' + String(c).padStart(3, '0') : String.fromCharCode(c);
    return out + '"';
}
function lit(v) {
    if (v === null || v === undefined || typeof v === 'function' || typeof v === 'symbol') return 'nil';
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'bigint') return String(v);
    if (typeof v === 'number') {
        if (Number.isNaN(v)) return '(0/0)';
        if (!Number.isFinite(v)) return v > 0 ? 'math.huge' : '-math.huge';
        return Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER ? String(v) : v.toPrecision(17);
    }
    if (typeof v === 'string') return litStr(v);
    if (typeof v.then === 'function') return 'nil';
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return litStr(Buffer.from(v).toString('latin1'));
    if (v instanceof Date) return litStr(v.toISOString());
    if (Array.isArray(v)) return '{' + Array.from(v, lit).join(',') + '}';
    const parts = [];
    for (const k of Object.keys(v)) if (v[k] !== null && v[k] !== undefined) parts.push('[' + litStr(k) + ']=' + lit(v[k]));
    return '{' + parts.join(',') + '}';
}

// ---- The Lua side ----------------------------------------------------------

const PRELUDE = String.raw`
local INCLUDE = %INCLUDE%
RES = %RES%

local fns, fnIds = {}, {}
local function enc(v)
    local t = type(v)
    if v == nil then return 'null' end
    if t == 'boolean' then return tostring(v) end
    if t == 'number' then
        if math.type(v) == 'integer' then return tostring(v) end
        if v ~= v or v == math.huge or v == -math.huge then return 'null' end
        return string.format('%.17g', v)
    end
    if t == 'string' then return '"' .. v:gsub('[%c"\\]', function(c) return string.format('\\u%04x', c:byte()) end) .. '"' end
    if t == 'function' then
        local id = fnIds[v]
        if not id then id = #fns + 1; fns[id] = v; fnIds[v] = id end
        return '{"__fn":' .. id .. '}'
    end
    if t == 'table' then
        local n, max, ints = 0, 0, true
        for k in pairs(v) do
            n = n + 1
            if math.type(k) == 'integer' and k > 0 then if k > max then max = k end else ints = false end
        end
        if n == 0 then return '[]' end
        if ints and max == n then
            local out = {}
            for i = 1, n do out[i] = enc(v[i]) end
            return '[' .. table.concat(out, ',') .. ']'
        end
        local keys = {}
        for k in pairs(v) do keys[#keys + 1] = k end
        table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
        local out = {}
        for _, k in ipairs(keys) do out[#out + 1] = enc(tostring(k)) .. ':' .. enc(v[k]) end
        return '{' .. table.concat(out, ',') .. '}'
    end
    return '"<' .. t .. '>"'
end

local function send(s) io.stdout:write(s, '\n'); io.stdout:flush() end
local function recv()
    local line = io.stdin:read('l')
    if not line then os.exit(3) end
    line = line:gsub('\r$', '')
    return line:sub(1, 1), assert(load('return ' .. line:sub(3), 'reply', 't'))()
end
function emit(name, v) send('@@emit\t' .. name .. '\t' .. enc(v)) end

-- exports.cis_database.<name>(self, ...) runs the export in node.
local function jsCall(name, ...)
    local parts = {}
    for i = 1, select('#', ...) do parts[i] = enc((select(i, ...))) end
    send('@@call\t{"m":' .. enc(name) .. ',"args":[' .. table.concat(parts, ',') .. ']}')
    local kind, v = recv()
    if kind == 'E' then error(v, 2) end
    return v
end
exports = setmetatable({}, { __index = function(_, res)
    if res ~= 'cis_database' then return nil end
    return setmetatable({}, { __index = function(_, k) return function(_, ...) return jsCall(k, ...) end end })
end })

threadErrors = {}
-- Runs the callbacks node called since the last pump.
local function pump()
    send('@@pump')
    local _, events = recv()
    for _, e in ipairs(events) do
        local f = fns[e[1]]
        if f then
            local ok, err = pcall(f, table.unpack(e[2], 1, e[3]))
            if not ok then threadErrors[#threadErrors + 1] = tostring(err) end
        end
    end
end

states = { cis_database = 'started' }
function GetCurrentResourceName() return RES end
function GetResourceState(n) return states[n] or 'missing' end
metadata = { mysql_option = %OPTS% }
function GetNumResourceMetadata(r, k) return r == RES and metadata[k] and #metadata[k] or 0 end
function GetResourceMetadata(r, k, i) return r == RES and metadata[k] and metadata[k][i + 1] or nil end
handlers = {}
function AddEventHandler(n, f) handlers[n] = handlers[n] or {}; table.insert(handlers[n], f) end

threads = {}
local function step(co)
    local ok, err = coroutine.resume(co)
    if not ok then threadErrors[#threadErrors + 1] = tostring(err) end
end
function CreateThread(f)
    local co = coroutine.create(f)
    threads[#threads + 1] = co
    step(co)
end
Citizen = { CreateThread = CreateThread, CreateThreadNow = CreateThread }
local function tick()
    for _, co in ipairs({ table.unpack(threads) }) do
        if coroutine.status(co) == 'suspended' then step(co) end
    end
end
function Wait() coroutine.yield() end
function GetGameTimer() return 0 end

promise = {}
function promise.new() return setmetatable({ state = 'pending' }, { __index = promise }) end
function promise:resolve(v) if self.state == 'pending' then self.state = 'resolved'; self.value = v end end
function promise:reject(e) if self.state == 'pending' then self.state = 'rejected'; self.value = e end end
function Citizen.Await(p)
    while p.state == 'pending' do coroutine.yield() end
    if p.state == 'rejected' then error(p.value, 0) end
    return p.value
end

-- One shape: its value, or the error it raised.
function case(name, f)
    local ok, v = pcall(f)
    if ok then emit(name, { ok = true, v = v }) else emit(name, { ok = false, err = tostring(v) }) end
end
-- A callback form: what the callback got, or nocb when it was never called.
function viaCb(start)
    local got, a1, a2 = false
    start(function(x, y) got, a1, a2 = true, x, y end)
    for _ = 1, 250 do
        if got then break end
        Wait()
    end
    if not got then return { nocb = true } end
    return { a1 = a1, a2 = a2 }
end

dofile(INCLUDE)
local finished = false
CreateThread(function()
    local ok, err = pcall(BODY)
    if not ok then emit('__body', tostring(err)) end
    finished = true
end)
for _ = 1, 200000 do
    if finished then break end
    tick()
    pump()
end
emit('__threads', threadErrors)
send('@@end')
`;

// Runs one Lua resource: res is its name, opts its mysql_option list, cases
// the shapes. Resolves with { name: { ok, v | err } }.
function runLua(res, opts, cases) {
    const body = 'function BODY()\n' + cases.map(([name, , , code]) => 'case(' + litStr(name) + ', function() ' + code + ' end)').join('\n') + '\nend\n';
    const src = PRELUDE.replace('%INCLUDE%', () => JSON.stringify(includePath.replace(/\\/g, '/')))
        .replace('%RES%', () => litStr(res)).replace('%OPTS%', () => lit(opts));
    // BODY must exist before the main loop at the end of the prelude runs.
    const file = path.join(dir, res + '.lua');
    fs.writeFileSync(file, body + src);
    return new Promise((resolve) => {
        const child = spawn(lua, [file], { stdio: ['pipe', 'pipe', 'pipe'] });
        const out = {};
        let stderr = '';
        const events = [];
        const proxies = new Map();
        const proxy = (id) => {
            if (!proxies.has(id)) proxies.set(id, (...a) => { events.push('{' + id + ',' + lit(a) + ',' + a.length + '}'); });
            return proxies.get(id);
        };
        const decode = (v) => {
            if (Array.isArray(v)) return v.map(decode);
            if (v && typeof v === 'object') {
                const keys = Object.keys(v);
                if (keys.length === 1 && typeof v.__fn === 'number') return proxy(v.__fn);
                const o = {};
                for (const k of keys) o[k] = decode(v[k]);
                return o;
            }
            return v;
        };
        const reply = (s) => { if (!child.stdin.destroyed) child.stdin.write(s + '\n'); };
        child.stderr.on('data', (d) => { stderr += d; });
        readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (raw) => {
            const line = raw.replace(/\r$/, '');
            if (line.startsWith('@@call\t')) {
                const msg = JSON.parse(line.slice(7));
                const fn = r[msg.m];
                if (typeof fn !== 'function') return reply('E ' + litStr('No such export ' + msg.m + ' in resource cis_database'));
                global.__fxInvoker = res;
                try {
                    const ret = fn(...decode(msg.args));
                    if (ret && typeof ret.then === 'function') ret.then(null, () => {});
                    reply('R ' + lit(ret));
                } catch (e) {
                    reply('E ' + litStr(e && e.message || e));
                }
            } else if (line === '@@pump') {
                setTimeout(() => reply('P {' + events.splice(0).join(',') + '}'), 1);
            } else if (line.startsWith('@@emit\t')) {
                const rest = line.slice(7);
                const tab = rest.indexOf('\t');
                try { out[rest.slice(0, tab)] = JSON.parse(rest.slice(tab + 1)); } catch (e) { out[rest.slice(0, tab)] = { ok: false, err: 'bad emit: ' + e.message }; }
            } else if (line === '@@end') {
                child.stdin.end();
            }
        });
        child.on('close', (code) => { out.__code = code; out.__stderr = stderr.trim(); resolve(out); });
    });
}

// ---- The shapes ------------------------------------------------------------
// [name, how, want, lua]. how: eq (the same value), sub (want's fields and
// items), err (raised, with want in the message), nocb (the callback never ran),
// cberr (the callback got nil and a message containing want).

const Q = (s) => JSON.stringify(s);
const ins = 'INSERT INTO logs (msg, n) VALUES (?, ?)';
const esxItem = 'INSERT IGNORE INTO items (name, label, weight, rare, can_remove) VALUES (?, ?, ?, ?, ?)';
const qbxGroup = 'INSERT INTO player_groups (citizenid, type, `group`, grade) VALUES (:citizenid, :type, :group, :grade) ON DUPLICATE KEY UPDATE grade = :grade';

const MAIN = [
    // query: parseArguments, then the rows (a write gives its header)
    ['query no params', 'eq', [{ identifier: 'a', money: 10 }, { identifier: 'b', money: 20 }, { identifier: 'c', money: 30 }], 'return MySQL.query.await("SELECT identifier, money FROM users ORDER BY identifier")'],
    ['query positional', 'eq', [{ identifier: 'b' }, { identifier: 'c' }], 'return MySQL.query.await("SELECT identifier FROM users WHERE money >= ? ORDER BY identifier", {20})'],
    ['query no rows is an empty list', 'eq', [], 'return MySQL.query.await("SELECT identifier FROM users WHERE money > ?", {999})'],
    ['query @name with @key', 'eq', [{ money: 10 }], 'return MySQL.query.await("SELECT money FROM users WHERE identifier = @id", {["@id"] = "a"})'],
    ['query :name with bare key', 'eq', [{ money: 20 }], 'return MySQL.query.await("SELECT money FROM users WHERE identifier = :id", {id = "b"})'],
    ['query :name with :key', 'eq', [{ money: 30 }], 'return MySQL.query.await("SELECT money FROM users WHERE identifier = :id", {[":id"] = "c"})'],
    ['query @name with bare key', 'eq', [{ money: 10 }], 'return MySQL.query.await("SELECT money FROM users WHERE identifier = @id", {id = "a"})'],
    ['query one name twice', 'eq', [{ identifier: 'b' }], 'return MySQL.query.await("SELECT identifier FROM users WHERE money >= :m AND money <= :m", {m = 20})'],
    ['query missing name is null', 'eq', [], 'return MySQL.query.await("SELECT identifier FROM users WHERE job = :job", {other = 1})'],
    ['query fewer values are padded with null', 'eq', [{ a: 1 }], 'return MySQL.query.await("SELECT ? AS a, ? AS b", {1})'],
    ['query more values than placeholders raises', 'err', 'Expected 1 parameters, but received 2', 'return MySQL.query.await("SELECT ? AS a", {1, 2})'],
    ['query values with no placeholder are ignored', 'eq', [{ n: 1 }], 'return MySQL.query.await("SELECT 1 AS n", {5})'],
    ['query nil in the middle', 'eq', [{ b: 2 }], 'return MySQL.query.await("SELECT ? AS a, ? AS b", {nil, 2})'],
    ['query numbered keys beside a name', 'eq', [{ a: 7 }], 'return MySQL.query.await("SELECT ? AS a", {[1] = 7, x = "z"})'],
    ['query IN list', 'eq', [{ identifier: 'a' }, { identifier: 'c' }], 'return MySQL.query.await("SELECT identifier FROM users WHERE identifier IN (?) ORDER BY identifier", {{"a", "c"}})'],
    ['query of a write gives its header', 'sub', { affectedRows: 2, insertId: 0 }, 'return MySQL.query.await("UPDATE users SET money = money WHERE job = ?", {"police"})'],
    ['query boolean value', 'eq', [{ b: 1 }], 'return MySQL.query.await("SELECT ? AS b", {true})'],
    ['query nil params', 'eq', [{ n: 3 }], 'return MySQL.query.await("SELECT COUNT(*) AS n FROM users", nil)'],
    ['query stored query', 'eq', [{ money: 20 }], 'local id = MySQL.store("SELECT money FROM users WHERE identifier = ?"); return MySQL.query.await(id, {"b"})'],
    ['query (sql, cb)', 'eq', { a1: [{ n: 3 }] }, 'return viaCb(function(cb) MySQL.query("SELECT COUNT(*) AS n FROM users", cb) end)'],
    ['query (sql, nil, cb)', 'eq', { a1: [{ n: 3 }] }, 'return viaCb(function(cb) MySQL.query("SELECT COUNT(*) AS n FROM users", nil, cb) end)'],
    ['query (sql, params, cb)', 'eq', { a1: [{ money: 30 }] }, 'return viaCb(function(cb) MySQL.query("SELECT money FROM users WHERE identifier = ?", {"c"}, cb) end)'],
    ['MySQL.Sync.fetchAll', 'eq', [{ money: 10 }], 'return MySQL.Sync.fetchAll("SELECT money FROM users WHERE identifier = ?", {"a"})'],
    ['MySQL.Async.fetchAll', 'eq', { a1: [{ money: 10 }] }, 'return viaCb(function(cb) MySQL.Async.fetchAll("SELECT money FROM users WHERE identifier = ?", {"a"}, cb) end)'],
    ['MySQL.Sync.fetchScalar', 'eq', 20, 'return MySQL.Sync.fetchScalar("SELECT money FROM users WHERE identifier = ?", {"b"})'],
    ['MySQL.Sync.fetchSingle', 'eq', { money: 30 }, 'return MySQL.Sync.fetchSingle("SELECT money FROM users WHERE identifier = ?", {"c"})'],
    ['MySQL.Sync.execute', 'eq', 1, 'return MySQL.Sync.execute("UPDATE users SET money = money WHERE identifier = ?", {"a"})'],
    ['MySQL.Async.execute', 'eq', { a1: 1 }, 'return viaCb(function(cb) MySQL.Async.execute("UPDATE users SET money = money WHERE identifier = ?", {"a"}, cb) end)'],

    // single: the first row or nil
    ['single row', 'eq', { identifier: 'a', money: 10 }, 'return MySQL.single.await("SELECT identifier, money FROM users WHERE identifier = ?", {"a"})'],
    ['single no row is nil', 'eq', null, 'return MySQL.single.await("SELECT identifier FROM users WHERE identifier = ?", {"zz"})'],
    ['single of many rows is the first', 'eq', { identifier: 'a' }, 'return MySQL.single.await("SELECT identifier FROM users ORDER BY identifier")'],
    ['single callback', 'eq', { a1: { identifier: 'b', money: 20 } }, 'return viaCb(function(cb) MySQL.single("SELECT identifier, money FROM users WHERE identifier = ?", {"b"}, cb) end)'],

    // scalar: the first column of the first row or nil
    ['scalar COUNT', 'eq', 3, 'return MySQL.scalar.await("SELECT COUNT(*) FROM users")'],
    ['scalar no row is nil', 'eq', null, 'return MySQL.scalar.await("SELECT money FROM users WHERE identifier = ?", {"zz"})'],
    ['scalar zero', 'eq', 0, 'return MySQL.scalar.await("SELECT COUNT(*) FROM users WHERE money > ?", {999})'],
    ['scalar NULL is nil', 'eq', null, 'return MySQL.scalar.await("SELECT ssn FROM users WHERE identifier = ?", {"a"})'],
    ['scalar string', 'eq', 'ems', 'return MySQL.scalar.await("SELECT job FROM users WHERE identifier = ?", {"c"})'],
    ['scalar callback through pcall (es_extended save)', 'eq', { a1: 1 }, 'return viaCb(function(cb) pcall(MySQL.scalar, "SELECT COUNT(*) FROM users WHERE identifier = ?", {"a"}, cb) end)'],

    // prepare reads
    ['prepare one row', 'eq', { citizenid: 'C1', license: 'lic1', cid: 1 }, 'return MySQL.prepare.await("SELECT * FROM players WHERE citizenid = ?", {"C1"})'],
    ['prepare COUNT is the value (qb-core createUniqueId)', 'eq', 0, 'return MySQL.prepare.await("SELECT COUNT(*) FROM players WHERE citizenid = ?", {"NEW"})'],
    ['prepare no row is nil', 'eq', null, 'return MySQL.prepare.await("SELECT cid FROM players WHERE citizenid = ?", {"zz"})'],
    ['prepare many rows are the rows', 'eq', [{ citizenid: 'C1' }, { citizenid: 'C2' }], 'return MySQL.prepare.await("SELECT citizenid FROM players WHERE license = ? ORDER BY citizenid", {"lic1"})'],
    ['prepare lowercase select', 'eq', 2, 'return MySQL.prepare.await("select cid from players where citizenid = ?", {"C2"})'],
    ['prepare nil params', 'eq', 2, 'return MySQL.prepare.await("SELECT COUNT(*) FROM players")'],
    ['prepare one nested set', 'eq', 1, 'return MySQL.prepare.await("SELECT cid FROM players WHERE citizenid = ?", {{"C1"}})'],
    ['prepare two sets', 'eq', [[{ cid: 1 }], [{ cid: 2 }]], 'return MySQL.prepare.await("SELECT cid FROM players WHERE citizenid = ?", {{"C1"}, {"C2"}})'],
    ['prepare a set with no row', 'eq', [[{ cid: 1 }], []], 'return MySQL.prepare.await("SELECT cid FROM players WHERE citizenid = ?", {{"C1"}, {"zz"}})'],
    ['prepare padded row of two columns', 'eq', { a: 1 }, 'return MySQL.prepare.await("SELECT ? AS a, ? AS b", {1})'],
    ['prepare callback', 'eq', { a1: { citizenid: 'C2', license: 'lic1', cid: 2 } }, 'return viaCb(function(cb) MySQL.prepare("SELECT * FROM players WHERE citizenid = ?", {"C2"}, cb) end)'],

    // rawExecute reads: the rows as the driver returns them
    ['rawExecute one row', 'eq', [{ cid: 1 }], 'return MySQL.rawExecute.await("SELECT cid FROM players WHERE citizenid = ?", {"C1"})'],
    ['rawExecute many rows', 'eq', [{ cid: 1 }, { cid: 2 }], 'return MySQL.rawExecute.await("SELECT cid FROM players WHERE license = ? ORDER BY cid", {"lic1"})'],
    ['rawExecute no row', 'eq', [], 'return MySQL.rawExecute.await("SELECT cid FROM players WHERE citizenid = ?", {"zz"})'],
    ['rawExecute two sets', 'eq', [[{ cid: 1 }], [{ cid: 2 }]], 'return MySQL.rawExecute.await("SELECT cid FROM players WHERE citizenid = ?", {{"C1"}, {"C2"}})'],

    // update: rows matched
    ['update rows', 'eq', 2, 'return MySQL.update.await("UPDATE users SET money = money WHERE job = ?", {"police"})'],
    ['update none', 'eq', 0, 'return MySQL.update.await("UPDATE users SET money = money WHERE job = ?", {"nobody"})'],
    ['update named', 'eq', 1, 'return MySQL.update.await("UPDATE users SET job = :job WHERE identifier = :id", {job = "ems", id = "c"})'],
    ['update callback', 'eq', { a1: 2 }, 'return viaCb(function(cb) MySQL.update("UPDATE users SET money = money WHERE job = ?", {"police"}, cb) end)'],
    ['update DELETE none', 'eq', 0, 'return MySQL.update.await("DELETE FROM users WHERE identifier = ?", {"zz"})'],

    // insert: the insert id, 0 when nothing got one
    ['insert', 'eq', 1, 'return MySQL.insert.await(' + Q(ins) + ', {"one", 1})'],
    ['insert callback', 'eq', { a1: 2 }, 'return viaCb(function(cb) MySQL.insert(' + Q(ins) + ', {"two", 2}, cb) end)'],
    ['insert named', 'eq', 3, 'return MySQL.insert.await("INSERT INTO logs (msg, n) VALUES (:msg, :n)", {msg = "three", n = 3})'],
    ['MySQL.Sync.insert', 'eq', 4, 'return MySQL.Sync.insert(' + Q(ins) + ', {"four", 4})'],
    ['insert IGNORE of a duplicate is 0', 'eq', 0, 'return MySQL.insert.await(' + Q(esxItem) + ', {"bread", "Bread", 1, false, true})'],
    ['insert into a table with no auto id is 0', 'eq', 0, 'return MySQL.insert.await("INSERT INTO items (name, label, weight, rare, can_remove) VALUES (?, ?, ?, ?, ?)", {"water", "Water", 1, false, true})'],
    ['insert stored booleans as 0 and 1', 'eq', { rare: 0, can_remove: 1 }, 'return MySQL.single.await("SELECT rare, can_remove FROM items WHERE name = ?", {"water"})'],
    ['insert ON DUPLICATE KEY with one name twice (qbx_core)', 'eq', 0, 'return MySQL.insert.await(' + Q(qbxGroup) + ', {citizenid = "C1", type = "job", group = "police", grade = 2})'],
    ['insert ON DUPLICATE KEY again', 'eq', 0, 'return MySQL.insert.await(' + Q(qbxGroup) + ', {citizenid = "C1", type = "job", group = "police", grade = 3})'],
    ['insert ON DUPLICATE KEY updated the row', 'eq', 3, 'return MySQL.scalar.await("SELECT grade FROM player_groups WHERE citizenid = ?", {"C1"})'],

    // prepare writes: the insert id or rows changed, per set
    ['prepare UPDATE', 'eq', 1, 'return MySQL.prepare.await("UPDATE users SET money = ? WHERE identifier = ?", {10, "a"})'],
    ['prepare UPDATE none', 'eq', 0, 'return MySQL.prepare.await("UPDATE users SET money = ? WHERE identifier = ?", {10, "zz"})'],
    ['prepare UPDATE callback (es_extended save)', 'eq', { a1: 1 }, 'return viaCb(function(cb) MySQL.prepare("UPDATE users SET money = ? WHERE identifier = ?", {20, "b"}, cb) end)'],
    ['prepare INSERT', 'eq', 5, 'return MySQL.prepare.await(' + Q(ins) + ', {"five", 5})'],
    ['prepare INSERT sets', 'eq', [6, 7], 'return MySQL.prepare.await(' + Q(ins) + ', {{"six", 6}, {"seven", 7}})'],
    ['prepare INSERT IGNORE sets (es_extended items)', 'eq', [0, 0], 'return MySQL.prepare.await(' + Q(esxItem) + ', {{"bread", "Bread", 1, false, true}, {"phone", "Phone", 1, false, true}})'],
    ['prepare UPDATE sets (es_extended ssn)', 'eq', [1, 1, 0], 'return MySQL.prepare.await("UPDATE users SET ssn = ? WHERE identifier = ? AND ssn IS NULL", {{"111", "a"}, {"222", "b"}, {"333", "zz"}})'],
    ['prepare DELETE', 'eq', 1, 'return MySQL.prepare.await("DELETE FROM logs WHERE n = ?", {7})'],
    ['prepare sets padded with null', 'eq', [8, 9], 'return MySQL.prepare.await(' + Q(ins) + ', {{"pad1"}, {"pad2"}})'],

    // rawExecute writes: the result header, one per set
    ['rawExecute INSERT', 'sub', { affectedRows: 1, insertId: 10 }, 'return MySQL.rawExecute.await(' + Q(ins) + ', {"ten", 10})'],
    ['rawExecute INSERT sets', 'sub', [{ affectedRows: 1, insertId: 11 }, { affectedRows: 1, insertId: 12 }], 'return MySQL.rawExecute.await(' + Q(ins) + ', {{"e11", 11}, {"e12", 12}})'],
    ['rawExecute UPDATE', 'sub', { affectedRows: 2 }, 'return MySQL.rawExecute.await("UPDATE logs SET msg = ? WHERE n >= ?", {"big", 11})'],

    // transaction: true on commit, false on rollback
    ['transaction tuples', 'eq', true, 'return MySQL.transaction.await({{"UPDATE users SET money = money + ? WHERE identifier = ?", {1, "a"}}, {"UPDATE users SET money = money - ? WHERE identifier = ?", {1, "a"}}})'],
    ['transaction query and values (qbx_core)', 'eq', true, 'return MySQL.transaction.await({{query = "UPDATE users SET money = money WHERE identifier = ?", values = {"a"}}})'],
    ['transaction query and parameters', 'eq', true, 'return MySQL.transaction.await({{query = "UPDATE users SET money = money WHERE identifier = ?", parameters = {"b"}}})'],
    ['transaction strings with shared params', 'eq', true, 'return MySQL.transaction.await({"UPDATE users SET money = money WHERE identifier = @id", "UPDATE users SET money = money WHERE identifier = @id"}, {["@id"] = "a"})'],
    ['transaction named values', 'eq', true, 'return MySQL.transaction.await({{query = "UPDATE users SET money = money WHERE identifier = :id", values = {id = "c"}}})'],
    ['transaction tuple with names', 'eq', true, 'return MySQL.transaction.await({{"UPDATE users SET money = money WHERE identifier = @id", {["@id"] = "b"}}})'],
    ['transaction IN list', 'eq', true, 'return MySQL.transaction.await({{"UPDATE users SET money = money WHERE identifier IN (?)", {{"a", "b"}}}})'],
    ['transaction failure is false', 'eq', false, 'return MySQL.transaction.await({{"UPDATE users SET money = 99 WHERE identifier = ?", {"b"}}, {"INSERT INTO nope_table (x) VALUES (?)", {1}}})'],
    ['transaction failure rolled back', 'eq', 20, 'return MySQL.scalar.await("SELECT money FROM users WHERE identifier = ?", {"b"})'],
    ['transaction failure callback is false', 'eq', { a1: false }, 'return viaCb(function(cb) MySQL.transaction({{"INSERT INTO nope_table (x) VALUES (?)", {1}}}, cb) end)'],
    ['transaction callback (qb-core delete)', 'eq', { a1: true }, 'return viaCb(function(cb) MySQL.transaction({{query = "DELETE FROM logs WHERE n = ?", values = {99}}}, cb) end)'],
    ['transaction empty list', 'eq', true, 'return MySQL.transaction.await({})'],
    ['MySQL.Sync.transaction', 'eq', true, 'return MySQL.Sync.transaction({{query = "UPDATE users SET money = money WHERE identifier = ?", values = {"a"}}})'],
    ['MySQL.Async.transaction', 'eq', { a1: true }, 'return viaCb(function(cb) MySQL.Async.transaction({{query = "UPDATE users SET money = money WHERE identifier = ?", values = {"a"}}}, cb) end)'],

    // errors: .await raises, a plain callback is never called
    ['query.await error raises', 'err', 'nope_table', 'return MySQL.query.await("SELECT * FROM nope_table")'],
    ['single.await error raises', 'err', 'nope_table', 'return MySQL.single.await("SELECT * FROM nope_table")'],
    ['scalar.await error raises', 'err', 'nope_table', 'return MySQL.scalar.await("SELECT x FROM nope_table")'],
    ['update.await error raises', 'err', 'nope_table', 'return MySQL.update.await("UPDATE nope_table SET x = 1")'],
    ['insert.await error raises', 'err', 'nope_table', 'return MySQL.insert.await("INSERT INTO nope_table (x) VALUES (1)")'],
    ['prepare.await error raises', 'err', 'nope_table', 'return MySQL.prepare.await("SELECT x FROM nope_table WHERE x = ?", {1})'],
    ['prepare.await sets error raises', 'err', 'nope_table', 'return MySQL.prepare.await("INSERT INTO nope_table (x) VALUES (?)", {{1}, {2}})'],
    ['rawExecute.await error raises', 'err', 'nope_table', 'return MySQL.rawExecute.await("SELECT x FROM nope_table")'],
    ['query callback error is not called', 'nocb', null, 'return viaCb(function(cb) MySQL.query("SELECT * FROM nope_table", {}, cb) end)'],
    ['prepare callback error is not called', 'nocb', null, 'return viaCb(function(cb) MySQL.prepare("SELECT x FROM nope_table WHERE x = ?", {1}, cb) end)'],
    ['insert callback error is not called', 'nocb', null, 'return viaCb(function(cb) MySQL.insert("INSERT INTO nope_table (x) VALUES (1)", {}, cb) end)'],
    ['a query that is not a string raises', 'err', 'boolean', 'return MySQL.query.await(true)'],
];

// A resource with mysql_option 'return_callback_errors': cb(nil, message).
const OPTED = [
    ['opted query callback error', 'cberr', 'nope_table', 'return viaCb(function(cb) MySQL.query("SELECT * FROM nope_table", {}, cb) end)'],
    ['opted update callback error', 'cberr', 'nope_table', 'return viaCb(function(cb) MySQL.update("UPDATE nope_table SET x = 1", {}, cb) end)'],
    ['opted insert callback error', 'cberr', 'nope_table', 'return viaCb(function(cb) MySQL.insert("INSERT INTO nope_table (x) VALUES (1)", {}, cb) end)'],
    ['opted prepare callback error', 'cberr', 'nope_table', 'return viaCb(function(cb) MySQL.prepare("SELECT x FROM nope_table WHERE x = ?", {1}, cb) end)'],
    ['opted query callback still gets rows', 'eq', { a1: [{ n: 3 }] }, 'return viaCb(function(cb) MySQL.query("SELECT COUNT(*) AS n FROM users", cb) end)'],
];

function judge(prefix, cases, out) {
    for (const [name, how, want] of cases) {
        const got = out[name];
        const label = prefix + name;
        if (!got) { check(label, false, 'no result'); continue; }
        const shown = got.ok ? canon(got.v) : 'raised ' + JSON.stringify(got.err);
        if (how === 'eq') check(label, got.ok && canon(got.v) === canon(want), shown);
        else if (how === 'sub') check(label, got.ok && within(want, got.v), shown);
        else if (how === 'err') check(label, !got.ok && String(got.err).includes(want), shown);
        else if (how === 'nocb') check(label, got.ok && got.v && got.v.nocb === true, shown);
        else if (how === 'cberr') check(label, got.ok && got.v && got.v.a1 == null && typeof got.v.a2 === 'string' && got.v.a2.includes(want), shown);
    }
    if (out.__body) check(prefix + 'the Lua body ran to its end', false, out.__body);
    if (out.__threads && out.__threads.length) check(prefix + 'no thread raised', false, JSON.stringify(out.__threads));
    if (out.__code !== 0) check(prefix + 'lua exited 0', false, 'code ' + out.__code + ' ' + out.__stderr.slice(0, 400));
}

// The JS exports oxmysql answers with a promise (src/index.ts async_exp:
// <name>_async and <name>Sync), and the names it provides for mysql-async and
// ghmattimysql (src/compatibility).
async function jsShapes() {
    global.__fxInvoker = 'parity_js';
    // FiveM hands a caller the promise an export returns as __cfx_async_retval
    // (done(values, err)); the caller's runtime turns it back into a promise.
    const unwrap = (v) => (v && typeof v.__cfx_async_retval === 'function'
        ? new Promise((res, rej) => v.__cfx_async_retval((vals, err) => (err ? rej(new Error(err)) : res(vals && vals[0]))))
        : v);
    const settle = (p) => Promise.resolve(p).then(unwrap).then((v) => ({ ok: true, v }), (e) => ({ ok: false, err: String(e && e.message || e) }));
    const exp = (resource, name) => {
        let fn = null;
        global.emit('__cfx_export_' + resource + '_' + name, (f) => { fn = f; });
        return fn;
    };
    const viaCb = (start) => new Promise((resolve) => {
        const t = setTimeout(() => resolve({ nocb: true }), 2000);
        start((a1, a2) => { clearTimeout(t); resolve(a2 === undefined ? { a1 } : { a1, a2 }); });
    });
    const shapes = [
        ['query_async', 'eq', [{ n: 3 }], () => settle(r.query_async('SELECT COUNT(*) AS n FROM users', []))],
        ['querySync', 'eq', [{ n: 3 }], () => settle(r.querySync('SELECT COUNT(*) AS n FROM users'))],
        ['single_async', 'eq', { money: 10 }, () => settle(r.single_async('SELECT money FROM users WHERE identifier = ?', ['a']))],
        ['scalar_async', 'eq', 30, () => settle(r.scalar_async('SELECT money FROM users WHERE identifier = ?', ['c']))],
        ['update_async', 'eq', 2, () => settle(r.update_async('UPDATE users SET money = money WHERE job = ?', ['police']))],
        ['insert_async', 'eq', 13, () => settle(r.insert_async('INSERT INTO logs (msg, n) VALUES (?, ?)', ['js', 13]))],
        ['prepare_async', 'eq', 1, () => settle(r.prepare_async('SELECT cid FROM players WHERE citizenid = ?', ['C1']))],
        ['rawExecute_async', 'eq', [{ cid: 2 }], () => settle(r.rawExecute_async('SELECT cid FROM players WHERE citizenid = ?', ['C2']))],
        ['transaction_async', 'eq', true, () => settle(r.transaction_async([{ query: 'UPDATE users SET money = money WHERE identifier = ?', values: ['a'] }]))],
        ['query_async error rejects', 'err', 'nope_table', () => settle(r.query_async('SELECT * FROM nope_table', []))],
        ['mysql-async mysql_fetch_all', 'eq', { a1: [{ money: 20 }] }, () => settle(viaCb((cb) => exp('mysql-async', 'mysql_fetch_all')('SELECT money FROM users WHERE identifier = ?', ['b'], cb)))],
        ['mysql-async mysql_fetch_scalar', 'eq', { a1: 3 }, () => settle(viaCb((cb) => exp('mysql-async', 'mysql_fetch_scalar')('SELECT COUNT(*) FROM users', [], cb)))],
        ['mysql-async mysql_execute', 'eq', { a1: 2 }, () => settle(viaCb((cb) => exp('mysql-async', 'mysql_execute')('UPDATE users SET money = money WHERE job = ?', ['police'], cb)))],
        ['mysql-async mysql_insert', 'eq', { a1: 14 }, () => settle(viaCb((cb) => exp('mysql-async', 'mysql_insert')('INSERT INTO logs (msg, n) VALUES (?, ?)', ['js', 14], cb)))],
        ['mysql-async mysql_transaction', 'eq', { a1: true }, () => settle(viaCb((cb) => exp('mysql-async', 'mysql_transaction')([{ query: 'UPDATE users SET money = money WHERE identifier = ?', values: ['a'] }], cb)))],
        ['ghmattimysql execute', 'eq', { a1: [{ money: 30 }] }, () => settle(viaCb((cb) => exp('ghmattimysql', 'execute')('SELECT money FROM users WHERE identifier = ?', ['c'], cb)))],
        ['ghmattimysql executeSync', 'eq', [{ money: 30 }], () => settle(exp('ghmattimysql', 'executeSync')('SELECT money FROM users WHERE identifier = ?', ['c']))],
        ['ghmattimysql scalar', 'eq', { a1: 3 }, () => settle(viaCb((cb) => exp('ghmattimysql', 'scalar')('SELECT COUNT(*) FROM users', [], cb)))],
        ['ghmattimysql scalarSync', 'eq', 3, () => settle(exp('ghmattimysql', 'scalarSync')('SELECT COUNT(*) FROM users', []))],
        ['ghmattimysql transaction', 'eq', { a1: true }, () => settle(viaCb((cb) => exp('ghmattimysql', 'transaction')(['UPDATE users SET money = money WHERE identifier = @id'], { '@id': 'a' }, cb)))],
    ];
    for (const [name, how, want, run] of shapes) {
        let got;
        try { got = await run(); } catch (e) { got = { ok: false, err: 'threw ' + (e && e.message || e) }; }
        const shown = got.ok ? canon(got.v) : 'raised ' + JSON.stringify(got.err);
        if (how === 'eq') check('js ' + name, got.ok && canon(got.v) === canon(want), shown);
        else check('js ' + name, !got.ok && got.err.includes(want), shown);
        await new Promise((res) => setTimeout(res, 10));
    }
}

(async () => {
    if (!(await fx.ready(20000))) throw new Error('not ready');
    judge('', MAIN, await runLua('parity_res', [], MAIN));
    judge('', OPTED, await runLua('parity_opt', ['return_callback_errors'], OPTED));
    await jsShapes();
    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
