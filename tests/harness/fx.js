'use strict';

// Loads server.js the way FXServer does (exportAll + boot), with the cfx
// globals stubbed and mysql2 replaced by a fake MariaDB backed by a node:sqlite
// file. The fake file survives process restarts, so a test can boot, write,
// crash, and boot again against the same "MariaDB".
//
// Env:
//   FX_RES_DIR      resource dir for cache/ (required, a temp dir)
//   FX_MARIA_FILE   fake MariaDB sqlite file (required unless FX_REAL_MARIA)
//   FX_NO_MYSQL2    '1' makes mysql2 fail to load, as in a copy without
//                   node_modules/ (tests/repro/mysql2_missing.js)
//   FX_REAL_MARIA   '1' keeps the real mysql2, for a real MariaDB named by the
//                   mysql_connection_string convar (tests/corpus/match.js)
//   FX_MARIA_WRITES 'down' makes the replica pool refuse connections
//   FX_MARIA_DOWN   '1' makes every MariaDB connection fail (hydrate, CDC, pool)
//   FX_MARIA_DELAY_MS  delay before every fake MariaDB connect and query
//   FX_MARIA_REJECT  regex; a fake MariaDB query whose text matches it is
//                   refused with ER_DUP_ENTRY (1062), a statement error;
//                   bound params are matched as 'value'
//   FX_MARIA_FAIL_COMMIT  n: the nth fake MariaDB commit rolls back and
//                   rejects with ER_LOCK_DEADLOCK (1213), a retryable error
//   FX_MARIA_READONLY  n: the first n fake MariaDB writes (INSERT, UPDATE,
//                   DELETE, REPLACE, alone or in a batch) are refused with 1290
//                   ER_OPTION_PREVENTS_STATEMENT, as a server under
//                   --read-only refuses them until it is writable again;
//                   FX_MARIA_READONLY_ERRNO picks another errno for them
//   FX_CONVARS      JSON object of convars
//   FX_BACKEND      'sql.js' hides node:sqlite from server.js, so it falls
//                   back to sql.js as on an FXServer build without it

const path = require('path');
const Module = require('module');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..', '..');
const resDir = process.env.FX_RES_DIR;
const mariaFile = process.env.FX_MARIA_FILE;
const realMaria = process.env.FX_REAL_MARIA === '1';
if (!resDir || (!mariaFile && !realMaria)) throw new Error('FX_RES_DIR and FX_MARIA_FILE are required');

const convars = Object.assign({
    mysql_connection_string: 'mysql://root@127.0.0.1/fake',
    cis_database_cdc: '0',
    // The fake MariaDB is SQLite: it cannot answer the reads routed to MariaDB.
    cis_database_maria_reads: realMaria ? '1' : '0',
}, JSON.parse(process.env.FX_CONVARS || '{}'));

const registry = Object.create(null);
const handlers = Object.create(null);
// Like citizen/scripting/v8/main.js: exports(name, fn) answers the
// __cfx_export_<resource>_<name> event, and a caller emits that event with a
// setter to get the function. Local events run their handlers synchronously.
global.exports = function (name, fn) {
    registry[name] = fn;
    global.on('__cfx_export_cis_database_' + name, (setCB) => setCB(fn));
};
global.on = function (name, fn) { (handlers[name] = handlers[name] || []).push(fn); };
global.emit = function (name, ...args) { for (const fn of handlers[name] || []) fn(...args); };
// FXServer's JS runtime runs every setTick function once per server tick;
// the interval below plays that tick.
const tickers = [];
global.setTick = (fn) => tickers.push(fn);
global.GetConvar = (name, fb) => (name in convars ? String(convars[name]) : fb);
global.GetCurrentResourceName = () => 'cis_database';
global.GetInvokingResource = () => global.__fxInvoker || '';
global.GetResourcePath = () => resDir;
// Only the server_exports list is read from the real manifest; every other key
// stays unset, as before.
const manifestExports = (() => {
    const src = require('fs').readFileSync(path.join(ROOT, 'fxmanifest.lua'), 'utf8');
    const block = /server_exports\s*\{([^}]*)\}/.exec(src);
    return block ? Array.from(block[1].matchAll(/'([^']+)'/g), (m) => m[1]) : [];
})();
global.GetNumResourceMetadata = (res, key) => (key === 'server_export' ? manifestExports.length : 0);
global.GetResourceMetadata = (res, key, i) => (key === 'server_export' ? manifestExports[i] || null : null);

function maria() {
    const db = new DatabaseSync(mariaFile);
    db.exec('PRAGMA journal_mode=WAL');
    // A function only MariaDB has, for reads SQLite cannot run.
    db.function('maria_only', (x) => 'maria:' + x);
    // MariaDB computes these itself, so a copy that sends the call instead of
    // the value SQLite used gets a different one.
    db.function('UUID', { deterministic: false }, () => require('crypto').randomUUID());
    db.function('UUID_SHORT', { deterministic: false }, () => Math.floor(Math.random() * 1e15));
    db.function('RAND', { deterministic: false }, () => Math.random());
    return db;
}

function infoTables(db) {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
        .map((r) => ({ TABLE_NAME: r.name, AUTO_INCREMENT: null }));
}

// A test can give a column the EXTRA (auto_increment, on update ...) and
// COLUMN_DEFAULT MariaDB would report, in a fake_columns table.
function fakeColumns(db) {
    const map = Object.create(null);
    try {
        for (const r of db.prepare('SELECT * FROM fake_columns').all()) {
            map[r.table_name + '.' + r.column_name] = r;
        }
    } catch (e) { /* no overrides */ }
    return map;
}

function infoColumns(db) {
    const out = [];
    const fake = fakeColumns(db);
    for (const t of infoTables(db)) {
        if (t.TABLE_NAME === 'fake_columns') continue;
        const cols = db.prepare('PRAGMA table_info("' + t.TABLE_NAME + '")').all();
        // An AUTOINCREMENT key is what MariaDB reports as auto_increment.
        const auto = /\bAUTOINCREMENT\b/i.test((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t.TABLE_NAME) || {}).sql || '');
        for (const c of cols) {
            const type = String(c.type || 'text').toLowerCase();
            const f = fake[t.TABLE_NAME + '.' + c.name] || {};
            out.push({
                TABLE_NAME: t.TABLE_NAME,
                COLUMN_NAME: c.name,
                ORDINAL_POSITION: c.cid + 1,
                DATA_TYPE: type.replace(/\(.*$/, ''),
                COLUMN_TYPE: type,
                // MariaDB reports the declared length of a char column.
                CHARACTER_MAXIMUM_LENGTH: /^(var)?char\(\d+\)/.test(type) ? Number(type.replace(/^\D*\((\d+)\).*$/, '$1')) : null,
                IS_NULLABLE: c.notnull ? 'NO' : 'YES',
                COLUMN_DEFAULT: f.column_default != null ? f.column_default : c.dflt_value,
                EXTRA: f.extra || (auto && c.pk === 1 && type === 'integer' ? 'auto_increment' : ''),
                COLUMN_KEY: c.pk ? 'PRI' : '',
                // fake_columns may carry a generation_expression column.
                GENERATION_EXPRESSION: f.generation_expression != null ? f.generation_expression : null,
            });
        }
    }
    return out;
}

function infoStats(db) {
    const out = [];
    for (const t of infoTables(db)) {
        const cols = db.prepare('PRAGMA table_info("' + t.TABLE_NAME + '")').all().filter((c) => c.pk).sort((a, b) => a.pk - b.pk);
        for (const c of cols) {
            out.push({ TABLE_NAME: t.TABLE_NAME, INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, SEQ_IN_INDEX: c.pk, COLUMN_NAME: c.name });
        }
        // UNIQUE constraints and secondary indexes, as MariaDB lists them.
        for (const ix of db.prepare('PRAGMA index_list("' + t.TABLE_NAME + '")').all()) {
            if (ix.origin === 'pk') continue;
            for (const c of db.prepare('PRAGMA index_info("' + ix.name + '")').all()) {
                const name = ix.origin === 'u' ? c.name : ix.name;
                out.push({ TABLE_NAME: t.TABLE_NAME, INDEX_NAME: name, NON_UNIQUE: ix.unique ? 0 : 1, SEQ_IN_INDEX: c.seqno + 1, COLUMN_NAME: c.name });
            }
        }
    }
    return out;
}

function infoForeignKeys(db) {
    const rules = (x) => String(x || 'NO ACTION').toUpperCase();
    const out = [];
    for (const t of infoTables(db)) {
        for (const fk of db.prepare('PRAGMA foreign_key_list("' + t.TABLE_NAME + '")').all()) {
            out.push({ TABLE_NAME: t.TABLE_NAME, CONSTRAINT_NAME: 'fk_' + t.TABLE_NAME + '_' + fk.id, COLUMN_NAME: fk.from,
                REFERENCED_TABLE_NAME: fk.table, REFERENCED_COLUMN_NAME: fk.to, UPDATE_RULE: rules(fk.on_update), DELETE_RULE: rules(fk.on_delete) });
        }
    }
    return out;
}

// The replica state table and TRUNCATE are MariaDB syntax; the fake runs SQLite.
// MariaDB reads '--' as a comment only before a space, a control character or
// the end; '1--?' is 1 - (-?). SQLite reads every '--' as a comment, so the
// fake spaces the dashes out first.
function mysqlDashes(s) {
    if (s.indexOf('--') < 0) return s;
    let out = '';
    let q = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        out += c;
        if (q) {
            if (c === '\\' && q !== '`') { out += s[++i] || ''; continue; }
            if (c === q) q = null;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') { q = c; continue; }
        if (c === '-' && s[i + 1] === '-') {
            if (i + 2 < s.length && s.charCodeAt(i + 2) > 32) { out += ' '; continue; }
            while (i + 1 < s.length && s[i + 1] !== '\n') out += s[++i];
        }
    }
    return out;
}

function fakeStateSql(s) {
    s = mysqlDashes(s);
    const trunc = s.match(/^\s*TRUNCATE\s+(?:TABLE\s+)?[`"]?(\w+)[`"]?\s*$/i);
    if (trunc) return 'DELETE FROM "' + trunc[1] + '"';
    // MariaDB has NOW(); SQLite does not.
    s = s.replace(/\bNOW\(\)/gi, 'CURRENT_TIMESTAMP');
    if (!/__cis_replica_state/.test(s)) return s;
    if (/^\s*CREATE\s+TABLE/i.test(s)) return 'CREATE TABLE IF NOT EXISTS __cis_replica_state (epoch TEXT PRIMARY KEY, applied INTEGER NOT NULL, updated_at TEXT)';
    if (/ON\s+DUPLICATE\s+KEY/i.test(s)) {
        return s.replace(/`/g, '"').replace(/ON\s+DUPLICATE\s+KEY\s+UPDATE[\s\S]*$/i, 'ON CONFLICT(epoch) DO UPDATE SET applied = excluded.applied');
    }
    return s.replace(/`/g, '"');
}

// mysql2's client-side format: each ? outside a string becomes a literal.
// Past the last value it leaves the ? in the text, as sql-escaper does, and
// MariaDB then refuses the statement.
function fakeFormat(sql, params) {
    const lit = (v) => {
        if (v == null) return 'NULL';
        if (typeof v === 'number' || typeof v === 'bigint') return String(v);
        if (typeof v === 'boolean') return v ? '1' : '0';
        if (Buffer.isBuffer(v)) return "X'" + v.toString('hex') + "'";
        return "'" + String(v).replace(/'/g, "''") + "'";
    };
    let out = '';
    let k = 0;
    let q = null;
    for (let i = 0; i < sql.length; i++) {
        const c = sql[i];
        if (q) { out += c; if (c === q) q = null; continue; }
        if (c === "'" || c === '"') { q = c; out += c; continue; }
        if (c === '?') { out += k < (params || []).length ? lit(params[k++]) : '?'; continue; }
        out += c;
    }
    return out;
}

function bareMarks(sql) {
    let n = 0;
    let q = null;
    for (const c of sql) {
        if (q) { if (c === q) q = null; continue; }
        if (c === "'" || c === '"') q = c;
        else if (c === '?') n++;
    }
    return n;
}

function runQuery(db, sql, params) {
    // mysql2's options form: query({ sql, values, typeCast }).
    if (sql && typeof sql === 'object') { params = sql.values; sql = sql.sql; }
    // A multi-statement batch (multipleStatements): run in order, stop at
    // the first error, as MariaDB does.
    if (String(sql).indexOf('\n;\n') >= 0 && !(params && params.length)) {
        let last = null;
        for (const part of String(sql).split('\n;\n')) last = runQuery(db, part, []);
        return last;
    }
    // mysql2 formats on the client, so a ? with no value left reaches
    // MariaDB as text and is a syntax error there; SQLite would bind NULL.
    if (bareMarks(String(sql)) > (params || []).length) {
        const e = new Error("You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use near '?' at line 1");
        e.code = 'ER_PARSE_ERROR';
        e.errno = 1064;
        throw e;
    }
    let s = fakeStateSql(String(sql));
    if (/information_schema\.tables/i.test(s)) return [infoTables(db), []];
    if (/information_schema\.columns/i.test(s)) return [infoColumns(db), []];
    if (/information_schema\.statistics/i.test(s)) return [infoStats(db), []];
    if (/information_schema\.key_column_usage/i.test(s)) return [infoForeignKeys(db), []];
    // SET insert_id: the next numbered row takes this id, as on MariaDB. The
    // fake moves the table's AUTOINCREMENT counter just before the INSERT.
    const pin = s.match(/^\s*SET\s+insert_id\s*=\s*(\d+)\s*$/i);
    if (pin) {
        db.cisInsertId = Number(pin[1]);
        return [{ affectedRows: 0, insertId: 0 }, []];
    }
    // SET timestamp: NOW() and CURRENT_TIMESTAMP read this time until DEFAULT.
    const clock = s.match(/^\s*SET\s+timestamp\s*=\s*(DEFAULT|\d+(?:\.\d+)?)\s*$/i);
    if (clock) {
        db.cisTimestamp = /^DEFAULT$/i.test(clock[1]) ? 0 : Number(clock[1]);
        return [{ affectedRows: 0, insertId: 0 }, []];
    }
    if (db.cisTimestamp) s = s.replace(/\bCURRENT_TIMESTAMP\b/gi, "datetime(" + Math.floor(db.cisTimestamp) + ", 'unixepoch')");
    if (db.cisInsertId && /^\s*(INSERT|REPLACE)\b/i.test(s)) {
        const t = s.match(/\bINTO\s+[`"]?(\w+)/i);
        // No sqlite_sequence until the file has an AUTOINCREMENT table.
        try { if (t) db.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(db.cisInsertId - 1, t[1]); } catch (e) { /* nothing to move */ }
    }
    const st = db.prepare(s);
    if (/^\s*(SELECT|SHOW|WITH)\b/i.test(s)) return [st.all(...(params || [])), []];
    const info = st.run(...(params || []));
    return [{ affectedRows: Number(info.changes), insertId: Number(info.lastInsertRowid) }, []];
}

// A slow MariaDB keeps hydrate running long enough for a test to call in
// before SQLite is open and while tables are still being copied.
const delayMs = () => Number(process.env.FX_MARIA_DELAY_MS) || 0;
// Without a delay every answer still comes back on a later turn of the event
// loop, as a network reply does, instead of as a microtask.
const pause = () => new Promise((r) => (delayMs() ? setTimeout(r, delayMs()) : setImmediate(r)));

let fakeCommits = 0;
let fakeCommitTries = 0;
let fakeReadOnlyTries = 0;
// Queries sent to the fake MariaDB, for tests that count round trips.
let fakeRoundTrips = 0;
// Connections the fake MariaDB opened; a pool keeps its idle ones.
let fakeOpens = 0;
// SQL that pool "connection" listeners sent, in order.
const fakeSessionSql = [];
// Every query text a connection received, with whether that connection
// allows multiple statements (the pool's multipleStatements option).
const fakeSent = [];

// MariaDB without multipleStatements refuses text with a second statement:
// a ; outside quotes, backticks and comments with more SQL after it.
function secondStatement(sql) {
    const s = String(sql);
    let q = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (q) {
            if (c === '\\' && q !== '`') { i++; continue; }
            if (c === q) q = null;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') { q = c; continue; }
        if (c === '#' || (c === '-' && s[i + 1] === '-' && /\s/.test(s[i + 2] || ' '))) { while (i < s.length && s[i] !== '\n') i++; continue; }
        if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 1; continue; }
        if (c === ';' && s.slice(i + 1).trim()) return s.slice(i + 1).trim();
    }
    return null;
}

function fakeConn(multi) {
    fakeOpens++;
    const db = maria();
    const send = (sql, params) => {
        const text = sql && typeof sql === 'object' ? sql.sql : sql;
        fakeSent.push({ multi: !!multi, sql: String(text) });
        const reject = process.env.FX_MARIA_REJECT;
        if (reject && new RegExp(reject).test(String(text) + ' ' + (Array.isArray(params) ? params.map((p) => "'" + p + "'").join(',') : ''))) {
            const e = new Error("Duplicate entry for key 'PRIMARY'");
            e.code = 'ER_DUP_ENTRY';
            e.errno = 1062;
            throw e;
        }
        const readOnly = Number(process.env.FX_MARIA_READONLY) || 0;
        if (readOnly && /(?:^|;)\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(String(text)) && ++fakeReadOnlyTries <= readOnly) {
            const e = new Error('The MariaDB server is running with the --read-only option so it cannot execute this statement');
            e.code = 'ER_OPTION_PREVENTS_STATEMENT';
            e.errno = 1290;
            const errno = Number(process.env.FX_MARIA_READONLY_ERRNO);
            if (errno) { e.code = 'ER_' + errno; e.errno = errno; }
            throw e;
        }
        const second = multi ? null : secondStatement(text);
        if (second) {
            const e = new Error("You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use near '" + second.slice(0, 80) + "' at line 1");
            e.code = 'ER_PARSE_ERROR';
            e.errno = 1064;
            throw e;
        }
        return runQuery(db, sql, params);
    };
    return {
        query: async (sql, params) => { await pause(); fakeRoundTrips++; return send(sql, params); },
        execute: async (sql, params) => { await pause(); fakeRoundTrips++; return send(sql, params); },
        format: fakeFormat,
        beginTransaction: async () => db.exec('BEGIN'),
        commit: async () => {
            const fail = Number(process.env.FX_MARIA_FAIL_COMMIT) || 0;
            if (fail && ++fakeCommitTries === fail) {
                db.exec('ROLLBACK');
                const e = new Error('Deadlock found when trying to get lock; try restarting transaction');
                e.code = 'ER_LOCK_DEADLOCK';
                e.errno = 1213;
                throw e;
            }
            db.exec('COMMIT');
            // FX_MARIA_KILL_AFTER_COMMIT=n kills the process right after the
            // nth MariaDB commit, before SQLite can record it.
            const n = Number(process.env.FX_MARIA_KILL_AFTER_COMMIT) || 0;
            if (n && ++fakeCommits >= n) process.kill(process.pid, 'SIGKILL');
        },
        rollback: async () => db.exec('ROLLBACK'),
        release() {},
        end: async () => db.close(),
    };
}

function refused() {
    const e = new Error('connect ECONNREFUSED 127.0.0.1:3306');
    e.code = 'ECONNREFUSED';
    return e;
}

const fakeMysql2 = {
    createConnection: async (opts) => { await pause(); if (process.env.FX_MARIA_DOWN === '1') throw refused(); return fakeConn(opts && opts.multipleStatements); },
    createPool(opts) {
        const multi = !!(opts && opts.multipleStatements);
        // Read on every call so a test can bring MariaDB back mid-run.
        const isDown = () => process.env.FX_MARIA_WRITES === 'down' || process.env.FX_MARIA_DOWN === '1';
        // mysql2 emits "connection" with the core (callback) connection
        // each time the pool opens one; the SQL a listener sends is kept for
        // tests. Released connections wait in `idle` for the next call, as
        // in mysql2, instead of a new SQLite connection per call.
        const listeners = [];
        const idle = [];
        const take = () => {
            if (idle.length) return idle.pop();
            for (const fn of listeners) fn({ query: (sql, cb) => { fakeSessionSql.push(typeof sql === 'string' ? sql : sql.sql); if (cb) setImmediate(cb, null); }, destroy() {} });
            const conn = fakeConn(multi);
            conn.release = () => { idle.push(conn); };
            return conn;
        };
        return {
            getConnection: async () => { if (isDown()) throw refused(); return take(); },
            query: async (sql, params) => {
                if (isDown()) throw refused();
                const conn = take();
                try { return await conn.query(sql, params); } finally { conn.release(); }
            },
            on(ev, fn) { if (ev === 'connection') listeners.push(fn); },
            end() {},
        };
    },
};

const origLoad = Module._load;
const hideNodeSqlite = process.env.FX_BACKEND === 'sql.js';
Module._load = function (request, parent, isMain) {
    if (process.env.FX_NO_MYSQL2 === '1' && /(^|[\\/])mysql2(\/promise)?$/.test(request)) throw new Error("Cannot find module '" + request + "'");
    if (!realMaria && (request === 'mysql2/promise' || request === 'mysql2')) return fakeMysql2;
    if (hideNodeSqlite && request === 'node:sqlite' && parent === serverModule) throw new Error('node:sqlite is hidden by FX_BACKEND=sql.js');
    return origLoad.apply(this, arguments);
};

// FXServer runs server.js with the cfx `exports` function in scope, where plain
// CommonJS would bind the module's exports object. Compile it the same way.
const serverFile = path.join(ROOT, 'server.js');
const serverModule = new Module(serverFile, module);
serverModule.filename = serverFile;
serverModule.paths = Module._nodeModulePaths(ROOT);
const serverRequire = (id) => serverModule.require(id);
const src = require('fs').readFileSync(serverFile, 'utf8');
new Function('exports', 'require', 'module', '__filename', '__dirname', src)(
    global.exports, serverRequire, serverModule, serverFile, ROOT);

// server.js marks each server frame from its setTick. Callbacks deferred past
// the frame budget are only delivered from there. The interval keeps the
// process alive like FXServer does, so tests end with process.exit.
setInterval(() => { for (const fn of tickers) fn(); }, 4);

// Runs fn as a call from cis_database itself. The internal exports (hydrate,
// a probe reset) refuse other callers.
function asSelf(fn) {
    const prev = global.__fxInvoker;
    global.__fxInvoker = 'cis_database';
    try { return fn(); } finally { global.__fxInvoker = prev; }
}

// Calls an export the way a Lua resource would and resolves with the callback
// result. A query export asks for errors (the include's flag after the
// resource name, as .await sends it), and a failed query resolves with false.
const NO_FLAG = new Set(['transaction', 'hydrate', 'execMany']);
function call(name, ...args) {
    return new Promise((resolve) => {
        if (NO_FLAG.has(name)) return registry[name](...args, (r) => resolve(r));
        registry[name](...args, (r, e) => resolve(e != null ? false : r), 'test', true);
    });
}

async function ready(timeoutMs) {
    const end = Date.now() + (timeoutMs || 10000);
    while (Date.now() < end) {
        if (registry.isReady && registry.isReady()) return true;
        await new Promise((r) => setTimeout(r, 20));
    }
    return false;
}

module.exports = { registry, handlers, tickers, call, ready, asSelf, maria, roundTrips: () => fakeRoundTrips, opens: () => fakeOpens, sessionSql: () => fakeSessionSql.slice(), sent: () => fakeSent.slice() };
