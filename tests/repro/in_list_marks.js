'use strict';

// A list bound to a ? inside IN ( ) expands to one ? per value, as mysql2
// formats it. The check looked back at most 200 characters for the IN and
// stopped at any quote, so IN ('a', ?) and a long IN (1, 2, ..., ?) bound
// the list as one value and matched nothing.
// Usage: node tests/repro/in_list_marks.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-inmarks-'));
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
const names = (rows) => (rows && rows.map ? rows.map((r) => r.name).join(',') : JSON.stringify(rows));

(async () => {
    check('engine ready', await fx.ready(20000));
    await fx.call('query', 'CREATE TABLE p (id INT PRIMARY KEY, name VARCHAR(8))');
    await fx.call('insert', "INSERT INTO p VALUES (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd'), (5, 'e')");
    let rows = await fx.call('query', "SELECT name FROM p WHERE name IN ('a', ?) ORDER BY id", [['c', 'd']]);
    check("IN ('a', ?) expands the list", names(rows) === 'a,c,d', names(rows));
    rows = await fx.call('query', "SELECT name FROM p WHERE name IN (?, 'e') ORDER BY id", [['b']]);
    check("IN (?, 'e') expands the list", names(rows) === 'b,e', names(rows));
    rows = await fx.call('query', "SELECT name FROM p WHERE name IN ('(?', ?) ORDER BY id", [['a', 'b']]);
    check('a ( and ? inside a string in the list are text', names(rows) === 'a,b', names(rows));
    const filler = Array.from({ length: 120 }, (_, i) => 100 + i).join(', ');
    rows = await fx.call('query', 'SELECT name FROM p WHERE id IN (' + filler + ', ?) ORDER BY id', [[2, 4]]);
    check('a long IN (..., ?) list expands', names(rows) === 'b,d', names(rows));
    rows = await fx.call('query', 'SELECT name FROM p WHERE id IN (SELECT id FROM p WHERE name = ?) ORDER BY id', ['c']);
    check('a ? in a subquery inside IN is a plain value', names(rows) === 'c', names(rows));
    rows = await fx.call('query', 'SELECT name FROM p WHERE id IN (?) AND name <> ? ORDER BY id', [[1, 2, 3], 'b']);
    check('a ? after the IN list is a plain value', names(rows) === 'a,c', names(rows));
    rows = await fx.call('query', 'SELECT name FROM p WHERE COALESCE(?, 0) < id AND id IN (?) ORDER BY id', [3, [4, 5, 1]]);
    check('a ? in another call before IN is a plain value', names(rows) === 'd,e', names(rows));
    const n = await fx.call('update', "UPDATE p SET name = 'z' WHERE name IN ('a', ?)", [['b', 'c']]);
    check("UPDATE ... IN ('a', ?) changes 3 rows", n === 3, String(n));
    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
