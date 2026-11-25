'use strict';

// mysql_connection_string names a MariaDB, but mysql2 does not load (a copy
// of the resource without node_modules/). The engine used to start anyway on
// whatever SQLite held, which on a fresh cache/ was nothing: qbx_core warned
// that `players` did not exist and qbx_management's CREATE TABLE failed with
// "no SQLite form for a foreign key to players" (qbox, 2026-10-28). Writes in
// that session never reached MariaDB either. It now stays not ready, answers
// nothing, and says how to fix it.
// Usage: node tests/repro/mysql2_missing.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-nomysql2-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE players (citizenid VARCHAR(50) PRIMARY KEY, money INT NOT NULL)');
m.exec("INSERT INTO players VALUES ('ABC123', 500)");
m.close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;
process.env.FX_NO_MYSQL2 = '1';

const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.join(' ')); };

const fx = require('../harness/fx.js');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

(async () => {
    const ready = await fx.ready(3000);
    check('engine stays not ready', !ready);
    let answered = null;
    fx.call('query', 'SELECT citizenid FROM players', []).then((r) => { answered = r; });
    await new Promise((r) => setTimeout(r, 1000));
    check('a query gets no answer from the empty SQLite file', answered === null, JSON.stringify(answered));
    console.error = origError;
    const line = errors.find((l) => l.includes('mysql2')) || '';
    check('the console says mysql2 is missing and how to fix it', /node_modules/.test(line), JSON.stringify(line.slice(0, 160)));
    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.error = origError;
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
