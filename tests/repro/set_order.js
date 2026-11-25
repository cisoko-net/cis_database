'use strict';

// MariaDB runs the assignments of a single-table UPDATE and of ON DUPLICATE
// KEY UPDATE left to right: a column assigned earlier reads its new value in
// the assignments after it. SQLite reads the old row in every assignment, so
// SQLite and MariaDB stored different values for the same statement (v-phone's
// `streak = streak + 1, best = GREATEST(best, streak + 1)`). Each write here
// runs through the engine and, as a reference, on MariaDB itself; the rows
// SQLite holds, the rows the engine copied to MariaDB and the reference must
// all be equal. Two schemas with different names, so no rule keys on a name.
//
// Also: SELECT LAST_INSERT_ID() is the caller's last insert, answered by the
// engine, never by a MariaDB pool connection that ran no insert (it said 0).
//
// Usage: node tests/repro/set_order.js
//   FX_TRUST_MARIA (default mysql://root@127.0.0.1:3307) names a MariaDB it
//   may write to (databases cm_seq_eng and cm_seq_ref are dropped and made
//   again). Without a reachable MariaDB it prints SKIP.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const URL_ = process.env.FX_TRUST_MARIA || 'mysql://root@127.0.0.1:3307';
const ENG = 'cm_seq_eng';
const REF = 'cm_seq_ref';

const SCHEMAS = [
    { T: 'stats', L: 'licenses', id: 'id', k: 'cid', a: 'streak', b: 'best', c: 'wins' },
    { T: 'zz_rows', L: 'zz_grants', id: 'rid', k: 'owner', a: 'n1', b: 'n2', c: 'n3' },
];
const fill = (sql, S) => sql.replace(/\{(\w+)\}/g, (m, k) => (S[k] !== undefined ? '`' + S[k] + '`' : m));

const SETUP = [
    'CREATE TABLE {T} ({id} INT AUTO_INCREMENT PRIMARY KEY, {k} VARCHAR(20) NOT NULL UNIQUE, {a} INT NOT NULL DEFAULT 0, {b} INT NOT NULL DEFAULT 0, {c} INT NOT NULL DEFAULT 0)',
    "INSERT INTO {T} ({k}, {a}, {b}, {c}) VALUES ('x', 1, 1, 1), ('y', 4, 2, 9)",
    'CREATE TABLE {L} ({id} INT NOT NULL AUTO_INCREMENT, {k} VARCHAR(20) NOT NULL, {a} VARCHAR(20) NOT NULL, PRIMARY KEY ({id}), UNIQUE KEY u ({a}, {k}))',
];

// [sql, params] run in order on both sides.
const WRITES = [
    ['UPDATE {T} SET {a} = {a} + ?, {b} = {a} * 10 WHERE {k} = ?', [2, 'x']],
    ["UPDATE {T} SET {a} = {a} + 1, {b} = {T}.{a} + {b}, {c} = {b} WHERE {k} = 'x'", []],
    ['INSERT INTO {T} ({k}, {a}, {b}, {c}) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE {a} = IF(? = 1, {a} + 1, 0), {b} = GREATEST({b}, IF(? = 1, {a} + 1, 0))', ['x', 1, 1, 1, 1, 1]],
    ['INSERT INTO {T} ({k}, {a}, {b}, {c}) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE {a} = IF(? = 1, {a} + 1, 0), {b} = GREATEST({b}, IF(? = 1, {a} + 1, 0))', ['y', 1, 1, 1, 0, 0]],
    ["INSERT INTO {T} ({k}, {a}, {b}, {c}) VALUES ('x', 5, 6, 7) ON DUPLICATE KEY UPDATE {a} = VALUES({a}), {b} = {a} + VALUES({b}), {c} = {c} + 1", []],
    ["UPDATE {T} SET {a} = {a} * 2, {c} = {a} WHERE {k} = 'y' LIMIT 1", []],
    ['UPDATE {T} SET {c} = {c} - ?, {a} = {c} WHERE {a} > ?', [1, 0]],
    // Nothing reads an earlier assignment: unchanged behaviour.
    ['UPDATE {T} SET {a} = 1, {b} = 2 WHERE {a} = 999', []],
];

const plain = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x)));

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
let checks = 0;
function check(name, ok, detail) {
    checks++;
    if (ok) return;
    failed++;
    console.log('FAIL ' + name + (detail ? '\n   ' + detail : ''));
}

(async () => {
    if (!(await reachable(URL_))) { console.log('SKIP no MariaDB at ' + URL_); process.exit(0); }
    const mysql = require('mysql2/promise');
    const root = await mysql.createConnection(URL_ + '?multipleStatements=true');
    for (const db of [ENG, REF]) {
        await root.query('DROP DATABASE IF EXISTS ' + db + '; CREATE DATABASE ' + db + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci; USE ' + db);
        for (const S of SCHEMAS) for (const s of SETUP) await root.query(fill(s, S));
    }
    await root.end();

    process.env.FX_RES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-seq-'));
    process.env.FX_REAL_MARIA = '1';
    process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: URL_ + '/' + ENG, cis_database_cdc: '0' });
    const fx = require('../harness/fx.js');
    if (!(await fx.ready(60000))) { console.log('FAIL engine not ready'); process.exit(1); }
    const ref = await mysql.createConnection({ uri: URL_ + '/' + REF, supportBigNumbers: true });
    const copy = await mysql.createConnection({ uri: URL_ + '/' + ENG, supportBigNumbers: true });

    const eng = (kind, sql, p) => new Promise((res) => fx.registry[kind](sql, p, (v, e) => res(e != null ? { err: String(e) } : { v: plain(v) }), 'test', true));
    const routedBy = async (fn) => { const a = fx.registry.probe().maria_reads; await fn(); return fx.registry.probe().maria_reads > a; };

    for (const S of SCHEMAS) {
        const read = fill('SELECT {k}, {a}, {b}, {c} FROM {T} ORDER BY {id}', S);
        for (const [tpl, p] of WRITES) {
            const sql = fill(tpl, S);
            const got = await eng('update', sql, p);
            const [res] = await ref.query(sql, p);
            check('write answers ' + sql, got.err === undefined, got.err);
            check('affected rows ' + sql, got.v === res.affectedRows, 'engine ' + got.v + ' maria ' + res.affectedRows);
            let rows;
            const routed = await routedBy(async () => { rows = await eng('query', read, []); });
            check('plain int read stays on SQLite', !routed);
            const [want] = await ref.query(read);
            check('SQLite holds what MariaDB stores after ' + sql, JSON.stringify(rows.v) === JSON.stringify(plain(want)),
                'engine ' + JSON.stringify(rows.v) + '\n   maria  ' + JSON.stringify(plain(want)));
        }
        // The engine's own MariaDB copy ends up with the same rows.
        const [want] = await ref.query(read);
        let same = false;
        let last;
        for (let i = 0; i < 100 && !same; i++) {
            [last] = await copy.query(read);
            same = JSON.stringify(plain(last)) === JSON.stringify(plain(want));
            if (!same) await new Promise((r) => setTimeout(r, 100));
        }
        check('the engine copied the same rows to MariaDB (' + S.T + ')', same, 'copy ' + JSON.stringify(plain(last)) + '\n   ref  ' + JSON.stringify(plain(want)));

        // LAST_INSERT_ID() after an insert is that insert's id, from the engine.
        const ins = await eng('insert', fill('INSERT INTO {T} ({k}) VALUES (?)', S), ['z' + S.T]);
        let lid;
        const routed = await routedBy(async () => { lid = await eng('scalar', 'SELECT LAST_INSERT_ID() AS id', []); });
        check('LAST_INSERT_ID() is not sent to MariaDB', !routed);
        check('LAST_INSERT_ID() is the last insert id', ins.v > 0 && lid.v === ins.v, JSON.stringify({ ins, lid }));

        // esx_license: ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id) gives
        // the id of the row it found, though nothing in that row changes.
        const up = fill('INSERT INTO {L} ({k}, {a}) VALUES (?, ?) ON DUPLICATE KEY UPDATE {id} = LAST_INSERT_ID({id})', S);
        for (const p of [['a', 'dmv'], ['b', 'dmv'], ['a', 'gun'], ['a', 'dmv'], ['b', 'dmv']]) {
            const got = await eng('insert', up, p);
            const [res] = await ref.query(up, p);
            check('LAST_INSERT_ID(id) upsert insertId ' + p, got.v === res.insertId, 'engine ' + JSON.stringify(got) + ' maria ' + res.insertId);
            const aff = await eng('update', up, p);
            const [res2] = await ref.query(up, p);
            check('LAST_INSERT_ID(id) upsert affected rows ' + p, aff.v === res2.affectedRows, 'engine ' + JSON.stringify(aff) + ' maria ' + res2.affectedRows);
            const after = await eng('scalar', 'SELECT LAST_INSERT_ID()', []);
            const [[r2]] = await ref.query('SELECT LAST_INSERT_ID() AS v');
            check('LAST_INSERT_ID() after that upsert ' + p, after.v === Number(r2.v), 'engine ' + JSON.stringify(after) + ' maria ' + r2.v);
        }
    }

    await ref.end();
    await copy.end();
    const c = await mysql.createConnection(URL_);
    await c.query('DROP DATABASE IF EXISTS ' + ENG);
    await c.query('DROP DATABASE IF EXISTS ' + REF);
    await c.end();
    if (failed) { console.log(failed + ' of ' + checks + ' failed'); process.exit(1); }
    console.log('all passed (' + checks + ' checks, ' + (process.env.FX_BACKEND || 'node:sqlite') + ')');
    process.exit(0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack)); process.exit(1); });
