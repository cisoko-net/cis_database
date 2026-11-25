'use strict';

// Review L10: SQLite keeps DECIMAL as REAL, so with no MariaDB to answer the
// read, SUM(m) of 0.10 and 0.20 came back as 0.30000000000000004. oxmysql
// sets no decimalNumbers, so mysql2 gives a DECIMAL result as a string:
// SUM, MIN and MAX at the column's scale, AVG at the scale plus 4
// (div_precision_increment), and NULL for no rows. Expected values are
// MariaDB 10.11.19's through mysql2 with oxmysql's pool options.
// Usage: node tests/repro/decimal_aggregates.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-decagg-'));
process.env.FX_RES_DIR = dir;
process.env.FX_REAL_MARIA = '1';
process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: '' });

const fx = require('../harness/fx.js');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const call = (kind, sql, params) => new Promise((res) => {
    global.__fxInvoker = 'decagg_script';
    fx.registry[kind](sql, params || [], (v, e) => res({ v, e }), 'decagg_script', true);
    global.__fxInvoker = '';
});

(async () => {
    check('engine ready', await fx.ready(20000));
    await call('query', 'CREATE TABLE d (id INT PRIMARY KEY, m DECIMAL(10,2), n INT, u DECIMAL(10,2) UNSIGNED)');
    await call('query', 'CREATE TABLE e (id INT PRIMARY KEY, d_id INT, m DECIMAL(8,3))');
    await call('insert', 'INSERT INTO d VALUES (1, 0.1, 1, 1.5), (2, 0.2, 2, NULL)');
    await call('insert', 'INSERT INTO e VALUES (1, 1, 1.25), (2, 1, 2.5)');

    let r = await call('query', 'SELECT SUM(m) s, AVG(m) a, MIN(m) mi, MAX(m) ma, SUM(DISTINCT m) sd, AVG(u) au, MAX(n) mn FROM d');
    const want = { s: '0.30', a: '0.150000', mi: '0.10', ma: '0.20', sd: '0.30', au: '1.500000', mn: 2 };
    check('SUM, AVG, MIN, MAX of a DECIMAL match MariaDB', JSON.stringify(r.v && r.v[0]) === JSON.stringify(want), JSON.stringify(r));
    r = await call('scalar', 'SELECT SUM(m) FROM d');
    check('unnamed SUM(m) is "0.30"', r.v === '0.30', JSON.stringify(r));
    r = await call('scalar', 'SELECT SUM(m) AS s FROM d WHERE id > 5');
    check('SUM of no rows is null', r.v === null, JSON.stringify(r));
    r = await call('query', 'SELECT d.id, SUM(e.m) AS t, AVG(x.m) AS a FROM d JOIN e ON e.d_id = d.id JOIN e AS x ON x.id = e.id GROUP BY d.id');
    check('a qualified and an aliased column keep their scale', JSON.stringify(r.v) === JSON.stringify([{ id: 1, t: '3.750', a: '1.8750000' }]), JSON.stringify(r));
    r = await call('single', 'SELECT SUM(m) AS s, COUNT(*) AS c FROM d');
    check('single row: SUM cast, COUNT stays a number', r.v && r.v.s === '0.30' && r.v.c === 2, JSON.stringify(r));
    r = await call('query', 'SELECT m FROM d ORDER BY id');
    check('a plain DECIMAL read is unchanged', JSON.stringify(r.v) === JSON.stringify([{ m: '0.10' }, { m: '0.20' }]), JSON.stringify(r));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
