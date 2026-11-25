'use strict';

// oxmysql sets no decimalNumbers (src/config.ts, overextended/oxmysql), so
// mysql2 gives a DECIMAL value as a string with the column's scale: 5 in a
// DECIMAL(10,2) reads "5.00", in a DECIMAL(10,0) "5". A Lua script that
// compares it with == sees a string. The rule keys on the declared type; the
// tables here are made up, and an alias, a join or prepare still find it.
// Usage: node tests/repro/decimal_strings.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-decimal-'));
const mariaFile = path.join(dir, 'maria.sqlite');
new DatabaseSync(mariaFile).close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;

const fx = require('../harness/fx.js');
const r = fx.registry;
const call = (k, sql, p) => new Promise((res) => r[k](sql, p || [], (v, err) => res(err ? { err } : v), 'test', true));

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

(async () => {
    await fx.ready(20000);
    await call('query', 'CREATE TABLE wallets (id INT PRIMARY KEY, cash DECIMAL(10,2) NOT NULL DEFAULT 0, rate NUMERIC(6,4), whole DECIMAL(12,0), n INT, f DOUBLE)');
    await call('query', 'INSERT INTO wallets VALUES (1, 5, 0.5, 7, 3, 1.5), (2, -12.345, NULL, -1, 4, 2), (3, 1234567.1, 1, 0, 5, 0)');
    const rows = await call('query', 'SELECT * FROM wallets ORDER BY id');
    check('DECIMAL(10,2) reads as a string with two places', rows[0].cash === '5.00' && rows[1].cash === '-12.35' && rows[2].cash === '1234567.10', JSON.stringify(rows.map((x) => x.cash)));
    check('NUMERIC(6,4) too, NULL stays null', rows[0].rate === '0.5000' && rows[1].rate === null && rows[2].rate === '1.0000', JSON.stringify(rows.map((x) => x.rate)));
    check('DECIMAL(12,0) reads with no point', rows[0].whole === '7' && rows[1].whole === '-1' && rows[2].whole === '0', JSON.stringify(rows.map((x) => x.whole)));
    check('INT and DOUBLE stay numbers', rows[0].n === 3 && rows[0].f === 1.5, JSON.stringify(rows[0]));
    const al = await call('query', 'SELECT w.cash AS money FROM wallets w JOIN wallets v ON v.id = w.id WHERE w.id = 1');
    check('an alias and a join still find the column', al[0] && al[0].money === '5.00', JSON.stringify(al));
    check('scalar gives the string', await call('scalar', 'SELECT cash FROM wallets WHERE id = 2') === '-12.35');
    const pr = await call('prepare', 'SELECT cash, n FROM wallets WHERE id = ?', [3]);
    check('prepare gives the string too (mysql2 execute does)', pr && pr.cash === '1234567.10', JSON.stringify(pr));
    const ex = await call('query', 'SELECT cash + 0 AS e FROM wallets WHERE id = 1');
    check('an expression is not a column: left as it is', ex[0] && typeof ex[0].e === 'number', JSON.stringify(ex));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' failed' : 'all passed');
    process.exit(failed ? 1 : 0);
})();
