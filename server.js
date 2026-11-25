'use strict';

// node:sqlite prints an ExperimentalWarning on first require. In the FXServer
// console it reads as an error on every boot, and server owners report it as
// one. The isolate is shared by every Node resource, so the wrapper drops only
// that warning and passes every other one, from any resource, unchanged.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, type, code, ctor) {
    const msg = typeof warning === 'string' ? warning : (warning && warning.message);
    const name = typeof type === 'string' ? type : (warning && warning.name);
    if (name === 'ExperimentalWarning' && msg && msg.indexOf('SQLite') !== -1) return;
    return emitWarning.apply(process, arguments);
};

/**
 * cis_database. Lua exports land in this V8 isolate, the same path as oxmysql.
 * Reads and writes hit in-process SQLite. MariaDB receives the same statement
 * on a background replica and is never on the query path.
 *
 * This is the engine. It provides the oxmysql, mysql-async and ghmattimysql
 * exports, runs every statement on SQLite (node:sqlite, or sql.js when that is
 * missing) after dialect.js has translated it from MySQL, and copies each
 * write to MariaDB through an outbox stored in the same SQLite transaction.
 * On boot it hydrates SQLite from MariaDB; cdc.js polls MariaDB for edits made
 * by other programs. collation.js supplies the MariaDB-compatible collations.
 *
 * Reading order (the sections below follow it):
 *   1. state, dashboard counters, server identity (DATABASE(), VERSION())
 *   2. argument and DSN parsing, parameter expansion (oxmysql call shapes)
 *   3. durability: WAL sync and checkpoint scheme, write acknowledgement
 *   4. per-frame trace and the slice/frame time budget (keeps the server thread free)
 *   5. SQLite backends (node:sqlite, sql.js), configuration, pragmas
 *   6. hydration from MariaDB, information_schema metadata, strict-mode triggers
 *   7. the outbox and the replica flusher
 *   8. DDL handling, per-statement plans, automatic indexes
 *   9. execution (execKind), dispatch, readiness gate, transactions
 *  10. Lua exports, caller checks, boot, update check
 */

const fs = require('fs');
const path = require('path');
const dialect = require('./dialect.js');

// The oxmysql methods; each has a plain, _async and Sync export (exportAll).
const METHODS = ['query', 'single', 'scalar', 'insert', 'update', 'prepare', 'transaction', 'rawExecute'];

// ---- Engine state -------------------------------------------------------
// Module-level state. The UPPER_CASE settings are defaults that loadConfig
// overwrites from config.json and convars before the first statement runs.
let engineReady = false;
let shuttingDown = false;
let backend = null;
// The performance profile's copy of the database (hotCopy); shutdown removes it.
let hotFile = null;
let replicaPool = null;
let mysql2mod = null;
// The error from loading mysql2 when mysql_connection_string is set and it
// fails, '' otherwise (boot, doctorChecks).
let mysql2Missing = '';
let bootDsn = null;
let bootHydrate = null;
const dirtyTables = new Set();
let storageMode = 'durable';
let cdcHandle = null;
const STMT_MAX = 256;
let REPLICA_FLUSH_MS = 50;
let REPLICA_BATCH = 64;
let REPLICA_Q_MAX = 4096;
let CDC_POLL_MS = 1000;
let CDC_DIRTY_TTL_MS = 2000;
let CDC_FORCE_MS = 10000;
let CDC_ENABLED = true;
let ID_RESERVE_MS = 5000;
let ID_RESERVE_GAP = 1000000;
let POOL_CONNECTIONS = 4;
let DEBUG = false;
let LOG_PREFIX = '[cis_database]';
let LOG_SQL_ERRORS = true;
let SLOW_QUERY_MS = 100;
function logLine(level, msg) {
    // "[cis_database]" becomes "[cis_database:warn]": the level goes inside
    // the closing bracket so the tag still reads as one word.
    const open = LOG_PREFIX.endsWith(']') ? LOG_PREFIX.slice(0, -1) : LOG_PREFIX;
    const tag = level === 'warn' || level === 'debug' ? open + ':' + level + ']' : LOG_PREFIX;
    const text = tag + ' ' + msg;
    if (level === 'warn') console.warn(text);
    else if (level === 'error') console.error(text);
    else console.log(text);
}
const log = {
    info(msg) { logLine('info', msg); },
    warn(msg) { logLine('warn', msg); },
    error(msg) { logLine('error', msg); },
    debug(msg) { if (DEBUG) logLine('debug', msg); },
};
const MAX_SQL_LEN = 262144;
let replicaDropN = 0;
// Outbox writes MariaDB refused as a duplicate key (logRejected), and the
// last time one was logged.
let idClashN = 0;
let idClashLogAt = 0;
let replicaFlushing = false;
let activeFlushPromise = null;
let lastFlushSuccess = true;
let replicaTimer = null;
let maintDb = null;
let checkpointTimer = null;
let checkpointScheduled = false;
let hydrateMs = 0;
let queryN = 0;
const dashViewers = new Set();
const dashLat = [];
const dashSlow = [];
const dashCdc = [];
let dashQpsAt = 0;
let dashQpsN = 0;
let dashQps = 0;
let dashFlushN = 0;
let dashFlushAt = 0;
let dashFlushPerSec = 0;
const SLOW_KEEP = 40;

// ---- Dashboard counters -------------------------------------------------
// Latency, qps, slow-query and CDC samples for the admin panel. They are only
// fed while a viewer is attached (dashViewers), so an idle server pays nothing.
function noteDash(ms, sql, from) {
    dashQpsN++;
    const now = Date.now();
    if (now - dashQpsAt >= 1000) {
        dashQps = dashQpsN;
        dashQpsN = 0;
        dashQpsAt = now;
    }
    if (dashLat.length >= 256) dashLat.shift();
    dashLat.push(ms);
    if (ms >= SLOW_QUERY_MS) {
        if (dashSlow.length >= SLOW_KEEP) dashSlow.shift();
        dashSlow.push({
            t: now,
            ms: Math.round(ms * 10) / 10,
            from: from || '',
            sql: clipSql(String(sql || '')),
        });
    }
}

function noteCdcTable(table, rows) {
    // CDC may have created the table; plans read its columns.
    bumpSchema();
    if (!dashViewers.size) return;
    if (dashCdc.length >= SLOW_KEEP) dashCdc.shift();
    dashCdc.push({ t: Date.now(), table: String(table), rows: Number(rows) || 0 });
}

function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
    return sorted[i];
}

function dashSnapshot() {
    const now = Date.now();
    if (now - dashFlushAt >= 1000) {
        dashFlushPerSec = dashFlushN;
        dashFlushN = 0;
        dashFlushAt = now;
    }
    const sorted = dashLat.slice().sort((a, b) => a - b);
    return {
        backend: backend && backend.kind || 'down',
        profile: cfg && cfg.profile || 'durable',
        ready: engineReady,
        p50us: Math.round(percentile(sorted, 0.5) * 1000),
        p99us: Math.round(percentile(sorted, 0.99) * 1000),
        qps: dashQps,
        queue: outboxPending,
        queueMax: REPLICA_Q_MAX,
        flushPerSec: dashFlushPerSec,
        batchSize: REPLICA_BATCH,
        flushMs: REPLICA_FLUSH_MS,
        drops: replicaDropN,
        idClash: idClashN,
        cdcOn: CDC_ENABLED,
        cdcPollMs: CDC_POLL_MS,
        cdcDirtyMs: CDC_DIRTY_TTL_MS,
        slowMs: SLOW_QUERY_MS,
        slow: dashSlow.slice(-12).reverse(),
        cdc: dashCdc.slice(-12).reverse(),
    };
}

// ---- Server identity and strict-mode state --------------------------------
// What SQL functions such as DATABASE() and VERSION() answer, and the strict
// SQL mode flags, so callers see MariaDB's behaviour from SQLite.
let lastInsertId = 0;
// DATABASE() and information_schema's TABLE_SCHEMA: the configured database.
// Its default collation comes from MariaDB at hydration (openInfoSchema).
let dbName = '';
let dbCollation = 'utf8mb4_general_ci';
// VERSION(): the replica's, from hydration. Until one is known, a MariaDB
// version, since the SQL cis_database takes is MariaDB's.
let dbVersion = '10.11.0-MariaDB';
// cis_strict(), which the strict-mode triggers (dialect.js) run on: on when
// the replica's sql_mode from hydration has STRICT_TRANS_TABLES or
// STRICT_ALL_TABLES (MariaDB's default is strict, so on until one is known),
// and off while an INSERT IGNORE or UPDATE IGNORE runs or CDC copies rows
// MariaDB already took.
let strictMode = true;
let strictOff = false;
// The triggers are only built once cis_strict() is registered: without it
// every write to the table would fail.
let strictReady = false;
// cis_storing(): how deep the strict-mode store triggers' own UPDATEs are,
// which cis_store(1) and cis_store(-1) around them count
// (dialect.strictTriggersSql); the ON UPDATE CURRENT_TIMESTAMP triggers do
// not stamp a row for them. Each write starts it at 0, so a depth a failed
// statement left raised does not outlive it.
let storeDepth = 0;
const cisStore = (d) => (storeDepth = Math.max(0, storeDepth + (Number(d) || 0)));
// cis_upserted(id): the AUTO_INCREMENT id of the row a single-row upsert found,
// noted from its DO UPDATE WHERE (markUpsertRow). MariaDB reports that id as the
// insert id when the update changed the row. Each upsert starts it at 0.
let upsertedId = 0;
let upsertMarkReady = false;
let textMarkReady = false;
const cisUpserted = (v) => { upsertedId = Number(v) || 0; return 1; };
// cis_set_insert_id(expr) is LAST_INSERT_ID(expr): it returns expr and makes
// it the session's LAST_INSERT_ID() and the write's insert id. Each write
// starts setInsertId at null.
let setInsertId = null;
const cisSetInsertId = (v) => { if (v != null) { setInsertId = v; lastInsertId = Number(v) || 0; } return v; };
let errN = 0;
let mariaTrustN = 0;
let txDepth = 0;
let lastTxStart = 0;
let cfg = null;
let lastWriteTime = Date.now();
let lastQueryTime = Date.now();
let activeQueries = 0;

// ---- Configuration inputs and oxmysql call shapes -------------------------
// Convar and resource-path helpers, the mysql_connection_string parser, and
// the argument shapes oxmysql, mysql-async and ghmattimysql callers use.
function resPath() {
    try {
        if (typeof GetResourcePath === 'function' && typeof GetCurrentResourceName === 'function') {
            return GetResourcePath(GetCurrentResourceName());
        }
    } catch (e) { /* ignore */ }
    return __dirname;
}

function convar(name, fallback) {
    try {
        if (typeof GetConvar === 'function') {
            const v = GetConvar(name, fallback == null ? '' : String(fallback));
            if (v != null && v !== '') return v;
        }
    } catch (e) { /* ignore */ }
    return fallback == null ? '' : String(fallback);
}

// A DSN part is %-decoded when it is valid percent-encoding. A raw % (an
// unencoded password like 50%off) is kept as typed instead of throwing
// URIError and stopping the boot.
function decodeDsnPart(v) {
    try { return decodeURIComponent(v); } catch (e) { return v; }
}

// The ssl (or sslmode) DSN option as mysql2's ssl setting: true, 1 or a MySQL mode that asks for TLS gives {} (TLS with the
// certificate checked); a JSON object is passed through, as oxmysql does
// (ssl={"rejectUnauthorized":false}); anything else leaves TLS off.
function dsnSsl(v) {
    const s = String(v || '').trim();
    if (s.charAt(0) === '{') {
        try {
            const o = JSON.parse(s);
            return o && typeof o === 'object' && !Array.isArray(o) ? o : undefined;
        } catch (e) { return undefined; }
    }
    return /^(true|1|on|required|require|verify[_-]ca|verify[_-]identity|verify[_-]full)$/i.test(s) ? {} : undefined;
}

function parseDsn(raw) {
    const out = { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: '' };
    if (!raw) return out;
    const s = String(raw).trim();
    if (/^mysql2?:\/\//i.test(s)) {
        const rest = s.replace(/^mysql2?:\/\//i, '');
        // The query string starts at the first ? followed by key=. A ?, /, #
        // or @ in an unencoded password is not one, so it stays in the
        // password. user:password ends at the last @ before the query string
        // so a ? in the password cannot move the split and send part of the
        // password to the host, the database or the log.
        const qm = /\?[A-Za-z_][A-Za-z0-9_ ]*=/.exec(rest);
        const qpos = qm ? qm.index : -1;
        const head = qpos >= 0 ? rest.slice(0, qpos) : rest;
        const qs = qpos >= 0 ? rest.slice(qpos + 1) : '';
        const at = head.lastIndexOf('@');
        const userinfo = at >= 0 ? head.slice(0, at) : '';
        const hq = at >= 0 ? head.slice(at + 1) : head;
        if (userinfo) {
            const c = userinfo.indexOf(':');
            if (c < 0) out.user = decodeDsnPart(userinfo);
            else {
                out.user = decodeDsnPart(userinfo.slice(0, c));
                out.password = decodeDsnPart(userinfo.slice(c + 1));
            }
        }
        const slash = hq.indexOf('/');
        let hostport = hq;
        if (slash >= 0) {
            hostport = hq.slice(0, slash);
            out.database = decodeDsnPart(hq.slice(slash + 1).replace(/\/$/, ''));
        }
        const colon = hostport.lastIndexOf(':');
        if (colon >= 0) {
            out.host = hostport.slice(0, colon) || out.host;
            const p = parseInt(hostport.slice(colon + 1), 10);
            if (p > 0) out.port = p;
        } else {
            out.host = hostport || out.host;
        }
        if (qs) {
            const parts = qs.split('&');
            for (let i = 0; i < parts.length; i++) {
                const eq = parts[i].indexOf('=');
                if (eq <= 0) continue;
                const k = decodeDsnPart(parts[i].slice(0, eq)).toLowerCase();
                const v = decodeDsnPart(parts[i].slice(eq + 1));
                if (k === 'user' || k === 'uid' || k === 'username') out.user = v;
                else if (k === 'password' || k === 'pwd') out.password = v;
                else if (k === 'database' || k === 'initial catalog') {
                    if (!out.database) out.database = v;
                } else if (k === 'ssl' || k === 'sslmode') out.ssl = dsnSsl(v);
            }
        }
        return clampDsn(out);
    }
    // key=value;key=value. A part with no = belongs to the value before it,
    // so password=ab;cd keeps ab;cd.
    const parts = [];
    const pieces = s.split(';');
    for (let i = 0; i < pieces.length; i++) {
        if (pieces[i].indexOf('=') > 0 || !parts.length) parts.push(pieces[i]);
        else if (pieces[i] !== '') parts[parts.length - 1] += ';' + pieces[i];
    }
    for (let i = 0; i < parts.length; i++) {
        const eq = parts[i].indexOf('=');
        if (eq <= 0) continue;
        const k = parts[i].slice(0, eq).trim().toLowerCase();
        const v = parts[i].slice(eq + 1).trim();
        if (k === 'server' || k === 'host' || k === 'data source') out.host = v;
        else if (k === 'port') out.port = parseInt(v, 10) || 3306;
        else if (k === 'user' || k === 'uid' || k === 'user id' || k === 'username') out.user = v;
        else if (k === 'password' || k === 'pwd') out.password = v;
        else if (k === 'database' || k === 'initial catalog') out.database = v;
        else if (k === 'ssl' || k === 'sslmode') out.ssl = dsnSsl(v);
    }
    return clampDsn(out);
}

function clampDsn(out) {
    // Windows resolves localhost to ::1 first. MariaDB on this box is IPv4, and that path times out.
    // Any other host is a shared MariaDB for a second game server, so it is left alone.
    if (!out.host || out.host === 'localhost' || out.host === '::1') out.host = '127.0.0.1';
    return out;
}

// True when host names this machine. Traffic to any other host crosses a
// network, so boot warns when it has no TLS.
function isLoopbackHost(host) {
    const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// The mysql2 connection options every MariaDB link shares: address, login
// and TLS. Callers add their own pool and type settings.
function mariaLink(dsn) {
    const o = { host: dsn.host, port: dsn.port, user: dsn.user, password: dsn.password, database: dsn.database };
    if (dsn.ssl) o.ssl = dsn.ssl;
    return o;
}

function parseArgs(a, b, c, d, e) {
    // (nil, sql, params, cb) is the oxmysql MySQL.lua call. nil is not an
    // object, so the old test left sql null and used the params table as cb.
    let sql = a;
    let params = b;
    let cb = c;
    if (typeof a !== 'string' && typeof b === 'string') {
        sql = b;
        params = c;
        cb = d;
    } else if (typeof a !== 'string' && typeof b !== 'string' && typeof c === 'string') {
        sql = c;
        params = d;
        cb = e;
    }
    if (typeof params === 'function') {
        cb = params;
        params = null;
    }
    if (typeof sql === 'function') {
        cb = sql;
        sql = '';
        params = null;
    }
    if (typeof cb !== 'function') cb = null;
    return { sql: sql || '', params: params || [], cb };
}

const LUA_LIST_MAX = 65535;
const EXEC_MANY_KINDS = new Set(['query', 'insert', 'update', 'scalar', 'single', 'prepare', 'rawExecute']);

function luaValues(v) {
    if (v == null) return null;
    if (Array.isArray(v)) return v;
    if (typeof v !== 'object') return null;
    const keys = Object.keys(v);
    const nums = [];
    for (let i = 0; i < keys.length; i++) {
        if (/^\d+$/.test(keys[i])) nums.push(Number(keys[i]));
    }
    if (!nums.length) return null;
    const min = nums.reduce((m, n) => Math.min(m, n), nums[0]);
    const max = nums.reduce((m, n) => Math.max(m, n), 0);
    if (min === 0 && max === v.length - 1 && nums.length === v.length && Array.isArray(v)) return v;
    // The gaps are filled below, so { [2000000000] = 'x' } would build a
    // two-billion-slot array on the server thread. MySQL takes at most
    // 65535 placeholders; a larger key is a sparse table, not a list.
    if (max > LUA_LIST_MAX) throw new Error('a Lua table used as a list has key ' + max + '; the most is ' + LUA_LIST_MAX + ' (a sparse table?)');
    // Lua keys start at 1: { nil, 'b' } arrives with key 2 only, and 'b' is
    // still the second value. A map with key 0 is 0-based.
    const arr = [];
    for (let i = min === 0 ? 0 : 1; i <= max; i++) {
        if (Object.prototype.hasOwnProperty.call(v, i)) arr.push(v[i]);
        else if (Object.prototype.hasOwnProperty.call(v, String(i))) arr.push(v[String(i)]);
        else arr.push(null);
    }
    return arr;
}

function luaList(v) {
    if (v == null) return [];
    if (Array.isArray(v)) return v;
    const values = luaValues(v);
    return values || (typeof v === 'object' ? [] : v);
}

function packParams(params) {
    if (params == null) return [];
    if (Array.isArray(params)) return params;
    if (typeof params === 'object') {
        const values = luaValues(params);
        if (values) return values;
        return params;
    }
    return [params];
}

function namedToPositional(sql, params) {
    if (params == null || Array.isArray(params)) return { sql, params: params == null ? [] : params };
    if (typeof params !== 'object') return { sql, params: [params] };
    const keys = Object.keys(params);
    if (keys.length === 0) return { sql, params: [] };
    if (keys.every((k) => /^\d+$/.test(k))) return { sql, params: packParams(params) };
    const values = [];
    // oxmysql's named-placeholders drops a leading @ or : from each key, so
    // mysql-async's { ['@id'] = 1 } binds @id the same as { id = 1 }.
    const bare = keys.map((k) => (k[0] === '@' || k[0] === ':' ? k.slice(1) : k));
    const replacer = (m, a, b) => {
        const name = a || b;
        if (Object.prototype.hasOwnProperty.call(params, name)) {
            values.push(params[name]);
            return '?';
        }
        const exact = bare.indexOf(name);
        if (exact >= 0) {
            values.push(params[keys[exact]]);
            return '?';
        }
        const lower = name.toLowerCase();
        for (let i = 0; i < keys.length; i++) {
            if (bare[i].toLowerCase() === lower) {
                values.push(params[keys[i]]);
                return '?';
            }
        }
        // Lua omits nil fields. MySQL treats an unset @name as NULL.
        values.push(null);
        return '?';
    };
    const out = dialect.mapCode(sql, (chunk) => chunk.replace(/@([A-Za-z_][A-Za-z0-9_]*)|:([A-Za-z_][A-Za-z0-9_]*)/g, replacer));
    if (values.length) return { sql: out, params: values };
    return { sql, params: packParams(params) };
}

function plainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && !(value instanceof Date) && !Buffer.isBuffer(value);
}

function quoteAssign(name) {
    return '`' + String(name).replace(/`/g, '``') + '` = ?';
}

/**
 * mysql-async binds an object to SET ? and a row array to VALUES ?.
 * Expand both before translation so SQLite and the replica see the same
 * placeholders. A statement with no parameters keeps the marker, and
 * dialect.js refuses an UPDATE ... SET ? left without its object. An object
 * with no keys, or a key that is not a plain column name, is refused here:
 * dropping the key would run a different UPDATE than the caller wrote.
 */
function expandBulk(sql, params) {
    if (!Array.isArray(params)) {
        if (plainObject(params)) return expandBulk(sql, [params]);
        return { sql, params };
    }
    if (!/\bSET\s+\?(?!\s*=)/i.test(sql) && !/\bVALUES\s*\?(?!\s*,)/i.test(sql)) return { sql, params };
    let out = '';
    let from = 0;
    let at = 0;
    const values = [];
    // The same scanner translation uses, so a ? in a comment or a backtick
    // name is never bound.
    for (const i of placeholderOffsets(sql)) {
        const value = params[at++];
        const before = sql.slice(Math.max(0, i - 16), i);
        if (/\bSET\s+$/i.test(before) && plainObject(value)) {
            const keys = Object.keys(value);
            if (!keys.length) throw new Error('cis_database: SET ? got an object with no columns');
            const bad = keys.find((key) => !dialect.identOk(key));
            if (bad !== undefined) throw new Error('cis_database: SET ? column name is not a plain identifier: ' + JSON.stringify(bad.slice(0, 64)));
            out += sql.slice(from, i) + keys.map(quoteAssign).join(', ');
            for (const key of keys) values.push(value[key]);
            from = i + 1;
            continue;
        }
        if (/\bVALUES\s*$/i.test(before) && Array.isArray(value)) {
            const rows = Array.isArray(value[0]) ? value : [value];
            const lists = [];
            for (const row of rows) {
                if (!Array.isArray(row)) { lists.push('(?)'); values.push(row); continue; }
                lists.push('(' + row.map(() => '?').join(', ') + ')');
                for (const cell of row) values.push(cell);
            }
            out += sql.slice(from, i) + lists.join(', ');
            from = i + 1;
            continue;
        }
        values.push(value);
    }
    if (from === 0) return { sql, params };
    return { sql: out + sql.slice(from), params: values.concat(params.slice(at)) };
}

/**
 * Offsets of the `?` placeholders in MySQL code: not inside a string, a
 * backtick name or a comment. Strings follow MySQL rules (backslash escapes,
 * doubled quotes, double-quoted strings).
 * When inList is an array, it gets one flag per mark: true when the
 * innermost open paren around the mark is an IN ( ) list.
 * @param {string} sql
 * @param {boolean[]} [inList]
 * @returns {number[]}
 */
function placeholderOffsets(sql, inList) {
    const out = [];
    const n = sql.length;
    const parens = [];
    let i = 0;
    while (i < n) {
        const c = sql.charCodeAt(i);
        if (c === 39 || c === 34 || c === 96) { // ' " `
            i++;
            while (i < n) {
                const d = sql.charCodeAt(i);
                if (d === 92 && c !== 96) { i += 2; continue; } // backslash escape
                if (d === c) {
                    if (sql.charCodeAt(i + 1) === c) { i += 2; continue; }
                    break;
                }
                i++;
            }
            i++;
            continue;
        }
        if (c === 35 || (c === 45 && sql.charCodeAt(i + 1) === 45 && dialect.dashComment(sql, i))) { // # or -- before a space
            while (i < n && sql.charCodeAt(i) !== 10) i++;
            continue;
        }
        if (c === 47 && sql.charCodeAt(i + 1) === 42) { // /*
            const end = sql.indexOf('*/', i + 2);
            i = end < 0 ? n : end + 2;
            continue;
        }
        if (c === 63) {
            out.push(i);
            if (inList) inList.push(parens.length > 0 && parens[parens.length - 1]);
        } else if (inList && c === 40) { // (
            parens.push(IN_OPEN.test(sql.slice(Math.max(0, i - 8), i)));
        } else if (inList && c === 41) { // )
            parens.pop();
        }
        i++;
    }
    return out;
}
const IN_OPEN = /\bIN\s*$/i;

/**
 * The statement text the replica is sent. mysql2 binds params with
 * sql-escaper, which skips '...' strings, backtick names, "-- " and block
 * comments, but binds a ? inside a "..." string or after #, and reads --x as
 * code. SQLite bound the ? that placeholderOffsets found, so the replica copy
 * is rewritten by the same rules: a "..." string becomes the same '...'
 * string and every comment becomes a space. Text with
 * neither is returned as it is.
 * @param {string} sql
 * @returns {string}
 */
function replicaSqlText(sql) {
    const n = sql.length;
    let out = '';
    let from = 0;
    let i = 0;
    while (i < n) {
        const c = sql.charCodeAt(i);
        if (c === 39 || c === 96) { // ' ` are copied as they are
            i++;
            while (i < n) {
                const d = sql.charCodeAt(i);
                if (d === 92 && c !== 96) { i += 2; continue; }
                if (d === c) {
                    if (sql.charCodeAt(i + 1) === c) { i += 2; continue; }
                    break;
                }
                i++;
            }
            i++;
            continue;
        }
        if (c === 34) { // "..." to '...': "" is ", ' is \', escapes stay
            let lit = "'";
            let j = i + 1;
            while (j < n) {
                const d = sql.charCodeAt(j);
                if (d === 92) { lit += sql.slice(j, j + 2); j += 2; continue; }
                if (d === 34) {
                    if (sql.charCodeAt(j + 1) === 34) { lit += '"'; j += 2; continue; }
                    break;
                }
                lit += d === 39 ? "\\'" : sql[j];
                j++;
            }
            out += sql.slice(from, i) + lit + "'";
            i = j + 1;
            from = i;
            continue;
        }
        if (c === 35 || (c === 45 && sql.charCodeAt(i + 1) === 45 && dialect.dashComment(sql, i))) { // # or -- before a space
            let j = i;
            while (j < n && sql.charCodeAt(j) !== 10) j++;
            out += sql.slice(from, i) + ' ';
            i = j;
            from = i;
            continue;
        }
        if (c === 47 && sql.charCodeAt(i + 1) === 42) { // /*
            const end = sql.indexOf('*/', i + 2);
            out += sql.slice(from, i) + ' ';
            i = end < 0 ? n : end + 2;
            from = i;
            continue;
        }
        i++;
    }
    if (from === 0) return sql;
    return out + sql.slice(from);
}

/**
 * Collapse every run of whitespace outside string literals to one space.
 * Several dialect rewrites use /\s+WORD/-style patterns that backtrack on a
 * long run of spaces (16 KB of spaces in a CREATE took 1.5 s, 80 KB took
 * minutes, all on the server thread). Only applied to statements that have
 * such a run, before any of them see it.
 * @param {string} sql
 * @returns {string}
 */
function collapseSpace(sql) {
    let out = '';
    let i = 0;
    const n = sql.length;
    while (i < n) {
        const c = sql.charCodeAt(i);
        if (c === 39 || c === 34 || c === 96) {
            const start = i;
            i++;
            while (i < n) {
                const d = sql.charCodeAt(i);
                if (d === 92 && c !== 96) { i += 2; continue; }
                if (d === c) {
                    if (sql.charCodeAt(i + 1) === c) { i += 2; continue; }
                    break;
                }
                i++;
            }
            i++;
            out += sql.slice(start, i);
            continue;
        }
        if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11) {
            while (i < n) {
                const d = sql.charCodeAt(i);
                if (d !== 32 && d !== 9 && d !== 10 && d !== 13 && d !== 12 && d !== 11) break;
                i++;
            }
            out += ' ';
            continue;
        }
        out += sql[i];
        i++;
    }
    return out;
}

function listParam(v) {
    if (v == null || typeof v !== 'object' || Buffer.isBuffer(v) || v instanceof Uint8Array || v instanceof Date) return null;
    return luaValues(v);
}

/**
 * Expand `IN (?)` bound to a list into `IN (?, ?, ?)` in the MySQL text, the
 * way mysql2 formats an array. It runs before translation, so SQLite and the
 * MariaDB copy get the same SQL and the same flat parameters (invariant 2).
 * A string is never split: 'Smith, John' stays one value, as in oxmysql. An
 * empty list becomes IN (NULL), which matches nothing on either side.
 */
function expandInLists(sql, params) {
    if (!params.length || !/\bIN\s*\(/i.test(sql)) return { sql, params };
    const inList = [];
    const marks = placeholderOffsets(sql, inList);
    let out = '';
    let from = 0;
    let changed = false;
    const values = [];
    for (let k = 0; k < marks.length; k++) {
        const at = marks[k];
        const value = k < params.length ? params[k] : null;
        const list = listParam(value);
        // Any mark inside the IN ( ) list, as mysql2 formats a list anywhere:
        // IN (?, 5), IN ('a', ?) and the second ? of IN (?, ?) too, however
        // long the list. A ? in a subquery or call inside it is not.
        if (list && inList[k]) {
            out += sql.slice(from, at) + (list.length ? list.map(() => '?').join(', ') : 'NULL');
            for (let j = 0; j < list.length; j++) values.push(list[j]);
            from = at + 1;
            changed = true;
            continue;
        }
        if (k < params.length) values.push(value);
    }
    if (!changed) return { sql, params };
    for (let k = marks.length; k < params.length; k++) values.push(params[k]);
    return { sql: out + sql.slice(from), params: values };
}

// Every call passes through here first: named, bulk and IN-list parameters
// become plain positional ones, and the same SQL and params go to both SQLite
// and the replica.
function normalizeParams(sql, params) {
    const named = namedToPositional(sql, packParams(params));
    const bulk = expandBulk(named.sql, named.params);
    if (!Array.isArray(bulk.params)) return bulk;
    // Counted before IN (?) lists expand, as oxmysql counts them.
    const padded = padParams(bulk);
    return bindVolatileCalls(expandInLists(padded.sql, padded.params));
}

const VOLATILE_HINT = /\b(?:UUID|UUID_SHORT|RAND)\s*\(\s*\)/i;
const VOLATILE_CALL = /(UUID_SHORT|UUID|RAND)\s*\(\s*\)/iy;
const ON_DUPLICATE = /ON\s+DUPLICATE\b/iy;
const uuidFn = dialect.sqlFunctions.find((f) => f.name === 'UUID').fn;
const uuidShortFn = dialect.sqlFunctions.find((f) => f.name === 'UUID_SHORT').fn;

/**
 * MariaDB computes UUID(), UUID_SHORT() and RAND() itself, so the copy of an
 * INSERT that sends the call stores another value than SQLite did: a row
 * keyed by UUID() gets another key there, later UPDATEs by that key miss, and
 * the next boot copies MariaDB's key back. In an INSERT or REPLACE ... VALUES
 * each call runs once per row as written, so it becomes a ? bound to a value
 * made here, the same on both sides. ON DUPLICATE KEY UPDATE, INSERT ...
 * SELECT and UPDATE keep the call: one value for every row would change what
 * they do (docs/KNOWN-GAPS.md).
 * @param {{ sql: string, params: any[] }} np
 * @returns {{ sql: string, params: any[] }}
 */
function bindVolatileCalls(np) {
    const sql = np.sql;
    if (!VOLATILE_HINT.test(sql) || !/^\s*(?:INSERT|REPLACE)\b/i.test(sql) || /\bSELECT\b/i.test(sql)) return np;
    const params = np.params;
    const values = [];
    const n = sql.length;
    let out = '';
    let from = 0;
    let k = 0;
    let i = 0;
    while (i < n) {
        const c = sql.charCodeAt(i);
        if (c === 39 || c === 34 || c === 96) { // ' " `
            i++;
            while (i < n) {
                const d = sql.charCodeAt(i);
                if (d === 92 && c !== 96) { i += 2; continue; }
                if (d === c) {
                    if (sql.charCodeAt(i + 1) === c) { i += 2; continue; }
                    break;
                }
                i++;
            }
            i++;
            continue;
        }
        if (c === 35 || (c === 45 && sql.charCodeAt(i + 1) === 45 && dialect.dashComment(sql, i))) { // # or -- before a space
            while (i < n && sql.charCodeAt(i) !== 10) i++;
            continue;
        }
        if (c === 47 && sql.charCodeAt(i + 1) === 42) { // /*
            const end = sql.indexOf('*/', i + 2);
            i = end < 0 ? n : end + 2;
            continue;
        }
        if (c === 63) { // ?
            if (k < params.length) values.push(params[k++]);
            i++;
            continue;
        }
        if (!/\w/.test(sql[i - 1] || ' ')) {
            ON_DUPLICATE.lastIndex = i;
            if (ON_DUPLICATE.test(sql)) break;
            VOLATILE_CALL.lastIndex = i;
            const call = VOLATILE_CALL.exec(sql);
            if (call) {
                const name = call[1].toUpperCase();
                values.push(name === 'RAND' ? Math.random() : name === 'UUID' ? uuidFn() : uuidShortFn());
                out += sql.slice(from, i) + '?';
                i += call[0].length;
                from = i;
                continue;
            }
        }
        i++;
    }
    if (from === 0) return np;
    while (k < params.length) values.push(params[k++]);
    return { sql: out + sql.slice(from), params: values };
}

// A Lua caller whose last values are nil sends fewer params than the SQL has
// marks. oxmysql pads them with null; SQLite would bind NULL on its own, but
// mysql2 leaves the extra ? in the text and MariaDB refuses the copy. More
// values than marks throws oxmysql's error, and a statement with no mark
// drops its values, as oxmysql's parseArguments does.
function padParams(np) {
    const p = np.params;
    let raw = 0;
    for (let i = np.sql.indexOf('?'); i >= 0 && raw <= p.length; i = np.sql.indexOf('?', i + 1)) raw++;
    // The plain count is every ?, including any in a string or comment, so it
    // only settles the common case: as many ? as values and nothing that could
    // hide one.
    if (raw === p.length && !/['"`#]|--|\/\*/.test(np.sql)) return np;
    const n = placeholderOffsets(np.sql).length;
    if (n === p.length) return np;
    if (n < p.length) {
        if (n === 0) return { sql: np.sql, params: [] };
        // Refused, not failed: MariaDB would ignore the extra values and answer.
        const e = new Error('Expected ' + n + ' parameters, but received ' + p.length + '.');
        e.cisRefused = true;
        throw e;
    }
    const out = p.slice();
    while (out.length < n) out.push(null);
    return { sql: np.sql, params: out };
}

function invokeCb(cb, resolve, reject, result, err) {
    if (!cb && !resolve && !reject) return;
    if (TRACE) trIn(TR_CB);
    try {
        if (err) {
            if (typeof cb === 'function') cb(false, String(err));
            if (reject) reject(err);
        } else {
            if (typeof cb === 'function') cb(result);
            if (resolve) resolve(result);
        }
    } catch (e) {
        log.error('A callback threw: ' + (e && e.message));
    } finally {
        if (TRACE) trOut();
    }
}

// ---- Durability: WAL sync, checkpoints, write acknowledgement ---------------
// SQLite runs in WAL mode with synchronous=NORMAL; the comments below explain
// how fsync cost is moved off the server thread without weakening durability.
function walMaxBytes() {
    const n = cfg && Number.isFinite(cfg.maxWal) ? cfg.maxWal : 104857600;
    return n > 0 ? n : 104857600;
}

// The main connection (synchronous=NORMAL) never fsyncs on commit; SQLite
// only syncs at a checkpoint: the WAL before copying its frames into the
// database file, then the database file before the WAL may be started over.
// Measured on our test box (AMD EPYC 7302, 1000 player saves) that is 3 ms + 4 ms
// copy + 16 ms, and 40 to 160 ms inside FXServer under load, all of it on the
// server thread. A checkpoint cycle here keeps that order and those
// guarantees, but runs both syncs on libuv's thread pool:
//
//   1. A read transaction on pinDb pins the WAL at its last frame M. While
//      it is open, no checkpoint copies a frame past M and no writer starts
//      the WAL over. (If every frame was already copied, the read takes
//      read-mark 0, which blocks every checkpoint until it ends: that cycle
//      copies nothing, which is just as safe.)
//   2. fdatasync(WAL) on the thread pool: every frame up to M is on disk.
//   3. PRAGMA wal_checkpoint(PASSIVE) on maintDb (synchronous=OFF, so it
//      does not sync again) copies frames up to M. This copy is the only
//      part on the server thread.
//   4. fdatasync(database) on the thread pool, then pinDb ends its read and
//      the next write may start the WAL over.
//
// A crash or power cut at any point leaves either the WAL frames or the
// copied pages on disk, as with SQLite's own checkpoint. The descriptors
// stay open until the database closes: on POSIX, closing any descriptor of a
// file drops every lock this process holds on it, SQLite's included.
let pinDb = null;
let pinStmt = null;
let ckptStmt = null;
let ckptFds = null;
let ckptBusy = false;
let walPinned = false;
let ckptSplit = true;
let ckptN = 0;
let ckptCopyMax = 0;
// Checkpoints run on the main connection, fsyncs included (checkpointMode).
let ckptThreadN = 0;
// SQLite starts the WAL over only when a write begins with every frame
// copied. A cycle copies up to its pin while writes go on appending, so
// under steady writes that moment never comes: 355000 updates in 20 s grew
// the WAL to 4.7 GB in tests/repro/ckpt_split.js's engine setup, and every
// read slows as it grows. Once the WAL holds WAL_RESTART_FRAMES, the next
// cycle quiesces: new calls wait in the queue, in arrival order, for its two
// syncs and the copy (milliseconds; the server thread is never held), so
// every frame is copied when the pin ends and the next write starts the WAL
// over. walFrames is the WAL's frame count from the last copy.
const WAL_RESTART_FRAMES = 8192;
const WAL_QUIESCE_MAX_MS = 2000;
let walFrames = 0;
let walQuiesce = false;
let walQuiesceTimer = null;
let walRestarts = 0;

function endQuiesce() {
    if (!walQuiesce) return;
    walQuiesce = false;
    if (walQuiesceTimer) { clearTimeout(walQuiesceTimer); walQuiesceTimer = null; }
    if (pendingCount() > 0) armSliceEnd();
}

/**
 * The setup traps the engine cannot fix itself (ship gate: a self-check that
 * names the fix). Each check is { state: OK | WARN | FAIL, name, detail, fix }.
 */
function doctorChecks() {
    const out = [];
    const add = (state, name, detail, fix) => out.push({ state, name, detail, fix: state === 'OK' ? '' : fix });
    let own = '';
    try { own = GetCurrentResourceName(); } catch (e) { /* not FXServer */ }
    add(own === 'cis_database' ? 'OK' : 'FAIL', 'folder', 'resource name is ' + own + '.',
        'rename the folder to cis_database; other resources load @cis_database files by that name.');
    // provide 'oxmysql' does not make GetResourceState('oxmysql') answer for
    // this resource on every build, so a started oxmysql only counts when its
    // folder is not this one.
    let oxState = 'missing';
    let oxOther = false;
    try {
        oxState = typeof GetResourceState === 'function' ? String(GetResourceState('oxmysql')) : 'missing';
        oxOther = (oxState === 'started' || oxState === 'starting') && GetResourcePath('oxmysql') !== GetResourcePath(own);
    } catch (e) { oxOther = false; }
    add(oxOther ? 'FAIL' : 'OK', 'oxmysql', oxOther ? 'a real oxmysql is ' + oxState + ' beside cis_database.' : 'no other oxmysql is running.',
        'remove ensure oxmysql from server.cfg and delete or move the oxmysql folder; cis_database provides it.');
    add(configError ? 'FAIL' : 'OK', 'config.json', configError ? 'does not parse (' + configError + '); every setting uses its default.' : 'parsed, or absent (defaults).',
        'fix the JSON syntax in config.json, then restart cis_database.');
    add(engineReady ? 'OK' : 'WARN', 'ready', engineReady ? 'answering queries.' : 'still copying from MariaDB or waiting for it.',
        'read the console above for the MariaDB error; queries wait until ready.');
    const kind = backend && backend.kind;
    const onFile = !!(backend && backend.filePath && backend.filePath !== ':memory:');
    add(kind === 'node:sqlite' && onFile ? 'OK' : 'WARN', 'SQLite', (kind || 'none') + (onFile ? ' file' : ' in memory') + '.',
        'use FXServer build 35245 or newer (Node 22 node:sqlite) and let FXServer write to cis_database/cache/.');
    if (onFile && storageMode === 'durable') {
        add(ckptSplit && maintDb ? 'OK' : 'WARN', 'checkpoint', ckptSplit && maintDb ? 'WAL syncs run off the server thread.' : 'WAL checkpoints run on the server thread.',
            'read the console for the "WAL checkpoints run on the server thread" warning; usually the cache/ disk refused a file.');
        add(fsyncErrN ? 'FAIL' : 'OK', 'disk sync', fsyncErrN ? fsyncErrN + ' fdatasync calls on the WAL failed; writes wait until one succeeds.' : 'every fdatasync of the WAL succeeded.',
            'check the disk under cis_database/cache/: free space, permissions and the kernel log for I/O errors.');
    }
    if (mysql2Missing) {
        add('FAIL', 'mysql2', 'mysql_connection_string is set but the mysql2 driver does not load (' + mysql2Missing + '), so nothing answers.',
            'copy node_modules/ from the release zip into the cis_database folder, then restart cis_database.');
    } else if (!replicaPool) {
        add('WARN', 'MariaDB copy', 'off: mysql_connection_string is not set, so writes stay in SQLite only.',
            'set mysql_connection_string in server.cfg, as for oxmysql.');
    } else {
        add(lastFlushSuccess ? 'OK' : 'WARN', 'MariaDB copy', lastFlushSuccess ? outboxPending + ' writes waiting.' : 'MariaDB is not answering; ' + outboxPending + ' writes wait in the outbox.',
            'check that MariaDB is running and that mysql_connection_string has the right host, user and password.');
        add(idReserveDenied ? 'WARN' : 'OK', 'ALTER privilege', idReserveDenied ? 'the MariaDB user cannot ALTER tables.' : 'not refused.',
            'GRANT ALTER on the game database to the MariaDB user, or insert rows only through the game.');
    }
    return out;
}

function checkpointMode(mode) {
    if (shuttingDown && mode !== 'TRUNCATE') return false;
    // maintDb runs with synchronous=OFF for the split cycle; anything else
    // checkpoints on the main connection, which syncs as SQLite always does.
    const db = backend;
    if (!db) return false;
    if (TRACE) trIn(TR_CKPT);
    ckptThreadN++;
    try {
        db.exec('PRAGMA wal_checkpoint(' + mode + ')');
        return true;
    } catch (e) {
        return false;
    } finally {
        if (TRACE) trOut();
    }
}

function replicaIdle() {
    return outboxPending === 0 && !replicaFlushing;
}

function unpinWal() {
    if (!walPinned) return;
    walPinned = false;
    try { pinDb.exec('COMMIT'); } catch (e) { /* ignore */ }
}

function ckptFail(where, e) {
    unpinWal();
    ckptBusy = false;
    endQuiesce();
    if (ckptSplit) {
        ckptSplit = false;
        log.warn('WAL checkpoints run on the server thread from now on (' + where + ': ' + (e && e.message || e) + ').');
    }
}

/**
 * One checkpoint cycle (see above). Starts nothing while one is running or
 * while a transaction is open on the main connection.
 */
function runWalCycle() {
    if (ckptBusy || shuttingDown || !backend || storageMode !== 'durable') return;
    if (txDepth > 0) {
        walCkptQueued = true;
        setTimeout(runWalCheckpoint, 50);
        return;
    }
    walWrites = 0;
    if (!ckptSplit || !pinDb || !maintDb || !ckptFds) {
        checkpointMode('PASSIVE');
        return;
    }
    ckptBusy = true;
    const quiesce = walFrames >= WAL_RESTART_FRAMES;
    if (quiesce) {
        walQuiesce = true;
        // A stalled disk must not hold every call for long: past this the
        // cycle carries on as a normal one and the WAL waits for the next.
        walQuiesceTimer = setTimeout(endQuiesce, WAL_QUIESCE_MAX_MS);
    }
    try {
        pinDb.exec('BEGIN');
        walPinned = true;
        pinStmt.get();
    } catch (e) {
        ckptFail('pin', e);
        return;
    }
    fs.fdatasync(ckptFds.wal, (e1) => {
        if (shuttingDown) { ckptBusy = false; return; }
        if (e1) return ckptFail('WAL sync', e1);
        // The copy counts against the slice budget like a query does. While
        // quiesced every call waits behind it, so it runs at once.
        if (walQuiesce) {
            enterBusy();
            try { copyWal(); } finally { leaveBusy(); }
        } else {
            gate({ t: J_FN, fn: copyWal });
        }
    });
}

function copyWal() {
    if (shuttingDown) { unpinWal(); ckptBusy = false; return; }
    const t0 = performance.now();
    let copied = false;
    if (TRACE) trIn(TR_CKPT);
    try {
        const r = ckptStmt.get();
        walFrames = Number(r && r.log) || 0;
        copied = walFrames > 0 && Number(r.checkpointed) === walFrames;
    } catch (e) {
        // SQLITE_BUSY from another checkpointer: nothing was copied.
    } finally {
        if (TRACE) trOut();
    }
    const copy = performance.now() - t0;
    if (copy > ckptCopyMax) ckptCopyMax = copy;
    if (copy >= HOLD_WARN_MS) noteHold('checkpoint', copy, 'The checkpoint copy of ' + walFrames + ' WAL frames', '');
    fs.fdatasync(ckptFds.db, (e2) => {
        if (shuttingDown) { ckptBusy = false; return; }
        if (e2) return ckptFail('database sync', e2);
        unpinWal();
        ckptBusy = false;
        ckptN++;
        if (walQuiesce) {
            walRestarts++;
            walFrames = 0;
            endQuiesce();
        } else if (copied && walFrames >= WAL_IDLE_RESTART_FRAMES && walWrites === 0) {
            restartIdleWal();
        }
        if (walWrites >= WAL_CKPT_WRITES && !walCkptQueued) {
            walCkptQueued = true;
            setImmediate(runWalCheckpoint);
        }
    });
}

// A cycle that copied every frame leaves them all valid until the next write
// starts the WAL over, and on an idle server that write may not come before a
// stop without a clean close (systemctl restart, a crash). The next start then
// replays every frame on the server thread: a 42 MB WAL held a qbox warm boot
// for 125 to 135 ms. So once a cycle has copied a WAL of at least
// WAL_IDLE_RESTART_FRAMES with nothing written since, one write of the file's
// own user_version (the same value; it touches page 1 only) starts it over,
// leaving one live frame. The WAL file keeps its size.
const WAL_IDLE_RESTART_FRAMES = 64;
function restartIdleWal() {
    if (shuttingDown || txDepth > 0 || walPinned || !backend || pendingCount() > 0) return;
    enterBusy();
    try {
        const v = Number(backend.get('PRAGMA user_version').user_version) || 0;
        backend.exec('PRAGMA user_version=' + v);
        walFrames = 0;
    } catch (e) {
        // The next write starts it over instead.
    } finally {
        leaveBusy();
    }
}

function runIdleWal() {
    if (shuttingDown) return;
    // Anything written since the last cycle is copied while the server is
    // quiet. The WAL file is not truncated here: journal_size_limit
    // (max_wal_bytes) trims it when a write starts it over, and a TRUNCATE
    // checkpoint syncs on the server thread.
    if (walWrites > 0 && (Date.now() - lastWriteTime) >= 2000) runWalCycle();
}

// The boot copy writes outside the queue, so no cycle stops it and the WAL
// never starts over: a 160,000-row copy left 139,000 frames, which a start
// after a kill replayed on the server thread inside journal_mode=WAL (411 ms).
// Between its slices the copy runs one whole cycle with nothing writing, so
// every frame is copied and its next write starts the WAL over. The syncs run
// on the thread pool; the copy is about WAL_SETTLE_FRAMES frames. Returns the
// frames the cycle found, 0 when none ran.
const WAL_SETTLE_FRAMES = 4096;
async function walSettle() {
    if (storageMode !== 'durable' || !ckptSplit || !pinDb || txDepth > 0) return 0;
    const until = Date.now() + 5000;
    const idle = async () => { while (ckptBusy && Date.now() < until) await new Promise((res) => setTimeout(res, 1)); };
    await idle();
    if (ckptBusy || txDepth > 0) return 0;
    runWalCycle();
    await idle();
    return walFrames;
}

// Reads get slower as the WAL grows: every page read searches the WAL index,
// one hash table per 4096 frames. A cycle every WAL_CKPT_WRITES rows changed
// keeps it short and keeps each copy to about a millisecond. Rows, not
// statements: one multi-row INSERT of 250 rows writes about 200 frames, and
// counted as one write a whole bulk import (cis_bench's seed: 240 such
// statements, about 190 MB of WAL) ran with no cycle at all, so the WAL grew
// far past the preallocated file and the first cycle after it copied for
// about 40 ms on the server thread.
const WAL_CKPT_WRITES = 256;
let walWrites = 0;
let walCkptQueued = false;

// Power-cut durability. With synchronous=NORMAL a commit is in the WAL file
// (the OS page cache) when it returns: safe from a crash of the server
// process, not from a power cut or an OS crash, which can lose the last
// commits (the file itself stays intact). synchronous=FULL would fsync on
// the server thread on every commit (0.9 ms median, 3.8 ms p99 on our test box).
// Instead a write's caller is answered only once an fdatasync of the WAL, run
// on libuv's thread pool, covers its commit (group commit: one sync covers
// every commit made before it started; 0.65 ms median for one commit on
// our test box). MariaDB under oxmysql does the same with
// innodb_flush_log_at_trx_commit=1. Reads are answered at once. The outbox
// is only sent to MariaDB up to the last synced row, so a power cut can never
// leave MariaDB holding a write SQLite lost.
// cis_database_ack 'process' answers writes at commit (the old behaviour);
// the replica gate stays either way.
let ACK_DURABLE = true;
let writeSeq = 0;
let syncedSeq = 0;
// Syncs in flight, and the newest writeSeq one of them covers.
let walSyncsInFlight = 0;
let walSyncTarget = 0;
let lastOutboxId = 0;
let durableOutboxId = 0;
let fsyncErrN = 0;
// After a failed sync the next one waits WAL_RETRY_MS, doubling to 30 s.
let walRetryMs = 0;
let walRetryAt = 0;
let walRetryTimer = null;
let fsyncN = 0;
let fsyncMsSum = 0;
let fsyncMsMax = 0;
const ackWaiters = [];

/** Run fn now, or once the WAL is synced if the call made a write (ws: writeSeq before it). */
function settleWrite(ws, fn) {
    if (writeSeq === ws || !ACK_DURABLE) {
        if (writeSeq !== ws) pumpWal();
        fn();
        return;
    }
    ackWaiters.push(writeSeq, fn);
    pumpWal();
}

function releaseAcks() {
    let n = 0;
    while (n < ackWaiters.length && ackWaiters[n] <= syncedSeq) n += 2;
    if (!n) return;
    const done = ackWaiters.splice(0, n);
    for (let i = 1; i < done.length; i += 2) {
        try { done[i](); } catch (e) { log.error('A write answer failed: ' + (e && e.message || e)); }
    }
}

function walSynced(target, obTarget) {
    if (target > syncedSeq) syncedSeq = target;
    if (obTarget > durableOutboxId) durableOutboxId = obTarget;
    releaseAcks();
    if (outboxPending > 0 && !activeFlushPromise && Date.now() >= outboxRetryAt) flushReplica();
}

// A write that commits while a sync is running is not covered by it: that
// sync may already have flushed the pages. Waiting for it to finish before
// starting the next one made such a write wait for most of two syncs, and
// inside FXServer each completion reaches this thread no sooner than about
// 1.2 ms after the last turn of the loop. So a second sync starts at once
// for writes the running one does not cover. Each sync covers every write
// committed before it started, whichever finishes first (fdatasync makes
// durable all data written to the file before the call), so syncedSeq only
// moves forward. More writes while two are running wait for the next.
const WAL_SYNC_MAX = 2;

function pumpWal() {
    if (syncedSeq >= writeSeq || walSyncTarget >= writeSeq || walSyncsInFlight >= WAL_SYNC_MAX) return;
    if (walRetryAt && Date.now() < walRetryAt) {
        if (!walRetryTimer) walRetryTimer = setTimeout(() => { walRetryTimer = null; pumpWal(); }, walRetryAt - Date.now());
        return;
    }
    const target = writeSeq;
    const obTarget = lastOutboxId;
    // No WAL file to sync: sql.js, :memory:, performance mode, or boot before
    // the files are open.
    if (!ckptFds || storageMode !== 'durable') {
        walSynced(target, obTarget);
        return;
    }
    walSyncsInFlight++;
    walSyncTarget = target;
    const t0 = performance.now();
    fs.fdatasync(ckptFds.wal, (e) => {
        walSyncsInFlight--;
        fsyncN++;
        const ms = performance.now() - t0;
        fsyncMsSum += ms;
        if (ms > fsyncMsMax) fsyncMsMax = ms;
        // A failed sync proves nothing is on disk, so its writes stay
        // unanswered and their outbox rows stay away from MariaDB. The sync
        // is retried; the first one that succeeds answers them.
        if (e) {
            fsyncErrN++;
            if (fsyncErrN === 1 || fsyncErrN % 100 === 0) log.error('fdatasync of the WAL failed (' + (e.message || e) + '): writes wait for a sync that succeeds; check the disk under cache/. ' + fsyncErrN + ' failures so far.');
            if (walSyncTarget === target) walSyncTarget = syncedSeq;
            walRetryMs = walRetryMs ? Math.min(walRetryMs * 2, 30000) : 1000;
            walRetryAt = Date.now() + walRetryMs;
        } else {
            walRetryMs = 0;
            walRetryAt = 0;
            walSynced(target, obTarget);
        }
        pumpWal();
    });
}

/**
 * At a stop: one blocking sync, then every waiting write is answered. If it
 * fails, they are not: their rows stay in the outbox for the next start.
 */
function syncWalNow() {
    if (walRetryTimer) { clearTimeout(walRetryTimer); walRetryTimer = null; }
    try {
        if (ckptFds && storageMode === 'durable') fs.fdatasyncSync(ckptFds.wal);
    } catch (e) {
        fsyncErrN++;
        log.error('fdatasync of the WAL failed at stop (' + (e.message || e) + '): writes not yet on disk are left unanswered.');
        return;
    }
    walSynced(writeSeq, lastOutboxId);
}

function noteWalWrite(rows) {
    writeSeq++;
    if ((walWrites += rows) < WAL_CKPT_WRITES || walCkptQueued || ckptBusy || storageMode !== 'durable') return;
    walCkptQueued = true;
    setImmediate(runWalCheckpoint);
}

function runWalCheckpoint() {
    walCkptQueued = false;
    runWalCycle();
}

function schedulePassiveCheckpoint() {
    if (checkpointScheduled) return;
    checkpointScheduled = true;
    setImmediate(() => {
        checkpointScheduled = false;
        runWalCycle();
    });
}

function closeCheckpointDbs() {
    unpinWal();
    for (const db of [pinDb, maintDb]) {
        try { if (db) db.close(); } catch (e) { /* ignore */ }
    }
    pinDb = null;
    maintDb = null;
    pinStmt = null;
    ckptStmt = null;
}

// Only after the main connection closed (see the note on descriptors above).
function closeCheckpointFds() {
    if (!ckptFds) return;
    try { fs.closeSync(ckptFds.wal); } catch (e) { /* ignore */ }
    try { fs.closeSync(ckptFds.db); } catch (e) { /* ignore */ }
    ckptFds = null;
}

// An fdatasync after a commit that only overwrites blocks the file already
// has is a data flush; one that grows the file also waits for the
// filesystem's journal commit. Measured on our test box (ext4, 4 KB writes):
// 0.21 ms vs 0.75 ms median, p99 1.1 vs 2.2 ms. Every answered write waits
// for one of these syncs. SQLite starts the WAL over from its beginning and
// keeps the file (journal_size_limit only trims it when larger), so the WAL
// is grown once at boot, with zeros, to the size it reaches before the
// quiesced restart; after that every commit is an overwrite. Zeros past the
// last frame are no frame to SQLite: recovery stops at the first frame whose
// page number is 0 or whose salts do not match the header's.
//
// This runs at boot, before the replica, CDC and every caller start, as
// async steps of WAL_PREALLOC_STEP with a turn of the event loop between
// them, then one fdatasync on the thread pool. Writing all 42 MB and
// syncing it in one go held the server thread for a 187 ms hitch warning on
// our test box. Filling it a step per turn while calls ran was worse on
// Windows: a sync in progress on the WAL blocks SQLite's next write to the
// file, and syncing fresh zeros took 40 to 210 ms. Each step writes at the
// file's end as it is at that moment, synchronously on this thread, where
// SQLite also writes, so a step never crosses a frame even if something
// writes meanwhile. A TRUNCATE checkpoint (exports.cis_database:checkpoint)
// empties the file again until the next boot.
let WAL_PREALLOC = true;
// oxmysql runs one statement per query unless the operator turns on
// multipleStatements; cis_database_multi_statements true is the same opt-in.
let MULTI_STATEMENTS = false;
let walPrealloc = 0;
let walFilling = false;
const WAL_PREALLOC_STEP = 4 << 20;

async function preallocWal() {
    if (!WAL_PREALLOC || !ckptFds) return;
    let page = 4096;
    try { page = Number(backend.prepare('PRAGMA page_size').get().page_size) || 4096; } catch (e) { /* default */ }
    const target = Math.min(walMaxBytes(), 32 + (page + 24) * Math.ceil(WAL_RESTART_FRAMES * 1.25));
    const fd = ckptFds.wal;
    const zero = Buffer.alloc(WAL_PREALLOC_STEP);
    walFilling = true;
    try {
        let end = fs.fstatSync(fd).size;
        while (end < target && !shuttingDown) {
            const n = fs.writeSync(fd, zero, 0, Math.min(zero.length, target - end), end);
            if (!(n > 0)) break;
            walPrealloc = end + n;
            await new Promise((res) => setImmediate(res));
            end = fs.fstatSync(fd).size;
        }
        walPrealloc = Math.max(walPrealloc, end);
        // The new size and blocks on disk now, so the first answer's sync
        // does not carry 42 MB of zeros.
        await new Promise((res) => fs.fdatasync(fd, () => res()));
    } catch (e) {
        log.warn('could not grow the WAL file ahead of time (' + (e && e.message || e) + '); writes still sync, a little slower.');
    } finally {
        walFilling = false;
    }
}

function fdatasyncAsync(fd) {
    return new Promise((res, rej) => fs.fdatasync(fd, (e) => (e ? rej(e) : res())));
}

// The split cycle's connections and descriptors. Boot opens them before the
// first write, so the copy from MariaDB checkpoints with the split cycle too:
// with checkpointMode on the main connection its WAL and database syncs held
// a cold boot (92,000 rows) for 113 to 199 ms on Windows, once per run.
async function openCheckpointDbs(filePath) {
    if (maintDb || !ckptSplit || !filePath || filePath === ':memory:' || storageMode !== 'durable') return;
    try {
        const DatabaseSync = require('node:sqlite').DatabaseSync;
        maintDb = new DatabaseSync(filePath);
        maintDb.exec('PRAGMA busy_timeout=0');
        maintDb.exec('PRAGMA synchronous=OFF');
        ckptStmt = maintDb.prepare('PRAGMA wal_checkpoint(PASSIVE)');
        // Each open reads the schema of every table: a step apiece at boot.
        await bootStep();
        pinDb = new DatabaseSync(filePath);
        pinDb.exec('PRAGMA busy_timeout=0');
        // Any read pins the WAL; sqlite_master exists before the outbox does.
        pinStmt = pinDb.prepare('SELECT COUNT(*) AS n FROM sqlite_master');
        await bootStep();
        backend.exec('PRAGMA journal_size_limit=' + walMaxBytes());
        // journal_mode=WAL has made the WAL file by now; O_CREAT only keeps a
        // missing one from turning the split cycle off.
        if (!ckptFds) {
            ckptFds = {
                db: fs.openSync(filePath, 'r+'),
                wal: fs.openSync(filePath + '-wal', fs.constants.O_RDWR | fs.constants.O_CREAT),
            };
        }
    } catch (e) {
        closeCheckpointDbs();
        ckptSplit = false;
        log.warn('WAL checkpoints run on the server thread: ' + (e && e.message || e));
    }
}

async function startCheckpointWorker(filePath) {
    if (checkpointTimer) {
        clearInterval(checkpointTimer);
        checkpointTimer = null;
    }
    await openCheckpointDbs(filePath);
    if (maintDb && ckptFds) {
        try {
            // Hydrate and the outbox import wrote without waiting; make the
            // file as it stands durable before the first call is answered.
            // The syncs run on the thread pool and boot awaits them before
            // ready: on the server thread they held a boot for 40-55 ms.
            const seq = writeSeq;
            const top = lastOutboxId;
            const fds = ckptFds;
            await fdatasyncAsync(fds.wal);
            await fdatasyncAsync(fds.db);
            // A file created since the last boot (the WAL every start, the
            // database on a first install) survives a power cut only once
            // its directory entry is on disk too. Windows cannot open a
            // directory; NTFS journals the entry itself.
            try {
                const dir = await fs.promises.open(path.dirname(filePath), 'r');
                try { await dir.sync(); } finally { await dir.close(); }
            } catch (e) { /* not supported here */ }
            syncedSeq = seq;
            durableOutboxId = top;
        } catch (e) {
            closeCheckpointDbs();
            ckptSplit = false;
            log.warn('WAL checkpoints run on the server thread: ' + (e && e.message || e));
        }
    }
    checkpointTimer = setInterval(runIdleWal, 3000);
    if (checkpointTimer.unref) checkpointTimer.unref();
}

// ---- Per-frame trace ---------------------------------------------------------
// Per-frame trace for finding hitch sources on a live server. Off unless the
// convar cis_database_frame_trace is 1; when off every hook is one boolean
// test. A frame is the time between two frame ticks (setTick), which is the Wait(0)
// tick a Lua hitch detector sees. Categories are exclusive time on this
// thread: nested work is charged to the inner category. "uv" is libuv loop
// active time (sockets, timers: mostly the MariaDB copy); "gc" overlaps the
// others; "other" is the rest of the frame, outside cis_database (other
// resources, Lua, export marshalling, the server's own work and sleep).
const TR_SQLITE = 0;
const TR_JS = 1;
const TR_CB = 2;
const TR_POLL = 3;
const TR_REPLICA = 4;
const TR_CKPT = 5;
const TR_N = 6;
const TR_NAMES = ['sqlite', 'js', 'cb', 'poll', 'replica', 'ckpt'];
const TR_HITCH_MS = 16.6;
const TR_WINDOW_MS = 2000;
const TR_BUCKETS = [4, 8, 16.6, 33, 50, 100, Infinity];
const TR_KEEP_WINDOWS = 600;
let TRACE = false;
const trStack = [];
const trFrame = new Float64Array(TR_N);
let trCalls = 0;
let trGcMs = 0;
let trLastPoll = 0;
let trElu = null;
let trT0 = 0;
let trWin = null;
let trTotal = null;
const trWindows = [];
let trWriting = false;
let trFile = '';

function trIn(cat) {
    trStack.push(cat, performance.now(), 0);
}

function trOut() {
    const child = trStack.pop();
    const start = trStack.pop();
    const cat = trStack.pop();
    const el = performance.now() - start;
    trFrame[cat] += el - child;
    if (trStack.length) trStack[trStack.length - 1] += el;
}

function trPart() {
    return { n: 0, gap: 0, cats: new Array(TR_N).fill(0), gc: 0, uv: 0, calls: 0 };
}

function trAgg(now) {
    return { t0: now, frames: 0, buckets: new Array(TR_BUCKETS.length).fill(0), maxGap: 0, all: trPart(), hitch: trPart(), worst: [] };
}

function trAdd(part, gap, uv) {
    part.n++;
    part.gap += gap;
    for (let i = 0; i < TR_N; i++) part.cats[i] += trFrame[i];
    part.gc += trGcMs;
    part.uv += uv;
    part.calls += trCalls;
}

function trFrameEnd(now) {
    // The frame tick runs from the first server tick; the trace starts once SQLite
    // is open.
    if (!trWin) return;
    if (!trLastPoll) {
        trLastPoll = now;
        trFrame.fill(0);
        trCalls = 0;
        trGcMs = 0;
        return;
    }
    const gap = now - trLastPoll;
    trLastPoll = now;
    let uv = 0;
    try {
        const e = performance.eventLoopUtilization();
        if (trElu) uv = Math.max(0, e.active - trElu.active);
        trElu = e;
    } catch (err) { /* not available in this runtime */ }
    let b = 0;
    while (gap >= TR_BUCKETS[b]) b++;
    for (const agg of [trWin, trTotal]) {
        agg.frames++;
        agg.buckets[b]++;
        if (gap > agg.maxGap) agg.maxGap = gap;
        trAdd(agg.all, gap, uv);
        if (gap > TR_HITCH_MS) trAdd(agg.hitch, gap, uv);
    }
    if (gap > TR_HITCH_MS) {
        const w = trWin.worst;
        if (w.length < 5 || gap > w[w.length - 1].gap) {
            const f = { t: +((now - trT0) / 1000).toFixed(2), gap: +gap.toFixed(2), uv: +uv.toFixed(2), gc: +trGcMs.toFixed(2), calls: trCalls };
            for (let i = 0; i < TR_N; i++) f[TR_NAMES[i]] = +trFrame[i].toFixed(2);
            w.push(f);
            w.sort((x, y) => y.gap - x.gap);
            if (w.length > 5) w.length = 5;
        }
    }
    trFrame.fill(0);
    trCalls = 0;
    trGcMs = 0;
    if (now - trWin.t0 >= TR_WINDOW_MS) trFlushWindow(now);
}

function trSummary(agg, now) {
    const per = (part) => {
        const out = { frames: part.n, gap: 0, other: 0, gc: 0, uv: 0, calls: 0 };
        if (!part.n) return out;
        let sum = 0;
        for (let i = 0; i < TR_N; i++) {
            out[TR_NAMES[i]] = +(part.cats[i] / part.n).toFixed(3);
            sum += part.cats[i];
        }
        out.gap = +(part.gap / part.n).toFixed(3);
        out.uv = +(part.uv / part.n).toFixed(3);
        out.gc = +(part.gc / part.n).toFixed(3);
        out.calls = +(part.calls / part.n).toFixed(2);
        out.other = +((part.gap - sum - part.uv) / part.n).toFixed(3);
        return out;
    };
    const buckets = {};
    TR_BUCKETS.forEach((lim, i) => { buckets[lim === Infinity ? '>=100' : '<' + lim] = agg.buckets[i]; });
    return {
        t: +((agg.t0 - trT0) / 1000).toFixed(2),
        seconds: +((now - agg.t0) / 1000).toFixed(2),
        frames: agg.frames,
        hitches: agg.hitch.n,
        maxGap: +agg.maxGap.toFixed(2),
        buckets,
        perFrame: per(agg.all),
        perHitchFrame: per(agg.hitch),
        worst: agg.worst,
    };
}

function trFlushWindow(now) {
    const s = trSummary(trWin, now);
    trWindows.push(s);
    if (trWindows.length > TR_KEEP_WINDOWS) trWindows.shift();
    const h = s.perHitchFrame;
    let line = 'frame_trace t=' + s.t + 's frames=' + s.frames + ' hitches=' + s.hitches + ' maxGap=' + s.maxGap + 'ms';
    if (s.hitches) {
        line += ' | per hitch frame: gap=' + h.gap + ' ' + TR_NAMES.map((n) => n + '=' + h[n]).join(' ')
            + ' uv=' + h.uv + ' gc=' + h.gc + ' other=' + h.other + ' calls=' + h.calls;
    }
    log.info(line);
    trWin = trAgg(now);
    if (!trWriting) {
        trWriting = true;
        const body = JSON.stringify({ hitchMs: TR_HITCH_MS, total: trSummary(trTotal, now), windows: trWindows });
        fs.promises.writeFile(trFile, body)
            .catch(() => {})
            .finally(() => { trWriting = false; });
    }
}

function startFrameTrace() {
    const now = performance.now();
    trT0 = now;
    trWin = trAgg(now);
    trTotal = trAgg(now);
    // One file per boot, so a restart right after a run does not overwrite it.
    trFile = path.join(resPath(), 'cache', 'frame_trace-' + Date.now() + '.json');
    try {
        const { PerformanceObserver } = require('perf_hooks');
        const obs = new PerformanceObserver((list) => {
            const entries = list.getEntries();
            for (let i = 0; i < entries.length; i++) trGcMs += entries[i].duration;
        });
        obs.observe({ entryTypes: ['gc'] });
    } catch (e) { /* gc entries not available */ }
    log.info('frame_trace on: a summary every ' + (TR_WINDOW_MS / 1000) + ' s, ' + trFile);
}

// Times the native SQLite calls. Only installed when the trace is on, so the
// normal backend object is untouched.
function traceBackend(b) {
    for (const name of ['run', 'all', 'get', 'exec']) {
        const fn = b[name];
        if (typeof fn !== 'function') continue;
        b[name] = function () {
            trIn(TR_SQLITE);
            try { return fn.apply(b, arguments); } finally { trOut(); }
        };
    }
    return b;
}

// ---- Slice and frame time budget ---------------------------------------------
// One time budget for every path. A slice is a stretch of cis_database work
// with no return to the event loop in between: the Lua threads of one server
// tick calling in, or one drain of the queue. Its cost is measured (SQL, JS,
// and the Lua callbacks it resumes, which run the caller's own code). Once it
// passes SLICE_MS the rest waits: a finished statement hands its result back
// later, so the caller's coroutine parks in Citizen.Await, and new calls join
// the queue in arrival order. setImmediate ends the slice once control is back
// in the event loop and drains the queue in further slices, so this resource
// never holds the server thread for much more than SLICE_MS at a time.
let SLICE_MS = 4;
const MAX_CB_DEPTH = 8;
const J_CB = 0;
const J_CALL = 1;
const J_FN = 2;
let cbDepth = 0;
let busyDepth = 0;
let busyStart = 0;
let sliceUsed = 0;
let sliceArmed = false;
let sliceTimer = null;
const pendingQ = [];
let pHead = 0;
let queuedN = 0;
// Longest slice since the last probe read, and how much work was in it.
let sliceMax = 0;

function pendingCount() {
    return pendingQ.length - pHead;
}

function sliceSpent() {
    return busyDepth > 0 ? sliceUsed + (performance.now() - busyStart) : sliceUsed;
}

// One budget per server frame as well. A frame is the time between two
// frame ticks (frameTick, a setTick that runs once per server tick). The
// slice budget alone let one frame hold several slices: during cis_bench's
// bulk import a frame ran two 250-row INSERTs, the Lua that built them, the
// MariaDB copy and the garbage collection they caused, up to 240 ms, and
// FXServer printed hitch warnings. Once FRAME_MS of work (this resource's
// own, and the Lua it resumes) is spent in a frame, calls wait for the next
// frame tick, which drains them; no slice wake is armed meanwhile. If no
// frame tick comes for FRAME_STALE_MS the frame budget lapses, so a stalled
// tick thread cannot hold calls.
// 25 ms leaves half of a 50 ms tick to entity sync, routing and the other
// resources on a full server; frameBudgetMs in config.json or the convar
// cis_database_frame_ms changes it.
let FRAME_MS = 25;
const FRAME_STALE_MS = 100;
let frameUsed = 0;
let frameAt = 0;
let frameTimer = null;
const frameWaiters = [];

function frameSpent() {
    if (!FRAME_MS || !frameAt) return 0;
    const now = performance.now();
    if (now - frameAt > FRAME_STALE_MS) {
        frameAt = now;
        frameUsed = 0;
    }
    return busyDepth > 0 ? frameUsed + (now - Math.max(busyStart, frameAt)) : frameUsed;
}

function frameFull() {
    return FRAME_MS > 0 && frameSpent() >= FRAME_MS;
}

function overBudget() {
    return sliceSpent() >= SLICE_MS || frameFull();
}

// Boot work that runs before the engine takes calls (the column meta, the
// strict-mode triggers of every table, ANALYZE, the checkpoint connections)
// goes in small steps: await bootStep() after each one, and the event loop
// gets a turn once boot has held the server thread for FRAME_MS. One clock
// for every stage, so stages run back to back cannot add up past the budget.
// Done in one block it held a qbox boot for one 300-540 ms hitch warning.
// The steps share the frame with the rest of this resource's work in it:
// the copy's statements and WAL cycles run in the same loop turn before the
// step resumes, and on its own clock a step ran a full FRAME_MS on top of
// them (38 ms turns at the end of a cold copy). So a step counts the frame
// spent when it resumed, and yields once the two together fill the frame.
// In the loops that only work the CPU between steps (cpu: the triggers,
// ANALYZE, the column types) it also yields when the next step, as long as
// the longest one so far, would run past the frame: one trigger rebuild of a
// wide table is 5 ms. Elsewhere the time between steps holds waits on
// MariaDB, so it says nothing about the next step.
let bootStepAt = 0;
let bootStepBase = 0;
let bootStepLast = 0;
let bootStepMax = 0;
async function bootStep(cpu) {
    const now = performance.now();
    if (!bootStepAt) { bootStepAt = now; bootStepBase = frameSpent(); }
    // Only steps under one frame count toward the longest.
    const step = cpu && bootStepLast ? now - bootStepLast : 0;
    if (step > bootStepMax && step < (FRAME_MS > 0 ? FRAME_MS : 25)) bootStepMax = step;
    bootStepLast = cpu ? now : 0;
    if (now - bootStepAt + bootStepBase + (cpu ? bootStepMax : 0) < (FRAME_MS > 0 ? FRAME_MS : 25) && !frameFull()) return;
    // A full frame waits for the next one; a turn alone would let one more
    // step run in the same frame.
    if (frameFull() && !shuttingDown) {
        await new Promise((res) => { frameWaiters.push(res); waitFrame(); });
    } else {
        await new Promise((res) => setImmediate(res));
    }
    bootStepAt = performance.now();
    bootStepLast = cpu ? bootStepAt : 0;
    bootStepBase = frameSpent();
}
const bootStepCpu = () => bootStep(true);

function releaseFrameWaiters(why) {
    if (frameWaiters.length) frameWaiters.splice(0).forEach((f) => f(why));
}

// Called from the frame tick: a new frame.
function startFrame() {
    frameAt = performance.now();
    frameUsed = 0;
    if (frameTimer) { clearTimeout(frameTimer); frameTimer = null; }
    releaseFrameWaiters('frame');
}

// Work waits for the next frame: the frame tick starts it, or this timer if
// no tick comes.
function waitFrame() {
    if (frameTimer) return;
    frameTimer = setTimeout(() => {
        frameTimer = null;
        frameAt = 0;
        frameUsed = 0;
        releaseFrameWaiters('frame');
        drainPending(false);
    }, FRAME_STALE_MS);
    if (frameTimer.unref) frameTimer.unref();
}

/**
 * Resolves when the slice and the frame have room. Background work (the
 * MariaDB copy) waits here before each step. A waiter resumes after the
 * queued calls of the new slice have run, so it checks again; after
 * BUDGET_ROOM_FRAMES frame starts it goes ahead anyway, so it is never
 * starved however busy the calls keep the budget (four 50 ms ticks at most).
 */
const BUDGET_ROOM_FRAMES = 4;
async function budgetRoom() {
    let frames = 0;
    while (!shuttingDown && overBudget()) {
        const why = await new Promise((res) => {
            frameWaiters.push(res);
            if (frameFull()) waitFrame();
            else armSliceEnd();
        });
        if (why === 'frame' && ++frames >= BUDGET_ROOM_FRAMES) return;
    }
}

// A call waits when the slice is spent or older calls are still queued, so
// statements run in the order they arrived. During a stop nothing waits.
function mustQueue() {
    return !shuttingDown && (walQuiesce || pHead < pendingQ.length || overBudget());
}

// A slice ends when the wake fires, which needs the event loop to have had a
// turn. Arming the wake after every call cost a datagram each, a third of
// the time of a primary-key read in tests/bench/call.js on Linux
// (23 us -> 15 us without it). So it is armed once SLICE_ARM_MS of work has
// built up, or when a job waits: at most one datagram per millisecond of
// work, and the slice still ends at the next turn after that. Before that, a
// slice also ends when this thread has done no work for us for SLICE_GAP_MS:
// whatever ran in between, it was not this resource holding the thread.
const SLICE_ARM_MS = 1;
const SLICE_GAP_MS = 1;
let lastLeaveAt = 0;

function enterBusy() {
    if (busyDepth++ === 0) {
        const now = performance.now();
        busyStart = now;
        if (!sliceArmed && sliceUsed > 0 && now - lastLeaveAt >= SLICE_GAP_MS) {
            if (sliceUsed > sliceMax) sliceMax = sliceUsed;
            sliceUsed = 0;
        }
    }
}

function leaveBusy() {
    if (--busyDepth === 0) {
        const now = performance.now();
        sliceUsed += now - busyStart;
        if (frameAt) frameUsed += now - Math.max(busyStart, frameAt);
        lastLeaveAt = now;
        if (frameFull()) {
            if (pHead < pendingQ.length) waitFrame();
        } else if (sliceUsed >= Math.min(SLICE_ARM_MS, SLICE_MS) || pHead < pendingQ.length) armSliceEnd();
    }
}

// How the slice end is woken. Measured with tests/fxserver/cis_wake on
// build 35245 (mean delay, idle / with libuv's four pool threads busy):
//   setImmediate, setTimeout(0)   ~50 ms   (they run once per server frame)
//   fs.stat completion            1.6 ms / 35 ms  (queues in the thread pool
//                                 behind fsyncs and other resources' files)
//   UDP datagram to itself        0.24 ms / 2.2 ms (p50 0.17 / 1.9)
//   MessageChannel message        0.09 ms / 0.8 ms
// A MessageChannel cannot be the wake: Node delivers every message queued on
// a port in one go, including ones posted from the handler, so the next
// slice would run without the event loop (and the server) getting a turn. A
// datagram is read on the loop's next poll, but libuv reads up to 32
// datagrams from a socket per readiness event, so one sent to the same
// socket from its own handler would be read in the same pass. Wakes
// therefore alternate between two sockets bound on 127.0.0.1: the one sent
// to was empty when the loop polled, and is read on the next turn. Each
// datagram carries the number of the slice it ends, so a late one cannot end
// a later slice early; a 50 ms timer stands behind it in case one is ever
// lost (inside FXServer a timer fires on the next frame anyway). 'io' is the
// fs.stat wake and 'timer' setImmediate with the same 2 ms timeout, kept for
// comparison. Measured delays are in probe() as wake_*.
let WAKE = 'udp';
let wakeSocks = null;
let wakePorts = null;
let wakeNext = 0;
let wakeGen = 0;
const WAKE_BUF = Buffer.alloc(1);
let wakeAt = 0;
let wakePath = '';
let wakeN = 0;
let wakeSum = 0;
let wakeMax = 0;

function armSliceEnd() {
    if (sliceArmed) return;
    sliceArmed = true;
    wakeAt = performance.now();
    if (WAKE === 'udp' && wakePorts) {
        wakeGen = (wakeGen + 1) & 255;
        WAKE_BUF[0] = wakeGen;
        wakeSocks[wakeNext].send(WAKE_BUF, wakePorts[wakeNext ^ 1], '127.0.0.1');
        wakeNext ^= 1;
        sliceTimer = setTimeout(endSlice, 50);
    } else if (WAKE === 'timer') {
        setImmediate(endSlice);
        sliceTimer = setTimeout(endSlice, 2);
    } else {
        fs.stat(wakePath || (wakePath = resPath()), endSlice);
    }
}

// Until both sockets are bound (or if they cannot be), slices wake on fs.stat.
function openWakeSocket() {
    if (wakeSocks || WAKE !== 'udp') return;
    try {
        const dgram = require('dgram');
        const socks = [dgram.createSocket('udp4'), dgram.createSocket('udp4')];
        const ports = [0, 0];
        let bound = 0;
        socks.forEach((sock, i) => {
            // Only the other wake socket wakes a slice: the port is open to
            // every local process.
            sock.on('message', (msg, from) => {
                if (msg[0] === wakeGen && wakePorts && from && from.port === wakePorts[i ^ 1]) endSlice();
            });
            sock.on('error', (e) => {
                if (wakePorts) log.warn('A slice wake socket failed (' + (e && e.message || e) + '); slices wake on an fs.stat completion.');
                closeWakeSocket();
            });
            sock.bind(0, '127.0.0.1', () => {
                ports[i] = sock.address().port;
                sock.unref();
                if (++bound === 2 && wakeSocks === socks) wakePorts = ports;
            });
        });
        wakeSocks = socks;
    } catch (e) {
        log.warn('No slice wake socket (' + (e && e.message || e) + '); slices wake on an fs.stat completion.');
    }
}

function closeWakeSocket() {
    const socks = wakeSocks;
    wakePorts = null;
    wakeSocks = null;
    if (socks) for (const sock of socks) { try { sock.close(); } catch (e) { /* ignore */ } }
}

function endSlice() {
    if (!sliceArmed) return;
    sliceArmed = false;
    const late = performance.now() - wakeAt;
    wakeN++;
    wakeSum += late;
    if (late > wakeMax) wakeMax = late;
    if (sliceTimer) { clearTimeout(sliceTimer); sliceTimer = null; }
    if (busyDepth > 0) { armSliceEnd(); return; }
    if (sliceUsed > sliceMax) sliceMax = sliceUsed;
    sliceUsed = 0;
    if (frameFull()) {
        if (pHead < pendingQ.length || frameWaiters.length) waitFrame();
        return;
    }
    releaseFrameWaiters('slice');
    drainPending(false);
}

function queueJob(job) {
    pendingQ.push(job);
    queuedN++;
    if (frameFull()) waitFrame();
    else armSliceEnd();
}

function compactPending() {
    if (pHead > 0 && pHead === pendingQ.length) {
        pendingQ.length = 0;
        pHead = 0;
    } else if (pHead > 1024) {
        pendingQ.splice(0, pHead);
        pHead = 0;
    }
}

function runJob(job) {
    if (job.t === J_CB) deliver(job.cb, job.resolve, job.reject, job.result, job.err);
    else if (job.t === J_CALL) dispatch(job.kind, job.sql, job.params, job.cb, job.resolve, job.reject);
    else job.fn();
}

/**
 * Run queued jobs until the slice is spent, or all of them when all is true
 * (the resource is stopping). Returns how many are left.
 * @param {boolean} all
 * @returns {number}
 */
function drainPending(all) {
    if (pHead >= pendingQ.length) return 0;
    enterBusy();
    try {
        while (pHead < pendingQ.length && (all || (!overBudget() && !walQuiesce && !hydrateHold))) {
            const job = pendingQ[pHead];
            pendingQ[pHead++] = null;
            try { runJob(job); } catch (e) { log.error('A queued call failed: ' + (e && e.message || e)); }
        }
    } finally {
        compactPending();
        leaveBusy();
    }
    return pendingCount();
}

/**
 * Run job now, inside the budget, or queue it.
 * @param {object} job
 */
function gate(job) {
    if (mustQueue()) {
        queueJob(job);
        return;
    }
    enterBusy();
    try { runJob(job); } finally { leaveBusy(); }
}

function deliver(cb, resolve, reject, result, err) {
    enterBusy();
    cbDepth++;
    try { invokeCb(cb, resolve, reject, result, err); }
    finally { cbDepth--; leaveBusy(); }
}

function finish(cb, resolve, reject, result, err) {
    // The statement has run. Past the budget the result waits for the next
    // slice, which parks the caller instead of letting it start another one.
    // A cis_call result goes back as the export's return value (cb.direct):
    // handing it over costs nothing here, and the caller's next call is held
    // back by the budget anyway.
    if (!shuttingDown && !(cb && cb.direct) && (cbDepth >= MAX_CB_DEPTH || overBudget())) {
        queueJob({ t: J_CB, cb, resolve, reject, result, err });
        return;
    }
    deliver(cb, resolve, reject, result, err);
}

function insertsRow(sql) {
    return /^\s*(?:INSERT|REPLACE)\b/i.test(sql);
}

// An upsert that updated a row leaves last_insert_rowid() as it was, so a
// changed value is the only proof that it inserted. Before each upsert the
// backends set it to -1 with this one-row TEMP table, an id no AUTO_INCREMENT
// row has. Comparing with the previous value failed when the new row's id
// equalled the outbox row id the last write left there (a fresh table).
const ROWID_RESET_TABLE = 'CREATE TEMP TABLE IF NOT EXISTS __cis_rowid (x INTEGER PRIMARY KEY)';
const ROWID_RESET = 'INSERT OR REPLACE INTO temp.__cis_rowid (x) VALUES (-1)';
function isUpsert(sql) {
    return insertsRow(sql) && /\bON\s+CONFLICT\b/i.test(sql);
}

// ---- SQLite backends -----------------------------------------------------------
// bindNative wraps node:sqlite and bindSqlJs wraps sql.js in the same small
// interface (run, all, get, exec, ...), so the rest of the engine does not care
// which one is loaded. Both register the cis_* SQL functions dialect.js emits.
function bindNative(db, filePath) {
    const stmts = new Map();
    try {
        applyModePragmas(db);
    } catch (e) { /* ignore */ }
    try {
        const crypto = require('crypto');
        const asText = (v) => (v == null ? null : String(v));
        if (typeof db.function === 'function') {
            db.function('MD5', (v) => {
                const s = asText(v);
                if (s == null) return null;
                return crypto.createHash('md5').update(s).digest('hex');
            });
            // REGEXP is dialect.js regexp (linear-time matcher), registered below.
            // LAST_INSERT_ID() is the last row a caller inserted. SQLite's
            // last_insert_rowid() also counts the outbox row written after it.
            db.function('cis_last_insert_id', () => lastInsertId);
            // BigInt arguments come back as INTEGER; a JS number would come
            // back REAL, and the upsert change guard would read 1.0 as a
            // change from 1.
            db.function('cis_set_insert_id', { useBigIntArguments: true }, cisSetInsertId);
            db.function('cis_database', () => dbName);
            db.function('cis_collation', () => dbCollation);
            db.function('cis_version', () => dbVersion);
            db.function('cis_strict', () => (strictMode && !strictOff ? 1 : 0));
            db.function('cis_store', cisStore);
            db.function('cis_storing', () => storeDepth);
            strictReady = true;
            db.function('cis_upserted', cisUpserted);
            upsertMarkReady = true;
            db.function('cis_text_mark', markImpure);
            textMarkReady = true;
            db.function('SHA2', (v, bits) => {
                const s = asText(v);
                if (s == null) return null;
                const n = Number(bits) || 256;
                const name = { 224: 'sha224', 256: 'sha256', 384: 'sha384', 512: 'sha512' }[n] || 'sha256';
                return crypto.createHash(name).update(s).digest('hex');
            });
            for (const f of dialect.sqlFunctions) {
                try {
                    db.function(f.name, { deterministic: !f.volatile, useBigIntArguments: !!f.bigint }, f.fn);
                } catch (e) { /* that function stays unavailable */ }
            }
        }
        // DatabaseSync.aggregate is newer than node:sqlite itself; without it
        // a read using STDDEV is answered by MariaDB.
        if (typeof db.aggregate === 'function') {
            for (const a of dialect.sqlAggregates) {
                try {
                    db.aggregate(a.name, { start: a.start, step: a.step, result: a.result, deterministic: true });
                } catch (e) { /* that aggregate stays unavailable */ }
            }
        }
    } catch (e) { /* hash functions stay unavailable */ }
    function prep(sql) {
        let s = stmts.get(sql);
        if (s) {
            // A hit moves the statement to the back, so the cache evicts the
            // least recently used one, not the oldest.
            stmts.delete(sql);
            stmts.set(sql, s);
        } else {
            if (stmts.size >= STMT_MAX) {
                const first = stmts.keys().next().value;
                try { stmts.get(first).finalize && stmts.get(first).finalize(); } catch (e) { /* ignore */ }
                stmts.delete(first);
            }
            s = db.prepare(sql);
            stmts.set(sql, s);
        }
        return s;
    }
    // See ROWID_RESET.
    db.exec(ROWID_RESET_TABLE);
    const cached = {};
    return {
        kind: 'node:sqlite',
        filePath,
        exec(sql) { db.exec(sql); },
        // exec() compiles its SQL on every call; these run once per write.
        savepoint() { (cached.sp || (cached.sp = db.prepare('SAVEPOINT cis_w'))).run(); },
        release() { (cached.rel || (cached.rel = db.prepare('RELEASE cis_w'))).run(); },
        rollbackTo() { (cached.rb || (cached.rb = db.prepare('ROLLBACK TO cis_w'))).run(); },
        run(sql, params) {
            const s = prep(sql);
            const p = sqliteBindList(params);
            const n = p.length;
            if (isUpsert(sql)) (cached.rid || (cached.rid = db.prepare(ROWID_RESET))).run();
            const info = n === 0 ? s.run()
                : n === 1 ? s.run(p[0])
                : n === 2 ? s.run(p[0], p[1])
                : n === 3 ? s.run(p[0], p[1], p[2])
                : n === 4 ? s.run(p[0], p[1], p[2], p[3])
                : s.run(...p);
            const lid = Number(info && info.lastInsertRowid || 0);
            const changes = Number(info && info.changes || 0);
            const inserted = changes > 0 && lid > 0 && insertsRow(sql);
            if (inserted) lastInsertId = lid;
            if (changes > 0) noteWalWrite(changes);
            return { changes, lastInsertRowid: inserted ? lid : 0 };
        },
        all(sql, params) {
            const s = prep(sql);
            const p = sqliteBindList(params);
            const n = p.length;
            const read = () => n === 0 ? s.all()
                : n === 1 ? s.all(p[0])
                : n === 2 ? s.all(p[0], p[1])
                : n === 3 ? s.all(p[0], p[1], p[2])
                : n === 4 ? s.all(p[0], p[1], p[2], p[3])
                : s.all(...p);
            const rows = s.cisBig ? read() : readSafe(s, sql, read);
            if (s.cisBig && rows) for (const r of rows) bigToMysql(r);
            return rows || [];
        },
        get(sql, params) {
            const s = prep(sql);
            const p = sqliteBindList(params);
            const n = p.length;
            const read = () => n === 0 ? s.get()
                : n === 1 ? s.get(p[0])
                : n === 2 ? s.get(p[0], p[1])
                : n === 3 ? s.get(p[0], p[1], p[2])
                : n === 4 ? s.get(p[0], p[1], p[2], p[3])
                : s.get(...p);
            const row = s.cisBig ? read() : readSafe(s, sql, read);
            if (s.cisBig && row) bigToMysql(row);
            return row || null;
        },
        // Each result column's name and the table and column it reads, as
        // SQLite resolves them (null for an expression); see castPlanFor.
        columns(sql) {
            const s = prep(sql);
            return typeof s.columns === 'function' ? s.columns() : null;
        },
        prepareRaw(sql) {
            return db.prepare(sql);
        },
        // Node 22's node:sqlite reads a statement's column list before the
        // step that re-prepares it after a schema change, so the first
        // SELECT * after an ALTER missed the new column. The cache is dropped
        // on every schema change (bumpSchema) and statements are prepared again.
        forgetStatements() {
            stmts.clear();
        },
        serialize() {
            try {
                if (typeof db.serialize === 'function') return db.serialize();
            } catch (e) { /* ignore */ }
            return null;
        },
        backupTo(dest) {
            const DatabaseSync = require('node:sqlite').DatabaseSync;
            const out = new DatabaseSync(dest);
            try {
                if (typeof db.backup === 'function') db.backup(out);
                else return false;
            } finally {
                try { out.close(); } catch (e) { /* ignore */ }
            }
            return true;
        },
        close() {
            try { db.close(); } catch (e) { /* ignore */ }
        },
    };
}

function bindSqlJs(db) {
    const stmts = new Map();
    function registerFunctions() {
        try {
            db.create_function('cis_last_insert_id', () => lastInsertId);
            // sql.js returns every JS number as REAL. A whole number goes back
            // as its text; dialect.js adds 0, which makes it INTEGER again.
            db.create_function('cis_set_insert_id', (v) => { const r = cisSetInsertId(v); return typeof r === 'number' && Number.isInteger(r) ? String(r) : r; });
        } catch (e) { /* LAST_INSERT_ID() stays unavailable */ }
        try {
            db.create_function('cis_database', () => dbName);
            db.create_function('cis_collation', () => dbCollation);
            db.create_function('cis_version', () => dbVersion);
        } catch (e) { /* information_schema stays unavailable */ }
        try {
            db.create_function('cis_strict', () => (strictMode && !strictOff ? 1 : 0));
            db.create_function('cis_store', cisStore);
            db.create_function('cis_storing', () => storeDepth);
            strictReady = true;
        } catch (e) { /* no strict-mode triggers */ }
        try { db.create_function('cis_upserted', cisUpserted); upsertMarkReady = true; } catch (e) { /* an upsert that updates reports insert id 0 */ }
        try { db.create_function('cis_text_mark', markImpure); textMarkReady = true; } catch (e) { /* text columns read as unchecked */ }
        for (const f of dialect.sqlFunctions) {
            try { db.create_function(f.name, f.fn); } catch (e) { /* that function stays unavailable */ }
        }
        for (const a of dialect.sqlAggregates) {
            try { db.create_aggregate(a.name, { init: a.start, step: a.step, finalize: a.result }); } catch (e) { /* that aggregate stays unavailable */ }
        }
    }
    registerFunctions();
    function prep(sql) {
        let s = stmts.get(sql);
        if (s) {
            // A hit moves the statement to the back, so the cache evicts the
            // least recently used one, not the oldest.
            stmts.delete(sql);
            stmts.set(sql, s);
        } else {
            if (stmts.size >= STMT_MAX) {
                const first = stmts.keys().next().value;
                try { stmts.get(first).free(); } catch (e) { /* ignore */ }
                stmts.delete(first);
            }
            s = db.prepare(sql);
            stmts.set(sql, s);
        }
        return s;
    }
    function bind(stmt, params) {
        stmt.reset();
        if (!params || !params.length) return;
        const bound = [];
        for (let i = 0; i < params.length; i++) {
            let v = params[i];
            // sql.js binds a BigInt as text and a number past 32 bits as a
            // REAL; digits as text take the column's affinity like MariaDB.
            if (typeof v === 'bigint') v = v >= -2147483648n && v <= 2147483647n ? Number(v) : v.toString();
            bound.push(v === undefined ? null : v);
        }
        stmt.bind(bound);
    }
    // See ROWID_RESET.
    db.run(ROWID_RESET_TABLE);
    const binding = {
        kind: 'sql.js',
        exec(sql) { db.run(sql); },
        run(sql, params) {
            if (isUpsert(sql)) { const r = prep(ROWID_RESET); r.step(); r.reset(); }
            const s = prep(sql);
            bind(s, params);
            s.step();
            s.reset();
            const changes = db.getRowsModified();
            let lastInsertRowid = 0;
            const head = sql.slice(0, 8).toUpperCase();
            if (changes > 0 && (head === 'INSERT I' || head === 'INSERT O' || head === 'REPLACE ')) {
                const row = db.exec('SELECT last_insert_rowid()');
                const lid = row && row[0] && row[0].values[0] ? Number(row[0].values[0][0]) : 0;
                if (lid > 0) {
                    lastInsertRowid = lid;
                    lastInsertId = lid;
                }
            }
            return { changes, lastInsertRowid };
        },
        all(sql, params) {
            const s = prep(sql);
            bind(s, params);
            const rows = [];
            while (s.step()) rows.push(s.getAsObject());
            s.reset();
            return rows;
        },
        get(sql, params) {
            const s = prep(sql);
            bind(s, params);
            let row = null;
            if (s.step()) row = s.getAsObject();
            s.reset();
            return row;
        },
        // sql.js cannot name a result column's table and column, so they
        // are read from the text (see lexicalColumns).
        columns(sql) { return lexicalColumns(sql); },
        // sql.js export() frees every prepared statement, drops every
        // create_function and TEMP object and closes and reopens the
        // connection. A cached statement then threw "Statement closed", and a
        // trigger calling cis_store would find no such function, so all of
        // it is set up again. Closing would also end an open transaction, so there
        // is no snapshot while one is open; boot takes it before Ready.
        serialize() {
            if (txDepth > 0) return null;
            const out = db.export();
            stmts.clear();
            registerFunctions();
            db.run(ROWID_RESET_TABLE);
            applyPragmas(binding);
            for (const v of dialect.infoSchemaViewsSql()) db.run(v);
            return out;
        },
        forgetStatements() {
            for (const s of stmts.values()) {
                try { s.free(); } catch (e) { /* ignore */ }
            }
            stmts.clear();
        },
        close() {
            for (const s of stmts.values()) {
                try { s.free(); } catch (e) { /* ignore */ }
            }
            stmts.clear();
            try { db.close(); } catch (e) { /* ignore */ }
        },
    };
    return binding;
}

// ---- Configuration -----------------------------------------------------------
// config.json supplies defaults; convars (cis_database_*) override them.
function configValue(block, key, fallback) {
    if (block && block[key] != null && block[key] !== '') return block[key];
    return fallback;
}

// The parse error of the last config.json read, for cis_database_doctor.
let configError = null;

// This build and the resources it stands in for, from fxmanifest.lua
// (cis_version, and version for oxmysql), for the boot log.
function bootLine() {
    const meta = (key) => (typeof GetResourceMetadata === 'function' ? GetResourceMetadata(GetCurrentResourceName(), key, 0) : null) || '';
    const own = meta('cis_version');
    const ox = meta('version');
    return 'cis_database' + (own ? ' ' + own : '') + ' provides oxmysql' + (ox ? ' ' + ox : '') + ', mysql-async and ghmattimysql';
}

function loadConfig() {
    const file = path.join(resPath(), 'config.json');
    let doc = null;
    let text = null;
    configError = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { text = null; }
    if (text != null) {
        try { doc = JSON.parse(text); } catch (e) {
            doc = null;
            configError = e.message;
            log.warn('config.json is not valid JSON (' + e.message + '); every setting uses its default.');
        }
    }
    const profileName = String(convar('cis_database_profile', '') || (doc && doc.activeProfile) || 'durable').toLowerCase();
    const profiles = doc && doc.profiles && typeof doc.profiles === 'object' ? doc.profiles : {};
    const picked = Object.prototype.hasOwnProperty.call(profiles, profileName)
        ? profiles[profileName]
        : (profiles.durable || {});
    const sq = picked.sqlite || {};
    const rp = Object.assign({}, (doc && doc.replication) || {}, picked.replication || {});
    const cd = Object.assign({}, (doc && doc.changeDataCapture) || {}, picked.changeDataCapture || {});
    const logging = (doc && doc.logging) || {};
    LOG_PREFIX = String(logging.prefix || '[cis_database]');
    LOG_SQL_ERRORS = logging.logSqlErrors !== false;
    SLOW_QUERY_MS = parseInt(logging.slowQueryThresholdMs != null ? logging.slowQueryThresholdMs : 100, 10) || 100;
    DEBUG = String(convar('cis_database_debug', doc && doc.debug ? '1' : '0')) === '1' || doc && doc.debug === true && convar('cis_database_debug', '') === '';
    REPLICA_FLUSH_MS = parseInt(convar('cis_database_flush_ms', String(configValue(rp, 'flushIntervalMs', 50))), 10) || 50;
    REPLICA_BATCH = parseInt(convar('cis_database_batch', String(configValue(rp, 'batchSize', 64))), 10) || 64;
    REPLICA_Q_MAX = parseInt(convar('cis_database_queue_max', String(configValue(rp, 'maxQueueEntries', 4096))), 10) || 4096;
    POOL_CONNECTIONS = parseInt(convar('cis_database_pool', String(configValue(rp, 'poolConnections', 4))), 10) || 4;
    CDC_POLL_MS = parseInt(convar('cis_cdc_interval', convar('cis_database_cdc_ms', String(configValue(cd, 'pollIntervalMs', 1000)))), 10) || 1000;
    CDC_DIRTY_TTL_MS = parseInt(convar('cis_database_dirty_ttl_ms', String(configValue(cd, 'dirtyTtlMs', 2000))), 10) || 2000;
    const forceMs = parseInt(convar('cis_database_cdc_force_ms', String(configValue(cd, 'forceMs', 10000))), 10);
    CDC_FORCE_MS = Number.isFinite(forceMs) && forceMs >= 0 ? forceMs : 10000;
    const resMs = parseInt(convar('cis_database_id_reserve_ms', '5000'), 10);
    ID_RESERVE_MS = Number.isFinite(resMs) && resMs >= 0 ? resMs : 5000;
    const resGap = parseInt(convar('cis_database_id_gap', '1000000'), 10);
    ID_RESERVE_GAP = Number.isFinite(resGap) && resGap >= 64 ? resGap : 1000000;
    const cdcOn = cd.enabled !== false;
    CDC_ENABLED = String(convar('cis_database_cdc', cdcOn ? '1' : '0')) !== '0';
    TRACE = String(convar('cis_database_frame_trace', '0')) === '1';
    const slice = parseFloat(convar('cis_database_slice_ms', String(configValue(doc, 'sliceMs', 4))));
    SLICE_MS = Number.isFinite(slice) ? Math.min(50, Math.max(0.5, slice)) : 4;
    const wake = String(convar('cis_database_wake', 'udp')).toLowerCase();
    WAKE = wake === 'timer' || wake === 'io' ? wake : 'udp';
    ACK_DURABLE = String(convar('cis_database_ack', 'power')).toLowerCase() !== 'process';
    AUTO_INDEX = String(convar('cis_database_auto_index', '1')) !== '0';
    MARIA_READS = String(convar('cis_database_maria_reads', '1')) !== '0';
    MARIA_READ_MS = parseInt(convar('cis_database_maria_read_ms', '30000'), 10) || 30000;
    WAL_PREALLOC = String(convar('cis_database_wal_prealloc', '1')) !== '0';
    MULTI_STATEMENTS = /^(1|true|yes|on)$/i.test(String(convar('cis_database_multi_statements', 'false')).trim());
    const frameMs = parseFloat(convar('cis_database_frame_ms', String(configValue(doc, 'frameBudgetMs', 25))));
    FRAME_MS = Number.isFinite(frameMs) && frameMs >= 0 ? Math.min(200, frameMs) : 25;
    const autoMs = parseFloat(convar('cis_database_auto_index_ms', '3'));
    AUTO_INDEX_MS = Number.isFinite(autoMs) && autoMs > 0 ? autoMs : 3;
    cfg = {
        profile: profileName,
        debug: DEBUG,
        sqlite: sq,
        maxWal: parseInt(convar('cis_database_wal_max_bytes', String(sq.max_wal_bytes != null ? sq.max_wal_bytes : 104857600)), 10),
    };
    // The boot log opens with the build, so a server console shows which
    // database answered as oxmysql. It prints here, once the configured
    // prefix applies.
    log.info(bootLine());
    log.info('config profile=' + profileName + ' debug=' + (DEBUG ? '1' : '0'));
}

function applyModePragmas(dbOrBackend) {
    const exec = (s) => dbOrBackend.exec(s);
    const sq = (cfg && cfg.sqlite) || {};
    const durable = storageMode === 'durable';
    // config.json values become PRAGMA text, so each must be one SQLite
    // accepts; anything else is the default.
    const pick = (key, def, ok) => {
        const v = sq[key];
        if (v == null || v === '') return def;
        const s = String(v).trim().toUpperCase();
        if (ok.test(s)) return s;
        log.warn('config.json sqlite.' + key + ' is not a value SQLite takes; using ' + def + '.');
        return def;
    };
    const journal = durable ? pick('journal_mode', 'WAL', /^(DELETE|TRUNCATE|PERSIST|MEMORY|WAL|OFF)$/) : 'OFF';
    const sync = durable ? pick('synchronous', 'NORMAL', /^([0-3]|OFF|NORMAL|FULL|EXTRA)$/) : '0';
    const cacheKb = parseInt(sq.cache_size_kb || 1048576, 10) || 1048576;
    const mmap = durable
        ? parseInt(sq.mmap_size_bytes || 1073741824, 10)
        : parseInt(sq.mmap_size_bytes || 2147483648, 10);
    const busy = parseInt(sq.busy_timeout_ms || 5000, 10) || 5000;
    const walAuto = pick('wal_autocheckpoint', '0', /^\d{1,9}$/);
    const list = durable ? [
        'PRAGMA temp_store=2',
        'PRAGMA journal_mode=' + journal,
        'PRAGMA synchronous=' + sync,
        'PRAGMA wal_autocheckpoint=' + walAuto,
        'PRAGMA cache_size=-' + cacheKb,
        'PRAGMA mmap_size=' + mmap,
        'PRAGMA cache_spill=OFF',
        'PRAGMA foreign_keys=ON',
        'PRAGMA case_sensitive_like=OFF',
        'PRAGMA busy_timeout=' + busy,
    ] : [
        'PRAGMA temp_store=2',
        'PRAGMA synchronous=' + sync,
        'PRAGMA journal_mode=OFF',
        'PRAGMA locking_mode=' + pick('locking_mode', 'EXCLUSIVE', /^(NORMAL|EXCLUSIVE)$/),
        'PRAGMA cache_size=-' + cacheKb,
        'PRAGMA mmap_size=' + mmap,
        'PRAGMA cache_spill=OFF',
        'PRAGMA query_only=OFF',
        'PRAGMA foreign_keys=ON',
        'PRAGMA busy_timeout=' + busy,
    ];
    for (let i = 0; i < list.length; i++) {
        try { exec(list[i]); } catch (e) { /* ignore */ }
    }
}

function applyPragmas(b) {
    applyModePragmas(b);
    // A temp_store change drops every TEMP table, so ROWID_RESET's table is
    // made again after it.
    b.exec(ROWID_RESET_TABLE);
}

// A JS Date as oxmysql sends it: mysql2 writes local time, and a DATETIME
// keeps whole seconds. toISOString() gave UTC with a T and a Z, which matched
// no 'YYYY-MM-DD HH:MM:SS' value and was another instant on a server whose
// clock is not UTC.
function mysqlDateTime(d) {
    if (Number.isNaN(d.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function sqliteBind(v) {
    if (v == null) return null;
    const t = typeof v;
    // node:sqlite binds every JS number as a REAL, so a Lua 5551234 written
    // to a VARCHAR would be stored as '5551234.0' and not match
    // '5551234'. A whole number is bound as an INTEGER, as MariaDB takes it.
    if (t === 'number') return Number.isSafeInteger(v) ? BigInt(v) : v;
    if (t === 'string' || t === 'bigint') return v;
    if (t === 'boolean') return v ? 1n : 0n;
    if (Buffer.isBuffer(v)) return v;
    if (v instanceof Uint8Array) return v;
    if (v instanceof Date) return mysqlDateTime(v);
    if (t === 'object') {
        if (v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data);
        try { return JSON.stringify(v); } catch (e) { return String(v); }
    }
    return String(v);
}

function expandPositional(params) {
    if (params == null) return [];
    if (Array.isArray(params)) {
        if (params.length === 1) {
            const only = params[0];
            if (only != null && typeof only === 'object' && !Array.isArray(only) && !Buffer.isBuffer(only)
                && !(only instanceof Uint8Array) && !(only instanceof Date)) {
                const inner = luaValues(only);
                if (inner && inner.length > 1) return expandPositional(inner);
            }
        }
        const direct = new Array(params.length);
        for (let i = 0; i < params.length; i++) direct[i] = sqliteBind(params[i]);
        return direct;
    }
    if (typeof params !== 'object') return [sqliteBind(params)];
    const values = luaValues(params);
    if (!values) return [];
    if (values.length === 1) {
        const only = values[0];
        if (only != null && typeof only === 'object' && !Buffer.isBuffer(only)
            && !(only instanceof Uint8Array) && !(only instanceof Date)) {
            const inner = luaValues(only);
            if (inner && inner.length > 1) return expandPositional(inner);
        }
    }
    const out = new Array(values.length);
    for (let i = 0; i < values.length; i++) out[i] = sqliteBind(values[i]);
    return out;
}

function expandInPlaceholders(sql, params) {
    if (!sql || sql.indexOf('IN') < 0 && sql.indexOf('in') < 0) return null;
    if (!params || !params.length) return null;
    let out = '';
    let pi = 0;
    let i = 0;
    let changed = false;
    const bound = [];
    while (i < sql.length) {
        const c = sql[i];
        if (c === "'" || c === '"') {
            const q = c;
            out += c;
            i++;
            while (i < sql.length) {
                out += sql[i];
                if (sql[i] === q) { i++; break; }
                i++;
            }
            continue;
        }
        if (c === '?') {
            const val = pi < params.length ? params[pi] : null;
            pi++;
            // IN (?) lists were expanded in the MySQL text by expandInLists,
            // for both sides. What is left here is json_each(?) from a
            // translated JSON function, which takes the list as JSON text.
            const list = listParam(val);
            let jsonList = list;
            if (!jsonList && typeof val === 'string' && val.charAt(0) === '[') {
                try { const parsed = JSON.parse(val); if (Array.isArray(parsed)) jsonList = parsed; } catch (e) { /* not a list */ }
            }
            const before = out.slice(-40);
            if (jsonList && jsonList.length && /json_each\(\s*$/i.test(before)) {
                out += '?';
                bound.push(JSON.stringify(jsonList));
                changed = true;
            } else if (list && list.length && /\bIN\s*\(\s*$/i.test(before)) {
                const marks = [];
                for (let k = 0; k < list.length; k++) {
                    marks.push('?');
                    bound.push(sqliteBind(list[k]));
                }
                out += marks.join(', ');
                changed = true;
            } else {
                out += '?';
                bound.push(sqliteBind(val));
            }
            i++;
            continue;
        }
        out += c;
        i++;
    }
    while (pi < params.length) bound.push(sqliteBind(params[pi++]));
    if (!changed) return null;
    return { sql: out, params: bound };
}

// node:sqlite throws on an integer past 2^53 unless the statement reads
// BigInts, and reading BigInts on every statement costs a conversion per
// value. So a read that throws for that reason switches its statement to
// BigInts for good and runs again. Only a plain read runs again: a write with
// RETURNING already wrote. mysql2 with supportBigNumbers (as oxmysql runs it)
// gives a safe integer as a number and a larger one as a decimal string.
const READ_AGAIN = /^\s*(?:SELECT|WITH|VALUES|PRAGMA)\b/i;
function readSafe(s, sql, read) {
    try { return read(); } catch (e) {
        if (!(e instanceof RangeError) || !/too large/i.test(e.message || '') || typeof s.setReadBigInts !== 'function' || !READ_AGAIN.test(sql) || /\bRETURNING\b/i.test(sql)) throw e;
        s.setReadBigInts(true);
        s.cisBig = true;
        return read();
    }
}
function bigToMysql(row) {
    for (const k in row) {
        const v = row[k];
        if (typeof v === 'bigint') row[k] = v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v.toString();
    }
    return row;
}
function sqliteBindList(params) {
    return expandPositional(params);
}

// ---- Opening the database and hydrating from MariaDB ----------------------------
// Open the SQLite file (or an in-memory/hot copy), then fill it from MariaDB
// on first boot. Hydration never replaces data SQLite already holds.
function openNodeSqlite(filePath) {
    let DatabaseSync;
    try {
        DatabaseSync = require('node:sqlite').DatabaseSync;
    } catch (e) {
        return null;
    }
    if (!DatabaseSync) return null;
    const db = filePath
        ? new DatabaseSync(filePath)
        : new DatabaseSync(':memory:');
    chmodPrivate(filePath);
    return bindNative(db, filePath || ':memory:');
}

async function openSqlJs(uint8) {
    let initSqlJs = null;
    const root = resPath();
    const candidates = [
        path.join(root, 'node_modules', 'sql.js', 'dist', 'sql-asm.js'),
        path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-asm.js'),
        path.join(root, 'node_modules', 'sql.js'),
        path.join(__dirname, 'node_modules', 'sql.js'),
        'sql.js',
    ];
    let lastErr = null;
    for (let i = 0; i < candidates.length; i++) {
        try {
            initSqlJs = require(candidates[i]);
            if (initSqlJs) {
                log.info('sql.js from ' + candidates[i]);
                break;
            }
        } catch (e) {
            lastErr = e;
        }
    }
    if (!initSqlJs) throw lastErr || new Error('sql.js missing');
    const SQL = await initSqlJs();
    const db = uint8 ? new SQL.Database(uint8) : new SQL.Database();
    const b = bindSqlJs(db);
    applyPragmas(b);
    return b;
}

function hydratePath() {
    return path.join(resPath(), 'cache', 'hydrate.sqlite');
}

function hotCopy(src) {
    if (storageMode === 'durable') {
        const dst = path.join(resPath(), 'cache', 'durable.sqlite');
        try {
            if (!fs.existsSync(dst)) {
                fs.copyFileSync(src, dst);
                chmodPrivate(dst);
            }
        } catch (e) { /* ignore */ }
        return dst;
    }
    // Copies a crashed or killed server left behind hold a full copy of
    // player data, in RAM when they sit in /dev/shm.
    sweepHotCopies('/dev/shm');
    sweepHotCopies(path.join(resPath(), 'cache'));
    // Every local account can write /dev/shm: a name it could guess, or a
    // copy onto a file it made first (or a symlink), would hand it the player
    // data. The name carries random bytes and the copy
    // refuses a file that is already there.
    const crypto = require('crypto');
    const fresh = () => 'cis_database_hot.' + process.pid + '.' + Date.now() + '.' + crypto.randomBytes(8).toString('hex') + '.sqlite';
    for (let i = 0; i < 3; i++) {
        const shm = path.join('/dev/shm', fresh());
        try {
            fs.copyFileSync(src, shm, fs.constants.COPYFILE_EXCL);
            chmodPrivate(shm);
            hotFile = shm;
            return shm;
        } catch (e) {
            if (!e || e.code !== 'EEXIST') break;
        }
    }
    const dst = path.join(resPath(), 'cache', fresh());
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    chmodPrivate(dst);
    hotFile = dst;
    return dst;
}

/**
 * Removes the hot copies in dir whose server process has exited, with their
 * -wal, -shm and -journal files. A copy whose pid still runs belongs to
 * another FXServer on the same host and is kept. Returns the count removed.
 */
function sweepHotCopies(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return 0; }
    let removed = 0;
    for (const name of names) {
        const m = /^cis_database_hot\.(\d+)\.\d+(?:\.[0-9a-f]+)?\.sqlite(?:-wal|-shm|-journal)?$/.exec(name);
        if (!m) continue;
        const pid = Number(m[1]);
        if (pid === process.pid) continue;
        try {
            process.kill(pid, 0);
            continue;
        } catch (e) {
            // EPERM: the process exists under another user, so it is in use.
            if (e && e.code === 'EPERM') continue;
        }
        try { fs.unlinkSync(path.join(dir, name)); removed++; } catch (e) { /* already gone */ }
    }
    return removed;
}

/** Removes a SQLite file and the -wal, -shm and -journal files beside it. */
function removeDbFile(file) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try { fs.unlinkSync(file + suffix); } catch (e) { /* not there */ }
    }
}

function ensureCacheDir() {
    const dir = path.join(resPath(), 'cache');
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { /* ignore */ }
    try { fs.chmodSync(dir, 0o700); } catch (e) { /* ignore */ }
    return dir;
}

function chmodPrivate(file) {
    try { if (file && file !== ':memory:' && fs.existsSync(file)) fs.chmodSync(file, 0o600); } catch (e) { /* ignore */ }
}

function isDangerousSql(sql) {
    return dialect.isForbiddenSql(sql);
}

function loadHydrateFile() {
    const p = hydratePath();
    try {
        if (fs.existsSync(p)) return fs.readFileSync(p);
    } catch (e) { /* ignore */ }
    return null;
}

function mysqlTypeToSqlite(dataType, columnType, extra, collation) {
    const dt = String(dataType || '').toLowerCase();
    const extraS = String(extra || '').toLowerCase();
    if (extraS.indexOf('auto_increment') >= 0) return 'INTEGER';
    if (/int|bit|bool|year/.test(dt)) return 'INTEGER';
    if (/decimal|float|double|numeric|real/.test(dt)) return 'REAL';
    if (/blob|binary|varbinary/.test(dt)) return 'BLOB';
    // A _bin or _cs column (JSON is utf8mb4_bin) tells case apart.
    if (/_(?:bin|cs)$/i.test(String(collation || ''))) return 'TEXT';
    return 'TEXT COLLATE NOCASE';
}

/**
 * A MariaDB information_schema COLUMN_DEFAULT as a SQLite DEFAULT clause, or
 * null when there is none or it is an expression SQLite cannot run. MariaDB
 * writes literals as SQL ('text', 0, NULL) and the time default as
 * current_timestamp().
 */
function sqliteDefault(raw, dataType, b) {
    if (raw == null) return null;
    const v = String(raw).trim();
    if (!v || /^NULL$/i.test(v)) return null;
    if (/^-?\d+(\.\d+)?$/.test(v)) return v;
    if (/^'(?:[^']|'')*'$/.test(v)) return v;
    if (/^current_timestamp(\(\d*\))?$/i.test(v) || /^now\(\d*\)$/i.test(v)) return dialect.defaultFromMaria('current_timestamp()', 'datetime');
    // An expression default (json_array(), curdate()...) is kept when
    // SQLite can evaluate it; a script that leaves the column out then gets
    // what MariaDB gives it instead of NULL.
    const expr = dialect.defaultFromMaria(v, dataType);
    if (expr == null) return null;
    try {
        (b || backend).get('SELECT ' + expr + ' AS v', []);
        return expr;
    } catch (e) {
        return null;
    }
}

const FK_RULES = { CASCADE: 'CASCADE', RESTRICT: 'RESTRICT', 'NO ACTION': 'NO ACTION', 'SET NULL': 'SET NULL', 'SET DEFAULT': 'SET DEFAULT' };

/**
 * MariaDB foreign keys as SQLite FOREIGN KEY clauses, by child table. A key
 * is kept only when its parent columns are a PRIMARY KEY or UNIQUE index:
 * SQLite needs one, where InnoDB takes any index, and without it every write
 * to either table fails with "foreign key mismatch".
 */
function hydrateForeignKeys(rows, idxMap, triggers) {
    const byName = new Map();
    for (const r of rows || []) {
        const t = r.TABLE_NAME || r.table_name;
        const key = t + '\u0000' + (r.CONSTRAINT_NAME || r.constraint_name);
        let fk = byName.get(key);
        if (!fk) {
            fk = { table: t, parent: r.REFERENCED_TABLE_NAME || r.referenced_table_name, cols: [], refs: [],
                upd: String(r.UPDATE_RULE || r.update_rule || '').toUpperCase(), del: String(r.DELETE_RULE || r.delete_rule || '').toUpperCase() };
            byName.set(key, fk);
        }
        fk.cols.push(r.COLUMN_NAME || r.column_name);
        fk.refs.push(r.REFERENCED_COLUMN_NAME || r.referenced_column_name);
    }
    const uniqueSets = (table) => {
        const sets = Object.create(null);
        for (const ir of idxMap[table] || []) {
            const nonUnique = ir.NON_UNIQUE != null ? ir.NON_UNIQUE : ir.non_unique;
            if (Number(nonUnique) !== 0) continue;
            const n = ir.INDEX_NAME || ir.index_name;
            (sets[n] = sets[n] || []).push(String(ir.COLUMN_NAME || ir.column_name).toLowerCase());
        }
        return Object.values(sets).map((s) => s.slice().sort().join(','));
    };
    const out = Object.create(null);
    for (const fk of byName.values()) {
        const names = [fk.table, fk.parent].concat(fk.cols, fk.refs);
        if (!names.every((x) => dialect.identOk(x))) continue;
        if (!uniqueSets(fk.parent).includes(fk.refs.map((c) => c.toLowerCase()).sort().join(','))) {
            // SQLite cannot declare it; triggers keep it (dialect.foreignKeyTriggersSql).
            triggers.push(...dialect.foreignKeyTriggersSql(fk.table, fk.cols, fk.parent, fk.refs, ' ON DELETE ' + fk.del + ' ON UPDATE ' + fk.upd));
            continue;
        }
        const q = (x) => '"' + x.replace(/"/g, '""') + '"';
        let clause = 'FOREIGN KEY (' + fk.cols.map(q).join(',') + ') REFERENCES ' + q(fk.parent) + ' (' + fk.refs.map(q).join(',') + ')';
        if (FK_RULES[fk.del]) clause += ' ON DELETE ' + FK_RULES[fk.del];
        if (FK_RULES[fk.upd]) clause += ' ON UPDATE ' + FK_RULES[fk.upd];
        (out[fk.table] = out[fk.table] || []).push(clause);
    }
    return out;
}

/** ON UPDATE CURRENT_TIMESTAMP columns of a MariaDB table, as triggers. */
function hydrateOnUpdate(b, name, columns) {
    let cols = null;
    for (const c of columns) {
        if (!/on update/i.test(String(c.EXTRA || c.extra || ''))) continue;
        cols = cols || (b.all('SELECT name FROM pragma_table_info(?)', [name]) || []).map((r) => r.name);
        const cname = c.COLUMN_NAME || c.column_name;
        if (!cols.some((x) => String(x).toLowerCase() === String(cname).toLowerCase())) continue;
        const trg = dialect.onUpdateTriggerSql(name, cname, cols, strictReady);
        if (trg) {
            try { b.exec(trg); } catch (e) { log.warn('ON UPDATE for ' + name + '.' + cname + ' not kept: ' + (e && e.message)); }
        }
    }
}

// Staging tables of builds before 1.0.0-beta.3, which copied under this name
// and renamed. A file from such a build may still hold one.
const HYDRATE_STAGE = '__cis_hydrate_';

// What hydrate knows each SQLite table holds, so a boot copies only the
// tables MariaDB changed since. sig is the table as hydrate builds it here;
// sum is MariaDB's CHECKSUM TABLE at a moment SQLite held the same rows, or
// NULL when unknown. copying is 1 while a copy runs: the table may be half
// full, so the file is not served alone until MariaDB copied it again.
const SYNC_SUMS = '__cis_sync_sums';
// The same sums, shared with Change Data Capture. Lowercased table names.
const syncSums = new Map();
// Writes to SYNC_SUMS that wait for no SQLite transaction to be open, so a
// game ROLLBACK cannot undo them. [table, sum] stores a sum, [table] forgets it.
const syncOps = [];
let syncOpsTimer = null;

function readSyncSums(b) {
    b.exec('CREATE TABLE IF NOT EXISTS "' + SYNC_SUMS + '" (table_name TEXT PRIMARY KEY, sig TEXT, sum TEXT, copying INTEGER NOT NULL DEFAULT 0)');
    const out = new Map();
    for (const r of b.all('SELECT table_name, sig, sum, copying FROM "' + SYNC_SUMS + '"', []) || []) out.set(String(r.table_name), r);
    return out;
}

/**
 * sqlite_sequence of a copied or unchanged table: the next id is MariaDB's
 * AUTO_INCREMENT, never below the ids SQLite already handed out (the reserve
 * base may predate rows the game wrote since the last reserve).
 */
function hydrateSequence(b, name, autoValue, autoincPk) {
    if (!(autoValue > 1 && autoincPk)) return;
    try {
        b.exec('CREATE TABLE IF NOT EXISTS sqlite_sequence (name TEXT PRIMARY KEY, seq INTEGER)');
        const had = b.get('SELECT seq FROM sqlite_sequence WHERE name = ?', [name]);
        const seq = Math.max(autoValue - 1, had ? Number(had.seq) || 0 : 0);
        if (!had || Number(had.seq) !== seq) b.run('INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES (?, ?)', [name, seq]);
    } catch (e) { /* sequence stays at the inserted high water */ }
}

/** True when a copy into SQLite was cut short, so some table may be half full. */
function syncCutShort(b) {
    try { return !!b.get('SELECT 1 AS n FROM "' + SYNC_SUMS + '" WHERE copying = 1 LIMIT 1', []); } catch (e) { return false; }
}

function flushSyncOps() {
    syncOpsTimer = null;
    if (!backend || !syncOps.length) return;
    if (txDepth > 0) {
        syncOpsTimer = setTimeout(flushSyncOps, 200);
        return;
    }
    const ops = syncOps.splice(0);
    try {
        for (const op of ops) {
            if (op.length > 1) backend.run('UPDATE "' + SYNC_SUMS + '" SET sum = ? WHERE table_name = ? AND copying = 0', [op[1], op[0]]);
            else backend.run('DELETE FROM "' + SYNC_SUMS + '" WHERE table_name = ?', [op[0]]);
        }
    } catch (e) { log.debug('sync sums not written: ' + (e && e.message)); }
}

function queueSyncOp(op) {
    syncOps.push(op);
    if (!syncOpsTimer) syncOpsTimer = setTimeout(flushSyncOps, 0);
}

/**
 * Forget what hydrate knew of these tables (comma-separated, lowercased), so
 * the next boot copies them from MariaDB: MariaDB refused a write SQLite took,
 * so the two differ while MariaDB's checksum stays the same.
 */
function forgetSync(tablesCsv) {
    if (!tablesCsv) return;
    for (const t of String(tablesCsv).split(',')) {
        if (!t || isInternalTable(t)) continue;
        syncSums.delete(t);
        queueSyncOp([t]);
    }
}

/**
 * True when SQLite already has a table by this name. SQLite table names are
 * case-insensitive, so `Users` and `users` are the same table here.
 */
function sqliteHasTable(b, name) {
    return !!b.get("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE LIMIT 1", [name]);
}

/**
 * Number of game tables SQLite holds. cis_database's own tables (the outbox,
 * staging tables from an interrupted copy) are not counted.
 */
function sqliteTableCount(b) {
    const row = b.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE ? ESCAPE '\\'", [INTERNAL_PREFIX.replace(/_/g, '\\_') + '%']);
    return row ? Number(row.n) || 0 : 0;
}

/**
 * Copy MariaDB's tables into SQLite. A table with writes MariaDB has not
 * confirmed yet is kept as it is, and so is one MariaDB has not changed since
 * SQLite last held the same rows (same schema, same CHECKSUM TABLE).
 * @param {object} [opts]
 * @param {boolean} [opts.all] Copy every table without pending writes, changed or not.
 * @returns {Promise<{tables:number, rows:number, kept:number, same:number}>} tables copied, rows copied, tables kept for pending writes, tables kept as unchanged.
 */
async function hydrateFromMaria(b, dsn, opts) {
    if (!mysql2mod) return { tables: 0, rows: 0, kept: 0, same: 0 };
    const all = !!(opts && opts.all);
    // Boot holds every call until ready, and the hydrate export holds them
    // until it ends (hydrateHold), so no call reaches a table between its copy
    // and its triggers: it may yield between tables and stages.
    const step = bootStep;
    // See walSettle: a cycle every settleEvery slices. Each one measures the
    // frames a slice writes, which sets the slices until the next.
    let settleEvery = 20;
    let settleSlices = 0;
    const settleTick = async () => {
        if (++settleSlices < settleEvery) return;
        const f = await walSettle();
        if (f > 0) settleEvery = Math.max(1, Math.min(200, Math.floor(WAL_SETTLE_FRAMES * settleSlices / f)));
        settleSlices = 0;
    };
    const conn = await mysql2mod.createConnection({
        ...mariaLink(dsn),
        connectTimeout: 3000,
        // Dates as MariaDB writes them ('2026-01-05 10:00:00'): as JS Dates
        // they were stored as UTC ISO text, a day early for a DATE on a
        // server east of UTC. A BIGINT past 2^53 comes as its digits.
        dateStrings: true,
        supportBigNumbers: true,
    });
    // Declared beside the connection so the finally block can see it.
    // Inside the try it is a separate binding, and the finally throws
    // "pageOpen is not defined" after MariaDB has already answered.
    let pageOpen = false;
    try {
        // Check MariaDB's outbox mark before the copy, so a file older than
        // MariaDB is found before the tables are kept (rewindOutbox). The
        // flush checks again if MariaDB refuses it here.
        if (outboxOn && !outboxStateReady) {
            try { await ensureReplicaState(conn); } catch (e) { log.debug('outbox mark not read at hydrate: ' + (e && e.message)); }
        }
        const stale = outboxStale;
        const [tables] = await conn.query(
            "SELECT table_name, auto_increment, table_collation FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name",
            [dsn.database]
        );
        const [cols] = await conn.query(
            'SELECT table_name, column_name, ordinal_position, data_type, column_type, is_nullable, column_default, extra, column_key, character_maximum_length, numeric_precision, numeric_scale, datetime_precision, collation_name, generation_expression FROM information_schema.columns WHERE table_schema = ? ORDER BY table_name, ordinal_position',
            [dsn.database]
        );
        const [idx] = await conn.query(
            'SELECT table_name, index_name, non_unique, seq_in_index, column_name FROM information_schema.statistics WHERE table_schema = ? ORDER BY table_name, index_name, seq_in_index',
            [dsn.database]
        );
        // Foreign keys, so a DELETE or UPDATE cascades in SQLite as it does in
        // MariaDB and a row MariaDB would refuse is refused here too.
        let fkRows = [];
        try {
            [fkRows] = await conn.query(
                'SELECT k.table_name, k.constraint_name, k.column_name, k.referenced_table_name, k.referenced_column_name, r.update_rule, r.delete_rule'
                + ' FROM information_schema.key_column_usage k JOIN information_schema.referential_constraints r'
                + ' ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name AND r.table_name = k.table_name'
                + ' WHERE k.table_schema = ? AND k.referenced_table_name IS NOT NULL ORDER BY k.table_name, k.constraint_name, k.ordinal_position',
                [dsn.database]
            );
        } catch (e) {
            log.warn('MariaDB foreign keys not read; copied tables have none: ' + (e && e.message));
        }
        const colMap = Object.create(null);
        for (let i = 0; i < cols.length; i++) {
            const t = cols[i].TABLE_NAME || cols[i].table_name;
            if (!colMap[t]) colMap[t] = [];
            colMap[t].push(cols[i]);
        }
        const idxMap = Object.create(null);
        for (let i = 0; i < idx.length; i++) {
            const t = idx[i].TABLE_NAME || idx[i].table_name;
            if (!idxMap[t]) idxMap[t] = [];
            idxMap[t].push(idx[i]);
        }
        const fkTriggers = [];
        const fkMap = hydrateForeignKeys(fkRows, idxMap, fkTriggers);
        // AUTO_INCREMENT values reserveIds raised. One MariaDB still holds
        // means nothing was inserted there since, so SQLite carries on from
        // the base it had, not from the top of the reserved range.
        const reserved = Object.create(null);
        try {
            const [rr] = await conn.query('SELECT table_name, raised_to, base FROM `' + ID_RESERVE + '`');
            for (const r of rr || []) reserved[String(r.table_name).toLowerCase()] = { raised: Number(r.raised_to), base: Number(r.base) };
        } catch (e) { /* no reserve table yet */ }
        let tableN = 0;
        let rowN = 0;
        let keptN = 0;
        let sameN = 0;
        const copiedNames = [];
        // One CHECKSUM TABLE over every table, read before any copy. A table
        // whose sum and schema match what SQLite was last copied at is not
        // copied again; a copied one stores its sum when MariaDB still has it
        // after the copy, so no row changed in between.
        const records = readSyncSums(b);
        syncSums.clear();
        const { checksumTables } = require('./cdc.js');
        const sumNames = [];
        for (let t = 0; t < tables.length; t++) {
            const n = tables[t].TABLE_NAME || tables[t].table_name;
            if (n && dialect.identOk(n) && !isInternalTable(n)) sumNames.push(n);
        }
        const sums = await checksumTables(conn, dsn.database, sumNames, log);
        const crypto = require('crypto');
        try { b.exec('PRAGMA foreign_keys=OFF'); } catch (e) { /* ignore */ }
        for (let t = 0; t < tables.length; t++) {
            const name = tables[t].TABLE_NAME || tables[t].table_name;
            if (!name || !dialect.identOk(name) || isInternalTable(name)) continue;
            const columns = colMap[name] || [];
            if (!columns.length) continue;
            const indexes = idxMap[name] || [];
            const pk = [];
            const uniques = Object.create(null);
            const secondaries = [];
            for (let i = 0; i < indexes.length; i++) {
                const ir = indexes[i];
                const iname = ir.INDEX_NAME || ir.index_name;
                const col = ir.COLUMN_NAME || ir.column_name;
                const seq = ir.SEQ_IN_INDEX || ir.seq_in_index;
                // MySQL 8 names the column NON_UNIQUE, MariaDB as selected. A
                // plain || turns NON_UNIQUE = 0 into undefined.
                const nonUnique = ir.NON_UNIQUE != null ? ir.NON_UNIQUE : ir.non_unique;
                const unique = Number(nonUnique) === 0;
                if (String(iname).toUpperCase() === 'PRIMARY') {
                    while (pk.length < seq) pk.push('');
                    pk[seq - 1] = col;
                    continue;
                }
                if (unique) {
                    if (!uniques[iname]) uniques[iname] = [];
                    while (uniques[iname].length < seq) uniques[iname].push('');
                    uniques[iname][seq - 1] = col;
                } else {
                    secondaries.push({ name: iname, col, seq, unique: false });
                }
            }
            const pkClean = pk.filter(Boolean);
            const parts = [];
            const generated = [];
            let autoincPk = false;
            // Columns made in SQLite. A name identOk refuses is left out of
            // the table and of the copy's INSERT: listing it there failed
            // every row, and a first install retried the copy forever.
            const madeCols = new Set();
            const leftOut = [];
            // SQLite numbers only an INTEGER PRIMARY KEY, so the AUTO_INCREMENT
            // column is that even when MariaDB's primary key is another one
            // (qb-core players: PRIMARY KEY (citizenid), KEY id (id)). That key
            // then becomes a unique index, its columns stay NOT NULL.
            const aiCol = columns.find((c) => String(c.EXTRA || c.extra || '').toLowerCase().indexOf('auto_increment') >= 0);
            const aiName = aiCol ? (aiCol.COLUMN_NAME || aiCol.column_name) : null;
            if (aiName && dialect.identOk(aiName) && pkClean.length && !(pkClean.length === 1 && pkClean[0] === aiName)) {
                uniques.PRIMARY = pkClean.slice();
            }
            for (let i = 0; i < columns.length; i++) {
                const c = columns[i];
                const cname = c.COLUMN_NAME || c.column_name;
                if (!dialect.identOk(cname)) { leftOut.push(String(cname)); continue; }
                madeCols.add(cname);
                const extra = c.EXTRA || c.extra || '';
                const auto = cname === aiName;
                if (auto) autoincPk = true;
                let piece = '"' + cname.replace(/"/g, '""') + '" ' + mysqlTypeToSqlite(c.DATA_TYPE || c.data_type, c.COLUMN_TYPE || c.column_type, extra,
                    c.COLLATION_NAME || c.collation_name);
                if (auto) piece += ' PRIMARY KEY AUTOINCREMENT';
                const notNull = String(c.IS_NULLABLE || c.is_nullable) === 'NO' && !auto;
                if (notNull) piece += ' NOT NULL';
                const gen = /GENERATED|PERSISTENT/i.test(extra) ? (c.GENERATION_EXPRESSION || c.generation_expression) : null;
                if (gen) {
                    // MariaDB computes it for every later write; a plain copy
                    // left NULL in rows written after hydration (esx owner_key).
                    generated.push({ name: cname, plain: parts.length, sql: piece + ' GENERATED ALWAYS AS (' + dialect.translateExpr(gen) + ')'
                        + (/VIRTUAL/i.test(extra) ? ' VIRTUAL' : ' STORED') });
                }
                const dflt = auto ? null : sqliteDefault(c.COLUMN_DEFAULT !== undefined ? c.COLUMN_DEFAULT : c.column_default, c.DATA_TYPE || c.data_type, b);
                if (dflt != null && !gen) piece += ' DEFAULT ' + dflt;
                parts.push(piece);
            }
            if (!parts.length) continue;
            if (!autoincPk && pkClean.length) {
                parts.push('PRIMARY KEY (' + pkClean.map((c) => '"' + c.replace(/"/g, '""') + '"').join(',') + ')');
            }
            for (const fk of fkMap[name] || []) parts.push(fk);
            let autoValue = 0;
            for (let i = 0; i < columns.length; i++) {
                const extra = String(columns[i].EXTRA || columns[i].extra || '').toLowerCase();
                if (extra.indexOf('auto_increment') >= 0) {
                    autoValue = Number(tables[t].AUTO_INCREMENT || tables[t].auto_increment || 0);
                    break;
                }
            }
            const rsv = reserved[name.toLowerCase()];
            if (rsv && autoValue > 0 && autoValue === rsv.raised && rsv.base > 0) autoValue = rsv.base;
            // MariaDB is the system of record. A table SQLite already has is
            // copied again when MariaDB changed it: it may have been edited
            // while the server was stopped (a panel, HeidiSQL, a stretch on
            // oxmysql), and a kept copy answered the old rows and handed out
            // ids MariaDB had already used. A table with writes still waiting
            // in the outbox is kept, deletes included, since MariaDB is behind
            // it; Change Data Capture copies it once those writes are in
            // (cdcRecheck).
            const lname = name.toLowerCase();
            const has = sqliteHasTable(b, name);
            const pendingHere = pendingTables.has(lname);
            const refresh = has && !pendingHere;
            if (!refresh && has) {
                keptN++;
                cdcRecheck.add(lname);
                log.warn('Table ' + name + ' has writes waiting for MariaDB, so it keeps what this SQLite file holds until they are sent.');
                // A table an older build copied has no ON UPDATE triggers yet.
                hydrateOnUpdate(b, name, columns);
                await step();
                continue;
            }
            const grouped = Object.create(null);
            for (let i = 0; i < secondaries.length; i++) {
                const s = secondaries[i];
                if (!grouped[s.name]) grouped[s.name] = [];
                grouped[s.name][s.seq - 1] = s.col;
            }
            // The table as this build makes it. A MariaDB column, index or key
            // change, or a build that maps a type another way, changes it.
            const sig = crypto.createHash('sha1').update(JSON.stringify([dsn.database, parts, generated.map((g) => g.sql), uniques, grouped,
                columns.map((c) => String(c.EXTRA || c.extra || ''))])).digest('hex');
            const sumNow = sums.get(lname);
            const rec = records.get(lname);
            if (refresh && !stale && !all && rec && !rec.copying && rec.sig === sig && sumNow != null && rec.sum === sumNow) {
                sameN++;
                syncSums.set(lname, sumNow);
                hydrateOnUpdate(b, name, columns);
                hydrateSequence(b, name, autoValue, autoincPk);
                await step();
                continue;
            }
            // The table is emptied and filled in place. SQLite renames a table
            // by rewriting every other table and trigger in the file, a pause
            // that grows with the schema (25-40 ms per table on 114 tables),
            // so there is no staging table. Until the copy ends the record
            // says copying, and a boot without MariaDB waits for it instead of
            // serving the half-full table.
            b.run('INSERT OR REPLACE INTO "' + SYNC_SUMS + '" (table_name, sig, sum, copying) VALUES (?, ?, NULL, 1)', [lname, sig]);
            const sqliteName = '"' + name.replace(/"/g, '""') + '"';
            const stageName = '"' + (HYDRATE_STAGE + name).replace(/"/g, '""') + '"';
            b.exec('DROP TABLE IF EXISTS ' + stageName);
            if (has) {
                // Its triggers go first: a cascade trigger on this table would
                // delete rows of a child table that is not copied again. The
                // rows go in chunks, so freeing a large table's pages does not
                // hold one frame.
                for (const tr of b.all("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE", [name]) || []) {
                    b.exec('DROP TRIGGER IF EXISTS "' + String(tr.name).replace(/"/g, '""') + '"');
                }
                await step();
                try {
                    while (true) {
                        const r = b.run('DELETE FROM ' + sqliteName + ' WHERE rowid IN (SELECT rowid FROM ' + sqliteName + ' LIMIT 1000)', []);
                        await step();
                        await settleTick();
                        if (!r || !(Number(r.changes) >= 1000)) break;
                    }
                } catch (e) { /* no rowid: DROP TABLE frees it whole */ }
                b.exec('DROP TABLE IF EXISTS ' + sqliteName);
                await step();
            }
            // Generated columns as SQLite expressions; one SQLite cannot take
            // leaves them plain columns, copied like the rest.
            let genCols = new Set();
            if (generated.length) {
                const withGen = parts.slice();
                for (const g of generated) withGen[g.plain] = g.sql;
                try {
                    b.exec('CREATE TABLE ' + sqliteName + ' (' + withGen.join(',') + ')');
                    genCols = new Set(generated.map((g) => g.name));
                } catch (e) {
                    log.warn('MariaDB table ' + name + ' keeps its generated columns as plain ones here: ' + (e && e.message));
                    b.exec('DROP TABLE IF EXISTS ' + sqliteName);
                    b.exec('CREATE TABLE ' + sqliteName + ' (' + parts.join(',') + ')');
                }
            } else {
                b.exec('CREATE TABLE ' + sqliteName + ' (' + parts.join(',') + ')');
            }
            for (const k of Object.keys(uniques)) {
                const colsU = uniques[k].filter(Boolean);
                if (!colsU.length) continue;
                try {
                    b.exec('CREATE UNIQUE INDEX IF NOT EXISTS "' + (name + '_' + k).replace(/"/g, '""') + '" ON ' + sqliteName + ' (' + colsU.map((c) => '"' + c.replace(/"/g, '""') + '"').join(',') + ')');
                } catch (e) { /* ignore */ }
            }
            for (const k of Object.keys(grouped)) {
                const colsS = grouped[k].filter(Boolean);
                if (!colsS.length) continue;
                try {
                    b.exec('CREATE INDEX IF NOT EXISTS "' + (name + '_' + k).replace(/"/g, '""') + '" ON ' + sqliteName + ' (' + colsS.map((c) => '"' + c.replace(/"/g, '""') + '"').join(',') + ')');
                } catch (e) { /* ignore */ }
            }
            await step();
            if (leftOut.length) {
                log.warn('MariaDB table ' + name + ' has columns this resource cannot name in SQL, so they are not copied: '
                    + leftOut.map((c) => JSON.stringify(c.slice(0, 64))).join(', ') + '. Rename them to letters, digits and _ to use them here.');
            }
            const qn = '`' + name.replace(/`/g, '``') + '`';
            const PAGE = 500;
            let offset = 0;
            let ins = null;
            let keys = null;
            pageOpen = false;
            while (true) {
                const [rows] = await conn.query('SELECT * FROM ' + qn + ' LIMIT ' + PAGE + ' OFFSET ' + offset);
                if (!rows || !rows.length) break;
                if (!keys) {
                    // SQLite computes generated columns and refuses values for them.
                    keys = Object.keys(rows[0]).filter((k) => !genCols.has(k) && madeCols.has(k));
                    const ph = keys.map(() => '?').join(',');
                    ins = 'INSERT INTO ' + sqliteName + ' (' + keys.map((k) => '"' + k.replace(/"/g, '""') + '"').join(',') + ') VALUES (' + ph + ')';
                }
                // A page is written in slices, one transaction each, with the
                // thread handed back between them.
                for (let r = 0; r < rows.length;) {
                    txDepth++;
                    lastTxStart = Date.now();
                    b.exec('BEGIN');
                    pageOpen = true;
                    const end = Math.min(rows.length, r + 100);
                    for (; r < end; r++) {
                        const vals = [];
                        for (let k = 0; k < keys.length; k++) vals.push(rows[r][keys[k]]);
                        b.run(ins, vals);
                        rowN++;
                    }
                    b.exec('COMMIT');
                    txDepth = 0;
                    pageOpen = false;
                    await step();
                    await settleTick();
                }
                offset += rows.length;
                if (rows.length < PAGE) break;
            }
            hydrateOnUpdate(b, name, columns);
            tableN++;
            copiedNames.push(name);
            hydrateSequence(b, name, autoValue, autoincPk);
            // MariaDB's sum after the copy. The same as before it means no row
            // changed while the pages were read, so SQLite holds that sum's rows.
            const sumAfter = sumNow != null ? (await checksumTables(conn, dsn.database, [name], log)).get(lname) : null;
            const sure = sumAfter != null && sumAfter === sumNow;
            b.run('UPDATE "' + SYNC_SUMS + '" SET sum = ?, copying = 0 WHERE table_name = ?', [sure ? sumNow : null, lname]);
            if (sure) syncSums.set(lname, sumNow);
            else if (sumNow != null) cdcRecheck.add(lname);
            await step();
        }
        txDepth = 0;
        await walSettle();
        // After every row is in: the triggers check a child row's parent, which
        // a table copied before its parent does not have yet. Kept tables get
        // them too, as they get ON UPDATE triggers.
        for (const s of fkTriggers) {
            try { b.exec(s); } catch (e) { log.debug('foreign key trigger skipped: ' + (e && e.message) + ' | ' + clipSql(s)); }
            await step();
        }
        try {
            const [sch] = await conn.query('SELECT default_collation_name AS c FROM information_schema.schemata WHERE schema_name = ?', [dsn.database]);
            if (sch && sch[0] && sch[0].c) setDefaultCollation(b, String(sch[0].c));
        } catch (e) { /* the collation stays as it was */ }
        try {
            const [ver] = await conn.query('SELECT VERSION() AS v');
            if (ver && ver[0] && ver[0].v) setServerVersion(b, String(ver[0].v));
        } catch (e) { /* the version stays as it was */ }
        try {
            // The replica's connections get the server's default sql_mode,
            // as this one does; it decides whether MariaDB refuses or cuts a
            // value that does not fit (refreshStrictTriggers).
            const [mode] = await conn.query('SELECT @@SESSION.sql_mode AS m');
            if (mode && mode[0] && mode[0].m != null) setSqlMode(b, String(mode[0].m));
        } catch (e) { /* the sql_mode stays as it was */ }
        try {
            // NOW() runs on this machine's local clock (dialect.js). A MariaDB
            // whose time_zone is not the system's stores other times.
            const [tz] = await conn.query('SELECT TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW()) AS m, @@session.time_zone AS z');
            const local = -new Date().getTimezoneOffset();
            if (tz && tz[0] && Math.abs(Number(tz[0].m) - local) > 1) {
                log.warn('MariaDB time_zone ' + tz[0].z + ' is UTC' + (tz[0].m >= 0 ? '+' : '') + (tz[0].m / 60) + ' but this server is UTC'
                    + (local >= 0 ? '+' : '') + (local / 60) + '; NOW() here and on the replica will differ by the gap');
            }
        } catch (e) { /* no check */ }
        await hydrateColumnMeta(b, cols, tables, bootStepCpu);
        await refreshAllStrictTriggersSliced(b, bootStepCpu);
        try { b.exec('PRAGMA foreign_keys=ON'); } catch (e) { /* ignore */ }
        if (tableN) await analyzeSliced(b, bootStepCpu, copiedNames);
        if (tableN > 0) bumpSchema();
        if (stale) {
            b.run('DELETE FROM "' + OUTBOX_META + '" WHERE k = ?', ['stale']);
            outboxStale = false;
            log.info('Copied ' + tableN + ' tables again from MariaDB after finding this SQLite file older than MariaDB.');
        }
        return { tables: tableN, rows: rowN, kept: keptN, same: sameN };
    } finally {
        txDepth = 0;
        if (pageOpen) {
            try { b.exec('ROLLBACK'); } catch (e) { /* the transaction already ended */ }
            pageOpen = false;
        }
        try { b.exec('PRAGMA foreign_keys=ON'); } catch (e) { /* ignore */ }
        try { await conn.end(); } catch (e) { /* ignore */ }
    }
}

// ---- Write bookkeeping and the replication outbox ---------------------------------
function callerResource() {
    try {
        if (typeof GetInvokingResource === 'function') return GetInvokingResource() || '';
    } catch (e) { /* ignore */ }
    return '';
}

function clipSql(sql) {
    const s = String(sql || '').replace(/\s+/g, ' ').trim();
    return s.length > 500 ? s.slice(0, 500) + '…' : s;
}

// The SQL with every quoted string and number shown as ?, for a log line: a
// literal can be player text. One pass over the characters, so a long
// statement cannot backtrack.
function sqlShape(sql) {
    const s = String(sql || '');
    const n = Math.min(s.length, 4000);
    let out = '';
    for (let i = 0; i < n; i++) {
        const c = s.charCodeAt(i);
        if (c === 39 || c === 34) {
            let j = i + 1;
            while (j < s.length && s.charCodeAt(j) !== c) j += s.charCodeAt(j) === 92 ? 2 : 1;
            out += '?';
            i = j;
        } else if (c >= 48 && c <= 57 && !(i > 0 && isWordCode(s.charCodeAt(i - 1)))) {
            while (i + 1 < n && (isWordCode(s.charCodeAt(i + 1)) || s.charCodeAt(i + 1) === 46)) i++;
            out += '?';
        } else {
            out += s[i];
        }
    }
    return clipSql(n < s.length ? out + '…' : out);
}

function isWordCode(c) {
    return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
}

// One statement is never split across slices, so a slow one holds the server
// thread for as long as it runs. The bench saw a 108 ms slice in its seed
// phase and nothing said which SQL it was. A statement, transaction, execMany
// list or checkpoint copy that holds the thread for HOLD_WARN_MS or more
// prints one line naming it: at most one line of each kind every
// HOLD_WARN_EVERY_MS, with a count of the ones left out since the last.
const HOLD_WARN_MS = 50;
const HOLD_WARN_EVERY_MS = 10000;
const holdWarnAt = new Map();
const holdWarnSkipped = new Map();

function noteHold(kind, ms, what, sql) {
    const now = Date.now();
    if (now - (holdWarnAt.get(kind) || 0) < HOLD_WARN_EVERY_MS) {
        holdWarnSkipped.set(kind, (holdWarnSkipped.get(kind) || 0) + 1);
        return;
    }
    const skipped = holdWarnSkipped.get(kind) || 0;
    holdWarnAt.set(kind, now);
    holdWarnSkipped.set(kind, 0);
    log.warn(what + ' held the server thread for ' + Math.round(ms) + ' ms' + (sql ? ': ' + sqlShape(sql) : '')
        + (skipped ? ' (' + skipped + ' more over ' + HOLD_WARN_MS + ' ms since the last line)' : ''));
}

// MariaDB quotes the value it refused ("Incorrect integer value: 'note' for
// column ..."), and that value is often player text. Outside debug, each
// quoted value becomes '?'; a quoted name (after key, column, table, ...)
// stays so the line still says what failed. A plain scan, not a regex, so a
// long message cannot backtrack.
function redactSqlError(msg) {
    const nameBefore = /\b(key|column|table|database|schema|index|constraint|function|procedure|field|in)\s*$/i;
    const s = String(msg);
    if (DEBUG) return s;
    let out = '';
    let i = 0;
    while (i < s.length) {
        const q = s.indexOf("'", i);
        if (q < 0) { out += s.slice(i); break; }
        // An apostrophe inside a word ("doesn't") opens no value.
        if (q > 0 && /\w/.test(s[q - 1])) {
            out += s.slice(i, q + 1);
            i = q + 1;
            continue;
        }
        let j = q + 1;
        while (j < s.length) {
            if (s[j] === '\\') j += 2;
            else if (s[j] === "'" && s[j + 1] === "'") j += 2;
            else if (s[j] === "'") break;
            else j++;
        }
        const end = Math.min(j + 1, s.length);
        out += s.slice(i, q);
        out += nameBefore.test(s.slice(Math.max(0, q - 24), q)) ? s.slice(q, end) : "'?'";
        i = end;
    }
    return out;
}

function noteDirtyList(tables) {
    if (!tables) return;
    for (let i = 0; i < tables.length; i++) {
        const name = String(tables[i] || '').toLowerCase();
        if (!name || !dialect.identOk(name)) continue;
        dirtyTables.add(name);
        if (cdcHandle && cdcHandle.noteDirty) cdcHandle.noteDirty(name);
    }
}

function enqueueReplica(sql, params, txBuf, tables, insertId) {
    const cached = !tables && sql ? dialect.cache.get(sql) : null;
    const resolvedTables = (tables && tables.length) ? tables : (cached && cached.tables) || null;
    if (txBuf) {
        txBuf.push(insertId ? { sql, params, tables: resolvedTables, id: insertId } : { sql, params, tables: resolvedTables });
        return;
    }
    if (resolvedTables && resolvedTables.length) noteDirtyList(resolvedTables);
    else if (sql) markDirtyTables(sql);
}

// Replication outbox. Every write MariaDB has not confirmed is a row of
// __cis_outbox, committed in the same SQLite transaction as the write, so a
// crash, a kill or a stop cannot lose it and nothing waits in memory. The
// flusher sends rows to MariaDB in id order, inside one MariaDB transaction
// that also stores the last id applied for this SQLite file (its epoch) in
// __cis_replica_state. A row is deleted only after that commit. A crash between
// the MariaDB commit and the delete is repaired at the next connect by reading
// the stored id, so every row is applied once.
const OUTBOX = '__cis_outbox';
const OUTBOX_META = '__cis_meta';
const REPLICA_STATE = '__cis_replica_state';
const INTERNAL_PREFIX = '__cis_';
let outboxOn = false;
let outboxEpoch = '';
let outboxPending = 0;
let outboxAppliedId = 0;
// The highest outbox id this file had handed out when it was opened, before
// MariaDB's mark for the epoch was checked (kept in __cis_meta as
// unchecked_from until the check). See rewindOutbox.
let outboxCheckFrom = 0;
// The file was found older than MariaDB (rewindOutbox): hydrate copies every
// table without pending writes again (kept in __cis_meta as stale).
let outboxStale = false;
let outboxStateReady = false;
let outboxRetryAt = 0;
let outboxFailN = 0;
let outboxPool = null;
// Pending outbox rows per table, lowercased. CDC leaves a table alone while it
// has writes MariaDB has not confirmed.
const pendingTables = new Map();
// Tables kept at hydrate because the outbox still had writes for them, or
// every table when the boot started from the SQLite file with MariaDB down.
// CDC copies each from MariaDB once, when nothing for it waits any more.
const cdcRecheck = new Set();
let obStmts = null;

function isInternalTable(name) {
    return String(name || '').toLowerCase().startsWith(INTERNAL_PREFIX);
}

function obValue(v) {
    if (v == null) return null;
    // Whole numbers reach here as BigInt (sqliteBind); MariaDB gets them as
    // numbers, so LIMIT ? and JSON_SET(..., ?) see 5, not '5'.
    if (typeof v === 'bigint') return v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : { $i: v.toString() };
    if (v instanceof Uint8Array) return { $b: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
    if (typeof v === 'number' && !Number.isFinite(v)) return null;
    return v;
}

function obParams(list) {
    if (!list || !list.length) return [];
    const out = new Array(list.length);
    for (let i = 0; i < list.length; i++) out[i] = obValue(list[i]);
    return out;
}

function obDecodeValue(v) {
    if (v && typeof v === 'object') {
        if (typeof v.$b === 'string') return Buffer.from(v.$b, 'base64');
        // mysql2 formats a BigInt as a quoted decimal string, so the string is
        // sent as it is.
        if (typeof v.$i === 'string') return v.$i;
    }
    return v;
}

function obDecodeParams(list) {
    if (!Array.isArray(list)) return [];
    const out = new Array(list.length);
    for (let i = 0; i < list.length; i++) out[i] = obDecodeValue(list[i]);
    return out;
}

function tablesOfSql(sql) {
    const hit = sql ? dialect.cache.get(sql) : null;
    if (hit && hit.tables) return hit.tables;
    try { return dialect.extractTables(sql); } catch (e) { return []; }
}

function notePending(tablesCsv, delta) {
    if (!tablesCsv) return;
    const list = tablesCsv.split(',');
    for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (!t) continue;
        const n = (pendingTables.get(t) || 0) + delta;
        if (n > 0) pendingTables.set(t, n);
        else pendingTables.delete(t);
    }
}

// ---- Column metadata, information_schema, strict mode ------------------------------
// information_schema (dialect.infoSchemaViewsSql) answers from SQLite, and
// what it says about a column's type is what MariaDB would say: hydration
// stores MariaDB's own information_schema.columns rows here, and CREATE and
// ALTER TABLE store the type they were written with (dialect.mysqlColumnMeta).
// A column with no row is described from its SQLite type. A row with a
// table name and no column name holds that table's collation; the row with
// neither, the database's default collation; the row with no table and the
// column name version, MariaDB's VERSION() in column_type.
const COLUMN_META = '__cis_columns';
const META_FIELDS = ['column_type', 'data_type', 'char_len', 'num_prec', 'num_scale', 'dt_prec', 'collation', 'extra', 'column_default', 'gen_expr', 'nullable'];

function openInfoSchema(b) {
    // AUTOINCREMENT also makes sqlite_sequence exist, which the tables view
    // reads for AUTO_INCREMENT.
    b.exec('CREATE TABLE IF NOT EXISTS "' + COLUMN_META + '" (id INTEGER PRIMARY KEY AUTOINCREMENT,'
        + ' table_name TEXT NOT NULL COLLATE NOCASE, column_name TEXT NOT NULL COLLATE NOCASE,'
        + ' column_type TEXT, data_type TEXT, char_len INTEGER, num_prec INTEGER, num_scale INTEGER, dt_prec INTEGER,'
        + ' collation TEXT, extra TEXT, column_default TEXT, gen_expr TEXT, nullable TEXT, UNIQUE (table_name, column_name))');
    const row = b.get('SELECT collation FROM "' + COLUMN_META + "\" WHERE table_name = '' AND column_name = ''", []);
    if (row && row.collation) dbCollation = String(row.collation);
    const ver = b.get('SELECT column_type FROM "' + COLUMN_META + "\" WHERE table_name = '' AND column_name = 'version'", []);
    if (ver && ver.column_type) dbVersion = String(ver.column_type);
    const mode = b.get('SELECT column_type FROM "' + COLUMN_META + "\" WHERE table_name = '' AND column_name = 'sql_mode'", []);
    if (mode && mode.column_type != null) applySqlMode(String(mode.column_type));
    for (const v of dialect.infoSchemaViewsSql()) b.exec(v);
    // Boot refreshes the strict-mode triggers next, in steps.
}

function applySqlMode(mode) {
    strictMode = /\bSTRICT_(?:TRANS|ALL)_TABLES\b/i.test(mode);
}

// The replica's sql_mode, kept for boots where MariaDB cannot be reached.
function setSqlMode(b, mode) {
    applySqlMode(mode);
    metaRun(b, 'INSERT INTO "' + COLUMN_META + "\" (table_name, column_name, column_type) VALUES ('', 'sql_mode', ?)"
        + ' ON CONFLICT (table_name, column_name) DO UPDATE SET column_type = excluded.column_type', [mode]);
}

/**
 * Builds a table's strict-mode triggers (dialect.strictTriggersSql) from its
 * column meta, replacing the ones it had. Triggers already as they should be
 * are left alone, so a boot changes nothing. A failure leaves the table
 * without them; it never fails the statement that changed the table.
 * @param {object} b backend
 * @param {string} table
 */
function refreshStrictTriggers(b, table) {
    if (!strictReady || !table || isInternalTable(table)) return;
    try {
        const info = b.all('SELECT name, type, pk FROM pragma_table_info(?)', [table]) || [];
        const pks = info.filter((c) => Number(c.pk) > 0);
        // The rowid alias reads -1 in a BEFORE INSERT trigger that was not given it.
        const skip = pks.length === 1 && /^INTEGER$/i.test(String(pks[0].type || '')) ? [pks[0].name] : [];
        const have = new Set(info.map((c) => String(c.name).toLowerCase()));
        const cols = (b.all('SELECT column_name, column_type, data_type, char_len, num_prec, num_scale, collation, extra FROM "' + COLUMN_META
            + "\" WHERE table_name = ? AND column_name <> ''", [table]) || []).filter((c) => have.has(String(c.column_name).toLowerCase()));
        // A column with no collation of its own has its table's, or the
        // database's: its character set decides what text it can hold.
        const own = b.get('SELECT collation FROM "' + COLUMN_META + "\" WHERE table_name = ? AND column_name = ''", [table]);
        const base = (own && own.collation) || (b.get('SELECT collation FROM "' + COLUMN_META + "\" WHERE table_name = '' AND column_name = ''", []) || {}).collation || null;
        for (const c of cols) if (!c.collation && base) c.collation = base;
        // TEMP triggers: every connection parses the file's whole schema on
        // its first statement, and these were most of it (727 KB of 773 KB
        // on qbox, about 50 ms per connection at boot). Only this connection
        // writes the game's tables, so only it needs them. SQLite keeps their
        // text without the TEMP.
        const want = dialect.strictTriggersSql(table, cols, skip, true);
        const kept = want.map((s) => s.replace('CREATE TEMP TRIGGER ', 'CREATE TRIGGER '));
        const prefix = dialect.STRICT_TRIGGER;
        dropFileStrictTriggers(b, table);
        const old = b.all("SELECT name, sql FROM sqlite_temp_master WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE AND substr(name, 1, ?) = ?",
            [table, prefix.length, prefix]) || [];
        if (!(old.length === want.length && old.every((t) => kept.indexOf(t.sql) >= 0))) {
            for (const t of old) b.exec('DROP TRIGGER IF EXISTS temp.' + quoteIdent(t.name));
            for (const s of want) b.exec(s);
        }
    } catch (e) {
        log.debug('strict-mode triggers not built for ' + table + ': ' + (e && e.message));
    }
    // ON UPDATE CURRENT_TIMESTAMP triggers skip the store triggers' rewrite
    // (cis_storing()), so a stamp the statement gave stays. One built before
    // that, or before stamps were local time, is rebuilt as it is now.
    try {
        const prefix = dialect.ON_UPDATE_TRIGGER;
        const stamps = b.all("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE AND substr(name, 1, ?) = ?",
            [table, prefix.length, prefix]) || [];
        if (!stamps.length) return;
        const names = (b.all('SELECT name FROM pragma_table_info(?)', [table]) || []).map((r) => r.name);
        for (const t of stamps) {
            const col = String(t.name).slice(String(t.name).lastIndexOf(':') + 1);
            const want = dialect.onUpdateTriggerSql(table, col, names, true);
            if (!want || want.replace('CREATE TRIGGER IF NOT EXISTS ', 'CREATE TRIGGER ') === t.sql) continue;
            b.exec('DROP TRIGGER IF EXISTS ' + quoteIdent(t.name));
            b.exec(want);
        }
    } catch (e) {
        log.debug('ON UPDATE triggers not rebuilt for ' + table + ': ' + (e && e.message));
    }
}

// Boot and hydrate: one table per step (bootStep).
async function refreshAllStrictTriggersSliced(b, step) {
    if (!strictReady) return;
    let tables = [];
    try { tables = b.all("SELECT DISTINCT table_name AS t FROM \"" + COLUMN_META + "\" WHERE table_name <> ''", []) || []; } catch (e) { return; }
    for (const r of tables) {
        if (sqliteHasTable(b, r.t)) refreshStrictTriggers(b, r.t);
        await step();
    }
}

// ANALYZE one table per step, which leaves the same statistics as one
// ANALYZE of the whole file. only: these tables alone.
async function analyzeSliced(b, step, only) {
    let tables = [];
    if (only) tables = only.map((name) => ({ name }));
    else try { tables = b.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'", []) || []; } catch (e) { return; }
    for (const r of tables) {
        try { b.exec('ANALYZE main.' + quoteIdent(r.name)); } catch (e) { /* stats stay empty */ }
        await step();
    }
}

// Strict-mode triggers an earlier build kept in the file's schema. table:
// that table's only.
function fileStrictTriggers(b, table) {
    const prefix = dialect.STRICT_TRIGGER;
    return b.all("SELECT name, tbl_name AS t FROM sqlite_master WHERE type = 'trigger' AND substr(name, 1, ?) = ?"
        + (table ? ' AND tbl_name = ? COLLATE NOCASE' : ''), table ? [prefix.length, prefix, table] : [prefix.length, prefix]) || [];
}

function dropFileStrictTriggers(b, table) {
    for (const t of fileStrictTriggers(b, table)) b.exec('DROP TRIGGER IF EXISTS main.' + quoteIdent(t.name));
}

// Boot, before the checkpoint connections open: one table's triggers per
// step, so those connections parse the schema without them.
async function dropFileStrictTriggersSliced(b, step) {
    let rows = [];
    try { rows = fileStrictTriggers(b, null); } catch (e) { return; }
    const tables = [...new Set(rows.map((r) => r.t))];
    for (const t of tables) {
        try { dropFileStrictTriggers(b, t); } catch (e) { log.debug('old strict-mode triggers not dropped for ' + t + ': ' + (e && e.message)); }
        await step();
    }
}

function dropStrictTriggers(table) {
    const prefix = dialect.STRICT_TRIGGER;
    const rows = backend.all("SELECT name FROM sqlite_temp_master WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE AND substr(name, 1, ?) = ?",
        [table, prefix.length, prefix]) || [];
    for (const t of rows) backend.exec('DROP TRIGGER IF EXISTS temp.' + quoteIdent(t.name));
    dropFileStrictTriggers(backend, table);
}

// Meta writes go through run() so the connection's insert rowid stays known
// to it (see bindNative), but they are not the caller's LAST_INSERT_ID().
// A failure leaves the column described from its SQLite type, never fails
// the statement that changed the table.
function metaRun(b, sql, params) {
    castMeta = null;
    const keep = lastInsertId;
    try { b.run(sql, params); } catch (e) { log.debug('column type not kept: ' + (e && e.message)); } finally { lastInsertId = keep; }
}

function setColumnMetaOn(b, table, row) {
    if (!row || row.column_name == null) return;
    metaRun(b, 'INSERT INTO "' + COLUMN_META + '" (table_name, column_name, ' + META_FIELDS.join(', ') + ') VALUES (?, ?'
        + ', ?'.repeat(META_FIELDS.length) + ') ON CONFLICT (table_name, column_name) DO UPDATE SET '
        + META_FIELDS.map((f) => f + ' = excluded.' + f).join(', '),
        [table, row.column_name].concat(META_FIELDS.map((f) => (row[f] == null ? null : row[f]))));
}

function setColumnMeta(table, row) { setColumnMetaOn(backend, table, row); }

function dropColumnMeta(table, col) {
    metaRun(backend, 'DELETE FROM "' + COLUMN_META + '" WHERE table_name = ? AND column_name = ?', [table, col]);
}

function renameColumnMeta(table, from, to) {
    if (String(from).toLowerCase() !== String(to).toLowerCase()) dropColumnMeta(table, to);
    metaRun(backend, 'UPDATE "' + COLUMN_META + '" SET column_name = ? WHERE table_name = ? AND column_name = ?', [to, table, from]);
}

function dropTableMeta(table) {
    if (table) metaRun(backend, 'DELETE FROM "' + COLUMN_META + '" WHERE table_name = ?', [table]);
}

function renameTableMeta(from, to) {
    if (String(from).toLowerCase() !== String(to).toLowerCase()) dropTableMeta(to);
    metaRun(backend, 'UPDATE "' + COLUMN_META + '" SET table_name = ? WHERE table_name = ?', [to, from]);
}

function setServerVersion(b, version) {
    dbVersion = version;
    metaRun(b, 'INSERT INTO "' + COLUMN_META + "\" (table_name, column_name, column_type) VALUES ('', 'version', ?)"
        + ' ON CONFLICT (table_name, column_name) DO UPDATE SET column_type = excluded.column_type', [version]);
}

function setDefaultCollation(b, collation) {
    dbCollation = collation;
    metaRun(b, 'INSERT INTO "' + COLUMN_META + "\" (table_name, column_name, collation) VALUES ('', '', ?)"
        + ' ON CONFLICT (table_name, column_name) DO UPDATE SET collation = excluded.collation', [collation]);
}

/**
 * MariaDB's information_schema.columns rows for the tables SQLite has. A
 * table with writes MariaDB has not applied yet keeps what its DDL stored:
 * MariaDB's answer for it is older.
 * @param {object} b backend
 * @param {Array<object>} cols
 */
// Written META_CHUNK rows to a transaction, with a step (bootStep) between
// transactions. Each row is an upsert of what MariaDB holds, so a chunk that
// fails leaves the rows before it right.
const META_CHUNK = 64;
async function hydrateColumnMeta(b, cols, tables, step) {
    const has = new Map();
    const num = (x) => (x == null || x === '' ? null : Number(x));
    const kept = (t) => {
        if (!t || isInternalTable(t) || pendingTables.has(String(t).toLowerCase())) return false;
        if (!has.has(t)) has.set(t, sqliteHasTable(b, t));
        return has.get(t);
    };
    const rows = [];
    for (const r of tables || []) {
        const v = (k) => (r[k.toUpperCase()] != null ? r[k.toUpperCase()] : r[k] != null ? r[k] : null);
        if (kept(v('table_name')) && v('table_collation')) rows.push([v('table_name'), { column_name: '', collation: v('table_collation') }]);
    }
    for (const c of cols || []) {
        const v = (k) => (c[k.toUpperCase()] != null ? c[k.toUpperCase()] : c[k] != null ? c[k] : null);
        const t = v('table_name');
        const name = v('column_name');
        if (!name || !kept(t)) continue;
        rows.push([t, {
            column_name: name, column_type: v('column_type'), data_type: v('data_type'),
            char_len: num(v('character_maximum_length')), num_prec: num(v('numeric_precision')), num_scale: num(v('numeric_scale')),
            dt_prec: num(v('datetime_precision')), collation: v('collation_name'), extra: v('extra'),
            column_default: v('column_default'), gen_expr: v('generation_expression'), nullable: v('is_nullable'),
        }]);
    }
    for (let i = 0; i < rows.length; i += META_CHUNK) {
        b.exec('BEGIN');
        try {
            for (let j = i; j < Math.min(i + META_CHUNK, rows.length); j++) setColumnMetaOn(b, rows[j][0], rows[j][1]);
            b.exec('COMMIT');
        } catch (e) {
            try { b.exec('ROLLBACK'); } catch (e2) { /* the transaction already ended */ }
            log.debug('column types from MariaDB not kept: ' + (e && e.message));
            return;
        }
        await step();
    }
}

/**
 * Create the outbox tables and load the epoch, the pending count and the
 * per-table counts. Runs once at boot, before the engine is ready.
 * @param {object} b backend
 */
function openOutbox(b) {
    b.exec('CREATE TABLE IF NOT EXISTS "' + OUTBOX + '" (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, tables TEXT NOT NULL DEFAULT \'\')');
    b.exec('CREATE TABLE IF NOT EXISTS "' + OUTBOX_META + '" (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    let row = b.get('SELECT v FROM "' + OUTBOX_META + '" WHERE k = ?', ['epoch']);
    if (!row) {
        const epoch = require('crypto').randomBytes(12).toString('hex');
        b.run('INSERT INTO "' + OUTBOX_META + '" (k, v) VALUES (?, ?)', ['epoch', epoch]);
        row = { v: epoch };
    }
    outboxEpoch = String(row.v);
    outboxAppliedId = 0;
    // What the file holds at open survived the last stop; startCheckpointWorker
    // syncs it once before the engine is ready.
    const top = b.get('SELECT MAX(id) AS id FROM "' + OUTBOX + '"', []);
    lastOutboxId = durableOutboxId = Number(top && top.id) || 0;
    // AUTOINCREMENT keeps the highest id it handed out in sqlite_sequence,
    // also once the outbox is empty. A boundary left by a boot that never
    // reached MariaDB stays: the writes after it were not checked either.
    let issued = lastOutboxId;
    try {
        const seq = b.get('SELECT seq FROM sqlite_sequence WHERE name = ?', [OUTBOX]);
        issued = Math.max(issued, Number(seq && seq.seq) || 0);
    } catch (e) { /* no sequence yet: nothing was handed out */ }
    const from = b.get('SELECT v FROM "' + OUTBOX_META + '" WHERE k = ?', ['unchecked_from']);
    if (from) {
        outboxCheckFrom = Number(from.v) || 0;
    } else {
        outboxCheckFrom = issued;
        b.run('INSERT INTO "' + OUTBOX_META + '" (k, v) VALUES (?, ?)', ['unchecked_from', String(issued)]);
    }
    outboxStale = !!b.get('SELECT 1 AS n FROM "' + OUTBOX_META + '" WHERE k = ?', ['stale']);
    countOutbox();
    obStmts = {
        insert: b.prepareRaw ? b.prepareRaw('INSERT INTO "' + OUTBOX + '" (body, tables) VALUES (?, ?)') : null,
        head: b.prepareRaw ? b.prepareRaw('SELECT id, body, tables FROM "' + OUTBOX + '" WHERE id > ? AND id <= ? ORDER BY id LIMIT ?') : null,
        drop: b.prepareRaw ? b.prepareRaw('DELETE FROM "' + OUTBOX + '" WHERE id <= ?') : null,
        ids: b.prepareRaw ? b.prepareRaw('SELECT id FROM "' + OUTBOX + '" WHERE id > ? AND id <= ? ORDER BY id LIMIT ?') : null,
        one: b.prepareRaw ? b.prepareRaw('SELECT id, body, tables FROM "' + OUTBOX + '" WHERE id = ?') : null,
    };
    obCacheClear();
    outboxOn = true;
    importLegacySpill(b);
}

// Decoded outbox rows by id, so the flush does not read back and parse what
// outboxAdd just wrote: for a 250-row INSERT that is about 400 KB of JSON
// read from overflow pages and parsed again, all of it on the server thread.
// An entry is always the last outboxAdd for its id. AUTOINCREMENT never
// hands out the id of a committed row again, so a row the flush finds in the
// table is the one its entry describes; a rolled-back row's id comes back
// with the next write, which replaces the entry, and until then the flush
// never asks for it. The flush reads only ids from the table (the rowid,
// no payload) and fetches the body of any row not held here: after a
// restart, past OB_CACHE_MAX, or a row whose params hold objects (JSON
// could turn those into something else).
const OB_CACHE_MAX = 32 * 1024 * 1024;
const obCache = new Map();
let obCacheBytes = 0;

function obCacheClear() {
    obCache.clear();
    obCacheBytes = 0;
}

function obCacheSet(id, entry, bytes) {
    const old = obCache.get(id);
    if (old) { obCache.delete(id); obCacheBytes -= old.b; }
    if (!entry || obCacheBytes + bytes > OB_CACHE_MAX) return;
    obCache.set(id, { e: entry, b: bytes });
    obCacheBytes += bytes;
}

// Ids only grow (a reused id keeps its place), so applied rows are at the front.
function obCachePrune() {
    for (const [id, c] of obCache) {
        if (id > outboxAppliedId) break;
        obCache.delete(id);
        obCacheBytes -= c.b;
    }
}

/** True when every value is one the outbox JSON round-trips exactly. */
function obPlainParams(list) {
    if (!list) return true;
    for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) return false;
    }
    return true;
}

/**
 * Write one outbox row for the replica entries in buf. Must run inside the
 * SQLite transaction or savepoint that made those writes.
 * @param {Array<{sql:string, params:Array, tables?:string[]}>} buf
 * @param {string} from calling resource
 */
function outboxAdd(buf, from) {
    const seen = new Set();
    const stmts = new Array(buf.length);
    let plain = true;
    for (let i = 0; i < buf.length; i++) {
        const x = buf[i];
        if (plain && !obPlainParams(x.params)) plain = false;
        stmts[i] = x.id ? { s: x.sql, p: obParams(x.params), i: x.id } : { s: x.sql, p: obParams(x.params) };
        const t = x.tables || tablesOfSql(x.sql);
        if (t) for (let k = 0; k < t.length; k++) seen.add(String(t[k]).toLowerCase());
    }
    let doc;
    if (stmts.length === 1) {
        doc = { s: stmts[0].s, p: stmts[0].p, f: from };
        if (stmts[0].i) doc.i = stmts[0].i;
    } else {
        doc = { tx: stmts, f: from };
    }
    // The commit time, so MariaDB's NOW() on replay is the game's (applyStmt).
    doc.t = Date.now();
    const body = JSON.stringify(doc);
    const csv = Array.from(seen).join(',');
    if (obStmts && obStmts.insert) {
        const info = obStmts.insert.run(body, csv);
        const id = Number(info && info.lastInsertRowid || 0);
        if (id > lastOutboxId) lastOutboxId = id;
        obCacheSet(id, plain ? decodeOutboxDoc(id, csv, doc) : null, body.length);
    } else {
        const keep = lastInsertId;
        backend.run('INSERT INTO "' + OUTBOX + '" (body, tables) VALUES (?, ?)', [body, csv]);
        lastInsertId = keep;
        const row = backend.get('SELECT MAX(id) AS id FROM "' + OUTBOX + '"', []);
        if (row && Number(row.id) > lastOutboxId) lastOutboxId = Number(row.id);
    }
    writeSeq++;
    outboxPending++;
    notePending(csv, 1);
    seen.forEach((t) => {
        if (!dialect.identOk(t)) return;
        dirtyTables.add(t);
        if (cdcHandle && cdcHandle.noteDirty) cdcHandle.noteDirty(t);
    });
    if (outboxPending >= REPLICA_BATCH && !activeFlushPromise) flushReplica();
}

/**
 * Run fn so the SQLite writes it makes and their outbox row commit together.
 * Inside a transaction (txBuf given) the caller writes the row before COMMIT.
 * @param {Array|undefined} txBuf
 * @param {(buf: Array|undefined) => any} fn
 */
function withOutbox(txBuf, fn) {
    if (txBuf || !outboxOn) return fn(txBuf);
    const buf = [];
    const b = backend;
    if (b.savepoint) b.savepoint(); else b.exec('SAVEPOINT cis_w');
    let out;
    try {
        out = fn(buf);
        if (buf.length) outboxAdd(buf, callerResource());
    } catch (e) {
        try { if (b.rollbackTo) b.rollbackTo(); else b.exec('ROLLBACK TO cis_w'); } catch (e2) { /* the savepoint is gone */ }
        try { if (b.release) b.release(); else b.exec('RELEASE cis_w'); } catch (e2) { /* the savepoint is gone */ }
        throw e;
    }
    if (b.release) b.release(); else b.exec('RELEASE cis_w');
    return out;
}

/**
 * Move spill files an older build left in cache/ into the outbox, in
 * sequence order, and delete them once that commit is done.
 */
function importLegacySpill(b) {
    const dir = path.join(resPath(), 'cache');
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    const files = [];
    for (let i = 0; i < names.length; i++) {
        const m = names[i].match(/^replica\.spill\.(-?\d+)\.jsonl$/);
        if (m) files.push({ seq: parseInt(m[1], 10), p: path.join(dir, names[i]) });
        else if (names[i] === 'replica.spill.jsonl') files.push({ seq: Number.MAX_SAFE_INTEGER, p: path.join(dir, names[i]) });
    }
    if (!files.length) return;
    files.sort((x, y) => x.seq - y.seq);
    let n = 0;
    b.exec('BEGIN IMMEDIATE');
    try {
        for (let i = 0; i < files.length; i++) {
            const lines = String(fs.readFileSync(files[i].p, 'utf8')).split('\n');
            for (let k = 0; k < lines.length; k++) {
                const line = lines[k].trim();
                if (!line) continue;
                let rec;
                try { rec = JSON.parse(line); } catch (e) { continue; }
                if (!spillRecordOk(rec)) continue;
                const list = Array.isArray(rec.tx) ? rec.tx : [rec];
                const buf = list.map((x) => ({ sql: x.sql, params: (x.params || []).map((v) => (v && v.type === 'Buffer' && Array.isArray(v.data) ? Buffer.from(v.data) : v)) }));
                outboxAdd(buf, rec.from || '');
                n++;
            }
        }
        b.exec('COMMIT');
    } catch (e) {
        try { b.exec('ROLLBACK'); } catch (e2) { /* nothing open */ }
        log.error('Could not move the old spill files into the outbox; they stay in cache/: ' + (e && e.message));
        return;
    }
    for (let i = 0; i < files.length; i++) {
        try { fs.unlinkSync(files[i].p); } catch (e) { /* already gone */ }
    }
    log.info('Moved ' + n + ' writes from ' + files.length + ' old spill files into the outbox.');
}

function spillRecordOk(rec) {
    if (!rec || typeof rec !== 'object') return false;
    if (Array.isArray(rec.tx)) {
        if (!rec.tx.length) return false;
        for (let i = 0; i < rec.tx.length; i++) {
            const stmt = rec.tx[i];
            if (!stmt || typeof stmt.sql !== 'string' || isDangerousSql(stmt.sql)) return false;
            if (stmt.params != null && !Array.isArray(stmt.params)) return false;
        }
        return true;
    }
    if (typeof rec.sql !== 'string' || isDangerousSql(rec.sql)) return false;
    if (rec.params != null && !Array.isArray(rec.params)) return false;
    return true;
}

let flushAgain = false;

function replicaLost(err) {
    const m = String(err && err.message || err);
    return /PROTOCOL_CONNECTION_LOST|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|Pool is closed|closed state/i.test(m);
}

// Errors that say nothing about the statement and pass once the server is
// writable again: a read-only server (1290 --read-only, 1792 read-only
// transaction, 1836 read-only mode), a full disk or table file (1021, 1114),
// a server shutting down (1053) or a killed connection (1927). Dropping the
// entry on one of these loses every write made while it lasts; the outbox
// keeps it and retries with backoff, and the warning says why it waits.
const REPLICA_TRANSIENT = new Set([1290, 1792, 1836, 1021, 1114, 1053, 1927]);

// Errors after which MariaDB has rolled back the whole transaction, or that
// will pass on a later try. The batch is sent again instead of dropping rows.
function replicaRetryable(err) {
    const code = err && (err.errno || err.code);
    return replicaLost(err) || code === 1213 || code === 1205 || code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT'
        || REPLICA_TRANSIENT.has(code);
}

function isDdlSql(sql) {
    const kw = dialect.firstKeyword(String(sql || ''));
    return kw === 'CREATE' || kw === 'ALTER' || kw === 'DROP' || kw === 'TRUNCATE' || kw === 'RENAME';
}

function decodeOutboxRow(row) {
    let doc = null;
    try { doc = JSON.parse(row.body); } catch (e) { doc = null; }
    return decodeOutboxDoc(row.id, row.tables, doc);
}

function decodeOutboxDoc(id, tables, doc) {
    if (!doc) return { id, tables, stmts: [], from: '', ddl: false };
    const list = Array.isArray(doc.tx) ? doc.tx : [doc];
    const stmts = [];
    let ddl = false;
    for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!s || typeof s.s !== 'string' || isDangerousSql(s.s)) continue;
        if (isDdlSql(s.s)) ddl = true;
        const st = { sql: s.s, params: obDecodeParams(s.p) };
        if (Number.isSafeInteger(s.i) && s.i > 0) st.insertId = s.i;
        if (Number.isSafeInteger(doc.t) && doc.t > 0) st.ts = doc.t;
        stmts.push(st);
    }
    return { id, tables, stmts, from: doc.f || '', tx: Array.isArray(doc.tx), ddl };
}

// One line per statement and reason every 10 s, with a count of the ones
// held back. A script whose writes MariaDB rejects (a missing column, a
// function it lacks) otherwise prints a line per write, and console output
// on a busy server is itself a hitch.
const REJECT_LOG_MS = 10000;
const rejectSeen = new Map();

function logRejected(entry, stmt, e) {
    replicaDropN++;
    const why = String(e && e.message || e);
    // SQLite kept a write MariaDB did not take, and MariaDB's checksum did not
    // move: the next boot must copy these tables, not keep them as unchanged.
    if (!/Duplicate key name|errno:\s*121|Duplicate column|already exists/i.test(why)) forgetSync(entry.tables);
    // A row SQLite took and MariaDB refuses as a duplicate means the two hold
    // different rows under one key (a row written in MariaDB that SQLite has
    // not seen). That is never "already applied": say so, and count it.
    if (/Duplicate entry/i.test(why) && !/^\s*(CREATE|ALTER|DROP|RENAME)\b/i.test(String(stmt.sql || ''))) {
        idClashN++;
        const now = Date.now();
        if (now - idClashLogAt >= REJECT_LOG_MS) {
            idClashLogAt = now;
            log.warn('MariaDB refused a write from ' + (entry.from || 'unknown') + ' as a duplicate (' + idClashN + ' so far): '
                + redactSqlError(why) + ' | ' + clipSql(stmt.sql)
                + '. A row was written straight into MariaDB under the same key; check that table in both places.');
        }
        return;
    }
    if (/Duplicate key name|errno:\s*121|Duplicate entry|Duplicate column|already exists/i.test(why)) {
        log.debug('MariaDB already has ' + clipSql(stmt.sql));
        return;
    }
    if (!LOG_SQL_ERRORS) return;
    const key = why + '|' + stmt.sql;
    const now = Date.now();
    const seen = rejectSeen.get(key);
    if (seen && now - seen.at < REJECT_LOG_MS) {
        seen.held++;
        return;
    }
    if (!seen && rejectSeen.size >= 256) rejectSeen.delete(rejectSeen.keys().next().value);
    rejectSeen.set(key, { at: now, held: 0 });
    const marks = (String(stmt.sql || '').match(/\?/g) || []).length;
    log.error('MariaDB rejected a write from ' + (entry.from || 'unknown') + ' (' + marks + ' placeholders, '
        + stmt.params.length + ' values): ' + redactSqlError(why) + ' | ' + clipSql(stmt.sql)
        + (seen && seen.held ? ' (and ' + seen.held + ' more like it in the last ' + Math.round((now - seen.at) / 1000) + ' s)' : ''));
}

/**
 * Load the counts of rows MariaDB has not applied (id above outboxAppliedId).
 */
function countOutbox() {
    const rows = backend.all('SELECT tables FROM "' + OUTBOX + '" WHERE id > ?', [outboxAppliedId]);
    outboxPending = rows.length;
    pendingTables.clear();
    for (let i = 0; i < rows.length; i++) notePending(rows[i].tables, 1);
}

async function ensureReplicaState(conn) {
    await conn.query('CREATE TABLE IF NOT EXISTS `' + REPLICA_STATE + '` (epoch VARCHAR(64) NOT NULL PRIMARY KEY, applied BIGINT NOT NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB');
    const [rows] = await conn.query('SELECT applied FROM `' + REPLICA_STATE + '` WHERE epoch = ?', [outboxEpoch]);
    const applied = rows && rows[0] ? Number(rows[0].applied || rows[0].APPLIED || 0) : 0;
    if (applied > outboxCheckFrom) {
        rewindOutbox(applied);
    } else if (applied > outboxAppliedId) {
        const before = outboxPending;
        outboxAppliedId = applied;
        countOutbox();
        dropAppliedOutbox();
        if (before > outboxPending) log.info('MariaDB already had ' + (before - outboxPending) + ' writes from before the last stop; cleared them from the outbox.');
    }
    backend.run('DELETE FROM "' + OUTBOX_META + '" WHERE k = ?', ['unchecked_from']);
    outboxStateReady = true;
}

/**
 * MariaDB's mark for this epoch is above every outbox id this file had
 * handed out when it was opened. A file only marks ids it wrote, so the file
 * is older than the one that set the mark: cache/ restored from a backup,
 * copied with the resource to another install on the same MariaDB, or the
 * last commits lost in a crash after MariaDB applied them. Its new ids start
 * below the mark, and comparing them with it counted every write as applied
 * and never sent it.
 *
 * The rows up to the boundary are the ones the newer file had too, and the
 * mark says MariaDB applied them; the rows after it were written here since
 * the file was opened and are not applied. They go on under a new epoch, so
 * the old mark no longer applies to them. MariaDB holds what the newer file
 * wrote and this one does not, so the tables are copied from it again
 * (outboxStale), except tables with writes still waiting here.
 * A boundary from a backup taken while MariaDB was down (unchecked_from
 * already set) is lower than the file's ids, so a few writes may be sent
 * twice; none is dropped.
 * @param {number} applied MariaDB's mark for the current epoch
 */
function rewindOutbox(applied) {
    const old = outboxEpoch;
    const epoch = require('crypto').randomBytes(12).toString('hex');
    outboxAppliedId = outboxCheckFrom;
    countOutbox();
    dropAppliedOutbox();
    backend.run('INSERT OR REPLACE INTO "' + OUTBOX_META + '" (k, v) VALUES (?, ?)', ['stale', '1']);
    backend.run('INSERT OR REPLACE INTO "' + OUTBOX_META + '" (k, v) VALUES (?, ?)', ['epoch', epoch]);
    outboxEpoch = epoch;
    outboxStale = true;
    log.warn('This SQLite file is older than MariaDB: MariaDB applied writes up to ' + applied + ' for outbox epoch ' + old
        + ', this file had handed out ' + outboxCheckFrom + ' (cache/ restored, copied from another install, or rewound by a crash). '
        + outboxPending + ' writes made since go to MariaDB under the new epoch ' + epoch + '; '
        + (engineReady ? 'tables are copied again from MariaDB at the next start.' : 'tables are copied again from MariaDB now.'));
}

function setAppliedSql() {
    return 'INSERT INTO `' + REPLICA_STATE + '` (epoch, applied) VALUES (?, ?) ON DUPLICATE KEY UPDATE applied = VALUES(applied)';
}

/** Record entries[from..to) as applied by MariaDB. */
function markApplied(entries, from, to) {
    enterBusy();
    if (TRACE) trIn(TR_REPLICA);
    try {
        for (let i = from; i < to; i++) {
            notePending(entries[i].tables, -1);
            if (entries[i].id > outboxAppliedId) outboxAppliedId = entries[i].id;
        }
        outboxPending = Math.max(0, outboxPending - (to - from));
        dropAppliedOutbox();
    } finally {
        if (TRACE) trOut();
        leaveBusy();
    }
}

/**
 * Delete applied rows. Rows are read with id > outboxAppliedId, so a delete
 * that is skipped here, or undone by a rollback around it, never sends a row
 * twice; the next call removes it.
 */
function dropAppliedOutbox() {
    obCachePrune();
    // A write while the WAL is quiesced for a restart would defeat it; the
    // next call removes the rows (they are read with id > outboxAppliedId).
    if (!backend || txDepth > 0 || walQuiesce || !outboxAppliedId) return;
    try {
        const info = obStmts && obStmts.drop
            ? obStmts.drop.run(outboxAppliedId)
            : backend.run('DELETE FROM "' + OUTBOX + '" WHERE id <= ?', [outboxAppliedId]);
        // Its frames need a checkpoint cycle too, or an idle server keeps
        // them in the WAL (restartIdleWal). It waits for no sync.
        walWrites += Number(info && info.changes) || 0;
    } catch (e) {
        log.debug('outbox delete deferred: ' + (e && e.message));
    }
}

// The next n rows for the flush, decoded: from obCache where it holds them.
// A batch stops at REPLICA_BATCH_BYTES of outbox JSON (one row at least):
// 64 rows of a bulk import formatted at once is about 25 MB of SQL built on
// the server thread in one go, and the garbage collection after it.
const REPLICA_BATCH_BYTES = 1024 * 1024;
function readOutboxEntries(n) {
    const out = [];
    let bytes = 0;
    if (!obCache.size || !obStmts || !obStmts.ids || !obStmts.one) {
        const rows = readOutboxHead(n);
        for (let i = 0; i < rows.length && (i === 0 || bytes < REPLICA_BATCH_BYTES); i++) {
            bytes += String(rows[i].body || '').length;
            out.push(decodeOutboxRow(rows[i]));
        }
        return out;
    }
    const ids = obStmts.ids.all(outboxAppliedId, durableOutboxId, n);
    for (let i = 0; i < ids.length && (i === 0 || bytes < REPLICA_BATCH_BYTES); i++) {
        const id = Number(ids[i].id);
        const c = obCache.get(id);
        if (c) { out.push(c.e); bytes += c.b; continue; }
        const row = obStmts.one.get(id);
        if (row) { out.push(decodeOutboxRow(row)); bytes += String(row.body || '').length; }
    }
    return out;
}

// Only rows a WAL sync has covered (see pumpWal).
function readOutboxHead(n) {
    if (obStmts && obStmts.head) return obStmts.head.all(outboxAppliedId, durableOutboxId, n);
    return backend.all('SELECT id, body, tables FROM "' + OUTBOX + '" WHERE id > ? AND id <= ? ORDER BY id LIMIT ?', [outboxAppliedId, durableOutboxId, n]);
}

/**
 * Apply entries[from..] up to the next DDL entry in one MariaDB transaction,
 * with the applied id stored in the same commit. A DDL entry (MariaDB commits
 * DDL on its own) goes alone, followed by its applied id.
 * @returns {Promise<number>} index of the first entry not applied
 */
// SQLite numbered the rows of an INSERT; MariaDB is told the same id first,
// as statement-based binlog replication does (see insertPinMode). MariaDB
// keeps a forced id until an INSERT numbers a row with it, and one that gives
// its own id or fails leaves it set, so it is cleared after every pinned
// statement.
const PIN_CLEAR = 'SET insert_id = 0';
// NOW(), CURRENT_TIMESTAMP and ON UPDATE columns read MariaDB's session
// clock. A write replayed late (MariaDB was away) is given the moment SQLite
// committed it, as statement-based binlog replication does, and the clock
// goes back to the real one after the entry.
const CLOCK_CLEAR = 'SET timestamp = DEFAULT';
const clockSql = (ms) => 'SET timestamp = ' + (ms / 1000).toFixed(3);

async function applyStmt(conn, st) {
    if (!st.insertId && !st.ts) return conn.query(replicaSqlText(st.sql), st.params);
    if (st.ts) await conn.query(clockSql(st.ts));
    try {
        if (!st.insertId) return await conn.query(replicaSqlText(st.sql), st.params);
        await conn.query('SET insert_id = ' + st.insertId);
        try { return await conn.query(replicaSqlText(st.sql), st.params); }
        finally { await conn.query(PIN_CLEAR); }
    } finally {
        if (st.ts) await conn.query(CLOCK_CLEAR);
    }
}

// Whether one of the entry's statements, as MariaDB will read it, may hold a
// statement boundary (see mayHoldBoundary). Kept on the entry, which the
// outbox cache reuses across flushes.
function entryLone(conn, entry) {
    if (entry.lone !== undefined) return entry.lone;
    const fmt = typeof conn.format === 'function';
    entry.lone = entry.stmts.some((st) => mayHoldBoundary(fmt ? conn.format(replicaSqlText(st.sql), st.params) : replicaSqlText(st.sql)));
    return entry.lone;
}

/**
 * One entry on its own connection from the replica pool, which has
 * multipleStatements off: MariaDB runs one statement per query there, so a
 * text that might hold a boundary cannot become two. Its applied id commits
 * with it, except for DDL, which MariaDB commits on its own.
 */
async function applyOutboxAlone(entry) {
    const conn = await replicaPool.getConnection();
    try {
        if (entry.ddl) {
            for (let k = 0; k < entry.stmts.length; k++) {
                try { await applyStmt(conn, entry.stmts[k]); }
                catch (e) {
                    if (replicaRetryable(e)) throw e;
                    logRejected(entry, entry.stmts[k], e);
                }
            }
            await conn.query(setAppliedSql(), [outboxEpoch, entry.id]);
            return;
        }
        await conn.beginTransaction();
        try {
            const many = entry.tx && entry.stmts.length > 1;
            if (many) await conn.query('SAVEPOINT cis_e');
            let k = 0;
            try {
                for (; k < entry.stmts.length; k++) await applyStmt(conn, entry.stmts[k]);
                if (many) await conn.query('RELEASE SAVEPOINT cis_e');
            } catch (e) {
                if (replicaRetryable(e)) throw e;
                if (many) await conn.query('ROLLBACK TO SAVEPOINT cis_e');
                logRejected(entry, entry.stmts[k] || entry.stmts[0], e);
            }
            await conn.query(setAppliedSql(), [outboxEpoch, entry.id]);
            await conn.commit();
        } catch (e) {
            try { await conn.rollback(); } catch (e2) { /* the connection is gone */ }
            throw e;
        }
    } finally {
        conn.release();
    }
}

async function applyOutboxRun(conn, entries, from) {
    const first = entries[from];
    // conn is the outbox's multi-statement connection when there is one.
    const alone = !!(outboxPool && replicaPool);
    if (alone && (first.ddl || first.lone === true)) {
        await applyOutboxAlone(first);
        markApplied(entries, from, from + 1);
        return from + 1;
    }
    if (first.ddl) {
        for (let k = 0; k < first.stmts.length; k++) {
            try { await applyStmt(conn, first.stmts[k]); }
            catch (e) {
                if (replicaRetryable(e)) throw e;
                logRejected(first, first.stmts[k], e);
            }
        }
        await conn.query(setAppliedSql(), [outboxEpoch, first.id]);
        markApplied(entries, from, from + 1);
        return from + 1;
    }
    if (typeof conn.format === 'function') {
        const done = await applyOutboxBatch(conn, entries, from);
        if (done > from) return done;
    }
    // The batch marks each entry it formats; without one, entryLone looks.
    if (alone && entryLone(conn, first)) {
        await applyOutboxAlone(first);
        markApplied(entries, from, from + 1);
        return from + 1;
    }
    let i = from;
    let last = 0;
    await conn.beginTransaction();
    try {
        for (; i < entries.length; i++) {
            const entry = entries[i];
            if (entry.ddl) break;
            if (alone && i > from && entryLone(conn, entry)) break;
            if (entry.tx && entry.stmts.length > 1) {
                await conn.query('SAVEPOINT cis_e');
                let k = 0;
                try {
                    for (; k < entry.stmts.length; k++) await applyStmt(conn, entry.stmts[k]);
                    await conn.query('RELEASE SAVEPOINT cis_e');
                } catch (e) {
                    if (replicaRetryable(e)) throw e;
                    await conn.query('ROLLBACK TO SAVEPOINT cis_e');
                    logRejected(entry, entry.stmts[k] || entry.stmts[0], e);
                }
            } else if (entry.stmts.length) {
                try { await applyStmt(conn, entry.stmts[0]); }
                catch (e) {
                    if (replicaRetryable(e)) throw e;
                    logRejected(entry, entry.stmts[0], e);
                }
            }
            last = entry.id;
        }
        if (last) await conn.query(setAppliedSql(), [outboxEpoch, last]);
        await conn.commit();
    } catch (e) {
        try { await conn.rollback(); } catch (e2) { /* the connection is gone */ }
        throw e;
    }
    markApplied(entries, from, i);
    return i;
}

/**
 * Fast path: entries[from..] up to the next DDL entry, formatted client side
 * the way mysql2 formats a query, sent as one multi-statement round trip in
 * one transaction with the applied id. Statements are separated by a newline,
 * a semicolon and a newline, so a trailing -- or # comment cannot swallow the
 * next one. If MariaDB rejects any statement the transaction is rolled back
 * and 0 is returned, and the caller sends the same entries one by one to
 * find and skip the bad statement.
 * @returns {Promise<number>} index of the first entry not applied, or 0
 */
async function applyOutboxBatch(conn, entries, from) {
    const parts = [];
    let i = from;
    let last = 0;
    let sql = '';
    let clock = 0;
    // Formatting is server-thread work like a query: it counts against the
    // slice and frame budgets.
    enterBusy();
    if (TRACE) trIn(TR_REPLICA);
    try {
        for (; i < entries.length; i++) {
            const entry = entries[i];
            if (entry.ddl || entry.lone) break;
            const mark = parts.length;
            let lone = false;
            for (let k = 0; k < entry.stmts.length && !lone; k++) {
                const st = entry.stmts[k];
                const text = conn.format(replicaSqlText(st.sql), st.params);
                if (entry.lone === undefined && mayHoldBoundary(text)) { lone = true; break; }
                if (st.ts && st.ts !== clock) { parts.push(clockSql(st.ts)); clock = st.ts; }
                if (st.insertId) parts.push('SET insert_id = ' + st.insertId);
                parts.push(text);
                if (st.insertId) parts.push(PIN_CLEAR);
            }
            entry.lone = lone;
            // A statement that may hold a boundary goes alone (applyOutboxRun).
            if (lone) { parts.length = mark; break; }
            last = entry.id;
        }
        if (last) {
            if (clock) parts.push(CLOCK_CLEAR);
            parts.push(conn.format(setAppliedSql(), [outboxEpoch, last]));
            sql = parts.join('\n;\n');
        }
    } finally {
        if (TRACE) trOut();
        leaveBusy();
    }
    if (!last) return 0;
    await conn.beginTransaction();
    try {
        await conn.query(sql);
        await conn.commit();
    } catch (e) {
        try { await conn.rollback(); } catch (e2) { /* the connection is gone */ }
        // The statement that failed may have been a pinned one.
        try { await conn.query(PIN_CLEAR); } catch (e2) { /* the connection is gone */ }
        if (clock) { try { await conn.query(CLOCK_CLEAR); } catch (e2) { /* the connection is gone */ } }
        if (replicaRetryable(e)) throw e;
        return 0;
    }
    markApplied(entries, from, i);
    return i;
}

/**
 * Send outbox rows to MariaDB until the outbox is empty or MariaDB stops
 * answering. Never called from inside a statement; the SQLite reads and
 * deletes here are small and indexed.
 * @returns {Promise<void>}
 */
function flushReplica() {
    if (!TRACE) return flushReplicaNow();
    trIn(TR_REPLICA);
    try { return flushReplicaNow(); } finally { trOut(); }
}

function flushReplicaNow() {
    if (!replicaPool || !outboxOn || walFilling) return Promise.resolve();
    if (activeFlushPromise) {
        flushAgain = true;
        return activeFlushPromise;
    }
    if (Date.now() < outboxRetryAt) return Promise.resolve();
    replicaFlushing = true;
    activeFlushPromise = (async () => {
        let conn;
        try {
            conn = await (outboxPool || replicaPool).getConnection();
        } catch (e) {
            lastFlushSuccess = false;
            backoffReplica(e);
            return;
        }
        try {
            if (!outboxStateReady) await ensureReplicaState(conn);
            while (backend && outboxPending > 0 && !shuttingDown) {
                // A batch starts only with room in this slice and frame.
                await budgetRoom();
                if (!backend || shuttingDown) break;
                // The SQLite side of a batch counts against the slice budget
                // and the trace like a call does.
                let entries;
                enterBusy();
                if (TRACE) trIn(TR_REPLICA);
                try { entries = readOutboxEntries(REPLICA_BATCH); }
                finally { if (TRACE) trOut(); leaveBusy(); }
                if (!entries.length) {
                    // Rows past durableOutboxId wait for the WAL sync, which
                    // starts the next flush.
                    if (durableOutboxId >= lastOutboxId) { outboxPending = 0; pendingTables.clear(); }
                    break;
                }
                let i = 0;
                while (i < entries.length) i = await applyOutboxRun(conn, entries, i);
                if (dashViewers.size) dashFlushN++;
                log.debug('Flushed ' + entries.length + ' outbox rows to MariaDB.');
            }
            lastFlushSuccess = true;
            outboxFailN = 0;
        } catch (e) {
            lastFlushSuccess = false;
            backoffReplica(e);
        } finally {
            if (conn) conn.release();
        }
    })().finally(() => {
        replicaFlushing = false;
        activeFlushPromise = null;
        if (flushAgain) {
            flushAgain = false;
            if (outboxPending > 0 && Date.now() >= outboxRetryAt) flushReplica();
        }
    });
    return activeFlushPromise;
}

function backoffReplica(e) {
    outboxFailN++;
    const wait = Math.min(5000, 250 * Math.pow(2, Math.min(outboxFailN, 5)));
    outboxRetryAt = Date.now() + wait;
    if (outboxFailN === 1 || outboxFailN % 20 === 0) {
        log.warn('MariaDB did not take the outbox (' + redactSqlError(e && e.message || e) + '). ' + outboxPending + ' writes wait in SQLite; next try in ' + wait + ' ms.');
    }
}

// mysql2 formats params client-side with backslash escapes, and MariaDB
// reads string literals by the session sql_mode. Under NO_BACKSLASH_ESCAPES
// a player string such as  x\'); DROP TABLE players; --  ends the literal
// early, and the outbox runs its batches with multipleStatements. ANSI_QUOTES, alone or through ANSI, reads "..." as an
// identifier where SQLite read a string. Every replica connection drops all
// three from its session before its first query: mysql2 runs a connection's
// commands in order, and the pool emits "connection" before it hands one out.
// A connection that cannot is destroyed, so nothing else is sent on it.
const REPLICA_SESSION_SQL = "SET SESSION sql_mode = TRIM(BOTH ',' FROM REPLACE(REPLACE(REPLACE("
    + "CONCAT(',', @@SESSION.sql_mode, ','), ',NO_BACKSLASH_ESCAPES,', ','), ',ANSI_QUOTES,', ','), ',ANSI,', ','))";

function guardReplicaSession(pool) {
    if (!pool || typeof pool.on !== 'function') return;
    pool.on('connection', (conn) => {
        // A MariaDB that stops answering must not hold the connection, and
        // every read queued behind it, forever.
        conn.query({ sql: REPLICA_SESSION_SQL, timeout: MARIA_READ_MS }, (err) => {
            if (!err) return;
            log.warn('MariaDB refused to set the session sql_mode (' + err.message + '); that connection is closed and not used.');
            try { conn.destroy(); } catch (e) { /* already closed */ }
        });
    });
}

function startReplica(dsn) {
    if (!mysql2mod) return;
    replicaPool = mysql2mod.createPool({
        ...mariaLink(dsn),
        waitForConnections: true,
        connectionLimit: POOL_CONNECTIONS,
        enableKeepAlive: true,
        charset: 'utf8mb4',
        supportBigNumbers: true,
        // oxmysql's own (src/config.ts): JSON comes back as its text.
        jsonStrings: true,
    });
    // The outbox flusher has its own connection with multipleStatements, so
    // one batch is one round trip. The pool above, which also answers the
    // read fallback with caller SQL, keeps multipleStatements off.
    outboxPool = mysql2mod.createPool({
        ...mariaLink(dsn),
        waitForConnections: true,
        connectionLimit: 1,
        enableKeepAlive: true,
        charset: 'utf8mb4',
        supportBigNumbers: true,
        multipleStatements: true,
    });
    guardReplicaSession(replicaPool);
    guardReplicaSession(outboxPool);
    replicaTimer = setInterval(() => {
        if (outboxPending > 0) flushReplica();
    }, REPLICA_FLUSH_MS);
    if (replicaTimer.unref) replicaTimer.unref();
    log.info('replica pool mysql://' + dsn.host + ':' + dsn.port + '/' + dsn.database);
}

// ---- AUTO_INCREMENT reserve -------------------------------------------------
// A row inserted straight into MariaDB (a panel, HeidiSQL) takes MariaDB's
// next AUTO_INCREMENT id. Until CDC copies it, SQLite does not know that id
// and hands it to the game's next insert, whose copy MariaDB then refuses as
// a duplicate: the game row is lost at the next boot copy. So MariaDB's
// counter is kept ID_RESERVE_GAP above the highest id SQLite has handed out.
// Rows written in MariaDB land in the high range, which SQLite only reaches
// after the game inserts gap/2 rows into that table between two scans.
// auto_increment_increment/offset would split ids too, but they are server or
// session variables: global affects every database on a shared server and
// needs SUPER, and a panel's session is not ours to set.
const ID_RESERVE = '__cis_id_reserve';
let idReserveOn = false;
let idReserveTimer = null;
let idReserveBusy = false;
let idReserveReady = false;
let idReserveDenied = false;
const idReserveBase = new Map();

function idTypeMax(columnType) {
    const t = String(columnType || '').toLowerCase();
    const un = t.indexOf('unsigned') >= 0;
    if (t.startsWith('tinyint')) return un ? 255 : 127;
    if (t.startsWith('smallint')) return un ? 65535 : 32767;
    if (t.startsWith('mediumint')) return un ? 16777215 : 8388607;
    if (t.startsWith('bigint')) return Number.MAX_SAFE_INTEGER;
    if (t.startsWith('int')) return un ? 4294967295 : 2147483647;
    return 0;
}

async function reserveIds() {
    if (!idReserveOn || idReserveBusy || !replicaPool || !backend || shuttingDown) return;
    idReserveBusy = true;
    let conn = null;
    try {
        conn = await replicaPool.getConnection();
        if (!idReserveReady) {
            await conn.query('CREATE TABLE IF NOT EXISTS `' + ID_RESERVE + '` (table_name VARCHAR(64) NOT NULL PRIMARY KEY,'
                + ' raised_to BIGINT NOT NULL, base BIGINT NOT NULL) ENGINE=InnoDB');
            idReserveReady = true;
        }
        const [rows] = await conn.query(
            'SELECT t.table_name AS tn, t.auto_increment AS ai, c.column_name AS cn, c.column_type AS ct'
            + ' FROM information_schema.tables t JOIN information_schema.columns c'
            + ' ON c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.extra LIKE \'%auto_increment%\''
            + ' WHERE t.table_schema = DATABASE() AND t.table_type = \'BASE TABLE\'');
        for (const r of rows || []) {
            if (shuttingDown) break;
            const name = String(r.tn || r.TN || '');
            const col = String(r.cn || r.CN || '');
            if (!name || !dialect.identOk(name) || !dialect.identOk(col) || isInternalTable(name)
                || !sqliteHasTable(backend, name)) continue;
            const typeMax = idTypeMax(r.ct || r.CT);
            if (!typeMax) continue;
            let top = 0;
            try {
                const s = backend.get('SELECT seq FROM sqlite_sequence WHERE name = ? COLLATE NOCASE', [name]);
                top = s ? Number(s.seq) || 0 : 0;
                const m = backend.get('SELECT max("' + col.replace(/"/g, '""') + '") AS m FROM "' + name.replace(/"/g, '""') + '"', []);
                top = Math.max(top, m ? Number(m.m) || 0 : 0);
            } catch (e) { continue; }
            const next = top + 1;
            const gap = Math.min(ID_RESERVE_GAP, Math.floor((typeMax - next) / 64));
            if (gap < 64) continue;
            const ai = Number(r.ai != null ? r.ai : r.AI) || 0;
            const lname = name.toLowerCase();
            if (ai >= next + gap / 2) {
                // The base only matters at the next boot (hydrate); write it
                // once a minute at most, not on every game insert.
                const had = idReserveBase.get(lname);
                if (had && had.base < next && Date.now() - had.at >= 60000) {
                    await conn.query('UPDATE `' + ID_RESERVE + '` SET base = ? WHERE table_name = ? AND raised_to = ?', [next, name, ai]);
                    idReserveBase.set(lname, { base: next, at: Date.now() });
                }
                continue;
            }
            const to = next + gap;
            await conn.query('SET SESSION lock_wait_timeout = 2');
            try {
                await conn.query('ALTER TABLE `' + name.replace(/`/g, '``') + '` AUTO_INCREMENT = ' + to);
            } finally {
                await conn.query('SET SESSION lock_wait_timeout = DEFAULT');
            }
            await conn.query('INSERT INTO `' + ID_RESERVE + '` (table_name, raised_to, base) VALUES (?, ?, ?)'
                + ' ON DUPLICATE KEY UPDATE raised_to = VALUES(raised_to), base = VALUES(base)', [name, to, next]);
            idReserveBase.set(lname, { base: next, at: Date.now() });
            log.debug('AUTO_INCREMENT of ' + name + ' in MariaDB set to ' + to + ' (SQLite is at ' + top + ')');
        }
    } catch (e) {
        const no = e && (e.errno || e.code);
        if (no === 1142 || no === 1044 || no === 'ER_TABLEACCESS_DENIED_ERROR' || no === 'ER_DBACCESS_DENIED_ERROR') {
            idReserveOn = false;
            idReserveDenied = true;
            log.warn('The MariaDB user cannot ALTER tables, so rows inserted straight into MariaDB can take an id the game'
                + ' uses next. Grant ALTER on this database, or insert those rows through the game. ' + (e && e.message));
        } else {
            log.debug('AUTO_INCREMENT reserve skipped: ' + (e && e.message));
        }
    } finally {
        if (conn) { try { conn.release(); } catch (e) { /* ignore */ } }
        idReserveBusy = false;
    }
}

/**
 * Raise MariaDB's AUTO_INCREMENT now (before CDC's first scan records the
 * fingerprints) and every ID_RESERVE_MS after.
 * @returns {Promise<void>} The first pass.
 */
function startIdReserve() {
    if (!replicaPool || ID_RESERVE_MS <= 0 || idReserveTimer) return Promise.resolve();
    idReserveOn = true;
    idReserveTimer = setInterval(() => { reserveIds(); }, ID_RESERVE_MS);
    if (idReserveTimer.unref) idReserveTimer.unref();
    return reserveIds();
}

// ---- DDL: ALTER TABLE and multi-statement helpers --------------------------------
/**
 * Walk SQL the way MariaDB's lexer finds statement boundaries, under the
 * session sql_mode every replica connection sets (no ANSI_QUOTES, no
 * NO_BACKSLASH_ESCAPES): '...' and "..." strings with backslash escapes and
 * doubled quotes, `names` with doubled backticks, # and "-- " comments to the
 * end of the line, and slash-star comments. visit(kind, i) is called with
 * 'semi' for each ; outside all of those, 'comment' where a comment starts,
 * and 'code' for any other non-space character outside a comment.
 * @returns {boolean} true when the text ends inside a string, name or comment
 */
function scanSql(s, visit) {
    const n = s.length;
    for (let i = 0; i < n; i++) {
        const c = s[i];
        if (c === "'" || c === '"' || c === '`') {
            visit('code', i);
            let j = i + 1;
            for (; j < n; j++) {
                const d = s[j];
                if (d === '\\' && c !== '`') { j++; continue; }
                if (d === c) {
                    if (s[j + 1] === c) { j++; continue; }
                    break;
                }
            }
            if (j >= n) return true;
            i = j;
            continue;
        }
        if (c === '#' || (c === '-' && s[i + 1] === '-' && (i + 2 >= n || /\s/.test(s[i + 2])))) {
            visit('comment', i);
            const e = s.indexOf('\n', i);
            if (e < 0) return false;
            i = e;
            continue;
        }
        if (c === '/' && s[i + 1] === '*') {
            visit('comment', i);
            const e = s.indexOf('*/', i + 2);
            if (e < 0) return true;
            i = e + 1;
            continue;
        }
        if (c === ';') { visit('semi', i); continue; }
        if (!/\s/.test(c)) visit('code', i);
    }
    return false;
}

// The statements of a text, split at each ; scanSql finds. A piece with only
// whitespace and comments (after a trailing ;) is not a statement.
function splitStatements(sql) {
    const s = String(sql || '');
    if (s.indexOf(';') < 0) return [s];
    const parts = [];
    let start = 0;
    let code = false;
    scanSql(s, (kind, i) => {
        if (kind === 'code') { code = true; return; }
        if (kind !== 'semi') return;
        if (code) parts.push(s.slice(start, i).trim());
        start = i + 1;
        code = false;
    });
    if (code) parts.push(s.slice(start).trim());
    return parts.length ? parts : [s];
}

// The outbox sends a batch as one multi-statement text, so MariaDB finds the
// statement boundaries again. A formatted statement with a ; or a
// comment outside its strings, or one that ends inside a string, could end
// early or swallow the next one there; it goes alone, on a connection that
// refuses a second statement, instead.
function mayHoldBoundary(text) {
    let found = false;
    const open = scanSql(String(text), (kind) => { if (kind !== 'code') found = true; });
    return found || open;
}

// MariaDB's answer to a second statement when multipleStatements is off.
function multiStatementError(sql, parts) {
    const at = sql.indexOf(parts[1]);
    const line = at > 0 ? sql.slice(0, at).split('\n').length : 1;
    return "ER_PARSE_ERROR: You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use near '"
        + parts[1].slice(0, 80) + "' at line " + line
        + ' (cis_database runs one statement per query, as oxmysql does; set cis_database_multi_statements true to allow more)';
}

/**
 * ALTER TABLE ... DROP COLUMN. SQLite refuses while an index names the
 * column; MariaDB takes the column out of those indexes and drops an index
 * left with no column. Same here, then the column goes.
 */
function dropColumn(table, col) {
    const lc = String(col).toLowerCase();
    const indexes = backend.all('SELECT name, "unique" AS u, origin FROM pragma_index_list(?)', [table]) || [];
    for (const ix of indexes) {
        if (ix.origin !== 'c') continue;
        const cols = (backend.all('SELECT name FROM pragma_index_info(?) ORDER BY seqno', [ix.name]) || []).map((r) => r.name);
        if (!cols.some((c) => String(c).toLowerCase() === lc)) continue;
        backend.exec('DROP INDEX ' + quoteIdent(ix.name));
        const rest = cols.filter((c) => c != null && String(c).toLowerCase() !== lc);
        if (rest.length) {
            backend.exec('CREATE ' + (Number(ix.u) ? 'UNIQUE ' : '') + 'INDEX ' + quoteIdent(ix.name) + ' ON ' + quoteIdent(table)
                + ' (' + rest.map(quoteIdent).join(', ') + ')');
        }
    }
    backend.exec('ALTER TABLE ' + quoteIdent(table) + ' DROP COLUMN ' + quoteIdent(col));
}

// The items of CREATE TABLE t (...) as SQLite stored it: the text before the
// list, each top-level item, and the text after. Quotes and parentheses are
// skipped over, so a comma in a default or a CHECK does not split.
function splitCreateTable(sql) {
    const s = String(sql);
    let depth = 0;
    let open = -1;
    let start = -1;
    const items = [];
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
            const close = ch === '[' ? ']' : ch;
            let j = i + 1;
            while (j < s.length) {
                if (s[j] === close) {
                    if (close !== ']' && s[j + 1] === close) { j += 2; continue; }
                    break;
                }
                j++;
            }
            i = j;
            continue;
        }
        if (ch === '(') {
            if (depth === 0 && open < 0) { open = i; start = i + 1; }
            depth++;
        } else if (ch === ')') {
            depth--;
            if (depth === 0 && open >= 0) {
                items.push(s.slice(start, i));
                return { head: s.slice(0, open + 1), items: items.map((x) => x.trim()), tail: s.slice(i) };
            }
        } else if (ch === ',' && depth === 1) {
            items.push(s.slice(start, i));
            start = i + 1;
        }
    }
    return null;
}

// The column an item of the list defines, or null for a table constraint.
function createItemColumn(item) {
    const m = /^(?:"((?:[^"]|"")*)"|`((?:[^`]|``)*)`|\[([^\]]*)\]|([A-Za-z_][\w$]*))/.exec(item);
    if (!m) return null;
    if (m[4] && /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)$/i.test(m[4])) return null;
    return m[1] != null ? m[1].replace(/""/g, '"') : m[2] != null ? m[2].replace(/``/g, '`') : m[3] != null ? m[3] : m[4];
}

/**
 * ALTER TABLE ... FIRST / AFTER x. SQLite appends every column it adds and
 * moves none, so the table is built again with its columns in MariaDB's
 * order: SELECT * and INSERT ... VALUES without a column list follow it.
 * The rows, the indexes, the triggers and the id sequence are kept. Keys in
 * other tables that point at it need foreign_keys off (runAlter turns it off
 * outside a transaction): SQLite rewrites their REFERENCES on a rename while
 * it is on, and dropping the old copy would run their ON DELETE. Inside a
 * transaction it cannot be turned off; a table other keys point at then
 * keeps SQLite's order rather than risk their rows.
 */
function keyedWhileForeignKeysOn(table) {
    const fk = backend.all('PRAGMA foreign_keys') || [];
    if (!(fk[0] && Number(fk[0].foreign_keys))) return false;
    const tables = backend.all("SELECT name FROM sqlite_master WHERE type = 'table'") || [];
    const lt = String(table).toLowerCase();
    for (const t of tables) {
        const refs = backend.all('SELECT "table" AS t FROM pragma_foreign_key_list(?)', [t.name]) || [];
        if (refs.some((x) => String(x.t).toLowerCase() === lt)) return true;
    }
    return false;
}

function placeColumn(table, col, after) {
    if (keyedWhileForeignKeysOn(table)) return;
    const master = backend.all("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE", [table]) || [];
    const parts = master[0] && splitCreateTable(master[0].sql);
    if (!parts) throw new Error("cis_database: cannot place column '" + col + "' of table '" + table + "'");
    const lc = String(col).toLowerCase();
    const cols = parts.items.map(createItemColumn);
    const from = cols.findIndex((c) => c != null && c.toLowerCase() === lc);
    const order = parts.items.map((_, i) => i).filter((i) => i !== from);
    let at = 0;
    if (after != null) {
        const la = String(after).toLowerCase();
        const k = order.findIndex((i) => cols[i] != null && cols[i].toLowerCase() === la);
        if (k < 0) throw new Error("Unknown column '" + after + "' in '" + table + "'");
        at = k + 1;
    }
    if (from < 0) throw new Error("Unknown column '" + col + "' in '" + table + "'");
    order.splice(at, 0, from);
    if (order.every((v, i) => v === i)) return;
    rebuildTable(table, parts.head + order.map((i) => parts.items[i]).join(', ') + parts.tail);
}

// Builds table again from createSql, with its rows, indexes, triggers and id
// sequence. The caller checked foreign keys (keyedWhileForeignKeysOn).
function rebuildTable(table, createSql) {
    const name = table;
    const live = (backend.all('SELECT name, hidden FROM pragma_table_xinfo(?)', [name]) || [])
        .filter((r) => Number(r.hidden) === 0).map((r) => quoteIdent(r.name)).join(', ');
    const kept = backend.all("SELECT sql FROM sqlite_master WHERE tbl_name = ? COLLATE NOCASE AND type IN ('index', 'trigger') AND sql IS NOT NULL", [name]) || [];
    const seq = backend.all("SELECT seq FROM sqlite_sequence WHERE name = ? COLLATE NOCASE", [name]) || [];
    const old = '__cis_place_' + name;
    const legacy = backend.all('PRAGMA legacy_alter_table') || [];
    backend.exec('PRAGMA legacy_alter_table = ON');
    try {
        backend.exec('ALTER TABLE ' + quoteIdent(name) + ' RENAME TO ' + quoteIdent(old));
    } finally {
        backend.exec('PRAGMA legacy_alter_table = ' + (legacy[0] && Number(legacy[0].legacy_alter_table) ? 'ON' : 'OFF'));
    }
    backend.exec(createSql);
    backend.exec('INSERT INTO ' + quoteIdent(name) + ' (' + live + ') SELECT ' + live + ' FROM ' + quoteIdent(old));
    backend.exec('DROP TABLE ' + quoteIdent(old));
    for (const k of kept) backend.exec(k.sql);
    if (seq.length) {
        backend.run('UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = ?', [seq[0].seq, name]);
        backend.run('INSERT INTO sqlite_sequence (name, seq) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ?)', [name, seq[0].seq, name]);
    }
    dialect.forgetColumns(name);
}

/**
 * MODIFY / ADD ... AUTO_INCREMENT on a column that is a key. SQLite numbers
 * only an INTEGER PRIMARY KEY, so the column becomes that, as CREATE TABLE
 * makes it: an INSERT that leaves it out gets the next id, and insertId is
 * that id. Rows with no value yet are numbered in order. A primary key on
 * other columns stays a unique index. Left as it is: a column that is no key
 * (MariaDB refuses it), a key of several columns, or one other keys point at
 * inside a transaction.
 */
function autoKeyColumn(table, col, keyed) {
    const master = backend.all("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE", [table]) || [];
    const parts = master[0] && splitCreateTable(master[0].sql);
    if (!parts) return;
    const lc = String(col).toLowerCase();
    const info = backend.all('SELECT name, type, pk FROM pragma_table_info(?)', [table]) || [];
    const me = info.find((r) => String(r.name).toLowerCase() === lc);
    if (!me || !/INT/i.test(String(me.type))) return;
    const pk = info.filter((r) => Number(r.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((r) => String(r.name));
    const isPk = pk.length === 1 && pk[0].toLowerCase() === lc;
    if (isPk && /\bAUTOINCREMENT\b/i.test(master[0].sql)) return;
    const uniqueOn = () => (backend.all("SELECT name FROM pragma_index_list(?) WHERE \"unique\" = 1", [table]) || []).some((ix) => {
        const c = backend.all('SELECT name FROM pragma_index_info(?)', [ix.name]) || [];
        return c.length === 1 && String(c[0].name).toLowerCase() === lc;
    });
    if (!keyed && !isPk && !uniqueOn()) return;
    if (pk.length > 1 && !uniqueOn()) return;
    if (keyedWhileForeignKeysOn(table)) return;
    const items = [];
    for (const item of parts.items) {
        const c = createItemColumn(item);
        if (c != null && c.toLowerCase() === lc) items.push(quoteIdent(me.name) + ' INTEGER PRIMARY KEY AUTOINCREMENT');
        else if (c == null && /^PRIMARY\s+KEY\b/i.test(item)) continue;
        else if (c != null) items.push(item.replace(/\s+PRIMARY\s+KEY(?:\s+(?:ASC|DESC))?(?:\s+AUTOINCREMENT)?/i, ' NOT NULL'));
        else items.push(item);
    }
    rebuildTable(table, parts.head + items.join(', ') + parts.tail);
    // The primary key it had, on other columns, stays unique.
    if (pk.length && !isPk) {
        backend.exec('CREATE UNIQUE INDEX IF NOT EXISTS ' + quoteIdent(table + '_PRIMARY') + ' ON ' + quoteIdent(table) + ' (' + pk.map(quoteIdent).join(', ') + ')');
    }
}

// Triggers dialect.js names for a table: the ON UPDATE CURRENT_TIMESTAMP
// columns, and the columns an ADD COLUMN gave a time or expression default.
function cisTriggers(table, prefix) {
    const rows = backend.all("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE AND substr(name, 1, ?) = ?",
        [table, prefix.length, prefix]) || [];
    return rows.map((r) => ({ name: r.name, sql: r.sql, col: String(r.name).slice(prefix.length).split(':')[1] }));
}

function tableColumnNames(table) {
    return (backend.all('SELECT name FROM pragma_table_info(?)', [table]) || []).map((r) => r.name);
}

function runAlter(tr, params, txBuf, originalSql) {
    // One ALTER TABLE can hold several clauses; SQLite takes one at a time.
    // They run in order inside one savepoint, so a clause that fails undoes
    // the ones before it, as MariaDB does.
    const steps = tr.steps && tr.steps.length ? tr.steps : [tr.sql];
    try {
        if (tr.table) dropAutoIndexes('ALTER TABLE ' + quoteIdent(tr.table));
        else dropAutoIndexes(tr.sql);
        const bound = sqliteBindList(params);
        // FIRST / AFTER x rebuilds the table (placeColumn), which needs
        // foreign_keys off; SQLite ignores the pragma inside a transaction.
        const placing = steps.some((s) => s && (s.place || s.autoKey));
        const fkWas = placing ? backend.all('PRAGMA foreign_keys') || [] : [];
        const fkOn = !!(fkWas[0] && Number(fkWas[0].foreign_keys));
        if (fkOn) backend.exec('PRAGMA foreign_keys = OFF');
        const run = () => withOutbox(txBuf, (buf) => {
            // ON UPDATE triggers list every column of the table, so they are
            // dropped first and built again for the columns as they end up.
            let stamped = [];
            // Strict-mode triggers name every checked column, and SQLite
            // will not drop a column a trigger names; they are built again
            // from the meta as it ends up.
            if (tr.table) dropStrictTriggers(tr.table);
            if (tr.table) {
                for (const t of cisTriggers(tr.table, dialect.ON_UPDATE_TRIGGER)) {
                    backend.exec('DROP TRIGGER IF EXISTS ' + quoteIdent(t.name));
                    if (t.col) stamped.push(t.col);
                }
            }
            for (const step of steps) {
                if (step && typeof step === 'object') {
                    if (step.dropColumn) {
                        const lc = String(step.dropColumn).toLowerCase();
                        for (const t of cisTriggers(tr.table, dialect.DEFAULT_TRIGGER)) {
                            if (String(t.col).toLowerCase() === lc) backend.exec('DROP TRIGGER IF EXISTS ' + quoteIdent(t.name));
                        }
                        dropColumn(tr.table, step.dropColumn);
                        dropColumnMeta(tr.table, step.dropColumn);
                        stamped = stamped.filter((c) => String(c).toLowerCase() !== lc);
                    } else if (step.place) {
                        placeColumn(tr.table, step.place, step.after);
                    } else if (step.autoKey) {
                        autoKeyColumn(tr.table, step.autoKey, step.keyed);
                    } else if (step.meta) {
                        setColumnMeta(tr.table, step.meta);
                    } else if (step.metaRename) {
                        renameColumnMeta(tr.table, step.metaRename[0], step.metaRename[1]);
                    } else if (step.onUpdate) {
                        stamped.push(step.onUpdate);
                    } else if (step.insertDefault) {
                        const trg = dialect.insertDefaultTriggerSql(tr.table, step.insertDefault, step.expr);
                        if (trg) backend.exec(trg);
                    }
                    continue;
                }
                storeDepth = 0;
                backend.run(step, steps.length === 1 ? bound : []);
            }
            if (tr.table && tr.renamed) renameTableMeta(tr.table, tr.renamed);
            if (tr.table) {
                for (const [from, to] of tr.renames || []) {
                    stamped = stamped.map((c) => (String(c).toLowerCase() === String(from).toLowerCase() ? to : c));
                }
                const table = tr.renamed || tr.table;
                const cols = tableColumnNames(table);
                for (const c of stamped) {
                    if (!cols.some((x) => String(x).toLowerCase() === String(c).toLowerCase())) continue;
                    const trg = dialect.onUpdateTriggerSql(table, c, cols, strictReady);
                    if (trg) backend.exec(trg);
                }
                refreshStrictTriggers(backend, table);
            }
            enqueueReplica(originalSql || tr.sql, bound, buf);
            // MariaDB reports no rows for an ALTER; SQLite's count is the previous statement's.
            return { kind: 'update', value: 0 };
        });
        try {
            return run();
        } finally {
            if (fkOn) backend.exec('PRAGMA foreign_keys = ON');
        }
    } catch (e) {
        if (tr.ifNotExists && tr.table && tr.col) {
            try {
                if (!dialect.identOk(tr.table)) return { kind: 'update', value: 0 };
                const info = backend.all('PRAGMA table_info("' + String(tr.table).replace(/"/g, '""') + '")', []);
                const has = (info || []).some((r) => String(r.name || r.Name || '') === tr.col);
                if (has) return { kind: 'update', value: 0 };
            } catch (e2) { /* ignore */ }
        }
        throw e;
    }
}

function sqlDefault(row) {
    if (!row) return null;
    if (Number(row.pk || row.PK || 0) > 0 && /int/i.test(String(row.type || row.Type || ''))) return null;
    const dflt = row.dflt_value != null ? row.dflt_value : row.dflt;
    if (dflt != null && dflt !== '') return String(dflt);
    if (Number(row.notnull || row.notNull || 0) === 0) return null;
    const type = String(row.type || row.Type || '').toUpperCase();
    if (type.indexOf('INT') >= 0 || type === 'REAL' || type === 'NUMERIC') return '0';
    if (type.indexOf('TEXT') >= 0 || type.indexOf('CHAR') >= 0 || type === 'JSON') return "''";
    return '0';
}

function parenEnd(sql, open) {
    let depth = 0;
    let q = null;
    for (let i = open; i < sql.length; i++) {
        const c = sql[i];
        if (q) {
            if (c === q) q = null;
            continue;
        }
        if (c === "'" || c === '"') { q = c; continue; }
        if (c === '(') depth++;
        else if (c === ')') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

// MariaDB fills a NOT NULL column with no default that an INSERT leaves out
// with '' or 0 only without strict mode, or under INSERT IGNORE. In strict
// mode it refuses the statement (1364), upserts and REPLACE included. The
// columns filled here go to plan.filled, and execKind refuses those writes
// the same way while the replica's sql_mode is strict.
function supplyOmittedNotNull(sql, plan) {
    if (!backend || !dialect.columnMeta) return sql;
    const into = sql.match(/^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/i);
    if (!into) return sql;
    const colOpen = into[0].length - 1;
    const colClose = parenEnd(sql, colOpen);
    if (colClose < 0) return sql;
    const valWord = sql.slice(colClose + 1).match(/^\s*VALUES\s*\(/i);
    if (!valWord) return sql;
    const table = into[1];
    const listed = sql.slice(colOpen + 1, colClose).split(',').map((s) => s.replace(/["`\s]/g, '').toLowerCase());
    const rows = dialect.columnMeta(table);
    const add = [];
    const vals = [];
    for (let i = 0; i < rows.length; i++) {
        const name = rows[i].name || rows[i].Name;
        if (!name || listed.indexOf(String(name).toLowerCase()) >= 0) continue;
        // SQLite applies a column's own DEFAULT. Only a NOT NULL column
        // without one needs a value here.
        const own = rows[i].dflt_value != null ? rows[i].dflt_value : rows[i].dflt;
        if (own != null && own !== '') continue;
        const value = sqlDefault(rows[i]);
        if (value == null) continue;
        add.push('"' + String(name).replace(/"/g, '""') + '"');
        vals.push(value);
    }
    if (!add.length) return sql;
    if (plan) plan.filled = add.map((q) => q.slice(1, -1).replace(/""/g, '"'));
    // Every row of a multi-row VALUES list gets the same extra values.
    const ends = [];
    let at = colClose + 1 + valWord[0].length - 1;
    for (;;) {
        const close = parenEnd(sql, at);
        if (close < 0) return sql;
        ends.push(close);
        const next = sql.slice(close + 1).match(/^\s*,\s*\(/);
        if (!next) break;
        at = close + next[0].length;
    }
    const extra = ', ' + vals.join(', ');
    let out = sql.slice(0, colClose) + ', ' + add.join(', ');
    let from = colClose;
    for (let i = 0; i < ends.length; i++) {
        out += sql.slice(from, ends[i]) + extra;
        from = ends[i];
    }
    return out + sql.slice(from);
}

// ---- Statement plans -----------------------------------------------------------------
// Per-SQL plan: everything execKind decides from the statement text alone
// (size and safety verdicts, keyword, statement split, translation, NOT NULL
// defaults, write flag), built once per distinct SQL string. The defaults
// read the schema, so plans built before a CREATE, ALTER or DROP are rebuilt.
const PLAN_MAX = 4096;
// The plan of the statement execKind ran last, for dispatch's timing.
let lastPlan = null;
const plans = new Map();
let schemaEpoch = 0;

function bumpSchema() {
    schemaEpoch++;
    castMeta = null;
    if (backend && backend.forgetStatements) backend.forgetStatements();
    dialect.forgetSchema();
}

function planFor(sql) {
    let plan = plans.get(sql);
    if (plan && plan.epoch === schemaEpoch) return plan;
    plan = buildPlan(sql);
    if (plans.size >= PLAN_MAX) plans.delete(plans.keys().next().value);
    plans.set(sql, plan);
    return plan;
}

function buildPlan(raw) {
    const plan = {
        epoch: schemaEpoch, error: null, kw: '', parts: null, tr: null, sqliteSql: '',
        ok: false, wcp: false, write: false, ddl: false, inScan: false, count: false,
        slowN: 0, autoDone: false, pin: '', firstOf: null, upsert: false, ignore: false, filled: null,
    };
    if (typeof raw === 'string' && raw.length > MAX_SQL_LEN) {
        plan.error = 'cis_database: SQL exceeds ' + MAX_SQL_LEN + ' bytes';
        return plan;
    }
    // MariaDB still gets the caller's text; whitespace there is harmless.
    const sql = /\s{32}/.test(raw) ? collapseSpace(raw) : raw;
    if (isDangerousSql(sql)) {
        plan.error = dialect.firstKeyword(sql) === 'PRAGMA'
            ? 'cis_database: unauthorized PRAGMA operation'
            : 'cis_database: blocked SQL (ATTACH/writable_schema/load_extension)';
        return plan;
    }
    plan.kw = dialect.firstKeyword(sql);
    if (sql.indexOf(';') >= 0) {
        const parts = splitStatements(sql);
        if (parts.length > 1 && !MULTI_STATEMENTS) {
            plan.error = multiStatementError(sql, parts);
            return plan;
        }
        if (parts.length > 1) {
            plan.parts = parts.map((part) => {
                let n = 0;
                dialect.mapCode(part, (chunk) => {
                    n += (chunk.match(/\?/g) || []).length;
                    return chunk;
                });
                return { sql: part, marks: n };
            });
        }
    }
    const tr = dialect.translate(sql);
    plan.tr = tr;
    let sqliteSql = tr.sql;
    if (/^\s*INSERT\b/i.test(sqliteSql)) sqliteSql = supplyOmittedNotNull(sqliteSql, plan);
    plan.sqliteSql = sqliteSql;
    plan.extra = (tr.extra || []).filter((x) => !isDangerousSql(x));
    plan.ok = plan.kw === 'SET' || plan.kw === 'USE' || plan.kw === 'LOCK' || plan.kw === 'UNLOCK'
        || plan.kw === 'START' || plan.kw === 'BEGIN' || plan.kw === 'COMMIT' || plan.kw === 'ROLLBACK';
    plan.wcp = plan.kw === 'PRAGMA' && /wal_checkpoint/i.test(sql);
    plan.write = dialect.isWriteStatement(sql);
    // MariaDB cuts a value to fit, with a warning, for INSERT IGNORE and
    // UPDATE IGNORE even in strict mode; cis_strict() is off for them.
    plan.ignore = plan.write && /^\s*(?:INSERT|UPDATE)\s+(?:(?:LOW_PRIORITY|HIGH_PRIORITY|DELAYED)\s+)?IGNORE\b/i.test(sql);
    plan.ddl =plan.kw === 'CREATE' || plan.kw === 'ALTER' || plan.kw === 'DROP' || plan.kw === 'RENAME';
    // expandInPlaceholders only rewrites a ? that follows IN ( or json_each(
    // in code. Most statements have neither, and scanning one costs a pass
    // over the text plus a JSON.parse of every param that starts with [ (a
    // bulk INSERT of inventories spent 5 ms per call there).
    let inScan = false;
    dialect.mapCode(sqliteSql, (chunk) => {
        if (!inScan && /\b(?:IN|json_each)\s*\(\s*\?/i.test(chunk)) inScan = true;
        return chunk;
    }, true);
    // Numbered ?N (dialect.joinUpdateKeepingParams) bind by number; the
    // expansion counts plain ? and would move them.
    plan.inScan = inScan && !/\?\d/.test(sqliteSql);
    plan.count = /COUNT\s*\(/i.test(sql);
    if (plan.write && insertsRow(sqliteSql)) {
        plan.pin = insertPinMode(sqliteSql);
        plan.upsert = /\bON\s+CONFLICT\b[\s\S]*\bDO\s+UPDATE\b/i.test(sqliteSql) && singleRowValues(sqliteSql);
        if (plan.upsert && plan.pin) {
            const marked = markUpsertRow(sqliteSql);
            if (marked) plan.sqliteSql = sqliteSql = marked;
            plan.marked = !!marked;
        }
        if (plan.pin === 'one' && /^\s*INSERT\s+OR\s+IGNORE\b/i.test(sqliteSql) && !singleRowValues(sqliteSql)) plan.firstOf = generatedKey(sqliteSql);
    }
    return plan;
}

// Indexes SQLite adds by itself. A SELECT that reads a whole table runs on
// the server thread for as long as the scan takes: a leaderboard (ORDER BY
// bank DESC LIMIT 10) over 20000 players took 13 ms a call on our test box, and a
// lookup on a column a script never indexed grows with the table. MariaDB is
// as slow but runs elsewhere, so oxmysql never holds the thread for it.
//
// When the same single-table SELECT has taken AUTO_INDEX_MS or more three
// times and SQLite's plan scans the table, an index on its equality columns
// (then its ORDER BY column, when there is a LIMIT) is created in SQLite only.
// It is never sent to MariaDB and never shown to callers (SHOW INDEX and
// information_schema leave out __cis_ names). An index cannot change what a
// query returns, only how fast; rows that tie on ORDER BY may come back in
// another order, which MariaDB does not fix either. Each index costs a little
// on every write to its table, so there are at most 4 per table and 32 in
// all, none on tables over AUTO_INDEX_MAX_ROWS rows (building one would hold
// the thread too long; the log names the index to add instead), and ALTER
// TABLE drops a table's own before it runs, so a dropped or renamed column
// is never blocked by one. cis_database_auto_index 0 turns this off.
const AUTO_PREFIX = '__cis_auto_';
const AUTO_PER_TABLE = 4;
const AUTO_TOTAL = 32;
// Building an index holds the thread: 32 ms for 60000 rows on a desktop.
const AUTO_INDEX_MAX_ROWS = 100000;
let AUTO_INDEX = true;
// Reads SQLite could answer differently go to MariaDB (cis_database_maria_reads).
let MARIA_READS = true;
// A read MariaDB has not answered in this long fails with the reason; a
// write is never given up on, since MariaDB may still commit it.
let MARIA_READ_MS = 30000;
let AUTO_INDEX_MS = 3;
const autoTried = new Set();
let autoQueue = [];
let autoScheduled = false;

/** Called after a read that took ms; cheap unless it was slow. */
function noteSlowRead(plan, ms) {
    if (!AUTO_INDEX || ms < AUTO_INDEX_MS || !plan || plan.kw !== 'SELECT' || plan.autoDone) return;
    if (++plan.slowN < 3) return;
    plan.autoDone = true;
    if (autoTried.has(plan.sqliteSql) || autoTried.size >= 1024) return;
    autoTried.add(plan.sqliteSql);
    autoQueue.push({ sql: plan.sqliteSql, ms });
    if (!autoScheduled) {
        autoScheduled = true;
        // Off the call path; inside FXServer this runs on the next frame.
        setTimeout(runAutoIndex, 0);
    }
}

function runAutoIndex() {
    autoScheduled = false;
    if (shuttingDown || !backend) return;
    if (txDepth > 0 || walQuiesce) {
        autoScheduled = true;
        setTimeout(runAutoIndex, 50);
        return;
    }
    const list = autoQueue;
    autoQueue = [];
    for (const item of list) {
        try { adviseIndex(item.sql, item.ms); } catch (e) { log.debug('auto index skipped: ' + (e && e.message)); }
    }
}

function quoteIdent(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
}

/**
 * The table and index columns for one slow SELECT, or null. Only plain
 * single-table SELECTs are handled: one SELECT, one table after FROM, no
 * JOIN, comma join, UNION or subquery.
 */
function autoIndexPlan(sql) {
    // Translated SQLite text: '...' is a string, "..." an identifier.
    const code = String(sql).replace(/'(?:[^']|'')*'/g, "''").replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
    if ((code.match(/\bSELECT\b/gi) || []).length !== 1) return null;
    if (/\b(?:JOIN|UNION|INTERSECT|EXCEPT)\b/i.test(code)) return null;
    const from = code.match(/\bFROM\s+(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))\s*(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*)?\s*(,)?/i);
    if (!from || from[5]) return null;
    const table = from[1] || from[2] || from[3];
    let alias = from[4] && !/^(?:WHERE|ORDER|GROUP|LIMIT|HAVING)$/i.test(from[4]) ? from[4] : null;
    const cols = backend.all('PRAGMA table_info(' + quoteIdent(table) + ')', []).map((c) => String(c.name));
    if (!cols.length) return null;
    const byLower = new Map(cols.map((c) => [c.toLowerCase(), c]));
    const colRef = '(?:(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\\s*\\.\\s*)?(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))';
    const whereM = code.match(/\bWHERE\b([\s\S]*?)(?:\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|\bHAVING\b|$)/i);
    const eq = [];
    if (whereM) {
        // An OR can be served by one index only when every branch uses it.
        if (/\bOR\b/i.test(whereM[1])) return null;
        const re = new RegExp(colRef + '\\s*(?:=|\\bIN\\s*\\()', 'gi');
        let m;
        while ((m = re.exec(whereM[1])) !== null) {
            const c = byLower.get(String(m[1] || m[2] || m[3]).toLowerCase());
            if (c && eq.indexOf(c) < 0) eq.push(c);
        }
    }
    let order = null;
    const orderM = code.match(new RegExp('\\bORDER\\s+BY\\s+' + colRef + '\\s*(ASC|DESC)?\\s*(,)?', 'i'));
    if (orderM && !orderM[5]) order = byLower.get(String(orderM[1] || orderM[2] || orderM[3]).toLowerCase()) || null;
    const limited = /\bLIMIT\b/i.test(code);
    const use = eq.slice(0, 3);
    if (order && limited && use.indexOf(order) < 0) use.push(order);
    if (!use.length || (!eq.length && !limited)) return null;
    return { table, alias, cols: use };
}

function adviseIndex(sql, ms) {
    const plan = autoIndexPlan(sql);
    if (!plan) return;
    // Only when SQLite's own plan reads the whole table.
    const eqp = backend.all('EXPLAIN QUERY PLAN ' + sql, []);
    const names = [plan.table.toLowerCase()].concat(plan.alias ? [plan.alias.toLowerCase()] : []);
    const scans = eqp.some((r) => {
        const m = String(r.detail || '').match(/^SCAN (\S+)$/);
        return m && names.indexOf(m[1].toLowerCase()) >= 0;
    });
    if (!scans) return;
    const name = (AUTO_PREFIX + plan.table + '_' + plan.cols.join('_')).slice(0, 120);
    const mine = backend.all("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND substr(name, 1, 11) = ?", [AUTO_PREFIX]);
    if (mine.some((r) => r.name === name)) return;
    if (mine.length >= AUTO_TOTAL || mine.filter((r) => String(r.tbl_name).toLowerCase() === plan.table.toLowerCase()).length >= AUTO_PER_TABLE) return;
    const ddl = 'CREATE INDEX IF NOT EXISTS ' + quoteIdent(name) + ' ON ' + quoteIdent(plan.table) + ' (' + plan.cols.map(quoteIdent).join(', ') + ')';
    let rows = 0;
    try { rows = Number((backend.get('SELECT MAX(rowid) AS n FROM ' + quoteIdent(plan.table), []) || {}).n) || 0; } catch (e) { return; }
    if (rows > AUTO_INDEX_MAX_ROWS) {
        log.info('A query on ' + plan.table + ' (' + rows + ' rows) reads the whole table, ' + ms.toFixed(1) + ' ms a call. An index would help: CREATE INDEX ... ON ' + plan.table + ' (' + plan.cols.join(', ') + ') | ' + clipSql(sql));
        return;
    }
    const t0 = performance.now();
    enterBusy();
    try { backend.exec(ddl); } finally { leaveBusy(); }
    log.info('Added SQLite index ' + name + ' on ' + plan.table + ' (' + plan.cols.join(', ') + ') in ' + (performance.now() - t0).toFixed(1)
        + ' ms, for a query that read the whole table (' + ms.toFixed(1) + ' ms a call). It is not copied to MariaDB. | ' + clipSql(sql));
}

/** Before ALTER TABLE: drop the table's own indexes (they come back if needed). */
function dropAutoIndexes(alterSql) {
    const m = String(alterSql || '').match(/^\s*ALTER\s+TABLE\s+(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))/i);
    if (!m || !backend) return;
    const table = m[1] || m[2] || m[3];
    const mine = backend.all("SELECT name FROM sqlite_master WHERE type = 'index' AND substr(name, 1, 11) = ? AND tbl_name = ? COLLATE NOCASE", [AUTO_PREFIX, table]);
    for (const r of mine) {
        try { backend.exec('DROP INDEX IF EXISTS ' + quoteIdent(r.name)); } catch (e) { /* ignore */ }
    }
    // The ALTER rebuilds every plan; a query that is still slow afterwards
    // may get its index again.
    if (mine.length) autoTried.clear();
}

/** The mysql2 ResultSetHeader a write returns through oxmysql's query. */
// An UPDATE's header carries MariaDB's info line and changedRows. SQLite
// counts every row the WHERE matched, so changed is the matched count; a row
// set to the value it had counts as changed here (docs/KNOWN-GAPS.md).
function okHeader(affectedRows, insertId, kw) {
    if (kw === 'UPDATE') {
        return { fieldCount: 0, affectedRows, insertId, info: 'Rows matched: ' + affectedRows + '  Changed: ' + affectedRows + '  Warnings: 0', serverStatus: 2, warningStatus: 0, changedRows: affectedRows };
    }
    return { fieldCount: 0, affectedRows, insertId, info: '', serverStatus: 2, warningStatus: 0, changedRows: 0 };
}

/**
 * Column sets of the table's PRIMARY KEY and UNIQUE indexes, or null when
 * SQLite has no such table. dialect.js keeps a foreign key only when its
 * parent columns are one of these, as SQLite requires.
 */
function uniqueKeys(table) {
    try {
        if (!dialect.identOk(table)) return null;
        const info = backend.all('SELECT name, pk FROM pragma_table_info(?)', [table]) || [];
        if (!info.length) return null;
        const out = [];
        const pk = info.filter((r) => Number(r.pk) > 0).sort((a, b) => a.pk - b.pk).map((r) => r.name);
        if (pk.length) out.push(pk);
        for (const ix of backend.all('SELECT name FROM pragma_index_list(?) WHERE "unique" = 1', [table]) || []) {
            const cols = (backend.all('SELECT name FROM pragma_index_info(?) ORDER BY seqno', [ix.name]) || []).map((r) => r.name);
            if (cols.length && cols.every((c) => c != null)) out.push(cols);
        }
        return out;
    } catch (e) { return null; }
}

// How the replica learns the ids SQLite gave an INSERT. MariaDB numbers
// AUTO_INCREMENT rows itself and uses up ids SQLite does not (an upsert that
// updated, a duplicate under INSERT IGNORE, a rejected or rolled-back
// insert), so a replayed INSERT got a later id than SQLite's and a later
// UPDATE ... WHERE id = ? changed another row there. '' when the table has no
// numbered key. 'one' when only a single numbered row is provably SQLite's
// id: upserts and IGNORE may skip rows, and a statement that names the key
// may give some rows their own id. 'many' when every row took the next id,
// so the first is the last minus the count plus one.
function insertPinMode(sql) {
    const m = /^\s*(?:INSERT|REPLACE)(?:\s+OR\s+\w+)?\s+INTO\s+("(?:[^"]|"")+"|\x60[^\x60]+\x60|[\w$]+)\s*(\()?/i.exec(sql);
    if (!m) return '';
    const table = m[1].replace(/^["\x60]|["\x60]$/g, '').replace(/""/g, '"');
    let key = '';
    try {
        const pk = backend.all('SELECT name, type FROM pragma_table_info(?) WHERE pk > 0', [table]) || [];
        if (pk.length === 1 && String(pk[0].type).toUpperCase() === 'INTEGER') key = String(pk[0].name).toLowerCase();
        // An INT PRIMARY KEY with no AUTO_INCREMENT (cdn-fuel's location) is
        // numbered by the caller: MariaDB reports insert id 0 for it. Known
        // from the column as declared; a table with no such record (a cache
        // from before it was kept) is taken as numbered, as it was.
        if (key && !backend.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE AND sql LIKE '%AUTOINCREMENT%'", [table])
            && backend.get('SELECT 1 AS x FROM "' + COLUMN_META + "\" WHERE table_name = ? AND column_name = ? AND column_type IS NOT NULL AND lower(coalesce(extra, '')) NOT LIKE '%auto_increment%'", [table, key])) key = '';
    } catch (e) { return ''; }
    if (!key) return '';
    if (!m[2] || /^\s*(?:REPLACE\b|INSERT\s+OR\b)|\bON\s+CONFLICT\b/i.test(sql)) return 'one';
    const start = m.index + m[0].length;
    const cols = sql.slice(start, sql.indexOf(')', start)).split(',')
        .map((c) => c.trim().replace(/^["\x60]|["\x60]$/g, '').toLowerCase());
    return cols.indexOf(key) >= 0 ? 'one' : 'many';
}

// A single-row upsert into a table numbered by AUTO_INCREMENT: the same SQL
// with cis_upserted(<key>) in its DO UPDATE WHERE, so the id of the row it
// found is noted, else ''. The WHERE reads the stored row; the mark is true
// and goes first, so the change guard after it decides as before.
function markUpsertRow(sql) {
    if (!upsertMarkReady) return '';
    const m = /^\s*INSERT(?:\s+OR\s+\w+)?\s+INTO\s+("(?:[^"]|"")+"|[\w$]+)/i.exec(sql);
    if (!m) return '';
    const table = m[1].replace(/^"|"$/g, '').replace(/""/g, '"');
    let key;
    try {
        const pk = backend.all('SELECT name FROM pragma_table_info(?) WHERE pk > 0', [table]) || [];
        if (pk.length !== 1) return '';
        key = '"' + String(pk[0].name).replace(/"/g, '""') + '"';
    } catch (e) { return ''; }
    const body = sql.replace(/\s*;\s*$/, '');
    const set = body.search(/\bON\s+CONFLICT\b[\s\S]*?\bDO\s+UPDATE\s+SET\b/i);
    if (set < 0) return '';
    const at = dialect.topKeyword(body, 'WHERE');
    if (at < 0) return body + ' WHERE cis_upserted(' + key + ')';
    if (at < set) return '';
    return body.slice(0, at) + 'WHERE cis_upserted(' + key + ') AND (' + body.slice(at + 5) + ')';
}

// INSERT IGNORE of several rows into an AUTOINCREMENT table whose key the
// statement leaves out: { table, key }, else null. A skipped row still spends
// an id (in SQLite as in MariaDB), so the rows it wrote are not consecutive
// and the first is found from the sequence as it stood before.
function generatedKey(sql) {
    const m = /^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+("(?:[^"]|"")+"|[\w$]+)\s*\(([^)]*)\)/i.exec(sql);
    if (!m) return null;
    const table = m[1].replace(/^"|"$/g, '').replace(/""/g, '"');
    try {
        const pk = backend.all('SELECT name FROM pragma_table_info(?) WHERE pk > 0', [table]) || [];
        if (pk.length !== 1) return null;
        const key = String(pk[0].name);
        const cols = m[2].split(',').map((c) => c.trim().replace(/^"|"$/g, '').toLowerCase());
        if (cols.indexOf(key.toLowerCase()) >= 0) return null;
        if (!backend.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ? AND instr(upper(sql), 'AUTOINCREMENT')", [table])) return null;
        return { table, key };
    } catch (e) { return null; }
}

// A foreign-key trigger (dialect.foreignKeyTriggersSql) sits on one table and
// names the other in its body; SQLite drops it with its own table only, and
// one left naming a dropped table fails every write to the table it is on.
function dropForeignKeyTriggers(tables) {
    const rows = backend.all("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND substr(name, 1, ?) = ?",
        [dialect.FK_TRIGGER.length, dialect.FK_TRIGGER]) || [];
    for (const t of tables) {
        if (!dialect.identOk(t)) continue;
        const named = new RegExp('\\b(?:FROM|UPDATE|ON)\\s+"' + t + '"', 'i');
        for (const r of rows) {
            if (named.test(String(r.sql || ''))) backend.exec('DROP TRIGGER IF EXISTS "' + String(r.name).replace(/"/g, '""') + '"');
        }
    }
}

/** True when an INSERT has a VALUES list of exactly one row. */
function singleRowValues(sql) {
    let code = '';
    dialect.mapCode(sql, (chunk) => { code += chunk + ' '; return chunk; }, true);
    const m = /\bVALUES\s*\(/i.exec(code);
    if (!m) return false;
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < code.length; i++) {
        const c = code[i];
        if (c === '(') depth++;
        else if (c === ')' && --depth === 0) return !/^\s*,/.test(code.slice(i + 1));
    }
    return false;
}

/** The id to send as SET insert_id before this write, or 0. */
function replicaInsertId(plan, info) {
    const last = Number(info && info.lastInsertRowid || 0);
    const n = Number(info && info.changes || 0);
    if (!plan.pin || last <= 0 || n <= 0) return 0;
    if (n === 1) return last;
    return plan.pin === 'many' ? last - n + 1 : 0;
}

function runExtras(plan) {
    for (let i = 0; i < plan.extra.length; i++) {
        try { backend.exec(plan.extra[i]); } catch (e) { log.debug('extra DDL skipped: ' + (e && e.message) + ' | ' + clipSql(plan.extra[i])); }
    }
}

// ---- Execution -------------------------------------------------------------------------
// oxmysql's prepare and rawExecute take a list of parameter lists and run the
// statement once per list (src/utils/parseExecute.ts, v2.14.3): es_extended
// adds its items so, ox_inventory saves its stashes so. Every item a list, or
// a Lua table with numbered keys, makes such a list; anything else is one
// flat list of values, and this returns null.
function executeSets(params) {
    const list = Array.isArray(params) ? params : (plainObject(params) ? luaValues(params) : null);
    if (!list || !list.length) return null;
    const sets = [];
    for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (Array.isArray(item)) {
            sets.push(item);
            continue;
        }
        if (!plainObject(item)) return null;
        // An empty Lua table is a list of no values: every mark binds NULL.
        const values = Object.keys(item).length ? luaValues(item) : [];
        if (!values) return null;
        sets.push(values);
    }
    return sets;
}

// True for a prepare or rawExecute given several parameter lists, and for one
// whose lists cannot be read: execKind then throws the reason.
function isBatch(kind, params) {
    if (kind !== 'prepare' && kind !== 'rawExecute') return false;
    try {
        const sets = executeSets(params);
        return !!sets && sets.length > 1;
    } catch (e) {
        return true;
    }
}

// oxmysql types a prepare by its first word, case and all (executeType):
// INSERT answers the insert id, UPDATE and DELETE the rows changed, any other
// statement what MariaDB gave (parseResponse).
function executeType(sql) {
    switch (sql.substring(0, sql.indexOf(' '))) {
        case 'INSERT': return 'insert';
        case 'UPDATE':
        case 'DELETE': return 'update';
        default: return null;
    }
}

function executeResult(type, r) {
    if (type === 'insert') return r && r.insertId != null ? r.insertId : null;
    if (type === 'update') return r && r.affectedRows != null ? r.affectedRows : null;
    return r == null ? null : r;
}

// A batch runs list by list, in order and with no transaction around it, as
// in oxmysql (src/database/rawExecute.ts): a list that fails stops the batch,
// and the lists before it stay written. Each list runs as a rawExecute, so a
// write gives its header and a read its rows; prepare keeps the insert id or
// the rows changed of each. A read of several rows adds each row on its own,
// as oxmysql does.
function execSets(kind, sql, sets, txBuf) {
    const type = kind === 'prepare' ? executeType(sql) : null;
    const out = [];
    for (let i = 0; i < sets.length; i++) {
        const r = execKind('rawExecute', sql, sets[i], txBuf, true).value;
        if (Array.isArray(r) && r.length > 1) {
            for (const row of r) out.push(kind === 'prepare' ? executeResult(type, row) : row);
        } else {
            out.push(kind === 'prepare' ? executeResult(type, r) : r);
        }
    }
    return { kind: 'rows', value: out };
}

// execKind runs one statement on SQLite, queues it for the replica, and shapes
// the result like oxmysql would (insert id, affected rows, row objects).
// oneSet: params is one list of values, never a batch (execSets).
function execKind(kind, sql, params, txBuf, oneSet) {
    if (!oneSet && (kind === 'prepare' || kind === 'rawExecute')) {
        const sets = executeSets(params);
        if (sets && sets.length > 1) return execSets(kind, sql, sets, txBuf);
        if (sets) params = sets[0];
    }
    lastQueryTime = Date.now();
    const np = normalizeParams(sql, params);
    const plan = planFor(np.sql);
    lastPlan = plan;
    if (plan.error) throw new Error(plan.error);
    const kw = plan.kw;
    if (plan.parts && kind !== 'transaction') {
        let last = { kind: 'update', value: 0 };
        const rest = Array.isArray(np.params) ? np.params.slice() : [];
        for (let i = 0; i < plan.parts.length; i++) {
            last = execKind('query', plan.parts[i].sql, rest.splice(0, plan.parts[i].marks), txBuf);
        }
        return last;
    }
    const replicaSql = np.sql;
    const tr = plan.tr;
    let sqliteSql = plan.sqliteSql;
    // Extra DDL runs on every call; it is idempotent. The indexes of a
    // CREATE TABLE need the table, and RENAME TABLE a TO b, b TO c goes in
    // order, so those run after it (runExtras below); run first, the indexes
    // would fail silently and leave the table with no UNIQUE or KEY index. ALTER VIEW
    // drops the view, then creates it again from its extra.
    const extrasAfter = kw === 'CREATE' || kw === 'RENAME' || !!(tr && tr.extrasAfter);
    if (!extrasAfter) runExtras(plan);
    if (plan.ok) {
        return { kind: 'ok', value: true };
    }
    let p = Array.isArray(np.params) ? np.params : [];
    if (p.length && plan.inScan) {
        const expanded = expandInPlaceholders(sqliteSql, p);
        if (expanded) {
            sqliteSql = expanded.sql;
            p = expanded.params;
        }
    }
    if (plan.wcp) {
        schedulePassiveCheckpoint();
        return { kind: 'ok', value: true };
    }
    // ALTER VIEW is a DROP VIEW plus its extra, so it runs as a plain write.
    if (kw === 'ALTER' && !extrasAfter) {
        bumpSchema();
        const altered = runAlter(tr, p, txBuf, replicaSql);
        if (kind === 'query' || kind === 'rawExecute') return { kind: 'header', value: okHeader(Number(altered.value || 0), 0) };
        return altered;
    }
    const write = plan.write;
    if (write) {
        if (plan.filled && strictMode && !plan.ignore) {
            throw new Error("Field '" + plan.filled[0] + "' doesn't have a default value");
        }
        if (plan.ddl) bumpSchema();
        try {
            const bound = sqliteBindList(p);
            return withOutbox(txBuf, (buf) => {
                const lastBefore = lastInsertId;
                let seqBefore = null;
                if (plan.firstOf) {
                    try { const s = backend.get('SELECT seq FROM sqlite_sequence WHERE name = ?', [plan.firstOf.table]); seqBefore = s ? Number(s.seq) : 0; } catch (e) { seqBefore = null; }
                }
                let info;
                strictOff = plan.ignore;
                storeDepth = 0;
                upsertedId = 0;
                setInsertId = null;
                try { info = backend.run(sqliteSql, bound); } finally { strictOff = false; }
                // A table with no numbered key (ox_inventory, esx items: keyed
                // by name) has no AUTO_INCREMENT in MariaDB, which reports
                // insert id 0 and leaves LAST_INSERT_ID() as it was. SQLite's
                // hidden rowid is not an id the caller can use.
                let insertId = insertsRow(sqliteSql) && !plan.pin ? 0 : Number(info.lastInsertRowid || 0);
                if (insertsRow(sqliteSql) && !plan.pin) lastInsertId = lastBefore;
                // An upsert that changed the row it found reports that row's
                // id, as MariaDB does; LAST_INSERT_ID() stays as it was.
                if (plan.marked && !info.lastInsertRowid && Number(info.changes || 0) === 1 && upsertedId > 0) insertId = upsertedId;
                // A statement of several rows whose ids are all generated
                // reports the first of them, in its result and in
                // LAST_INSERT_ID(), as MariaDB does; SQLite gives the last.
                // Those ids are consecutive (replicaInsertId pins the same one).
                if (plan.pin === 'many' && insertId > 0 && Number(info.changes || 0) > 1) {
                    insertId = replicaInsertId(plan, info);
                    lastInsertId = insertId;
                } else if (seqBefore !== null && insertId > 0 && Number(info.changes || 0) > 1) {
                    const q = '"' + plan.firstOf.key.replace(/"/g, '""') + '"';
                    try {
                        const f = backend.get('SELECT min(' + q + ') AS f FROM "' + plan.firstOf.table.replace(/"/g, '""') + '" WHERE ' + q + ' > ?', [seqBefore]);
                        if (f && Number(f.f) > 0) { insertId = Number(f.f); lastInsertId = insertId; }
                    } catch (e) { /* keeps the last id */ }
                }
                // LAST_INSERT_ID(expr) in the statement sets both, as MariaDB does.
                if (setInsertId !== null) { insertId = Number(setInsertId) || 0; lastInsertId = insertId; }
                if (extrasAfter) runExtras(plan);
                if (tr.dropped) {
                    dropForeignKeyTriggers(tr.dropped);
                    for (const t of tr.dropped) dropTableMeta(t);
                }
                if (tr.meta && tr.table) for (const row of tr.meta) setColumnMeta(tr.table, row);
                if (tr.tableCollation && tr.table) setColumnMeta(tr.table, { column_name: '', collation: tr.tableCollation });
                if (tr.renamedTables) for (const [from, to] of tr.renamedTables) renameTableMeta(from, to);
                if (tr.meta && tr.table) refreshStrictTriggers(backend, tr.table);
                if (tr.renamedTables) for (const [, to] of tr.renamedTables) refreshStrictTriggers(backend, to);
                lastWriteTime = Date.now();
                enqueueReplica(replicaSql, bound, buf, null, replicaInsertId(plan, info));
                if (kind === 'insert') return { kind: 'insert', value: insertId };
                // A prepare typed INSERT answers the insert id (executeType).
                if (kind === 'prepare' && executeType(sql) === 'insert') return { kind: 'insert', value: insertId };
                // SQLite's change count after DDL is the previous statement's.
                let changes = plan.ddl ? 0 : Number(info.changes || 0);
                // MariaDB counts a row ON DUPLICATE KEY UPDATE changed as 2 (an
                // inserted row is 1). The backend reports no insert id when the
                // upsert updated. A row set to the values it had is 1 on MariaDB
                // and 0 here: dialect.upsertChangeGuard skipped the update. An
                // upsert it could not guard still counts 2 for an unchanged row.
                if (plan.upsert && changes === 1 && !info.lastInsertRowid) changes = 2;
                else if (plan.upsert && changes === 0) changes = 1;
                if (kind === 'query' || kind === 'rawExecute') {
                    // oxmysql hands query/rawExecute the mysql2 result as is,
                    // which for a write is this header, not a number.
                    return { kind: 'header', value: okHeader(changes, insertId, kw) };
                }
                return { kind: 'update', value: changes };
            });
        } catch (e) {
            const msg = String(e && e.message || e);
            // MariaDB's INSERT IGNORE skips a row whose parent key is missing
            // with a warning; SQLite's OR IGNORE does not cover foreign keys
            // and fails the statement. For one row that is the same as
            // skipping it. A statement of several rows still fails, since
            // MariaDB would have written the others.
            const ignoredFk = /FOREIGN KEY constraint failed/i.test(msg) && /^\s*INSERT\s+OR\s+IGNORE\b/i.test(sqliteSql) && singleRowValues(sqliteSql);
            if (ignoredFk) {
                if (kind === 'query' || kind === 'rawExecute') return { kind: 'header', value: okHeader(0, 0) };
                if (kind === 'insert') return { kind: 'insert', value: 0 };
                return { kind: 'update', value: 0 };
            }
            throw e;
        }
    }
    if (tr.jsonBool) return jsonBooleanResult(kind, execRead(kind, kw, plan, sqliteSql, p));
    return execRead(kind, kw, plan, sqliteSql, p);
}

// A JSON true or false in a SELECT item comes back from SQLite as a marker
// (dialect.js, markJsonBooleans); the caller gets the boolean, as from MySQL.
function jsonBooleanValue(v) {
    if (v === dialect.JSON_TRUE) return true;
    if (v === dialect.JSON_FALSE) return false;
    return v;
}

function jsonBooleanRow(row) {
    if (row && typeof row === 'object') for (const k in row) row[k] = jsonBooleanValue(row[k]);
    return row;
}

function jsonBooleanResult(kind, out) {
    if (out.kind === 'scalar') out.value = jsonBooleanValue(out.value);
    else if (out.kind === 'single') jsonBooleanRow(out.value);
    else if (out.kind === 'rows' && Array.isArray(out.value)) out.value.forEach(jsonBooleanRow);
    return out;
}

// oxmysql returns each result value cast by its column's MariaDB type
// (observed: tests/repro/type_casts.js checks it against a real MariaDB):
// DATETIME and TIMESTAMP come back as epoch ms, DATE as ms at local
// midnight, TINYINT(1) as a boolean. prepare and rawExecute go through
// mysql2's execute(), where only the dates are turned. A value's type is the declared
// type of the column it is read from: __cis_columns, which hydrate fills from
// MariaDB and CREATE / ALTER TABLE from the statement. An expression has no
// column and comes back as SQLite gives it. sql.js cannot say where a result
// column comes from, so it casts nothing.
let castMeta = null;
let castMetaOf = null;
const castPlans = new Map();

function castTypes() {
    if (castMeta && castMetaOf === backend) return castMeta;
    castMeta = new Map();
    castMetaOf = backend;
    castPlans.clear();
    let rows = [];
    try {
        rows = backend.all('SELECT table_name AS t, column_name AS c, data_type AS d, column_type AS ct FROM "' + COLUMN_META
            + "\" WHERE table_name <> '' AND column_name <> '' AND lower(data_type) IN ('datetime', 'timestamp', 'date', 'tinyint', 'decimal', 'numeric',"
            + " 'smallint', 'mediumint', 'int', 'integer', 'bigint')", []) || [];
    } catch (e) { /* no column types kept: nothing is cast */ }
    for (const r of rows) {
        const d = String(r.d).toLowerCase();
        // oxmysql sets no decimalNumbers: mysql2 gives DECIMAL as a string
        // with the column's scale (DECIMAL alone is DECIMAL(10,0)).
        const scale = () => { const m = /\(\s*\d+\s*,\s*(\d+)\s*\)/.exec(String(r.ct || '')); return m ? Number(m[1]) : 0; };
        // 'int' is never cast itself; castPlanFor reads it for SUM and AVG.
        const code = d === 'date' ? 'date' : d === 'tinyint' ? (/^tinyint\(1\)/i.test(String(r.ct || '')) ? 'bool' : 'int')
            : d === 'decimal' || d === 'numeric' ? 'dec' + scale()
                : d === 'datetime' || d === 'timestamp' ? 'time' : 'int';
        if (code) castMeta.set(String(r.t).toLowerCase() + '\0' + String(r.c).toLowerCase(), code);
    }
    return castMeta;
}

// The columns() answer for a backend that cannot name a result column's
// source (sql.js): worked out from the text for a column read as it is
// (name, table.name, *, table.*, with or without an alias); anything else is
// an expression, as node:sqlite reports it. SUM, AVG, MIN or MAX of one
// column also names that column in `agg`, for castPlanFor.
function lexicalColumns(sql) {
    const raw = dialect.lexSql(sql);
    const t = [];
    const pos = [];
    raw.forEach((x, i) => { if (x.k !== 'ws' && x.k !== 'comment') { t.push(x); pos.push(i); } });
    if (!t.length || !t[0] || t[0].k !== 'word' || t[0].v.toUpperCase() !== 'SELECT') return null;
    const up = (x) => (x && x.k === 'word' ? x.v.toUpperCase() : '');
    const isName = (x) => x && (x.k === 'word' || (x.k === 'id' && (x.v[0] === '`' || x.v[0] === '"')));
    const nameOf = (x) => (x.k === 'id' ? x.v.slice(1, -1).split(x.v[0] + x.v[0]).join(x.v[0]) : x.v);
    const tables = tablesOfSql(sql).filter((n) => !isInternalTable(n));
    const colsOf = new Map();
    for (const n of tables) {
        try { colsOf.set(n, (backend.all('SELECT name FROM pragma_table_info(?)', [n]) || []).map((r) => String(r.name))); } catch (e) { colsOf.set(n, []); }
    }
    // Alias or name of each table in the text.
    const alias = new Map();
    for (const n of tables) alias.set(n.toLowerCase(), n);
    for (let i = 0; i < t.length - 1; i++) {
        if (!isName(t[i]) || !colsOf.has(nameOf(t[i]))) continue;
        let j = i + 1;
        if (up(t[j]) === 'AS') j++;
        if (isName(t[j]) && !TRUST_KEYWORDS.has(up(t[j]))) alias.set(nameOf(t[j]).toLowerCase(), nameOf(t[i]));
    }
    let i0 = 1;
    while (i0 < t.length && SELECT_MODIFIERS.has(up(t[i0]))) i0++;
    const items = [];
    const starts = [];
    for (let i = i0, d = 0, s = i0; i <= t.length; i++) {
        const x = t[i];
        if (i === t.length || (d === 0 && (x.k === 'comma' || /^(?:FROM|UNION|INTO|LIMIT|FOR|LOCK|WHERE)$/.test(up(x))))) {
            items.push(t.slice(s, i));
            starts.push(s);
            s = i + 1;
            if (i === t.length || x.k !== 'comma') break;
            continue;
        }
        if (x.k === 'lp') d++;
        else if (x.k === 'rp') d--;
    }
    const out = [];
    const find = (col) => {
        let hit = null;
        for (const n of tables) {
            const c = colsOf.get(n).find((v) => v.toLowerCase() === col.toLowerCase());
            if (c) { if (hit) return null; hit = [n, c]; }
        }
        return hit;
    };
    // [table, column] that a name or table.name in a resolves to, or null.
    const ref = (a) => {
        if (a.length === 1 && isName(a[0]) && !TRUST_KEYWORDS.has(up(a[0]))) return find(nameOf(a[0]));
        if (a.length === 3 && isName(a[0]) && a[1].v === '.' && isName(a[2])) {
            const tn = alias.get(nameOf(a[0]).toLowerCase());
            const c = tn && colsOf.get(tn).find((v) => v.toLowerCase() === nameOf(a[2]).toLowerCase());
            if (c) return [tn, c];
        }
        return null;
    };
    for (let idx = 0; idx < items.length; idx++) {
        let it = items[idx];
        let as = null;
        const n = it.length;
        if (n >= 3 && up(it[n - 2]) === 'AS' && (isName(it[n - 1]) || it[n - 1].k === 'str')) { as = it[n - 1].k === 'str' ? it[n - 1].v.slice(1, -1) : nameOf(it[n - 1]); it = it.slice(0, n - 2); }
        else if (n === 2 && isName(it[0]) && isName(it[1])) { as = nameOf(it[1]); it = it.slice(0, 1); }
        else if (n === 4 && isName(it[3]) && it[1].v === '.') { as = nameOf(it[3]); it = it.slice(0, 3); }
        else if (n >= 4 && it[n - 2].k === 'rp' && isName(it[n - 1]) && !TRUST_KEYWORDS.has(up(it[n - 1]))) { as = nameOf(it[n - 1]); it = it.slice(0, n - 1); }
        const k = it.length;
        if (k === 1 && it[0].k === 'op' && it[0].v === '*') {
            for (const tn of tables) for (const c of colsOf.get(tn)) out.push({ name: c, table: tn, column: c });
            continue;
        }
        if (k === 3 && isName(it[0]) && it[1].v === '.' && it[2].v === '*') {
            const tn = alias.get(nameOf(it[0]).toLowerCase());
            for (const c of tn ? colsOf.get(tn) : []) out.push({ name: c, table: tn, column: c });
            continue;
        }
        const hit = ref(it);
        const fn = up(it[0]);
        if (!hit && k >= 4 && (fn === 'SUM' || fn === 'AVG' || fn === 'MIN' || fn === 'MAX') && it[1].k === 'lp' && it[k - 1].k === 'rp') {
            const arg = ref(it.slice(up(it[2]) === 'DISTINCT' ? 3 : 2, k - 1));
            // SQLite names an expression column by its text as written.
            const text = raw.slice(pos[starts[idx]], pos[starts[idx] + k - 1] + 1).map((x) => x.v).join('');
            out.push({ name: as != null ? as : text, table: null, column: null, agg: arg ? { fn, table: arg[0], column: arg[1] } : null });
            continue;
        }
        const name = as != null ? as : hit && k === 1 ? nameOf(it[0]) : hit ? nameOf(it[2]) : '';
        out.push({ name, table: hit ? hit[0] : null, column: hit ? hit[1] : null });
    }
    return out;
}

// [[result name, cast], ...] for the columns of sql that need one, or null.
// A name read twice keeps the last column's cast, as the row object keeps
// its value.
function castPlanFor(sql) {
    const meta = castTypes();
    if (!meta.size || !backend.columns) return null;
    let plan = castPlans.get(sql);
    if (plan !== undefined) return plan;
    let cols = null;
    try { cols = backend.columns(sql); } catch (e) { cols = null; }
    const key = (tn, cn) => String(tn).toLowerCase() + '\0' + String(cn).toLowerCase();
    // SUM, MIN and MAX of a DECIMAL column keep its scale and AVG adds 4
    // (div_precision_increment), as MariaDB gives them; SQLite answers a REAL.
    let lex = null;
    if (cols && /\b(?:SUM|AVG|MIN|MAX)\s*\(/i.test(sql)) {
        try { lex = lexicalColumns(sql); } catch (e) { lex = null; }
        if (lex && lex.length !== cols.length) lex = null;
    }
    const byName = new Map();
    (cols || []).forEach((c, i) => {
        let code = (c.table && c.column && meta.get(key(c.table, c.column))) || null;
        if (code === 'int') code = null;
        const agg = !code && lex && lex[i].agg;
        if (agg) {
            const dec = meta.get(key(agg.table, agg.column));
            if (dec && dec.startsWith('dec')) code = agg.fn === 'AVG' ? 'dec' + Math.min(Number(dec.slice(3)) + 4, 38) : dec;
            // SUM of an integer column is DECIMAL(n,0) on MariaDB and AVG is
            // DECIMAL(n,4); MIN and MAX keep the integer type.
            else if (dec === 'int' && (agg.fn === 'SUM' || agg.fn === 'AVG')) code = agg.fn === 'AVG' ? 'dec4' : 'dec0';
        }
        byName.set(c.name, code);
    });
    const list = [...byName].filter((e) => e[1]);
    plan = list.length ? list : null;
    if (castPlans.size >= PLAN_MAX) castPlans.clear();
    castPlans.set(sql, plan);
    return plan;
}

function castValue(code, v) {
    if (v == null) return v;
    if (code === 'bool') return String(v) === '1';
    if (code.startsWith('dec')) return decimalText(v, Number(code.slice(3)));
    if (typeof v !== 'string') return v;
    if (!v) return null;
    if (code === 'date') return new Date((v.length > 10 ? v.slice(0, 10) : v) + ' 00:00:00').getTime();
    return new Date(v).getTime();
}

// A DECIMAL value as mysql2 gives it: the digits with exactly `scale` places.
function decimalText(v, scale) {
    if (typeof v === 'bigint') return scale ? v.toString() + '.' + '0'.repeat(scale) : v.toString();
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return String(v);
    const s = n.toFixed(scale);
    return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}

// A function that casts a row in place for this call, or null.
function rowCaster(kind, sql) {
    const plan = castPlanFor(sql);
    if (!plan) return null;
    const list = kind === 'prepare' || kind === 'rawExecute' ? plan.filter((e) => e[1] !== 'bool') : plan;
    if (!list.length) return null;
    return (row) => {
        if (row) for (let i = 0; i < list.length; i++) { const k = list[i][0]; if (k in row) row[k] = castValue(list[i][1], row[k]); }
        return row;
    };
}

function execRead(kind, kw, plan, sqliteSql, p) {
    const cast = rowCaster(kind, sqliteSql);
    if (cast) {
        const out = execReadRaw(kind, kw, plan, sqliteSql, p, cast);
        if (out.kind === 'rows' && Array.isArray(out.value)) out.value.forEach(cast);
        return out;
    }
    return execReadRaw(kind, kw, plan, sqliteSql, p, null);
}

function execReadRaw(kind, kw, plan, sqliteSql, p, cast) {
    if (kind === 'prepare' && (kw === 'SELECT' || kw === 'WITH' || kw === 'PRAGMA')) {
        // oxmysql's rawExecute adds each row of a read on its own, so a read
        // of several rows answers the rows; one row answers its value or the
        // row, and none answers nil. execRead casts the rows.
        const rows = backend.all(sqliteSql, p);
        if (rows.length > 1) return { kind: 'rows', value: rows };
        let row = rows[0];
        if (cast) row = cast(row);
        if (!row) return { kind: 'single', value: null };
        const keys = Object.keys(row);
        if (keys.length === 1) {
            let v = row[keys[0]];
            if (typeof v === 'bigint') v = Number(v);
            return { kind: 'scalar', value: v };
        }
        return { kind: 'single', value: row };
    }
    if (kind === 'scalar') {
        let row = backend.get(sqliteSql, p);
        if (cast) row = cast(row);
        if (!row) {
            if (plan.count) return { kind: 'scalar', value: 0 };
            return { kind: 'scalar', value: null };
        }
        let v = null;
        for (const k in row) { v = row[k]; break; }
        if (typeof v === 'bigint') v = Number(v);
        if (v == null && plan.count) v = 0;
        return { kind: 'scalar', value: v };
    }
    if (kind === 'single') {
        let row = backend.get(sqliteSql, p);
        if (cast) row = cast(row);
        return { kind: 'single', value: row || null };
    }
    const rows = backend.all(sqliteSql, p);
    return { kind: 'rows', value: rows };
}

function markDirtyTables(sql) {
    const re = /\b(?:INTO|UPDATE|FROM|TABLE)\s+["`]?([A-Za-z0-9_]+)/gi;
    let m;
    const seen = Object.create(null);
    while ((m = re.exec(String(sql || '')))) {
        if (!dialect.identOk(m[1])) continue;
        const name = m[1].toLowerCase();
        if (seen[name]) continue;
        seen[name] = true;
        dirtyTables.add(name);
        if (cdcHandle && cdcHandle.noteDirty) cdcHandle.noteDirty(name);
    }
}

function shapeMaria(kind, rows, header, type) {
    const list = Array.isArray(rows) ? rows : [];
    if (kind === 'scalar') {
        const row = list[0];
        if (!row) return null;
        let v = null;
        for (const k in row) { v = row[k]; break; }
        if (typeof v === 'bigint') v = Number(v);
        return v;
    }
    if (kind === 'single') return list[0] || null;
    if (kind === 'insert' || (kind === 'prepare' && type === 'insert')) return Number(header && header.insertId || 0);
    // A prepared read gives what execReadRaw gives: the rows when there are
    // several, the one value of a one-column row, else the row, else null.
    if (kind === 'prepare' && Array.isArray(rows)) {
        if (list.length > 1) return list;
        const row = list[0];
        if (!row) return null;
        const keys = Object.keys(row);
        if (keys.length !== 1) return row;
        const v = row[keys[0]];
        return typeof v === 'bigint' ? Number(v) : v;
    }
    if (kind === 'update' || kind === 'rawExecute' || kind === 'prepare') {
        if (header && header.affectedRows != null) return Number(header.affectedRows);
        return list;
    }
    return list;
}

/**
 * Run the caller's SQL on MariaDB when SQLite cannot.
 * The original statement is used, not the SQLite translation.
 * A write marks its tables dirty so CDC does not copy the row back.
 * @param {'query'|'scalar'|'single'|'insert'|'update'|'prepare'|'rawExecute'} kind
 * @param {string} rawSql
 * @param {Array} params
 * @returns {Promise<{value:*}>}
 */
const mariaDirectSet = new Set();

// Result casts for statements the engine hands to MariaDB as they are, so
// their values come back as the rest of the API gives them (written from the
// documented and observed results, see the comment above castTypes):
// DATETIME and TIMESTAMP as epoch ms, DATE as ms at local midnight,
// TINYINT(1) as a boolean, BIT(1) as a boolean and a wider BIT as its first
// byte, a binary BLOB as an array of bytes. prepare and rawExecute cast the
// dates only.
function castEpoch(text) {
    return text === null || text === '' ? null : new Date(text).getTime();
}
const castDateTime = (field) => castEpoch(field.string());
const castDate = (field) => {
    const text = field.string();
    return text === null || text === '' ? null : new Date(text + ' 00:00:00').getTime();
};
const DATE_CASTS = Object.assign(Object.create(null), {
    DATETIME: castDateTime, DATETIME2: castDateTime, TIMESTAMP: castDateTime,
    TIMESTAMP2: castDateTime, NEWDATE: castDateTime, DATE: castDate,
});
const castBlob = (field) => {
    if (field.charset !== 63) return field.string();
    const buf = field.buffer();
    return buf === null ? null : Array.from(buf);
};
const QUERY_CASTS = Object.assign(Object.create(null), DATE_CASTS, {
    TINY: (field, next) => {
        if (field.length !== 1) return next();
        const text = field.string();
        return text === null ? null : text === '1';
    },
    BIT: (field) => {
        const buf = field.buffer();
        if (buf === null) return null;
        return buf.length === 1 ? buf[0] === 1 : buf[0];
    },
    TINY_BLOB: castBlob, MEDIUM_BLOB: castBlob, LONG_BLOB: castBlob, BLOB: castBlob,
});

function mariaTypeCast(field, next) {
    const convert = QUERY_CASTS[field.type];
    return convert ? convert(field, next) : next();
}

function mariaTypeCastExecute(field, next) {
    const convert = DATE_CASTS[field.type];
    return convert ? convert(field, next) : next();
}

// A read MariaDB answers must see every write SQLite already took. Writes
// still in the outbox for a table it reads are copied first; while MariaDB
// is failing, or when they are not copied in time, the read fails with the
// reason rather than answer from an older copy.
const CATCH_UP_MS = 10000;

async function mariaCatchUp(rawSql) {
    if (!pendingTables.size || dialect.isWriteStatement(rawSql)) return;
    const tables = tablesOfSql(rawSql);
    const behind = () => tables.some((t) => pendingTables.has(String(t).toLowerCase()));
    if (!behind()) return;
    const deadline = Date.now() + CATCH_UP_MS;
    while (behind()) {
        if (outboxFailN > 0 && Date.now() < outboxRetryAt) throw new Error('MariaDB is not taking writes, so it has not seen the latest ones');
        if (Date.now() > deadline) throw new Error('writes to ' + tables.join(', ') + ' were not copied to MariaDB within ' + (CATCH_UP_MS / 1000) + ' s');
        await Promise.race([flushReplica(), new Promise((r) => setTimeout(r, 200))]);
        if (behind()) await new Promise((r) => setTimeout(r, 20));
    }
}

// A read MariaDB answers gives up after cis_database_maria_read_ms, counted
// from the moment it asks the pool, so a MariaDB that accepts a connection and
// then goes quiet fails the read with the reason instead of holding it. A
// connection whose read timed out is destroyed: its reply may still arrive and
// would answer the next query sent on it. Writes are never timed out here,
// since MariaDB may still commit one.
async function mariaRead(q) {
    if (typeof replicaPool.getConnection !== 'function') return replicaPool.query(Object.assign({ timeout: MARIA_READ_MS }, q));
    return new Promise((resolve, reject) => {
        let conn = null;
        let done = false;
        const finish = (fn, v) => {
            if (done) return false;
            done = true;
            clearTimeout(timer);
            fn(v);
            return true;
        };
        const timer = setTimeout(() => {
            if (finish(reject, new Error('MariaDB did not answer within ' + MARIA_READ_MS + ' ms')) && conn) {
                try { conn.destroy(); } catch (x) { /* already closed */ }
            }
        }, MARIA_READ_MS);
        replicaPool.getConnection().then((c) => {
            // A connection handed out after the read gave up goes back unused.
            if (done) { c.release(); return; }
            conn = c;
            c.query(q).then((out) => {
                if (done) return;
                c.release();
                finish(resolve, out);
            }, (e) => {
                if (done) return;
                try { c.release(); } catch (x) { /* already closed */ }
                finish(reject, e);
            });
        }, (e) => finish(reject, e));
    });
}

async function executeMariaDirect(kind, rawSql, params) {
    if (!replicaPool) throw new Error('cis_database: MariaDB fallback unavailable');
    // The same SQL and values SQLite would run: named values, bulk rows,
    // padding and IN (?) lists become plain positional ones first.
    const np = normalizeParams(rawSql, params);
    rawSql = np.sql;
    await mariaCatchUp(rawSql);
    // mysql2 quotes a BigInt; whole numbers go as numbers (see obValue).
    const bound = sqliteBindList(np.params).map((v) => (typeof v === 'bigint' && v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v));
    const typeCast = kind === 'prepare' || kind === 'rawExecute' ? mariaTypeCastExecute : mariaTypeCast;
    const q = { sql: rawSql, values: bound, typeCast };
    const [rows, header] = dialect.isWriteStatement(rawSql) ? await replicaPool.query(q) : await mariaRead(q);
    const kw = dialect.firstKeyword(rawSql);
    if (dialect.isWriteStatement(rawSql)) {
        markDirtyTables(rawSql);
    }
    return { value: shapeMaria(kind, rows, header, executeType(rawSql)) };
}

// ---- Reads SQLite could answer differently --------------------------------------------
// SQLite runs most reads exactly as MariaDB would. Some it runs and answers
// otherwise: a value it computes (SUM, ROUND, CONCAT of a DECIMAL, JSON_EXTRACT,
// integer `/`), a comparison of a text column with a number, an ENUM, BIT,
// BLOB or FLOAT column, or text with accents or trailing spaces, which
// utf8mb4_general_ci folds and SQLite's NOCASE does not. MariaDB answers
// those reads when it is configured, so the caller gets MariaDB's answer and
// never a silently different one. Every rule keys on the statement's shape,
// the declared type of a column it reads, or the value it is given; none on a
// table or column name. Each rule's evidence is tests/repro/maria_trust.js,
// every case checked against MariaDB 10.11.19 with oxmysql's typeCast.

// Calls SQLite answers as MariaDB does wherever they stand outside the
// select list. In the select list only COUNT is trusted.
const TRUST_FUNCS = new Set(['COUNT', 'IFNULL', 'COALESCE', 'NOW', 'CURRENT_TIMESTAMP', 'UNIX_TIMESTAMP', 'YEAR']);
// Words that are not a column, a call or a name.
const TRUST_KEYWORDS = new Set(['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'ON', 'AS', 'NULL', 'TRUE', 'FALSE',
    'WHEN', 'THEN', 'ELSE', 'CASE', 'END', 'EXISTS', 'JOIN', 'BY', 'HAVING', 'LIKE', 'BETWEEN', 'USING', 'LIMIT', 'OFFSET',
    'ALL', 'ANY', 'SOME', 'DISTINCT', 'DISTINCTROW', 'GROUP', 'ORDER', 'INTERVAL', 'ESCAPE', 'DESC', 'ASC', 'INNER', 'LEFT',
    'RIGHT', 'CROSS', 'OUTER', 'NATURAL', 'STRAIGHT_JOIN', 'DIV', 'MOD', 'XOR', 'FOR', 'SHARE', 'LOCK', 'MODE', 'NOWAIT',
    'SKIP', 'LOCKED', 'SQL_NO_CACHE', 'SQL_CACHE', 'SQL_CALC_FOUND_ROWS', 'HIGH_PRIORITY', 'SQL_SMALL_RESULT',
    'SQL_BIG_RESULT', 'SQL_BUFFER_RESULT', 'UPDATE', 'INDEX', 'FORCE', 'USE', 'IGNORE', 'KEY',
    'MICROSECOND', 'SECOND', 'MINUTE', 'HOUR', 'DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR']);
// Words before `(` that open a list or a subquery, not a call.
const PAREN_WORDS = new Set(['IN', 'EXISTS', 'AND', 'OR', 'NOT', 'ON', 'FROM', 'JOIN', 'WHERE', 'AS', 'SELECT', 'WHEN', 'THEN',
    'ELSE', 'BY', 'HAVING', 'ANY', 'ALL', 'SOME', 'BETWEEN', 'LIKE', 'IS', 'CASE', 'USING', 'INTO', 'XOR', 'DIV', 'MOD', 'INDEX', 'KEY']);
const SELECT_MODIFIERS = new Set(['ALL', 'DISTINCT', 'DISTINCTROW', 'HIGH_PRIORITY', 'STRAIGHT_JOIN', 'SQL_SMALL_RESULT',
    'SQL_BIG_RESULT', 'SQL_BUFFER_RESULT', 'SQL_NO_CACHE', 'SQL_CACHE', 'SQL_CALC_FOUND_ROWS']);
const COMPARE_CHARS = new Set(['=', '<', '>', '!']);
const ARITH_CHARS = new Set(['+', '-', '*', '%']);

// Text SQLite and utf8mb4_general_ci compare alike: printable ASCII with no
// trailing space.
function plainText(s) {
    return !/[^\x20-\x7e]|\x20$/.test(s);
}

function numericText(s) {
    return /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(s);
}

// A column's kind from its declared MariaDB type: text, enum, int, dec,
// float (FLOAT, kept as a 4-byte float by MariaDB), double, date, bin
// (BIT, BLOB, BINARY, spatial) or other.
function typeClass(dataType) {
    const d = String(dataType || '').toLowerCase();
    if (/^(?:char|varchar|tinytext|text|mediumtext|longtext|json)$/.test(d)) return 'text';
    if (d === 'enum' || d === 'set') return 'enum';
    if (/^(?:tinyint|smallint|mediumint|int|integer|bigint|year|bool|boolean)$/.test(d)) return 'int';
    if (d === 'decimal' || d === 'numeric') return 'dec';
    if (d === 'float') return 'float';
    if (d === 'double' || d === 'real' || d === 'double precision') return 'double';
    if (d === 'date' || d === 'datetime' || d === 'timestamp' || d === 'time') return 'date';
    if (/blob|binary|^bit$|geometry|point|linestring|polygon/.test(d)) return 'bin';
    return 'other';
}

// SQLite's declared type, for a table with no MariaDB column types kept.
function sqliteTypeClass(t) {
    const d = String(t || '').toUpperCase();
    if (/INT/.test(d)) return 'int';
    if (/CHAR|CLOB|TEXT/.test(d)) return 'text';
    if (/REAL|FLOA|DOUB/.test(d)) return 'double';
    if (!d || /BLOB/.test(d)) return 'bin';
    return 'other';
}

let trustEpoch = -1;
const trustPlans = new Map();
const trustColumns = new Map();

function trustReset() {
    if (trustEpoch === schemaEpoch) return;
    trustEpoch = schemaEpoch;
    trustPlans.clear();
    trustColumns.clear();
    textPurity.clear();
}

// Map of lowercased column name to its kind, for one table; empty when the
// table is not in SQLite.
function trustTableColumns(table) {
    let m = trustColumns.get(table);
    if (m) return m;
    m = new Map();
    try {
        const info = backend.all('SELECT name, type FROM pragma_table_info(?)', [table]) || [];
        const meta = new Map();
        for (const r of backend.all('SELECT column_name AS c, data_type AS d FROM "' + COLUMN_META + "\" WHERE table_name = ? AND column_name <> ''", [table]) || []) {
            meta.set(String(r.c).toLowerCase(), r.d);
        }
        for (const r of info) {
            const k = String(r.name).toLowerCase();
            m.set(k, meta.has(k) ? typeClass(meta.get(k)) : sqliteTypeClass(r.type));
        }
    } catch (e) { /* the table's names stay unknown */ }
    trustColumns.set(table, m);
    return m;
}

/**
 * What a read's text says about trusting SQLite with it, cached per
 * statement: a fixed reason to ask MariaDB, or the checks its values need.
 * @param {string} sql the caller's statement
 * @returns {{reason: string|null, textAt: number[], numAt: number[], dateAt: number[], limitAt: number[], textCols: string[][]}}
 */
function trustPlanFor(sql) {
    trustReset();
    let plan = trustPlans.get(sql);
    if (plan) return plan;
    plan = buildTrustPlan(sql);
    if (trustPlans.size >= PLAN_MAX) trustPlans.clear();
    trustPlans.set(sql, plan);
    return plan;
}

function buildTrustPlan(sql) {
    const plan = { reason: null, textAt: [], numAt: [], dateAt: [], limitAt: [], textCols: [] };
    const why = (r) => { plan.reason = r; return plan; };
    // MySQL reads a backslash in a string as an escape and # as a comment;
    // the lexer here does not, so such text is left to MariaDB.
    if (/[\\#]/.test(sql)) return why('backslash or # in the text');
    if (dialect.firstKeyword(sql) !== 'SELECT') return why('not a plain SELECT');
    const t = dialect.lexSql(sql).filter((x) => x.k !== 'ws');
    const up = (x) => (x && x.k === 'word' ? x.v.toUpperCase() : '');
    // A double-quoted run is a string in MySQL.
    const isStr = (x) => x && (x.k === 'str' || (x.k === 'id' && x.v[0] === '"'));
    const strVal = (x) => x.v.slice(1, -1).split(x.v[0] + x.v[0]).join(x.v[0]);
    const isName = (x) => x && (x.k === 'word' || (x.k === 'id' && x.v[0] === '`'));
    const nameOf = (x) => (x.k === 'id' ? x.v.slice(1, -1).replace(/``/g, '`') : x.v).toLowerCase();
    const tables = tablesOfSql(sql).filter((n) => !isInternalTable(n));
    const cols = tables.map((n) => [n, trustTableColumns(n)]);
    for (const [n, m] of cols) if (!m.size) return why('table ' + n + ' is not in SQLite');
    const classOf = (name) => {
        let hit = null;
        for (const [n, m] of cols) if (m.has(name)) { if (hit && hit[1] !== m.get(name)) return ['', 'other']; hit = [n, m.get(name)]; }
        return hit;
    };
    // Parameter number of each ?, in order.
    const paramNo = new Map();
    let pn = 0;
    for (let i = 0; i < t.length; i++) if (t[i].k === 'param') paramNo.set(i, pn++);
    // Names that are aliases or tables, not columns.
    const names = new Set(tables);
    for (let i = 0; i < t.length; i++) {
        if (up(t[i]) === 'AS' && isName(t[i + 1])) names.add(nameOf(t[i + 1]));
        if (isName(t[i]) && t[i + 1] && t[i + 1].v === '.' && t[i + 1].k === 'op') names.add(nameOf(t[i]));
        if (isName(t[i]) && isName(t[i + 1]) && tables.indexOf(nameOf(t[i])) >= 0 && !TRUST_KEYWORDS.has(up(t[i + 1]))) names.add(nameOf(t[i + 1]));
    }
    // The top-level select list.
    let i0 = 1;
    let distinct = false;
    while (i0 < t.length && SELECT_MODIFIERS.has(up(t[i0]))) { if (up(t[i0]) !== 'ALL') distinct = true; i0++; }
    let i1 = i0;
    for (let d = 0; i1 < t.length; i1++) {
        if (t[i1].k === 'lp') d++;
        else if (t[i1].k === 'rp') d--;
        else if (d === 0 && /^(?:FROM|UNION|INTO|LIMIT|FOR|LOCK)$/.test(up(t[i1]))) break;
    }
    if (t.some((x) => /^(?:UNION|INTERSECT|EXCEPT|WINDOW|OVER)$/.test(up(x)))) return why('UNION or window');
    if (t.some((x) => up(x) === 'GROUP')) distinct = true;
    const noteText = (name) => {
        const c = classOf(name);
        if (!c) return;
        for (const [n, m] of cols) if (m.get(name) === 'text') plan.textCols.push([n, name]);
    };
    const items = [];
    for (let i = i0, d = 0, s = i0; i <= i1; i++) {
        if (i === i1 || (d === 0 && t[i].k === 'comma')) { items.push(t.slice(s, i)); s = i + 1; continue; }
        if (t[i].k === 'lp') d++;
        else if (t[i].k === 'rp') d--;
    }
    for (let it of items) {
        const n = it.length;
        if (n >= 3 && up(it[n - 2]) === 'AS' && (isName(it[n - 1]) || isStr(it[n - 1]))) it = it.slice(0, n - 2);
        else if (n >= 2 && isName(it[n - 1]) && !(it[n - 2].k === 'op' && it[n - 2].v === '.') && !TRUST_KEYWORDS.has(up(it[n - 1]))) {
            names.add(nameOf(it[n - 1]));
            it = it.slice(0, n - 1);
        }
        const k = it.length;
        if (k === 1 && it[0].k === 'op' && it[0].v === '*') {
            for (const [tn, m] of cols) for (const [cn, c] of m) {
                if (c === 'bin' || c === 'other' || c === 'float') return why(c + ' column ' + tn + '.' + cn + ' read by *');
                if (distinct && c !== 'int' && c !== 'date') noteText(cn);
            }
            continue;
        }
        if (k === 3 && isName(it[0]) && it[1].v === '.' && it[2].v === '*') {
            for (const [tn, m] of cols) for (const [cn, c] of m) if (c === 'bin' || c === 'other' || c === 'float') return why(c + ' column ' + tn + '.' + cn + ' read by *');
            continue;
        }
        const bare = k === 1 && isName(it[0]) ? it[0] : k === 3 && isName(it[0]) && it[1].v === '.' && isName(it[2]) ? it[2] : null;
        if (bare && !TRUST_KEYWORDS.has(up(bare))) {
            const c = classOf(nameOf(bare));
            if (!c) return why('unknown column ' + nameOf(bare));
            if (c[1] === 'bin' || c[1] === 'other' || c[1] === 'float') return why(c[1] + ' column ' + nameOf(bare));
            if (distinct) { if (c[1] === 'enum') return why('enum column grouped'); noteText(nameOf(bare)); }
            continue;
        }
        if (k === 1 && (up(it[0]) === 'NULL' || (it[0].k === 'num' && /^\d+$/.test(it[0].v)) || (isStr(it[0]) && plainText(strVal(it[0]))))) continue;
        if (k >= 3 && up(it[0]) === 'COUNT' && it[1].k === 'lp' && it[k - 1].k === 'rp') {
            const a = it.slice(2, k - 1);
            const arg = a.length === 2 && up(a[0]) === 'DISTINCT' ? a[1] : a.length === 1 ? a[0] : null;
            if (arg && (arg.v === '*' || /^\d+$/.test(arg.v))) continue;
            if (arg && isName(arg)) {
                const c = classOf(nameOf(arg));
                if (!c) return why('unknown column ' + nameOf(arg));
                if (a.length === 2) { if (c[1] !== 'int' && c[1] !== 'text' && c[1] !== 'date') return why('COUNT(DISTINCT) of a ' + c[1] + ' column'); noteText(nameOf(arg)); }
                continue;
            }
            return why('COUNT of an expression');
        }
        return why('computed column ' + it.map((x) => x.v).join(' ').slice(0, 40));
    }
    // Everything outside the select list.
    for (let i = 1; i < t.length; i++) {
        if (i >= i0 && i < i1) continue;
        const x = t[i];
        if (x.k === 'op') {
            if (x.v === '/') return why('division');
            if (x.v === '|' || x.v === '&' || x.v === '^' || x.v === '~') return why('operator ' + x.v);
            if (x.v[0] === '-' && x.v.length > 1) return why('JSON arrow');
            if ((x.v === '<' && t[i + 1] && (t[i + 1].v === '<')) || (x.v === '>' && t[i + 1] && t[i + 1].v === '>')) return why('bit shift');
            if (x.v === '@' || x.v === ':' || x.v === '$') return why('variable or named value');
            continue;
        }
        if (x.k === 'num') {
            if (!/^\d+(?:\.\d+)?$/.test(x.v)) return why('number literal ' + x.v);
            if (x.v.indexOf('.') >= 0 && ((t[i - 1] && t[i - 1].k === 'op' && ARITH_CHARS.has(t[i - 1].v)) || (t[i + 1] && t[i + 1].k === 'op' && ARITH_CHARS.has(t[i + 1].v)))) return why('decimal arithmetic');
            continue;
        }
        if (isStr(x)) {
            if (!plainText(strVal(x))) return why('text literal with accents or trailing space');
            continue;
        }
        if (x.k === 'param') {
            const prev = up(t[i - 1]);
            if (prev === 'LIMIT' || prev === 'OFFSET' || (t[i - 1] && t[i - 1].k === 'comma' && up(t[i - 3]) === 'LIMIT')) plan.limitAt.push(paramNo.get(i));
            continue;
        }
        if (!isName(x)) continue;
        if (t[i + 1] && t[i + 1].k === 'lp') {
            const w = x.k === 'word' ? x.v.toUpperCase() : '';
            if (PAREN_WORDS.has(w)) continue;
            if (TRUST_FUNCS.has(w)) continue;
            return why('function ' + (w || x.v));
        }
        const w = up(x);
        if (w && TRUST_KEYWORDS.has(w)) continue;
        if (w === 'CURRENT_TIMESTAMP') continue;
        const name = nameOf(x);
        if (t[i + 1] && t[i + 1].k === 'op' && t[i + 1].v === '.') continue;
        const qualified = t[i - 1] && t[i - 1].k === 'op' && t[i - 1].v === '.';
        const c = classOf(name);
        if (!c) {
            if (!qualified && names.has(name)) continue;
            return why('unknown name ' + name);
        }
        if (!qualified && tables.indexOf(name) >= 0 && /^(?:FROM|JOIN)$/.test(up(t[i - 1]))) continue;
        const cls = c[1];
        if (cls === 'bin' || cls === 'other' || cls === 'enum' || cls === 'float') return why(cls + ' column ' + name);
        const nb = [t[i - 1], t[i + 1]];
        if ((cls === 'dec' || cls === 'double') && nb.some((y) => y && y.k === 'op' && ARITH_CHARS.has(y.v))) return why(cls + ' arithmetic');
        if (cls === 'text') noteText(name);
        // The values it is compared with: col op v, v op col, col [NOT] IN
        // (...), col [NOT] LIKE v, col BETWEEN a AND b.
        const ops = [];
        let j = i + 1;
        while (t[j] && t[j].k === 'op' && COMPARE_CHARS.has(t[j].v)) j++;
        if (j > i + 1) ops.push(t[j]);
        else {
            if (up(t[j]) === 'NOT') j++;
            if (up(t[j]) === 'LIKE' || up(t[j]) === 'REGEXP' || up(t[j]) === 'RLIKE') ops.push(t[j + 1]);
            else if (up(t[j]) === 'BETWEEN') { ops.push(t[j + 1]); if (up(t[j + 2]) === 'AND') ops.push(t[j + 3]); }
            else if (up(t[j]) === 'IN' && t[j + 1] && t[j + 1].k === 'lp') {
                for (let q = j + 2; t[q] && t[q].k !== 'rp'; q++) { if (t[q].k === 'lp') break; if (t[q].k !== 'comma') ops.push(t[q]); }
            }
        }
        let b = i - 1;
        while (t[b] && t[b].k === 'op' && COMPARE_CHARS.has(t[b].v)) b--;
        if (b < i - 1 && t[b]) ops.push(t[b]);
        for (const o of ops) {
            if (!o) continue;
            const at = o.k === 'param' ? paramNo.get(t.indexOf(o)) : -1;
            if (o.k === 'param') {
                if (cls === 'text') plan.textAt.push(at);
                else if (cls === 'date') plan.dateAt.push(at);
                else plan.numAt.push(at);
            } else if (o.k === 'num') {
                if (cls === 'text') return why('text column ' + name + ' compared with a number');
                if (cls === 'date') return why('date column ' + name + ' compared with a number');
            } else if (isStr(o)) {
                if ((cls === 'int' || cls === 'dec' || cls === 'double') && !numericText(strVal(o))) return why('number column ' + name + ' compared with text');
            } else if (isName(o)) {
                const oc = classOf(nameOf(o));
                const group = (k) => (k === 'int' || k === 'dec' || k === 'double' ? 'n' : k);
                if (oc && group(oc[1]) !== group(cls)) return why('columns of different types compared');
            }
        }
    }
    return plan;
}

// Text columns known to hold a value with accents or trailing spaces
// ("table\0column"), and the tables whose columns are watched. A trigger per
// table marks a column the moment a write stores such a value, so a column is
// checked once by a scan and from then on by its writes. A schema change
// (bumpSchema) drops what is known; the next read scans again.
const textPurity = new Map();

function markImpure(table, col) {
    const k = String(table).toLowerCase();
    const s = textPurity.get(k);
    if (s) s.impure.add(String(col).toLowerCase());
    return 1;
}

function textColumnPure(table, col) {
    let s = textPurity.get(table);
    if (!s) {
        s = { impure: new Set(), scanned: new Set(), watched: false };
        textPurity.set(table, s);
        try {
            const text = [...trustTableColumns(table)].filter((e) => e[1] === 'text').map((e) => e[0]);
            const real = (backend.all('SELECT name FROM pragma_table_info(?)', [table]) || []).map((r) => String(r.name));
            const names = text.map((c) => real.find((r) => r.toLowerCase() === c)).filter(Boolean);
            const test = (ref) => '(' + ref + " GLOB '*[^ -~]*' OR " + ref + " GLOB '* ')";
            const body = (row) => names.map((n) => 'SELECT cis_text_mark(' + sqlText(table) + ', ' + sqlText(n) + ') WHERE ' + test(row + '.' + quoteIdent(n)) + ';').join(' ');
            const when = (row) => names.map((n) => test(row + '.' + quoteIdent(n))).join(' OR ');
            if (names.length && textMarkReady) {
                for (const ev of ['INSERT', 'UPDATE']) {
                    backend.exec('CREATE TEMP TRIGGER IF NOT EXISTS ' + quoteIdent('__cis_text:' + table + ':' + ev) + ' AFTER ' + ev + ' ON ' + quoteIdent(table)
                        + ' WHEN ' + when('NEW') + ' BEGIN ' + body('NEW') + ' END');
                }
            }
            s.watched = true;
        } catch (e) {
            log.debug('text check not set up for ' + table + ': ' + (e && e.message));
        }
    }
    if (!s.watched || !textMarkReady) return false;
    if (!s.scanned.has(col)) {
        s.scanned.add(col);
        try {
            const real = (backend.all('SELECT name FROM pragma_table_info(?)', [table]) || []).map((r) => String(r.name)).find((r) => r.toLowerCase() === col);
            if (!real || backend.get('SELECT 1 AS x FROM ' + quoteIdent(table) + ' WHERE ' + quoteIdent(real) + " GLOB '*[^ -~]*' OR " + quoteIdent(real) + " GLOB '* ' LIMIT 1", [])) s.impure.add(col);
        } catch (e) { s.impure.add(col); }
    }
    return !s.impure.has(col);
}

function sqlText(s) {
    return "'" + String(s).replace(/'/g, "''") + "'";
}

// Only a read is checked; a write always runs on SQLite first. Text with a ;
// could carry a second statement, so it stays on SQLite too. So does a read
// of the caller's own session (LAST_INSERT_ID(), ROW_COUNT(), FOUND_ROWS()):
// the engine keeps those for the caller, and a MariaDB pool connection never
// ran the caller's writes, so it would answer 0.
const SESSION_FN = /\b(?:LAST_INSERT_ID|ROW_COUNT|FOUND_ROWS)\s*\(/i;
function trustableRead(sql) {
    const kw = dialect.firstKeyword(sql);
    if (kw !== 'SELECT' && kw !== 'WITH') return false;
    if (SESSION_FN.test(sql)) return false;
    return !dialect.isWriteStatement(sql) && sql.indexOf(';') < 0 && !isDangerousSql(sql);
}

/**
 * Why MariaDB, not SQLite, answers this read, or null when SQLite's answer
 * is MariaDB's.
 * @param {string} sql
 * @param {Array|object} params
 * @returns {string|null}
 */
function mariaTrustReason(sql, params) {
    const plan = trustPlanFor(sql);
    if (plan.reason) return plan.reason;
    const list = Array.isArray(params) ? params : params && typeof params === 'object' ? null : [];
    if (!list) {
        for (const k in params) { const v = params[k]; if (typeof v === 'string' && !plainText(v)) return 'text value with accents or trailing space'; }
        if (plan.textAt.length || plan.numAt.length || plan.dateAt.length || plan.limitAt.length) return 'named values compared with typed columns';
    } else {
        for (let i = 0; i < list.length; i++) {
            const v = list[i];
            const vs = Array.isArray(v) ? v : [v];
            for (const e of vs) {
                if (typeof e === 'string' && !plainText(e)) return 'text value with accents or trailing space';
                if (e instanceof Date) return 'Date value';
            }
        }
        const any = (at, test) => at.some((n) => { const v = list[n]; return (Array.isArray(v) ? v : [v]).some(test); });
        if (any(plan.textAt, (e) => typeof e === 'number' || typeof e === 'bigint' || typeof e === 'boolean')) return 'text column compared with a number';
        if (any(plan.numAt, (e) => typeof e === 'string' && !numericText(e))) return 'number column compared with text';
        if (any(plan.dateAt, (e) => typeof e === 'number' || typeof e === 'bigint' || typeof e === 'boolean')) return 'date column compared with a number';
        if (any(plan.limitAt, (e) => typeof e === 'string')) return 'LIMIT given text';
    }
    for (const [tb, col] of plan.textCols) if (!textColumnPure(tb, col)) return 'text column ' + col + ' holds accents or trailing spaces';
    return null;
}

// ---- Dispatch, readiness gate and transactions -------------------------------------------
// Entry points (submit, wrap, runTransaction) hold calls until hydrate has
// finished, then hand them to dispatch, which times them and settles the caller.
function dispatch(kind, sql, params, cb, resolve, reject) {
    const dashT = dashViewers.size ? performance.now() : 0;
    activeQueries++;
    if (TRACE) { trCalls++; trIn(TR_JS); }
    // MariaDB would take a batch's lists as one list of values: a batch runs
    // on SQLite only (execSets), and its error goes to the caller.
    const batch = isBatch(kind, params);
    try {
        if (!batch && replicaPool && sql && mariaDirectSet.has(sql)) {
            executeMariaDirect(kind, sql, params).then((out) => {
                queryN++;
                if (dashT) noteDash(performance.now() - dashT, sql, callerResource());
                finish(cb, resolve, reject, out.value, null);
            }).catch((mariaErr) => {
                errN++;
                finish(cb, resolve, reject, false, mariaErr && mariaErr.message ? mariaErr.message : mariaErr);
            });
            return;
        }
        if (!batch && MARIA_READS && replicaPool && sql && kind !== 'insert' && kind !== 'update' && kind !== 'rawExecute' && trustableRead(sql)) {
            let why;
            // Checked on the SQL SQLite would run: a named value bound by the
            // params table is a placeholder, and only a real user variable
            // (no params table) keeps its @ and needs MariaDB. Params the
            // engine refuses stay on SQLite, which gives that error.
            let np = null;
            try { np = normalizeParams(sql, params); } catch (e) { why = null; }
            if (np) {
                try { why = mariaTrustReason(np.sql, np.params); } catch (e) { why = 'read not checked: ' + (e && e.message); }
            }
            if (why) {
                mariaTrustN++;
                executeMariaDirect(kind, sql, params).then((out) => {
                    queryN++;
                    if (dashT) noteDash(performance.now() - dashT, sql, callerResource());
                    finish(cb, resolve, reject, out.value, null);
                }).catch((mariaErr) => {
                    errN++;
                    finish(cb, resolve, reject, false, 'cis_database: this read is answered by MariaDB (' + why + ') and MariaDB failed: '
                        + (mariaErr && mariaErr.message ? mariaErr.message : mariaErr));
                });
                return;
            }
        }
        const t0 = performance.now();
        lastPlan = null;
        const ws = writeSeq;
        const out = execKind(kind, sql || '', params);
        const ms = performance.now() - t0;
        queryN++;
        if (lastPlan && lastPlan.ddl) writeSeq++;
        if (ms >= AUTO_INDEX_MS) noteSlowRead(lastPlan, ms);
        if (ms >= HOLD_WARN_MS) noteHold('query', ms, 'A query from ' + (callerResource() || 'unknown'), sql);
        if (dashT) noteDash(performance.now() - dashT, sql, callerResource());
        settleWrite(ws, () => finish(cb, resolve, reject, out.value, null));
    } catch (e) {
        // Only a read may be answered by MariaDB. A write MariaDB took but
        // SQLite refused would leave the two apart for good and jump ahead of
        // the outbox, so the caller gets the SQLite error instead.
        // Text with a ; could carry a second statement past SQLite.
        // A statement dialect.js refuses on purpose (CALL, SET @name) stays refused.
        if (batch || !replicaPool || (e && e.cisRefused) || isDangerousSql(sql || '') || dialect.isWriteStatement(sql || '') || String(sql || '').indexOf(';') >= 0) {
            errN++;
            let msg = e && e.message ? e.message : e;
            // With no MariaDB a read SQLite cannot run has nowhere else to go.
            if (!replicaPool && sql && !dialect.isWriteStatement(sql) && !(e && e.cisRefused)) msg = String(msg) + ' (no MariaDB is configured to answer this read)';
            finish(cb, resolve, reject, false, msg);
            return;
        }
        executeMariaDirect(kind, sql || '', params).then((out) => {
            if (sql && mariaDirectSet.size < 1024) mariaDirectSet.add(sql);
            queryN++;
            if (dashT) noteDash(performance.now() - dashT, sql, callerResource());
            finish(cb, resolve, reject, out.value, null);
        }).catch((mariaErr) => {
            errN++;
            const msg = mariaErr && mariaErr.message ? mariaErr.message : (e && e.message ? e.message : e);
            finish(cb, resolve, reject, false, msg);
        });
    } finally {
        activeQueries = Math.max(0, activeQueries - 1);
        if (TRACE) trOut();
    }
}

// Calls that arrive before the engine is ready, oldest first. engineReady stays
// false until hydrate has copied MariaDB, including the retries, so answering
// earlier would hand the caller a missing or empty table. The waiters run in
// arrival order the moment the engine is ready, before any later call (calls
// made while they run join the end of the list), or fail together when the
// resource stops first. Nothing polls, so the game thread is not held.
const readyWaiters = [];
let readyDraining = false;
// The hydrate export copies tables again while the server runs. A copied
// table has no strict-mode or foreign-key triggers until the copy ends, so
// calls wait for it the way they wait for ready, and run in arrival order
// after it. isReady stays true: the database is not down, only busy.
let hydrateHold = false;

function acceptingCalls() {
    return engineReady && !readyDraining && !hydrateHold;
}

/**
 * Run `run` now if the engine takes calls, otherwise once it does.
 * @param {Function} run
 * @param {(msg: string) => void} fail called instead when the resource stops first
 */
function whenReady(run, fail) {
    if (acceptingCalls()) {
        run();
        return;
    }
    if (shuttingDown) {
        fail('engine not ready');
        return;
    }
    readyWaiters.push({ run, fail });
}

function markEngineReady() {
    engineReady = true;
    runReadyWaiters();
}

function releaseHydrateHold() {
    if (!hydrateHold) return;
    hydrateHold = false;
    // Jobs queued before the hold are older than the waiters: a waiter that
    // finds them queued joins the end of the queue (mustQueue).
    if (pendingCount() > 0) armSliceEnd();
    runReadyWaiters();
}

function runReadyWaiters() {
    readyDraining = true;
    try {
        for (let i = 0; i < readyWaiters.length; i++) {
            const w = readyWaiters[i];
            readyWaiters[i] = null;
            try { w.run(); } catch (e) { log.error('A call queued before ready failed: ' + (e && e.message || e)); }
        }
    } finally {
        readyWaiters.length = 0;
        readyDraining = false;
    }
}

function failReadyWaiters() {
    const list = readyWaiters.splice(0, readyWaiters.length);
    for (let i = 0; i < list.length; i++) {
        if (!list[i]) continue;
        try { list[i].fail('engine not ready'); } catch (e) { /* the caller is gone */ }
    }
}

function submit(kind, sql, params, cb) {
    let resolve = null;
    let reject = null;
    let returned;
    if (typeof cb === 'function') {
        // The callback is the answer. A promise here would only cost an
        // allocation, and its rejection would go unhandled.
        returned = undefined;
    } else {
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        // Marks a rejection as handled when the host never asks for the value.
        promise.catch(() => {});
        returned = {
            // Citizen unpacks this with table.unpack on both sides. A bare
            // number or row has no length, so the caller dies with
            // "attempt to get length of a number value". One slot, always.
            __cfx_async_retval(done) {
                promise.then((v) => done([v], null), (e) => done(null, e && e.message ? e.message : String(e)));
            },
        };
    }
    if (!acceptingCalls()) {
        // The waiter settles this call's own promise, so .await and
        // __cfx_async_retval resolve too, not only the callback form.
        whenReady(
            () => submitReady(kind, sql, params, cb, resolve, reject),
            (msg) => finish(cb, resolve, reject, false, msg)
        );
        return returned;
    }
    submitReady(kind, sql, params, cb, resolve, reject);
    return returned;
}

function submitReady(kind, sql, params, cb, resolve, reject) {
    if (mustQueue()) {
        queueJob({ t: J_CALL, kind, sql, params, cb, resolve, reject });
        return;
    }
    enterBusy();
    try { dispatch(kind, sql, params, cb, resolve, reject); } finally { leaveBusy(); }
}

/**
 * Build the export for one oxmysql method.
 * query, scalar, single, insert, update, prepare, and rawExecute all land here.
 * FiveM calls the export as (self, sql, params, cb) and drops self, so parseArgs
 * accepts the SQL in the first or second position. A missing callback returns a Promise.
 * scalar resolves one value. single resolves one row or null. query resolves the row array.
 * @param {'query'|'scalar'|'single'|'insert'|'update'|'prepare'|'rawExecute'} kind
 * @returns {Function} (sql, params, cb) => Promise|undefined
 */
function wrap(kind) {
    return function (a, b, c, d, e) {
        const args = parseArgs(a, b, c, d, e);
        const cb = args.cb ? oxCallback(args.cb, errorsWanted(arguments, args.cb), args.sql) : null;
        return submit(kind, args.sql, args.params, cb);
    };
}

// The include sends (sql, params, cb, resource, flag): flag is true for its
// .await forms and for a resource with mysql_option 'return_callback_errors'.
function errorsWanted(args, cb) {
    for (let i = 0; i < args.length; i++) if (args[i] === cb) return args[i + 2] === true;
    return false;
}

/**
 * oxmysql calls a plain callback only with a result. A failed query is
 * printed, and reaches the callback as (nil, message) only when the caller
 * asked for errors.
 * @param {Function} cb
 * @param {boolean} wantErrors
 * @param {string} sql
 * @returns {Function}
 */
function oxCallback(cb, wantErrors, sql) {
    const from = callerResource() || 'unknown';
    return function (result, err) {
        if (arguments.length < 2 || err == null || err === '') return cb(result);
        if (wantErrors) return cb(null, String(err));
        log.error(from + ' was unable to execute a query: ' + redactSqlError(String(err)) + ' (' + clipSql(sql) + ')');
    };
}

/**
 * Run a list of statements in one SQLite transaction.
 * Accepts an array, a Lua array (keys "1".."n"), or objects shaped
 * { query|sql, values|parameters|params }. An empty list resolves true.
 * A statement that throws rolls back and the callback gets (false, message).
 * Nested transactions are rejected. The outbox row for MariaDB commits with the transaction.
 * @param {Array<object|string>|object} queries
 * @param {Function|null} cb (ok, err) => void. Absent means the returned Promise is the result.
 * @returns {Promise<boolean>|undefined}
 */
function releaseTx(began) {
    if (began) {
        try { backend.exec('ROLLBACK'); } catch (e2) { /* ignore */ }
    }
    txDepth = 0;
}

function runTransaction(queries, cb, sharedParams) {
    let resolve, reject, promise;
    if (typeof cb !== 'function') {
        promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        promise.catch(() => {});
    }
    const job = { t: J_FN, fn: () => runTransactionNow(queries, cb, resolve, reject, sharedParams) };
    if (!acceptingCalls()) {
        whenReady(() => gate(job), (msg) => finish(cb, resolve, reject, false, msg));
        return promise;
    }
    gate(job);
    return promise;
}

function runTransactionNow(queries, cb, resolve, reject, sharedParams) {
    if (!TRACE) return transactionBody(queries, cb, resolve, reject, sharedParams);
    trCalls++;
    trIn(TR_JS);
    try { return transactionBody(queries, cb, resolve, reject, sharedParams); } finally { trOut(); }
}

function transactionBody(queries, cb, resolve, reject, sharedParams) {
    let began = false;
    const shared = sharedParams != null && typeof sharedParams === 'object' ? sharedParams : [];
    try {
        const list = luaList(queries);
        if (!list || !list.length) {
            finish(cb, resolve, reject, true, null);
            return;
        }
        if (txDepth > 0) {
            // A holder older than 5s is a leaked BEGIN, not a nested caller.
            if (Date.now() - lastTxStart > 5000) {
                releaseTx(true);
            } else {
                log.error('A transaction from ' + callerResource() + ' returned false: cannot start a transaction within a transaction.');
                finish(cb, resolve, reject, false, null);
                return;
            }
        }
        const txReplicaBuffer = [];
        const ws = writeSeq;
        txDepth++;
        lastTxStart = Date.now();
        const t0 = performance.now();
        let worstMs = -1;
        let worstSql = '';
        backend.exec('BEGIN IMMEDIATE');
        began = true;
        for (let i = 0; i < list.length; i++) {
            const item = list[i];
            let sql = '';
            let params = [];
            // The three forms oxmysql's parseTransaction takes: a string uses
            // the shared parameters, a Lua { sql, params } pair arrives as a
            // 0-based array, and a { query, values } table brings its own.
            if (typeof item === 'string') {
                sql = item;
                params = shared;
            } else if (Array.isArray(item)) {
                sql = item[0] || '';
                params = item[1] || [];
            } else if (typeof item === 'object') {
                sql = item.query || item.sql || item[1] || item['1'] || '';
                params = item.values || item.parameters || item.params || item[2] || item['2'] || [];
            }
            // oxmysql refuses an item with no SQL, so nothing commits.
            if (typeof sql !== 'string' || !sql) throw new Error('transaction item ' + (i + 1) + ' has no SQL');
            const ti = performance.now();
            execKind('update', sql, params, txReplicaBuffer);
            const di = performance.now() - ti;
            if (di > worstMs) { worstMs = di; worstSql = sql; }
        }
        // The outbox row commits with the transaction, so MariaDB gets all of
        // it or none of it, even after a crash.
        if (outboxOn && txReplicaBuffer.length) outboxAdd(txReplicaBuffer, callerResource());
        backend.exec('COMMIT');
        began = false;
        txDepth = 0;
        lastWriteTime = Date.now();
        const held = performance.now() - t0;
        if (held >= HOLD_WARN_MS) noteHold('transaction', held, 'A transaction of ' + list.length + ' statement' + (list.length === 1 ? '' : 's') + ' from ' + (callerResource() || 'unknown'), worstSql);
        if (!outboxOn) {
            for (let i = 0; i < txReplicaBuffer.length; i++) {
                const item = txReplicaBuffer[i];
                if (item.tables) noteDirtyList(item.tables);
                else markDirtyTables(item.sql);
            }
        }
        settleWrite(ws, () => finish(cb, resolve, reject, true, null));
    } catch (e) {
        releaseTx(began);
        // oxmysql resolves false and prints the error; callers such as
        // qbx_core and es_extended test that value.
        log.error('A transaction from ' + callerResource() + ' rolled back: ' + redactSqlError(e && e.message ? e.message : String(e)));
        finish(cb, resolve, reject, false, null);
    }
}

// ---- Lua exports ----------------------------------------------------------------------------
// The path lib/MySQL.lua's .await forms use. Passing a Lua callback to an
// export creates a function reference on every call, and FXServer frees it
// only when V8 collects the JavaScript wrapper; until then the reference
// keeps the caller's closure, promise and result alive. Measured with
// tests/fxserver/cis_refs on build 35245, 50000 awaited calls answered
// synchronously: 132 us a call and 107 MB of the caller's Lua heap still
// held afterwards, against 82 us and 6 MB with one callback registered once.
//
// So a resource registers one resolver (cis_register), and cis_call returns
// the result itself when the statement ran at once, which is nearly always:
//   [1, result]   done        [2, message]   failed
//   [0, id]       held back by the slice budget; the resolver gets
//                 (id, result) or (id, nil, message) later
//   [3]           this resource has no resolver (cis_database restarted)
function exportCallPath() {
    const resolvers = new Map();
    // Resources whose include takes answers in batches (cis_register(fn, 2)):
    // fn(0, n, ids, results, errors). A WAL sync answers every write waiting
    // for it at once, and each call into Lua costs tens of microseconds, so
    // the answers for one resource go over in one call, up to BATCH_MAX.
    const batched = new Set();
    const batches = new Map();
    const BATCH_MAX = 32;
    let flushQueued = false;
    let seq = 0;
    const invoker = () => {
        try { return (typeof GetInvokingResource === 'function' && GetInvokingResource()) || ''; } catch (e) { return ''; }
    };
    const flushOne = (res, b) => {
        batches.delete(res);
        enterBusy();
        if (TRACE) trIn(TR_CB);
        try { b.fn(0, b.ids.length, b.ids, b.results, b.errs); } catch (e) { log.error('Answering ' + res + ' failed: ' + (e && e.message || e)); }
        finally { if (TRACE) trOut(); leaveBusy(); }
    };
    const flushAll = () => {
        flushQueued = false;
        for (const [res, b] of Array.from(batches)) flushOne(res, b);
    };
    const answer = (res, id, result, err) => {
        const fn = resolvers.get(res);
        if (!fn) return;
        if (!batched.has(res)) { fn(id, result, err); return; }
        let b = batches.get(res);
        if (!b) { b = { fn, ids: [], results: [], errs: [] }; batches.set(res, b); }
        b.ids.push(id);
        b.results.push(result);
        b.errs.push(err);
        if (b.ids.length >= BATCH_MAX) flushOne(res, b);
        else if (!flushQueued) { flushQueued = true; process.nextTick(flushAll); }
    };
    exports('cis_register', (fn, version) => {
        const res = invoker();
        if (!res || typeof fn !== 'function') return false;
        resolvers.set(res, fn);
        if (Number(version) >= 2) batched.add(res); else batched.delete(res);
        return true;
    });
    if (typeof on === 'function') {
        on('onResourceStop', (name) => {
            // Any resource can TriggerEvent('onResourceStop', 'x'). Only a
            // real stop has x in the stopping state.
            if (typeof GetResourceState === 'function' && GetResourceState(String(name)) !== 'stopping') return;
            resolvers.delete(String(name));
            batched.delete(String(name));
            batches.delete(String(name));
        });
    }
    exports('cis_call', (kind, sql, params) => {
        const res = invoker();
        if (!resolvers.has(res)) return [3];
        if (METHODS.indexOf(kind) < 0) return [2, 'cis_database: unknown method ' + String(kind)];
        let sync = true;
        let out = null;
        let id = 0;
        // invokeCb calls cb(result) on success and cb(false, message) on error.
        const cb = function (result, err) {
            const failed = arguments.length > 1 && err != null && err !== '';
            if (sync) {
                out = failed ? [2, String(err)] : [1, result];
                return;
            }
            answer(res, id, failed ? null : result, failed ? String(err) : null);
        };
        cb.direct = true;
        try {
            // The same argument handling as the transaction and wrap(kind)
            // exports, so both paths run a call identically.
            if (kind === 'transaction') {
                runTransaction(sql, cb, params);
            } else {
                const args = parseArgs(sql, params, cb);
                submit(kind, args.sql, args.params, args.cb);
            }
        } catch (e) {
            sync = false;
            cb.direct = false;
            return [2, String(e && e.message || e)];
        }
        sync = false;
        cb.direct = false;
        if (out) return out;
        id = ++seq;
        return [0, id];
    });
}

function exportAll() {
    for (const m of METHODS) {
        if (m === 'transaction') continue;
        exports(m, wrap(m));
        exports(m + '_async', wrap(m));
        exports(m + 'Sync', wrap(m));
    }
    function txExport(a, b, c, d, e) {
        // CFX drops the export self that MySQL.lua passes. Await then calls
        // (queries, nil, cb). The bench passes nil first, so the queries sit in b.
        // The argument after the queries is oxmysql's shared parameters.
        const looksLikeQueries = (v) => Array.isArray(v) || (v && typeof v === 'object' && (v[0] || v['1'] || v.query || v.sql));
        const args = [a, b, c, d];
        let qi = 0;
        let cb = null;
        if (!looksLikeQueries(a) && looksLikeQueries(b)) qi = 1;
        else if (!looksLikeQueries(a) && !looksLikeQueries(b) && looksLikeQueries(c)) qi = 2;
        let queries = args[qi];
        const shared = args[qi + 1];
        if (typeof b === 'function') cb = b;
        else if (typeof c === 'function') cb = c;
        else if (typeof d === 'function') cb = d;
        else if (typeof e === 'function') cb = e;
        if (typeof queries === 'function') {
            cb = queries;
            queries = [];
        }
        return runTransaction(queries, cb, shared);
    }
    exports('transaction', txExport);
    exports('transaction_async', txExport);
    exports('transactionSync', txExport);
    exportCallPath();
    exports('fetchAll', wrap('query'));
    exports('fetchSingle', wrap('single'));
    exports('fetchScalar', wrap('scalar'));
    // oxmysql sets MySQL.execute and MySQL.fetch to query (src/index.ts), so
    // a SELECT through either returns its rows.
    for (const alias of ['execute', 'fetch']) {
        exports(alias, wrap('query'));
        exports(alias + '_async', wrap('query'));
        exports(alias + 'Sync', wrap('query'));
    }
    // oxmysql's startTransaction(fn) keeps one connection open while fn
    // awaits its queries. cis_database has one SQLite connection that the
    // outbox, the change scan and every other caller also write on between
    // those awaits, so it cannot do this safely yet. The stub never runs fn
    // and returns false, which callers already treat as a failed transaction
    // (docs/KNOWN-GAPS.md).
    const startTxWarned = new Set();
    exports('startTransaction', (fn, b, c) => {
        const who = callerResource();
        if (!startTxWarned.has(who)) {
            startTxWarned.add(who);
            log.error(who + ' called startTransaction, which cis_database does not support yet; it returned false and ran nothing. Use MySQL.transaction with a list of queries.');
        }
        const cb = typeof b === 'function' ? b : (typeof c === 'function' ? c : null);
        if (cb) setImmediate(() => cb(false));
        return false;
    });
    exports('isReady', () => engineReady);
    exports('ready', () => engineReady);
    // API.md documents awaitConnection(nil, cb), so the callback can be in
    // either position. Like oxmysql's, the answer is true once the engine
    // answers calls: to the callback, or as an awaitable return value.
    exports('awaitConnection', (a, b) => {
        const cb = typeof a === 'function' ? a : (typeof b === 'function' ? b : null);
        if (cb) {
            whenReady(() => setImmediate(() => cb(true)), () => {});
            return undefined;
        }
        const promise = new Promise((res, rej) => whenReady(() => res(true), (msg) => rej(new Error(msg))));
        promise.catch(() => {});
        return {
            __cfx_async_retval(done) {
                promise.then((v) => done([v], null), (e) => done(null, e.message));
            },
        };
    });
    // oxmysql's store, kept for mysql-async and ghmattimysql scripts: the
    // stored query is the SQL itself, so the later call runs it as given.
    // The value is also returned, so the Sync form needs no callback.
    function storeExport(a, b, c) {
        const sql = [a, b, c].find((v) => typeof v === 'string');
        const cb = [a, b, c].find((v) => typeof v === 'function');
        if (cb) cb(sql);
        return sql;
    }
    exports('store', storeExport);
    exports('store_async', storeExport);
    exports('storeSync', storeExport);
    // Internal exports answer only this resource (index.lua, server/*.lua).
    // An empty invoker is refused too: every export call has one.
    function selfExport(name, fn) {
        exports(name, function (a, b, c, d) {
            let inv = '';
            try { if (typeof GetInvokingResource === 'function') inv = GetInvokingResource() || ''; } catch (e) { inv = ''; }
            let mine = '';
            try { if (typeof GetCurrentResourceName === 'function') mine = GetCurrentResourceName() || ''; } catch (e) { mine = ''; }
            if (!mine || inv !== mine) {
                if (!selfExport.warned[name]) {
                    selfExport.warned[name] = true;
                    log.warn('Refused ' + name + ' from ' + (inv || 'an unknown caller') + '; it is internal to ' + (mine || 'cis_database') + '.');
                }
                const cb = typeof d === 'function' ? d : typeof c === 'function' ? c : typeof b === 'function' ? b : typeof a === 'function' ? a : null;
                if (cb) finish(cb, null, null, false, 'cis_database: ' + name + ' is internal');
                return false;
            }
            return fn(a, b, c, d);
        });
    }
    selfExport.warned = Object.create(null);
    selfExport('cis_dash_snapshot', () => dashSnapshot());
    selfExport('cis_dash_watch', (src, on) => {
        const id = Number(src) || 0;
        if (!id) return false;
        if (on) dashViewers.add(id);
        else dashViewers.delete(id);
        if (!dashViewers.size) {
            dashLat.length = 0;
            dashQpsN = 0;
            dashQps = 0;
        }
        return true;
    });
    selfExport('shutdown', () => {
        shuttingDown = true;
        engineReady = false;
        failReadyWaiters();
        // Calls already accepted and queued behind the budget run now, before
        // the database closes.
        drainPending(true);
        syncWalNow();
        if (replicaTimer) clearInterval(replicaTimer);
        if (idReserveTimer) clearInterval(idReserveTimer);
        if (checkpointTimer) clearInterval(checkpointTimer);
        closeCheckpointDbs();
        closeWakeSocket();
        // Writes MariaDB has not confirmed are already in the outbox on disk.
        const pending = activeFlushPromise || Promise.resolve();
        pending.then(() => {
            if (outboxPending) log.info(outboxPending + ' writes wait in the outbox for MariaDB; they are sent after the next start.');
            try { if (replicaPool) replicaPool.end(); } catch (e2) { /* ignore */ }
            try { if (outboxPool) outboxPool.end(); } catch (e2) { /* ignore */ }
            try { if (backend) backend.close(); } catch (e3) { /* ignore */ }
            closeCheckpointFds();
            // The hot copy is rebuilt from cache/hydrate.sqlite at every boot.
            if (hotFile) removeDbFile(hotFile);
        }).catch(() => { });
    });
    // Server console only: cis_database_doctor. A player, even an admin,
    // gets nothing, so the output never names paths or hosts to a client.
    if (typeof RegisterCommand === 'function') {
        RegisterCommand('cis_database_doctor', (source) => {
            if (Number(source) !== 0) return;
            const checks = doctorChecks();
            for (const c of checks) {
                log.info('doctor ' + c.state + ' ' + c.name + ': ' + c.detail + (c.fix ? ' Fix: ' + c.fix : ''));
            }
            const bad = checks.filter((c) => c.state !== 'OK').length;
            log.info('doctor ' + (bad ? bad + (bad === 1 ? ' problem' : ' problems') : 'no problems') + ' in ' + checks.length + ' checks.');
        }, true);
    }
    // Any resource may read probe. Only cis_database itself, or a resource
    // granted `add_ace resource.<name> cis_database.probe allow` (the bench
    // resource), may reset the counters the dashboard reads.
    exports('probe', (a, b) => {
        const out = probeSnapshot();
        let mine = false;
        try {
            const inv = typeof GetInvokingResource === 'function' ? GetInvokingResource() || '' : '';
            mine = inv !== '' && (inv === GetCurrentResourceName()
                || (typeof IsPrincipalAceAllowed === 'function' && !!IsPrincipalAceAllowed('resource.' + inv, 'cis_database.probe')));
        } catch (e) { mine = false; }
        if (mine && (a === true || b === true)) { sliceMax = 0; wakeN = 0; wakeSum = 0; wakeMax = 0; ckptCopyMax = 0; }
        return out;
    });
    const probeSnapshot = () => ({
        ready: engineReady,
        backend: backend && backend.kind,
        queries: queryN,
        errors: errN,
        maria_reads: mariaTrustN,
        replica: outboxPending,
        queued: pendingCount(),
        queued_total: queuedN,
        slice_ms: SLICE_MS,
        frame_ms: FRAME_MS,
        slice_max_ms: Math.round(Math.max(sliceMax, sliceUsed) * 100) / 100,
        wake: WAKE,
        wake_n: wakeN,
        wake_avg_ms: wakeN ? Math.round(wakeSum / wakeN * 1000) / 1000 : 0,
        wake_max_ms: Math.round(wakeMax * 1000) / 1000,
        ckpt: ckptSplit ? 'split' : 'thread',
        ckpt_n: ckptN,
        ckpt_thread_n: ckptThreadN,
        ckpt_copy_max_ms: Math.round(ckptCopyMax * 100) / 100,
        ack: ACK_DURABLE ? 'power' : 'process',
        fsync_n: fsyncN,
        fsync_errors: fsyncErrN,
        fsync_avg_ms: fsyncN ? Math.round(fsyncMsSum / fsyncN * 1000) / 1000 : 0,
        fsync_max_ms: Math.round(fsyncMsMax * 100) / 100,
        wal_prealloc: walPrealloc,
        ob_cache: obCache.size,
        ob_cache_bytes: obCacheBytes,
        acks_waiting: ackWaiters.length / 2,
        wal_frames: walFrames,
        wal_restarts: walRestarts,
        replica_drop: replicaDropN,
        id_clash: idClashN,
        id_reserve: idReserveOn ? 'on' : 'off',
        hydrate_ms: hydrateMs,
        rss_kb: Math.round(process.memoryUsage().rss / 1024),
    });
    selfExport('flushReplica', (a, b) => {
        const cb = typeof a === 'function' ? a : (typeof b === 'function' ? b : null);
        Promise.resolve(flushReplica()).then(() => {
            if (typeof cb === 'function') cb(true);
        }).catch((e) => {
            if (typeof cb === 'function') cb(false, e && e.message);
        });
    });
    selfExport('reloadTable', (a, b, c) => {
        let table = a;
        let done = b;
        if (typeof a !== 'string' && typeof b === 'string') { table = b; done = c; }
        if (typeof done !== 'function' && typeof c === 'function') done = c;
        if (typeof table !== 'string' || !/^[A-Za-z0-9_]+$/.test(table)) {
            finish(done, null, null, false, 'cis_database: reloadTable name');
            return;
        }
        if (dirtyTables) dirtyTables.delete(table.toLowerCase());
        const run = cdcHandle && cdcHandle.reload ? cdcHandle.reload(table) : Promise.resolve(false);
        Promise.resolve(run).then((n) => finish(done, null, null, n == null ? true : n, null))
            .catch((e) => finish(done, null, null, false, e && e.message));
    });
    selfExport('hydrate', (a, b) => {
        const done = typeof a === 'function' ? a : (typeof b === 'function' ? b : null);
        whenReady(() => runHydrateExport(done), (msg) => finish(done, null, null, false, msg));
    });
    function runHydrateExport(done) {
        if (!bootDsn || !backend || !mysql2mod) {
            finish(done, null, null, false, 'cis_database: hydrate unavailable');
            return;
        }
        txDepth++;
        lastTxStart = Date.now();
        hydrateHold = true;
        const ready = bootHydrate ? bootHydrate.catch(() => null) : Promise.resolve();
        ready.then(() => hydrateFromMaria(backend, bootDsn, { all: true })).then((res) => {
            const tables = res && res.tables || 0;
            const rows = res && res.rows || 0;
            log.info('Re-hydrated ' + tables + ' tables (' + rows + ' rows) into SQLite.');
            txDepth = 0;
            releaseHydrateHold();
            finish(done, null, null, { tables: tables, rows: rows }, null);
        }).catch((e) => {
            txDepth = 0;
            releaseHydrateHold();
            log.error('hydrate failed: ' + (e && e.stack ? e.stack : e));
            finish(done, null, null, false, e && e.message ? e.message : String(e));
        });
    }
    // The frame boundary, once per server tick. setTick runs it inside this
    // resource's own JS tick, not a Lua Wait(0) thread calling an export: that
    // costs about 0.23 ms per idle frame for the Lua thread and the export hop
    // alone.
    function frameTick() {
        if (TRACE) { trFrameEnd(performance.now()); trIn(TR_POLL); }
        startFrame();
        try {
            // The queue is drained from setImmediate between ticks. This is
            // the fallback for a host that runs immediates late.
            return drainPending(false);
        } finally {
            if (TRACE) trOut();
        }
    }
    // FXServer and the test harness (tests/harness/fx.js) both provide setTick.
    if (typeof setTick === 'function') setTick(frameTick);
    // The list comes first. A colon call written with a leading nil, as the
    // other direct exports need, gives (nil, list, cb): the list is taken from
    // the second place then. With no list in either place the caller raises,
    // as it would otherwise wait for a callback that runs nothing.
    const execManyFn = function (a, b, c) {
        let items = a;
        let cb = b;
        if (a == null && b !== null && typeof b === 'object') {
            items = b;
            cb = c;
        }
        if (items === null || typeof items !== 'object') {
            throw new Error('execMany wants a list of { query, values } as its first argument, but received ' + (items === null ? 'nil' : typeof items));
        }
        whenReady(() => gate({ t: J_FN, fn: () => execManyNow(items, cb) }), (msg) => finish(cb, null, null, false, msg));
    };
    const execManyNow = function (items, cb) {
        if (!TRACE) return execManyBody(items, cb);
        trCalls++;
        trIn(TR_JS);
        try { return execManyBody(items, cb); } finally { trOut(); }
    };
    const execManyBody = function (items, cb) {
        const out = [];
        const buf = [];
        let began = false;
        try {
            // Inside the try: a sparse list throws, and the callback must
            // still get false and the reason.
            const list = luaList(items);
            if (!list || !list.length) {
                finish(cb, null, null, out, null);
                return;
            }
            if (txDepth > 0 && Date.now() - lastTxStart > 5000) releaseTx(true);
            const ws = writeSeq;
            txDepth++;
            lastTxStart = Date.now();
            const t0 = performance.now();
            let worstMs = -1;
            let worstSql = '';
            backend.exec('BEGIN IMMEDIATE');
            began = true;
            for (let i = 0; i < list.length; i++) {
                const it = list[i] || {};
                const sql = it.sql || it.query || '';
                const kind = it.kind || 'query';
                // Only the result shapes a caller can ask for by name;
                // 'transaction' would split a multi-statement string here.
                if (!EXEC_MANY_KINDS.has(kind)) throw new Error('execMany item ' + (i + 1) + ' has kind ' + JSON.stringify(String(kind)).slice(0, 40) + '; use one of ' + Array.from(EXEC_MANY_KINDS).join(', '));
                const ti = performance.now();
                out.push(execKind(kind, sql, it.params || it.values || [], buf).value);
                const di = performance.now() - ti;
                if (di > worstMs) { worstMs = di; worstSql = sql; }
            }
            if (outboxOn && buf.length) outboxAdd(buf, callerResource());
            backend.exec('COMMIT');
            began = false;
            txDepth = 0;
            lastWriteTime = Date.now();
            const held = performance.now() - t0;
            if (held >= HOLD_WARN_MS) noteHold('execMany', held, 'An execMany of ' + list.length + ' statement' + (list.length === 1 ? '' : 's') + ' from ' + (callerResource() || 'unknown'), worstSql);
            if (!outboxOn) {
                for (let i = 0; i < buf.length; i++) {
                    if (buf[i].tables) noteDirtyList(buf[i].tables);
                    else markDirtyTables(buf[i].sql);
                }
            }
            settleWrite(ws, () => finish(cb, null, null, out, null));
        } catch (e) {
            releaseTx(began);
            finish(cb, null, null, false, e && e.message);
        }
    };
    exports('execMany', execManyFn);
    exports('queryMany', execManyFn);
    provideExports();
}

// The names oxmysql v2.14.3 answers for scripts written against mysql-async
// and ghmattimysql, and the oxmysql method behind each (src/index.ts and
// src/compatibility/*.ts), so their results are oxmysql's.
const COMPAT_EXPORTS = {
    'mysql-async': {
        mysql_execute: 'update',
        mysql_insert: 'insert',
        mysql_fetch_all: 'query',
        mysql_fetch_scalar: 'scalar',
        mysql_transaction: 'transaction',
        mysql_store: 'store',
    },
    ghmattimysql: {
        execute: 'query',
        executeSync: 'querySync',
        scalar: 'scalar',
        scalarSync: 'scalarSync',
        transaction: 'transaction',
        transactionSync: 'transactionSync',
        store: 'store',
        storeSync: 'storeSync',
    },
};

// provide 'oxmysql' lets this resource stand in for oxmysql as a dependency and
// for @oxmysql/ file includes, but FXServer does not alias exports:
// exports.oxmysql:query(...) emits __cfx_export_oxmysql_query, and only a
// handler under that exact name answers (citizen/scripting/v8/main.js). Each
// export in the manifest's server_exports list therefore answers under oxmysql
// too, and each COMPAT_EXPORTS name under its resource, by passing the
// caller's setter on to this resource's own handler.
function provideExports() {
    if (typeof on !== 'function' || typeof emit !== 'function') return;
    const self = GetCurrentResourceName();
    if (!self || self === 'oxmysql') return;
    const alias = (resource, name, target) => {
        const own = '__cfx_export_' + self + '_' + target;
        on('__cfx_export_' + resource + '_' + name, (setCB) => emit(own, setCB));
    };
    const count = GetNumResourceMetadata(self, 'server_export') || 0;
    for (let i = 0; i < count; i++) {
        const name = GetResourceMetadata(self, 'server_export', i);
        if (name) alias('oxmysql', name, name);
    }
    for (const resource of Object.keys(COMPAT_EXPORTS)) {
        for (const [name, target] of Object.entries(COMPAT_EXPORTS[resource])) alias(resource, name, target);
    }
}

// ---- Boot -------------------------------------------------------------------------------------
// Load config, open SQLite, hydrate from MariaDB, start the replica and CDC,
// then mark the engine ready so queued calls run.
async function boot() {
    const t0 = Date.now();
    // The boot clock starts with the resource load, so the load's own work
    // (mysql2, the file open, the pragmas) counts against the first frame.
    bootStepAt = performance.now();
    loadConfig();
    openWakeSocket();
    const modeRaw = (convar('cis_database_mode', '') || (cfg && cfg.profile) || 'durable').toLowerCase();
    storageMode = (modeRaw === 'performance' || modeRaw === 'off' || modeRaw === 'shm') ? 'performance' : 'durable';
    ensureCacheDir();
    const rawDsn = convar('mysql_connection_string', '');
    const dsn = parseDsn(rawDsn);
    bootDsn = dsn;
    dbName = dsn.database || '';
    dialect.setDatabaseName(dbName);
    try {
        mysql2mod = require('mysql2/promise');
    } catch (e1) {
        try {
            mysql2mod = require(path.join(resPath(), 'node_modules', 'mysql2/promise'));
        } catch (e2) {
            mysql2Missing = String((e2 && e2.message) || e2).split('\n')[0];
        }
    }
    if (!rawDsn || !dsn.database) {
        mysql2mod = null;
        mysql2Missing = '';
        log.info('replica disabled: mysql_connection_string unset');
    } else if (!mysql2mod) {
        // MariaDB is configured but its driver is not there, usually a copy of
        // the resource without node_modules/. Starting anyway served whatever
        // SQLite held, an empty file on a fresh cache/, and kept the session's
        // writes from MariaDB. So the engine stays not ready and answers nothing.
        log.error('mysql_connection_string is set but mysql2 does not load, so cis_database answers no query. Copy node_modules/ from the release zip into the cis_database folder, then restart cis_database. (' + mysql2Missing + ')');
        return;
    }
    await bootStep();
    if (mysql2mod && !dsn.ssl && !isLoopbackHost(dsn.host)) {
        log.warn('MariaDB at ' + dsn.host + ' is not on this machine and mysql_connection_string has no ssl option, so game data and the'
            + ' database password cross the network in plain text. Add ?ssl=true (URL form) or ;ssl=true, or keep MariaDB on this machine.');
    }

    const file = hydratePath();
    const hasFile = fs.existsSync(file);
    if (mysql2mod && dsn.database) startReplica(dsn);
    let opened = null;
    if (storageMode === 'durable') {
        const durable = path.join(resPath(), 'cache', 'durable.sqlite');
        // hydrate.sqlite is a snapshot from an earlier boot and can be days old.
        // Hydrate keeps every table SQLite has, so seeding from it with MariaDB
        // configured would serve that old copy for good. With MariaDB, a missing
        // durable file is a first install and is filled from MariaDB instead.
        try {
            if (!fs.existsSync(durable) && hasFile) {
                if (replicaPool) {
                    log.warn('cache/durable.sqlite is missing. Copying every table from MariaDB; the older cache/hydrate.sqlite snapshot is not used.');
                } else {
                    fs.copyFileSync(file, durable);
                    chmodPrivate(durable);
                }
            }
        } catch (e) { /* DatabaseSync creates the file when the copy is absent */ }
        opened = openNodeSqlite(durable);
        if (opened) log.info('backend=node:sqlite file=' + durable);
    } else if (hasFile && !replicaPool) {
        const hot = hotCopy(file);
        opened = openNodeSqlite(hot);
        if (opened) {
            log.info('backend=node:sqlite file=' + hot);
        }
    }
    if (!opened) {
        opened = openNodeSqlite(null);
        if (opened) log.info('backend=node:sqlite :memory:');
    }
    if (!opened) {
        log.warn('Native node:sqlite unavailable, falling back to WebAssembly sql.js');
        const buf = loadHydrateFile();
        opened = await openSqlJs(buf);
        log.info('backend=sql.js bytes=' + (buf ? buf.length : 0));
    }
    backend = opened;
    applyPragmas(backend);
    openInfoSchema(backend);
    await bootStep();
    await dropFileStrictTriggersSliced(backend, bootStepCpu);
    // Before the first write: see openCheckpointDbs.
    await openCheckpointDbs(backend && backend.filePath);
    await refreshAllStrictTriggersSliced(backend, bootStepCpu);
    if (replicaPool) {
        openOutbox(backend);
        if (outboxPending) log.info(outboxPending + ' writes from before the last stop wait in the outbox for MariaDB.');
    }
    if (TRACE) {
        traceBackend(backend);
        startFrameTrace();
    }

    const needHydrate = !!replicaPool || !hasFile || (backend.kind === 'node:sqlite' && backend.filePath === ':memory:' && !hasFile);
    if (needHydrate && mysql2mod) {
        let h = { tables: 0, rows: 0, kept: 0 };
        let copied = false;
        let hadTables = false;
        try { hadTables = sqliteTableCount(backend) > 0; } catch (e) { /* treated as a first install */ }
        bootHydrate = (async () => {
        try {
            h = await hydrateFromMaria(backend, dsn);
            copied = true;
        } catch (e) {
            log.warn('MariaDB did not answer at ' + dsn.host + ':' + dsn.port + '. SQLite stays as it is until the next try. ' + (e && e.message));
        }
        return h;
        })();
        h = await bootHydrate;
        if (copied) {
            log.info('Database initialized: hydrated ' + h.tables + ' tables (' + h.rows + ' rows) into ' + (backend.filePath || 'SQLite') + ', kept ' + h.kept + ' tables with writes waiting and '
                + (h.same || 0) + ' unchanged since the last boot.');
        } else if (hadTables && backend.filePath && backend.filePath !== ':memory:' && !syncCutShort(backend)) {
            // The SQLite file is the source of truth. It already has the game's
            // tables, so the server starts from it and queued writes reach
            // MariaDB when it answers. A database held in memory (sql.js, or
            // node:sqlite without a file) was loaded from the snapshot of an
            // earlier boot and lacks every write since; MariaDB has them, so it
            // waits for MariaDB below like a first install. Starting from the
            // snapshot answered old rows and gave a new row an id MariaDB
            // already had.
            log.warn('Starting from the existing SQLite file without MariaDB. Writes are queued for MariaDB until it answers.');
            // MariaDB may have been edited while the server was stopped. Each
            // table is copied from it once MariaDB answers and has its writes.
            try {
                for (const r of backend.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_\\_cis\\_%' ESCAPE '\\'")) {
                    cdcRecheck.add(String(r.name).toLowerCase());
                }
            } catch (e) { /* CDC records them as hydrate left them */ }
        } else {
            // First install and the connect failed, or a copy was cut short and
            // left a table half full. Keep trying here, before the engine is
            // marked ready, so a caller cannot read an empty or partial table.
            // The waits are timers, not a block on the game thread.
            let wait = 2000;
            while (!shuttingDown && !copied) {
                log.warn('MariaDB has not been copied yet at ' + dsn.host + ':' + dsn.port + '. Next try in ' + wait + ' ms.');
                await new Promise((res) => setTimeout(res, wait));
                if (shuttingDown) break;
                try {
                    h = await hydrateFromMaria(backend, dsn);
                    copied = true;
                    log.info('MariaDB answered. Hydrated ' + h.tables + ' tables (' + h.rows + ' rows).');
                } catch (e) {
                    log.warn('MariaDB still not answering at ' + dsn.host + ':' + dsn.port + '. Retrying. ' + (e && e.message));
                }
                wait = Math.min(wait * 2, 30000);
            }
            bootHydrate = Promise.resolve(h);
        }
        try {
            // A file-backed database is copied off the thread; serialize
            // (node:sqlite on Node 24, sql.js) copies the whole database on
            // it, a hitch that grows with the file.
            const onFile = !!(backend.filePath && backend.filePath !== ':memory:');
            const ser = !onFile && backend.serialize && backend.serialize();
            if (ser && ser.length) {
                fs.writeFileSync(file, Buffer.from(ser), { mode: 0o600 });
                chmodPrivate(file);
                log.info('hydrate snapshot bytes=' + ser.length);
            } else if (backend.filePath && backend.filePath !== ':memory:' && !fs.existsSync(file)) {
                const src = backend.filePath;
                const dest = file;
                setImmediate(() => {
                    fs.promises.copyFile(src, dest).then(() => {
                        chmodPrivate(dest);
                        log.info('hydrate snapshot copied in background from ' + src);
                    }).catch((e) => log.warn('hydrate snapshot copy failed: ' + (e && e.message)));
                });
            } else if (backend.filePath && backend.filePath !== ':memory:') {
                // Hydrate analyzed the tables it copied; the others keep their statistics.
                log.info('hydrate snapshot already present, WAL left for the idle worker');
            } else {
                log.info('hydrate snapshot skipped: serialize returned ' + (ser ? ser.length : 'null'));
            }
        } catch (e) {
            log.warn('hydrate snapshot skip: ' + (e && e.message));
        }
    } else if (hasFile) {
        log.info('hydrate snapshot loaded path=' + (backend.filePath || 'sql.js'));
    }

    dialect.setSchemaProvider((table) => {
        try {
            if (!dialect.identOk(table)) return [];
            return backend.all('PRAGMA table_info("' + String(table).replace(/"/g, '""') + '")', []) || [];
        } catch (e) { return []; }
    }, uniqueKeys, (table) => {
        try {
            return (backend.all('SELECT name FROM pragma_index_list(?)', [table]) || []).map((r) => r.name);
        } catch (e) { return []; }
    });
    // Which text columns compare as utf8mb4_general_ci (dialect.collateGeneralCi)
    // and the collation a new column falls back to.
    dialect.setCollationProvider((table) => {
        const rows = backend.all('SELECT column_name, data_type, collation FROM "' + COLUMN_META + '" WHERE table_name = ?', [table]) || [];
        const own = rows.find((r) => r.column_name === '');
        return { dflt: dbCollation, table: (own && own.collation) || null, cols: rows.filter((r) => r.column_name !== '') };
    });

    // Before the replica and CDC, which write: see preallocWal.
    await startCheckpointWorker(backend && backend.filePath);
    await preallocWal();
    if (!replicaPool) startReplica(dsn);
    // Not awaited: a MariaDB that is down must not hold the boot.
    const reserved = startIdReserve();
    try {
        if (!CDC_ENABLED) throw new Error('disabled by config');
        const { startCdc } = require('./cdc.js');
        // Every row CDC copies is one MariaDB stored, so the strict-mode
        // triggers do not check it again. CDC updates a row in place, and
        // cis_storing() above 0 keeps the ON UPDATE CURRENT_TIMESTAMP
        // triggers from stamping it: the row keeps MariaDB's stamp.
        const cdcBackend = new Proxy(backend, {
            get(t, k) {
                const v = t[k];
                if (typeof v !== 'function') return v;
                return (...a) => {
                    const was = strictOff;
                    strictOff = true;
                    storeDepth = 1;
                    try { return v.apply(t, a); } finally { strictOff = was; storeDepth = 0; }
                };
            },
        });
        cdcHandle = startCdc({
            mysql2mod, dsn, backend: cdcBackend, dialect, dirtyTables,
            pollMs: CDC_POLL_MS,
            dirtyTtlMs: CDC_DIRTY_TTL_MS,
            log,
            debug: () => DEBUG,
            onTable: noteCdcTable,
            pending: (table) => pendingTables.has(table),
            recheck: cdcRecheck,
            txBusy: () => txDepth > 0 || walQuiesce || walFilling || activeQueries > 0 || pendingCount() > 0 || (Date.now() - lastQueryTime) < 2000,
            hardBusy: () => txDepth > 0 || walQuiesce || walFilling,
            forceMs: CDC_FORCE_MS,
            baseline: reserved,
            sums: syncSums,
            onSynced: (table, sum) => queueSyncOp([String(table).toLowerCase(), sum]),
        });
        log.info('Change Data Capture is on (' + storageMode + ').');
    } catch (e) {
        log.info('Change Data Capture is off: ' + (e && e.message));
    }
    hydrateMs = Date.now() - t0;
    lastQueryTime = Date.now();
    const queued = readyWaiters.length;
    log.info('Ready. Backend ' + backend.kind + ', hydrate ' + hydrateMs + ' ms.' + (queued ? ' Running ' + queued + ' calls that arrived before ready, in arrival order.' : ''));
    markEngineReady();
    try {
        const sv = backend.get('SELECT sqlite_version() AS v', []);
        log.info('runtime node=' + process.version + ' v8=' + (process.versions && process.versions.v8) + ' sqlite=' + (sv && (sv.v || sv.V || sv['v'])));
    } catch (e) {
        log.info('runtime node=' + process.version + ' v8=' + (process.versions && process.versions.v8) + ' sqlite=err');
    }
    checkVersion();
}

/**
 * Compare the product version with the latest GitHub release.
 * The manifest version 2.14.3 is the oxmysql compatibility number, so it is
 * not the version being checked. A missing release, a private repo, or a
 * failed request prints nothing. The notes under the warning are the release
 * body, which is filled in when a release is published.
 */
function versionParts(value) {
    const core = String(value || '').trim().replace(/^v/i, '').split('-')[0];
    return core.split('.').map((part) => {
        const n = parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
    });
}

// The text after the first `-` (`beta.1`), or '' for a final release.
function versionPre(value) {
    const s = String(value || '').trim();
    const i = s.indexOf('-');
    return i < 0 ? '' : s.slice(i + 1);
}

function versionOlder(local, remote) {
    const a = versionParts(local);
    const b = versionParts(remote);
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const av = a[i] || 0;
        const bv = b[i] || 0;
        if (av < bv) return true;
        if (av > bv) return false;
    }
    // Same core: a prerelease is older than the final release (semver).
    const ap = versionPre(local);
    const bp = versionPre(remote);
    if (ap === bp) return false;
    if (!ap) return false;
    if (!bp) return true;
    const x = ap.split('.');
    const y = bp.split('.');
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if (x[i] === undefined) return true;
        if (y[i] === undefined) return false;
        const xn = /^\d+$/.test(x[i]);
        const yn = /^\d+$/.test(y[i]);
        if (xn && yn) {
            const d = parseInt(x[i], 10) - parseInt(y[i], 10);
            if (d !== 0) return d < 0;
        } else if (xn !== yn) {
            return xn;
        } else if (x[i] !== y[i]) {
            return x[i] < y[i];
        }
    }
    return false;
}

function checkVersion() {
    const local = (typeof GetResourceMetadata === 'function')
        ? (GetResourceMetadata(GetCurrentResourceName(), 'cis_version', 0) || '')
        : '';
    if (!local) return;
    let https;
    try { https = require('https'); } catch (e) { return; }
    const req = https.get({
        host: 'api.github.com',
        path: '/repos/cisoko-net/cis_database/releases/latest',
        headers: {
            'User-Agent': 'cis_database',
            'Accept': 'application/vnd.github+json',
        },
        timeout: 8000,
    }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
            size += chunk.length;
            if (size > 65536) {
                res.destroy();
                return;
            }
            chunks.push(chunk);
        });
        res.on('end', () => {
            if (res.statusCode !== 200) return;
            let body;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return; }
            const remote = body && (body.tag_name || body.name);
            if (!remote || !versionOlder(local, remote)) return;
            log.warn('cis_database ' + local + ' is outdated. Latest release is ' + remote + '.');
            log.warn('https://github.com/cisoko-net/cis_database/releases/latest');
            const notes = String(body.body || '').trim();
            if (!notes) {
                log.info('No release notes were published for ' + remote + '.');
                return;
            }
            log.info('What is new in ' + remote + ':');
            notes.split(/\r?\n/).forEach((line) => log.info(line));
        });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => {});
}

exportAll();
boot().catch((e) => {
    log.error('FATAL boot: ' + (e && e.stack ? e.stack : e));
});
