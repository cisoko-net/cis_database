'use strict';

// A read SQLite cannot run is answered by MariaDB. A statement cis_database
// refuses on purpose (CALL, SIGNAL, SET @name) must not take that path: a
// CALL would then run on MariaDB alone, and the two copies would drift.
// The fake MariaDB fails these statements with its own message, so a
// cis_database: message proves MariaDB was never asked.
// Usage: node tests/repro/noop_refused_maria.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-noopm-'));
const mariaFile = path.join(dir, 'maria.sqlite');
new DatabaseSync(mariaFile).exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INT)');
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;
process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: 'mysql://root@127.0.0.1/fake', cis_database_cdc: '0' });

const fx = require('../harness/fx.js');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const call = (kind, sql, params) => new Promise((res) => {
    global.__fxInvoker = 'noop_script';
    fx.registry[kind](sql, params || [], (v, e) => res({ v, e }), 'noop_script', true);
    global.__fxInvoker = '';
});

(async () => {
    check('engine ready', await fx.ready(20000));
    for (const sql of ['CALL give_money(1, 500)', "SIGNAL SQLSTATE '45000'", 'SET @last = 5']) {
        const r = await call('query', sql);
        check('refused, not sent to MariaDB: ' + sql, r.e && /^cis_database: /.test(String(r.e)), JSON.stringify(r));
    }
    const r = await call('query', 'SELECT v FROM t');
    check('a plain read still works', Array.isArray(r.v), JSON.stringify(r));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
