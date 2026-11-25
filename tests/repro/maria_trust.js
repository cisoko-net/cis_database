'use strict';

// Reads SQLite runs but would answer otherwise are answered by MariaDB, so a
// caller never gets a silently different value. Each case runs through the
// engine and through mysql2 with oxmysql's pool options and typeCast on the
// same MariaDB, and both answers must be equal. The rules key on the
// statement's shape, a column's declared type and the value bound, never on a
// name: every case runs on two schemas whose tables and columns are named
// differently. Cases that SQLite answers as MariaDB does must stay on SQLite.
//
// Also: a text column that gets accents by a write is noticed at once; a
// routed read sees a write made a moment before (the outbox is copied first);
// with node:sqlite hidden (FX_BACKEND=sql.js) the same holds.
//
// Usage: node tests/repro/maria_trust.js
//   FX_TRUST_MARIA (default mysql://root@127.0.0.1:3307) names a MariaDB it
//   may write to (database cm_trust is dropped and made again). Without a
//   reachable MariaDB it prints SKIP.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const URL_ = process.env.FX_TRUST_MARIA || 'mysql://root@127.0.0.1:3307';
const DB = 'cm_trust';

// The values the API gives for each column type (tests/harness/result_cast.js).
const { makeQueryCast, executeCast: typeCastExecute } = require('../harness/result_cast.js');
const typeCast = makeQueryCast({ bitBy: 'field' });

// Two schemas, same shape, different names.
const SCHEMAS = [
    { T: 'gear', U: 'gear_tag', id: 'id', n: 'qty', b: 'big', p: 'cost', d: 'w', f: 'ratio', s: 'label', e: 'tier', g: 'on_duty', c: 'made', dy: 'day', j: 'meta', bt: 'bits', bl: 'raw', k: 'gear_id', tag: 'tag' },
    { T: 'zz_people', U: 'zz_notes', id: 'pid', n: 'n', b: 'b', p: 'price', d: 'dbl', f: 'flt', s: 'name', e: 'grade', g: 'flag', c: 'created', dy: 'born', j: 'data', bt: 'bit1', bl: 'blob1', k: 'person', tag: 'note' },
];
const fill = (sql, S) => sql.replace(/\{(\w+)\}/g, (m, k) => (S[k] !== undefined ? '`' + S[k] + '`' : m));

const SETUP = [
    'CREATE TABLE {T} ({id} INT AUTO_INCREMENT PRIMARY KEY, {n} INT, {b} BIGINT, {p} DECIMAL(10,2), {d} DOUBLE, {f} FLOAT, {s} VARCHAR(50), {e} ENUM(\'low\',\'mid\',\'high\'), {g} TINYINT(1), {c} DATETIME, {dy} DATE, {j} LONGTEXT, {bt} BIT(1), {bl} BLOB)',
    'CREATE TABLE {U} ({id} INT AUTO_INCREMENT PRIMARY KEY, {k} INT, {tag} VARCHAR(20))',
    'INSERT INTO {T} ({n},{b},{p},{d},{f},{s},{e},{g},{c},{dy},{j},{bt},{bl}) VALUES (5,10,5.30,2.5,1.25,\'Bob\',\'high\',1,\'2024-01-02 03:04:05\',\'2024-01-02\',\'{"name":"Bob","n":3,"flag":true,"obj":{"a":1}}\',1,X\'00FF\')',
    'INSERT INTO {T} ({n},{b},{p},{d},{f},{s},{e},{g},{c},{dy},{j},{bt},{bl}) VALUES (2,20,1.10,0.1,2.5,\'alice\',\'low\',0,\'2024-03-04 05:06:07\',\'2024-03-04\',\'{"name":"alice","n":7}\',0,NULL)',
    'INSERT INTO {T} ({n},{b},{p},{d},{f},{s},{e},{g},{c},{dy},{j},{bt},{bl}) VALUES (NULL,NULL,NULL,NULL,NULL,\'Émile\',\'mid\',NULL,NULL,NULL,NULL,NULL,NULL)',
    'INSERT INTO {U} ({k},{tag}) VALUES (1,\'x\'),(1,\'y\'),(2,\'x\')',
];

// [sql, params, route] where route says whether MariaDB must answer it:
// true, false, or null for "either way, as long as the answer is MariaDB's".
const CASES = [
    // Computed values: SQLite's numbers, text and JSON differ.
    ['SELECT {n} / 2 AS v FROM {T} ORDER BY {id}', [], true],
    ['SELECT SUM({p}) AS v FROM {T}', [], true],
    ['SELECT AVG({n}) AS v FROM {T}', [], true],
    ['SELECT ROUND({d}) AS v FROM {T} ORDER BY {id}', [], true],
    ['SELECT CONCAT({p}, \'x\') AS v FROM {T} ORDER BY {id}', [], true],
    ['SELECT JSON_EXTRACT({j}, \'$.name\') AS v FROM {T} ORDER BY {id}', [], true],
    ['SELECT JSON_OBJECT(\'a\', 1) AS v', [], true],
    ['SELECT {j}->>\'$.name\' AS v FROM {T} ORDER BY {id}', [], true],
    ['SELECT MAX({c}) AS v FROM {T}', [], true],
    ['SELECT DATE({c}) AS v FROM {T} ORDER BY {id}', [], true],
    ['SELECT LENGTH({s}) AS v FROM {T} ORDER BY {id}', [], true],
    ['SELECT GREATEST(1, \'2\') AS v', [], true],
    ['SELECT \'a\' || \'b\' AS v', [], true],
    // Columns whose stored form differs.
    ['SELECT {f} FROM {T} ORDER BY {id}', [], true],
    ['SELECT {bt}, {bl} FROM {T} ORDER BY {id}', [], true],
    ['SELECT * FROM {T} ORDER BY {id}', [], true],
    ['SELECT {id} FROM {T} ORDER BY {e}', [], true],
    ['SELECT {id} FROM {T} WHERE {e} = 2', [], true],
    // Comparisons SQLite types otherwise.
    ['SELECT {id} FROM {T} WHERE {s} = 0', [], true],
    ['SELECT {id} FROM {T} WHERE {s} = ?', [5], true],
    ['SELECT {id} FROM {T} WHERE {n} = 5 || {n} = 2 ORDER BY {id}', [], true],
    ['SELECT {id} FROM {T} WHERE {n} / 2 = 2.5', [], true],
    ['SELECT {id} FROM {T} WHERE LOWER({s}) = \'émile\'', [], true],
    ['SELECT {id} FROM {T} WHERE {c} = ?', [1704164645000], true],
    ['SELECT {id} FROM {T} ORDER BY {id} LIMIT ?', ['2'], true],
    // Accents and trailing spaces: utf8mb4_general_ci folds them.
    ['SELECT {id} FROM {T} WHERE {s} = \'emile\'', [], true],
    ['SELECT {id} FROM {T} WHERE {s} = ?', ['BOB '], true],
    ['SELECT {id} FROM {T} WHERE {s} LIKE ?', ['é%'], true],
    ['SELECT {id} FROM {T} WHERE {s} = ?', ['bob'], true],
    ['SELECT {id} FROM {T} ORDER BY {s}', [], true],
    // Reads SQLite answers as MariaDB does stay on SQLite.
    ['SELECT {id}, {n} FROM {T} ORDER BY {n}', [], false],
    ['SELECT {id} FROM {T} WHERE {n} = ?', [5], false],
    ['SELECT {id} FROM {T} WHERE {n} = ?', ['5'], false],
    ['SELECT {id}, {p}, {d}, {g}, {c}, {dy} FROM {T} WHERE {id} = ?', [1], false],
    ['SELECT COUNT(*) AS v FROM {T} WHERE {g} = ?', [true], false],
    ['SELECT {id} FROM {T} WHERE {p} = ?', ['5.3'], false],
    ['SELECT {id} FROM {T} WHERE {c} > ?', ['2024-02-01'], false],
    ['SELECT {id} FROM {T} WHERE YEAR({c}) = 2024 ORDER BY {id}', [], false],
    ['SELECT {id} FROM {T} WHERE IFNULL({n}, 0) = 0', [], false],
    ['SELECT x.{id}, y.{tag} FROM {T} x JOIN {U} y ON y.{k} = x.{id} WHERE y.{tag} = ? ORDER BY x.{id}', ['x'], false],
    ['SELECT COUNT(*) FROM {U} WHERE {k} IN (?, ?)', [1, 2], false],
    ['SELECT {tag} FROM {U} WHERE {k} = ? ORDER BY {id} LIMIT 1', [1], false],
    ['SELECT * FROM {U} WHERE {id} = ?', [2], false],
];

const plain = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Uint8Array) return [...v];
    if (Array.isArray(v)) return v.map(plain);
    if (typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = plain(v[k]); return o; }
    return v;
};

function reachable(u) {
    const m = /\/\/(?:[^@/]*@)?([^:/]+):?(\d+)?/.exec(u);
    return new Promise((res) => {
        const s = net.connect(Number(m[2] || 3306), m[1]);
        s.setTimeout(1500);
        s.on('connect', () => { s.destroy(); res(true); });
        s.on('error', () => res(false));
        s.on('timeout', () => { s.destroy(); res(false); });
    });
}

let failed = 0;
function check(name, ok, detail) {
    if (ok) return;
    failed++;
    console.log('FAIL ' + name + (detail ? '\n   ' + detail : ''));
}

(async () => {
    if (!(await reachable(URL_))) { console.log('SKIP no MariaDB at ' + URL_); process.exit(0); }
    const mysql = require('mysql2/promise');
    const root = await mysql.createConnection(URL_ + '?multipleStatements=true');
    await root.query('DROP DATABASE IF EXISTS ' + DB + '; CREATE DATABASE ' + DB + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci; USE ' + DB);
    for (const S of SCHEMAS) for (const s of SETUP) await root.query(fill(s, S));
    await root.end();

    process.env.FX_RES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-trust-'));
    process.env.FX_REAL_MARIA = '1';
    process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: URL_ + '/' + DB, cis_database_cdc: '0' });
    const fx = require('../harness/fx.js');
    if (!(await fx.ready(60000))) { console.log('FAIL engine not ready'); process.exit(1); }
    const ref = await mysql.createPool({ uri: URL_ + '/' + DB, supportBigNumbers: true, jsonStrings: true, charset: 'utf8mb4_general_ci', connectionLimit: 1 });

    const eng = (kind, sql, p) => new Promise((res) => fx.registry[kind](sql, p, (v, e) => res(e != null ? { err: true } : { v: plain(v) }), 'test', true));
    const want = async (kind, sql, p) => {
        try {
            const [rows] = await ref.query({ sql, values: p, typeCast: kind === 'prepare' ? typeCastExecute : typeCast });
            const r0 = rows[0] || null;
            // oxmysql's rawExecute (prepare) answers the rows of a read of several
            // rows, else the one value of a one-column row, else the row.
            const one = rows.length > 1 ? rows : r0 && Object.keys(r0).length === 1 ? Object.values(r0)[0] : r0;
            return { v: plain(kind === 'scalar' ? (r0 ? Object.values(r0)[0] : null) : kind === 'single' ? r0 : kind === 'prepare' ? one : rows) };
        } catch (e) { return { err: true }; }
    };
    const routedBy = async (fn) => { const a = fx.registry.probe().maria_reads; await fn(); return fx.registry.probe().maria_reads > a; };

    let ran = 0;
    for (const S of SCHEMAS) {
        for (const [tpl, p, route] of CASES) {
            const sql = fill(tpl, S);
            for (const kind of ['query', 'scalar', 'single', 'prepare']) {
                ran++;
                let got;
                const routed = await routedBy(async () => { got = await eng(kind, sql, p); });
                const exp = await want(kind, sql, p);
                check(kind + ' ' + sql + ' ' + JSON.stringify(p), JSON.stringify(got) === JSON.stringify(exp),
                    'engine ' + JSON.stringify(got).slice(0, 200) + '\n   maria  ' + JSON.stringify(exp).slice(0, 200));
                if (route !== null && kind === 'query') check('route ' + sql + ' ' + JSON.stringify(p), routed === route, 'answered by ' + (routed ? 'MariaDB' : 'SQLite'));
            }
        }
    }

    // Named values (@x, :x, ['@x']) and IN (?) lists on reads MariaDB
    // answers: the engine binds them as it does on SQLite, so the answer
    // equals MariaDB's answer to the positional form. Each has a trust
    // reason (an aggregate or an accented value), so MariaDB answers it.
    const NAMED = [
        ['SELECT SUM({n}) AS v FROM {T} WHERE {s} = @who', { who: 'Bob' }, 'SELECT SUM({n}) AS v FROM {T} WHERE {s} = ?', ['Bob']],
        ['SELECT SUM({n}) AS v FROM {T} WHERE {s} = :who', { who: 'Bob' }, 'SELECT SUM({n}) AS v FROM {T} WHERE {s} = ?', ['Bob']],
        ['SELECT SUM({n}) AS v FROM {T} WHERE {s} = @who', { '@who': 'Bob' }, 'SELECT SUM({n}) AS v FROM {T} WHERE {s} = ?', ['Bob']],
        ['SELECT {id} FROM {T} WHERE {s} = @who ORDER BY {id}', { who: 'Émile' }, 'SELECT {id} FROM {T} WHERE {s} = ? ORDER BY {id}', ['Émile']],
        ['SELECT {id} FROM {T} WHERE {s} = @who AND {e} = @tier ORDER BY {id}', { '@who': 'Émile', '@tier': 'mid' }, 'SELECT {id} FROM {T} WHERE {s} = ? AND {e} = ? ORDER BY {id}', ['Émile', 'mid']],
        ['SELECT SUM({n}) AS v FROM {T} WHERE {s} IN (?)', [['Bob', 'alice']], 'SELECT SUM({n}) AS v FROM {T} WHERE {s} IN (?, ?)', ['Bob', 'alice']],
        ['SELECT {id} FROM {T} WHERE {s} IN (?) ORDER BY {id}', [['Émile', 'alice']], 'SELECT {id} FROM {T} WHERE {s} IN (?, ?) ORDER BY {id}', ['Émile', 'alice']],
        ['SELECT SUM({n}) AS v FROM {T} WHERE {s} IN (@who)', { who: ['Bob', 'alice'] }, 'SELECT SUM({n}) AS v FROM {T} WHERE {s} IN (?, ?)', ['Bob', 'alice']],
        // A missing trailing value is NULL, as on SQLite, not a parse error.
        ['SELECT SUM({n}) AS v FROM {T} WHERE {s} = ? OR {s} = ?', ['Bob'], 'SELECT SUM({n}) AS v FROM {T} WHERE {s} = ? OR {s} = ?', ['Bob', null]],
    ];
    for (const S of SCHEMAS) {
        for (const [tpl, p, ptpl, pp] of NAMED) {
            const sql = fill(tpl, S);
            const exp0 = await want('query', fill(ptpl, S), pp);
            check('positional answer has rows ' + ptpl, exp0.v && exp0.v.length > 0, JSON.stringify(exp0));
            for (const kind of ['query', 'scalar', 'single', 'prepare']) {
                ran++;
                let got;
                const routed = await routedBy(async () => { got = await eng(kind, sql, p); });
                const exp = await want(kind, fill(ptpl, S), pp);
                check(kind + ' ' + sql + ' ' + JSON.stringify(p), JSON.stringify(got) === JSON.stringify(exp),
                    'engine ' + JSON.stringify(got).slice(0, 200) + '\n   maria  ' + JSON.stringify(exp).slice(0, 200));
                if (kind === 'query') check('route ' + sql + ' ' + JSON.stringify(p), routed, 'answered by SQLite');
            }
        }
    }

    // A text column with only plain ASCII stays on SQLite until a write
    // stores an accent in it; from then on its reads go to MariaDB, and the
    // read sees that write.
    for (const S of SCHEMAS) {
        const sql = fill('SELECT {id} FROM {U} WHERE {tag} = ? ORDER BY {id}', S);
        check('plain text stays on SQLite', !(await routedBy(() => eng('query', sql, ['x']))));
        await eng('insert', fill('INSERT INTO {U} ({k}, {tag}) VALUES (?, ?)', S), [3, 'Zoë']);
        let got;
        const routed = await routedBy(async () => { got = await eng('query', sql, ['zoe']); });
        check('accented write sends the column to MariaDB', routed);
        check('MariaDB sees the write made just before', JSON.stringify(got) === JSON.stringify(await want('query', sql, ['zoe'])), JSON.stringify(got));
        check('routed read found the new row', got.v && got.v.length === 1, JSON.stringify(got));
        // A write then an at-once routed read of the same table.
        await eng('update', fill('UPDATE {T} SET {n} = ? WHERE {id} = ?', S), [41, 2]);
        const sum = await eng('scalar', fill('SELECT SUM({n}) AS v FROM {T}', S), []);
        check('routed SUM sees the write made just before', JSON.stringify(sum) === JSON.stringify(await want('scalar', fill('SELECT SUM({n}) AS v FROM {T}', S), [])), JSON.stringify(sum));
    }

    await ref.end();
    const c = await mysql.createConnection(URL_);
    await c.query('DROP DATABASE IF EXISTS ' + DB);
    await c.end();
    if (failed) { console.log(failed + ' of ' + ran + ' failed'); process.exit(1); }
    console.log('all passed (' + ran + ' reads, ' + (process.env.FX_BACKEND || 'node:sqlite') + ')');
    process.exit(0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack)); process.exit(1); });
