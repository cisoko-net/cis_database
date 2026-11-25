'use strict';

// lib/MySQL.lua, the consumer include, run under stock Lua 5.4 with FiveM
// stubbed out: exports.cis_database records every call, promise and
// Citizen.Await behave like the runtime's (a rejected promise raises), and
// threads are coroutines the test steps by hand. Each scenario is a fresh
// Lua process, because the include caches the driver.
// Usage: node tests/repro/mysql_include.js
//        MYSQL_INCLUDE=/path/to/MySQL.lua node tests/repro/mysql_include.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const includePath = path.resolve(process.env.MYSQL_INCLUDE || path.join(__dirname, '../../lib/MySQL.lua'));

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

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

// ---- The Lua side ----------------------------------------------------------

const PRELUDE = String.raw`
local INCLUDE = %INCLUDE%

-- JSON-ish output: one "@@name<TAB>value" line per emit.
local function enc(v)
    local t = type(v)
    if v == nil then return 'null' end
    if t == 'boolean' or t == 'number' then return tostring(v) end
    if t == 'string' then return '"' .. v:gsub('[%c"\\]', function(c) return string.format('\\u%04x', c:byte()) end) .. '"' end
    if t == 'table' then
        local n = 0
        for _ in pairs(v) do n = n + 1 end
        if n == 0 then return '[]' end
        if #v == n then
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
function emit(name, v) io.write('@@', name, '\t', enc(v), '\n') end

-- The runtime.
RES = 'test_res'
states = { cis_database = 'started' }
function GetCurrentResourceName() return RES end
function GetResourceState(n) return states[n] or 'missing' end
metadata = {}
function GetNumResourceMetadata(r, k) return r == RES and metadata[k] and #metadata[k] or 0 end
function GetResourceMetadata(r, k, i) return r == RES and metadata[k] and metadata[k][i + 1] or nil end
handlers = {}
function AddEventHandler(n, f) handlers[n] = handlers[n] or {}; table.insert(handlers[n], f) end
function fire(n, ...) for _, f in ipairs(handlers[n] or {}) do f(...) end end

threads = {}
threadErrors = {}
local function step(co)
    local ok, err = coroutine.resume(co)
    if not ok then threadErrors[#threadErrors + 1] = tostring(err) end
end
function CreateThread(f)
    local co = coroutine.create(f)
    threads[#threads + 1] = co
    step(co)
end
-- Citizen.CreateThreadNow runs f at once, up to its first yield. The FiveM
-- runtime has no global CreateThreadNow, so neither does this one.
Citizen = { CreateThread = CreateThread, CreateThreadNow = CreateThread }
function tick()
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
Citizen = Citizen or {}
function Citizen.Await(p)
    while p.state == 'pending' do
        if not coroutine.isyieldable() then error('Citizen.Await would block the main chunk', 2) end
        coroutine.yield()
    end
    if p.state == 'rejected' then error(p.value, 0) end
    return p.value
end

-- exports.<resource>:<name>(...) is recorded; behave[name](args) answers it.
calls = {}
behave = {}
missing = {}
function reset() calls = {} end
function callsTo(name)
    local out = {}
    for _, c in ipairs(calls) do if c.name == name then out[#out + 1] = c end end
    return out
end
function isFn(v) return type(v) == 'function' or (type(v) == 'table' and v.__cfx_functionReference ~= nil) end
-- The callback of a recorded call: argument 4 (query, params, cb) or 3.
function cbOf(args)
    if isFn(args[4]) then return args[4] end
    if isFn(args[3]) then return args[3] end
end
local function makeDriver(resource)
    return setmetatable({}, { __index = function(_, k)
        return function(...)
            local args = { ... }
            calls[#calls + 1] = { res = resource, name = k, n = select('#', ...), args = args }
            if missing[resource .. '.' .. k] then error('No such export ' .. k .. ' in resource ' .. resource, 2) end
            local b = behave[k]
            if b then return b(args) end
            local cb = cbOf(args)
            if cb then cb('res:' .. k) end
            return 'ret:' .. k
        end
    end })
end
exports = { cis_database = makeDriver('cis_database'), oxmysql = makeDriver('oxmysql') }

function loadInclude() dofile(INCLUDE) end
-- The first .await asks the driver for the fast path (cis_register) once.
function warm() behave.cis_register = function() return false end; pcall(MySQL.Sync.fetchAll, 'SELECT 0'); behave.cis_register = nil; reset() end
function try(f, ...) local ok, err = pcall(f, ...); return ok, (not ok) and tostring(err) or nil end
`;

function runScenario(name, body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-mysqlinc-'));
    const file = path.join(dir, name + '.lua');
    fs.writeFileSync(file, PRELUDE.replace('%INCLUDE%', () => JSON.stringify(includePath.replace(/\\/g, '/'))) + '\n' + body);
    const r = spawnSync(lua, [file], { encoding: 'utf8', timeout: 30000 });
    fs.rmSync(dir, { recursive: true, force: true });
    const out = {};
    for (const line of (r.stdout || '').split(/\r?\n/)) {
        if (!line.startsWith('@@')) continue;
        const tab = line.indexOf('\t');
        try { out[line.slice(2, tab)] = JSON.parse(line.slice(tab + 1)); } catch (e) { out[line.slice(2, tab)] = undefined; }
    }
    out.__failed = r.status !== 0 || !!r.error;
    out.__stderr = (r.stderr || '').trim() + (r.error ? String(r.error) : '');
    return out;
}

const METHODS = ['query', 'single', 'scalar', 'update', 'insert', 'prepare', 'rawExecute', 'transaction'];

// ---- 1. Methods and the callable form --------------------------------------

const callable = runScenario('callable', String.raw`
loadInclude()
local methods = { 'query', 'single', 'scalar', 'update', 'insert', 'prepare', 'rawExecute', 'transaction' }
emit('has_global', type(MySQL) == 'table')
for _, m in ipairs(methods) do
    reset()
    local got
    local cb = function(r) got = r end
    local ret = MySQL[m]('SELECT ?', { 7 }, cb)
    local c = calls[1] or { args = {}, n = 0 }
    emit('m_' .. m, {
        count = #calls, name = c.name, n = c.n, selfNil = c.args[1] == nil, q = c.args[2], p = c.args[3],
        cbSame = c.args[4] == cb, res = c.args[5], flag = c.args[6], got = got, ret = ret,
        hasAwait = isFn(MySQL[m].await), callable = isFn(MySQL[m]) or getmetatable(MySQL[m]) ~= nil,
    })
end

-- parameters omitted, callback in position 2
reset()
local got2
local cb2 = function(r) got2 = r end
MySQL.query('SELECT 1', cb2)
local c = calls[1]
emit('omitted_params', { p = c.args[3], pIsTable = type(c.args[3]) == 'table', cbSame = c.args[4] == cb2, got = got2, n = c.n })

-- nothing but the query
reset()
local ok, err = try(MySQL.single, 'SELECT 1')
c = calls[1]
emit('only_query', { ok = ok, err = err, pIsTable = c and type(c.args[3]) == 'table', cbNil = c and c.args[4] == nil, count = #calls })

-- parameters, no callback
reset()
ok, err = try(MySQL.single, 'SELECT ?', { 1, 2 })
c = calls[1]
emit('params_no_cb', { ok = ok, p = c and c.args[3], cbNil = c and c.args[4] == nil })

-- explicit nil callback after parameters
reset()
ok = try(MySQL.scalar, 'SELECT ?', { 1 }, nil)
emit('nil_cb', { ok = ok, count = #calls })

-- a function reference from another resource
local refGot
local ref = setmetatable({ __cfx_functionReference = 'ref:1' }, { __call = function(self, r) refGot = r end })
reset()
ok, err = try(MySQL.query, 'SELECT 1', {}, ref)
c = calls[1]
emit('ref_cb', { ok = ok, err = err, same = c and c.args[4] == ref, got = refGot })
reset()
refGot = nil
ok, err = try(MySQL.query, 'SELECT 1', ref)
c = calls[1]
emit('ref_params', { ok = ok, err = err, cbSame = c and c.args[4] == ref, pEmpty = c and type(c.args[3]) == 'table' and next(c.args[3]) == nil, got = refGot })

-- bad queries
local bad = {}
for _, v in ipairs({ 123, true, function() end }) do
    reset()
    local o, e = try(MySQL.query, v)
    bad[#bad + 1] = { type = type(v), ok = o, err = e, count = #calls }
end
reset()
local o, e = try(MySQL.query)
bad[#bad + 1] = { type = 'nil', ok = o, err = e, count = #calls }
reset()
o, e = try(MySQL.query, { 'SELECT 1' })
bad[#bad + 1] = { type = 'table', ok = o, err = e, count = #calls }
emit('bad_query', bad)

-- transaction takes a list or a string, nothing else
local txList = { { 'UPDATE a SET b = ?', { 1 } }, { 'UPDATE c SET d = ?', { 2 } } }
reset()
ok, err = try(MySQL.transaction, txList)
c = calls[1]
emit('tx_list', { ok = ok, err = err, same = c and c.args[2] == txList })
reset()
ok, err = try(MySQL.transaction, 'UPDATE a SET b = 1')
emit('tx_string', { ok = ok, err = err, count = #calls })
reset()
ok, err = try(MySQL.transaction, 42)
emit('tx_number', { ok = ok, err = err, count = #calls })
reset()
ok, err = try(MySQL.transaction.await, 42)
emit('tx_number_await', { ok = ok, err = err, count = #calls })
reset()
ok, err = try(MySQL.transaction, txList, { 5 }, function() end)
emit('tx_shared_params', { ok = ok, p = calls[1] and calls[1].args[3] })

-- a plain table, a number or a string where the callback goes
reset()
local o1, e1 = try(MySQL.query, 'SELECT 1', {}, {})
local o2, e2 = try(MySQL.query, 'SELECT 1', {}, 'cb')
local o3, e3 = try(MySQL.query, 'SELECT 1', 5)
local o4, e4 = try(MySQL.query, 'SELECT 1', 'x')
emit('bad_cb', { plainTable = { o1, e1 }, str = { o2, e2 }, numParams = { o3, e3 }, strParams = { o4, e4 }, count = #calls })

-- the call returns what the export returned
reset()
emit('returns_export', MySQL.insert('INSERT INTO t VALUES (1)'))
emit('thread_errors', threadErrors)
`);
check('callable run completes', !callable.__failed, callable.__stderr);
for (const m of METHODS) {
    const r = callable['m_' + m] || {};
    check('MySQL.' + m + ' calls the ' + m + ' export as (nil, sql, params, cb, resource, false)',
        r.count === 1 && r.name === m && r.n === 6 && r.selfNil && r.q === 'SELECT ?' && Array.isArray(r.p) && r.p[0] === 7
        && r.cbSame && r.res === 'test_res' && r.flag === false && r.got === 'res:' + m && r.ret === 'ret:' + m,
        JSON.stringify(r));
    check('MySQL.' + m + ' has .await', r.hasAwait === true);
}
check('MySQL is a global table', callable.has_global === true);
check('params omitted, callback in position 2: params become empty, cb is passed',
    callable.omitted_params && callable.omitted_params.pIsTable && callable.omitted_params.cbSame && callable.omitted_params.got === 'res:query' && callable.omitted_params.n === 6,
    JSON.stringify(callable.omitted_params));
check('only a query is fine, params empty and cb nil',
    callable.only_query && callable.only_query.ok && callable.only_query.pIsTable && callable.only_query.cbNil && callable.only_query.count === 1, JSON.stringify(callable.only_query));
check('params without a callback are passed as given', callable.params_no_cb && callable.params_no_cb.ok && callable.params_no_cb.cbNil
    && JSON.stringify(callable.params_no_cb.p) === '[1,2]', JSON.stringify(callable.params_no_cb));
check('an explicit nil callback is fine', callable.nil_cb && callable.nil_cb.ok && callable.nil_cb.count === 1);
check('a function reference table works as callback (review L2)',
    callable.ref_cb && callable.ref_cb.ok && callable.ref_cb.same && callable.ref_cb.got === 'res:query', JSON.stringify(callable.ref_cb));
check('a function reference table in the params position is the callback, params empty (review L2)',
    callable.ref_params && callable.ref_params.ok && callable.ref_params.cbSame && callable.ref_params.pEmpty && callable.ref_params.got === 'res:query',
    JSON.stringify(callable.ref_params));
const bq = callable.bad_query || [];
check('a query that is not a string raises and names what arrived, with no export call',
    bq.length === 5 && bq.every((b) => b.ok === false && b.count === 0 && typeof b.err === 'string' && b.err.indexOf(b.type) >= 0), JSON.stringify(bq));
check('transaction accepts a list of queries and passes the table through', callable.tx_list && callable.tx_list.ok && callable.tx_list.same, JSON.stringify(callable.tx_list));
check('transaction accepts a string', callable.tx_string && callable.tx_string.ok && callable.tx_string.count === 1);
check('transaction with a number raises', callable.tx_number && callable.tx_number.ok === false && /number/.test(callable.tx_number.err) && callable.tx_number.count === 0, JSON.stringify(callable.tx_number));
check('transaction.await with a number raises too', callable.tx_number_await && callable.tx_number_await.ok === false && callable.tx_number_await.count === 0, JSON.stringify(callable.tx_number_await));
check('transaction passes shared parameters', callable.tx_shared_params && callable.tx_shared_params.ok && JSON.stringify(callable.tx_shared_params.p) === '[5]');
const bc = callable.bad_cb || {};
check('a plain table in the callback position is an error', bc.plainTable && bc.plainTable[0] === false && typeof bc.plainTable[1] === 'string', JSON.stringify(bc.plainTable));
check('a string callback, a number or a string for params are errors, and nothing is called',
    bc.str && bc.str[0] === false && bc.numParams && bc.numParams[0] === false && bc.strParams && bc.strParams[0] === false && bc.count === 0, JSON.stringify(bc));
check('the call returns what the export returned', callable.returns_export === 'ret:insert');
check('no thread errors', Array.isArray(callable.thread_errors) && callable.thread_errors.length === 0);

// mysql_option 'return_callback_errors' in the caller's fxmanifest: the
// callback forms ask the driver for errors, as oxmysql's include does.
const opted = runScenario('opted', String.raw`
metadata.mysql_option = { 'return_callback_errors' }
loadInclude()
MySQL.query('SELECT 1', {}, function() end)
emit('flag', { flag = calls[1] and calls[1].args[6], n = calls[1] and calls[1].n })
`);
check('mysql_option return_callback_errors makes the callback forms send true', opted.flag && opted.flag.flag === true && opted.flag.n === 6, JSON.stringify(opted.flag) + opted.__stderr);

// ---- 2. .await without the fast path ---------------------------------------

const awaits = runScenario('await', String.raw`
loadInclude()
local methods = { 'query', 'single', 'scalar', 'update', 'insert', 'prepare', 'rawExecute', 'transaction' }
for _, m in ipairs(methods) do
    reset()
    local ok, v = pcall(MySQL[m].await, 'SELECT ?', { 3 })
    local c
    for _, x in ipairs(calls) do if x.name == m then c = x end end
    emit('aw_' .. m, { ok = ok, v = v, q = c and c.args[2], p = c and c.args[3], cbFn = c and type(c.args[4]) == 'function', n = c and c.n,
        res = c and c.args[5], flag = c and c.args[6], selfNil = c and c.args[1] == nil })
end

-- params omitted
reset()
local ok = pcall(MySQL.query.await, 'SELECT 1')
emit('aw_omitted', { ok = ok, pIsTable = calls[1] and type(calls[1].args[3]) == 'table' and next(calls[1].args[3]) == nil })

-- rejected answer: callback receives (nil, message)
behave.query = function(args) cbOf(args)(nil, 'boom') end
reset()
local ok2, err2 = try(MySQL.query.await, 'SELECT 1')
emit('aw_rejected', { ok = ok2, err = err2 })
-- false, message as the engine's callback form reports it
behave.single = function(args) cbOf(args)(false, 'bad sql') end
local ok3, err3 = try(MySQL.single.await, 'SELECT 1')
emit('aw_rejected_false', { ok = ok3, err = err3 })
-- an empty error string is no error
behave.scalar = function(args) cbOf(args)(5, '') end
local ok4, v4 = pcall(MySQL.scalar.await, 'SELECT 1')
emit('aw_empty_err', { ok = ok4, v = v4 })
-- a false result is a result
behave.transaction = function(args) cbOf(args)(false) end
local ok5, v5 = pcall(MySQL.transaction.await, { 'UPDATE a SET b = 1' })
emit('aw_false', { ok = ok5, v = v5 })
-- a bad query raises before anything is sent
reset()
local ok6, err6 = try(MySQL.update.await, 99)
emit('aw_bad_query', { ok = ok6, err = err6, count = #calls })
emit('thread_errors', threadErrors)
`);
check('await run completes', !awaits.__failed, awaits.__stderr);
for (const m of METHODS) {
    const r = awaits['aw_' + m] || {};
    check('MySQL.' + m + '.await goes through the export and returns its answer',
        r.ok === true && r.v === 'res:' + m && r.q === 'SELECT ?' && r.p && r.p[0] === 3 && r.cbFn && r.n === 6 && r.res === 'test_res' && r.flag === true && r.selfNil,
        JSON.stringify(r));
}
check('.await with params omitted sends empty params', awaits.aw_omitted && awaits.aw_omitted.ok && awaits.aw_omitted.pIsTable);
check('.await raises the error of a rejected answer', awaits.aw_rejected && awaits.aw_rejected.ok === false && /boom/.test(awaits.aw_rejected.err), JSON.stringify(awaits.aw_rejected));
check('.await raises on (false, message) too', awaits.aw_rejected_false && awaits.aw_rejected_false.ok === false && /bad sql/.test(awaits.aw_rejected_false.err), JSON.stringify(awaits.aw_rejected_false));
check('an empty error string is not an error', awaits.aw_empty_err && awaits.aw_empty_err.ok && awaits.aw_empty_err.v === 5);
check('a false result comes back as false', awaits.aw_false && awaits.aw_false.ok && awaits.aw_false.v === false);
check('.await with a bad query raises and sends nothing', awaits.aw_bad_query && awaits.aw_bad_query.ok === false && awaits.aw_bad_query.count === 0, JSON.stringify(awaits.aw_bad_query));

// ---- 3. .await fast path (cis_register / cis_call) --------------------------

const fast = runScenario('fast', String.raw`
loadInclude()
local registered, regVersion, regCount = nil, nil, 0
local mode = function() return { 1, 'fast' } end
behave.cis_register = function(args) registered = args[2]; regVersion = args[3]; regCount = regCount + 1; return true end
behave.cis_call = function(args) return mode(args) end

local function await(m, ...) local ok, v = pcall(MySQL[m].await, ...); return ok, v end

-- done at once
reset()
local ok, v = await('scalar', 'SELECT COUNT(*) FROM t', { 1 })
local cc = callsTo('cis_call')[1]
emit('fast_done', { ok = ok, v = v, nCalls = #callsTo('cis_call'), exportCalls = #callsTo('scalar'), regCount = regCount, regVersion = regVersion,
    regIsFn = type(registered) == 'function', selfNil = cc and cc.args[1] == nil, method = cc and cc.args[2], q = cc and cc.args[3], p = cc and cc.args[4], n = cc and cc.n })

-- registers once
await('query', 'SELECT 1')
emit('fast_registered_once', { regCount = regCount })

-- failed
mode = function() return { 2, 'bad thing' } end
local ok2, v2 = await('query', 'SELECT 1')
emit('fast_failed', { ok = ok2, v = v2 })

-- held back, answered through the resolver
mode = (function() local id = 40; return function() id = id + 1; return { 0, id } end end)()
local r1, r2
local e2
CreateThread(function() local ok, v = pcall(MySQL.query.await, 'SELECT 1'); r1 = { ok, v } end)
CreateThread(function() local ok, v = pcall(MySQL.single.await, 'SELECT 2'); r2 = { ok, v } end)
local beforeAnswer = (r1 == nil) and (r2 == nil)
registered(41, 'late')
registered(42, nil, 'oops')
tick()
emit('fast_held', { pendingBefore = beforeAnswer, r1 = r1, r2 = r2 })

-- a batch: (0, n, ids, results, errors)
mode = (function() local id = 50; return function() id = id + 1; return { 0, id } end end)()
local b1, b2, b3
CreateThread(function() local ok, v = pcall(MySQL.query.await, 'A'); b1 = { ok, v } end)
CreateThread(function() local ok, v = pcall(MySQL.query.await, 'B'); b2 = { ok, v } end)
CreateThread(function() local ok, v = pcall(MySQL.query.await, 'C'); b3 = { ok, v } end)
registered(0, 3, { 51, 52, 53 }, { 'a', 'b' }, { [3] = 'third failed' })
tick()
emit('fast_batch', { b1 = b1, b2 = b2, b3 = b3 })
-- an answer for an unknown id changes nothing
emit('fast_unknown_id', { ok = pcall(registered, 999, 'x') })

-- the resolver is lost: the call takes the callback path, the next one registers again
mode = function() return { 3 } end
reset()
local ok3, v3 = await('query', 'SELECT 1')
emit('fast_lost', { ok = ok3, v = v3, exportCalls = #callsTo('query'), regCount = regCount })
mode = function() return { 1, 'again' } end
local ok4, v4 = await('query', 'SELECT 1')
emit('fast_reregister', { ok = ok4, v = v4, regCount = regCount })

-- startTransaction is not a cis_call method: it takes the export
reset()
local nBefore = #callsTo('cis_call')
local ok6, v6 = await('startTransaction', function() end)
emit('fast_skips_store', { ok6 = ok6, v6 = v6, cisCalls = #callsTo('cis_call') - nBefore, stCalls = #callsTo('startTransaction') })

-- the stopping-state guard
mode = function() return { 0, 77 } end
local s1
CreateThread(function() local ok, v = pcall(MySQL.query.await, 'SELECT 1'); s1 = { ok, v } end)
fire('onResourceStop', 'cis_database')   -- spoofed: the resource is still started
tick()
local afterSpoof = s1 == nil
states.cis_database = 'stopping'
fire('onResourceStop', 'cis_database')
tick()
emit('fast_stop_guard', { pendingAfterSpoof = afterSpoof, s1 = s1 })

-- a start of the driver drops the cached fast path
states.cis_database = 'started'
fire('onResourceStart', 'cis_database')
mode = function() return { 1, 'after restart' } end
local regBefore = regCount
local ok7, v7 = await('query', 'SELECT 1')
emit('fast_restart', { ok = ok7, v = v7, registeredAgain = regCount - regBefore })
emit('thread_errors', threadErrors)
`);
check('fast path run completes', !fast.__failed, fast.__stderr);
const fd = fast.fast_done || {};
check('.await calls cis_call(nil, method, sql, params) and returns [1, result], without the method export',
    fd.ok && fd.v === 'fast' && fd.nCalls === 1 && fd.exportCalls === 0 && fd.selfNil && fd.method === 'scalar' && fd.q === 'SELECT COUNT(*) FROM t' && fd.p && fd.p[0] === 1 && fd.n === 4, JSON.stringify(fd));
check('one resolver is registered with version 2, once', fd.regIsFn && fd.regVersion === 2 && fast.fast_registered_once && fast.fast_registered_once.regCount === 1, JSON.stringify(fast.fast_registered_once));
check('[2, message] raises', fast.fast_failed && fast.fast_failed.ok === false && /bad thing/.test(fast.fast_failed.v), JSON.stringify(fast.fast_failed));
const fh = fast.fast_held || {};
check('[0, id] waits for the resolver, then returns the result or raises the error', fh.pendingBefore && fh.r1 && fh.r1[0] === true && fh.r1[1] === 'late' && fh.r2 && fh.r2[0] === false && /oops/.test(fh.r2[1]), JSON.stringify(fh));
const fb = fast.fast_batch || {};
check('a batched answer settles each call, with its own result or error',
    fb.b1 && fb.b1[0] === true && fb.b1[1] === 'a' && fb.b2 && fb.b2[0] === true && fb.b2[1] === 'b' && fb.b3 && fb.b3[0] === false && /third failed/.test(fb.b3[1]), JSON.stringify(fb));
check('an answer for an unknown id is ignored', fast.fast_unknown_id && fast.fast_unknown_id.ok === true);
const fl = fast.fast_lost || {};
check('[3] takes the callback path for that call', fl.ok && fl.v === 'res:query' && fl.exportCalls === 1, JSON.stringify(fl));
check('and the next call registers again', fast.fast_reregister && fast.fast_reregister.ok && fast.fast_reregister.v === 'again' && fast.fast_reregister.regCount === 2, JSON.stringify(fast.fast_reregister));
const fs2 = fast.fast_skips_store || {};
check('startTransaction.await uses the export, not cis_call',
    fs2.ok6 && fs2.v6 === 'res:startTransaction' && fs2.cisCalls === 0 && fs2.stCalls === 1, JSON.stringify(fs2));
const fg = fast.fast_stop_guard || {};
check('onResourceStop for a driver that is not stopping rejects nothing', fg.pendingAfterSpoof === true, JSON.stringify(fg));
check('a real stop of cis_database rejects the held calls', fg.s1 && fg.s1[0] === false && /cis_database stopped/.test(fg.s1[1]), JSON.stringify(fg));
check('a driver start clears the cached fast path', fast.fast_restart && fast.fast_restart.ok && fast.fast_restart.v === 'after restart' && fast.fast_restart.registeredAgain === 1, JSON.stringify(fast.fast_restart));
check('fast path: no thread errors', Array.isArray(fast.thread_errors) && fast.thread_errors.length === 0, JSON.stringify(fast.thread_errors));

// ---- 4. Aliases and mysql-async tables --------------------------------------

const alias = runScenario('alias', String.raw`
local keepMarker = {}
MySQL = { Async = { marker = keepMarker } }
loadInclude()
warm()
emit('exec', MySQL.execute == MySQL.query)
emit('fetch', MySQL.fetch == MySQL.query)
emit('fetchAll', MySQL.fetchAll == MySQL.query)
emit('fetchSingle', MySQL.fetchSingle == MySQL.single)
emit('fetchScalar', MySQL.fetchScalar == MySQL.scalar)
emit('existing_async_kept', MySQL.Async.marker == keepMarker)
emit('sync_table', type(MySQL.Sync) == 'table')

local asyncMap = { fetchAll = 'query', fetchScalar = 'scalar', fetchSingle = 'single', execute = 'update', insert = 'insert', transaction = 'transaction', prepare = 'prepare' }
local out = {}
for name, method in pairs(asyncMap) do
    reset()
    local got
    local okA = pcall(MySQL.Async[name], 'SELECT 1', {}, function(r) got = r end)
    local viaAsync = calls[1] and calls[1].name
    local gotA = got
    reset()
    local okS, v = pcall(MySQL.Sync[name], 'SELECT 1', {})
    out[name] = { asyncOk = okA, asyncMethod = viaAsync, asyncGot = gotA, syncOk = okS, syncMethod = calls[1] and calls[1].name, syncV = v,
        sameCallable = MySQL.Async[name] == MySQL[method], sameAwait = MySQL.Sync[name] == MySQL[method].await, count = #calls }
end
emit('maps', out)
reset()
pcall(MySQL.Sync.execute, 'UPDATE t SET a = 1', { 1 })
emit('sync_execute_update', { count = #calls, name = calls[1] and calls[1].name })
reset()
pcall(MySQL.execute, 'SELECT 1', {}, function() end)
emit('execute_alias_query', { name = calls[1] and calls[1].name })
emit('thread_errors', threadErrors)
`);
check('alias run completes', !alias.__failed, alias.__stderr);
check('MySQL.execute, fetch and fetchAll are MySQL.query', alias.exec === true && alias.fetch === true && alias.fetchAll === true);
check('MySQL.fetchSingle is MySQL.single and fetchScalar is MySQL.scalar', alias.fetchSingle === true && alias.fetchScalar === true);
check('an existing MySQL.Async table is kept', alias.existing_async_kept === true && alias.sync_table === true);
for (const [name, method] of Object.entries({ fetchAll: 'query', fetchScalar: 'scalar', fetchSingle: 'single', execute: 'update', insert: 'insert', transaction: 'transaction', prepare: 'prepare' })) {
    const r = (alias.maps || {})[name] || {};
    check('MySQL.Async.' + name + ' is the callable ' + method + ', MySQL.Sync.' + name + ' awaits it',
        r.asyncOk && r.asyncMethod === method && r.asyncGot === 'res:' + method && r.syncOk && r.syncMethod === method && r.syncV === 'res:' + method && r.sameCallable && r.sameAwait && r.count === 1,
        JSON.stringify(r));
}
check('Sync.execute goes to update, not query', alias.sync_execute_update && alias.sync_execute_update.count === 1 && alias.sync_execute_update.name === 'update', JSON.stringify(alias.sync_execute_update));
check('MySQL.execute goes to query', alias.execute_alias_query && alias.execute_alias_query.name === 'query');

// ---- 5. Unknown names reach the driver --------------------------------------

const unknown = runScenario('unknown', String.raw`
loadInclude()
behave.isReady = function() return true end
behave.awaitConnection = function(args) local cb = args[2]; if cb then cb() end; return 'a', 'b' end
behave.somethingNew = function(args) return args[2], args[3] end
reset()
local r = MySQL.isReady()
local c = calls[1]
emit('isReady', { r = r, name = c and c.name, n = c and c.n, selfNil = c and c.args[1] == nil, count = #calls, res = c and c.res })
reset()
local called = 0
local r1, r2 = MySQL.awaitConnection(function() called = called + 1 end)
c = calls[1]
emit('awaitConnection', { r1 = r1, r2 = r2, name = c and c.name, cbPassed = c and type(c.args[2]) == 'function', selfNil = c and c.args[1] == nil, called = called })
reset()
local x, y = MySQL.somethingNew(10, 20)
emit('multi_args', { x = x, y = y, n = calls[1] and calls[1].n })
emit('is_function', type(MySQL.anything) == 'function')
emit('not_shadowed', { async = type(MySQL.Async), sync = type(MySQL.Sync), query = type(MySQL.query), ready = type(MySQL.ready), asyncIsFn = type(MySQL.Async) == 'function' })
emit('has_index', getmetatable(MySQL) ~= nil and getmetatable(MySQL).__index ~= nil)
emit('same_each_time', MySQL.isReady == MySQL.isReady)
-- looks up the driver on every call
reset()
states.cis_database = 'stopping'
states.oxmysql = 'started'
fire('onResourceStop', 'cis_database')
MySQL.isReady()
emit('driver_each_call', calls[1] and calls[1].res)
emit('thread_errors', threadErrors)
`);
check('unknown run completes', !unknown.__failed, unknown.__stderr);
const ui = unknown.isReady || {};
check('MySQL.isReady() reaches the export through __index as (nil)', ui.r === true && ui.name === 'isReady' && ui.n === 1 && ui.selfNil && ui.count === 1 && ui.res === 'cis_database', JSON.stringify(ui));
const uc = unknown.awaitConnection || {};
check('MySQL.awaitConnection(cb) passes (nil, cb) and returns every result', uc.name === 'awaitConnection' && uc.cbPassed && uc.selfNil && uc.called === 1 && uc.r1 === 'a' && uc.r2 === 'b', JSON.stringify(uc));
check('any argument count passes through', unknown.multi_args && unknown.multi_args.x === 10 && unknown.multi_args.y === 20 && unknown.multi_args.n === 3, JSON.stringify(unknown.multi_args));
check('reading an unknown name gives a function', unknown.is_function === true && unknown.has_index === true && unknown.same_each_time === true);
const ns = unknown.not_shadowed || {};
check('Async, Sync and the methods are not shadowed by __index', ns.async === 'table' && ns.sync === 'table' && ns.query === 'table' && ns.ready === 'table', JSON.stringify(ns));
check('the driver is resolved when the function runs', unknown.driver_each_call === 'oxmysql', JSON.stringify(unknown.driver_each_call));

// ---- 6. store and startTransaction ------------------------------------------

const store = runScenario('store', String.raw`
loadInclude()
warm()
-- store keeps the query in the include and hands back a number, as
-- oxmysql's include does; a later call takes the number as its SQL.
reset()
local got
local ret = MySQL.store('SELECT * FROM users WHERE id = ?', function(id) got = id end)
emit('store_cb', { got = got, ret = ret, count = #calls })
local stored = got
reset()
MySQL.query(stored, { 5 }, function() end)
emit('store_later', { q = calls[1] and calls[1].args[2], name = calls[1] and calls[1].name })
reset()
MySQL.single.await(stored, { 5 })
emit('store_later_await', { q = calls[1] and calls[1].args[2] })
local viaAwait = MySQL.store.await('SELECT 2')
emit('store_await', { id = viaAwait, n = MySQL.Sync.store('SELECT 3') })
reset()
local okBad, errBad = try(MySQL.query, 999, {}, function() end)
emit('store_bad_id', { ok = okBad, err = errBad, count = #calls })
local okType = try(MySQL.store, 42)
emit('store_bad_type', okType)
emit('store_async_alias', MySQL.Async.store == MySQL.store)

-- startTransaction
behave.startTransaction = function(args)
    local cb
    for i = 3, 4 do if isFn(args[i]) then cb = args[i] end end
    if cb then cb(false) end
    return false
end
local ran = false
local fn = function() ran = true end
reset()
local txGot
local txRet = MySQL.startTransaction(fn, function(r) txGot = r end)
local c2 = calls[1]
emit('st_cb', { name = c2 and c2.name, fnSame = c2 and c2.args[2] == fn, got = txGot, ret = txRet, selfNil = c2 and c2.args[1] == nil, ran = ran, count = #calls })
reset()
local okA, vA = pcall(MySQL.startTransaction.await, fn)
emit('st_await', { ok = okA, v = vA, name = calls[1] and calls[1].name, fnSame = calls[1] and calls[1].args[2] == fn, ran = ran })
reset()
local okB, errB = try(MySQL.startTransaction, 'not a function')
emit('st_bad', { ok = okB, err = errB, count = #calls })
reset()
local okC = try(MySQL.startTransaction, fn)
emit('st_no_cb', { ok = okC, count = #calls })
emit('thread_errors', threadErrors)
`);
check('store run completes', !store.__failed, store.__stderr);
const sc = store.store_cb || {};
check('MySQL.store(sql, cb) hands back a number to cb and as its return value, and calls no export',
    typeof sc.got === 'number' && sc.ret === sc.got && sc.count === 0, JSON.stringify(sc));
check('a later call with the stored number runs its SQL', store.store_later && store.store_later.q === 'SELECT * FROM users WHERE id = ?' && store.store_later.name === 'query'
    && store.store_later_await && store.store_later_await.q === 'SELECT * FROM users WHERE id = ?', JSON.stringify(store.store_later));
check('store.await and Sync.store return new numbers', store.store_await && typeof store.store_await.id === 'number' && store.store_await.n === store.store_await.id + 1, JSON.stringify(store.store_await));
check('an unknown stored number raises and sends nothing', store.store_bad_id && store.store_bad_id.ok === false && /999/.test(store.store_bad_id.err || '') && store.store_bad_id.count === 0, JSON.stringify(store.store_bad_id));
check('store of a non-string raises', store.store_bad_type === false, JSON.stringify(store.store_bad_type));
check('Async.store is MySQL.store', store.store_async_alias === true);
const st = store.st_cb || {};
check('MySQL.startTransaction(fn, cb) calls the startTransaction export and never runs fn here', st.name === 'startTransaction' && st.fnSame && st.got === false && st.ret === false && st.selfNil && st.ran === false && st.count === 1, JSON.stringify(st));
const sa = store.st_await || {};
check('startTransaction.await returns what the driver answers (false)', sa.ok && sa.v === false && sa.name === 'startTransaction' && sa.fnSame && sa.ran === false, JSON.stringify(sa));
check('startTransaction with a non-function raises and sends nothing', store.st_bad && store.st_bad.ok === false && store.st_bad.count === 0, JSON.stringify(store.st_bad));
check('startTransaction without a callback is fine', store.st_no_cb && store.st_no_cb.ok && store.st_no_cb.count === 1);

// ---- 7. ready ----------------------------------------------------------------

// oxmysql starts the ready wait with Citizen.CreateThreadNow: when the engine
// is up, cb runs before MySQL.ready returns, not on the next tick. Only the
// Citizen table has it; a bare CreateThreadNow is nil in FiveM.
{
    const lib = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'MySQL.lua'), 'utf8');
    check('MySQL.ready starts its wait with Citizen.CreateThreadNow', /Citizen\.CreateThreadNow\(function\(\)\s+waitForEngine\(\)/.test(lib));
    check('no bare CreateThreadNow call', !/(^|[^.\w])CreateThreadNow\s*\(/m.test(lib));
}

const ready = runScenario('ready', String.raw`
loadInclude()
local up = false
behave.isReady = function() return up end
local calledA = 0
reset()
MySQL.ready(function() calledA = calledA + 1 end)
tick(); tick()
emit('not_yet', { called = calledA, isReadyCalls = #callsTo('isReady') })
up = true
tick()
tick()
emit('after_up', { called = calledA })

-- await blocks the caller until ready
up = false
local awaited, awaitDone = nil, false
CreateThread(function() awaited = MySQL.ready.await(); awaitDone = true end)
tick()
local before = awaitDone
up = true
tick()
emit('await', { blocked = not before, done = awaitDone, v = awaited })

-- already ready: runs at once
local calledB = 0
MySQL.ready(function() calledB = calledB + 1 end)
emit('immediate', calledB)

-- a function reference table works as the callback
local refCalled = 0
local ref = setmetatable({ __cfx_functionReference = 'r' }, { __call = function() refCalled = refCalled + 1 end })
MySQL.ready(ref)
emit('ref_cb', refCalled)

-- bad callback
emit('bad_cb', { try(MySQL.ready, 'nope') })
emit('thread_errors', threadErrors)
`);
check('ready run completes', !ready.__failed, ready.__stderr);
check('MySQL.ready(cb) waits while isReady is false, in a thread', ready.not_yet && ready.not_yet.called === 0 && ready.not_yet.isReadyCalls >= 1, JSON.stringify(ready.not_yet));
check('and runs cb once when isReady turns true', ready.after_up && ready.after_up.called === 1, JSON.stringify(ready.after_up));
check('MySQL.ready.await() blocks until ready and returns true', ready.await && ready.await.blocked && ready.await.done && ready.await.v === true, JSON.stringify(ready.await));
check('ready when already up runs cb in the thread at once', ready.immediate === 1);
check('a function reference table is a valid ready callback', ready.ref_cb === 1);
check('a non-function callback raises', Array.isArray(ready.bad_cb) && ready.bad_cb[0] === false);
check('ready: no thread errors', Array.isArray(ready.thread_errors) && ready.thread_errors.length === 0, JSON.stringify(ready.thread_errors));

const oldDriver = runScenario('ready_old', String.raw`
loadInclude()
-- an old driver has no isReady export: wait for the resource state
states.cis_database = 'starting'
missing['cis_database.isReady'] = true
local called, awaited = 0, nil
MySQL.ready(function() called = called + 1 end)
CreateThread(function() awaited = MySQL.ready.await() end)
tick()
local early = { called = called, awaited = awaited }
states.cis_database = 'started'
tick()
emit('old_driver', { early = early, called = called, awaited = awaited })
emit('thread_errors', threadErrors)
`);
check('ready run on an old driver completes', !oldDriver.__failed, oldDriver.__stderr);
const od = oldDriver.old_driver || {};
check('a driver without isReady: ready waits for the resource state "started"',
    od.early && od.early.called === 0 && od.early.awaited === undefined && od.called === 1 && od.awaited === true, JSON.stringify(od));
check('old driver: no thread errors', Array.isArray(oldDriver.thread_errors) && oldDriver.thread_errors.length === 0, JSON.stringify(oldDriver.thread_errors));

// A driver that never comes up: after 30 s one warning names the driver and
// its resource state, then the wait polls once a second instead of every 50 ms.
const stuck = runScenario('ready_stuck', String.raw`
loadInclude()
states.cis_database = 'stopped'
missing['cis_database.isReady'] = true
local now, waits, lines = 0, {}, {}
function GetGameTimer() return now end
function Wait(ms) waits[#waits + 1] = ms; coroutine.yield() end
function print(...) lines[#lines + 1] = table.concat({ ... }, ' ') end
local called = 0
MySQL.ready(function() called = called + 1 end)
tick()
local early = { warned = #lines, wait = waits[#waits] }
now = 31000; tick(); tick()
now = 62000; tick(); tick()
local late = { warned = #lines, line = lines[1], wait = waits[#waits] }
states.cis_database = 'started'
tick()
emit('stuck', { early = early, late = late, called = called })
emit('thread_errors', threadErrors)
`);
check('ready_stuck run completes', !stuck.__failed, stuck.__stderr);
const stk = stuck.stuck || {};
check('a driver that never starts: one warning after 30 s naming it and its state, then 1 s polls',
    stk.early && stk.early.warned === 0 && stk.early.wait === 50 && stk.late && stk.late.warned === 1
    && /cis_database/.test(stk.late.line || '') && /stopped/.test(stk.late.line || '') && stk.late.wait === 1000 && stk.called === 1, JSON.stringify(stk));
check('ready_stuck: no thread errors', Array.isArray(stuck.thread_errors) && stuck.thread_errors.length === 0, JSON.stringify(stuck.thread_errors));

// ---- 8. Driver choice ---------------------------------------------------------

const drv = runScenario('driver', String.raw`
states.cis_database = 'missing'
states.oxmysql = 'started'
loadInclude()
reset()
MySQL.query('SELECT 1')
emit('ox_fallback', calls[1] and calls[1].res)
states.oxmysql = 'stopped'
states.cis_database = 'started'
fire('onResourceStart', 'cis_database')
reset()
MySQL.query('SELECT 1')
emit('back_to_cis', calls[1] and calls[1].res)
emit('thread_errors', threadErrors)
`);
check('driver run completes', !drv.__failed, drv.__stderr);
check('a started oxmysql is used when cis_database is not', drv.ox_fallback === 'oxmysql', JSON.stringify(drv.ox_fallback));
check('and cis_database again once it starts', drv.back_to_cis === 'cis_database', JSON.stringify(drv.back_to_cis));

// ---- 9. The file itself ---------------------------------------------------------

const text = fs.readFileSync(includePath, 'utf8');
const lines = text.split(/\r?\n/);
check('line 1 is a comment: written for cis_database from the oxmysql documentation, without oxmysql\'s source',
    /^--/.test(lines[0]) && /cis_database/.test(lines[0]) && /documentation/i.test(lines[0]) && /without oxmysql'?s? source/i.test(lines[0]), lines[0]);
check('the stopping-state guard text is verbatim', text.indexOf("GetResourceState(name) ~= 'stopping'") >= 0);
check('names from the replaced file are not used', !/safeArgs|mysql_method_mt|onReady/.test(text));
check('the include has no fixed oxmysql file text of the old header', !/oxmysql\/lib\/MySQL\.lua is/i.test(text));

const failed = results.filter((x) => !x).length;
console.log(failed ? 'mysql_include: ' + failed + ' FAILED' : 'mysql_include: all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
