'use strict';

// A list bound to a mark inside IN ( ) beside other values. mysql2 formats a
// list wherever it is bound, so MariaDB ran IN (1, 2, 3) for IN (?, ?) with
// {{1, 2}, {3}}, while SQLite expanded only the first mark and matched 1 and 2.
// Both sides now get the same expanded text (invariant 2).
// Usage: node tests/repro/in_list_mixed.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-inmix-'));
const mariaFile = path.join(dir, 'maria.sqlite');
new DatabaseSync(mariaFile).close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;

const fx = require('../harness/fx.js');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const ids = (rows) => (rows || []).map((r) => r.id).join(',');

(async () => {
    check('engine ready', await fx.ready(20000));
    await fx.call('query', 'CREATE TABLE t (id INT PRIMARY KEY)');
    for (const i of [1, 2, 3, 5, 7]) await fx.call('insert', 'INSERT INTO t (id) VALUES (?)', [i]);
    const a = await fx.call('query', 'SELECT id FROM t WHERE id IN (?, 5) ORDER BY id', [[1, 2]]);
    check('IN (?, 5) with a list', ids(a) === '1,2,5', ids(a));
    const b = await fx.call('query', 'SELECT id FROM t WHERE id IN (?, ?) ORDER BY id', [[1, 2], [3]]);
    check('IN (?, ?) with two lists', ids(b) === '1,2,3', ids(b));
    const c = await fx.call('query', 'SELECT id FROM t WHERE id IN (?) ORDER BY id', [[7, 1]]);
    check('IN (?) with a list', ids(c) === '1,7', ids(c));
    const d = await fx.call('query', "SELECT id FROM t WHERE id IN (5, ?) AND 'IN (' <> ? ORDER BY id", [[3], 'x']);
    check('a string after IN ( ) is not a list', ids(d) === '3,5', ids(d));
    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
