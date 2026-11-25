'use strict';

// MariaDB gives SUM of an integer column as a DECIMAL with scale 0 and AVG
// as a DECIMAL with scale 4, and mysql2 under oxmysql (no decimalNumbers)
// hands both back as strings: '6', '2.0000'. SQLite answered numbers. MIN
// and MAX keep the column's integer type, and a plain read stays a number.
// Usage: node tests/repro/int_aggregates.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-intagg-'));
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

(async () => {
    check('engine ready', await fx.ready(20000));
    await fx.call('query', 'CREATE TABLE w (id INT PRIMARY KEY, money BIGINT NOT NULL, lvl SMALLINT, ok TINYINT(1))');
    await fx.call('insert', 'INSERT INTO w VALUES (1, 1, 2, 1), (2, 2, 2, 0), (3, 3, 5, 1)');
    const r = (await fx.call('query', 'SELECT SUM(money) s, AVG(money) a, MIN(money) mi, MAX(lvl) ml, SUM(DISTINCT lvl) sd, COUNT(*) c FROM w'))[0];
    check('SUM of a BIGINT is the string mysql2 gives', r.s === '6', JSON.stringify(r.s));
    check('AVG of a BIGINT has 4 places', r.a === '2.0000', JSON.stringify(r.a));
    check('MIN and MAX stay numbers', r.mi === 1 && r.ml === 5, JSON.stringify([r.mi, r.ml]));
    check('SUM(DISTINCT) of a SMALLINT is a string', r.sd === '7', JSON.stringify(r.sd));
    check('COUNT stays a number', r.c === 3, JSON.stringify(r.c));
    const s = await fx.call('scalar', 'SELECT SUM(money) FROM w WHERE id > ?', [1]);
    check('scalar SUM is a string', s === '5', JSON.stringify(s));
    const none = await fx.call('scalar', 'SELECT SUM(money) FROM w WHERE id > 9');
    check('SUM of no rows is NULL', none === null, JSON.stringify(none));
    const row = await fx.call('single', 'SELECT id, money, ok FROM w WHERE id = 2');
    check('a plain read stays a number, TINYINT(1) a boolean', row.id === 2 && row.money === 2 && row.ok === false, JSON.stringify(row));
    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
