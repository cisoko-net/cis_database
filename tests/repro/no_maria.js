'use strict';

// With no MariaDB configured, a read SQLite cannot run fails with SQLite's
// reason and says no MariaDB is there to answer it. It never answers a value,
// and the engine keeps answering the reads it can. Runs on node:sqlite, and on
// sql.js with FX_BACKEND=sql.js.
//
// Usage: node tests/repro/no_maria.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-nomaria-'));
process.env.FX_RES_DIR = dir;
process.env.FX_REAL_MARIA = '1';
process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: '' });
const fx = require('../harness/fx.js');

let failed = 0;
let checks = 0;
function check(name, ok, detail) {
    checks++;
    if (ok) return;
    failed++;
    console.log('FAIL ' + name + (detail ? '\n   ' + detail : ''));
}
const call = (kind, sql, params) => new Promise((res) => fx.registry[kind](sql, params || [], (v, e) => res({ v, e }), 'test', true));

// MariaDB functions and clauses SQLite has no form of, in each call shape a
// resource uses. Each must fail, never answer.
const UNRUNNABLE = [
    "SELECT INET_ATON('10.0.0.1') AS v",
    'SELECT k, SUM(n) AS v FROM t GROUP BY k WITH ROLLUP',
    "SELECT CONVERT_TZ('2024-01-01 00:00:00', '+00:00', '+01:00') AS v",
    "SELECT * FROM JSON_TABLE('[1,2]', '$[*]' COLUMNS (x INT PATH '$')) AS j",
    'SELECT no_such_function(n) AS v FROM t',
];

(async () => {
    if (!(await fx.ready(60000))) { console.log('FAIL engine not ready'); process.exit(1); }
    let r = await call('query', 'CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY, k VARCHAR(10), n INT)');
    check('create answers', r.e == null, String(r.e));
    r = await call('insert', 'INSERT INTO t (k, n) VALUES (?, ?)', ['a', 2]);
    check('insert answers', r.e == null && r.v === 1, JSON.stringify(r));

    for (const sql of UNRUNNABLE) {
        for (const kind of ['query', 'scalar', 'single', 'prepare']) {
            const x = await call(kind, sql, []);
            check(kind + ' ' + sql + ': fails, no value', x.e != null && x.v === null, JSON.stringify({ v: x.v, e: String(x.e) }));
            check(kind + ' ' + sql + ': the error says no MariaDB is configured', /no MariaDB is configured to answer this read/.test(String(x.e)), String(x.e));
        }
    }
    // A write SQLite refuses is SQLite's error alone: there is no read fallback.
    const w = await call('update', 'UPDATE no_such_table SET n = 1', []);
    check('a refused write fails', w.e != null && w.v === null, JSON.stringify({ v: w.v, e: String(w.e) }));
    check('a refused write does not claim a read fallback', !/answer this read/.test(String(w.e)), String(w.e));
    // The engine still answers what SQLite runs.
    const c = await call('scalar', 'SELECT COUNT(*) FROM t', []);
    check('after the errors a plain read answers', c.e == null && c.v === 1, JSON.stringify(c));

    if (failed) { console.log(failed + ' of ' + checks + ' failed'); process.exit(1); }
    console.log('all passed (' + checks + ' checks, ' + (process.env.FX_BACKEND || 'node:sqlite') + ')');
    process.exit(0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack)); process.exit(1); });
