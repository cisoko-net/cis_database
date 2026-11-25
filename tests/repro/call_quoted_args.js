'use strict';

// GREATEST, LEAST, FIND_IN_SET and JSON_LENGTH whose arguments hold a quoted
// name or a string. The rewrite used to run on one code chunk at a time, and a
// backticked name splits the chunk, so GREATEST(0, `jackpot` + ?) came out as
// max(0)"jackpot" + ?) and failed near "jackpot". The tables here are made up.
// Usage: node tests/repro/call_quoted_args.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-callq-'));
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
    await call('query', 'CREATE TABLE `pots` (`id` INT PRIMARY KEY, `amount` INT, `tags` VARCHAR(40), `doc` LONGTEXT)');
    await call('query', "INSERT INTO pots VALUES (1, 10, 'a,b,c', '[1,2,3]')");
    let h = await call('update', 'UPDATE `pots` SET `amount` = GREATEST(0, `amount` + ?) WHERE `id` = ?', [-25, 1]);
    check('GREATEST(0, `col` + ?) in SET (the corpus sample)', h === 1 && await call('scalar', 'SELECT amount FROM pots WHERE id = 1') === 0, JSON.stringify(h));
    h = await call('scalar', 'SELECT LEAST(`amount` + 5, ?) FROM `pots` WHERE `id` = 1', [3]);
    check('LEAST(`col` + 5, ?) with the name first', h === 3, JSON.stringify(h));
    h = await call('scalar', "SELECT GREATEST(`amount`, LENGTH('x,y'), ?) FROM pots", [2]);
    check('GREATEST with a string and a nested call in its args', h === 3, JSON.stringify(h));
    h = await call('scalar', 'SELECT FIND_IN_SET(?, `tags`) > 0 FROM `pots`', ['b']);
    check('FIND_IN_SET(?, `col`)', Number(h) === 1, JSON.stringify(h));
    h = await call('scalar', 'SELECT JSON_LENGTH(`doc`) FROM `pots`');
    check('JSON_LENGTH(`col`)', h === 3, JSON.stringify(h));
    h = await call('scalar', "SELECT GREATEST(1, 2) FROM pots WHERE tags = 'GREATEST(9'");
    check('a string that looks like a call is left alone', h === undefined || h === null, JSON.stringify(h));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' failed' : 'all passed');
    process.exit(failed ? 1 : 0);
})();
