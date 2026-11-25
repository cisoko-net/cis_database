'use strict';

// Translates the MySQL that scripts send into SQLite. Each distinct
// statement is translated once; every later call with the same text is a
// Map lookup.
//
// This is the SQL front end of cis_database. server.js calls translate() for
// every statement and runs the result on SQLite; the original MySQL text is
// what the MariaDB replica receives, so a translation only has to be right
// for SQLite. The rules that hold throughout:
//   - rewrites run on code chunks only, never inside string literals or
//     comments (mapCode, mapOutsideStrings);
//   - a rewrite that moves or repeats an expression holding a ? rebinds the
//     placeholders, so parameter count and order survive;
//   - a form with no exact SQLite equivalent is left alone or refused, so the
//     caller sees an error instead of a result that differs from MariaDB's.
//
// Layout: schema providers and statement classification (top), string and
// token handling, function and date rewrites, collation-aware ORDER BY,
// JOIN/UPDATE/DELETE/INSERT rewrites, CREATE/ALTER/DROP translation and the
// triggers that emulate MySQL column behaviour, information_schema views,
// SHOW, translate() itself, and last the SQL functions server.js registers
// on each SQLite connection.
const { generalCiKey, unicodeCiKey } = require('./collation.js');

const cache = new Map();
const schemaCache = Object.create(null);
const MAX_CACHE = 4096;
const MAX_SQL_LEN = 262144;
const FORBIDDEN_KEYS = Object.create(null);
FORBIDDEN_KEYS.__proto__ = true;
FORBIDDEN_KEYS.constructor = true;
FORBIDDEN_KEYS.prototype = true;
let schemaProvider = null;
let uniqueProvider = null;
let indexProvider = null;
let collationProvider = null;
// The configured database (server.js), for SHOW TABLES' Tables_in_<db>.
let databaseName = '';

function identOk(name) {
    return typeof name === 'string' && name.length > 0 && name.length < 128
        && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)
        && !FORBIDDEN_KEYS[name.toLowerCase()];
}

const SQL_WORDS = Object.create(null);
['select', 'from', 'where', 'and', 'or', 'not', 'into', 'update', 'delete', 'insert',
    'set', 'values', 'table', 'join', 'inner', 'left', 'right', 'on', 'as', 'with',
    'replace', 'ignore', 'duplicate', 'key', 'alter', 'create', 'drop', 'index'].forEach((w) => { SQL_WORDS[w] = true; });

function extractTables(sql) {
    const out = [];
    const seen = Object.create(null);
    const re = /\b(?:INTO|UPDATE|FROM|TABLE|JOIN)\s+["`]?([A-Za-z_][A-Za-z0-9_]*)/gi;
    let m;
    // CREATE TABLE IF NOT EXISTS t: the name is t, not IF.
    const s = String(sql || '').replace(/\bIF\s+(?:NOT\s+)?EXISTS\b/gi, ' ');
    while ((m = re.exec(s))) {
        const name = m[1];
        if (!identOk(name) || SQL_WORDS[name.toLowerCase()]) continue;
        const key = name.toLowerCase();
        if (seen[key]) continue;
        seen[key] = true;
        out.push(key);
    }
    return out;
}

function identQuote(name) {
    if (!identOk(name)) return null;
    return '"' + name.replace(/"/g, '""') + '"';
}

function rememberColumns(table, cols) {
    if (!identOk(table) || !cols || !cols.length) return;
    const k = String(table).toLowerCase();
    const prev = schemaCache[k] || [];
    const seen = Object.create(null);
    const out = [];
    for (const c of prev.concat(cols)) {
        const n = String(c || '').trim();
        if (!n) continue;
        const lk = n.toLowerCase();
        if (seen[lk]) continue;
        seen[lk] = true;
        out.push(n);
    }
    schemaCache[k] = out;
}

// ---- Schema access ----------------------------------------------------------
// server.js supplies the live schema; translations that depend on column
// lists or unique keys ask for it through these providers. setDatabaseName
// sets the name SHOW TABLES reports. setSchemaProvider(fn, uniqueFn) takes:
//   fn(table): the table's columns (PRAGMA table_info rows)
//   uniqueFn(table): column sets with a PRIMARY KEY or UNIQUE index, null when
//     the table does not exist
//   indexFn(table): the SQLite names of the table's indexes
function setDatabaseName(name) {
    databaseName = String(name || '');
}

function setSchemaProvider(fn, uniqueFn, indexFn) {
    schemaProvider = typeof fn === 'function' ? fn : null;
    uniqueProvider = typeof uniqueFn === 'function' ? uniqueFn : null;
    indexProvider = typeof indexFn === 'function' ? indexFn : null;
}

// A translation can depend on the tables as they were (collateText
// reads their columns), so a schema change forgets them all.
function forgetSchema() {
    cache.clear();
}

// The remembered column list of a table whose columns moved (ALTER ... FIRST /
// AFTER x); the next read takes the order from the live schema.
function forgetColumns(table) {
    if (identOk(table)) delete schemaCache[String(table).toLowerCase()];
}

function columnMeta(table) {
    if (!identOk(table) || !schemaProvider) return [];
    try { return schemaProvider(table) || []; } catch (e) { return []; }
}

function tableColumns(table) {
    if (!identOk(table)) return null;
    const k = String(table).toLowerCase();
    if (schemaCache[k] && schemaCache[k].length) return schemaCache[k];
    if (!schemaProvider) return null;
    try {
        const rows = schemaProvider(table) || [];
        const cols = [];
        for (let i = 0; i < rows.length; i++) {
            const name = rows[i] && (rows[i].name || rows[i].Name || rows[i].column_name);
            if (name) cols.push(String(name));
        }
        if (cols.length) rememberColumns(table, cols);
        return schemaCache[k] || cols;
    } catch (e) {
        return null;
    }
}

// ---- Statement classification --------------------------------------------------
// First keyword, read/write verdict and the PRAGMA allow-list that decide how
// server.js runs a statement and whether it is replicated.
function firstKeyword(sql) {
    if (!sql) return '';
    const s = String(sql);
    let i = 0;
    const n = s.length;
    while (i < n) {
        const c = s.charCodeAt(i);
        if (c <= 32) { i++; continue; }
        if (c === 45 && s.charCodeAt(i + 1) === 45 && dashComment(s, i)) {
            while (i < n && s.charCodeAt(i) !== 10) i++;
            continue;
        }
        if (c === 35) {
            while (i < n && s.charCodeAt(i) !== 10) i++;
            continue;
        }
        if (c === 47 && s.charCodeAt(i + 1) === 42) {
            i += 2;
            while (i < n && !(s.charCodeAt(i) === 42 && s.charCodeAt(i + 1) === 47)) i++;
            i += 2;
            continue;
        }
        if (c === 40 || c === 41) { i++; continue; }
        break;
    }
    let j = i;
    while (j < n) {
        const c = s.charCodeAt(j);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) j++;
        else break;
    }
    return s.slice(i, j).toUpperCase();
}

const PRAGMA_ALLOW = Object.create(null);
PRAGMA_ALLOW.table_info = true;
PRAGMA_ALLOW.table_xinfo = true;
PRAGMA_ALLOW.index_info = true;
PRAGMA_ALLOW.index_xinfo = true;
PRAGMA_ALLOW.index_list = true;
PRAGMA_ALLOW.foreign_key_list = true;
PRAGMA_ALLOW.database_list = true;
PRAGMA_ALLOW.wal_checkpoint = true;

function pragmaName(sql) {
    const s = String(sql || '').trimStart();
    const m = s.match(/^PRAGMA\s+(?:(?:"[^"]+"|[A-Za-z0-9_]+)\.)?([A-Za-z0-9_]+)/i);
    return m ? m[1].toLowerCase() : '';
}

function isPragmaAllowed(sql) {
    const name = pragmaName(sql);
    return !!(name && PRAGMA_ALLOW[name]);
}

function cteTerminalKeyword(sql) {
    const s = String(sql || '');
    let i = 0;
    const n = s.length;
    function skip() {
        while (i < n) {
            const c = s.charCodeAt(i);
            if (c <= 32) { i++; continue; }
            if (c === 45 && s.charCodeAt(i + 1) === 45 && dashComment(s, i)) {
                while (i < n && s.charCodeAt(i) !== 10) i++;
                continue;
            }
            if (c === 35) {
                while (i < n && s.charCodeAt(i) !== 10) i++;
                continue;
            }
            if (c === 47 && s.charCodeAt(i + 1) === 42) {
                i += 2;
                while (i < n && !(s.charCodeAt(i) === 42 && s.charCodeAt(i + 1) === 47)) i++;
                i += 2;
                continue;
            }
            break;
        }
    }
    function ident() {
        skip();
        if (s[i] === '"' || s[i] === '`' || s[i] === '[') {
            const q = s[i] === '[' ? ']' : s[i];
            i++;
            while (i < n && s[i] !== q) i++;
            if (i < n) i++;
            return 'IDENT';
        }
        let j = i;
        while (j < n) {
            const c = s.charCodeAt(j);
            if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || (c >= 48 && c <= 57)) j++;
            else break;
        }
        const w = s.slice(i, j).toUpperCase();
        i = j;
        return w;
    }
    function skipBalanced() {
        skip();
        if (s[i] !== '(') return;
        let depth = 1;
        let q = null;
        i++;
        while (i < n && depth > 0) {
            const c = s[i];
            if (q) {
                if (c === '\\') { i += 2; continue; }
                if (c === q && s[i + 1] === q) { i += 2; continue; }
                if (c === q) { q = null; i++; continue; }
                i++;
                continue;
            }
            if (c === "'" || c === '"' || c === '`') { q = c; i++; continue; }
            if (c === '(') depth++;
            else if (c === ')') depth--;
            i++;
        }
    }
    skip();
    if (ident() !== 'WITH') return firstKeyword(s);
    skip();
    const mark = i;
    if (ident() !== 'RECURSIVE') i = mark;
    while (i < n) {
        ident();
        skip();
        if (s[i] === '(') skipBalanced();
        skip();
        if (ident() !== 'AS') break;
        skipBalanced();
        skip();
        if (s[i] === ',') { i++; continue; }
        return ident() || 'WITH';
    }
    return 'WITH';
}

function writeKeyword(sql) {
    const kw = firstKeyword(sql);
    if (kw === 'WITH') return cteTerminalKeyword(sql);
    return kw;
}

function isWriteStatement(sql) {
    return isWrite(writeKeyword(sql));
}

// ---- Quoting and string literals -----------------------------------------------
// MySQL quotes (backticks, backslash escapes, double-quoted strings) become
// SQLite's; mapCode and mapOutsideStrings then hand rewrites only the code
// between literals.
function stripTicks(sql) {
    let out = '';
    let i = 0;
    const n = sql.length;
    while (i < n) {
        const c = sql[i];
        if (c === '`') {
            out += '"';
            i++;
            while (i < n) {
                if (sql[i] === '`') {
                    if (sql[i + 1] === '`' && sql[i + 2] === '`') { out += '`'; i += 3; continue; }
                    if (sql[i + 1] === '`') { out += '`'; i += 2; continue; }
                    out += '"';
                    i++;
                    break;
                }
                if (sql[i] === '"') { out += '""'; i++; continue; }
                out += sql[i];
                i++;
            }
            continue;
        }
        if (c === "'" || c === '"') {
            const q = c;
            out += c;
            i++;
            while (i < n) {
                if (sql[i] === q && sql[i + 1] === q) { out += q + q; i += 2; continue; }
                if (sql[i] === q) { out += q; i++; break; }
                out += sql[i];
                i++;
            }
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

// MySQL backslash escapes. \% and \_ keep their backslash (MySQL does, for
// LIKE); any other escaped character stands for itself.
const MYSQL_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', Z: '\x1a', '%': '\\%', _: '\\_' };

function rewriteMysqlStrings(sql) {
    if (sql.indexOf('\\') < 0 && sql.indexOf('"') < 0 && sql.indexOf('#') < 0) return sql;
    let out = '';
    let i = 0;
    const n = sql.length;
    while (i < n) {
        const c = sql[i];
        if (c === '-' && sql[i + 1] === '-' && dashComment(sql, i)) {
            while (i < n && sql[i] !== '\n') { out += sql[i]; i++; }
            continue;
        }
        if (c === '#' && (i === 0 || sql.charCodeAt(i - 1) <= 32)) {
            out += '--';
            i++;
            while (i < n && sql[i] !== '\n') { out += sql[i]; i++; }
            continue;
        }
        if (c === '/' && sql[i + 1] === '*') {
            out += '/*';
            i += 2;
            while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) { out += sql[i]; i++; }
            if (i < n) { out += '*/'; i += 2; }
            continue;
        }
        // In MySQL both '...' and "..." are strings: WHERE job = "police"
        // compares with the text police, never with a column of that name.
        // Both become SQLite '...' with MySQL's escapes resolved.
        if (c === "'" || c === '"') {
            let body = '';
            i++;
            while (i < n) {
                if (sql[i] === '\\' && i + 1 < n) {
                    const nx = sql[i + 1];
                    if (nx === '0') throw new Error('cis_database: \\0 (a NUL byte) in a string literal; pass the value as a parameter');
                    body += MYSQL_ESCAPES[nx] !== undefined ? MYSQL_ESCAPES[nx] : nx;
                    i += 2;
                    continue;
                }
                if (sql[i] === c) {
                    if (sql[i + 1] === c) { body += c; i += 2; continue; }
                    i++;
                    break;
                }
                body += sql[i];
                i++;
            }
            out += "'" + body.replace(/'/g, "''") + "'";
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

// Calls fn on each stretch of code outside quotes and comments. Caller SQL
// is MySQL text, where a backslash escapes the next character; translated
// SQL (sqliteText) has no escapes, so 'C:\' ends at its second quote.
// MySQL's rule: '--' at i opens a comment only when a space, a control
// character or the end of the text follows it.
function dashComment(sql, i) {
    return i + 2 >= sql.length || sql.charCodeAt(i + 2) <= 32;
}

function mapCode(sql, fn, sqliteText) {
    let out = '';
    let i = 0;
    const n = sql.length;
    while (i < n) {
        const c = sql[i];
        if (c === "'" || c === '"' || c === '`') {
            const q = c;
            out += c;
            i++;
            while (i < n) {
                if (sql[i] === '\\' && !sqliteText) { out += sql[i] + (sql[i + 1] || ''); i += 2; continue; }
                if (sql[i] === q && sql[i + 1] === q) { out += q + q; i += 2; continue; }
                if (sql[i] === q) { out += q; i++; break; }
                out += sql[i];
                i++;
            }
            continue;
        }
        if (c === '-' && sql[i + 1] === '-' && (sqliteText || dashComment(sql, i))) {
            while (i < n && sql[i] !== '\n') { out += sql[i]; i++; }
            continue;
        }
        if (c === '#' && (!sqliteText || i === 0 || sql.charCodeAt(i - 1) <= 32)) {
            out += '--';
            i++;
            while (i < n && sql[i] !== '\n') { out += sql[i]; i++; }
            continue;
        }
        if (c === '/' && sql[i + 1] === '*') {
            out += '/*';
            i += 2;
            while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) { out += sql[i]; i++; }
            if (i < n) { out += '*/'; i += 2; }
            continue;
        }
        let j = i + 1;
        while (j < n) {
            const d = sql[j];
            if (d === "'" || d === '"' || d === '`' || (d === '/' && sql[j + 1] === '*')) break;
            if (d === '-' && sql[j + 1] === '-' && (sqliteText || dashComment(sql, j))) break;
            if (d === '#' && (!sqliteText || sql.charCodeAt(j - 1) <= 32)) break;
            j++;
        }
        // A '--' left in caller text is two minus signs (1--1); SQLite would
        // read it as a comment without the space.
        const chunk = sql.slice(i, j);
        out += fn(sqliteText || chunk.indexOf('--') < 0 ? chunk : chunk.replace(/-(?=-)/g, '- '));
        i = j;
    }
    return out;
}

// Calls fn on each stretch of SQL outside string literals and comments.
// In caller MySQL text (mysql) '...' and "..." are literals with backslash
// escapes; in translated SQL only '...' is, with no escapes. Quoted
// identifiers stay inside the stretch, so a rewrite still sees "t".col.
function mapOutsideStrings(sql, fn, mysql) {
    let out = '';
    let start = 0;
    let i = 0;
    const n = sql.length;
    while (i < n) {
        const c = sql[i];
        const lit = c === "'" || (mysql && c === '"');
        const ident = !lit && (c === '"' || c === '`');
        if (!lit && !ident && !(c === '-' && sql[i + 1] === '-') && !(c === '/' && sql[i + 1] === '*')
            && !(mysql && c === '#')) {
            i++;
            continue;
        }
        let j = i + 1;
        if (lit || ident) {
            while (j < n) {
                if (lit && mysql && sql[j] === '\\') { j += 2; continue; }
                if (sql[j] === c) {
                    if (sql[j + 1] === c) { j += 2; continue; }
                    j++;
                    break;
                }
                j++;
            }
            if (ident) { i = Math.min(j, n); continue; }
        } else if (c === '/') {
            const e = sql.indexOf('*/', i + 2);
            j = e < 0 ? n : e + 2;
        } else {
            while (j < n && sql[j] !== '\n') j++;
        }
        j = Math.min(j, n);
        if (i > start) out += fn(sql.slice(start, i));
        out += sql.slice(i, j);
        i = j;
        start = j;
    }
    if (n > start) out += fn(sql.slice(start));
    return out;
}

// ---- Token-level function rewrites ------------------------------------------------
// MySQL functions whose arguments matter (DATE_ADD, DATEDIFF, DATE_FORMAT,
// INTERVAL arithmetic...) are rewritten on tokens of the translated SQL, so
// an argument that holds a string literal or a nested call is taken whole,
// and nothing inside a literal is ever touched. A call that has no exact
// SQLite form is left as it is: SQLite then refuses it, a read is answered
// by MariaDB, and a write fails for its caller instead of storing something
// MariaDB would not.

const isWordStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c === 64 || c > 127;
const isWordPart = (c) => isWordStart(c) || (c >= 48 && c <= 57);

function lexSql(s) {
    const toks = [];
    const n = s.length;
    let i = 0;
    while (i < n) {
        const c = s.charCodeAt(i);
        let j = i + 1;
        let k;
        if (c === 39 || c === 34 || c === 96) {
            while (j < n) {
                if (s.charCodeAt(j) === c) {
                    if (s.charCodeAt(j + 1) === c) { j += 2; continue; }
                    j++;
                    break;
                }
                j++;
            }
            k = c === 39 ? 'str' : 'id';
        } else if (c <= 32) {
            while (j < n && s.charCodeAt(j) <= 32) j++;
            k = 'ws';
        } else if (c === 45 && s.charCodeAt(i + 1) === 45 && dashComment(s, i)) {
            while (j < n && s.charCodeAt(j) !== 10) j++;
            k = 'ws';
        } else if (c === 47 && s.charCodeAt(i + 1) === 42) {
            const e = s.indexOf('*/', i + 2);
            j = e < 0 ? n : e + 2;
            k = 'ws';
        } else if (isWordStart(c)) {
            while (j < n && isWordPart(s.charCodeAt(j))) j++;
            k = 'word';
        } else if (c >= 48 && c <= 57) {
            while (j < n && (isWordPart(s.charCodeAt(j)) || s.charCodeAt(j) === 46)) j++;
            k = 'num';
        } else if (c === 63) {
            k = 'param';
        } else if (c === 40) {
            k = 'lp';
        } else if (c === 41) {
            k = 'rp';
        } else if (c === 44) {
            k = 'comma';
        } else {
            k = 'op';
            if (c === 45 && s.charCodeAt(i + 1) === 62) j = s.charCodeAt(i + 2) === 62 ? i + 3 : i + 2;
        }
        toks.push({ k, v: s.slice(i, j) });
        i = j;
    }
    return toks;
}

// Words that are never an operand or the name of a call.
const KEYWORDS = new Set(['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'ON', 'AS', 'SET',
    'VALUES', 'VALUE', 'WHEN', 'THEN', 'ELSE', 'CASE', 'END', 'EXISTS', 'JOIN', 'BY', 'HAVING', 'LIKE',
    'BETWEEN', 'RETURNING', 'USING', 'INTO', 'LIMIT', 'OFFSET', 'UNION', 'ALL', 'ANY', 'DISTINCT', 'GROUP',
    'ORDER', 'UPDATE', 'DELETE', 'INSERT', 'REPLACE', 'INTERVAL', 'ESCAPE', 'OVER', 'FILTER', 'WITH',
    'COLLATE', 'GLOB', 'REGEXP', 'MATCH', 'DESC', 'ASC', 'DO', 'CONFLICT', 'IGNORE', 'INNER', 'LEFT',
    'RIGHT', 'CROSS', 'OUTER', 'NATURAL', 'DIV']);

// SQLite modifier unit and multiplier for each MySQL INTERVAL unit.
const INTERVAL_UNITS = {
    SECOND: ['seconds', 1], MINUTE: ['minutes', 1], HOUR: ['hours', 1], DAY: ['days', 1],
    WEEK: ['days', 7], MONTH: ['months', 1], QUARTER: ['months', 3], YEAR: ['years', 1],
};

function makeInterval(unitName, lit, text) {
    const unit = INTERVAL_UNITS[String(unitName).toUpperCase()];
    if (!unit) return null;
    return { lit, text, unit: unit[0], mult: unit[1], days: unit[0] === 'days' || unit[0] === 'months' || unit[0] === 'years' };
}

function nextSolid(ctx, i, to) {
    while (i < to && ctx.toks[i].k === 'ws') i++;
    return i;
}

function lastSolid(atoms) {
    let p = atoms.length - 1;
    while (p >= 0 && atoms[p].k === 'ws') p--;
    return p;
}

function pushVal(atoms, text, tok) {
    // t.col and "t"."col" are one operand.
    const n = atoms.length;
    if (tok && n >= 2 && atoms[n - 1].t === '.' && atoms[n - 2].k === 'val') {
        atoms.splice(n - 2, 2, { k: 'val', t: atoms[n - 2].t + '.' + text });
        return;
    }
    atoms.push({ k: 'val', t: text });
}

function hasParam(ctx, arg) {
    for (let i = arg.a; i < arg.b; i++) if (ctx.toks[i].k === 'param') return true;
    return false;
}

function soleToken(ctx, arg) {
    const i = nextSolid(ctx, arg.a, arg.b);
    if (i >= arg.b || nextSolid(ctx, i + 1, arg.b) !== arg.b) return null;
    return ctx.toks[i];
}

// INTERVAL <amount> <unit> starting at token i. The amount is an integer
// (or a quoted one), ?, a column, a call or a parenthesised expression.
function parseInterval(ctx, i, to) {
    const toks = ctx.toks;
    let j = nextSolid(ctx, i + 1, to);
    if (j >= to) return null;
    let neg = false;
    if (toks[j].k === 'op' && toks[j].v === '-') {
        neg = true;
        j = nextSolid(ctx, j + 1, to);
        if (j >= to) return null;
    }
    const t = toks[j];
    let lit = null;
    let text = null;
    let end = j + 1;
    if (t.k === 'num' && /^\d+$/.test(t.v)) {
        lit = Number(t.v) * (neg ? -1 : 1);
    } else if (t.k === 'str' && /^'-?\d+'$/.test(t.v)) {
        lit = Number(t.v.slice(1, -1)) * (neg ? -1 : 1);
    } else if (neg) {
        return null;
    } else if (t.k === 'param' || t.k === 'id') {
        text = t.v;
    } else if (t.k === 'word' && !KEYWORDS.has(t.v.toUpperCase())) {
        while (end + 1 < to && toks[end].v === '.' && (toks[end + 1].k === 'word' || toks[end + 1].k === 'id')) end += 2;
        if (end < to && toks[end].k === 'lp' && ctx.match[end] > end && ctx.match[end] < to) end = ctx.match[end] + 1;
        text = transformRange(ctx, j, end);
    } else if (t.k === 'lp' && ctx.match[j] > j && ctx.match[j] < to) {
        end = ctx.match[j] + 1;
        text = transformRange(ctx, j, end);
    } else {
        return null;
    }
    const u = nextSolid(ctx, end, to);
    if (u >= to || toks[u].k !== 'word') return null;
    const iv = makeInterval(toks[u].v.replace(/s$/i, ''), lit, text);
    if (!iv) return null;
    iv.end = u + 1;
    return iv;
}

// base shifted by an interval: DATE_ADD, DATE_SUB, base + INTERVAL ...
function dateShift(base, sign, iv) {
    let mod;
    if (iv.lit != null) {
        const v = (sign === '-' ? -iv.lit : iv.lit) * iv.mult;
        mod = "'" + (v < 0 ? '' : '+') + v + ' ' + iv.unit + "'";
    } else {
        mod = '(' + (sign === '-' ? '-' : '') + '(' + iv.text + ')' + (iv.mult !== 1 ? ' * ' + iv.mult : '') + ") || ' " + iv.unit + "'";
    }
    // MySQL keeps a DATE a DATE when whole days are added to it.
    const dateOnly = iv.days && /^(?:CURDATE\(\s*\)|CURRENT_DATE(?:\(\s*\))?|UTC_DATE\(\s*\)|date\('now'(?:,\s*'localtime')?\)|'\d{4}-\d{2}-\d{2}')$/i.test(base.trim());
    return (dateOnly ? 'date(' : 'datetime(') + base + ', ' + mod + ')';
}

function intervalArg(ctx, arg) {
    const i = nextSolid(ctx, arg.a, arg.b);
    if (i >= arg.b || ctx.toks[i].k !== 'word' || ctx.toks[i].v.toUpperCase() !== 'INTERVAL') return null;
    const iv = parseInterval(ctx, i, arg.b);
    return iv && nextSolid(ctx, iv.end, arg.b) === arg.b ? iv : null;
}

function dateShiftRule(sign, plainDays) {
    return (args, ctx) => {
        if (args.length !== 2) return null;
        let iv = intervalArg(ctx, args[1]);
        // ADDDATE(d, n) and SUBDATE(d, n) count days.
        if (!iv && plainDays) {
            const t = soleToken(ctx, args[1]);
            if (t && t.k === 'num' && /^\d+$/.test(t.v)) iv = makeInterval('DAY', Number(t.v), null);
            else if (t && t.k === 'param') iv = makeInterval('DAY', null, '?');
        }
        return iv ? dateShift(args[0].text, sign, iv) : null;
    };
}

// MySQL DATE_FORMAT specifiers SQLite's strftime prints the same way.
const FMT_SAME = { Y: '%Y', m: '%m', d: '%d', H: '%H', h: '%I', I: '%I', i: '%M', s: '%S', S: '%S', j: '%j', w: '%w', p: '%p', T: '%H:%M:%S', r: '%I:%M:%S %p', '%': '%%' };
// Unpadded forms; SQLite pads them with a space, so they are cast instead.
const FMT_NOPAD = { c: '%m', e: '%d', k: '%H', l: '%I' };
// Month and weekday names in MariaDB's default lc_time_names (en_US), and the
// two-digit year. Each is an expression over the date.
const caseOf = (spec, names, from) => (base) => "CASE strftime('" + spec + "', " + base + ')'
    + names.map((n, i) => " WHEN '" + String(i + from).padStart(spec === '%m' ? 2 : 1, '0') + "' THEN '" + n + "'").join('') + ' END';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FMT_EXPR = {
    M: caseOf('%m', MONTHS, 1),
    b: caseOf('%m', MONTHS.map((n) => n.slice(0, 3)), 1),
    W: caseOf('%w', WEEKDAYS, 0),
    a: caseOf('%w', WEEKDAYS.map((n) => n.slice(0, 3)), 0),
    y: (base) => "substr(strftime('%Y', " + base + '), 3)',
};

function dateFormat(base, fmtTok, noRepeat) {
    if (!fmtTok || fmtTok.k !== 'str') return null;
    const fmt = fmtTok.v.slice(1, -1).replace(/''/g, "'");
    const parts = [];
    let lit = '';
    for (let i = 0; i < fmt.length; i++) {
        const c = fmt[i];
        if (c !== '%' || i + 1 >= fmt.length) {
            lit += c;
            continue;
        }
        const f = fmt[++i];
        if (FMT_SAME[f]) {
            lit += FMT_SAME[f];
        } else if (FMT_NOPAD[f]) {
            if (lit) parts.push(lit);
            lit = '';
            parts.push({ nopad: FMT_NOPAD[f] });
        } else if (FMT_EXPR[f]) {
            if (lit) parts.push(lit);
            lit = '';
            parts.push({ expr: FMT_EXPR[f] });
        } else if (/[A-Za-z]/.test(f)) {
            // Day-of-month suffixes, week numbers, microseconds: no strftime form.
            return null;
        } else {
            lit += f;
        }
    }
    if (lit) parts.push(lit);
    const q = (x) => "'" + x.replace(/'/g, "''") + "'";
    if (parts.every((p) => typeof p === 'string')) return 'strftime(' + q(parts.join('')) + ', ' + base + ')';
    // The date is repeated once per piece; a ? in it would bind twice.
    if (noRepeat) return null;
    return '(' + parts.map((p) => (typeof p === 'string'
        ? 'strftime(' + q(p) + ', ' + base + ')'
        : p.expr ? p.expr(base)
            : "CAST(strftime('" + p.nopad + "', " + base + ') AS INTEGER)')).join(' || ') + ')';
}

// MariaDB's clock reads the server's local time (time_zone SYSTEM), and the
// DATETIME text it stores and hydration copies is local wall-clock time.
// SQLite's 'now' is UTC; the 'localtime' modifier gives the same text
// MariaDB would.
const LOCAL_NOW = "datetime('now', 'localtime')";
const LOCAL_DATE = "date('now', 'localtime')";
const LOCAL_TIME = "time('now', 'localtime')";
const CLOCK_SQL = { CURRENT_TIMESTAMP: LOCAL_NOW, CURRENT_DATE: LOCAL_DATE, CURRENT_TIME: LOCAL_TIME };
// A default as ddlDefault spells it (CURRENT_TIMESTAMP, a literal, an
// expression), as SQL that runs on the local clock.
const clockSql = (d) => CLOCK_SQL[d] || d;

const strftimeInt = (spec) => (args) => (args.length === 1 ? "CAST(strftime('" + spec + "', " + args[0].text + ') AS INTEGER)' : null);
// Seconds since the epoch of a local date and time, as MariaDB's
// UNIX_TIMESTAMP(x) reads it.
const unixSeconds = (x) => "CAST(strftime('%s', " + x + ", 'utc') AS INTEGER)";
const DIFF_SECONDS = { SECOND: 1, MINUTE: 60, HOUR: 3600, DAY: 86400, WEEK: 604800 };

const FN_RULES = {
    DATE_ADD: dateShiftRule('+', false),
    DATE_SUB: dateShiftRule('-', false),
    ADDDATE: dateShiftRule('+', true),
    SUBDATE: dateShiftRule('-', true),
    TIMESTAMPADD(args, ctx) {
        if (args.length !== 3) return null;
        // The amount comes before the date; with a ? in both they would swap.
        if (hasParam(ctx, args[1]) && hasParam(ctx, args[2])) return null;
        const n = args[1].text;
        const iv = /^-?\d+$/.test(n) ? makeInterval(args[0].text, Number(n), null) : makeInterval(args[0].text, null, n);
        return iv ? dateShift(args[2].text, '+', iv) : null;
    },
    // Whole days between the two dates; the times do not count.
    DATEDIFF: (args) => (args.length === 2 ? 'CAST(julianday(date(' + args[0].text + ')) - julianday(date(' + args[1].text + ')) AS INTEGER)' : null),
    // Whole units, truncated toward zero. The first date is written first so
    // its ? still binds first.
    TIMESTAMPDIFF(args) {
        if (args.length !== 3) return null;
        const div = DIFF_SECONDS[args[0].text.toUpperCase()];
        if (!div) return null;
        // Wall-clock difference, as MariaDB takes it for DATETIME.
        const wall = (x) => "CAST(strftime('%s', " + x + ') AS INTEGER)';
        const secs = '(-' + wall(args[1].text) + ' + ' + wall(args[2].text) + ')';
        return div === 1 ? secs : '(' + secs + ' / ' + div + ')';
    },
    UNIX_TIMESTAMP: (args) => (args.length === 0 ? "CAST(strftime('%s', 'now') AS INTEGER)" : args.length === 1 ? unixSeconds(args[0].text) : null),
    FROM_UNIXTIME(args, ctx) {
        if (args.length === 1) return 'datetime(' + args[0].text + ", 'unixepoch', 'localtime')";
        if (args.length === 2) return dateFormat('datetime(' + args[0].text + ", 'unixepoch', 'localtime')", soleToken(ctx, args[1]), hasParam(ctx, args[0]));
        return null;
    },
    DATE_FORMAT: (args, ctx) => (args.length === 2 ? dateFormat(args[0].text, soleToken(ctx, args[1]), hasParam(ctx, args[0])) : null),
    STR_TO_DATE(args, ctx) {
        if (args.length !== 2) return null;
        const t = soleToken(ctx, args[1]);
        const fmt = t && t.k === 'str' ? t.v.slice(1, -1) : '';
        if (fmt === '%Y-%m-%d') return 'date(' + args[0].text + ')';
        if (/^%Y-%m-%d (?:%H:%i(?::%[sS])?|%T)$/.test(fmt)) return 'datetime(' + args[0].text + ')';
        return null;
    },
    YEAR: strftimeInt('%Y'),
    MONTH: strftimeInt('%m'),
    DAY: strftimeInt('%d'),
    DAYOFMONTH: strftimeInt('%d'),
    HOUR: strftimeInt('%H'),
    MINUTE: strftimeInt('%M'),
    SECOND: strftimeInt('%S'),
    TIME_TO_SEC(args, ctx) {
        if (args.length !== 1 || hasParam(ctx, args[0])) return null;
        const x = args[0].text;
        return "(strftime('%s', " + x + ") - strftime('%s', date(" + x + ')))';
    },
    LEFT: (args) => (args.length === 2 ? 'substr(' + args[0].text + ', 1, ' + args[1].text + ')' : null),
    RIGHT(args, ctx) {
        if (args.length !== 2) return null;
        const n = args[1].text;
        return 'substr(' + args[0].text + ', -(' + n + ')' + (hasParam(ctx, args[1]) ? '' : ', ' + n) + ')';
    },
    // instr takes its arguments the other way round.
    LOCATE: (args, ctx) => (args.length === 2 && !(hasParam(ctx, args[0]) && hasParam(ctx, args[1])) ? 'instr(' + args[1].text + ', ' + args[0].text + ')' : null),
    MOD: (args) => (args.length === 2 ? '((' + args[0].text + ') % (' + args[1].text + '))' : null),
    ISNULL: (args) => (args.length === 1 ? '((' + args[0].text + ') IS NULL)' : null),
    LCASE: (args) => (args.length === 1 ? 'lower(' + args[0].text + ')' : null),
    UCASE: (args) => (args.length === 1 ? 'upper(' + args[0].text + ')' : null),
    CHAR_LENGTH: (args) => (args.length === 1 ? 'length(' + args[0].text + ')' : null),
    CHARACTER_LENGTH: (args) => (args.length === 1 ? 'length(' + args[0].text + ')' : null),
    LAST_DAY: (args) => (args.length === 1 ? 'date(' + args[0].text + ", 'start of month', '+1 month', '-1 day')" : null),
    // LAST_INSERT_ID(expr) returns expr and makes it the insert id, as MariaDB
    // does: ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id) reports the id of
    // the row it found, even when nothing in that row changes. `+ 0` makes a
    // whole number INTEGER on both backends (sql.js returns it as text), so
    // the upsert change guard reads 1 as 1, not as 1.0.
    LAST_INSERT_ID: (args) => (args.length === 0 ? 'cis_last_insert_id()' : args.length === 1 ? '(cis_set_insert_id(' + args[0].text + ') + 0)' : null),
};

function matchParens(toks) {
    const match = new Array(toks.length).fill(-1);
    const stack = [];
    for (let i = 0; i < toks.length; i++) {
        if (toks[i].k === 'lp') stack.push(i);
        else if (toks[i].k === 'rp' && stack.length) {
            const o = stack.pop();
            match[o] = i;
            match[i] = o;
        }
    }
    return match;
}

function splitRange(ctx, from, to) {
    const out = [];
    let a = from;
    for (let i = from; i < to; i++) {
        const t = ctx.toks[i];
        if (t.k === 'lp' && ctx.match[i] > i) { i = ctx.match[i]; continue; }
        if (t.k === 'comma') { out.push({ a, b: i }); a = i + 1; }
    }
    if (out.length || nextSolid(ctx, a, to) < to) out.push({ a, b: to });
    return out;
}

function transformRange(ctx, from, to) {
    const toks = ctx.toks;
    const atoms = [];
    let i = from;
    while (i < to) {
        const t = toks[i];
        if (t.k === 'word') {
            const up = t.v.toUpperCase();
            const j = nextSolid(ctx, i + 1, to);
            const dotted = atoms.length > 0 && atoms[atoms.length - 1].t === '.';
            if (!dotted && j < to && toks[j].k === 'lp' && ctx.match[j] > j && ctx.match[j] < to) {
                const close = ctx.match[j];
                const rule = FN_RULES[up];
                if (rule) {
                    const args = splitRange(ctx, j + 1, close);
                    for (const arg of args) arg.text = transformRange(ctx, arg.a, arg.b).trim();
                    const r = rule(args, ctx);
                    if (r != null) {
                        pushVal(atoms, r);
                        i = close + 1;
                        continue;
                    }
                }
                if (!KEYWORDS.has(up)) {
                    let gap = '';
                    for (let g = i + 1; g < j; g++) gap += toks[g].v;
                    pushVal(atoms, t.v + gap + '(' + transformRange(ctx, j + 1, close) + ')');
                    i = close + 1;
                    continue;
                }
            }
            if (up === 'INTERVAL') {
                // <operand> + INTERVAL n unit / <operand> - INTERVAL n unit
                const p = lastSolid(atoms);
                if (p >= 0 && atoms[p].k === 'op' && (atoms[p].t === '+' || atoms[p].t === '-')) {
                    let q = p - 1;
                    while (q >= 0 && atoms[q].k === 'ws') q--;
                    const iv = q >= 0 && atoms[q].k === 'val' ? parseInterval(ctx, i, to) : null;
                    if (iv) {
                        const shifted = dateShift(atoms[q].t, atoms[p].t, iv);
                        atoms.length = q;
                        pushVal(atoms, shifted);
                        i = iv.end;
                        continue;
                    }
                }
            }
            if (up === 'LIKE') {
                // A backslash in a MySQL LIKE pattern escapes the next character.
                atoms.push({ k: 'kw', t: t.v });
                const s = nextSolid(ctx, i + 1, to);
                const e = s < to ? nextSolid(ctx, s + 1, to) : to;
                if (s < to && toks[s].k === 'str' && toks[s].v.indexOf('\\') >= 0
                    && !(e < to && toks[e].k === 'word' && toks[e].v.toUpperCase() === 'ESCAPE')) {
                    for (let x = i + 1; x <= s; x++) atoms.push({ k: x === s ? 'val' : 'ws', t: toks[x].v });
                    atoms.push({ k: 'kw', t: " ESCAPE '\\'" });
                    i = s + 1;
                    continue;
                }
                i++;
                continue;
            }
            if (KEYWORDS.has(up)) atoms.push({ k: 'kw', t: t.v });
            else pushVal(atoms, t.v, true);
            i++;
            continue;
        }
        if (t.k === 'lp' && ctx.match[i] > i && ctx.match[i] < to) {
            pushVal(atoms, '(' + transformRange(ctx, i + 1, ctx.match[i]) + ')');
            i = ctx.match[i] + 1;
            continue;
        }
        if (t.k === 'op' && (t.v === '->' || t.v === '->>')) {
            // col->'$.path' and col->>'$.path'; MariaDB has neither operator.
            const p = lastSolid(atoms);
            const s = nextSolid(ctx, i + 1, to);
            if (p >= 0 && atoms[p].k === 'val' && s < to && toks[s].k === 'str') {
                const operand = atoms[p].t;
                atoms.length = p;
                pushVal(atoms, 'json_extract(' + operand + ', ' + toks[s].v + ')');
                i = s + 1;
                continue;
            }
        }
        if (t.k === 'ws') atoms.push({ k: 'ws', t: t.v });
        else if (t.k === 'id') pushVal(atoms, t.v, true);
        else if (t.k === 'str' || t.k === 'num' || t.k === 'param') pushVal(atoms, t.v);
        else atoms.push({ k: 'op', t: t.v });
        i++;
    }
    let out = '';
    for (let k = 0; k < atoms.length; k++) out += atoms[k].t;
    return out;
}

// MySQL hands a JSON true or false from JSON_EXTRACT back as a boolean, so a
// script's `if row.isdead then` sees false as false. SQLite's json_extract
// gives 1 and 0, and 0 is true in Lua. A JSON_EXTRACT(doc, path) or
// doc->path that is a whole item of the outer SELECT list becomes
// cis_json_value(doc -> path): the -> operator keeps the JSON text, so true
// and false come back as markers that server.js turns into booleans, and
// everything else as json_extract would return it. Anywhere else (WHERE,
// ORDER BY, inside another call) the value stays 1 or 0, so = true and = 1
// still match.
const JSON_TRUE = '\u0001cis:true';
const JSON_FALSE = '\u0001cis:false';

function markJsonBooleans(sql) {
    const toks = lexSql(sql);
    const ctx = { toks, match: matchParens(toks) };
    const n = toks.length;
    let i = nextSolid(ctx, 0, n);
    if (i >= n || toks[i].k !== 'word' || toks[i].v.toUpperCase() !== 'SELECT') return null;
    let end = n;
    for (let j = i + 1; j < n; j++) {
        if (toks[j].k === 'lp' && ctx.match[j] > j) { j = ctx.match[j]; continue; }
        if (toks[j].k === 'word' && /^(?:FROM|INTO|WHERE|GROUP|HAVING|ORDER|LIMIT|UNION|WINDOW)$/i.test(toks[j].v)) { end = j; break; }
    }
    const edits = [];
    for (const item of splitRange(ctx, i + 1, end)) {
        let a = nextSolid(ctx, item.a, item.b);
        if (a < item.b && toks[a].k === 'word' && /^(?:DISTINCT|ALL)$/i.test(toks[a].v)) a = nextSolid(ctx, a + 1, item.b);
        const solid = [];
        for (let j = a; j < item.b; j++) if (toks[j].k !== 'ws') solid.push(j);
        if (solid.length < 3) continue;
        // Drop the alias: AS name, or a bare name after the expression.
        let z = solid.length - 1;
        const last = toks[solid[z]];
        if (last.k === 'word' || last.k === 'id' || last.k === 'str') {
            const prev = toks[solid[z - 1]];
            if (prev.k === 'word' && prev.v.toUpperCase() === 'AS') z -= 2;
            else if (prev.k === 'rp' || (prev.k === 'str' && last.k !== 'str')) z -= 1;
        }
        const first = solid[0];
        const stop = solid[z];
        const text = (from, to) => toks.slice(from, to).map((t) => t.v).join('').trim();
        let out = null;
        if (toks[first].k === 'word' && toks[first].v.toUpperCase() === 'JSON_EXTRACT'
            && toks[solid[1]].k === 'lp' && ctx.match[solid[1]] === stop) {
            const args = splitRange(ctx, solid[1] + 1, stop);
            if (args.length === 2) out = 'cis_json_value((' + text(args[0].a, args[0].b) + ') -> (' + text(args[1].a, args[1].b) + '))';
        } else if (toks[stop].k === 'str' && z >= 2 && toks[solid[z - 1]].v === '->') {
            const operand = solid.slice(0, z - 1);
            if (operand.every((j) => toks[j].k === 'word' || toks[j].k === 'id' || toks[j].v === '.')) {
                out = 'cis_json_value((' + text(first, solid[z - 1]) + ') -> (' + toks[stop].v + '))';
            }
        }
        if (out) edits.push({ from: first, to: stop + 1, out });
    }
    if (!edits.length) return null;
    let s = '';
    let at = 0;
    for (const e of edits) {
        s += toks.slice(at, e.from).map((t) => t.v).join('') + e.out;
        at = e.to;
    }
    return s + toks.slice(at).map((t) => t.v).join('');
}

// MySQL resolves ORDER BY id against the output columns first, so with
// SELECT a.id ... JOIN b it means a.id even when b has an id too; in GROUP BY
// and HAVING it falls back to them when the name is ambiguous. SQLite does
// the first only for an explicit alias and never the second. So an outer
// a.col named bare in ORDER BY gets AS col (the name SQLite gives it
// anyway), and a bare col in GROUP BY or HAVING becomes a.col.
function aliasSortedColumns(sql) {
    const toks = lexSql(sql);
    const solid = [];
    for (let i = 0; i < toks.length; i++) if (toks[i].k !== 'ws') solid.push(i);
    const word = (j) => (toks[solid[j]] && toks[solid[j]].k === 'word' ? toks[solid[j]].v.toUpperCase() : '');
    const nameOf = (tok) => (tok.k === 'id' && tok.v[0] === '"' ? tok.v.slice(1, -1).replace(/""/g, '"') : tok.k === 'word' ? tok.v : null);
    let depth = 0;
    let select = -1;
    let from = -1;
    const bare = new Set();
    const grouped = [];
    let inSort = false;
    let inGroup = false;
    for (let j = 0; j < solid.length; j++) {
        const t = toks[solid[j]];
        if (t.k === 'lp') { depth++; continue; }
        if (t.k === 'rp') { depth--; continue; }
        if (depth !== 0) continue;
        const w = word(j);
        if (w === 'SELECT' && select < 0) select = j;
        else if (w === 'FROM' && select >= 0 && from < 0) from = j;
        else if ((w === 'ORDER' || w === 'GROUP') && word(j + 1) === 'BY') { inSort = true; inGroup = w === 'GROUP'; j++; continue; }
        else if (w === 'HAVING') { inSort = true; inGroup = true; continue; }
        else if (w === 'LIMIT' || w === 'UNION' || w === 'WINDOW') inSort = false;
        if (inSort && (t.k === 'word' || t.k === 'id')) {
            const prev = toks[solid[j - 1]];
            const next = toks[solid[j + 1]];
            if ((!prev || prev.v !== '.') && (!next || (next.v !== '.' && next.k !== 'lp'))) {
                const n = nameOf(t);
                if (n) {
                    bare.add(n.toLowerCase());
                    if (inGroup) grouped.push({ at: solid[j], name: n.toLowerCase() });
                }
            }
        }
    }
    if (select < 0 || from < 0 || !bare.size) return sql;
    // Output names the list already has, and the plain a.col items.
    const items = [];
    let start = select + 1;
    depth = 0;
    for (let j = select + 1; j <= from; j++) {
        const t = toks[solid[j]];
        if (t.k === 'lp') depth++;
        else if (t.k === 'rp') depth--;
        if ((t.k === 'comma' && depth === 0) || j === from) {
            items.push([start, j - 1]);
            start = j + 1;
        }
    }
    const taken = new Map();
    const plain = [];
    for (const [a, b] of items) {
        const last = toks[solid[b]];
        const n = last ? nameOf(last) : null;
        if (n) taken.set(n.toLowerCase(), (taken.get(n.toLowerCase()) || 0) + 1);
        if (b - a === 2 && toks[solid[a + 1]].v === '.' && nameOf(toks[solid[a]]) && n) {
            plain.push({ end: solid[b], name: n, text: toks[solid[a]].v + '.' + toks[solid[b]].v });
        }
    }
    let changed = false;
    for (const g of grouped) {
        const p = plain.find((x) => x.name.toLowerCase() === g.name);
        if (!p || taken.get(g.name) !== 1) continue;
        toks[g.at] = { k: 'id', v: p.text };
        changed = true;
    }
    for (const p of plain) {
        const k = p.name.toLowerCase();
        if (!bare.has(k) || taken.get(k) !== 1) continue;
        toks[p.end] = { k: 'id', v: toks[p.end].v + ' AS "' + p.name.replace(/"/g, '""') + '"' };
        changed = true;
    }
    return changed ? toks.map((t) => t.v).join('') : sql;
}

// MySQL takes HAVING in a query with no GROUP BY and no aggregate, as a
// filter that can name the output columns (HAVING fullName LIKE ?). SQLite
// refuses HAVING there, but its WHERE resolves output aliases too, so the
// condition joins the WHERE. A query with an aggregate keeps its HAVING,
// which SQLite runs as it is.
const AGGREGATE_CALL = /^(?:COUNT|SUM|AVG|MIN|MAX|GROUP_CONCAT|JSON_GROUP_ARRAY|JSON_GROUP_OBJECT|TOTAL|STDDEV\w*|STD|VARIANCE|VAR_\w+|BIT_\w+)$/i;
function havingToWhere(sql) {
    const toks = lexSql(sql);
    let depth = 0;
    let select = -1;
    let where = -1;
    let having = -1;
    let end = toks.length;
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (t.k === 'lp') { depth++; continue; }
        if (t.k === 'rp') { depth--; continue; }
        if (t.k === 'word' && AGGREGATE_CALL.test(t.v)) {
            let j = i + 1;
            while (toks[j] && toks[j].k === 'ws') j++;
            if (toks[j] && toks[j].k === 'lp') return sql;
        }
        if (depth !== 0 || t.k !== 'word') continue;
        const w = t.v.toUpperCase();
        if (w === 'SELECT' && select < 0) select = i;
        else if (w === 'GROUP' || w === 'UNION' || w === 'EXCEPT' || w === 'INTERSECT' || w === 'WINDOW') return sql;
        else if (w === 'WHERE' && having < 0) where = i;
        else if (w === 'HAVING' && having < 0) having = i;
        else if (having >= 0 && end === toks.length && (w === 'ORDER' || w === 'LIMIT' || w === 'FOR' || w === 'LOCK')) end = i;
    }
    if (select < 0 || having < 0) return sql;
    const cond = toks.slice(having + 1, end).map((t) => t.v).join('').trim();
    if (!cond) return sql;
    const head = toks.slice(0, having).map((t) => t.v).join('');
    const tail = toks.slice(end).map((t) => t.v).join('');
    if (where < 0) return head + 'WHERE ' + cond + ' ' + tail;
    const before = toks.slice(0, where + 1).map((t) => t.v).join('');
    const filter = toks.slice(where + 1, having).map((t) => t.v).join('').trim();
    return before + ' (' + filter + ') AND (' + cond + ') ' + tail;
}

// ---- Collation-aware comparison and ordering ------------------------------------------------------
// MariaDB's _ci text columns order and compare differently from SQLite's
// NOCASE; collateText routes ORDER BY and range compares through the sort-key
// functions in collation.js (registered as cis_ci / cis_uci below).
/**
 * @param {(table: string) => {dflt: string, table: string|null, cols: object[]}|null} fn
 *   the table's column meta (__cis_columns rows with column_name, data_type
 *   and collation), its own collation and the database's
 */
function setCollationProvider(fn) {
    collationProvider = typeof fn === 'function' ? fn : null;
}

// The collation of a text column with none of its own: the table's, then
// the database's.
function effectiveCollation(info, collation) {
    return collation || (info && info.table) || (info && info.dflt) || null;
}

// Types whose values MariaDB compares by their collation. ENUM sorts by its
// position in the list, JSON is utf8mb4_bin, and dates are not text.
const COLLATED_TYPES = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'set']);

// The SQL function whose result sorts as the collation does, or null:
// cis_ci for utf8mb4_general_ci (and utf8mb3's and ascii's, which weigh
// what they can hold the same), cis_uci for utf8mb4_unicode_ci (UCA 4.0.0,
// as utf8mb3's). Any other collation is left to SQLite.
function keyFunction(collation) {
    if (/^(?:utf8(?:mb[34])?|ascii)_general_ci$/i.test(collation)) return 'cis_ci';
    if (/^utf8(?:mb[34])?_unicode_ci$/i.test(collation)) return 'cis_uci';
    return null;
}

// A table's columns (lower case) and, for those that compare as text in a
// collation keyFunction knows, the key function; or null when SQLite has no
// such table (a view, a CTE, a name that is not a table at all).
function collatedColumns(table, memo) {
    const k = String(table).toLowerCase();
    if (memo.has(k)) return memo.get(k);
    let out = null;
    const all = columnMeta(table);
    if (all.length) {
        out = { all: new Set(), ci: new Map() };
        for (const c of all) if (c && c.name != null) out.all.add(String(c.name).toLowerCase());
        try {
            const info = collationProvider(table);
            for (const c of (info && info.cols) || []) {
                const name = String(c.column_name || '').toLowerCase();
                if (!name || !out.all.has(name)) continue;
                if (!COLLATED_TYPES.has(String(c.data_type || '').toLowerCase())) continue;
                const fn = keyFunction(effectiveCollation(info, c.collation) || '');
                if (fn) out.ci.set(name, fn);
            }
        } catch (e) { /* no meta: nothing is wrapped */ }
    }
    memo.set(k, out);
    return out;
}

const isColumnTok = (t) => !!t && ((t.k === 'word' && !KEYWORDS.has(t.v.toUpperCase())) || (t.k === 'id' && t.v[0] !== "'"));
const ALIAS_STOP = new Set(['WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'NATURAL', 'FULL', 'ON', 'USING',
    'SET', 'ORDER', 'GROUP', 'LIMIT', 'HAVING', 'UNION', 'EXCEPT', 'INTERSECT', 'WINDOW', 'FOR', 'LOCK', 'INDEXED', 'NOT',
    'RETURNING', 'OFFSET', 'VALUES', 'STRAIGHT_JOIN', 'USE', 'FORCE', 'IGNORE', 'AS']);
const CMP_BEFORE = new Set(['WHERE', 'AND', 'OR', 'NOT', 'ON', 'WHEN', 'THEN', 'ELSE', 'HAVING']);
const CMP_AFTER = new Set(['AND', 'OR', 'THEN', 'ELSE', 'END', 'WHEN', 'ORDER', 'GROUP', 'LIMIT', 'HAVING', 'UNION', 'EXCEPT',
    'INTERSECT', 'WINDOW', 'RETURNING', 'OFFSET']);
const ORDER_END = new Set(['LIMIT', 'OFFSET', 'FOR', 'LOCK', 'SEPARATOR', 'ROWS', 'RANGE', 'GROUPS', 'UNION', 'EXCEPT', 'INTERSECT', 'WINDOW']);

/**
 * Sends ORDER BY terms and <, >, <=, >=, BETWEEN comparisons on
 * utf8mb4_general_ci text columns through cis_ci (generalCiKey) and on
 * utf8mb4_unicode_ci ones through cis_uci (unicodeCiKey), so they order and
 * compare as MariaDB does. Only what is certain is wrapped: an
 * ORDER BY term that is one column (or an output alias of one), and a
 * comparison of such a column with a string, a ? or another such column
 * of the same collation. A name that more than one table could hold, a table SQLite does not have,
 * a sorted UNION and the outer select list (whose text names the result
 * columns) are left as they are. Strings and ? are wrapped, never changed,
 * so the placeholders keep their count and order.
 * @param {string} sql translated SELECT, UPDATE, DELETE or WITH
 * @returns {string}
 */
function collateText(sql) {
    if (!collationProvider || !schemaProvider || !/\bORDER\s+BY\b|[<>]|\bBETWEEN\b/i.test(sql)) return sql;
    const toks = lexSql(sql);
    const S = [];
    for (let i = 0; i < toks.length; i++) if (toks[i].k !== 'ws') S.push(i);
    const T = (p) => (p >= 0 && p < S.length ? toks[S[p]] : null);
    const up = (p) => { const t = T(p); return t && t.k === 'word' ? t.v.toUpperCase() : ''; };
    const nameOf = (t) => (t.k === 'word' ? t.v : t.v.slice(1, -1).split(t.v[0] + t.v[0]).join(t.v[0]));
    const isOp = (p, v) => { const t = T(p); return !!t && t.k === 'op' && t.v === v; };
    const depth = new Array(S.length);
    for (let p = 0, d = 0; p < S.length; p++) {
        if (T(p).k === 'rp') d--;
        depth[p] = d;
        if (T(p).k === 'lp') d++;
    }

    // Tables after FROM, JOIN and UPDATE, with their aliases.
    const memo = new Map();
    const scope = new Map();
    const tables = [];
    const tableAs = new Set();
    let unknown = false;
    let anyCi = false;
    const bind = (name, info) => {
        const k = name.toLowerCase();
        scope.set(k, scope.has(k) && scope.get(k) !== info ? false : info);
    };
    for (let p = 0; p < S.length; p++) {
        const w = up(p);
        if (w !== 'FROM' && w !== 'JOIN' && w !== 'UPDATE') continue;
        let q = p + 1;
        for (;;) {
            let info = false;
            if (T(q) && T(q).k === 'lp') {
                let d = 1;
                for (q++; q < S.length && d > 0; q++) {
                    if (T(q).k === 'lp') d++;
                    else if (T(q).k === 'rp') d--;
                }
            } else if (isColumnTok(T(q))) {
                let name = nameOf(T(q));
                q++;
                if (isOp(q, '.') && isColumnTok(T(q + 1))) { name = nameOf(T(q + 1)); q += 2; }
                if (!identOk(name)) {
                    unknown = true;
                } else {
                    info = collatedColumns(name, memo) || false;
                    if (!info) unknown = true;
                    else {
                        tables.push(info);
                        if (info.ci.size) anyCi = true;
                    }
                    bind(name, info);
                }
            } else {
                break;
            }
            if (up(q) === 'AS' && isColumnTok(T(q + 1))) { tableAs.add(q); bind(nameOf(T(q + 1)), info); q += 2; }
            else if (T(q) && (T(q).k === 'id' || (T(q).k === 'word' && !ALIAS_STOP.has(up(q)) && !KEYWORDS.has(up(q))))) { bind(nameOf(T(q)), info); q++; }
            if (w === 'FROM' && T(q) && T(q).k === 'comma') { q++; continue; }
            break;
        }
    }
    if (!anyCi) return sql;

    // A column reference at p: [qualifier .] name, not a call.
    const colAt = (p) => {
        if (!isColumnTok(T(p)) || (T(p + 1) && T(p + 1).k === 'lp') || isOp(p - 1, '.')) return null;
        if (isOp(p + 1, '.')) {
            if (!isColumnTok(T(p + 2)) || (T(p + 3) && (T(p + 3).k === 'lp' || isOp(p + 3, '.')))) return null;
            return { a: p, b: p + 2, qual: nameOf(T(p)).toLowerCase(), col: nameOf(T(p + 2)).toLowerCase() };
        }
        return { a: p, b: p, qual: null, col: nameOf(T(p)).toLowerCase() };
    };
    // The same, ending at p.
    const colEnding = (p) => (isOp(p - 1, '.') ? colAt(p - 2) : colAt(p));

    // Output aliases: name -> the column it renames, or null for an
    // expression.
    const aliases = new Map();
    for (let p = 0; p < S.length; p++) {
        if (up(p) !== 'AS' || tableAs.has(p) || !isColumnTok(T(p + 1)) || (T(p + 2) && T(p + 2).k === 'lp')) continue;
        let a = p - 1;
        while (a >= 0 && !(depth[a] === depth[p] && (T(a).k === 'comma' || up(a) === 'SELECT' || SELECT_MODIFIERS.has(up(a))))) {
            if (depth[a] < depth[p]) break;
            a--;
        }
        if (a < 0 || !(T(a).k === 'comma' || up(a) === 'SELECT' || SELECT_MODIFIERS.has(up(a)))) continue;
        const c = colAt(a + 1);
        const ref = c && c.b === p - 1 ? c : null;
        const k = nameOf(T(p + 1)).toLowerCase();
        aliases.set(k, aliases.has(k) ? null : ref);
    }

    // The key function of the column c, or null. A bare name every table
    // that has it must agree on.
    const resolveColumn = (c) => {
        if (c.qual) {
            const info = scope.get(c.qual);
            return (info && info.ci.get(c.col)) || null;
        }
        if (unknown) return null;
        let fn = null;
        for (const info of tables) {
            if (!info.all.has(c.col)) continue;
            const f = info.ci.get(c.col);
            if (!f || (fn && f !== fn)) return null;
            fn = f;
        }
        return fn;
    };
    const textOf = (c) => toks.slice(S[c.a], S[c.b] + 1).map((x) => x.v).join('');
    // What to wrap for the reference c, as {text, fn}: its own text or the
    // text of the column an output alias renames, and its key function; or
    // null. Inside an expression SQLite reads a
    // name as a table's column before an alias, where ORDER BY in MariaDB
    // takes the alias, so an alias is replaced by its column. In a
    // comparison (a WHERE, or a HAVING moved there) a name that is both is
    // left alone.
    const resolve = (c, order) => {
        if (!c.qual && aliases.has(c.col)) {
            const ref = aliases.get(c.col);
            const fn = ref && resolveColumn(ref);
            if (!fn) return null;
            if (!order && !(ref.col === c.col && !ref.qual) && tables.some((info) => info.all.has(c.col))) return null;
            return { text: textOf(ref), fn };
        }
        const fn = resolveColumn(c);
        return fn ? { text: textOf(c), fn } : null;
    };

    // The outer select lists: their text names the result columns.
    const listed = new Uint8Array(S.length);
    for (let p = 0, on = false; p < S.length; p++) {
        if (depth[p] === 0 && up(p) === 'SELECT') on = true;
        else if (depth[p] === 0 && up(p) === 'FROM') on = false;
        if (on) listed[p] = 1;
    }

    const wraps = [];
    const used = new Uint8Array(S.length);
    const free = (a, b) => { for (let p = a; p <= b; p++) if (used[p]) return false; return true; };
    const take = (a, b, cast, text, fn) => {
        for (let p = a; p <= b; p++) used[p] = 1;
        wraps.push({ a, b, cast, text, fn });
    };
    // A side of a comparison: a string, a ? or a collated column.
    const operand = (p, forward) => {
        const t = T(p);
        if (!t) return null;
        if (t.k === 'str' || t.k === 'param') return { a: p, b: p, lit: true, text: t.v };
        const c = forward ? colAt(p) : colEnding(p);
        const got = c && resolve(c, false);
        return got ? { a: c.a, b: c.b, lit: false, text: got.text, fn: got.fn } : null;
    };
    // ORDER BY k: the k-th output column of the query the ORDER BY at p
    // ends, when it is one column.
    const positional = (p, k) => {
        if (!Number.isInteger(k) || k < 1) return null;
        const d = depth[p];
        let q = p - 1;
        while (q >= 0 && depth[q] >= d && !(depth[q] === d && up(q) === 'SELECT')) q--;
        if (q < 0 || depth[q] < d) return null;
        q++;
        while (SELECT_MODIFIERS.has(up(q))) q++;
        let n = 1;
        let a = q;
        for (; q < p; q++) {
            const end = depth[q] === d && (T(q).k === 'comma' || up(q) === 'FROM');
            if (!end) continue;
            if (n === k) break;
            if (up(q) === 'FROM') return null;
            n++;
            a = q + 1;
        }
        if (n !== k || q >= p) return null;
        let b = q - 1;
        if (up(b - 1) === 'AS') b -= 2;
        const c = colAt(a);
        const fn = c && c.b === b && resolveColumn(c);
        return fn ? { text: textOf(c), fn } : null;
    };
    const before = (p) => p < 0 || T(p).k === 'lp' || T(p).k === 'comma' || CMP_BEFORE.has(up(p));
    const after = (p) => p >= S.length || T(p).k === 'rp' || T(p).k === 'comma' || isOp(p, ';') || CMP_AFTER.has(up(p));
    const adjacent = (p) => p + 1 < S.length && S[p + 1] === S[p] + 1;
    const wrapSides = (sides) => {
        if (!sides.every(Boolean) || !sides.some((s) => !s.lit)) return;
        // Columns of two collations: MariaDB refuses or coerces; leave it.
        const fns = new Set(sides.filter((s) => !s.lit).map((s) => s.fn));
        if (fns.size !== 1 || !sides.every((s) => free(s.a, s.b))) return;
        const [fn] = fns;
        for (const s of sides) take(s.a, s.b, s.lit, s.text, fn);
    };

    for (let p = 0; p < S.length; p++) {
        if (listed[p]) continue;
        const t = T(p);
        if (t.k === 'op' && (t.v === '<' || t.v === '>')) {
            if (isOp(p - 1, '<') || isOp(p - 1, '>') || isOp(p - 1, '=') || isOp(p - 1, '!')) continue;
            let end = p;
            if (adjacent(p) && isOp(p + 1, '=')) end = p + 1;
            else if (adjacent(p) && (isOp(p + 1, '>') || isOp(p + 1, '<'))) continue;
            if (end > p && adjacent(end) && isOp(end + 1, '>')) continue;
            const left = operand(p - 1, false);
            const right = operand(end + 1, true);
            if (!left || !right || !before(left.a - 1) || !after(right.b + 1)) continue;
            wrapSides([left, right]);
        } else if (up(p) === 'BETWEEN') {
            const subj = operand(up(p - 1) === 'NOT' ? p - 2 : p - 1, false);
            const lo = operand(p + 1, true);
            if (!subj || subj.lit || !lo || up(lo.b + 1) !== 'AND') continue;
            const hi = operand(lo.b + 2, true);
            if (!hi || !before(subj.a - 1) || !after(hi.b + 1)) continue;
            wrapSides([subj, lo, hi]);
        } else if (up(p) === 'ORDER' && up(p + 1) === 'BY') {
            const d = depth[p];
            let union = false;
            for (let q = p - 1; q >= 0 && depth[q] >= d; q--) {
                if (depth[q] === d && (up(q) === 'UNION' || up(q) === 'EXCEPT' || up(q) === 'INTERSECT')) { union = true; break; }
            }
            if (union) continue;
            let a = p + 2;
            for (let q = a; ; q++) {
                const stop = q >= S.length || depth[q] < d || (depth[q] === d && (ORDER_END.has(up(q)) || isOp(q, ';')));
                if (stop || (depth[q] === d && T(q).k === 'comma')) {
                    let b = q - 1;
                    if (up(b) === 'FIRST' || up(b) === 'LAST') b -= up(b - 1) === 'NULLS' ? 2 : 0;
                    if (up(b) === 'ASC' || up(b) === 'DESC') b--;
                    const c = colAt(a);
                    const got = c && c.b === b ? resolve(c, true) : a === b && T(a).k === 'num' ? positional(p, Number(T(a).v)) : null;
                    if (got && free(a, b)) take(a, b, false, got.text, got.fn);
                    if (stop) break;
                    a = q + 1;
                }
            }
        }
    }
    if (!wraps.length) return sql;
    for (const w of wraps) {
        for (let i = S[w.a] + 1; i <= S[w.b]; i++) toks[i] = { k: 'ws', v: '' };
        toks[S[w.a]] = { k: 'id', v: w.cast ? w.fn + '(CAST(' + w.text + ' AS TEXT))' : w.fn + '(' + w.text + ')' };
    }
    return toks.map((x) => x.v).join('');
}

const SELECT_MODIFIERS = new Set(['DISTINCT', 'ALL', 'DISTINCTROW', 'HIGH_PRIORITY', 'STRAIGHT_JOIN', 'SQL_SMALL_RESULT',
    'SQL_BIG_RESULT', 'SQL_BUFFER_RESULT', 'SQL_NO_CACHE', 'SQL_CACHE', 'SQL_CALC_FOUND_ROWS']);
const SELECT_LIST_END = new Set(['FROM', 'UNION', 'INTO', 'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'WINDOW', 'FOR', 'LOCK', 'EXCEPT', 'INTERSECT']);

// BINARY x compares x byte for byte (WHERE BINARY plate = ?); SQLite has no
// such operator and reads BINARY as a column name. x COLLATE BINARY is the
// same compare. x is a name (dotted or quoted), a ? or a string; BINARY
// before ( or ) is a type (CAST(x AS BINARY), BINARY(16)) and stays.
function rewriteBinaryOperator(sql) {
    const toks = lexSql(sql);
    const next = (i) => { let j = i + 1; while (toks[j] && toks[j].k === 'ws') j++; return j; };
    let changed = false;
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (t.k !== 'word' || t.v.toUpperCase() !== 'BINARY') continue;
        let j = next(i);
        const first = toks[j];
        if (!first || !(first.k === 'word' || first.k === 'id' || first.k === 'param' || first.k === 'str')) continue;
        if (first.k === 'word' && toks[next(j)] && toks[next(j)].k === 'lp') continue;
        let end = j;
        while (first.k !== 'param' && first.k !== 'str' && toks[next(end)] && toks[next(end)].v === '.') {
            const k = next(next(end));
            if (!toks[k] || !(toks[k].k === 'word' || toks[k].k === 'id')) break;
            end = k;
        }
        toks[i] = { k: 'ws', v: '' };
        if (toks[i + 1] && toks[i + 1].k === 'ws') toks[i + 1] = { k: 'ws', v: '' };
        toks[end] = { k: toks[end].k, v: toks[end].v + ' COLLATE BINARY' };
        changed = true;
        i = end;
    }
    return changed ? toks.map((x) => x.v).join('') : sql;
}

// The items of the outer SELECT list: the tokens, the non-space token
// indexes and, per item, the range [a, b) of those indexes. Null when the
// statement has no outer SELECT.
function outerSelectList(sql) {
    const toks = lexSql(sql);
    const solid = [];
    for (let i = 0; i < toks.length; i++) if (toks[i].k !== 'ws') solid.push(i);
    const tok = (j) => toks[solid[j]];
    const up = (j) => (tok(j) && tok(j).k === 'word' ? tok(j).v.toUpperCase() : '');
    let depth = 0;
    let j = 0;
    for (; j < solid.length; j++) {
        if (tok(j).k === 'lp') depth++;
        else if (tok(j).k === 'rp') depth--;
        else if (depth === 0 && up(j) === 'SELECT') break;
    }
    if (j >= solid.length) return null;
    j++;
    while (SELECT_MODIFIERS.has(up(j))) j++;
    const items = [];
    let start = j;
    depth = 0;
    for (; j <= solid.length; j++) {
        const t = tok(j);
        if (t && depth === 0 && t.k !== 'comma' && !SELECT_LIST_END.has(up(j))) {
            if (t.k === 'lp') depth++;
            continue;
        }
        if (t && depth > 0) {
            if (t.k === 'lp') depth++;
            else if (t.k === 'rp') depth--;
            continue;
        }
        items.push([start, j]);
        if (!t || t.k !== 'comma') break;
        start = j + 1;
    }
    return { toks, solid, items };
}

const isNameTok = (t) => t && (t.k === 'word' || t.k === 'id');
const nameOfTok = (t) => (t.k === 'word' ? t.v : t.v.slice(1, -1).split(t.v[0] + t.v[0]).join(t.v[0]));

// col, t.col or db.t.col
function plainItem(list, a, b) {
    const n = b - a;
    let plain = n % 2 === 1 && n <= 5;
    for (let k = 0; plain && k < n; k++) plain = k % 2 === 0 ? isNameTok(list.toks[list.solid[a + k]]) : list.toks[list.solid[a + k]].v === '.';
    return plain;
}

// Words an expression can end with that are not an alias after it.
const EXPR_END_WORDS = new Set(['END', 'NULL', 'TRUE', 'FALSE', 'UNKNOWN', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME',
    'LOCALTIME', 'LOCALTIMESTAMP', 'MICROSECOND', 'SECOND', 'MINUTE', 'HOUR', 'DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR',
    'SECOND_MICROSECOND', 'MINUTE_MICROSECOND', 'MINUTE_SECOND', 'HOUR_MICROSECOND', 'HOUR_SECOND', 'HOUR_MINUTE',
    'DAY_MICROSECOND', 'DAY_SECOND', 'DAY_MINUTE', 'DAY_HOUR', 'YEAR_MONTH']);
// Words before a name that make the name part of the expression.
const EXPR_LEAD_WORDS = new Set(['BINARY', 'DISTINCT', 'NOT', 'INTERVAL', 'COLLATE', 'AND', 'OR', 'XOR', 'IS', 'LIKE', 'IN',
    'BETWEEN', 'THEN', 'ELSE', 'WHEN', 'CASE', 'DIV', 'MOD', 'REGEXP', 'RLIKE', 'ESCAPE', 'ALL', 'ANY', 'SOME', 'EXISTS', 'SELECT']);

// True when the item ends in an alias, with AS or without.
function hasAlias(list, a, b) {
    if (b - a < 2) return false;
    const last = list.toks[list.solid[b - 1]];
    const prev = list.toks[list.solid[b - 2]];
    if (!isNameTok(last) && last.k !== 'str') return false;
    if (prev.k === 'word' && prev.v.toUpperCase() === 'AS') return true;
    if (last.k === 'str' || (last.k === 'word' && EXPR_END_WORDS.has(last.v.toUpperCase()))) return false;
    if (prev.k === 'rp' || prev.k === 'str' || prev.k === 'num') return true;
    if (prev.k === 'id') return true;
    return prev.k === 'word' && !EXPR_LEAD_WORDS.has(prev.v.toUpperCase());
}

// MariaDB names a result column after the select item as written: ox_mdt's
// SELECT stateId ... on a column declared stateid hands Lua row.stateId.
// SQLite names a plain column after its declaration, so the field was nil.
// Each plain column item of the outer SELECT (col, t.col, db.t.col) without
// an alias gets the spelling it was written with as one.
function aliasPlainColumns(sql) {
    const list = outerSelectList(sql);
    if (!list) return sql;
    let changed = false;
    for (const [a, b] of list.items) {
        if (!plainItem(list, a, b)) continue;
        const last = list.toks[list.solid[b - 1]];
        list.toks[list.solid[b - 1]] = { k: 'id', v: last.v + ' AS "' + nameOfTok(last).replace(/"/g, '""') + '"' };
        changed = true;
    }
    return changed ? list.toks.map((x) => x.v).join('') : sql;
}

// An expression item without an alias is named after its text, and SQLite
// names it after the translated text: COUNT(`id`) came back as COUNT("id"),
// EXISTS(...) with the quotes changed, VERSION() as 'sqlite'. Items are
// paired with the caller's text by position, and only when both lists have
// as many items. An item with a ? keeps SQLite's name: MariaDB's would hold
// the value mysql2 put in its place.
function aliasExpressionColumns(original, sql) {
    const from = outerSelectList(original);
    const to = outerSelectList(sql);
    if (!from || !to || from.items.length !== to.items.length) return sql;
    const text = (list, a, b) => list.toks.slice(list.solid[a], list.solid[b - 1] + 1).map((x) => x.v).join('');
    let changed = false;
    for (let i = 0; i < from.items.length; i++) {
        const [fa, fb] = from.items[i];
        const [ta, tb] = to.items[i];
        if (fb <= fa || tb <= ta || plainItem(from, fa, fb) || hasAlias(from, fa, fb) || hasAlias(to, ta, tb)) continue;
        const name = text(from, fa, fb);
        if (name === '*' || /\.\s*\*$/.test(name) || name.indexOf('?') >= 0 || name === text(to, ta, tb)) continue;
        const last = to.toks[to.solid[tb - 1]];
        to.toks[to.solid[tb - 1]] = { k: last.k, v: last.v + ' AS "' + name.replace(/"/g, '""') + '"' };
        changed = true;
    }
    return changed ? to.toks.map((x) => x.v).join('') : sql;
}

// ---- Function and call rewrites, outer-SELECT column names ------------------------
// rewriteFunctions runs the token-level rules above, rewriteCalls the simple
// name swaps; aliasPlainColumns and aliasExpressionColumns keep result column
// names as MariaDB would spell them.
function rewriteFunctions(sql) {
    const toks = lexSql(sql);
    return transformRange({ toks, match: matchParens(toks) }, 0, toks.length);
}

const MYSQL_HINT =/`|\bIFNULL\s*\(|\bNOW\s*\(|\bCURRENT_(?:TIMESTAMP|DATE|TIME)\b|\bLOCALTIME(?:STAMP)?\b|\bSYSDATE\s*\(|\bUTC_TIME\s*\(|\bCURDATE\s*\(|\bUTC_DATE\s*\(|\bUTC_TIMESTAMP\s*\(|\bUNIX_TIMESTAMP\s*\(|\bLAST_INSERT_ID\s*\(|\bJSON_|\bON\s+DUPLICATE|\bINSERT\s+IGNORE|\bREPLACE\s+INTO|\bDATE_SUB|\bDATE_ADD|\bCONCAT\s*\(|\bTRUE\b|\bFALSE\b|\bPOW\s*\(|\bPOWER\s*\(|\bRAND\s*\(|\bIF\s*\(|\bSUBSTRING\s*\(|\bGROUP_CONCAT\b|\binformation_schema\b|\bDATABASE\s*\(|\bINTERVAL\s+\d+|\bALTER\s+TABLE\b|\bUNSIGNED\b|\bLONGTEXT\b|\bADD\s+COLUMN\b|\bLIMIT\s+\d+|\bFOR\s+UPDATE\b|\bLOCK\s+IN\s+SHARE|\bAUTO_INCREMENT\b|\bENGINE\s*=|\bJSON_CONTAINS\s*\(|\bJSON_SEARCH\s*\(|\bGREATEST\s*\(|\bLEAST\s*\(|\bFROM_UNIXTIME\s*\(|\bDATEDIFF\s*\(|\bLOCATE\s*\(|\bMOD\s*\(|\bMD5\s*\(|\bFIELD\s*\(|\bVERSION\s*\(|\bLAST_INSERT_ID\s*\(|\bLEFT\s*\(|\bRIGHT\s*\(|\bDROP\s+PRIMARY\b|\bDROP\s+COLUMN\b|\bUPDATE\s+IGNORE\b|\bALTER\s+COLUMN\b|\bFIND_IN_SET\s*\(|\bTRUNCATE\s*\(|\bSTDDEV(?:_POP|_SAMP)?\s*\(|\bVARIANCE\s*\(|\bVAR_POP\s*\(|\bVAR_SAMP\s*\(|\bHIGH_PRIORITY\b|\bLOW_PRIORITY\b|\bDELAYED\b|\bSIGNAL\b|\bPROCEDURE\b|\bREGEXP\b|\bSHA2\s*\(|\bUNHEX\s*\(|\bTIMESTAMPDIFF\s*\(|\bJSON_QUERY\s*\(|\bJSON_ARRAYAGG\s*\(|\bJSON_ARRAY_APPEND\s*\(|\bTRUNCATE\s+TABLE\b|\bSTR_TO_DATE\s*\(|\bENUM\s*\(|\bVALUE\s*\(|\bYEAR\s*\(|\bMONTH\s*\(|\bDAY\s*\(|\bCURTIME\s*\(|\bTIME_TO_SEC\s*\(|\bTRIM\s*\(|\bJSON_CONTAINS_PATH\s*\(|\bJSON_OBJECTAGG\s*\(|\bYEARWEEK\s*\(|\bLPAD\s*\(|\bTIMESTAMPADD\s*\(|\bNULLIF\s*\(|\bVALUES\s*\(\s*DEFAULT\b|->|\bINTERVAL\b|\bDATE_FORMAT\s*\(|\bISNULL\s*\(|\bLCASE\s*\(|\bUCASE\s*\(|\bCHAR(?:ACTER)?_LENGTH\s*\(|\bHOUR\s*\(|\bMINUTE\s*\(|\bSECOND\s*\(|\bDAYOFMONTH\s*\(|\bADDDATE\s*\(|\bSUBDATE\s*\(|\bRPAD\s*\(|\bLAST_DAY\s*\(|\bRLIKE\b|\bBINARY\s+[A-Za-z_`"?]|\bLIKE\s+'[^']*\\/i;

function needsMysql(sql) {
    MYSQL_HINT.lastIndex = 0;
    return MYSQL_HINT.test(sql);
}

function hasTok(s, a, b) {
    return s.indexOf(a) >= 0 || (b && s.indexOf(b) >= 0);
}

// Renames and keyword rewrites on one stretch of code that holds no string
// literal and no comment (the caller skips them). Calls whose arguments
// matter were already rewritten by rewriteFunctions.
function rewriteCallsChunk(chunk) {
    let s = chunk;
    if (hasTok(s, 'IFNULL', 'ifnull')) s = s.replace(/\bIFNULL\s*\(/gi, 'COALESCE(');
    if (/\bYEARWEEK\s*\(/i.test(s)) s = s.replace(/\bYEARWEEK\s*\(\s*([^()]*?(?:\([^()]*\))?)\s*(?:,\s*\d+\s*)?\)/gi, "CAST(strftime('%Y%W', $1) AS INTEGER)");
    // The bare keywords are SQLite's too, on the UTC clock. This runs before
    // the calls below put 'localtime' in the text. In parentheses the local
    // form still parses where a DEFAULT takes it.
    if (/\b(?:CURRENT_(?:TIMESTAMP|DATE|TIME)|LOCALTIME(?:STAMP)?)\b(?!\s*\()/i.test(s)) {
        s = s.replace(/\b(CURRENT_(?:TIMESTAMP|DATE|TIME)|LOCALTIME(?:STAMP)?)\b(?!\s*\()/gi, (w) => {
            const u = w.toUpperCase();
            return '(' + (u === 'CURRENT_DATE' ? LOCAL_DATE : u === 'CURRENT_TIME' ? LOCAL_TIME : LOCAL_NOW) + ')';
        });
    }
    if (/\b(?:NOW|LOCALTIME|LOCALTIMESTAMP|SYSDATE)\s*\(/i.test(s)) s = s.replace(/\b(?:NOW|LOCALTIME|LOCALTIMESTAMP|SYSDATE)\s*\(\s*\d*\s*\)/gi, LOCAL_NOW);
    if (hasTok(s, 'CURRENT_TIMESTAMP', 'current_timestamp')) s = s.replace(/\bCURRENT_TIMESTAMP\s*\(\s*\d*\s*\)/gi, LOCAL_NOW);
    if (hasTok(s, 'UTC_TIMESTAMP', 'utc_timestamp')) s = s.replace(/\bUTC_TIMESTAMP\s*\(\s*\d*\s*\)/gi, "datetime('now')");
    if (hasTok(s, 'CURDATE', 'curdate')) s = s.replace(/\bCURDATE\s*\(\s*\)/gi, LOCAL_DATE);
    if (hasTok(s, 'CURRENT_DATE', 'current_date')) s = s.replace(/\bCURRENT_DATE\s*\(\s*\)/gi, LOCAL_DATE);
    if (/\bUTC_DATE\s*\(/i.test(s)) s = s.replace(/\bUTC_DATE\s*\(\s*\)/gi, "date('now')");
    if (hasTok(s, 'JSON_', 'json_')) {
        s = s.replace(/\bJSON_UNQUOTE\s*\(/gi, '(');
        s = s.replace(/\bJSON_EXTRACT\s*\(/gi, 'json_extract(');
        s = s.replace(/\bJSON_VALUE\s*\(/gi, 'json_extract(');
        s = s.replace(/\bJSON_SET\s*\(/gi, 'json_set(');
        s = s.replace(/\bJSON_ARRAY\s*\(/gi, 'json_array(');
        s = s.replace(/\bJSON_OBJECT\s*\(/gi, 'json_object(');
        s = s.replace(/\bJSON_REPLACE\s*\(/gi, 'json_replace(');
        s = s.replace(/\bJSON_REMOVE\s*\(/gi, 'json_remove(');
        s = s.replace(/\bJSON_INSERT\s*\(/gi, 'json_insert(');
        s = s.replace(/\bJSON_TYPE\s*\(/gi, 'json_type(');
        s = s.replace(/\bJSON_VALID\s*\(/gi, 'json_valid(');
        s = s.replace(/\bJSON_LENGTH\s*\(/gi, '__CISJLEN__(');
    }
    if (hasTok(s, 'POW', 'pow')) s = s.replace(/\bPOW\s*\(/gi, 'power(');
    if (hasTok(s, 'POWER', 'power')) s = s.replace(/\bPOWER\s*\(/gi, 'power(');
    if (hasTok(s, 'RAND', 'rand')) s = s.replace(/\bRAND\s*\(\s*\)/gi, '(abs(random()) % 1000000) / 1000000.0');
    // SUBSTRING(s, pos, len) is substr; SUBSTRING_INDEX is a function of its own.
    if (hasTok(s, 'SUBSTRING', 'substring')) s = s.replace(/\bSUBSTRING\s*\(/gi, 'substr(');
    if (/\bFIELD\s*\(/i.test(s)) s = s.replace(/\bFIELD\s*\(/gi, '__CISFIELD__(');
    if (/\bRLIKE\b/i.test(s)) s = s.replace(/\bRLIKE\b/gi, 'REGEXP');
    if (/\bREGEXP\b/i.test(s)) {
        s = s.replace(/([\w.`"]+)\s+REGEXP\s+\?/gi, '$1 REGEXP ?');
        s = s.replace(/OR 0 = \s*'(?:[^']|'')*'/gi, '');
    }
    if (hasTok(s, 'TRUE', 'true')) s = s.replace(/\bTRUE\b/gi, '1');
    if (hasTok(s, 'FALSE', 'false')) s = s.replace(/\bFALSE\b/gi, '0');
    if (hasTok(s, 'GREATEST', 'greatest')) s = s.replace(/\bGREATEST\s*\(/gi, '__CISMAX__(');
    if (hasTok(s, 'LEAST', 'least')) s = s.replace(/\bLEAST\s*\(/gi, 'min(');
    // MariaDB's version string, as the replica reported it (server.js): esx_lib
    // writes DEFAULT literals one way for MariaDB and another for MySQL.
    if (hasTok(s, 'VERSION', 'version')) s = s.replace(/\bVERSION\s*\(\s*\)/gi, 'cis_version()');
    if (/\bJSON_QUERY\s*\(/i.test(s)) s = s.replace(/\bJSON_QUERY\s*\(/gi, 'json_extract(');
    if (/\bJSON_ARRAYAGG\s*\(/i.test(s)) s = s.replace(/\bJSON_ARRAYAGG\s*\(/gi, 'json_group_array(');
    if (/\bJSON_OBJECTAGG\s*\(/i.test(s)) s = s.replace(/\bJSON_OBJECTAGG\s*\(/gi, 'json_group_object(');
    if (/\bJSON_ARRAY_APPEND\s*\(/i.test(s)) s = s.replace(/\bJSON_ARRAY_APPEND\s*\(/gi, 'json_insert(');
    if (/\bJSON_CONTAINS_PATH\s*\(/i.test(s)) s = rewriteJsonContainsPath(s);
    if (/\b(?:CURTIME|CURRENT_TIME)\s*\(/i.test(s)) s = s.replace(/\b(?:CURTIME|CURRENT_TIME)\s*\(\s*\d*\s*\)/gi, LOCAL_TIME);
    if (/\bUTC_TIME\s*\(/i.test(s)) s = s.replace(/\bUTC_TIME\s*\(\s*\d*\s*\)/gi, "time('now')");
    if (/\bNULLIF\s*\(/i.test(s)) s = s.replace(/\bNULLIF\s*\(/gi, 'nullif(');
    if (/\bVALUES\s*\(/i.test(s) && /\bDEFAULT\b/i.test(s)) {
        s = s.replace(/\bVALUES\s*\(([^)]*)\)/gi, (full, inner) => 'VALUES (' + inner.replace(/\bDEFAULT\b/gi, 'NULL') + ')');
    }
    if (/\bgroup\b(?!\s+BY\b)/i.test(s)) s = s.replace(/\bgroup\b(?!\s+BY\b)/gi, '"group"');
    if (/(?:SELECT|,|\bSET)\s+text\b/i.test(s)) s = s.replace(/((?:SELECT|,|\bSET)\s+)text\b(?!\s*\()/gi, '$1"text"');
    if (/\b(?:HIGH_PRIORITY|LOW_PRIORITY|DELAYED|QUICK)\b/i.test(s)) {
        s = s.replace(/\b(?:HIGH_PRIORITY|LOW_PRIORITY|DELAYED|QUICK)\b/gi, '');
    }
    if (/\bCAST\s*\(/i.test(s)) s = s.replace(/\bAS\s+(?:UNSIGNED|SIGNED)\b/gi, 'AS INTEGER');
    if (/\bFIND_IN_SET\s*\(/i.test(s)) s = s.replace(/\bFIND_IN_SET\s*\(/gi, '__CISFIND__(');
    if (/(?:SELECT|,)\s+count\b/i.test(s)) s = s.replace(/((?:SELECT|,)\s+)count\b(?!\s*\()/gi, '$1"count"');
    // The configured database name, as MariaDB returns it (server.js).
    if (hasTok(s, 'DATABASE', 'database')) s = s.replace(/\bDATABASE\s*\(\s*\)/gi, 'cis_database()');
    s = s.replace(/\s+CONVERT\s+TO\s+CHARACTER\s+SET\s+\w+(?:\s+COLLATE\s+\w+)?/gi, '');
    // A _bin collation asks for a byte-for-byte compare, which SQLite's BINARY
    // is; the others go, and the column's own collation applies.
    s = s.replace(/\s+COLLATE\s+([A-Za-z0-9_]+)/gi, (all, c) => (/_bin$|^binary$/i.test(c) ? ' COLLATE BINARY' : ''));
    s = s.replace(/,\s*UNIQUE\s+KEY\s*\([^)]+\)/gi, '');
    if (/\bDROP\s+PRIMARY\s+KEY\s*,\s*\S/i.test(s)) s = s.replace(/\bDROP\s+PRIMARY\s+KEY\s*,\s*/gi, '');
    if (/\bDROP\s+COLUMN\s+IF\s+EXISTS\b/i.test(s)) s = s.replace(/\bDROP\s+COLUMN\s+IF\s+EXISTS\b/gi, 'DROP COLUMN');
    return s;
}

function callEndAt(sql, openParen) {
    let depth = 0;
    let q = null;
    for (let i = openParen; i < sql.length; i++) {
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

function rewriteJsonContainsPath(sql) {
    const re = /\bJSON_CONTAINS_PATH\s*\(/gi;
    let out = '';
    let i = 0;
    let m;
    while ((m = re.exec(sql))) {
        const open = m.index + m[0].length - 1;
        const end = callEndAt(sql, open);
        if (end < 0) break;
        const parts = splitArgs(sql.slice(open + 1, end)).map((p) => p.trim());
        const doc = parts[0] || 'NULL';
        const paths = parts.slice(2).filter(Boolean);
        const expr = paths.length
            ? '(' + paths.map((p) => 'json_extract(' + doc + ', ' + p + ') IS NOT NULL').join(' OR ') + ')'
            : '0';
        out += sql.slice(i, m.index) + expr;
        i = end + 1;
        re.lastIndex = i;
    }
    return out + sql.slice(i);
}

function rewriteTrimBoth(sql) {
    let s = String(sql).replace(/\bTRIM\s*\(\s*BOTH\s+(?:'[^']*'|"[^"]*")\s+FROM\s+/gi, 'TRIM(');
    if (/\bJSON_CONTAINS_PATH\s*\(/i.test(s)) s = rewriteJsonContainsPath(s);
    return s;
}

function rewriteCalls(sql) {
    MYSQL_HINT.lastIndex = 0;
    if (!MYSQL_HINT.test(sql) && !/\bCURRENT_TIMESTAMP\b|\bCURDATE\b|\bIF\s*\(/i.test(sql)) return sql;
    return resolveChunkMarkers(mapCode(rewriteFunctions(sql), rewriteCallsChunk, true));
}

// rewriteCallsChunk marks these calls; they are rendered on the whole statement
// because a quoted name or a string in the arguments splits the code chunk.
function resolveChunkMarkers(sql) {
    let s = sql;
    if (s.indexOf('__CISJLEN__(') >= 0) {
        s = rewriteMarkedCalls(s, '__CISJLEN__(', (args) => '(SELECT COUNT(*) FROM json_each(' + args.trim() + '))');
    }
    if (s.indexOf('__CISFIND__(') >= 0) {
        s = rewriteMarkedCalls(s, '__CISFIND__(', (args) => {
            const parts = splitArgs(args).map((p) => p.trim());
            const needle = parts[0] || "''";
            const hay = parts[1] || "''";
            return "(',' || " + hay + " || ',' LIKE '%,' || " + needle + " || ',%')";
        });
    }
    if (s.indexOf('__CISMAX__(') >= 0) {
        s = rewriteMarkedCalls(s, '__CISMAX__(', (args) => 'max(' + splitArgs(args).map((p) => p.trim()).join(', ') + ')');
    }
    return s;
}

function qlit(name) {
    return "'" + String(name).replace(/'/g, "''") + "'";
}

function splitTop(body) {
    const parts = [];
    let start = 0;
    let depth = 0;
    let q = null;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (q) {
            if (c === '\\') { i++; continue; }
            if (c === q) q = null;
            continue;
        }
        if (c === "'" || c === '"') { q = c; continue; }
        if (c === '(') depth++;
        else if (c === ')' && depth > 0) depth--;
        else if (c === ',' && depth === 0) {
            parts.push(body.slice(start, i).trim());
            start = i + 1;
        }
    }
    const last = body.slice(start).trim();
    if (last) parts.push(last);
    return parts;
}

function quoteIdent(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
}

function topKeyword(sql, word) {
    const re = new RegExp('\\b' + word + '\\b', 'gi');
    let m;
    while ((m = re.exec(sql))) {
        let depth = 0;
        let q = null;
        for (let i = 0; i < m.index; i++) {
            const c = sql[i];
            if (q) {
                if (c === q) q = null;
                continue;
            }
            if (c === "'" || c === '"') { q = c; continue; }
            if (c === '(') depth++;
            else if (c === ')' && depth > 0) depth--;
        }
        if (depth === 0) return m.index;
    }
    return -1;
}

function topSetAt(sql) {
    return topKeyword(sql, 'SET');
}

// ---- UPDATE ... JOIN ------------------------------------------------------------------
// SQLite has no multi-table UPDATE; these rewrite it to UPDATE ... FROM or to
// subqueries, keeping the ? parameters in order (joinUpdateKeepingParams).
function rewriteLeftJoinUpdate(sql) {
    if (!/\bLEFT\s+JOIN\b/i.test(sql)) return null;
    const setAt = topSetAt(sql);
    if (setAt < 0) return null;
    const head = sql.slice(0, setAt);
    const tail = sql.slice(setAt).replace(/^\s*SET\s+/i, '');
    if ((head.match(/\bJOIN\b/gi) || []).length !== 1) return null;
    const id = '(?:`([^`]+)`|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))';
    const re = new RegExp(
        '^\\s*UPDATE\\s+' + id + '(?:\\s+(?:AS\\s+)?' + id + ')?\\s+LEFT\\s+JOIN\\s+([\\s\\S]+?)\\s+ON\\s+([\\s\\S]+)$',
        'i'
    );
    const m = head.match(re);
    if (!m) return null;
    const pick = (i) => m[i] || m[i + 1] || m[i + 2];
    const t1 = pick(1);
    const a1 = pick(4) || t1;
    const joined = (m[7] || '').trim();
    let t2;
    let a2;
    if (joined[0] === '(') {
        let depth = 0;
        let q = null;
        let end = -1;
        for (let i = 0; i < joined.length; i++) {
            const c = joined[i];
            if (q) {
                if (c === q) q = null;
                continue;
            }
            if (c === "'" || c === '"') { q = c; continue; }
            if (c === '(') depth++;
            else if (c === ')' && depth > 0) {
                depth--;
                if (depth === 0) { end = i; break; }
            }
        }
        if (end < 0) return null;
        t2 = joined.slice(0, end + 1);
        const alias = joined.slice(end + 1).trim().match(/^(?:AS\s+)?(?:`([^`]+)`|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))$/i);
        a2 = alias && (alias[1] || alias[2] || alias[3]);
    } else {
        const joinedName = joined.match(/^(?:`([^`]+)`|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))(?:\s+(?:AS\s+)?(?:`([^`]+)`|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*)))?$/i);
        if (!joinedName) return null;
        t2 = joinedName[1] || joinedName[2] || joinedName[3];
        a2 = joinedName[4] || joinedName[5] || joinedName[6] || t2;
    }
    const derived = typeof t2 === 'string' && t2[0] === '(';
    if (!identOk(t1) || !identOk(a1) || !identOk(a2) || (!derived && !identOk(t2))) return null;
    const onExpr = m[8].trim();
    const whereAt = topKeyword(tail, 'WHERE');
    const setRaw = (whereAt < 0 ? tail : tail.slice(0, whereAt)).trim();
    const whereExpr = whereAt < 0 ? '' : tail.slice(whereAt).replace(/^\s*WHERE\s+/i, '').trim();
    const other = new RegExp('\\b' + a2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.([A-Za-z_][A-Za-z0-9_]*)', 'g');
    const from2 = derived ? t2 : quoteIdent(t2);
    const source = derived
        ? '(SELECT * FROM ' + from2 + ' AS ' + quoteIdent(a2) + ' WHERE ' + onExpr + ' LIMIT 1)'
        : null;
    const pull = (col) => derived
        ? '(SELECT ' + quoteIdent(col) + ' FROM ' + source + ')'
        : '(SELECT ' + quoteIdent(col) + ' FROM ' + from2 + ' AS ' + quoteIdent(a2) + ' WHERE ' + onExpr + ' LIMIT 1)';
    const lift = (text) => text.replace(other, (_, col) => pull(col));
    const lhsRe = new RegExp('^(?:"?' + a1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"?|"?' + t1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"?)\\s*\\.\\s*', 'i');
    const assigns = [];
    for (const part of splitTop(setRaw)) {
        const eq = part.indexOf('=');
        if (eq <= 0) return null;
        let lhs = part.slice(0, eq).trim().replace(/`/g, '').replace(lhsRe, '').replace(/"/g, '');
        if (!identOk(lhs)) return null;
        assigns.push(quoteIdent(lhs) + ' = ' + lift(part.slice(eq + 1).trim()));
    }
    if (!assigns.length) return null;
    const target = quoteIdent(t1) + (a1 !== t1 ? ' AS ' + quoteIdent(a1) : '');
    const out = 'UPDATE ' + target + ' SET ' + assigns.join(', ') + (whereExpr ? ' WHERE ' + lift(whereExpr) : '');
    return { sql: rewriteCalls(stripTicks(out)), extra: [] };
}

// UPDATE a JOIN b ON b.x = ? SET a.y = ? moves the ON clause after SET, and
// a LEFT JOIN's lands in each subquery that reads b, so the values went to
// the wrong ? (esx_vehicleshop set money to the operation id). Each ? is
// numbered first, in the caller's order, and SQLite binds ?N to the Nth
// value wherever it ends up. When the order comes out the same they are
// plain ? again.
function joinUpdateKeepingParams(sql) {
    let n = 0;
    const numbered = mapCode(sql, (chunk) => chunk.replace(/\?/g, () => '?' + (++n)));
    if (!n) return rewriteJoinUpdate(sql);
    const out = rewriteJoinUpdate(numbered);
    if (!out) return null;
    const seen = [];
    mapCode(out.sql, (chunk) => {
        chunk.replace(/\?(\d+)/g, (all, d) => { seen.push(Number(d)); return all; });
        return chunk;
    }, true);
    if (seen.length === n && seen.every((v, i) => v === i + 1)) out.sql = mapCode(out.sql, (chunk) => chunk.replace(/\?\d+/g, '?'), true);
    return out;
}

function rewriteJoinUpdate(sql) {
    // SQLite 3.33 UPDATE ... FROM. Only a single INNER or CROSS join. A single
    // LEFT JOIN becomes a correlated subquery so a missing row stays NULL.
    // RIGHT and a second JOIN stay on MariaDB.
    const left = rewriteLeftJoinUpdate(sql);
    if (left) return left;
    const id = '(?:`([^`]+)`|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))';
    const re = new RegExp(
        '^\\s*UPDATE\\s+' + id + '(?:\\s+(?:AS\\s+)?' + id + ')?\\s+(?:INNER\\s+|CROSS\\s+)?JOIN\\s+' + id + '(?:\\s+(?:AS\\s+)?' + id + ')?\\s+ON\\s+([\\s\\S]+?)\\s+SET\\s+([\\s\\S]+?)(?:\\s+WHERE\\s+([\\s\\S]+))?$',
        'i'
    );
    const quoted = sql.replace(/\b(order|group|index|key|table|column|row|run|input|match)\s*\./gi, '"$1".');
    const m = quoted.match(re);
    if (!m) return null;
    if (/\b(?:LEFT|RIGHT|FULL|OUTER)\s+JOIN\b/i.test(sql)) return null;
    const pick = (i) => m[i] || m[i + 1] || m[i + 2];
    const t1 = pick(1);
    const a1 = pick(4) || t1;
    const t2 = pick(7);
    const a2 = pick(10) || t2;
    if (!identOk(t1) || !identOk(a1) || !identOk(t2) || !identOk(a2)) return null;
    const onExpr = m[13].trim();
    const setRaw = m[14].trim();
    const whereExpr = m[15] ? m[15].trim() : '';
    const extra = [];
    const peel = (text) => {
        let rest = text;
        const found = [];
        while (true) {
            const at = rest.search(/\b(?:INNER\s+|CROSS\s+)?JOIN\b/i);
            if (at < 0) break;
            const head = rest.slice(0, at).trim();
            if (head) found.push(head);
            rest = rest.slice(at).replace(/^\s*(?:INNER\s+|CROSS\s+)?JOIN\s+/i, '');
            const alias = rest.match(/^(?:`([^`]+)`|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))(?:\s+(?:AS\s+)?(?:`([^`]+)`|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*)))?\s+ON\s+/i);
            if (!alias) return null;
            const table = alias[1] || alias[2] || alias[3];
            const name = alias[4] || alias[5] || alias[6] || table;
            if (!identOk(table) || !identOk(name)) return null;
            rest = rest.slice(alias[0].length);
            const next = rest.search(/\b(?:INNER\s+|CROSS\s+|LEFT\s+|RIGHT\s+)?JOIN\b|\bSET\b|\bWHERE\b/i);
            const pred = (next < 0 ? rest : rest.slice(0, next)).trim();
            extra.push({ table, name, pred });
            if (next < 0) { rest = ''; break; }
            rest = rest.slice(next);
        }
        if (rest.trim()) found.push(rest.trim());
        return found.join(' AND ');
    };
    const onClean = peel(onExpr);
    const setClean = peel(setRaw);
    const whereClean = whereExpr ? peel(whereExpr) : '';
    if (onClean == null || setClean == null || whereClean == null) return null;
    const q = (n) => '"' + n.replace(/"/g, '""') + '"';
    const parts = splitArgs(extra.length ? setClean : setRaw);
    const assigns = [];
    const lhsRe = new RegExp('^(?:"?' + a1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"?|"?' + t1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"?)\\s*\\.\\s*', 'i');
    for (let i = 0; i < parts.length; i++) {
        const eq = parts[i].indexOf('=');
        if (eq <= 0) return null;
        let lhs = parts[i].slice(0, eq).trim().replace(/`/g, '');
        const rhs = parts[i].slice(eq + 1).trim();
        lhs = lhs.replace(lhsRe, '').replace(/"/g, '');
        if (!identOk(lhs)) return null;
        assigns.push(q(lhs) + ' = ' + rhs);
    }
    if (!assigns.length) return null;
    const targetClause = q(t1) + (a1 !== t1 ? ' AS ' + q(a1) : '');
    const fromClause = q(t2) + (a2 !== t2 ? ' AS ' + q(a2) : '');
    let onUsed = extra.length ? onClean : onExpr;
    let whereUsed = extra.length ? whereClean : whereExpr;
    const exists = extra.map((join) => {
        const ref = new RegExp('(?:^|\\b)' + join.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.([A-Za-z_][A-Za-z0-9_]*)', 'g');
        const lift = (text) => text.replace(ref, '(SELECT "$1" FROM ' + q(join.table) + ' AS ' + q(join.name) + (join.pred ? ' WHERE ' + join.pred : '') + ' LIMIT 1)');
        onUsed = lift(onUsed);
        whereUsed = lift(whereUsed);
        for (let i = 0; i < assigns.length; i++) assigns[i] = lift(assigns[i]);
        return 'EXISTS (SELECT 1 FROM ' + q(join.table) + ' AS ' + q(join.name) + (join.pred ? ' WHERE ' + join.pred : '') + ')';
    }).join(' AND ');
    const fullWhere = [onUsed ? '(' + onUsed + ')' : '', whereUsed ? '(' + whereUsed + ')' : '', exists].filter(Boolean).join(' AND ');
    const out = 'UPDATE ' + targetClause + ' SET ' + assigns.join(', ') + ' FROM ' + fromClause + ' WHERE ' + fullWhere;
    return { sql: rewriteCalls(stripTicks(out)), extra: [] };
}


// information_schema as MariaDB answers it. Each table resources read is a
// TEMP view over sqlite_master, the pragmas and __cis_columns (the MariaDB
// type of each column, from hydration and from the DDL that made it), and
// the caller's query runs on it as written: its select list, LIKE, GROUP BY,
// HAVING and subqueries all mean what they mean on MariaDB. Tables it has no
// view for stay as written; SQLite then fails the read and MariaDB answers
// it. cis_database() and cis_collation() are server.js functions: the
// configured database and its default collation.
const INFO_PREFIX = '__cis_is_';
const INFO_TABLES = new Set(['tables', 'columns', 'statistics', 'table_constraints', 'key_column_usage', 'referential_constraints', 'schemata']);
const INFO_SHOWN = "m.type IN ('table', 'view') AND substr(m.name, 1, 7) <> 'sqlite_' AND substr(m.name, 1, 6) <> '__cis_'";
const INFO_DB = 'cis_database() COLLATE NOCASE';
const INFO_INDEX_SHOWN = "substr(il.name, 1, 11) <> '__cis_auto_'";
const INFO_PRIMARY = "(il.origin = 'pk' OR lower(il.name) = lower(m.name) || '_primary')";
// SQLite names index k of table t t_k (translateCreateTable, hydration); an
// unnamed UNIQUE is named after its first column, as MariaDB names it.
const INFO_INDEX_NAME = 'CASE WHEN ' + INFO_PRIMARY + " THEN 'PRIMARY'"
    + " WHEN il.origin = 'u' THEN (SELECT f.name FROM pragma_index_info(il.name) f WHERE f.seqno = 0)"
    + " WHEN lower(substr(il.name, 1, length(m.name) + 1)) = lower(m.name) || '_' THEN substr(il.name, length(m.name) + 2)"
    + ' ELSE il.name END';
const INFO_TEXT_TYPES = "('char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set')";
// A column __cis_columns has no row for (a table an older build made) is
// described from its SQLite type.
const INFO_DERIVED = "CASE WHEN instr(upper(c.type), 'INT') THEN 'int'"
    + " WHEN instr(upper(c.type), 'REAL') OR instr(upper(c.type), 'DOUB') OR instr(upper(c.type), 'FLOA') THEN 'double'"
    + " WHEN instr(upper(c.type), 'BLOB') THEN 'longblob'"
    + " WHEN upper(c.type) IN ('NUMERIC', 'DECIMAL') THEN 'decimal' ELSE 'longtext' END";
// The table's own collation: the __cis_columns row with its name and no column.
const INFO_TABLE_COLLATION = (t) => '(SELECT tc.collation FROM main."__cis_columns" tc WHERE tc.table_name = ' + t + " AND tc.column_name = '')";
const INFO_RULE = (r) => "CASE upper(" + r + ") WHEN 'NO ACTION' THEN 'RESTRICT' ELSE upper(" + r + ') END';

/** CREATE TEMP VIEW statements for the information_schema tables, in order. */
function infoSchemaViewsSql() {
    const v = (name, body) => 'CREATE TEMP VIEW IF NOT EXISTS ' + dq(INFO_PREFIX + name) + ' AS ' + body;
    const key = 'CASE'
        + ' WHEN EXISTS (SELECT 1 FROM pragma_index_list(x.t) il JOIN pragma_index_info(il.name) f WHERE '
        + "(il.origin = 'pk' OR lower(il.name) = lower(x.t) || '_primary') AND f.name = x.name COLLATE NOCASE) THEN 'PRI'"
        + " WHEN x.pk > 0 AND NOT EXISTS (SELECT 1 FROM pragma_index_list(x.t) il WHERE lower(il.name) = lower(x.t) || '_primary') THEN 'PRI'"
        + ' WHEN EXISTS (SELECT 1 FROM pragma_index_list(x.t) il WHERE il."unique" AND ' + INFO_INDEX_SHOWN
        + ' AND (SELECT COUNT(*) FROM pragma_index_info(il.name)) = 1 AND (SELECT f.name FROM pragma_index_info(il.name) f) = x.name COLLATE NOCASE)'
        + " THEN 'UNI'"
        + ' WHEN EXISTS (SELECT 1 FROM pragma_index_list(x.t) il JOIN pragma_index_info(il.name) f WHERE ' + INFO_INDEX_SHOWN
        + " AND f.seqno = 0 AND f.name = x.name COLLATE NOCASE) THEN 'MUL'"
        + " ELSE '' END";
    return [
        v('tables', "SELECT 'def' AS TABLE_CATALOG, " + INFO_DB + ' AS TABLE_SCHEMA, m.name COLLATE NOCASE AS TABLE_NAME,'
            + " CASE m.type WHEN 'view' THEN 'VIEW' ELSE 'BASE TABLE' END AS TABLE_TYPE,"
            + " CASE m.type WHEN 'view' THEN NULL ELSE 'InnoDB' END AS ENGINE, 10 AS VERSION,"
            + " CASE m.type WHEN 'view' THEN NULL ELSE 'Dynamic' END AS ROW_FORMAT,"
            + ' NULL AS TABLE_ROWS, NULL AS AVG_ROW_LENGTH, NULL AS DATA_LENGTH, NULL AS MAX_DATA_LENGTH, NULL AS INDEX_LENGTH, NULL AS DATA_FREE,'
            + " CASE WHEN instr(upper(m.sql), 'AUTOINCREMENT') THEN COALESCE((SELECT s.seq + 1 FROM main.sqlite_sequence s WHERE s.name = m.name), 1) END AS AUTO_INCREMENT,"
            + ' NULL AS CREATE_TIME, NULL AS UPDATE_TIME, NULL AS CHECK_TIME,'
            + " CASE m.type WHEN 'view' THEN NULL ELSE COALESCE(" + INFO_TABLE_COLLATION('m.name') + ', cis_collation()) END AS TABLE_COLLATION, NULL AS CHECKSUM,'
            + " '' AS CREATE_OPTIONS, '' AS TABLE_COMMENT, 0 AS MAX_INDEX_LENGTH, 'N' AS TEMPORARY"
            + ' FROM main.sqlite_master m WHERE ' + INFO_SHOWN),
        v('columns', "SELECT 'def' AS TABLE_CATALOG, " + INFO_DB + ' AS TABLE_SCHEMA, x.t COLLATE NOCASE AS TABLE_NAME,'
            + ' x.name COLLATE NOCASE AS COLUMN_NAME, x.cid + 1 AS ORDINAL_POSITION,'
            + ' CASE WHEN x.k IS NOT NULL THEN x.k_default WHEN x.hidden IN (2, 3) THEN NULL'
            + " WHEN x.dflt_value IS NULL THEN CASE WHEN x.nn THEN NULL ELSE 'NULL' END"
            + " WHEN upper(x.dflt_value) IN ('CURRENT_TIMESTAMP', '(" + LOCAL_NOW.toUpperCase().replace(/'/g, "''") + ")') THEN 'current_timestamp()'"
            + " WHEN upper(x.dflt_value) IN ('CURRENT_DATE', '(" + LOCAL_DATE.toUpperCase().replace(/'/g, "''") + ")') THEN 'curdate()'"
            + " WHEN upper(x.dflt_value) IN ('CURRENT_TIME', '(" + LOCAL_TIME.toUpperCase().replace(/'/g, "''") + ")') THEN 'curtime()'"
            + " WHEN substr(x.dflt_value, 1, 1) = '(' THEN substr(x.dflt_value, 2, length(x.dflt_value) - 2)"
            + ' ELSE x.dflt_value END AS COLUMN_DEFAULT,'
            + " COALESCE(x.k_null, CASE WHEN x.nn THEN 'NO' ELSE 'YES' END) AS IS_NULLABLE,"
            + ' x.data_type AS DATA_TYPE,'
            + " CASE WHEN x.k IS NOT NULL THEN x.k_len WHEN x.dd IN ('longtext', 'longblob') THEN 4294967295 END AS CHARACTER_MAXIMUM_LENGTH,"
            + " CASE WHEN x.k IS NOT NULL THEN CASE WHEN x.k_data IN ('char', 'varchar', 'enum', 'set') THEN x.k_len * 4 ELSE x.k_len END"
            + " WHEN x.dd IN ('longtext', 'longblob') THEN 4294967295 END AS CHARACTER_OCTET_LENGTH,"
            + " CASE WHEN x.k IS NOT NULL THEN x.k_prec WHEN x.dd = 'int' THEN 10 WHEN x.dd = 'double' THEN 22 WHEN x.dd = 'decimal' THEN 10 END AS NUMERIC_PRECISION,"
            + " CASE WHEN x.k IS NOT NULL THEN x.k_scale WHEN x.dd IN ('int', 'decimal') THEN 0 END AS NUMERIC_SCALE,"
            + ' x.k_dt AS DATETIME_PRECISION,'
            + " CASE WHEN x.coll IS NOT NULL THEN substr(x.coll, 1, instr(x.coll, '_') - 1) END AS CHARACTER_SET_NAME,"
            + ' x.coll AS COLLATION_NAME,'
            + " COALESCE(x.k_type, CASE x.dd WHEN 'int' THEN 'int(11)' WHEN 'decimal' THEN 'decimal(10,0)' ELSE x.dd END) AS COLUMN_TYPE,"
            + ' ' + key + ' AS COLUMN_KEY,'
            + " CASE WHEN x.k IS NOT NULL THEN x.k_extra WHEN x.hidden = 2 THEN 'VIRTUAL GENERATED' WHEN x.hidden = 3 THEN 'STORED GENERATED'"
            + " WHEN x.pk = 1 AND upper(x.type) = 'INTEGER' AND instr(upper(x.tsql), 'AUTOINCREMENT') THEN 'auto_increment' ELSE '' END AS EXTRA,"
            + " 'select,insert,update,references' AS PRIVILEGES, '' AS COLUMN_COMMENT,"
            + " CASE WHEN x.hidden IN (2, 3) THEN 'ALWAYS' ELSE 'NEVER' END AS IS_GENERATED, x.k_gen AS GENERATION_EXPRESSION"
            + ' FROM (SELECT y.*, COALESCE(y.k_data, y.dd) AS data_type,'
            + ' CASE WHEN COALESCE(y.k_data, y.dd) IN ' + INFO_TEXT_TYPES + ' THEN COALESCE(y.k_coll, ' + INFO_TABLE_COLLATION('y.t') + ', cis_collation()) END AS coll'
            + ' FROM (SELECT m.name AS t, m.sql AS tsql, c.cid, c.name, c.type, (c."notnull" OR c.pk > 0) AS nn, c.dflt_value, c.pk, c.hidden,'
            + ' k.table_name AS k, k.column_type AS k_type, k.data_type AS k_data, k.char_len AS k_len, k.num_prec AS k_prec,'
            + ' k.num_scale AS k_scale, k.dt_prec AS k_dt, k.collation AS k_coll, k.extra AS k_extra, k.column_default AS k_default,'
            + ' k.gen_expr AS k_gen, k.nullable AS k_null, ' + INFO_DERIVED + ' AS dd'
            + ' FROM main.sqlite_master m JOIN pragma_table_xinfo(m.name) c'
            + ' LEFT JOIN main."__cis_columns" k ON k.table_name = m.name AND k.column_name = c.name'
            + ' WHERE ' + INFO_SHOWN + ' AND c.hidden <> 1) y) x'),
        v('statistics', "SELECT 'def' AS TABLE_CATALOG, " + INFO_DB + ' AS TABLE_SCHEMA, m.name COLLATE NOCASE AS TABLE_NAME,'
            + ' CASE WHEN il."unique" THEN 0 ELSE 1 END AS NON_UNIQUE, ' + INFO_DB + ' AS INDEX_SCHEMA,'
            + ' (' + INFO_INDEX_NAME + ') COLLATE NOCASE AS INDEX_NAME, f.seqno + 1 AS SEQ_IN_INDEX, f.name COLLATE NOCASE AS COLUMN_NAME,'
            + " 'A' AS COLLATION, NULL AS CARDINALITY, NULL AS SUB_PART, NULL AS PACKED,"
            + ' CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info(m.name) tc WHERE tc.name = f.name AND (tc."notnull" OR tc.pk > 0))'
            + " THEN '' ELSE 'YES' END AS NULLABLE, 'BTREE' AS INDEX_TYPE, '' AS COMMENT, '' AS INDEX_COMMENT, 'NO' AS IGNORED"
            + ' FROM main.sqlite_master m JOIN pragma_index_list(m.name) il JOIN pragma_index_info(il.name) f'
            + " WHERE m.type = 'table' AND " + INFO_SHOWN + ' AND ' + INFO_INDEX_SHOWN
            // An INTEGER PRIMARY KEY is the rowid and has no index of its own.
            + " UNION ALL SELECT 'def', " + INFO_DB + ', m.name COLLATE NOCASE, 0, ' + INFO_DB + ", 'PRIMARY' COLLATE NOCASE, 1, c.name COLLATE NOCASE,"
            + " 'A', NULL, NULL, NULL, '', 'BTREE', '', '', 'NO'"
            + ' FROM main.sqlite_master m JOIN pragma_table_info(m.name) c'
            + " WHERE m.type = 'table' AND " + INFO_SHOWN + ' AND c.pk = 1'
            + ' AND NOT EXISTS (SELECT 1 FROM pragma_index_list(m.name) il WHERE ' + INFO_PRIMARY + ')'),
        v('table_constraints', "SELECT 'def' AS CONSTRAINT_CATALOG, s.TABLE_SCHEMA AS CONSTRAINT_SCHEMA, s.INDEX_NAME AS CONSTRAINT_NAME,"
            + " s.TABLE_SCHEMA AS TABLE_SCHEMA, s.TABLE_NAME AS TABLE_NAME, CASE WHEN s.INDEX_NAME = 'PRIMARY' THEN 'PRIMARY KEY' ELSE 'UNIQUE' END AS CONSTRAINT_TYPE"
            + ' FROM ' + dq(INFO_PREFIX + 'statistics') + ' s WHERE s.NON_UNIQUE = 0 AND s.SEQ_IN_INDEX = 1'
            + " UNION ALL SELECT 'def', " + INFO_DB + ", (m.name || '_ibfk_' || (fk.id + 1)) COLLATE NOCASE, " + INFO_DB + ", m.name COLLATE NOCASE, 'FOREIGN KEY'"
            + ' FROM main.sqlite_master m JOIN pragma_foreign_key_list(m.name) fk'
            + " WHERE m.type = 'table' AND " + INFO_SHOWN + ' AND fk.seq = 0'),
        v('key_column_usage', "SELECT 'def' AS CONSTRAINT_CATALOG, s.TABLE_SCHEMA AS CONSTRAINT_SCHEMA, s.INDEX_NAME AS CONSTRAINT_NAME,"
            + " 'def' AS TABLE_CATALOG, s.TABLE_SCHEMA AS TABLE_SCHEMA, s.TABLE_NAME AS TABLE_NAME, s.COLUMN_NAME AS COLUMN_NAME,"
            + ' s.SEQ_IN_INDEX AS ORDINAL_POSITION, NULL AS POSITION_IN_UNIQUE_CONSTRAINT, NULL AS REFERENCED_TABLE_SCHEMA,'
            + ' NULL AS REFERENCED_TABLE_NAME, NULL AS REFERENCED_COLUMN_NAME'
            + ' FROM ' + dq(INFO_PREFIX + 'statistics') + ' s WHERE s.NON_UNIQUE = 0'
            + " UNION ALL SELECT 'def', " + INFO_DB + ", (m.name || '_ibfk_' || (fk.id + 1)) COLLATE NOCASE, 'def', " + INFO_DB + ','
            + ' m.name COLLATE NOCASE, fk."from" COLLATE NOCASE, fk.seq + 1, fk.seq + 1, ' + INFO_DB + ', fk."table" COLLATE NOCASE, fk."to" COLLATE NOCASE'
            + ' FROM main.sqlite_master m JOIN pragma_foreign_key_list(m.name) fk'
            + " WHERE m.type = 'table' AND " + INFO_SHOWN),
        v('referential_constraints', "SELECT 'def' AS CONSTRAINT_CATALOG, " + INFO_DB + ' AS CONSTRAINT_SCHEMA,'
            + " (m.name || '_ibfk_' || (fk.id + 1)) COLLATE NOCASE AS CONSTRAINT_NAME, 'def' AS UNIQUE_CONSTRAINT_CATALOG,"
            + ' ' + INFO_DB + " AS UNIQUE_CONSTRAINT_SCHEMA, 'PRIMARY' AS UNIQUE_CONSTRAINT_NAME, 'NONE' AS MATCH_OPTION,"
            + ' ' + INFO_RULE('fk.on_update') + ' AS UPDATE_RULE, ' + INFO_RULE('fk.on_delete') + ' AS DELETE_RULE,'
            + ' m.name COLLATE NOCASE AS TABLE_NAME, fk."table" COLLATE NOCASE AS REFERENCED_TABLE_NAME'
            + ' FROM main.sqlite_master m JOIN pragma_foreign_key_list(m.name) fk'
            + " WHERE m.type = 'table' AND " + INFO_SHOWN + ' AND fk.seq = 0'),
        v('schemata', "SELECT 'def' AS CATALOG_NAME, " + INFO_DB + " AS SCHEMA_NAME, substr(cis_collation(), 1, instr(cis_collation(), '_') - 1) AS DEFAULT_CHARACTER_SET_NAME,"
            + " cis_collation() AS DEFAULT_COLLATION_NAME, NULL AS SQL_PATH, '' AS SCHEMA_COMMENT"),
    ];
}

// information_schema.<table> as the view for it; null when the statement
// names none it has a view for.
function mapInformationSchema(sql) {
    const toks = lexSql(sql);
    const name = (t) => (t && t.k === 'id' ? t.v.slice(1, -1) : t && t.k === 'word' ? t.v : null);
    let hit = false;
    for (let i = 0; i < toks.length; i++) {
        if (String(name(toks[i])).toLowerCase() !== 'information_schema') continue;
        let j = i + 1;
        while (toks[j] && toks[j].k === 'ws') j++;
        if (!toks[j] || toks[j].v !== '.') continue;
        let k = j + 1;
        while (toks[k] && toks[k].k === 'ws') k++;
        const table = String(name(toks[k]) || '').toLowerCase();
        if (!INFO_TABLES.has(table)) continue;
        toks[i] = { k: 'id', v: dq(INFO_PREFIX + table) };
        for (let x = i + 1; x <= k; x++) toks[x] = { k: 'ws', v: '' };
        hit = true;
        i = k;
    }
    return hit ? toks.map((t) => t.v).join('') : null;
}

function takeCall(s, marker, at) {
    const open = at + marker.length;
    let depth = 1;
    let j = open;
    let q = null;
    while (j < s.length && depth > 0) {
        const c = s[j];
        if (q) {
            if (c === q) q = null;
            j++;
            continue;
        }
        if (c === "'" || c === '"') { q = c; j++; continue; }
        if (c === '(') depth++;
        else if (c === ')') depth--;
        j++;
    }
    return { args: s.slice(open, j - 1), end: j };
}

function rewriteMarkedCalls(sql, marker, render) {
    let s = sql;
    for (let n = 0; n < 32; n++) {
        const at = s.lastIndexOf(marker);
        if (at < 0) break;
        const call = takeCall(s, marker, at);
        s = s.slice(0, at) + render(call.args) + s.slice(call.end);
    }
    return s;
}

function rewriteParenFns(sql) {
    if (!/\b(?:CONCAT|IF|JSON_CONTAINS|JSON_SEARCH)\s*\(/i.test(sql) && sql.indexOf('__CISFIELD__(') < 0) return sql;
    let s = mapCode(sql, (chunk) => {
        let x = chunk;
        x = x.replace(/\bCONCAT\s*\(/gi, '__CISCONCAT__(');
        x = x.replace(/\bIF\s*\(/gi, '__CISIF__(');
        x = x.replace(/\bJSON_CONTAINS\s*\(/gi, '__CISJCONTAINS__(');
        x = x.replace(/\bJSON_SEARCH\s*\(/gi, '__CISJSEARCH__(');
        return x;
    }, true);
    s = rewriteMarkedCalls(s, '__CISIF__(', (args) => {
        const parts = splitArgs(args);
        const cond = (parts[0] || '0').trim();
        const a = (parts[1] || "''").trim();
        const b = (parts[2] || "''").trim();
        return '(CASE WHEN ' + cond + ' THEN ' + a + ' ELSE ' + b + ' END)';
    });
    s = rewriteMarkedCalls(s, '__CISCONCAT__(', (args) => {
        const parts = splitArgs(args);
        if (!parts.length) return "''";
        // SQLite's || binds tighter than + and -: CONCAT('a', 1+2) is 'a3'
        // only with each argument in its own parentheses.
        return '(' + parts.map((p) => '(' + (p.trim() || "''") + ')').join(' || ') + ')';
    });
    s = rewriteMarkedCalls(s, '__CISFIELD__(', (args) => {
        const parts = splitArgs(args).map((p) => p.trim()).filter((p) => p);
        if (parts.length < 2) return '0';
        let out = '(CASE ' + parts[0] + ' ';
        for (let i = 1; i < parts.length; i++) out += 'WHEN ' + parts[i] + ' THEN ' + i + ' ';
        return out + 'ELSE 0 END)';
    });
    s = rewriteMarkedCalls(s, '__CISJSEARCH__(', (args) => {
        const parts = splitArgs(args).map((p) => p.trim());
        const doc = parts[0] || "''";
        const needle = parts[2] || "''";
        const path = parts[4] || null;
        if (path && /\[\*\]\.([A-Za-z0-9_]+)/.test(path)) {
            const key = path.match(/\[\*\]\.([A-Za-z0-9_]+)/)[1];
            return '(SELECT 1 FROM json_each(' + doc + ') WHERE json_extract(value, ' + qlit('$.' + key) + ') = ' + needle + ')';
        }
        return '(SELECT 1 FROM json_tree(' + doc + ') WHERE value = ' + needle + ')';
    });
    s = rewriteMarkedCalls(s, '__CISJCONTAINS__(', (args) => {
        const parts = splitArgs(args).map((p) => p.trim());
        const doc = parts[0] || "''";
        const cand = parts[1] || "''";
        const path = parts[2] || "'$'";
        return 'EXISTS (SELECT 1 FROM json_each(json_extract(' + doc + ', ' + path + ')) WHERE value = ' + cand + ' OR (json_valid(' + cand + ') AND value = json_extract(' + cand + ", '$')))";
    });
    return s;
}

function splitArgs(s) {
    const out = [];
    let depth = 0;
    let sq = 0;
    let curly = 0;
    let cur = '';
    let q = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (q) {
            cur += c;
            if (c === q && s[i + 1] === q) { cur += s[i + 1]; i++; continue; }
            if (c === q) q = null;
            continue;
        }
        if (c === "'" || c === '"') { q = c; cur += c; continue; }
        if (c === '(') { depth++; cur += c; continue; }
        if (c === ')') { depth--; cur += c; continue; }
        if (c === '[') { sq++; cur += c; continue; }
        if (c === ']') { sq--; cur += c; continue; }
        if (c === '{') { curly++; cur += c; continue; }
        if (c === '}') { curly--; cur += c; continue; }
        if (c === ',' && depth === 0 && sq === 0 && curly === 0) { out.push(cur); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim()) out.push(cur);
    return out;
}

// ---- INSERT, REPLACE, upsert, LIMIT and GROUP_CONCAT ----------------------------------
// Statement-shape rewrites: name clashes, INSERT ... SET, INSERT IGNORE,
// REPLACE, ON DUPLICATE KEY UPDATE, UPDATE/DELETE with LIMIT, GROUP_CONCAT.
// Column names that are also SQLite keywords or function names.
function quoteColumnWords(chunk) {
    let x = chunk.replace(/((?:SELECT|,)\s+)count\b(?!\s*\()/gi, '$1"count"');
    if (/\bgroup\b(?!\s+BY\b)/i.test(x)) x = x.replace(/\bgroup\b(?!\s+BY\b)/gi, '"group"');
    if (/(?:SELECT|,|\bSET)\s+text\b/i.test(x)) x = x.replace(/((?:SELECT|,|\bSET)\s+)text\b(?!\s*\()/gi, '$1"text"');
    return x;
}

function quoteNameClash(sql) {
    const from = sql.match(/\bFROM\s+(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))/i);
    const upd = sql.match(/^\s*UPDATE\s+(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))/i);
    const table = (from && (from[1] || from[2] || from[3])) || (upd && (upd[1] || upd[2] || upd[3]));
    if (!table || !identOk(table)) return sql;
    const re = new RegExp('(?<![.\\w"])\\b' + table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b(?![\\w"(])', 'gi');
    const quoted = '"' + table.replace(/"/g, '""') + '"';
    return mapOutsideStrings(sql, (chunk) => chunk.replace(re, quoted));
}

function unqualifyOwnColumns(sql) {
    const m = sql.match(/^\s*UPDATE\s+(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))\s+SET\b/i);
    if (!m) return sql;
    const table = m[1] || m[2] || m[3];
    if (!identOk(table)) return sql;
    const name = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('((?:SET|,)\\s*)(?:"' + name + '"|' + name + ')\\s*\\.\\s*', 'gi');
    const where = new RegExp('\\b(?:"' + name + '"|' + name + ')\\s*\\.\\s*([A-Za-z_][A-Za-z0-9_]*)', 'gi');
    return mapOutsideStrings(sql, (chunk) => chunk.replace(re, '$1').replace(where, '"$1"'));
}

function repairBareInsert(sql) {
    const m = sql.match(/^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+((?:`[^`]+`|"[^"]+"|[A-Za-z0-9_]+))(?:\s*\(([^)]*)\))?\s*$/i);
    if (!m) return sql;
    const table = m[1];
    const cols = m[2] ? m[2].split(',').map((c) => c.trim()).filter(Boolean) : [];
    if (!cols.length) return 'INSERT INTO ' + table + ' DEFAULT VALUES';
    return 'INSERT INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + cols.map(() => 'NULL').join(', ') + ')';
}

function bulkRow(sql) {
    const table = '(?:`[^`]+`|"[^"]+"|\'[^\']+\'|[A-Za-z0-9_.]+)';
    const cols = sql.match(new RegExp('^\\s*(?:INSERT|REPLACE)\\s+(?:OR\\s+\\w+\\s+|IGNORE\\s+)?INTO\\s+' + table + '\\s*\\(([^)]*)\\)\\s*VALUES\\s*\\?\\s*$', 'i'));
    if (cols) {
        const n = cols[1].split(',').filter((c) => c.trim()).length;
        if (n > 0 && n <= 64) return sql.replace(/VALUES\s*\?\s*$/i, 'VALUES (' + new Array(n).fill('?').join(', ') + ')');
    }
    if (/^\s*(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+|IGNORE\s+)?INTO\s+\S+\s*VALUES\s*\?\s*$/i.test(sql)) {
        return sql.replace(/VALUES\s*\?\s*$/i, 'VALUES (?)');
    }
    return null;
}

function rewriteInsertSet(sql) {
    const m = sql.match(/^\s*(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+|IGNORE\s+)?INTO\s+((?:`[^`]+`|"[^"]+"|'[^']+'|[A-Za-z0-9_.]+))\s+SET\s+([\s\S]+)$/i);
    if (!m) return sql;
    const verb = /^\s*REPLACE\b/i.test(sql) ? 'INSERT OR REPLACE'
        : /\bIGNORE\b/i.test(sql) ? 'INSERT OR IGNORE'
        : 'INSERT';
    if (/^\s*\?\s*$/.test(m[2])) return verb + ' INTO ' + m[1].replace(/`/g, '"').replace(/^'|'$/g, '"') + ' DEFAULT VALUES';
    const parts = splitArgs(m[2].replace(/;+\s*$/, ''));
    const cols = [];
    const vals = [];
    for (let i = 0; i < parts.length; i++) {
        const eq = parts[i].match(/^\s*((?:`[^`]+`|"[^"]+"|[A-Za-z0-9_]+))\s*=\s*([\s\S]+)$/);
        if (!eq) return sql;
        cols.push(eq[1].replace(/`/g, '"'));
        vals.push(eq[2].trim());
    }
    const table = m[1].replace(/`/g, '"');
    return verb + ' INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + vals.join(', ') + ')';
}

function rewriteInsertIgnore(sql) {
    return sql.replace(/^\s*INSERT\s+IGNORE\s+/i, 'INSERT OR IGNORE ');
}

function rewriteReplace(sql) {
    return sql.replace(/^\s*REPLACE\s+INTO\s+/i, 'INSERT OR REPLACE INTO ');
}

function indexOutsideKeyword(sql, needle) {
    const target = needle.toUpperCase();
    const nlen = needle.length;
    let i = 0;
    const n = sql.length;
    while (i < n) {
        const c = sql[i];
        if (c === "'" || c === '"' || c === '`') {
            const q = c;
            i++;
            while (i < n) {
                if (sql[i] === q) {
                    if (sql[i + 1] === q) { i += 2; continue; }
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        if ((c === 'O' || c === 'o') && sql.slice(i, i + nlen).toUpperCase() === target) {
            const prev = i === 0 ? 32 : sql.charCodeAt(i - 1);
            const next = i + nlen >= n ? 32 : sql.charCodeAt(i + nlen);
            const prevOk = !((prev >= 65 && prev <= 90) || (prev >= 97 && prev <= 122) || prev === 95);
            const nextOk = !((next >= 65 && next <= 90) || (next >= 97 && next <= 122) || next === 95);
            if (prevOk && nextOk) return i;
        }
        i++;
    }
    return -1;
}

// ON DUPLICATE KEY UPDATE fires on a clash with any PRIMARY or UNIQUE key,
// and so does an SQLite upsert with no conflict target (3.35+). The row is
// updated where it is. INSERT OR REPLACE is never used for it: that deletes
// the row, gives it a new id and resets every column the INSERT left out.
function rewriteOnDuplicate(sql) {
    const idx = indexOutsideKeyword(sql, 'ON DUPLICATE KEY UPDATE');
    if (idx < 0) return sql;
    let insertPart = sql.slice(0, idx).replace(/\s+$/, '').replace(/\bINTO\s+(?:"[^"]+"|[A-Za-z0-9_]+)\s*\.\s*/i, 'INTO ');
    let assigns = mapOutsideStrings(sql.slice(idx).replace(/^\s*ON\s+DUPLICATE\s+KEY\s+UPDATE\s+/i, ''), (chunk) =>
        chunk.replace(/\bVALUES\s*\(\s*(?:"([^"]+)"|([A-Za-z0-9_]+))\s*\)/gi, (full, a, b) => {
            const col = a || b;
            return identOk(col) ? 'excluded.' + identQuote(col) : full;
        }));
    // SQLite's DO UPDATE SET takes a bare column: `t.col = ...` (MariaDB
    // allows the table name) loses its qualifier. Targets only; the
    // expressions keep theirs.
    if (/^\s*(?:"[^"]+"|[A-Za-z_]\w*)\s*\.|,\s*(?:"[^"]+"|[A-Za-z_]\w*)\s*\./.test(assigns)) {
        assigns = splitArgs(assigns).map((p) => p.replace(/^(\s*)(?:"[^"]+"|[A-Za-z_]\w*)\s*\.\s*(?=(?:"[^"]+"|[A-Za-z_]\w*)\s*=)/, '$1')).join(',');
    }
    // INSERT ... SELECT needs a WHERE before ON CONFLICT, or SQLite reads
    // the ON as a join constraint.
    if (/^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+\S+(?:\s*\([^)]*\))?\s*SELECT\b/i.test(insertPart)
        && topKeyword(insertPart, 'WHERE') < 0 && topKeyword(insertPart, 'GROUP') < 0
        && topKeyword(insertPart, 'ORDER') < 0 && topKeyword(insertPart, 'LIMIT') < 0) {
        insertPart += ' WHERE true';
    }
    const into = /\bINTO\s+(?:"([^"]+)"|([A-Za-z_]\w*))/i.exec(insertPart);
    if (sequentialAssigns(assigns, into && (into[1] || into[2]))) {
        const sep = ' ON CONFLICT DO UPDATE SET ';
        const numbered = numberMarks(insertPart + sep + assigns);
        const at = numbered.indexOf(sep);
        insertPart = numbered.slice(0, at);
        assigns = sequentialAssigns(numbered.slice(at + sep.length), into && (into[1] || into[2]));
    }
    // The change guard repeats each assigned expression. One holding a ?
    // (qbx_core's `grade = ?`) is numbered first, so the guard's copy reads
    // the same value: SQLite binds ?N to the Nth one wherever it stands.
    let marks = 0;
    mapCode(assigns, (chunk) => { marks += (chunk.match(/\?/g) || []).length; return chunk; });
    if (marks) {
        const sep = ' ON CONFLICT DO UPDATE SET ';
        let n = 0;
        const numbered = mapCode(insertPart + sep + assigns, (chunk) => chunk.replace(/\?(?!\d)/g, () => '?' + (++n)));
        const at = numbered.indexOf(sep);
        const guard = at > 0 ? upsertChangeGuard(numbered.slice(0, at), numbered.slice(at + sep.length)) : '';
        if (guard) return numbered + guard;
    }
    return insertPart + ' ON CONFLICT DO UPDATE SET ' + assigns + upsertChangeGuard(insertPart, assigns);
}

// MariaDB counts a found row whose values stay the same as 1 affected row
// (2 when they change). SQLite updates it anyway, so a single-row upsert gets
// a WHERE that skips the update when every assigned column already holds its
// new value; the engine then reads 0 changes as found-and-unchanged. Compared
// as bytes (CAST AS BLOB), as MariaDB compares the stored row: 'abc' to 'ABC' is a
// change. Left out when an assignment holds a ? (the copy would need its own
// param) or the target is not a plain column, so the update runs as before.
function upsertChangeGuard(insertPart, assigns) {
    const v = /\bVALUES\s*(\([\s\S]*\))\s*$/i.exec(insertPart);
    if (!v || splitArgs(v[1]).length !== 1) return '';
    const parts = splitArgs(assigns.replace(/;+\s*$/, ''));
    const same = [];
    for (const p of parts) {
        const m = /^\s*(?:(?:"[^"]+"|[A-Za-z_]\w*)\s*\.\s*)?(?:"([^"]+)"|([A-Za-z_]\w*))\s*=\s*([\s\S]+?)\s*$/.exec(p);
        if (!m) return '';
        const col = m[1] || m[2];
        if (!identOk(col)) return '';
        // A plain ? cannot be repeated without a second value; a numbered
        // one (rewriteOnDuplicate) can.
        let marks = 0;
        mapOutsideStrings(m[3], (chunk) => { marks += (chunk.match(/\?(?!\d)/g) || []).length; return chunk; });
        if (marks) return '';
        same.push('CAST(' + identQuote(col) + ' AS BLOB) IS CAST((' + m[3] + ') AS BLOB)');
    }
    return same.length ? ' WHERE NOT (' + same.join(' AND ') + ')' : '';
}

// MariaDB runs the assignments of a single-table UPDATE and of ON DUPLICATE
// KEY UPDATE left to right: a column assigned earlier reads its new value in
// the assignments after it (`streak = streak + 1, best = GREATEST(best,
// streak)` compares with the new streak). SQLite reads the old row in every
// assignment. Each reference to an earlier-assigned column, bare or qualified
// by the target table, is replaced by that assignment's expression, so SQLite
// stores what MariaDB stores. `excluded.col` (VALUES(col)) is the inserted
// value and is left alone. Returns null when no assignment reads an earlier
// one. The caller numbers each ? first, so a copied ? binds the same value.
function sequentialAssigns(assigns, table) {
    const parts = splitArgs(assigns);
    if (parts.length < 2) return null;
    const own = table ? table.toLowerCase() : null;
    const done = new Map();
    const out = [];
    let changed = false;
    const ref = /((?:"[^"]+"|\b[A-Za-z_]\w*)\s*\.\s*)?(?:"([^"]+)"|\b([A-Za-z_]\w*)\b)(?!\s*[.(])/g;
    for (const p of parts) {
        const m = /^(\s*(?:"([^"]+)"|([A-Za-z_]\w*))\s*=)([\s\S]*)$/.exec(p);
        if (!m) return null;
        let expr = m[4];
        if (done.size) {
            const next = mapOutsideStrings(expr, (chunk) => chunk.replace(ref, (full, qual, a, b) => {
                const name = (a || b).toLowerCase();
                if (!done.has(name)) return full;
                if (qual && qual.replace(/["\s.]/g, '').toLowerCase() !== own) return full;
                return '(' + done.get(name) + ')';
            }));
            if (next !== expr) { changed = true; expr = next; }
        }
        out.push(m[1] + expr);
        done.set((m[2] || m[3]).toLowerCase(), expr.trim());
    }
    return changed ? out.join(',') : null;
}

// Numbers each bare ? (?1, ?2, ...) so a copy of an expression binds the same
// value; SQLite binds ?N to the Nth param wherever it stands.
function numberMarks(sql) {
    let n = 0;
    return mapOutsideStrings(sql, (chunk) => chunk.replace(/\?(\d*)/g, (full, d) => (d ? (n = Math.max(n, +d), full) : '?' + (++n))));
}

// A single-table UPDATE with assignments read left to right, as MariaDB
// does. A join UPDATE is left as it is: MariaDB gives it no order.
function sequentialUpdate(sql) {
    const m = /^\s*UPDATE\s+(?:"([^"]+)"|([A-Za-z_]\w*))\s+SET\s/i.exec(sql);
    if (!m || topKeyword(sql, 'FROM') >= 0) return sql;
    const table = m[1] || m[2];
    const setList = (s) => {
        let end = s.length;
        for (const w of ['WHERE', 'ORDER', 'LIMIT', 'RETURNING']) {
            const k = topKeyword(s, w);
            if (k >= m[0].length && k < end) end = k;
        }
        return end;
    };
    if (!sequentialAssigns(sql.slice(m[0].length, setList(sql)), table)) return sql;
    // Numbering only changes ? to ?N, so the SET keyword stays where it was.
    const numbered = numberMarks(sql);
    const stop = setList(numbered);
    return numbered.slice(0, m[0].length) + sequentialAssigns(numbered.slice(m[0].length, stop), table) + numbered.slice(stop);
}

function stripUpdateAlias(sql) {
    return sql.replace(/^(\s*UPDATE\s+(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*))\s+(?:AS\s+)?[A-Za-z_][A-Za-z0-9_]*\s+SET\b/i, '$1 SET');
}

// Top-level tokens of translated SQL: [index in toks, upper-case word] for
// each word outside parentheses.
function topWords(toks) {
    const out = [];
    let depth = 0;
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (t.k === 'lp') depth++;
        else if (t.k === 'rp') depth--;
        else if (depth === 0 && t.k === 'word') out.push([i, t.v.toUpperCase()]);
    }
    return out;
}

// UPDATE/DELETE ... [ORDER BY ...] LIMIT n. SQLite as Node ships it has no
// LIMIT there, and dropping it changed every matching row instead of n. The
// rows are picked by rowid in a subquery with the same WHERE, ORDER BY and
// LIMIT, so the ? placeholders keep their order. An ORDER BY without LIMIT
// only orders the work and is dropped.
function rewriteLimitUpdate(sql, kw) {
    if (kw !== 'UPDATE' && kw !== 'DELETE') return sql;
    if (!/\b(?:LIMIT|ORDER)\b/i.test(sql)) return sql;
    const toks = lexSql(sql.replace(/[\s;]+$/, ''));
    const words = topWords(toks);
    const find = (w, after) => { const x = words.find(([i, v]) => v === w && i > (after || -1)); return x ? x[0] : -1; };
    const limit = find('LIMIT');
    let order = -1;
    for (const [i, v] of words) if (v === 'ORDER' && toks.slice(i + 1).find((t) => t.k !== 'ws').v.toUpperCase() === 'BY') order = i;
    if (limit < 0 && order < 0) return sql;
    const text = (a, b) => toks.slice(a, b).map((t) => t.v).join('');
    const end = order >= 0 ? order : limit;
    if (limit < 0) return text(0, order).trimEnd();
    const where = find('WHERE');
    // The table: after DELETE FROM, or after UPDATE.
    const nameAt = find(kw === 'DELETE' ? 'FROM' : 'UPDATE');
    let k = nameAt + 1;
    while (k < toks.length && toks[k].k === 'ws') k++;
    const table = toks[k];
    if (!table || (table.k !== 'id' && table.k !== 'word')) return sql;
    const head = text(0, where >= 0 ? where : end).trimEnd();
    const cond = where >= 0 ? ' WHERE ' + text(where + 1, end).trim() : '';
    const tail = text(end, toks.length).trim();
    return head + ' WHERE rowid IN (SELECT rowid FROM ' + table.v + cond + ' ' + tail + ')';
}

// DELETE t FROM t JOIN u ON ... WHERE ... (and DELETE FROM t USING t JOIN u)
// deletes the rows of t the join selects: as SQLite, the rowids of t from
// the same join in a subquery. MySQL text in, MySQL text out; the rest of
// translate rewrites the functions inside. Deleting from several tables in
// one statement has no SQLite form.
function joinDeleteSql(sql) {
    const toks = lexSql(sql.replace(/[\s;]+$/, ''));
    const solid = [];
    for (let i = 0; i < toks.length; i++) if (toks[i].k !== 'ws') solid.push(i);
    const W = (j) => (toks[solid[j]] && toks[solid[j]].k === 'word' ? toks[solid[j]].v.toUpperCase() : '');
    const name = (j) => {
        const t = toks[solid[j]];
        if (!t) return null;
        if (t.k === 'id') return t.v.slice(1, -1);
        return t.k === 'word' ? t.v : null;
    };
    let j = 1;
    while (W(j) === 'LOW_PRIORITY' || W(j) === 'QUICK' || W(j) === 'IGNORE') j++;
    let targets = [];
    let from;
    if (W(j) === 'FROM') {
        // DELETE FROM t USING refs: the multi-table form; otherwise single-table.
        let u = j + 1;
        while (u < solid.length && W(u) !== 'USING' && W(u) !== 'WHERE') u++;
        if (W(u) !== 'USING') return null;
        for (let x = j + 1; x < u; x++) if (toks[solid[x]].k !== 'comma') targets.push(name(x));
        from = u;
    } else {
        let f = j;
        while (f < solid.length && W(f) !== 'FROM') f++;
        if (f >= solid.length) return null;
        for (let x = j; x < f; x++) {
            const t = toks[solid[x]];
            if (t.k === 'comma' || t.v === '.' || t.v === '*') continue;
            targets.push(name(x));
        }
        from = f;
    }
    targets = targets.filter((t) => t != null);
    if (targets.length !== 1) {
        if (targets.length > 1) throw new Error('cis_database: no SQLite form for a DELETE from several tables in one statement');
        return null;
    }
    // FROM refs [WHERE ...]: find the target among table [AS] alias pairs.
    const refsAt = solid[from] + 1;
    const NOT_ALIAS = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'CROSS', 'OUTER', 'NATURAL', 'STRAIGHT_JOIN', 'ON', 'USING', 'WHERE', 'AS']);
    let depth = 0;
    let table = null;
    let alias = null;
    let expectTable = true;
    for (let x = from + 1; x < solid.length; x++) {
        const t = toks[solid[x]];
        if (t.k === 'lp') { depth++; continue; }
        if (t.k === 'rp') { depth--; continue; }
        if (depth) continue;
        const w = W(x);
        if (w === 'WHERE') break;
        if (t.k === 'comma' || w === 'JOIN' || w === 'STRAIGHT_JOIN') { expectTable = true; continue; }
        if (w === 'ON' || w === 'USING') { expectTable = false; continue; }
        if (!expectTable || (t.k !== 'id' && t.k !== 'word') || NOT_ALIAS.has(w)) continue;
        const tn = name(x);
        let an = tn;
        let y = x + 1;
        if (W(y) === 'AS') y++;
        const at = toks[solid[y]];
        if (at && (at.k === 'id' || at.k === 'word') && !NOT_ALIAS.has(W(y))) { an = name(y); x = y; }
        expectTable = false;
        if (an.toLowerCase() === targets[0].toLowerCase() || (tn.toLowerCase() === targets[0].toLowerCase() && an === tn)) {
            table = tn;
            alias = an;
            break;
        }
    }
    if (!table || !identOk(table) || !identOk(alias)) return null;
    const rest = toks.slice(refsAt).map((t) => t.v).join('');
    return 'DELETE FROM `' + table + '` WHERE rowid IN (SELECT `' + alias + '`.rowid FROM' + rest + ')';
}

// GROUP_CONCAT([DISTINCT] a [, b ...] [ORDER BY ...] [SEPARATOR s]) as
// SQLite's group_concat(x, s ORDER BY ...). MySQL joins several arguments
// into one value; SQLite would take the second as the separator. DISTINCT
// with a separator other than ',' has no SQLite form and is left as it is,
// so SQLite refuses it and MariaDB answers.
function rewriteGroupConcat(sql) {
    const toks = lexSql(sql);
    let out = '';
    let i = 0;
    while (i < toks.length) {
        const t = toks[i];
        let k = i + 1;
        while (k < toks.length && toks[k].k === 'ws') k++;
        if (!(t.k === 'word' && t.v.toUpperCase() === 'GROUP_CONCAT' && toks[k] && toks[k].k === 'lp')) { out += t.v; i++; continue; }
        let depth = 0;
        let close = -1;
        for (let x = k; x < toks.length; x++) {
            if (toks[x].k === 'lp') depth++;
            else if (toks[x].k === 'rp' && --depth === 0) { close = x; break; }
        }
        if (close < 0) { out += t.v; i++; continue; }
        const inner = toks.slice(k + 1, close);
        const words = [];
        depth = 0;
        for (let x = 0; x < inner.length; x++) {
            if (inner[x].k === 'lp') depth++;
            else if (inner[x].k === 'rp') depth--;
            else if (depth === 0) words.push(x);
        }
        const upAt = (x) => (inner[x] && inner[x].k === 'word' ? inner[x].v.toUpperCase() : '');
        let distinct = false;
        let first = 0;
        while (first < inner.length && inner[first].k === 'ws') first++;
        if (upAt(first) === 'DISTINCT') { distinct = true; first++; }
        let orderAt = -1;
        let sepAt = -1;
        for (const x of words) {
            if (upAt(x) === 'ORDER' && orderAt < 0) orderAt = x;
            if (upAt(x) === 'SEPARATOR') sepAt = x;
        }
        const argEnd = [orderAt, sepAt, inner.length].filter((x) => x >= 0).reduce((a, b) => Math.min(a, b));
        const args = [];
        let from = first;
        depth = 0;
        for (let x = first; x < argEnd; x++) {
            if (inner[x].k === 'lp') depth++;
            else if (inner[x].k === 'rp') depth--;
            else if (inner[x].k === 'comma' && depth === 0) { args.push(inner.slice(from, x)); from = x + 1; }
        }
        args.push(inner.slice(from, argEnd));
        const txt = (list) => rewriteGroupConcat(list.map((x) => x.v).join('').trim());
        let sep = "','";
        if (sepAt >= 0) {
            const st = inner.slice(sepAt + 1).find((x) => x.k !== 'ws');
            if (!st || st.k !== 'str' && st.k !== 'id') { out += toks.slice(i, close + 1).map((x) => x.v).join(''); i = close + 1; continue; }
            sep = st.k === 'id' && st.v[0] === '"' ? "'" + st.v.slice(1, -1).replace(/'/g, "''") + "'" : st.v;
        }
        const order = orderAt >= 0 ? ' ' + inner.slice(orderAt, sepAt > orderAt ? sepAt : inner.length).map((x) => x.v).join('').trim() : '';
        if (distinct && sep !== "','") { out += toks.slice(i, close + 1).map((x) => x.v).join(''); i = close + 1; continue; }
        const expr = args.length > 1 ? args.map((a) => '(' + txt(a) + ')').join(' || ') : txt(args[0]);
        out += 'group_concat(' + (distinct ? 'DISTINCT ' + expr : expr + ', ' + sep) + order + ')';
        i = close + 1;
    }
    return out;
}

// ---- DDL translation ------------------------------------------------------------------------
// CREATE TABLE, CREATE/DROP INDEX, ALTER TABLE, DROP and RENAME are read on
// tokens of the caller's text, one clause at a time. A clause that has no
// SQLite form and only matters to MariaDB (ENGINE, COLLATE, a FULLTEXT
// parser, a foreign key added later) is dropped; MariaDB still gets the
// whole statement. A clause the parser does not know makes the statement
// untranslatable: SQLite refuses it and the caller sees the error, rather
// than a table that differs from MariaDB's.
//
// SQLite index names are global, MariaDB's belong to a table, so an index
// is named table_index in SQLite, as hydration names them.

function ddlState(sql) {
    const all = lexSql(sql);
    const t = [];
    for (let i = 0; i < all.length; i++) if (all[i].k !== 'ws') t.push({ k: all[i].k, v: all[i].v, i });
    return { all, t, p: 0 };
}

const ddlUp = (tok) => (tok && tok.k === 'word' ? tok.v.toUpperCase() : '');

function ddlName(tok) {
    if (!tok) return null;
    if (tok.k === 'id') {
        const q = tok.v[0];
        return tok.v.slice(1, -1).split(q + q).join(q);
    }
    if (tok.k === 'word') return tok.v;
    return null;
}

// Consumes the given words when they come next.
function ddlAccept(ps, ...words) {
    for (let k = 0; k < words.length; k++) if (ddlUp(ps.t[ps.p + k]) !== words[k]) return false;
    ps.p += words.length;
    return true;
}

// A table or index name, without a database qualifier.
function ddlTakeName(ps) {
    let name = ddlName(ps.t[ps.p]);
    if (name == null) return null;
    ps.p++;
    while (ps.t[ps.p] && ps.t[ps.p].v === '.' && ddlName(ps.t[ps.p + 1]) != null) {
        name = ddlName(ps.t[ps.p + 1]);
        ps.p += 2;
    }
    return name;
}

// Index of the ) that closes the ( at token a.
function ddlClose(ps, a) {
    let depth = 0;
    for (let i = a; i < ps.t.length; i++) {
        if (ps.t[i].k === 'lp') depth++;
        else if (ps.t[i].k === 'rp' && --depth === 0) return i;
    }
    return -1;
}

// The caller's text from token a to token b, both included.
function ddlText(ps, a, b) {
    if (b < a) return '';
    let out = '';
    for (let i = ps.t[a].i; i <= ps.t[b].i; i++) out += ps.all[i].v;
    return out;
}

// Token ranges [a, b] of the comma-separated items between a and b.
function ddlItems(ps, a, b) {
    const out = [];
    let depth = 0;
    let from = a;
    for (let i = a; i <= b; i++) {
        const k = ps.t[i].k;
        if (k === 'lp') depth++;
        else if (k === 'rp') depth--;
        else if (k === 'comma' && depth === 0) {
            if (i > from) out.push([from, i - 1]);
            from = i + 1;
        }
    }
    if (b >= from) out.push([from, b]);
    return out;
}

const dq = (name) => '"' + String(name).replace(/"/g, '""') + '"';

// MySQL code in a DEFAULT, CHECK or generated column, as SQLite.
function ddlExpr(expr) {
    let s = stripTicks(expr);
    s = rewriteFunctions(s);
    s = resolveChunkMarkers(mapCode(s, rewriteCallsChunk, true));
    if (/\b(?:CONCAT|IF|JSON_CONTAINS|JSON_SEARCH)\s*\(/i.test(s) || s.indexOf('__CISFIELD__(') >= 0) s = rewriteParenFns(s);
    return s;
}

const INT_TYPES = new Set(['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'INTEGER', 'BIGINT', 'INT1', 'INT2', 'INT3', 'INT4', 'INT8',
    'BIT', 'BOOL', 'BOOLEAN', 'YEAR', 'SERIAL', 'MIDDLEINT']);
const REAL_TYPES = new Set(['DECIMAL', 'DEC', 'NUMERIC', 'FIXED', 'FLOAT', 'DOUBLE', 'REAL', 'FLOAT4', 'FLOAT8']);
const BLOB_TYPES = new Set(['BLOB', 'TINYBLOB', 'MEDIUMBLOB', 'LONGBLOB', 'BINARY', 'VARBINARY']);
const TEXT_TYPES = new Set(['CHAR', 'VARCHAR', 'NCHAR', 'NVARCHAR', 'TEXT', 'TINYTEXT', 'MEDIUMTEXT', 'LONGTEXT', 'JSON',
    'ENUM', 'SET', 'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'UUID', 'INET4', 'INET6', 'CHARACTER', 'NATIONAL',
    'LONG', 'VARCHAR2', 'CLOB', 'GEOMETRY', 'POINT', 'LINESTRING', 'POLYGON', 'ROW']);

function sqliteTypeOf(base) {
    if (INT_TYPES.has(base)) return 'INTEGER';
    if (REAL_TYPES.has(base)) return 'REAL';
    if (BLOB_TYPES.has(base)) return 'BLOB';
    if (TEXT_TYPES.has(base)) return 'TEXT';
    return null;
}

const NOW_WORDS = new Set(['CURRENT_TIMESTAMP', 'NOW', 'LOCALTIMESTAMP', 'LOCALTIME', 'SYSDATE', 'UTC_TIMESTAMP']);
const DATE_WORDS = new Set(['CURRENT_DATE', 'CURDATE', 'UTC_DATE']);
const TIME_WORDS = new Set(['CURRENT_TIME', 'CURTIME', 'UTC_TIME']);

// The value after DEFAULT, as SQLite. base is the column's MySQL type.
function ddlDefault(ps, end, base) {
    const tok = ps.t[ps.p];
    if (!tok || ps.p > end) return { bad: true };
    const clock = (w) => {
        if (DATE_WORDS.has(w)) return 'CURRENT_DATE';
        if (TIME_WORDS.has(w)) return base === 'TIME' ? 'CURRENT_TIME' : (base === 'DATETIME' || base === 'TIMESTAMP' ? 'CURRENT_TIMESTAMP' : 'CURRENT_TIME');
        return base === 'DATE' ? 'CURRENT_DATE' : base === 'TIME' ? 'CURRENT_TIME' : 'CURRENT_TIMESTAMP';
    };
    if (tok.k === 'lp') {
        const close = ddlClose(ps, ps.p);
        if (close < 0 || close > end) return { bad: true };
        const inner = ddlState(ddlText(ps, ps.p + 1, close - 1));
        ps.p = close + 1;
        const w = ddlUp(inner.t[0]);
        const rest = inner.t.slice(1);
        if ((NOW_WORDS.has(w) || DATE_WORDS.has(w) || TIME_WORDS.has(w))
            && (rest.length === 0 || (rest[0].k === 'lp' && rest[rest.length - 1].k === 'rp' && rest.length <= 3))) {
            return { sql: clock(w) };
        }
        if (inner.t.length === 1 && (inner.t[0].k === 'num' || inner.t[0].k === 'str')) return { sql: inner.t[0].v };
        return { sql: '(' + ddlExpr(ddlText(inner, 0, inner.t.length - 1)) + ')' };
    }
    if (tok.k === 'str' || tok.k === 'num') {
        ps.p++;
        return { sql: tok.v };
    }
    if (tok.k === 'op' && (tok.v === '-' || tok.v === '+') && ps.t[ps.p + 1] && ps.t[ps.p + 1].k === 'num') {
        ps.p += 2;
        return { sql: (tok.v === '-' ? '-' : '') + ps.t[ps.p - 1].v };
    }
    if (tok.k !== 'word') return { bad: true };
    const w = tok.v.toUpperCase();
    const next = ps.t[ps.p + 1];
    if (w === 'NULL') { ps.p++; return { sql: null }; }
    if (w === 'TRUE' || w === 'FALSE') { ps.p++; return { sql: w === 'TRUE' ? '1' : '0' }; }
    if ((w === 'B' || w === 'X') && next && next.k === 'str' && ps.t[ps.p].i + 1 === next.i) {
        ps.p += 2;
        const body = next.v.slice(1, -1);
        if (w === 'B') return /^[01]+$/.test(body) ? { sql: String(parseInt(body, 2)) } : { bad: true };
        return /^[0-9A-Fa-f]*$/.test(body) ? { sql: "X'" + body + "'" } : { bad: true };
    }
    if (w[0] === '_' && next && next.k === 'str') { ps.p += 2; return { sql: next.v }; }
    if (NOW_WORDS.has(w) || DATE_WORDS.has(w) || TIME_WORDS.has(w)) {
        ps.p++;
        if (ps.t[ps.p] && ps.t[ps.p].k === 'lp') {
            const close = ddlClose(ps, ps.p);
            if (close < 0 || close > end) return { bad: true };
            ps.p = close + 1;
        }
        return { sql: clock(w) };
    }
    if (next && next.k === 'lp') {
        const close = ddlClose(ps, ps.p + 1);
        if (close < 0 || close > end) return { bad: true };
        const text = ddlText(ps, ps.p, close);
        ps.p = close + 1;
        return { sql: '(' + ddlExpr(text) + ')' };
    }
    return { bad: true };
}

// Column names of an index or key list, prefix lengths dropped.
function ddlKeyCols(ps, open) {
    const close = ddlClose(ps, open);
    if (close < 0) return null;
    const cols = [];
    for (const [a, b] of ddlItems(ps, open + 1, close - 1)) {
        const name = ddlName(ps.t[a]);
        if (name == null || !identOk(name)) return null;
        let desc = false;
        for (let i = a + 1; i <= b; i++) if (ddlUp(ps.t[i]) === 'DESC') desc = true;
        cols.push({ name, desc });
    }
    ps.p = close + 1;
    return cols.length ? cols : null;
}

// Skips USING BTREE, COMMENT '...', KEY_BLOCK_SIZE = n, WITH PARSER x,
// VISIBLE/INVISIBLE, CLUSTERING = YES after an index definition.
function ddlIndexTail(ps, end) {
    while (ps.p <= end) {
        const w = ddlUp(ps.t[ps.p]);
        if (w === 'USING') ps.p += 2;
        else if (w === 'COMMENT') ps.p += 2;
        else if (w === 'KEY_BLOCK_SIZE' || w === 'CLUSTERING') { ps.p++; if (ps.t[ps.p] && ps.t[ps.p].v === '=') ps.p++; ps.p++; }
        else if (w === 'WITH' && ddlUp(ps.t[ps.p + 1]) === 'PARSER') ps.p += 3;
        else if (w === 'VISIBLE' || w === 'INVISIBLE' || w === 'IGNORED' || w === 'NOT') ps.p++;
        else break;
    }
}

function ddlRefActions(ps, end) {
    let out = '';
    while (ps.p <= end) {
        if (ddlAccept(ps, 'MATCH')) { ps.p++; continue; }
        if (ddlUp(ps.t[ps.p]) !== 'ON') break;
        const what = ddlUp(ps.t[ps.p + 1]);
        if (what !== 'DELETE' && what !== 'UPDATE') return null;
        ps.p += 2;
        let act;
        if (ddlAccept(ps, 'CASCADE')) act = 'CASCADE';
        else if (ddlAccept(ps, 'RESTRICT')) act = 'RESTRICT';
        else if (ddlAccept(ps, 'NO', 'ACTION')) act = 'NO ACTION';
        else if (ddlAccept(ps, 'SET', 'NULL')) act = 'SET NULL';
        else if (ddlAccept(ps, 'SET', 'DEFAULT')) act = 'SET DEFAULT';
        else return null;
        out += ' ON ' + what + ' ' + act;
    }
    return out;
}

// REFERENCES t (cols) [MATCH x] [ON DELETE a] [ON UPDATE b]
function ddlReference(ps, end) {
    const table = ddlTakeName(ps);
    if (table == null || !identOk(table) || !ps.t[ps.p] || ps.t[ps.p].k !== 'lp') return null;
    const cols = ddlKeyCols(ps, ps.p);
    if (!cols) return null;
    const actions = ddlRefActions(ps, end);
    if (actions == null) return null;
    return { table, cols: cols.map((c) => c.name), actions };
}

/**
 * One column definition, from its name to the end of the item.
 * @returns {object|null} null when a clause is not understood.
 */
function ddlColumn(ps, end) {
    const name = ddlName(ps.t[ps.p]);
    if (name == null || !identOk(name)) return null;
    ps.p++;
    // args, unsigned, zerofill, charset, collate: the MySQL type as written,
    // for information_schema (mysqlColumnMeta).
    const col = { name, base: '', type: null, notNull: false, dflt: undefined, ai: false, pk: false, unique: false, checks: [], gen: null, ref: null, onUpdate: false,
        args: null, unsigned: false, zerofill: false, charset: null, collate: null, binary: false };
    const first = ddlUp(ps.t[ps.p]);
    if (first && sqliteTypeOf(first)) {
        col.base = first;
        ps.p++;
        if (first === 'DOUBLE') ddlAccept(ps, 'PRECISION');
        if (first === 'NATIONAL' || first === 'LONG') { col.base = ddlUp(ps.t[ps.p]) || first; ps.p++; }
        if ((first === 'CHARACTER' || first === 'CHAR') && ddlAccept(ps, 'VARYING')) col.base = 'VARCHAR';
        if (ps.t[ps.p] && ps.t[ps.p].k === 'lp') {
            const close = ddlClose(ps, ps.p);
            if (close < 0 || close > end) return null;
            col.args = ddlText(ps, ps.p + 1, close - 1);
            ps.p = close + 1;
        }
        col.type = sqliteTypeOf(first);
        if (first === 'SERIAL') { col.ai = true; col.notNull = true; col.unique = true; }
    }
    const optName = () => {
        if (ps.t[ps.p] && ps.t[ps.p].v === '=') ps.p++;
        const tok = ps.t[ps.p++];
        if (!tok) return null;
        return tok.k === 'str' ? tok.v.slice(1, -1) : ddlName(tok);
    };
    while (ps.p <= end) {
        const w = ddlUp(ps.t[ps.p]);
        if (w === 'UNSIGNED') col.unsigned = true;
        if (w === 'ZEROFILL') { col.zerofill = true; col.unsigned = true; }
        // VARCHAR(n) BINARY is the charset's _bin collation.
        if (w === 'BINARY') col.binary = true;
        if (w === 'UNSIGNED' || w === 'SIGNED' || w === 'ZEROFILL' || w === 'BINARY' || w === 'ASCII' || w === 'UNICODE'
            || w === 'BYTE' || w === 'VISIBLE' || w === 'INVISIBLE' || w === 'COMPRESSED') { ps.p++; continue; }
        if (ddlAccept(ps, 'CHARACTER', 'SET') || ddlAccept(ps, 'CHARSET')) { col.charset = optName(); continue; }
        if (ddlAccept(ps, 'COLLATE')) { col.collate = optName(); continue; }
        if (ddlAccept(ps, 'NOT', 'NULL')) { col.notNull = true; continue; }
        if (ddlAccept(ps, 'NULL')) { col.notNull = false; continue; }
        if (ddlAccept(ps, 'DEFAULT')) {
            const d = ddlDefault(ps, end, col.base);
            if (d.bad) return null;
            col.dflt = d.sql;
            continue;
        }
        if (ddlAccept(ps, 'AUTO_INCREMENT')) { col.ai = true; continue; }
        if (ddlAccept(ps, 'PRIMARY', 'KEY') || ddlAccept(ps, 'KEY')) { col.pk = true; continue; }
        if (ddlAccept(ps, 'UNIQUE')) { ddlAccept(ps, 'KEY'); col.unique = true; continue; }
        if (ddlAccept(ps, 'COMMENT')) { ps.p++; continue; }
        if (ddlAccept(ps, 'ON', 'UPDATE')) {
            const d = ddlDefault(ps, end, col.base);
            if (d.bad) return null;
            col.onUpdate = true;
            continue;
        }
        if (w === 'CONSTRAINT' && ddlUp(ps.t[ps.p + 2]) === 'CHECK') { ps.p += 2; continue; }
        if (ddlAccept(ps, 'CHECK')) {
            if (!ps.t[ps.p] || ps.t[ps.p].k !== 'lp') return null;
            const close = ddlClose(ps, ps.p);
            if (close < 0 || close > end) return null;
            col.checks.push(ddlExpr(ddlText(ps, ps.p + 1, close - 1)));
            ps.p = close + 1;
            continue;
        }
        if (ddlAccept(ps, 'GENERATED', 'ALWAYS', 'AS') || ddlAccept(ps, 'AS')) {
            if (!ps.t[ps.p] || ps.t[ps.p].k !== 'lp') return null;
            const close = ddlClose(ps, ps.p);
            if (close < 0 || close > end) return null;
            col.gen = { expr: ddlExpr(ddlText(ps, ps.p + 1, close - 1)), raw: ddlText(ps, ps.p + 1, close - 1), stored: false };
            ps.p = close + 1;
            if (ddlAccept(ps, 'STORED') || ddlAccept(ps, 'PERSISTENT')) col.gen.stored = true;
            else ddlAccept(ps, 'VIRTUAL');
            continue;
        }
        if (ddlAccept(ps, 'REFERENCES')) {
            col.ref = ddlReference(ps, end);
            if (!col.ref) return null;
            continue;
        }
        if (ddlAccept(ps, 'COLUMN_FORMAT') || ddlAccept(ps, 'STORAGE')) { ps.p++; continue; }
        if (ddlAccept(ps, 'SERIAL', 'DEFAULT', 'VALUE')) { col.ai = true; col.notNull = true; col.unique = true; continue; }
        if (ddlAccept(ps, 'WITH', 'SYSTEM', 'VERSIONING') || ddlAccept(ps, 'WITHOUT', 'SYSTEM', 'VERSIONING')) continue;
        return null;
    }
    return col;
}

// The column as SQLite DDL. add: for ALTER TABLE ADD COLUMN, which cannot
// take a time or expression default, PRIMARY KEY or UNIQUE.
// Text MariaDB compares without case (a _ci collation: the column's, the
// table's or the database's) is NOCASE in SQLite, so = and UNIQUE ignore
// case as they do there. fallback is the collation a column with none of
// its own takes.
const FOLD_TYPES = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'set', 'enum']);
function foldsCase(col, tableCollate, tableCharset, fallback) {
    if (col.type !== 'TEXT' || /^binary$/i.test(String(col.charset || ''))) return false;
    const m = mysqlColumnMeta(col, tableCollate, tableCharset);
    return FOLD_TYPES.has(m.data_type) && /_ci$/i.test(m.collation || fallback || '');
}

// The collations a table's new columns fall back to: its own, then the
// database's (utf8mb4_general_ci when nothing says).
function defaultCollation(table) {
    let info = null;
    try { info = collationProvider && identOk(table) ? collationProvider(table) : null; } catch (e) { info = null; }
    return { table: (info && info.table) || null, db: (info && info.dflt) || 'utf8mb4_general_ci' };
}

function ddlColumnSql(col, opts) {
    let s = dq(col.name) + (col.type ? ' ' + col.type : '') + (opts.fold ? ' COLLATE NOCASE' : '');
    if (opts.aiPk) return s + ' PRIMARY KEY AUTOINCREMENT';
    if (col.notNull || opts.pkCol) s += ' NOT NULL';
    let dflt = col.dflt;
    if (opts.add && dflt != null && (/^CURRENT_/.test(dflt) || dflt[0] === '(')) dflt = undefined;
    if (opts.add && col.notNull && dflt == null && !col.gen) {
        // MariaDB fills existing rows with the type's zero value.
        dflt = col.type === 'INTEGER' || col.type === 'REAL' ? '0' : col.type === 'BLOB' ? "X''" : "''";
    }
    if (dflt != null && !col.gen) s += ' DEFAULT ' + (CLOCK_SQL[dflt] ? '(' + CLOCK_SQL[dflt] + ')' : dflt);
    for (const c of col.checks) s += ' CHECK (' + c + ')';
    if (col.gen) s += ' GENERATED ALWAYS AS (' + col.gen.expr + ')' + (col.gen.stored ? ' STORED' : ' VIRTUAL');
    if (col.ref) s += ' REFERENCES ' + dq(col.ref.table) + ' (' + col.ref.cols.map(dq).join(', ') + ')' + col.ref.actions;
    return s;
}

// What MariaDB's information_schema.COLUMNS says about a column it built from
// this definition. Migrations read these to decide what to ALTER (esx widens
// identifier when CHARACTER_MAXIMUM_LENGTH < 60), and a wrong answer leaves
// MariaDB's column narrower than the data SQLite then sends it. The rules are
// MariaDB 10.11's: integer display widths, decimal(10,0), text lengths in
// characters, JSON as longtext, enum values requoted without spaces.
const INT_WIDTH = { TINYINT: [4, 3, 3], SMALLINT: [6, 5, 5], MEDIUMINT: [9, 8, 7], MIDDLEINT: [9, 8, 7], INT: [11, 10, 10],
    INTEGER: [11, 10, 10], BIGINT: [20, 20, 19], INT1: [4, 3, 3], INT2: [6, 5, 5], INT3: [9, 8, 7], INT4: [11, 10, 10], INT8: [20, 20, 19] };
const INT_NAME = { INTEGER: 'int', MIDDLEINT: 'mediumint', INT1: 'tinyint', INT2: 'smallint', INT3: 'mediumint', INT4: 'int', INT8: 'bigint' };
const LONG_TYPES = { TINYTEXT: 255, TEXT: 65535, MEDIUMTEXT: 16777215, LONGTEXT: 4294967295, JSON: 4294967295, LONG: 16777215,
    TINYBLOB: 255, BLOB: 65535, MEDIUMBLOB: 16777215, LONGBLOB: 4294967295 };
const CHARSET_COLLATION = { utf8mb4: 'utf8mb4_general_ci', utf8mb3: 'utf8mb3_general_ci', utf8: 'utf8mb3_general_ci',
    latin1: 'latin1_swedish_ci', ascii: 'ascii_general_ci', binary: null };

/**
 * @param {object} col from ddlColumn
 * @param {string|null} tableCollate the table's COLLATE option
 * @param {string|null} tableCharset the table's CHARSET option
 * @returns {object} a __cis_columns row without table_name; collation null
 *   on a text column means the database default
 */
function mysqlColumnMeta(col, tableCollate, tableCharset) {
    const base = col.base;
    const nums = col.args != null && /^\s*\d+\s*(?:,\s*\d+\s*)?$/.test(col.args) ? col.args.split(',').map((x) => Number(x.trim())) : null;
    const sign = (col.unsigned ? ' unsigned' : '') + (col.zerofill ? ' zerofill' : '');
    // nullable: MODIFY and CHANGE can make a column NOT NULL in MariaDB that
    // stays nullable in SQLite.
    const m = { column_name: col.name, column_type: null, data_type: null, char_len: null, num_prec: null, num_scale: null, dt_prec: null,
        collation: null, extra: '', column_default: null, gen_expr: null, nullable: col.notNull || col.pk || col.ai ? 'NO' : 'YES' };
    let text = false;
    if (base === 'BOOL' || base === 'BOOLEAN') {
        Object.assign(m, { data_type: 'tinyint', column_type: 'tinyint(1)', num_prec: 3, num_scale: 0 });
    } else if (INT_WIDTH[base]) {
        const w = INT_WIDTH[base];
        const t = INT_NAME[base] || base.toLowerCase();
        Object.assign(m, { data_type: t, column_type: t + '(' + (nums ? nums[0] : col.unsigned ? w[1] : w[0]) + ')' + sign,
            num_prec: t === 'bigint' && col.unsigned ? 20 : w[2], num_scale: 0 });
    } else if (base === 'SERIAL') {
        Object.assign(m, { data_type: 'bigint', column_type: 'bigint(20) unsigned', num_prec: 20, num_scale: 0 });
    } else if (base === 'DECIMAL' || base === 'DEC' || base === 'NUMERIC' || base === 'FIXED') {
        const p = nums ? nums[0] : 10;
        const s = nums && nums.length > 1 ? nums[1] : 0;
        Object.assign(m, { data_type: 'decimal', column_type: 'decimal(' + p + ',' + s + ')' + sign, num_prec: p, num_scale: s });
    } else if (base === 'FLOAT' || base === 'FLOAT4') {
        const dbl = nums && nums.length === 1 && nums[0] > 24;
        const t = dbl ? 'double' : 'float';
        const two = nums && nums.length === 2;
        Object.assign(m, { data_type: t, column_type: t + (two ? '(' + nums[0] + ',' + nums[1] + ')' : '') + sign,
            num_prec: two ? nums[0] : dbl ? 22 : 12, num_scale: two ? nums[1] : null });
    } else if (base === 'DOUBLE' || base === 'REAL' || base === 'FLOAT8') {
        const two = nums && nums.length === 2;
        Object.assign(m, { data_type: 'double', column_type: 'double' + (two ? '(' + nums[0] + ',' + nums[1] + ')' : '') + sign,
            num_prec: two ? nums[0] : 22, num_scale: two ? nums[1] : null });
    } else if (base === 'BIT') {
        const n = nums ? nums[0] : 1;
        Object.assign(m, { data_type: 'bit', column_type: 'bit(' + n + ')', num_prec: n });
    } else if (base === 'CHAR' || base === 'CHARACTER' || base === 'NCHAR') {
        const n = nums ? nums[0] : 1;
        Object.assign(m, { data_type: 'char', column_type: 'char(' + n + ')', char_len: n });
        text = true;
    } else if (base === 'VARCHAR' || base === 'NVARCHAR' || base === 'VARCHAR2') {
        const n = nums ? nums[0] : 255;
        Object.assign(m, { data_type: 'varchar', column_type: 'varchar(' + n + ')', char_len: n });
        text = true;
    } else if (base === 'BINARY' || base === 'VARBINARY') {
        const n = nums ? nums[0] : 1;
        const t = base.toLowerCase();
        Object.assign(m, { data_type: t, column_type: t + '(' + n + ')', char_len: n });
    } else if (LONG_TYPES[base]) {
        const t = base === 'JSON' ? 'longtext' : base === 'LONG' ? 'mediumtext' : base.toLowerCase();
        Object.assign(m, { data_type: t, column_type: t, char_len: LONG_TYPES[base] });
        text = !/blob$/.test(t);
    } else if (base === 'DATETIME' || base === 'TIMESTAMP' || base === 'TIME') {
        const fsp = nums ? nums[0] : 0;
        const t = base.toLowerCase();
        Object.assign(m, { data_type: t, column_type: t + (fsp ? '(' + fsp + ')' : ''), dt_prec: fsp });
    } else if (base === 'DATE') {
        Object.assign(m, { data_type: 'date', column_type: 'date' });
    } else if (base === 'YEAR') {
        Object.assign(m, { data_type: 'year', column_type: 'year(4)' });
    } else if (base === 'ENUM' || base === 'SET') {
        const vals = [];
        String(col.args || '').replace(/'((?:[^'\\]|''|\\.)*)'|"((?:[^"\\]|""|\\.)*)"/g, (all, a, b) => {
            vals.push(a != null ? a.replace(/''/g, "'") : b.replace(/""/g, '"'));
            return all;
        });
        const t = base.toLowerCase();
        const len = base === 'SET' ? vals.reduce((n, v) => n + v.length, 0) + Math.max(0, vals.length - 1) : vals.reduce((n, v) => Math.max(n, v.length), 0);
        Object.assign(m, { data_type: t, column_type: t + '(' + vals.map((v) => "'" + v.replace(/'/g, "''") + "'").join(',') + ')', char_len: len });
        text = true;
    } else {
        const t = (base || 'longtext').toLowerCase();
        Object.assign(m, { data_type: t, column_type: t + (col.args != null ? '(' + col.args.trim() + ')' : '') });
    }
    // MariaDB's JSON is longtext COLLATE utf8mb4_bin.
    if (base === 'JSON' && !col.collate && !col.charset) m.collation = 'utf8mb4_bin';
    else if (text) {
        const cs = col.charset || (col.collate ? null : tableCharset);
        m.collation = col.collate || (col.charset ? CHARSET_COLLATION[String(cs).toLowerCase()] || null : tableCollate || (cs ? CHARSET_COLLATION[String(cs).toLowerCase()] || null : null));
        if (col.binary && !col.collate) m.collation = (CHARSET_COLLATION[String(cs || 'utf8mb4').toLowerCase()] || 'utf8mb4_general_ci').replace(/_[a-z]+_ci$/, '_bin');
    }
    if (col.ai) m.extra = 'auto_increment';
    else if (col.onUpdate) m.extra = 'on update current_timestamp(' + (m.dt_prec ? m.dt_prec : '') + ')';
    if (col.gen) {
        m.extra = col.gen.stored ? 'STORED GENERATED' : 'VIRTUAL GENERATED';
        m.gen_expr = col.gen.raw;
        return m;
    }
    const d = col.dflt;
    if (d == null) m.column_default = col.notNull || col.ai || col.pk ? null : 'NULL';
    else if (/^NULL$/i.test(d)) m.column_default = 'NULL';
    else if (d === 'CURRENT_TIMESTAMP') m.column_default = 'current_timestamp(' + (m.dt_prec ? m.dt_prec : '') + ')';
    else if (d === 'CURRENT_DATE') m.column_default = 'curdate()';
    else if (d === 'CURRENT_TIME') m.column_default = 'curtime()';
    else if (d[0] === '(' && d[d.length - 1] === ')') m.column_default = d.slice(1, -1);
    else if (base === 'BIT' && /^\d+$/.test(d)) m.column_default = "b'" + Number(d).toString(2) + "'";
    else if (m.num_prec != null && /^'-?\d+(\.\d+)?'$/.test(d)) m.column_default = d.slice(1, -1);
    else m.column_default = d;
    return m;
}

// ---- Triggers that emulate MySQL column behaviour ------------------------------------------------
// ON UPDATE CURRENT_TIMESTAMP and ADD COLUMN ... DEFAULT <time or
// expression> have no SQLite form, so a trigger does what MariaDB does:
// stamp the column when another column of the row changed and this one was
// not, or fill it when an INSERT left it out. server.js keeps these
// triggers in step with ALTER TABLE; the column is in the trigger's name.
const ON_UPDATE_TRIGGER = 'cis_on_update:';
const DEFAULT_TRIGGER = 'cis_default:';

// gated: skip the rewrites strict mode's store triggers make (cis_storing()
// is their depth); server.js builds them so once it has the function.
function onUpdateTriggerSql(table, col, cols, gated) {
    if (!identOk(table) || !identOk(col)) return null;
    const others = cols.filter((c) => identOk(c) && c.toLowerCase() !== col.toLowerCase());
    if (!others.length) return null;
    return 'CREATE TRIGGER IF NOT EXISTS ' + dq(ON_UPDATE_TRIGGER + table + ':' + col) + ' AFTER UPDATE ON ' + dq(table)
        + ' FOR EACH ROW WHEN ' + (gated ? 'cis_storing() = 0 AND ' : '') + 'NEW.' + dq(col) + ' IS OLD.' + dq(col)
        + ' AND (' + others.map((c) => 'NEW.' + dq(c) + ' IS NOT OLD.' + dq(c)).join(' OR ') + ')'
        + ' BEGIN UPDATE ' + dq(table) + ' SET ' + dq(col) + ' = ' + LOCAL_NOW + ' WHERE rowid = NEW.rowid; END';
}

function insertDefaultTriggerSql(table, col, expr) {
    if (!identOk(table) || !identOk(col)) return null;
    return 'CREATE TRIGGER IF NOT EXISTS ' + dq(DEFAULT_TRIGGER + table + ':' + col) + ' AFTER INSERT ON ' + dq(table)
        + ' FOR EACH ROW WHEN NEW.' + dq(col) + ' IS NULL'
        + ' BEGIN UPDATE ' + dq(table) + ' SET ' + dq(col) + ' = ' + expr + ' WHERE rowid = NEW.rowid; END';
}

// MariaDB in strict mode (STRICT_TRANS_TABLES, its default) refuses a value
// its column cannot hold. SQLite stores it, and the replica then refuses the
// write SQLite kept. These triggers refuse the value here first, with
// MariaDB's message, so the write fails for its caller and reaches neither
// database. server.js turns cis_strict() off for INSERT IGNORE and UPDATE
// IGNORE and when the replica's sql_mode is not strict; MariaDB then stores
// the value cut to fit. Each check is one MariaDB 10.11 refuses (probed on
// 10.11.14); a value MariaDB takes with only a note, such as spaces past a
// VARCHAR's length or digits past a DECIMAL's scale, is let through. Dates
// are checked only for text with no digit at all, which MariaDB never takes.
const STRICT_TRIGGER = 'cis_strict:';
const INT_RANGE = {
    tinyint: [-128, 127, 255], smallint: [-32768, 32767, 65535],
    mediumint: [-8388608, 8388607, 16777215], int: [-2147483648, 2147483647, 4294967295],
};
const LOB_BYTES = { tinytext: 255, text: 65535, mediumtext: 16777215, tinyblob: 255, blob: 65535, mediumblob: 16777215 };

// The values of ENUM('a','b') as written in a column type.
function enumValues(columnType) {
    const m = /^\s*enum\s*\(([\s\S]*)\)\s*$/i.exec(String(columnType || ''));
    if (!m) return null;
    const out = [];
    const re = /'((?:[^']|'')*)'/g;
    let x;
    while ((x = re.exec(m[1]))) out.push(x[1].replace(/''/g, "'"));
    return out.length ? out : null;
}

// [condition, message] pairs for one column; X is the value (NEW."col").
function strictChecks(c, X) {
    const name = String(c.column_name);
    const dt = String(c.data_type || '').toLowerCase();
    const ct = String(c.column_type || '').toLowerCase();
    if (/generated/i.test(String(c.extra || '')) || /auto_increment/i.test(String(c.extra || ''))) return [];
    const at = " for column '" + name + "' at row 1";
    const ql = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    const num = "typeof(" + X + ") IN ('integer', 'real')";
    const out = [];
    if (INT_RANGE[dt]) {
        const [lo, hi, uhi] = INT_RANGE[dt];
        const range = /unsigned/.test(ct) ? '(' + X + ' < 0 OR round(' + X + ') > ' + uhi + ')' : '(round(' + X + ') < ' + lo + ' OR round(' + X + ') > ' + hi + ')';
        out.push([num + ' AND ' + range, 'Out of range value' + at]);
        out.push(["typeof(" + X + ") = 'text'", 'Incorrect integer value' + at]);
    } else if (dt === 'bigint') {
        if (/unsigned/.test(ct)) out.push([num + ' AND ' + X + ' < 0', 'Out of range value' + at]);
        out.push(["typeof(" + X + ") = 'text'", 'Incorrect integer value' + at]);
    } else if (dt === 'decimal') {
        const p = Number(c.num_prec);
        const s = Number(c.num_scale) || 0;
        if (p > 0 && p - s < 300) out.push([num + ' AND abs(round(' + X + ', ' + s + ')) >= 1e' + (p - s), 'Out of range value' + at]);
        out.push(["typeof(" + X + ") = 'text'", 'Incorrect decimal value' + at]);
    } else if (dt === 'double' || dt === 'float') {
        out.push(["typeof(" + X + ") = 'text'", 'Incorrect double value' + at]);
    } else if ((dt === 'varchar' || dt === 'char') && Number(c.char_len) > 0) {
        out.push(["length(rtrim(" + X + ", ' ')) > " + Number(c.char_len), 'Data too long' + at]);
    } else if ((dt === 'varbinary' || dt === 'binary') && Number(c.char_len) > 0) {
        out.push(['length(CAST(' + X + ' AS BLOB)) > ' + Number(c.char_len), 'Data too long' + at]);
    } else if (LOB_BYTES[dt]) {
        // TEXT limits are bytes in the column's character set; SQLite's text
        // is UTF-8, so only a utf8 column is counted in bytes.
        const bytes = /blob$/.test(dt) || !c.collation || /^utf8/i.test(String(c.collation));
        out.push([(bytes ? 'length(CAST(' + X + ' AS BLOB))' : 'length(' + X + ')') + ' > ' + LOB_BYTES[dt], 'Data too long' + at]);
    } else if (dt === 'enum') {
        const vals = enumValues(c.column_type);
        if (!vals) return [];
        // A _ci collation matches any case; a number is the value's position.
        const ci = !/_(?:bin|cs)$/i.test(String(c.collation || ''));
        const v = ci ? "lower(rtrim(" + X + ", ' '))" : "rtrim(" + X + ", ' ')";
        const list = vals.map((x) => ql(ci ? x.toLowerCase() : x)).join(', ');
        const index = "(trim(" + X + ") GLOB '[0-9]*' AND NOT trim(" + X + ") GLOB '*[^0-9.]*' AND round(CAST(" + X + " AS REAL)) BETWEEN 1 AND " + vals.length + ')';
        out.push([X + ' IS NOT NULL AND ' + v + ' NOT IN (' + list + ') AND NOT ' + index, 'Data truncated' + at]);
    } else if (dt === 'date' || dt === 'datetime' || dt === 'timestamp') {
        out.push(["typeof(" + X + ") = 'text' AND " + X + " NOT GLOB '*[0-9]*'", 'Incorrect ' + (dt === 'date' ? 'date' : 'datetime') + ' value' + at]);
    }
    // A utf8mb3 column holds no character past U+FFFF (an emoji), an ascii
    // column none past U+007F. GLOB compares a range by code point.
    const top = charsetTop(c.collation);
    if (top && CHARSET_TYPES.has(dt)) {
        out.push(["typeof(" + X + ") = 'text' AND " + X + " GLOB ('*[' || char(" + (top + 1) + ") || '-' || char(1114111) || ']*')", 'Incorrect string value' + at]);
    }
    return out;
}

const CHARSET_TYPES = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext']);

// The highest code point a column's character set stores, from its
// collation, or 0 for one that stores them all (utf8mb4) or is not known.
function charsetTop(collation) {
    const c = String(collation || '').toLowerCase();
    if (/^(?:utf8|utf8mb3)_/.test(c)) return 0xffff;
    if (/^ascii_/.test(c)) return 0x7f;
    return 0;
}

// What MariaDB stores for a value it takes, when that is not the value as
// given: [need(X), value(X)] for one column, or null. MariaDB rounds a real
// to an integer column (110.00000000000001 is 110) and to a DECIMAL's or a
// DOUBLE(M,D)'s scale, cuts trailing spaces past a VARCHAR's length, and
// stores an ENUM value as the type spells it (or by its position). Where
// strict mode refused, INSERT IGNORE, UPDATE IGNORE and a sql_mode that is
// not strict clamp a number to the type's range, cut a string to its length
// and store '' for an ENUM value it does not have.
function storedValue(c) {
    const dt = String(c.data_type || '').toLowerCase();
    const ct = String(c.column_type || '').toLowerCase();
    if (/generated/i.test(String(c.extra || '')) || /auto_increment/i.test(String(c.extra || ''))) return null;
    const ql = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    const unsigned = /unsigned/.test(ct);
    // Only a real is rounded: round() of a 64-bit integer is a double and
    // would lose its low digits. lo and hi are the range as SQL literals.
    const ranged = (s, lo, hi) => [
        (X) => "(typeof(" + X + ") = 'real' AND " + X + ' <> round(' + X + ', ' + s + '))'
            + (lo != null ? " OR (typeof(" + X + ") IN ('integer', 'real') AND (" + X + ' < ' + lo + (hi != null ? ' OR ' + X + ' > ' + hi : '') + '))' : ''),
        (X) => {
            let v = "CASE WHEN typeof(" + X + ") = 'real' THEN round(" + X + ', ' + s + ') ELSE ' + X + ' END';
            if (hi != null) v = 'min(' + hi + ', ' + v + ')';
            return lo != null ? 'max(' + lo + ', ' + v + ')' : v;
        },
    ];
    if (INT_RANGE[dt]) {
        const [lo, hi, uhi] = INT_RANGE[dt];
        return unsigned ? ranged(0, 0, uhi) : ranged(0, lo, hi);
    }
    if (dt === 'bigint') return ranged(0, unsigned ? 0 : null, null);
    if (dt === 'decimal') {
        const p = Number(c.num_prec);
        const s = Number(c.num_scale) || 0;
        if (!(p > 0) || p - s >= 300) return ranged(s, unsigned ? 0 : null, null);
        const max = (p - s ? '9'.repeat(p - s) : '0') + (s ? '.' + '9'.repeat(s) : '');
        return ranged(s, unsigned ? 0 : '-' + max, max);
    }
    if (dt === 'double' || dt === 'float') {
        const m = /\(\s*\d+\s*,\s*(\d+)\s*\)/.exec(ct);
        return m ? ranged(Number(m[1]), unsigned ? 0 : null, null) : null;
    }
    if ((dt === 'varchar' || dt === 'char') && Number(c.char_len) > 0) {
        const n = Number(c.char_len);
        return [(X) => 'length(' + X + ') > ' + n, (X) => 'substr(' + X + ', 1, ' + n + ')'];
    }
    if (dt === 'enum') {
        const vals = enumValues(c.column_type);
        if (!vals) return null;
        const ci = !/_(?:bin|cs)$/i.test(String(c.collation || ''));
        const exact = vals.map(ql).join(', ');
        return [
            // The column compares NOCASE; the stored spelling is checked byte for byte.
            (X) => X + ' IS NOT NULL AND ' + X + " <> '' AND " + X + ' COLLATE BINARY NOT IN (' + exact + ')',
            (X) => 'CASE ' + (ci ? "lower(rtrim(" + X + ", ' '))" : "rtrim(" + X + ", ' ')")
                + vals.map((v) => ' WHEN ' + ql(ci ? v.toLowerCase() : v) + ' THEN ' + ql(v)).join('')
                + " WHEN '' THEN '' ELSE CASE WHEN trim(" + X + ") GLOB '[0-9]*' AND NOT trim(" + X + ") GLOB '*[^0-9.]*' THEN CASE CAST(round(CAST(" + X + ' AS REAL)) AS INTEGER)'
                + vals.map((v, i) => ' WHEN ' + (i + 1) + ' THEN ' + ql(v)).join('') + " ELSE '' END ELSE '' END END",
        ];
    }
    return null;
}

/**
 * Strict-mode triggers for a table, from its MariaDB column types
 * (server.js's column meta): a BEFORE INSERT and a BEFORE UPDATE trigger
 * that refuse what MariaDB refuses, and an AFTER INSERT and an AFTER UPDATE
 * trigger that store what MariaDB stores (storedValue); none when no column
 * needs either. skip names columns not to check (the rowid alias, which a
 * BEFORE INSERT trigger sees as -1). An UPDATE checks only the columns it
 * changes, so a row SQLite stored before these triggers existed still takes
 * changes to its other columns. temp: TEMP triggers on main."table", which
 * live on the connection that makes them and stay out of the file's schema.
 */
function strictTriggersSql(table, cols, skip, temp) {
    if (!identOk(table)) return [];
    const skipped = new Set((skip || []).map((x) => String(x).toLowerCase()));
    const checks = [];
    const stores = [];
    for (const c of cols || []) {
        if (!c || !identOk(String(c.column_name || '')) || skipped.has(String(c.column_name).toLowerCase())) continue;
        for (const [cond, msg] of strictChecks(c, 'NEW.' + dq(c.column_name))) checks.push({ col: dq(c.column_name), cond, msg });
        const sv = storedValue(c);
        if (sv) stores.push({ col: dq(c.column_name), need: sv[0], value: sv[1] });
    }
    const ql = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    const create = temp ? 'CREATE TEMP TRIGGER ' : 'CREATE TRIGGER ';
    const on = temp ? ' ON main.' + dq(table) : ' ON ' + dq(table);
    const body = (update) => ' BEGIN SELECT CASE' + checks.map((k) => ' WHEN '
        + (update ? 'NEW.' + k.col + ' IS NOT OLD.' + k.col + ' AND ' : '')
        + '(' + k.cond + ') THEN RAISE(ABORT, ' + ql(k.msg) + ')').join('') + ' END; END';
    // The row is rewritten in place by rowid; the trigger's own UPDATE does
    // not fire it again (recursive_triggers is off). cis_store(1) and (-1)
    // around it tell the ON UPDATE CURRENT_TIMESTAMP triggers that this is
    // not a change of the caller's, so a stamp the statement gave stays.
    const store = (event) => create + dq(STRICT_TRIGGER + table + ':store_' + event.toLowerCase()) + ' AFTER ' + event + on
        + ' FOR EACH ROW WHEN ' + stores.map((k) => '(' + k.need('NEW.' + k.col) + ')').join(' OR ')
        + ' BEGIN SELECT cis_store(1); UPDATE ' + dq(table) + ' SET ' + stores.map((k) => k.col + ' = CASE WHEN ' + k.need(k.col) + ' THEN ' + k.value(k.col) + ' ELSE ' + k.col + ' END').join(', ')
        + ' WHERE rowid = NEW.rowid; SELECT cis_store(-1); END';
    const out = [];
    if (checks.length) {
        out.push(create + dq(STRICT_TRIGGER + table + ':insert') + ' BEFORE INSERT' + on + ' FOR EACH ROW WHEN cis_strict()' + body(false));
        out.push(create + dq(STRICT_TRIGGER + table + ':update') + ' BEFORE UPDATE' + on + ' FOR EACH ROW WHEN cis_strict()' + body(true));
    }
    if (stores.length) out.push(store('INSERT'), store('UPDATE'));
    return out;
}

// A MariaDB foreign key whose parent columns are not a unique key (ox_mdt
// and ps-mdt point at the first column of a two-column primary key, or at a
// column with a plain index). InnoDB takes it; SQLite cannot declare it, so
// triggers do what InnoDB does, row by row: a child row needs a parent row
// with its value unless a key column is NULL, and each parent row deleted or
// changed cascades to, nulls or is refused by every child row with its old
// value, even when another parent row still has that value.
const FK_TRIGGER = 'cis_fk:';

/**
 * @param {string} child
 * @param {string[]} cols child columns
 * @param {string} parent
 * @param {string[]} refs parent columns
 * @param {string} actions ' ON DELETE x ON UPDATE y' as written
 * @returns {string[]} CREATE TRIGGER statements, none when a name is unsafe
 */
function foreignKeyTriggersSql(child, cols, parent, refs, actions) {
    if (!identOk(child) || !identOk(parent) || !cols.length || cols.length !== refs.length
        || !cols.every(identOk) || !refs.every(identOk)) return [];
    const rule = (re) => {
        const m = re.exec(actions || '');
        return m ? m[1].toUpperCase().replace(/\s+/, ' ') : 'RESTRICT';
    };
    const del = rule(/\bON\s+DELETE\s+(CASCADE|SET\s+NULL)/i);
    const upd = rule(/\bON\s+UPDATE\s+(CASCADE|SET\s+NULL)/i);
    const head = (kind, when) => 'CREATE TRIGGER IF NOT EXISTS ' + dq(FK_TRIGGER + child + ':' + cols.join(',') + ':' + parent + ':' + kind) + ' ' + when + ' FOR EACH ROW';
    const fail = " BEGIN SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed'); END";
    const hasParent = 'EXISTS (SELECT 1 FROM ' + dq(parent) + ' WHERE ' + refs.map((r, i) => dq(r) + ' = NEW.' + dq(cols[i])).join(' AND ') + ')';
    const keyed = cols.map((c) => 'NEW.' + dq(c) + ' IS NOT NULL').join(' AND ');
    const childMoved = cols.map((c) => 'NEW.' + dq(c) + ' IS NOT OLD.' + dq(c)).join(' OR ');
    const parentMoved = refs.map((r) => 'NEW.' + dq(r) + ' IS NOT OLD.' + dq(r)).join(' OR ');
    const ofChild = ' WHERE ' + cols.map((c, i) => dq(c) + ' = OLD.' + dq(refs[i])).join(' AND ');
    const hasChild = 'EXISTS (SELECT 1 FROM ' + dq(child) + ofChild + ')';
    const setChild = (to) => 'UPDATE ' + dq(child) + ' SET ' + cols.map((c, i) => dq(c) + ' = ' + (to === 'NULL' ? 'NULL' : 'NEW.' + dq(refs[i]))).join(', ') + ofChild + ';';
    const out = [
        head('insert', 'BEFORE INSERT ON ' + dq(child)) + ' WHEN ' + keyed + ' AND NOT ' + hasParent + fail,
        head('update', 'BEFORE UPDATE OF ' + cols.map(dq).join(', ') + ' ON ' + dq(child)) + ' WHEN ' + keyed + ' AND (' + childMoved + ') AND NOT ' + hasParent + fail,
    ];
    if (del === 'CASCADE') out.push(head('delete', 'AFTER DELETE ON ' + dq(parent)) + ' BEGIN DELETE FROM ' + dq(child) + ofChild + '; END');
    else if (del === 'SET NULL') out.push(head('delete', 'AFTER DELETE ON ' + dq(parent)) + ' BEGIN ' + setChild('NULL') + ' END');
    else out.push(head('delete', 'BEFORE DELETE ON ' + dq(parent)) + ' WHEN ' + hasChild + fail);
    const onParentUpdate = 'UPDATE OF ' + refs.map(dq).join(', ') + ' ON ' + dq(parent);
    if (upd === 'CASCADE') out.push(head('parent', 'AFTER ' + onParentUpdate) + ' WHEN ' + parentMoved + ' BEGIN ' + setChild('NEW') + ' END');
    else if (upd === 'SET NULL') out.push(head('parent', 'AFTER ' + onParentUpdate) + ' WHEN ' + parentMoved + ' BEGIN ' + setChild('NULL') + ' END');
    else out.push(head('parent', 'BEFORE ' + onParentUpdate) + ' WHEN (' + parentMoved + ') AND ' + hasChild + fail);
    return out;
}

/**
 * A MariaDB information_schema COLUMN_DEFAULT that is an expression
 * (json_array(), curdate(), uuid()...) as a SQLite DEFAULT, or null.
 * Literals and current_timestamp() are handled by the caller.
 * @param {string} raw
 * @param {string} dataType MariaDB DATA_TYPE
 */
function defaultFromMaria(raw, dataType) {
    const v = String(raw || '').trim();
    if (!v || /^NULL$/i.test(v)) return null;
    const ps = ddlState(v);
    const d = ddlDefault(ps, ps.t.length - 1, String(dataType || '').toUpperCase());
    if (d.bad || d.sql == null || ps.p !== ps.t.length) return null;
    return CLOCK_SQL[d.sql] ? '(' + CLOCK_SQL[d.sql] + ')' : d.sql;
}

// MariaDB keeps index names per table and refuses one the table has, unless
// the statement says IF NOT EXISTS. SQLite's are per database, so every
// index statement here carries IF NOT EXISTS and this check gives the error.
function ddlIndexClash(table, ix) {
    if (ix.ifNot || !indexProvider) return;
    let names = [];
    try { names = indexProvider(table) || []; } catch (e) { names = []; }
    const want = (table + '_' + ix.name).toLowerCase();
    if (names.some((n) => String(n).toLowerCase() === want)) throw new Error("Duplicate key name '" + ix.name + "'");
}

function ddlIndexSql(table, ix) {
    return (ix.unique ? 'CREATE UNIQUE INDEX IF NOT EXISTS ' : 'CREATE INDEX IF NOT EXISTS ')
        + dq(table + '_' + ix.name) + ' ON ' + dq(table) + ' (' + ix.cols.map((c) => dq(c.name) + (c.desc ? ' DESC' : '')).join(', ') + ')';
}

// Column sets the table already has a PRIMARY KEY or UNIQUE index on.
function knownUniques(table) {
    if (!uniqueProvider || !identOk(table)) return null;
    try { return uniqueProvider(table); } catch (e) { return null; }
}

function sameCols(a, b) {
    if (a.length !== b.length) return false;
    const x = a.map((c) => String(c).toLowerCase()).sort();
    const y = b.map((c) => String(c).toLowerCase()).sort();
    return x.every((c, i) => c === y[i]);
}

// A foreign key SQLite can hold: it needs a PRIMARY KEY or UNIQUE index on
// the parent columns, where InnoDB takes any index. A key SQLite cannot
// hold is left to MariaDB; with it, every write to either table would fail.
// MariaDB refuses a key to a table that does not exist (errno 150), so the
// CREATE TABLE fails here too rather than make a table MariaDB lacks.
function ddlForeignKey(fk, selfTable, selfUniques, sql, triggers) {
    let uniques;
    if (fk.table.toLowerCase() === String(selfTable).toLowerCase()) uniques = selfUniques;
    else {
        uniques = knownUniques(fk.table);
        if (uniques === null && uniqueProvider) ddlRefused(sql, 'a foreign key to ' + fk.table + ', which does not exist');
    }
    if (uniques && !uniques.some((u) => sameCols(u, fk.cols))) {
        triggers.push(...foreignKeyTriggersSql(selfTable, fk.from, fk.table, fk.cols, fk.actions));
        return null;
    }
    return 'FOREIGN KEY (' + fk.from.map(dq).join(', ') + ') REFERENCES ' + dq(fk.table) + ' (' + fk.cols.map(dq).join(', ') + ')' + fk.actions;
}

// One table-level item (a key, an index, a constraint). Returns false when
// the item is not one, null when it is one the parser does not understand.
function ddlTableItem(ps, end, out) {
    let cname = null;
    if (ddlAccept(ps, 'CONSTRAINT')) {
        const w = ddlUp(ps.t[ps.p]);
        if (w !== 'PRIMARY' && w !== 'UNIQUE' && w !== 'FOREIGN' && w !== 'CHECK') { cname = ddlName(ps.t[ps.p]); ps.p++; }
    }
    const w = ddlUp(ps.t[ps.p]);
    if (w === 'PRIMARY') {
        if (!ddlAccept(ps, 'PRIMARY', 'KEY')) return null;
        ddlIndexTail(ps, end);
        if (!ps.t[ps.p] || ps.t[ps.p].k !== 'lp') return null;
        const cols = ddlKeyCols(ps, ps.p);
        if (!cols) return null;
        ddlIndexTail(ps, end);
        out.pk = cols.map((c) => c.name);
        return ps.p > end;
    }
    if (w === 'UNIQUE' || w === 'KEY' || w === 'INDEX' || w === 'FULLTEXT' || w === 'SPATIAL') {
        ps.p++;
        const unique = w === 'UNIQUE';
        if (w !== 'KEY' && w !== 'INDEX') { ddlAccept(ps, 'KEY') || ddlAccept(ps, 'INDEX'); }
        const ifNot = ddlAccept(ps, 'IF', 'NOT', 'EXISTS');
        let name = null;
        if (ps.t[ps.p] && ps.t[ps.p].k !== 'lp' && ddlUp(ps.t[ps.p]) !== 'USING') { name = ddlName(ps.t[ps.p]); ps.p++; }
        ddlIndexTail(ps, end);
        if (!ps.t[ps.p] || ps.t[ps.p].k !== 'lp') return null;
        const cols = ddlKeyCols(ps, ps.p);
        if (!cols) return null;
        ddlIndexTail(ps, end);
        name = name || cname || cols[0].name;
        if (!identOk(name)) return null;
        out.indexes.push({ name, unique, cols, ifNot });
        return ps.p > end;
    }
    if (w === 'FOREIGN') {
        if (!ddlAccept(ps, 'FOREIGN', 'KEY')) return null;
        if (ps.t[ps.p] && ps.t[ps.p].k !== 'lp') ps.p++;
        if (!ps.t[ps.p] || ps.t[ps.p].k !== 'lp') return null;
        const cols = ddlKeyCols(ps, ps.p);
        if (!cols || !ddlAccept(ps, 'REFERENCES')) return null;
        const ref = ddlReference(ps, end);
        if (!ref) return null;
        ref.from = cols.map((c) => c.name);
        out.fks.push(ref);
        return ps.p > end;
    }
    if (w === 'CHECK') {
        ps.p++;
        if (!ps.t[ps.p] || ps.t[ps.p].k !== 'lp') return null;
        const close = ddlClose(ps, ps.p);
        if (close < 0) return null;
        out.checks.push(ddlExpr(ddlText(ps, ps.p + 1, close - 1)));
        ps.p = close + 1;
        return ps.p > end;
    }
    if (w === 'PERIOD' && ddlUp(ps.t[ps.p + 1]) === 'FOR') return true;
    return cname ? null : false;
}

const TABLE_OPTIONS = new Set(['ENGINE', 'TYPE', 'AUTO_INCREMENT', 'AVG_ROW_LENGTH', 'CHECKSUM', 'COMMENT', 'COMPRESSION',
    'CONNECTION', 'DATA', 'INDEX', 'DELAY_KEY_WRITE', 'ENCRYPTED', 'ENCRYPTION', 'ENCRYPTION_KEY_ID', 'IETF_QUOTES',
    'INSERT_METHOD', 'KEY_BLOCK_SIZE', 'MAX_ROWS', 'MIN_ROWS', 'PACK_KEYS', 'PAGE_CHECKSUM', 'PAGE_COMPRESSED',
    'PAGE_COMPRESSION_LEVEL', 'PASSWORD', 'ROW_FORMAT', 'SEQUENCE', 'STATS_AUTO_RECALC', 'STATS_PERSISTENT',
    'STATS_SAMPLE_PAGES', 'TRANSACTIONAL', 'UNION', 'WITH', 'TABLESPACE', 'STORAGE', 'START']);

// ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ... after the column list. Returns
// the AUTO_INCREMENT start, or -1 on a clause it does not know.
function ddlTableOptions(ps) {
    let autoStart = 0;
    while (ps.p < ps.t.length) {
        const tok = ps.t[ps.p];
        if (tok.k === 'comma' || (tok.k === 'op' && tok.v === ';')) { ps.p++; continue; }
        const w = ddlUp(tok);
        if (w === 'AS' || w === 'SELECT' || w === 'IGNORE' || w === 'REPLACE') return autoStart;
        if (w === 'PARTITION') { ps.p = ps.t.length; return autoStart; }
        if (ddlAccept(ps, 'DEFAULT')) continue;
        const charset = ddlAccept(ps, 'CHARACTER', 'SET') || ddlAccept(ps, 'CHARSET');
        if (charset || ddlAccept(ps, 'COLLATE')) {
            if (ps.t[ps.p] && ps.t[ps.p].v === '=') ps.p++;
            const tok = ps.t[ps.p];
            const v = tok && (tok.k === 'str' ? tok.v.slice(1, -1) : ddlName(tok));
            // The table's own collation, for its text columns (mysqlColumnMeta).
            if (v && charset) ps.charset = v;
            else if (v) ps.collate = v;
            ps.p++;
            continue;
        }
        if (!TABLE_OPTIONS.has(w)) return -1;
        ps.p++;
        if (w === 'DATA' || w === 'INDEX') ddlAccept(ps, 'DIRECTORY');
        if (w === 'WITH') { ddlAccept(ps, 'SYSTEM', 'VERSIONING'); continue; }
        if (ps.t[ps.p] && ps.t[ps.p].v === '=') ps.p++;
        const val = ps.t[ps.p];
        if (!val) return -1;
        if (w === 'AUTO_INCREMENT' && val.k === 'num') autoStart = Number(val.v);
        if (w === 'UNION' && val.k === 'lp') { ps.p = ddlClose(ps, ps.p) + 1; continue; }
        ps.p++;
    }
    return autoStart;
}

// A statement with no exact SQLite form fails for its caller, with the
// reason, instead of building a table that differs from MariaDB's.
function ddlRefused(sql, why) {
    const head = String(sql).replace(/\s+/g, ' ').trim().slice(0, 80);
    throw new Error('cis_database: no SQLite form for ' + (why || 'this statement') + ': ' + head);
}

// The table's columns as SQLite has them now (DDL is never cached, so this
// is read fresh for every statement).
function liveColumns(table) {
    if (schemaProvider) {
        const rows = columnMeta(table);
        return rows.map((r) => String(r && (r.name || r.Name || r.column_name) || '')).filter(Boolean);
    }
    return tableColumns(table) || [];
}

function translateCreateTable(sql) {
    const ps = ddlState(sql);
    ps.p = 1;
    const temp = ddlAccept(ps, 'TEMPORARY');
    if (!ddlAccept(ps, 'TABLE')) return null;
    const ifNot = ddlAccept(ps, 'IF', 'NOT', 'EXISTS');
    const table = ddlTakeName(ps);
    if (table == null || !identOk(table)) return ddlRefused(sql);
    const head = 'CREATE ' + (temp ? 'TEMP ' : '') + 'TABLE IF NOT EXISTS ' + dq(table);
    // An existing table stays as it is under IF NOT EXISTS, as in MariaDB;
    // its indexes too. Without it MariaDB refuses the statement. A temporary
    // table may share a name with a real one.
    const exists = liveColumns(table).length > 0;
    if (exists && !ifNot && !temp) throw new Error("Table '" + table + "' already exists");
    const tok = ps.t[ps.p];
    if (!tok || tok.k !== 'lp') {
        // CREATE TABLE t [AS] SELECT ...
        ddlTableOptions(ps);
        ddlAccept(ps, 'AS');
        if (ddlUp(ps.t[ps.p]) !== 'SELECT') return ddlRefused(sql);
        const select = translate(ddlText(ps, ps.p, ps.t.length - 1));
        return { sql: head + ' AS ' + select.sql, extra: [] };
    }
    const close = ddlClose(ps, ps.p);
    if (close < 0) return ddlRefused(sql);
    if (ddlUp(ps.t[ps.p + 1]) === 'LIKE') return ddlRefused(sql, 'CREATE TABLE ... LIKE');
    const out = { pk: null, indexes: [], fks: [], checks: [] };
    const cols = [];
    for (const [a, b] of ddlItems(ps, ps.p + 1, close - 1)) {
        ps.p = a;
        const item = ddlTableItem(ps, b, out);
        if (item === null) return ddlRefused(sql);
        if (item === true) continue;
        ps.p = a;
        const col = ddlColumn(ps, b);
        if (!col) return ddlRefused(sql);
        cols.push(col);
    }
    ps.p = close + 1;
    const autoStart = ddlTableOptions(ps);
    if (autoStart < 0) return ddlRefused(sql);
    if (ps.p < ps.t.length) return ddlRefused(sql);
    if (!cols.length) return ddlRefused(sql);
    const inlinePk = cols.filter((c) => c.pk);
    if (inlinePk.length > 1 || (inlinePk.length && out.pk)) return ddlRefused(sql);
    const pk = out.pk || (inlinePk.length ? [inlinePk[0].name] : null);
    const ai = cols.filter((c) => c.ai);
    if (ai.length > 1) return ddlRefused(sql);
    let aiPk = null;
    if (ai.length) {
        // SQLite numbers only an INTEGER PRIMARY KEY, so the AUTO_INCREMENT
        // column is that even when MariaDB's primary key is another one
        // (qb-core players: PRIMARY KEY (citizenid), KEY id (id)). That key
        // then becomes a unique index, as hydration builds it.
        aiPk = ai[0];
        aiPk.type = 'INTEGER';
        if (pk && !(pk.length === 1 && pk[0].toLowerCase() === aiPk.name.toLowerCase())) {
            out.indexes.unshift({ name: 'PRIMARY', unique: true, cols: pk.map((name) => ({ name, desc: false })) });
        }
    }
    const pkSet = new Set((pk || []).map((c) => c.toLowerCase()));
    const dbCollation = defaultCollation(table).db;
    const defs = cols.map((c) => ddlColumnSql(c, { aiPk: c === aiPk, pkCol: pkSet.has(c.name.toLowerCase()) && c !== aiPk,
        fold: foldsCase(c, ps.collate || null, ps.charset || null, dbCollation) }));
    if (pk && !aiPk) defs.push('PRIMARY KEY (' + pk.map(dq).join(', ') + ')');
    for (const c of cols) {
        if (c.unique && !(aiPk === c)) out.indexes.push({ name: c.name, unique: true, cols: [{ name: c.name, desc: false }] });
        if (c.ref) out.fks.push(Object.assign({ from: [c.name] }, c.ref));
        c.ref = null;
    }
    const selfUniques = [];
    if (pk) selfUniques.push(pk);
    for (const ix of out.indexes) if (ix.unique) selfUniques.push(ix.cols.map((c) => c.name));
    const fkTriggers = [];
    for (const fk of out.fks) {
        const f = ddlForeignKey(fk, table, selfUniques, sql, fkTriggers);
        if (f) defs.push(f);
    }
    for (const c of out.checks) defs.push('CHECK (' + c + ')');
    const names = cols.map((c) => c.name);
    rememberColumns(table, names);
    const extra = exists ? [] : out.indexes.map((ix) => ddlIndexSql(table, ix));
    if (!exists) {
        for (const c of cols) {
            const trg = c.onUpdate ? onUpdateTriggerSql(table, c.name, names) : null;
            if (trg) extra.push(trg);
        }
        extra.push(...fkTriggers);
    }
    if (!exists && autoStart > 1 && aiPk) {
        extra.push('INSERT INTO sqlite_sequence (name, seq) SELECT ' + qlit(table) + ', ' + (autoStart - 1)
            + ' WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ' + qlit(table) + ')');
    }
    // MariaDB makes primary key columns NOT NULL.
    const meta = exists ? null : cols.map((c) => mysqlColumnMeta(pkSet.has(c.name.toLowerCase()) ? Object.assign({}, c, { notNull: true }) : c, ps.collate || null, ps.charset || null));
    // The table's collation, for the text columns ALTER TABLE adds later.
    const tableCollation = ps.collate || (ps.charset ? CHARSET_COLLATION[String(ps.charset).toLowerCase()] || null : null);
    return { sql: head + ' (' + defs.join(', ') + ')', extra, table, meta, tableCollation: exists ? null : tableCollation };
}

// CREATE [UNIQUE|FULLTEXT|SPATIAL] INDEX [IF NOT EXISTS] name ON t (cols)
function translateCreateIndex(sql) {
    const ps = ddlState(sql);
    ps.p = 1;
    ddlAccept(ps, 'OR', 'REPLACE');
    const unique = ddlAccept(ps, 'UNIQUE');
    if (!unique) ddlAccept(ps, 'FULLTEXT') || ddlAccept(ps, 'SPATIAL');
    if (!ddlAccept(ps, 'INDEX')) return null;
    const ifNot = ddlAccept(ps, 'IF', 'NOT', 'EXISTS');
    const name = ddlTakeName(ps);
    ddlIndexTail(ps, ps.t.length - 1);
    if (name == null || !identOk(name) || !ddlAccept(ps, 'ON')) return ddlRefused(sql);
    const table = ddlTakeName(ps);
    if (table == null || !identOk(table) || !ps.t[ps.p] || ps.t[ps.p].k !== 'lp') return ddlRefused(sql);
    const cols = ddlKeyCols(ps, ps.p);
    if (!cols) return ddlRefused(sql);
    while (ps.p < ps.t.length) {
        const w = ddlUp(ps.t[ps.p]);
        if (w === 'ALGORITHM' || w === 'LOCK') { ps.p++; if (ps.t[ps.p] && ps.t[ps.p].v === '=') ps.p++; ps.p++; continue; }
        const before = ps.p;
        ddlIndexTail(ps, ps.t.length - 1);
        if (ps.p === before) break;
    }
    if (ps.p < ps.t.length) return ddlRefused(sql);
    ddlIndexClash(table, { name, ifNot });
    return { sql: ddlIndexSql(table, { name, unique, cols }), extra: [], table };
}

// ALTER TABLE: each clause becomes zero or more SQLite statements, run in
// order (server.js, runAlter) inside one savepoint.
// Functions whose value changes from one call to the next.
const NONDETERMINISTIC = /\b(NOW|SYSDATE|CURDATE|CURTIME|CURRENT_DATE|CURRENT_TIME|CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP|UTC_DATE|UTC_TIME|UTC_TIMESTAMP|UNIX_TIMESTAMP|RAND|UUID|UUID_SHORT|CONNECTION_ID|LAST_INSERT_ID|USER|CURRENT_USER|DATABASE)\b/i;

function translateAlterTable(sql) {
    const ps = ddlState(sql);
    ps.p = 1;
    ddlAccept(ps, 'ONLINE');
    ddlAccept(ps, 'IGNORE');
    if (!ddlAccept(ps, 'TABLE')) return null;
    ddlAccept(ps, 'IF', 'EXISTS');
    const table = ddlTakeName(ps);
    if (table == null || !identOk(table)) return ddlRefused(sql);
    const qt = dq(table);
    const steps = [];
    const known = () => liveColumns(table);
    const has = (c) => known().some((x) => String(x).toLowerCase() === String(c).toLowerCase());
    let fallback = null;
    const fold = (col) => {
        if (fallback == null) {
            const d = defaultCollation(table);
            fallback = d.table || d.db;
        }
        return foldsCase(col, null, null, fallback);
    };
    let single = null;
    let renamed = null;
    const renames = [];
    const addColumn = (ps2, a, b, ifNot) => {
        const col = ddlColumn(ps2, b);
        if (!col) return false;
        if (ifNot && has(col.name)) return true;
        // ADD id INT AUTO_INCREMENT PRIMARY KEY: added plain, then made the
        // numbered key, which numbers the rows there (server.js autoKeyColumn).
        if (col.ai) {
            steps.push('ALTER TABLE ' + qt + ' ADD COLUMN ' + ddlColumnSql(Object.assign({}, col, { ai: false, pk: false, unique: false, notNull: false, dflt: undefined }), { add: true, fold: false }));
            steps.push({ meta: mysqlColumnMeta(col, null, null) });
            steps.push({ autoKey: col.name, keyed: !!(col.pk || col.unique) });
            rememberColumns(table, [col.name]);
            single = false;
            return true;
        }
        // SQLite adds no STORED generated column to a table that exists. A
        // VIRTUAL one computes the same value on every read, so a deterministic
        // expression is added that way; the column metadata still says STORED.
        // NOW() or RAND() would give a new value each read: left to MariaDB.
        let sqlCol = col;
        if (col.gen && col.gen.stored) {
            if (NONDETERMINISTIC.test(col.gen.raw)) return null;
            sqlCol = Object.assign({}, col, { gen: Object.assign({}, col.gen, { stored: false }) });
        }
        const dflt = col.dflt;
        if (dflt != null && !col.gen && (/^CURRENT_/.test(dflt) || dflt[0] === '(')) {
            // MariaDB fills the rows it has and every later INSERT that
            // leaves the column out; SQLite takes no such default here.
            steps.push('ALTER TABLE ' + qt + ' ADD COLUMN ' + ddlColumnSql(Object.assign({}, col, { dflt: undefined, notNull: false }), { add: true, fold: fold(col) }));
            steps.push('UPDATE ' + qt + ' SET ' + dq(col.name) + ' = ' + clockSql(dflt));
            steps.push({ insertDefault: col.name, expr: clockSql(dflt) });
        } else {
            steps.push('ALTER TABLE ' + qt + ' ADD COLUMN ' + ddlColumnSql(sqlCol, { add: true, fold: fold(col) }));
        }
        if (col.onUpdate) steps.push({ onUpdate: col.name });
        if (col.unique || col.pk) steps.push(ddlIndexSql(table, { name: col.pk ? 'PRIMARY' : col.name, unique: true, cols: [{ name: col.name, desc: false }] }));
        steps.push({ meta: mysqlColumnMeta(col, null, null) });
        rememberColumns(table, [col.name]);
        single = single === null ? { col: col.name, ifNot } : false;
        return true;
    };
    for (const [a, b] of ddlItems(ps, ps.p, ps.t.length - 1)) {
        ps.p = a;
        const w = ddlUp(ps.t[a]);
        if (w === 'ADD') {
            ps.p++;
            // FIRST / AFTER x: MariaDB places the column there; server.js
            // (runAlter) rebuilds the table in that order.
            const after = (name) => {
                if (ddlAccept(ps, 'FIRST')) steps.push({ place: name, after: null });
                else if (ddlAccept(ps, 'AFTER')) {
                    const x = ddlName(ps.t[ps.p]);
                    ps.p++;
                    if (x != null) steps.push({ place: name, after: x });
                }
                return true;
            };
            const nw = ddlUp(ps.t[ps.p]);
            if (nw === 'CONSTRAINT' || nw === 'PRIMARY' || nw === 'UNIQUE' || nw === 'KEY' || nw === 'INDEX'
                || nw === 'FULLTEXT' || nw === 'SPATIAL' || nw === 'FOREIGN' || nw === 'CHECK' || nw === 'PERIOD') {
                const out = { pk: null, indexes: [], fks: [], checks: [] };
                const item = ddlTableItem(ps, b, out);
                if (item !== true) return ddlRefused(sql);
                // A primary key added later is a unique index here; foreign
                // keys and checks need a rebuilt table and stay with MariaDB.
                if (out.pk) {
                    if (columnMeta(table).some((r) => Number(r.pk || r.PK || 0) > 0)) throw new Error('Multiple primary key defined');
                    ddlIndexClash(table, { name: 'PRIMARY' });
                    steps.push(ddlIndexSql(table, { name: 'PRIMARY', unique: true, cols: out.pk.map((name) => ({ name, desc: false })) }));
                }
                for (const ix of out.indexes) {
                    ddlIndexClash(table, ix);
                    steps.push(ddlIndexSql(table, ix));
                }
                continue;
            }
            ddlAccept(ps, 'COLUMN');
            const ifNot = ddlAccept(ps, 'IF', 'NOT', 'EXISTS');
            if (ps.t[ps.p] && ps.t[ps.p].k === 'lp') {
                const close = ddlClose(ps, ps.p);
                if (close !== b) return ddlRefused(sql);
                for (const [c, d] of ddlItems(ps, ps.p + 1, close - 1)) {
                    ps.p = c;
                    if (!addColumn(ps, c, d, ifNot)) return ddlRefused(sql);
                }
                continue;
            }
            // FIRST / AFTER x close the definition; ddlColumn stops on them.
            let end = b;
            for (let i = ps.p; i <= b; i++) {
                const u = ddlUp(ps.t[i]);
                if (u === 'FIRST' && i === b) { end = i - 1; break; }
                if (u === 'AFTER' && i === b - 1) { end = i - 1; break; }
            }
            const before = steps.length;
            const colName = ddlName(ps.t[ps.p]);
            if (!addColumn(ps, ps.p, end, ifNot)) return ddlRefused(sql);
            ps.p = end + 1;
            // IF NOT EXISTS on a column that is there: MariaDB leaves it where it is.
            if (steps.length > before) after(colName);
            continue;
        }
        if (w === 'DROP') {
            ps.p++;
            const nw = ddlUp(ps.t[ps.p]);
            if (nw === 'INDEX' || nw === 'KEY') {
                ps.p++;
                ddlAccept(ps, 'IF', 'EXISTS');
                const name = ddlName(ps.t[ps.p]);
                if (name == null || !identOk(name)) return ddlRefused(sql);
                steps.push('DROP INDEX IF EXISTS ' + dq(table + '_' + name));
                continue;
            }
            if (ddlAccept(ps, 'PRIMARY', 'KEY')) { steps.push('DROP INDEX IF EXISTS ' + dq(table + '_PRIMARY')); continue; }
            if (nw === 'FOREIGN' || nw === 'CHECK') continue;
            if (nw === 'CONSTRAINT') {
                ps.p++;
                ddlAccept(ps, 'IF', 'EXISTS');
                const name = ddlName(ps.t[ps.p]);
                if (name != null && identOk(name)) steps.push('DROP INDEX IF EXISTS ' + dq(table + '_' + name));
                continue;
            }
            ddlAccept(ps, 'COLUMN');
            const ifEx = ddlAccept(ps, 'IF', 'EXISTS');
            const name = ddlName(ps.t[ps.p]);
            if (name == null || !identOk(name)) return ddlRefused(sql);
            if (ifEx && !has(name)) continue;
            steps.push({ dropColumn: name });
            continue;
        }
        // The new definition of MODIFY / CHANGE, without FIRST / AFTER x. SQLite
        // keeps the column as it is (its affinity already takes the values);
        // information_schema reports the new type.
        // FIRST / AFTER x moves it: a {place} step, as for ADD.
        const newDefinition = () => {
            let end = b;
            let after;
            if (ddlUp(ps.t[b]) === 'FIRST') { end = b - 1; after = null; }
            else if (ddlUp(ps.t[b - 1]) === 'AFTER') { end = b - 2; after = ddlName(ps.t[b]); }
            const col = ddlColumn(ps, end);
            if (col) steps.push({ meta: mysqlColumnMeta(col, null, null) });
            // MODIFY id INT NOT NULL AUTO_INCREMENT (a phpMyAdmin dump, after
            // ADD PRIMARY KEY (id)): the column becomes the table's numbered
            // key, as CREATE TABLE makes it (server.js autoKeyColumn).
            if (col && col.ai) steps.push({ autoKey: col.name, keyed: !!(col.pk || col.unique) });
            if (col && after !== undefined) steps.push({ place: col.name, after });
        };
        if (w === 'MODIFY') {
            ps.p++;
            ddlAccept(ps, 'COLUMN');
            const ifEx = ddlAccept(ps, 'IF', 'EXISTS');
            const name = ddlName(ps.t[ps.p]);
            if (ifEx && name != null && !has(name)) continue;
            newDefinition();
            continue;
        }
        if (w === 'CHANGE') {
            ps.p++;
            ddlAccept(ps, 'COLUMN');
            const ifEx = ddlAccept(ps, 'IF', 'EXISTS');
            const from = ddlName(ps.t[ps.p]);
            const to = ddlName(ps.t[ps.p + 1]);
            if (from == null || to == null || !identOk(from) || !identOk(to)) return ddlRefused(sql);
            if (ifEx && !has(from)) continue;
            if (from.toLowerCase() !== to.toLowerCase()) {
                steps.push('ALTER TABLE ' + qt + ' RENAME COLUMN ' + dq(from) + ' TO ' + dq(to));
                renames.push([from, to]);
                rememberColumns(table, [to]);
            }
            steps.push({ metaRename: [from, to] });
            ps.p++;
            newDefinition();
            continue;
        }
        if (w === 'RENAME') {
            ps.p++;
            if (ddlAccept(ps, 'COLUMN')) {
                const from = ddlName(ps.t[ps.p]);
                const to = ddlName(ps.t[ps.p + 2]);
                if (from == null || to == null || !identOk(from) || !identOk(to) || ddlUp(ps.t[ps.p + 1]) !== 'TO') return ddlRefused(sql);
                steps.push('ALTER TABLE ' + qt + ' RENAME COLUMN ' + dq(from) + ' TO ' + dq(to));
                renames.push([from, to]);
                steps.push({ metaRename: [from, to] });
                continue;
            }
            if (ddlUp(ps.t[ps.p]) === 'INDEX' || ddlUp(ps.t[ps.p]) === 'KEY') return ddlRefused(sql);
            ddlAccept(ps, 'TO') || ddlAccept(ps, 'AS');
            const to = ddlTakeName(ps);
            if (to == null || !identOk(to)) return ddlRefused(sql);
            renamed = to;
            continue;
        }
        if (w === 'ALTER') continue; // ALTER [COLUMN] c SET/DROP DEFAULT
        if (w === 'AUTO_INCREMENT') {
            ps.p++;
            if (ps.t[ps.p] && ps.t[ps.p].v === '=') ps.p++;
            const n = ps.t[ps.p] && ps.t[ps.p].k === 'num' ? Number(ps.t[ps.p].v) : NaN;
            if (Number.isFinite(n) && n > 0) {
                // A table with no row yet has no sequence row: it is added
                // when the table numbers its key.
                steps.push('INSERT INTO sqlite_sequence (name, seq) SELECT ' + qlit(table) + ', 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = '
                    + qlit(table) + ") AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = " + qlit(table) + " AND instr(upper(sql), 'AUTOINCREMENT'))");
                steps.push('UPDATE sqlite_sequence SET seq = max(seq, ' + (n - 1) + ') WHERE name = ' + qlit(table));
            }
            continue;
        }
        if (w === 'ENGINE' || w === 'DEFAULT' || w === 'CHARACTER' || w === 'CHARSET' || w === 'COLLATE' || w === 'CONVERT'
            || w === 'COMMENT' || w === 'ROW_FORMAT' || w === 'FORCE' || w === 'ALGORITHM' || w === 'LOCK'
            || w === 'ENABLE' || w === 'DISABLE' || w === 'ORDER' || w === 'PACK_KEYS' || w === 'KEY_BLOCK_SIZE'
            || w === 'STATS_PERSISTENT' || w === 'STATS_AUTO_RECALC' || w === 'DISCARD' || w === 'IMPORT'
            || w === 'CHECKSUM' || w === 'MAX_ROWS' || w === 'MIN_ROWS' || w === 'AVG_ROW_LENGTH') continue;
        return ddlRefused(sql);
    }
    if (renamed) steps.push('ALTER TABLE ' + qt + ' RENAME TO ' + dq(renamed));
    // Object steps ({dropColumn}, {onUpdate}, {insertDefault}) need the
    // database as it is when they run; server.js (runAlter) carries them out.
    const out = { sql: 'SELECT 1', extra: [], steps, table, renames, renamed };
    if (single && out.steps.length === 1 && typeof out.steps[0] === 'string') {
        out.col = single.col;
        out.ifNotExists = single.ifNot;
    }
    if (out.steps.length && typeof out.steps[0] === 'string') out.sql = out.steps[0];
    return out;
}

// DROP INDEX [IF EXISTS] name ON t / DROP TABLE a, b / DROP <anything else>
function translateDrop(sql) {
    const ps = ddlState(sql);
    ps.p = 1;
    if (ddlAccept(ps, 'INDEX')) {
        ddlAccept(ps, 'IF', 'EXISTS');
        const name = ddlTakeName(ps);
        if (name == null || !identOk(name) || !ddlAccept(ps, 'ON')) return ddlRefused(sql);
        const table = ddlTakeName(ps);
        if (table == null || !identOk(table)) return ddlRefused(sql);
        return { sql: 'DROP INDEX IF EXISTS ' + dq(table + '_' + name), extra: [] };
    }
    const temp = ddlAccept(ps, 'TEMPORARY');
    if (ddlAccept(ps, 'TABLE') || ddlAccept(ps, 'TABLES')) {
        const ifEx = ddlAccept(ps, 'IF', 'EXISTS');
        const names = [];
        for (const [a, b] of ddlItems(ps, ps.p, ps.t.length - 1)) {
            ps.p = a;
            const name = ddlTakeName(ps);
            ddlAccept(ps, 'RESTRICT') || ddlAccept(ps, 'CASCADE');
            if (name == null || !identOk(name) || ps.p !== b + 1) return ddlRefused(sql);
            names.push(name);
        }
        if (!names.length) return ddlRefused(sql);
        const drops = names.map((n) => 'DROP TABLE ' + (ifEx ? 'IF EXISTS ' : '') + (temp ? 'temp.' : '') + dq(n));
        return { sql: drops[0], extra: drops.slice(1), dropped: names };
    }
    if (ddlAccept(ps, 'VIEW')) {
        const ifEx = ddlAccept(ps, 'IF', 'EXISTS');
        const name = ddlTakeName(ps);
        if (name == null || !identOk(name)) return ddlRefused(sql);
        return { sql: 'DROP VIEW ' + (ifEx ? 'IF EXISTS ' : '') + dq(name), extra: [] };
    }
    // DATABASE, PROCEDURE, FUNCTION, TRIGGER, EVENT, USER: MariaDB's alone.
    return { sql: 'SELECT 1', extra: [] };
}

// RENAME TABLE a TO b [, c TO d]
function translateRename(sql) {
    const ps = ddlState(sql);
    ps.p = 1;
    if (!ddlAccept(ps, 'TABLE') && !ddlAccept(ps, 'TABLES')) return ddlRefused(sql);
    const steps = [];
    const pairs = [];
    for (const [a, b] of ddlItems(ps, ps.p, ps.t.length - 1)) {
        ps.p = a;
        const from = ddlTakeName(ps);
        if (!ddlAccept(ps, 'TO')) return ddlRefused(sql);
        const to = ddlTakeName(ps);
        if (from == null || to == null || !identOk(from) || !identOk(to) || ps.p !== b + 1) return ddlRefused(sql);
        steps.push('ALTER TABLE ' + dq(from) + ' RENAME TO ' + dq(to));
        pairs.push([from, to]);
    }
    if (!steps.length) return ddlRefused(sql);
    return { sql: steps[0], extra: steps.slice(1), renamedTables: pairs };
}

function translateCreateView(sql) {
    const ps = ddlState(sql);
    ps.p = 1;
    const replace = ddlAccept(ps, 'OR', 'REPLACE');
    while (ps.p < ps.t.length && ddlUp(ps.t[ps.p]) !== 'VIEW') ps.p++; // ALGORITHM=, DEFINER=, SQL SECURITY
    if (!ddlAccept(ps, 'VIEW')) return null;
    const ifNot = ddlAccept(ps, 'IF', 'NOT', 'EXISTS');
    const name = ddlTakeName(ps);
    if (name == null || !identOk(name)) return ddlRefused(sql);
    let cols = '';
    if (ps.t[ps.p] && ps.t[ps.p].k === 'lp') {
        const c = ddlKeyCols(ps, ps.p);
        if (!c) return ddlRefused(sql);
        cols = ' (' + c.map((x) => dq(x.name)).join(', ') + ')';
    }
    if (!ddlAccept(ps, 'AS')) return ddlRefused(sql);
    let end = ps.t.length - 1;
    if (ddlUp(ps.t[end]) === 'OPTION' && ddlUp(ps.t[end - 1]) === 'CHECK') {
        end -= 2;
        if (ddlUp(ps.t[end]) === 'CASCADED' || ddlUp(ps.t[end]) === 'LOCAL') end--;
        if (ddlUp(ps.t[end]) === 'WITH') end--;
    }
    const select = translate(ddlText(ps, ps.p, end));
    const create = 'CREATE VIEW ' + (ifNot && !replace ? 'IF NOT EXISTS ' : '') + dq(name) + cols + ' AS ' + select.sql;
    if (replace) return { sql: 'DROP VIEW IF EXISTS ' + dq(name), extra: [create] };
    return { sql: create, extra: [] };
}

/**
 * DDL as SQLite, or null for a statement this part does not handle.
 * @param {string} sql caller's text, strings already rewritten
 * @param {string} kw first keyword
 */
function translateDdl(sql, kw) {
    sql = sql.replace(/[\s;]+$/, '');
    const ps = ddlState(sql);
    const second = ddlUp(ps.t[1]);
    if (kw === 'CREATE') {
        if (second === 'TABLE' || second === 'TEMPORARY') return translateCreateTable(sql);
        if (second === 'INDEX' || second === 'UNIQUE' || second === 'FULLTEXT' || second === 'SPATIAL') return translateCreateIndex(sql);
        if (second === 'OR' && ddlUp(ps.t[3]) === 'INDEX') return translateCreateIndex(sql);
        if (second === 'VIEW' || second === 'ALGORITHM' || second === 'DEFINER' || second === 'SQL' || (second === 'OR' && sql.match(/\bVIEW\b/i))) return translateCreateView(sql);
        if (second === 'DATABASE' || second === 'SCHEMA' || second === 'USER' || second === 'ROLE') {
            return { sql: 'SELECT 1', extra: [] };
        }
        // A stored program, and CREATE OR REPLACE TABLE (drop, then create),
        // did work on MariaDB; answering SELECT 1 told the caller they ran.
        if (second === 'PROCEDURE' || second === 'FUNCTION' || second === 'TRIGGER' || second === 'EVENT'
            || second === 'AGGREGATE' || second === 'OR') {
            throw new Error('cis_database: CREATE ' + (second === 'OR' ? 'OR REPLACE ' + ddlUp(ps.t[3]) : second) + ' is not supported on SQLite');
        }
        return null;
    }
    if (kw === 'ALTER') {
        if (second === 'TABLE' || second === 'ONLINE' || second === 'IGNORE') return translateAlterTable(sql);
        if (second === 'DATABASE' || second === 'SCHEMA' || second === 'USER') {
            return { sql: 'SELECT 1', extra: [] };
        }
        // ALTER VIEW replaces the view's query, as CREATE OR REPLACE VIEW does.
        if (second === 'VIEW' || second === 'DEFINER' || second === 'ALGORITHM' || second === 'SQL') {
            const out = translateCreateView(sql.replace(/^\s*ALTER\b/i, 'CREATE OR REPLACE'));
            out.extrasAfter = true;
            return out;
        }
        if (second === 'PROCEDURE' || second === 'FUNCTION' || second === 'EVENT') {
            throw new Error('cis_database: ALTER ' + second + ' is not supported on SQLite');
        }
        return null;
    }
    if (kw === 'DROP') return translateDrop(sql);
    if (kw === 'RENAME') return translateRename(sql);
    return null;
}

// SHOW TABLES / COLUMNS / INDEX and DESCRIBE, on the information_schema
// views, with MariaDB's result columns. A LIKE or WHERE tail keeps its
// meaning: it filters those columns.
const SHOW_NAME = String.raw`(?:"((?:[^"]|"")+)"|([A-Za-z0-9_$-]+))`;
const SHOW_DB = String.raw`(?:\s+(?:FROM|IN)\s+(?:"(?:[^"]|"")+"|[A-Za-z0-9_$-]+))?`;
const SHOW_TAIL = String.raw`(?:\s+LIKE\s+('(?:[^']|'')*')|\s+WHERE\s+([\s\S]+))?`;

function rewriteShow(sql) {
    const u = sql.trim().replace(/;+\s*$/, '');
    const filter = (m, likeOn) => (m[1] ? ' WHERE ' + likeOn + ' LIKE ' + m[1] : m[2] ? ' WHERE ' + m[2] : '');
    const named = (m, i) => (m[i] != null ? m[i].replace(/""/g, '"') : m[i + 1]);
    let m = new RegExp('^SHOW\\s+(FULL\\s+)?TABLES' + SHOW_DB + SHOW_TAIL + '$', 'i').exec(u);
    if (m) {
        const col = dq('Tables_in_' + databaseName);
        const inner = 'SELECT TABLE_NAME AS ' + col + (m[1] ? ', TABLE_TYPE AS Table_type' : '') + ' FROM ' + dq(INFO_PREFIX + 'tables');
        return { sql: 'SELECT * FROM (' + inner + ')' + filter([null, m[2], m[3]], col) + ' ORDER BY 1', extra: [] };
    }
    m = new RegExp('^SHOW\\s+(FULL\\s+)?(?:COLUMNS|FIELDS)\\s+(?:FROM|IN)\\s+' + SHOW_NAME + SHOW_DB + SHOW_TAIL + '$', 'i').exec(u)
        || new RegExp('^(?:DESCRIBE|DESC|EXPLAIN)()\\s+' + SHOW_NAME + '(?:\\s+(' + "'(?:[^']|'')*'" + '|[A-Za-z0-9_$%-]+))?()$', 'i').exec(u);
    if (m) {
        const t = named(m, 2);
        if (!identOk(t)) return { sql: 'SELECT 1 WHERE 0', extra: [] };
        let like = m[4];
        if (like && like[0] !== "'") like = qlit(like);
        // SHOW COLUMNS gives the default as a value: 'abc' as abc, NULL as null.
        const dflt = "CASE WHEN COLUMN_DEFAULT IS NULL OR COLUMN_DEFAULT = 'NULL' THEN NULL"
            + " WHEN substr(COLUMN_DEFAULT, 1, 1) = '''' THEN replace(substr(COLUMN_DEFAULT, 2, length(COLUMN_DEFAULT) - 2), '''''', '''')"
            + ' ELSE COLUMN_DEFAULT END';
        const inner = 'SELECT COLUMN_NAME AS Field, COLUMN_TYPE AS "Type"' + (m[1] ? ', COLLATION_NAME AS "Collation"' : '')
            + ', IS_NULLABLE AS "Null", COLUMN_KEY AS "Key", ' + dflt + ' AS "Default", EXTRA AS Extra'
            + (m[1] ? ", PRIVILEGES AS \"Privileges\", COLUMN_COMMENT AS \"Comment\"" : '')
            + ' FROM ' + dq(INFO_PREFIX + 'columns') + ' WHERE TABLE_NAME = ' + qlit(t) + ' ORDER BY ORDINAL_POSITION';
        return { sql: 'SELECT * FROM (' + inner + ')' + filter([null, like, m[5]], 'Field'), extra: [] };
    }
    m = new RegExp('^SHOW\\s+(?:INDEX|INDEXES|KEYS)\\s+(?:FROM|IN)\\s+' + SHOW_NAME + SHOW_DB + '(?:\\s+WHERE\\s+([\\s\\S]+))?$', 'i').exec(u);
    if (m) {
        const t = named(m, 1);
        if (!identOk(t)) return { sql: 'SELECT 1 WHERE 0', extra: [] };
        const inner = 'SELECT TABLE_NAME AS "Table", NON_UNIQUE AS Non_unique, INDEX_NAME AS Key_name, SEQ_IN_INDEX AS Seq_in_index,'
            + ' COLUMN_NAME AS Column_name, COLLATION AS "Collation", CARDINALITY AS Cardinality, SUB_PART AS Sub_part, PACKED AS Packed,'
            + ' NULLABLE AS "Null", INDEX_TYPE AS Index_type, COMMENT AS "Comment", INDEX_COMMENT AS Index_comment, IGNORED AS Ignored'
            + ' FROM ' + dq(INFO_PREFIX + 'statistics') + ' WHERE TABLE_NAME = ' + qlit(t);
        return { sql: 'SELECT * FROM (' + inner + ')' + (m[3] ? ' WHERE ' + m[3] : '')
            + " ORDER BY Key_name <> 'PRIMARY', Non_unique, Key_name, Seq_in_index", extra: [] };
    }
    return { sql: 'SELECT 1', extra: [] };
}

function unwrapUnionParens(sql) {
    if (sql.indexOf('UNION') < 0 && sql.indexOf('union') < 0) return sql;
    let s = String(sql);
    const re = /\(\s*(SELECT[\s\S]*?)\)\s*(UNION(?:\s+ALL)?)\s*\(\s*(SELECT[\s\S]*?)\s*\)/i;
    for (let n = 0; n < 8 && re.test(s); n++) {
        s = s.replace(re, '$1 $2 $3');
    }
    return s;
}

function rewriteMysqlTail(sql) {
    const raw = String(sql);
    let s = raw;
    const low = (hasTok(s, 'GROUP_CONCAT', 'group_concat') || s.indexOf('LOCK') >= 0 || s.indexOf('lock') >= 0 || s.indexOf('UPDATE') >= 0 || s.indexOf('update') >= 0);
    if (low && /\bGROUP_CONCAT\b|\bLOCK\s+IN\s+SHARE|\bFOR\s+UPDATE\b/i.test(s)) {
        if (/\bGROUP_CONCAT\s*\(/i.test(s)) s = rewriteGroupConcat(s);
        s = s.replace(/\s+LOCK\s+IN\s+SHARE\s+MODE\b/gi, '');
        s = s.replace(/\s+FOR\s+UPDATE\b/gi, '');
    }
    if (s.indexOf('<=>') < 0 && s.indexOf('0x') < 0 && !/\bCONVERT\s*\(|\bDECIMAL\b|\b(?:USE|FORCE|IGNORE)\s+(?:INDEX|KEY)\b/i.test(s)) return s;
    // A column type in DDL stays as written: information_schema reports it.
    const ddl = /^\s*(?:CREATE|ALTER)\b/i.test(s);
    return mapOutsideStrings(s, (chunk) => {
        let x = chunk;
        if (x.indexOf('<=>') >= 0) x = x.replace(/\s*<=>\s*/g, ' IS ');
        if (/\bCONVERT\s*\(/i.test(x)) x = x.replace(/\bCONVERT\s*\(\s*([^)]+?)\s+USING\s+[A-Za-z0-9_]+\s*\)/gi, '$1');
        if (x.indexOf('0x') >= 0) x = x.replace(/\b0x([0-9A-Fa-f]+)\b/g, "X'$1'");
        if (!ddl && /\bDECIMAL\b/i.test(x)) {
            x = x.replace(/\bDECIMAL\s*\(\s*\d+\s*,\s*\d+\s*\)/gi, 'REAL');
            x = x.replace(/\bCAST\s*\(\s*([^,]+?)\s+AS\s+REAL\s*\)/gi, 'CAST($1 AS REAL)');
        }
        // Index hints only steer MariaDB's planner; they never change a result.
        if (/\b(?:USE|FORCE|IGNORE)\s+(?:INDEX|KEY)\b/i.test(x)) {
            x = x.replace(/\s+(?:USE|FORCE|IGNORE)\s+(?:INDEX|KEY)(?:\s+FOR\s+(?:JOIN|ORDER\s+BY|GROUP\s+BY))?\s*\(\s*(?:(?:`[^`]*`|[A-Za-z0-9_$]+)(?:\s*,\s*(?:`[^`]*`|[A-Za-z0-9_$]+))*)?\s*\)/gi, '');
        }
        return x;
    }, true);
}

function stripSqlComments(sql) {
    let out = '';
    let i = 0;
    const n = sql.length;
    while (i < n) {
        const c = sql[i];
        if (c === "'" || c === '"' || c === '`') {
            const q = c;
            out += c;
            i++;
            while (i < n) {
                out += sql[i];
                // MySQL: \' inside '...' (and \" inside "...") is a quote
                // that does not end the string, as in scanSql. Names in
                // backticks have no escapes.
                if (sql[i] === '\\' && q !== '`' && i + 1 < n) {
                    out += sql[i + 1];
                    i += 2;
                    continue;
                }
                if (sql[i] === q) { i++; break; }
                i++;
            }
            continue;
        }
        if (c === '/' && sql[i + 1] === '*') {
            i += 2;
            // "I.e." is not the end of the comment. Require a real "*/".
            while (i + 1 < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
            if (i + 1 < n) i += 2;
            else i = n;
            out += ' ';
            continue;
        }
        // MySQL: '--' opens a comment only before a space, a control
        // character or the end; '1--1' is 1 - (-1), and SQLite needs the
        // space to read it so.
        if (c === '-' && sql[i + 1] === '-') {
            if (i + 2 < n && sql.charCodeAt(i + 2) > 32) {
                out += '- ';
                i++;
                continue;
            }
            while (i < n && sql[i] !== '\n') i++;
            continue;
        }
        if (c === '#') {
            while (i < n && sql[i] !== '\n') i++;
            out += ' ';
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

// ---- Entry point: safety check and translate() -----------------------------------------------
// isForbiddenSql refuses statements that could reach the host or cis_database's
// own tables; translate() then runs the rewrites above in a fixed order and
// caches the result.
/**
 * An error for a statement cis_database refuses on purpose. A read SQLite
 * cannot run may be answered by MariaDB instead; a refused statement must
 * not be, or a CALL would run on MariaDB alone.
 * @param {string} msg
 */
function refusal(msg) {
    const e = new Error(msg);
    e.cisRefused = true;
    return e;
}

/** True for SET with a user variable (@name, not @@name) in its code. */
function setsUserVariable(sql) {
    let found = false;
    mapCode(sql, (chunk) => {
        if (!found && /(?:^|[^@\w$])@(?!@)/.test(chunk)) found = true;
        return chunk;
    });
    return found;
}

// Replaces each quoted run opened by one of `quotes` with an empty pair, so a
// word in a value is not read as code. With `escapes` a backslash escapes the
// next character, as MySQL reads a string; without, only a doubled quote does,
// as SQLite reads it.
function blankQuoted(s, quotes, escapes) {
    let out = '';
    let i = 0;
    const n = s.length;
    while (i < n) {
        const c = s[i];
        if (quotes.indexOf(c) < 0) { out += c; i++; continue; }
        i++;
        while (i < n) {
            if (escapes && s[i] === '\\') { i += 2; continue; }
            if (s[i] === c && s[i + 1] === c) { i += 2; continue; }
            if (s[i] === c) { i++; break; }
            i++;
        }
        out += c + c;
    }
    return out;
}

function isForbiddenSql(sql) {
    if (!sql) return false;
    const s = stripSqlComments(String(sql));
    // A word counts as code if MySQL's or SQLite's reading of the quotes leaves
    // it outside a string; the two disagree on a backslash, and the guard must
    // not trust either alone. A quoted name is never a keyword, so keywords are
    // looked for with every quote blanked. SQLite still calls a quoted function
    // and opens a quoted table, so those two checks keep identifiers.
    for (const esc of [true, false]) {
        const kw = blankQuoted(s, '\'"`', esc);
        if (/\bATTACH\b/i.test(kw)) return true;
        if (/\bDETACH\b/i.test(kw)) return true;
        if (/\bPRAGMA\s+writable_schema\b/i.test(kw)) return true;
        if (/\bPRAGMA\s+module_list\b/i.test(kw)) return true;
        // VACUUM [schema] INTO writes the whole database to a chosen file. The
        // schema may be a bare name, a quoted name (blanked to a pair here) or
        // a [bracketed] one.
        if (/\bVACUUM\b(?:\s+[A-Za-z_]\w*|\s*(?:""|``|''|\[[^\]]*\]))?\s*INTO\b/i.test(kw)) return true;
        const code = blankQuoted(s, '\'', esc);
        if (/\bload_extension["`\]]?\s*\(/i.test(code)) return true;
        // cis_database's own tables: the replication outbox and its state. A
        // caller that could write them could send any SQL to MariaDB.
        if (/(?:^|[^A-Za-z0-9_])__cis_/i.test(code)) return true;
    }
    if (/^\s*PRAGMA\b/i.test(s) && !isPragmaAllowed(s)) return true;
    return false;
}

/**
 * Translate one MySQL statement into SQLite.
 * @param {string|null} sql Caller SQL, at most 262144 bytes.
 * @returns {{sql:string, extra:string[], blocked?:boolean, tables:string[]}} sql is the
 *   statement to run. extra is SQL that goes with it: a CREATE TABLE's
 *   indexes (run after it) or TRUNCATE's sequence reset. blocked is set when
 *   the statement is refused and sql is 'SELECT 1'. tables are the tables
 *   the caller's text names.
 * The same text returns the same cached object.
 */
function translate(sql) {
    if (sql == null) return { sql: 'SELECT 1', extra: [] };
    const raw = String(sql);
    if (raw.length > MAX_SQL_LEN) {
        throw new Error('cis_database: SQL exceeds ' + MAX_SQL_LEN + ' bytes');
    }
    const hit = cache.get(raw);
    if (hit) return hit;
    if (isForbiddenSql(raw)) {
        const blocked = { sql: 'SELECT 1', extra: [], blocked: true };
        cache.set(raw, blocked);
        return blocked;
    }
    let mapped = unwrapUnionParens(rewriteTrimBoth(rewriteMysqlStrings(rewriteMysqlTail(stripSqlComments(raw)))));
    const kw = firstKeyword(mapped);
    if (kw === 'DELETE') mapped = joinDeleteSql(mapped) || mapped;
    let result;
    let jsonBool = false;
    // information_schema tables become their views; the rest of the query is
    // translated like any other.
    if (kw === 'SELECT' || kw === 'WITH') {
        if (/information_schema/i.test(mapped)) mapped = mapInformationSchema(mapped) || mapped;
    }
    const truncated = kw === 'TRUNCATE' ? mapped.match(/^\s*TRUNCATE\s+(?:TABLE\s+)?[`"]?([A-Za-z0-9_]+)[`"]?\s*;?\s*$/i) : null;
    if (truncated && identOk(truncated[1])) {
        // MariaDB empties the table, so SQLite must too. The sequence reset is
        // what TRUNCATE does to AUTO_INCREMENT.
        const t = identQuote(truncated[1]);
        result = { sql: 'DELETE FROM ' + t, extra: ["DELETE FROM sqlite_sequence WHERE name = '" + truncated[1] + "'"] };
    } else if (kw === 'TRUNCATE') {
        throw new Error('cis_database: TRUNCATE takes one table name: ' + raw.slice(0, 120));
    } else if (kw === 'CALL' || kw === 'SIGNAL' || kw === 'PROCEDURE' || kw === 'TRIGGER') {
        // These did work on MariaDB. Answering SELECT 1 told the caller they ran.
        throw refusal('cis_database: ' + kw + ' is not supported: stored programs do not run on SQLite');
    } else if (kw === 'SET' && setsUserVariable(mapped)) {
        throw refusal('cis_database: SET @name is not supported: SQLite has no user variables');
    } else if (kw === 'SET' || kw === 'USE' || kw === 'LOCK' || kw === 'UNLOCK' || kw === 'START' || kw === 'BEGIN' || kw === 'COMMIT' || kw === 'ROLLBACK') {
        // Session settings and transaction control have nothing to do here. A
        // COMMIT run on SQLite inside a transaction() list would end the
        // transaction cis_database holds and keep half the list.
        result = { sql: 'SELECT 1', extra: [] };
    } else if (kw === 'SHOW' || kw === 'DESCRIBE' || kw === 'DESC') {
        result = rewriteShow(stripTicks(mapped));
    } else if (kw === 'UPDATE' && /\bSET\s+\?(?!\s*=)/i.test(mapped)) {
        // expandBulk replaces SET ? with the object's columns; one left here had
        // no object to expand.
        throw new Error('cis_database: UPDATE ... SET ? needs an object of column values');
    } else if ((kw === 'CREATE' || kw === 'ALTER' || kw === 'DROP' || kw === 'RENAME') && (result = translateDdl(mapped, kw))) {
        // DDL depends on the tables as they are now, so it is never cached.
        result.tables = extractTables(raw);
        return result;
    } else if (!needsMysql(mapped) && kw !== 'CREATE' && kw !== 'ALTER' && kw !== 'UPDATE' && kw !== 'DELETE' && kw !== 'WITH' && !/\b(?:FIELD|COLLATE|VALUE|ENUM|UTC_DATE|RIGHT|REGEXP|DROP\s+PRIMARY)\b/i.test(mapped)) {
        let plain = mapOutsideStrings(mapped, quoteColumnWords);
        if (kw === 'INSERT' || kw === 'REPLACE') {
            plain = bulkRow(plain) || repairBareInsert(/\bSET\b/i.test(plain) ? rewriteInsertSet(plain) : plain);
        }
        if (kw === 'UPDATE' && !/\bSET\s+\?(?!\s*=)/i.test(mapped)) plain = unqualifyOwnColumns(plain);
        if ((kw === 'SELECT' || kw === 'UPDATE' || kw === 'DELETE') && !/\bSET\s+\?(?!\s*=)/i.test(mapped)) plain = quoteNameClash(plain);
        result = { sql: plain, extra: [] };
    } else if ((kw === 'INSERT' || kw === 'REPLACE') && bulkRow(mapped)) {
        result = { sql: rewriteInsertIgnore(rewriteReplace(bulkRow(mapped))), extra: [] };
    } else if (kw === 'UPDATE' && (result = joinUpdateKeepingParams(mapped))) {
        // A join UPDATE is matched on the caller's text, before any function
        // is rewritten.
    } else {
        let s = bulkRow(mapped) || repairBareInsert(rewriteInsertSet(mapped.indexOf('`') >= 0 ? stripTicks(mapped) : mapped));
        if (kw === 'SELECT' && /\bJSON_EXTRACT\s*\(|->/i.test(s)) {
            const marked = markJsonBooleans(s);
            if (marked) {
                s = marked;
                jsonBool = true;
            }
        }
        s = rewriteFunctions(s);
        s = resolveChunkMarkers(mapCode(s, rewriteCallsChunk, true));
        if (/\b(?:CONCAT|IF|JSON_CONTAINS|JSON_SEARCH)\s*\(/i.test(s) || s.indexOf('__CISFIELD__(') >= 0) s = rewriteParenFns(s);
        s = s.replace(/^\s*UPDATE\s+IGNORE\b/i, 'UPDATE');
        s = rewriteInsertIgnore(s);
        if (/\bVALUE\s*\(/i.test(s)) s = mapOutsideStrings(s, (x) => x.replace(/\bVALUE\s*\(/gi, 'VALUES ('));
        s = rewriteReplace(s);
        if (/\bON\s+DUPLICATE\s+KEY\b/i.test(s)) s = rewriteOnDuplicate(s);
        const kw2 = writeKeyword(s);
        if (kw2 === 'UPDATE') {
            s = unqualifyOwnColumns(stripUpdateAlias(s));
            s = mapOutsideStrings(s, (x) => x.replace(/((?:SET|,)\s+)"[^"]+"\s*\.\s*/gi, '$1'));
        }
        if (kw2 === 'UPDATE' || kw2 === 'DELETE') s = rewriteLimitUpdate(s, kw2);
        if (kw2 === 'UPDATE') s = sequentialUpdate(s);
        result = { sql: s, extra: [] };
    }
    if (result && result.sql && /\bBINARY\b/i.test(result.sql)) result.sql = rewriteBinaryOperator(result.sql);
    if (result && result.sql && (kw === 'SELECT' || kw === 'DELETE' || (kw === 'UPDATE' && !/\bFROM\b/i.test(result.sql))) && !/\bSET\s+\?(?!\s*=)/i.test(mapped)) {
        result = { sql: quoteNameClash(result.sql), extra: result.extra || [] };
    }
    if (kw === 'SELECT' && /\bJOIN\b/i.test(result.sql) && /\b(?:ORDER|GROUP)\s+BY\b|\bHAVING\b/i.test(result.sql)) {
        result.sql = aliasSortedColumns(result.sql);
    }
    if (kw === 'SELECT' && result.sql && /\bHAVING\b/i.test(result.sql)) result.sql = havingToWhere(result.sql);
    if ((kw === 'SELECT' || kw === 'WITH') && result.sql) {
        result.sql = aliasExpressionColumns(stripSqlComments(raw), aliasPlainColumns(result.sql));
    }
    if ((kw === 'SELECT' || kw === 'WITH' || kw === 'UPDATE' || kw === 'DELETE') && result.sql) result.sql = collateText(result.sql);
    if (cache.size >= MAX_CACHE) {
        const first = cache.keys().next().value;
        cache.delete(first);
    }
    result.tables = extractTables(raw);
    if (jsonBool) result.jsonBool = true;
    cache.set(raw, result);
    return result;
}

function isWrite(kw) {
    return kw === 'INSERT' || kw === 'UPDATE' || kw === 'DELETE' || kw === 'REPLACE'
        || kw === 'CREATE' || kw === 'DROP' || kw === 'ALTER' || kw === 'TRUNCATE'
        || kw === 'RENAME';
}

// ---- REGEXP --------------------------------------------------------------------------------------
// MariaDB answers REGEXP with PCRE. JS RegExp backtracks without a limit, so
// a player-supplied pattern such as ^(a+)+$ can hold the server thread for
// seconds. This matcher compiles the pattern to a small
// program and runs it as a Pike VM: every thread advances one character at a
// time, so the work is at most program size times value length, whatever the
// pattern. It covers what game SQL uses: literals, ., classes with ranges and
// POSIX names, \d \w \s and their negations, anchors, word boundaries,
// groups, alternation, and greedy or lazy * + ? {n,m}. Backreferences,
// lookaround, inline flags and possessive quantifiers are refused with an
// error that names REGEXP, never matched differently.
const RX_MAX_PATTERN = 4096;
const RX_MAX_PROG = 10000;
const RX_MAX_REPEAT = 65535;
const RX_MAX_WORK = 50000000;
const RX_CHAR = 0;
const RX_SPLIT = 1;
const RX_JMP = 2;
const RX_ASSERT = 3;
const RX_MATCH = 4;
const regexCache = new Map();
// Work spent since the current synchronous run began. A statement calls
// regexp once per row and runs to its end without yielding, so RX_MAX_WORK
// bounds the whole statement, not one row. The count
// starts over in the microtask after the run.
let rxSpent = 0;
let rxResetQueued = false;
function rxResetSpent() {
    rxSpent = 0;
    rxResetQueued = false;
}

function rxError(msg) {
    return new Error('REGEXP: ' + msg);
}

const isDigit = (c) => c >= 48 && c <= 57;
const isWordCp = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isSpaceCp = (c) => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
    || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
const POSIX_CLASSES = {
    alpha: (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122),
    digit: isDigit,
    alnum: (c) => isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122),
    upper: (c) => c >= 65 && c <= 90,
    lower: (c) => c >= 97 && c <= 122,
    space: isSpaceCp,
    blank: (c) => c === 32 || c === 9,
    punct: (c) => (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126),
    xdigit: (c) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102),
    word: isWordCp,
    cntrl: (c) => c <= 31 || c === 127,
    print: (c) => c >= 32 && c !== 127,
    graph: (c) => c > 32 && c !== 127,
};

// A class is a list of [lo, hi] code point ranges plus predicates, maybe negated.
function rxClass(ranges, fns, neg) {
    return { ranges, fns, neg };
}
function rxInClass(cls, c) {
    for (let k = 0; k < cls.ranges.length; k++) if (c >= cls.ranges[k][0] && c <= cls.ranges[k][1]) return true;
    for (let k = 0; k < cls.fns.length; k++) if (cls.fns[k](c)) return true;
    return false;
}
const RX_ANY = rxClass([], [(c) => c !== 10], false);

// Parses the pattern into a tree: char, cat, alt, rep, assert.
function rxParse(src) {
    let i = 0;
    const n = src.length;
    const peek = () => src[i];

    function cpAt() {
        const c = src.codePointAt(i);
        i += c > 0xffff ? 2 : 1;
        return c;
    }

    // An escape after the backslash. Returns { cls } or { cp } or { assert }.
    function escape(inClass) {
        if (i >= n) throw rxError('pattern ends with a backslash');
        const ch = src[i++];
        switch (ch) {
            case 'd': return { cls: rxClass([], [isDigit], false) };
            case 'D': return { cls: rxClass([], [isDigit], true) };
            case 'w': return { cls: rxClass([], [isWordCp], false) };
            case 'W': return { cls: rxClass([], [isWordCp], true) };
            case 's': return { cls: rxClass([], [isSpaceCp], false) };
            case 'S': return { cls: rxClass([], [isSpaceCp], true) };
            case 'n': return { cp: 10 };
            case 't': return { cp: 9 };
            case 'r': return { cp: 13 };
            case 'f': return { cp: 12 };
            case 'v': return { cp: 11 };
            case 'e': return { cp: 27 };
            case 'a': return { cp: 7 };
            case 'x': {
                let hex;
                if (src[i] === '{') {
                    const end = src.indexOf('}', i);
                    if (end < 0) throw rxError('unterminated \\x{...}');
                    hex = src.slice(i + 1, end);
                    i = end + 1;
                } else {
                    hex = src.slice(i, i + 2);
                    i += 2;
                }
                if (!/^[0-9A-Fa-f]{1,6}$/.test(hex) || parseInt(hex, 16) > 0x10ffff) throw rxError('bad \\x escape');
                return { cp: parseInt(hex, 16) };
            }
            default: break;
        }
        if (!inClass) {
            if (ch === 'b') return { assert: 'wb' };
            if (ch === 'B') return { assert: 'nwb' };
            if (ch === 'A') return { assert: 'begin' };
            if (ch === 'z') return { assert: 'end' };
            if (ch === 'Z') return { assert: 'eol' };
        } else if (ch === 'b') {
            return { cp: 8 };
        }
        if (/[0-9A-Za-z]/.test(ch)) throw rxError('\\' + ch + ' (backreferences and Unicode properties are not supported)');
        i--;
        return { cp: cpAt() };
    }

    function bracket() {
        // At the character after '['.
        const ranges = [];
        const fns = [];
        let neg = false;
        if (src[i] === '^') { neg = true; i++; }
        let first = true;
        for (;;) {
            if (i >= n) throw rxError('unterminated [ class');
            if (src[i] === ']' && !first) { i++; break; }
            first = false;
            let lo;
            if (src[i] === '[' && src[i + 1] === ':') {
                const end = src.indexOf(':]', i + 2);
                const name = end < 0 ? null : src.slice(i + 2, end);
                if (name == null || !POSIX_CLASSES[name]) throw rxError('unknown class [:' + (name || '') + ':]');
                fns.push(POSIX_CLASSES[name]);
                i = end + 2;
                continue;
            }
            if (src[i] === '\\') {
                i++;
                const e = escape(true);
                if (e.cls) {
                    fns.push(e.cls.neg ? ((f) => (c) => !f(c))(e.cls.fns[0]) : e.cls.fns[0]);
                    continue;
                }
                lo = e.cp;
            } else {
                lo = cpAt();
            }
            if (src[i] === '-' && i + 1 < n && src[i + 1] !== ']') {
                i++;
                let hi;
                if (src[i] === '\\') {
                    i++;
                    const e = escape(true);
                    if (e.cls) throw rxError('a class cannot end a range');
                    hi = e.cp;
                } else if (src[i] === '[' && src[i + 1] === ':') {
                    throw rxError('a class cannot end a range');
                } else {
                    hi = cpAt();
                }
                if (hi < lo) throw rxError('range out of order in [ class');
                ranges.push([lo, hi]);
            } else {
                ranges.push([lo, lo]);
            }
        }
        return rxClass(ranges, fns, neg);
    }

    function atom() {
        const ch = peek();
        if (ch === '(') {
            i++;
            if (src[i] === '?') {
                if (src[i + 1] !== ':') throw rxError('(?' + (src[i + 1] || '') + ' groups (lookaround, flags, names) are not supported');
                i += 2;
            }
            const node = alt();
            if (src[i] !== ')') throw rxError('missing )');
            i++;
            return node;
        }
        if (ch === '[') {
            if (src.startsWith('[[:<:]]', i)) { i += 7; return { t: 'assert', kind: 'wbstart' }; }
            if (src.startsWith('[[:>:]]', i)) { i += 7; return { t: 'assert', kind: 'wbend' }; }
            i++;
            return { t: 'char', cls: bracket() };
        }
        if (ch === '.') { i++; return { t: 'char', cls: RX_ANY }; }
        if (ch === '^') { i++; return { t: 'assert', kind: 'begin' }; }
        if (ch === '$') { i++; return { t: 'assert', kind: 'eol' }; }
        if (ch === '\\') {
            i++;
            const e = escape(false);
            if (e.assert) return { t: 'assert', kind: e.assert };
            if (e.cls) return { t: 'char', cls: e.cls };
            return { t: 'char', cls: rxClass([[e.cp, e.cp]], [], false) };
        }
        if (ch === '*' || ch === '+' || ch === '?') throw rxError('nothing to repeat before ' + ch);
        const c = cpAt();
        return { t: 'char', cls: rxClass([[c, c]], [], false) };
    }

    // {n}, {n,} or {n,m} at i; returns null when the text is a literal brace.
    function braces() {
        const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i, i + 24));
        if (!m) return null;
        const min = Number(m[1]);
        const max = m[2] === undefined ? min : (m[3] === '' ? -1 : Number(m[3]));
        if (min > RX_MAX_REPEAT || max > RX_MAX_REPEAT) throw rxError('repeat count above ' + RX_MAX_REPEAT);
        if (max !== -1 && max < min) throw rxError('{n,m} with m below n');
        i += m[0].length;
        return { min, max };
    }

    function piece() {
        let node = atom();
        for (;;) {
            const ch = peek();
            let q = null;
            if (ch === '*') { i++; q = { min: 0, max: -1 }; }
            else if (ch === '+') { i++; q = { min: 1, max: -1 }; }
            else if (ch === '?') { i++; q = { min: 0, max: 1 }; }
            else if (ch === '{') q = braces();
            if (!q) return node;
            if (node.t === 'assert') throw rxError('nothing to repeat');
            if (src[i] === '?') i++;
            else if (src[i] === '+') throw rxError('possessive quantifiers are not supported');
            node = { t: 'rep', node, min: q.min, max: q.max };
        }
    }

    function cat() {
        const list = [];
        while (i < n && src[i] !== '|' && src[i] !== ')') list.push(piece());
        return list.length === 1 ? list[0] : { t: 'cat', list };
    }

    function alt() {
        const list = [cat()];
        while (src[i] === '|') { i++; list.push(cat()); }
        return list.length === 1 ? list[0] : { t: 'alt', list };
    }

    const tree = alt();
    if (i < n) throw rxError('unmatched )');
    return tree;
}

// Program size of a tree, refusing anything past RX_MAX_PROG before it is built.
function rxSize(node) {
    let s;
    switch (node.t) {
        case 'char': case 'assert': return 1;
        case 'cat': s = 0; for (const k of node.list) s += rxSize(k); break;
        case 'alt': s = 0; for (const k of node.list) s += rxSize(k) + 2; break;
        case 'rep': {
            const b = rxSize(node.node);
            s = b * node.min + (node.max === -1 ? b + 2 : (b + 1) * (node.max - node.min));
            break;
        }
        default: s = 0;
    }
    if (s > RX_MAX_PROG) throw rxError('pattern too large (over ' + RX_MAX_PROG + ' steps once repeats are expanded)');
    return s;
}

function rxCompile(tree) {
    rxSize(tree);
    const op = [];
    const a = [];
    const b = [];
    const emit = (o, x, y) => { op.push(o); a.push(x); b.push(y); return op.length - 1; };
    function gen(node) {
        switch (node.t) {
            case 'char': emit(RX_CHAR, node.cls, 0); return;
            case 'assert': emit(RX_ASSERT, node.kind, 0); return;
            case 'cat': for (const k of node.list) gen(k); return;
            case 'alt': {
                const jumps = [];
                for (let k = 0; k < node.list.length; k++) {
                    if (k < node.list.length - 1) {
                        const sp = emit(RX_SPLIT, 0, 0);
                        a[sp] = sp + 1;
                        gen(node.list[k]);
                        jumps.push(emit(RX_JMP, 0, 0));
                        b[sp] = op.length;
                    } else {
                        gen(node.list[k]);
                    }
                }
                for (const j of jumps) a[j] = op.length;
                return;
            }
            case 'rep': {
                for (let k = 0; k < node.min; k++) gen(node.node);
                if (node.max === -1) {
                    const sp = emit(RX_SPLIT, 0, 0);
                    a[sp] = sp + 1;
                    gen(node.node);
                    emit(RX_JMP, sp, 0);
                    b[sp] = op.length;
                } else {
                    const splits = [];
                    for (let k = node.min; k < node.max; k++) {
                        const sp = emit(RX_SPLIT, 0, 0);
                        a[sp] = sp + 1;
                        splits.push(sp);
                        gen(node.node);
                    }
                    for (const sp of splits) b[sp] = op.length;
                }
                return;
            }
            default: return;
        }
    }
    gen(tree);
    emit(RX_MATCH, 0, 0);
    return { op, a, b };
}

function rxProgram(pattern) {
    let prog = regexCache.get(pattern);
    if (prog === undefined) {
        try {
            if (pattern.length > RX_MAX_PATTERN) throw rxError('pattern longer than ' + RX_MAX_PATTERN + ' characters');
            prog = rxCompile(rxParse(pattern));
        } catch (e) {
            prog = { error: e.message };
        }
        if (regexCache.size >= 256) regexCache.delete(regexCache.keys().next().value);
        regexCache.set(pattern, prog);
    }
    if (prog.error) throw new Error(prog.error);
    return prog;
}

// Case folds one code point the way MariaDB's _ci collations compare.
function rxFold(c, upper) {
    if (c < 128) {
        if (upper) return c >= 97 && c <= 122 ? c - 32 : c;
        return c >= 65 && c <= 90 ? c + 32 : c;
    }
    const s = String.fromCodePoint(c);
    const f = upper ? s.toUpperCase() : s.toLowerCase();
    return f.length === s.length ? f.codePointAt(0) : c;
}

// True when the pattern matches anywhere in value, ignoring case.
function rxTest(pattern, value) {
    const prog = rxProgram(pattern);
    const cps = [];
    for (let k = 0; k < value.length; k++) {
        const c = value.codePointAt(k);
        if (c > 0xffff) k++;
        cps.push(c);
    }
    const n = cps.length;
    const size = prog.op.length;
    if (size * (n + 1) > RX_MAX_WORK) throw rxError('pattern and value too large to match safely');
    if (!rxResetQueued) {
        rxResetQueued = true;
        queueMicrotask(rxResetSpent);
    }
    const { op, a, b } = prog;
    const mark = new Int32Array(size);
    const stack = [];
    const word = (k) => k >= 0 && k < n && isWordCp(cps[k]);
    function holds(kind, pos) {
        switch (kind) {
            case 'begin': return pos === 0;
            case 'end': return pos === n;
            case 'eol': return pos === n || (pos === n - 1 && cps[pos] === 10);
            case 'wb': return word(pos - 1) !== word(pos);
            case 'nwb': return word(pos - 1) === word(pos);
            case 'wbstart': return !word(pos - 1) && word(pos);
            case 'wbend': return word(pos - 1) && !word(pos);
            default: return false;
        }
    }
    // Adds pc and every state reachable from it without reading a character
    // to list. Returns true when one of them is MATCH.
    function add(list, pc, pos, stamp) {
        stack.push(pc);
        while (stack.length) {
            const p = stack.pop();
            if (++rxSpent > RX_MAX_WORK) throw rxError('statement matched too much text to finish safely');
            if (mark[p] === stamp) continue;
            mark[p] = stamp;
            switch (op[p]) {
                case RX_MATCH: stack.length = 0; return true;
                case RX_CHAR: list.push(p); break;
                case RX_JMP: stack.push(a[p]); break;
                case RX_SPLIT: stack.push(b[p], a[p]); break;
                case RX_ASSERT: if (holds(a[p], pos)) stack.push(p + 1); break;
                default: break;
            }
        }
        return false;
    }
    let list = [];
    for (let pos = 0; ; pos++) {
        if (add(list, 0, pos, pos + 1)) return true;
        if (pos === n) return false;
        const c = cps[pos];
        const lo = rxFold(c, false);
        const up = rxFold(c, true);
        const next = [];
        for (let k = 0; k < list.length; k++) {
            const p = list[k];
            const cls = a[p];
            const hit = rxInClass(cls, c) || rxInClass(cls, lo) || rxInClass(cls, up);
            if (hit !== cls.neg && add(next, p + 1, pos + 1, pos + 2)) return true;
        }
        list = next;
    }
}

// ---- SQL functions registered on SQLite connections --------------------------------------------
// MySQL functions SQLite lacks, registered on each connection by server.js
// under their MySQL names, so the SQL needs no rewrite. A NULL argument
// gives NULL, as in MySQL.
const PAD_MAX = 1048576;

function pad(left) {
    return (s, len, fill) => {
        if (s == null || len == null || fill == null) return null;
        const n = Math.trunc(Number(len));
        if (!(n >= 0) || n > PAD_MAX) return null;
        const str = String(s);
        if (str.length >= n) return str.slice(0, n);
        const f = String(fill);
        if (!f) return null;
        let run = '';
        while (run.length < n - str.length) run += f;
        run = run.slice(0, n - str.length);
        return left ? run + str : str + run;
    };
}

const UUID_NODE = (() => {
    const b = require('crypto').randomBytes(8);
    b[2] |= 0x01; // a random node sets the multicast bit (RFC 4122 4.5)
    return { seq: ((b[0] << 8) | b[1]) & 0x3fff | 0x8000, node: b.subarray(2).toString('hex') };
})();
let uuidLast = 0n;
function uuidV1() {
    let t = BigInt(Date.now()) * 10000n + 0x01b21dd213814000n;
    if (t <= uuidLast) t = uuidLast + 1n;
    uuidLast = t;
    const h = t.toString(16).padStart(15, '0');
    return h.slice(7) + '-' + h.slice(3, 7) + '-1' + h.slice(0, 3) + '-' + UUID_NODE.seq.toString(16) + '-' + UUID_NODE.node;
}
const UUID_SHORT_BASE = BigInt(Math.floor(Date.now() / 1000)) << 24n;
let uuidShortN = -1;

const sqlFunctions = [
    {
        // The utf8mb4_general_ci sort key (collateText). INTEGER
        // arguments arrive as BigInt and come back as they were.
        name: 'cis_ci',
        bigint: true,
        fn: generalCiKey,
    },
    {
        // The utf8mb4_unicode_ci sort key (collateText).
        name: 'cis_uci',
        bigint: true,
        fn: unicodeCiKey,
    },
    {
        // TRUNCATE(x, d) cuts toward zero; ROUND would round 1.999 up to 2.
        // INTEGER arguments arrive as BigInt, so an integer stays one.
        name: 'TRUNCATE',
        bigint: true,
        fn(x, d) {
            if (x == null || d == null) return null;
            const k = Math.max(-30, Math.min(30, Math.trunc(Number(d))));
            if (typeof x === 'bigint') {
                if (k >= 0) return x;
                const f = 10n ** BigInt(-k);
                return (x / f) * f;
            }
            const v = Number(x);
            if (!Number.isFinite(v)) return null;
            const f = Math.pow(10, Math.abs(k));
            // toPrecision(15) drops binary noise: 1.15 * 100 is 114.99999999999999.
            const scaled = Number((k >= 0 ? v * f : v / f).toPrecision(15));
            return k >= 0 ? Math.trunc(scaled) / f : Math.trunc(scaled) * f;
        },
    },
    {
        // Text before the count-th delimiter, or after it counting from the
        // right when count is negative. Case-sensitive, as in MySQL.
        name: 'SUBSTRING_INDEX',
        fn(s, delim, count) {
            if (s == null || delim == null || count == null) return null;
            const str = String(s);
            const d = String(delim);
            let n = Math.trunc(Number(count));
            if (!d || !n) return '';
            if (n > 0) {
                let at = -d.length;
                while (n-- > 0) {
                    at = str.indexOf(d, at + d.length);
                    if (at < 0) return str;
                }
                return str.slice(0, at);
            }
            let end = str.length;
            while (n++ < 0) {
                end = end - d.length < 0 ? -1 : str.lastIndexOf(d, end - d.length);
                if (end < 0) return str;
            }
            return str.slice(end + d.length);
        },
    },
    {
        name: 'UNHEX',
        fn(s) {
            if (s == null) return null;
            let hex = String(s);
            if (!/^[0-9A-Fa-f]*$/.test(hex)) return null;
            if (hex.length % 2) hex = '0' + hex;
            return Buffer.from(hex, 'hex');
        },
    },
    {
        // The JSON text from doc -> path (see markJsonBooleans): true and
        // false become markers, the rest what json_extract returns.
        name: 'cis_json_value',
        fn(json) {
            if (json == null) return null;
            const s = String(json);
            if (s === 'true') return JSON_TRUE;
            if (s === 'false') return JSON_FALSE;
            if (s === 'null') return null;
            const c = s.charCodeAt(0);
            if (c === 123 || c === 91) return s;
            try { return JSON.parse(s); } catch (e) { return s; }
        },
    },
    {
        // x REGEXP p calls regexp(p, x). MariaDB matches with PCRE and, on
        // the _ci collations every framework uses, ignores case. rxTest
        // runs in linear time; see the REGEXP section above.
        name: 'regexp',
        fn(pattern, value) {
            if (pattern == null || value == null) return null;
            return rxTest(String(pattern), String(value)) ? 1 : 0;
        },
    },
    { name: 'LPAD', fn: pad(true) },
    { name: 'RPAD', fn: pad(false) },
    // UUID() is a version 1 UUID as MariaDB makes it: the time in 100 ns
    // steps since 1582-10-15, a clock sequence and a node, fixed per process.
    // Volatile: each call gives a new one, also within one statement.
    { name: 'UUID', volatile: true, fn: uuidV1 },
    // UUID_SHORT() is (server_id & 255) << 56 | startup seconds << 24 |
    // counter, a 64-bit integer that goes up by one per call. One process is
    // server 0.
    { name: 'UUID_SHORT', volatile: true, fn: () => UUID_SHORT_BASE + BigInt(++uuidShortN) },
];

// Variance and standard deviation (Welford's method). STD, STDDEV and
// VARIANCE are the population forms in MySQL.
function spread(sample, root) {
    return {
        start: () => [0, 0, 0],
        step(acc, v) {
            if (v == null) return acc;
            const x = Number(v);
            const n = acc[0] + 1;
            const d = x - acc[1];
            const mean = acc[1] + d / n;
            return [n, mean, acc[2] + d * (x - mean)];
        },
        result(acc) {
            const n = acc[0];
            if (n === 0 || (sample && n < 2)) return null;
            const v = acc[2] / (sample ? n - 1 : n);
            return root ? Math.sqrt(v) : v;
        },
    };
}

const sqlAggregates = [
    { name: 'STD', ...spread(false, true) },
    { name: 'STDDEV', ...spread(false, true) },
    { name: 'STDDEV_POP', ...spread(false, true) },
    { name: 'STDDEV_SAMP', ...spread(true, true) },
    { name: 'VARIANCE', ...spread(false, false) },
    { name: 'VAR_POP', ...spread(false, false) },
    { name: 'VAR_SAMP', ...spread(true, false) },
];

// What server.js (and the tests) use from this module.
module.exports = {
    onUpdateTriggerSql,
    insertDefaultTriggerSql,
    strictTriggersSql,
    STRICT_TRIGGER,
    defaultFromMaria,
    ON_UPDATE_TRIGGER,
    DEFAULT_TRIGGER,
    foreignKeyTriggersSql,
    infoSchemaViewsSql,
    translateExpr: ddlExpr,
    setDatabaseName,
    FK_TRIGGER,
    translate,
    sqlFunctions,
    sqlAggregates,
    JSON_TRUE,
    JSON_FALSE,
    firstKeyword,
    isWriteStatement,
    dashComment,
    setSchemaProvider,
    setCollationProvider,
    forgetSchema,
    forgetColumns,
    generalCiKey,
    unicodeCiKey,
    columnMeta,
    identOk,
    extractTables,
    isForbiddenSql,
    mapCode,
    topKeyword,
    lexSql,
    cache,
};
