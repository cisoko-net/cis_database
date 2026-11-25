'use strict';

// exports.oxmysql:<name>(...) from a script that skips @oxmysql/lib/MySQL.lua.
// The caller emits __cfx_export_oxmysql_<name> with a setter, as
// citizen/scripting/v8/main.js and lua/scheduler.lua do; provide 'oxmysql'
// does not route that event to cis_database. Every server_exports name must
// answer under oxmysql with the same function as under cis_database, and the
// mysql-async and ghmattimysql names oxmysql v2.14.3 answers (src/index.ts,
// src/compatibility/*.ts) must answer with the method oxmysql maps them to.
// Usage: node tests/repro/provide_exports.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-provide-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE users (identifier VARCHAR(64) PRIMARY KEY, money INT NOT NULL); CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, seq INT)');
m.exec("INSERT INTO users VALUES ('a', 5), ('b', 7)");
m.close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;
process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: 'mysql://root@127.0.0.1/fake', cis_database_cdc: '0' });

const fx = require('../harness/fx.js');

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

// What a caller gets from exports[resource][name], or undefined.
function lookup(resource, name) {
    let fn;
    global.emit('__cfx_export_' + resource + '_' + name, (f) => { fn = f; });
    return fn;
}
const viaOx = (name, ...args) => new Promise((resolve) => lookup('oxmysql', name)(...args, (r) => resolve(r)));

(async () => {
    if (!(await fx.ready(20000))) throw new Error('not ready');
    global.__fxInvoker = 'some_script';

    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'fxmanifest.lua'), 'utf8');
    const names = Array.from(/server_exports\s*\{([^}]*)\}/.exec(src)[1].matchAll(/'([^']+)'/g), (x) => x[1]);
    const missing = names.filter((n) => typeof lookup('oxmysql', n) !== 'function');
    check('every server_exports name answers under oxmysql', names.length > 40 && missing.length === 0,
        names.length + ' names, missing: ' + (missing.join(' ') || 'none'));
    const different = names.filter((n) => lookup('oxmysql', n) !== lookup('cis_database', n));
    check('oxmysql gets the same function as cis_database', different.length === 0, different.join(' ') || '');
    check('a name cis_database does not export stays missing', lookup('oxmysql', 'nope') === undefined);

    if (missing.length === 0) {
        check('scalar', (await viaOx('scalar', 'SELECT money FROM users WHERE identifier = ?', ['b'])) === 7);
        check('update', (await viaOx('update', 'UPDATE users SET money = money + 1 WHERE identifier = ?', ['a'])) === 1);
        check('query', JSON.stringify(await viaOx('query', 'SELECT money FROM users ORDER BY identifier', [])) === '[{"money":6},{"money":7}]');
        check('isReady', lookup('oxmysql', 'isReady')() === true);
    }

    const aliases = {
        'mysql-async': { mysql_execute: 'update', mysql_insert: 'insert', mysql_fetch_all: 'query', mysql_fetch_scalar: 'scalar', mysql_transaction: 'transaction', mysql_store: 'store' },
        ghmattimysql: { execute: 'query', executeSync: 'querySync', scalar: 'scalar', scalarSync: 'scalarSync', transaction: 'transaction', transactionSync: 'transactionSync', store: 'store', storeSync: 'storeSync' },
    };
    for (const [res, map] of Object.entries(aliases)) {
        const wrong = Object.entries(map).filter(([alias, target]) => {
            const fn = lookup(res, alias);
            return typeof fn !== 'function' || fn !== lookup('cis_database', target);
        }).map(([alias]) => alias);
        check(res + ' names answer with the method oxmysql maps them to', wrong.length === 0, wrong.join(' ') || '');
    }
    check('an oxmysql name stays missing under mysql-async', lookup('mysql-async', 'query') === undefined);

    const via = (res, name, ...args) => new Promise((resolve) => lookup(res, name)(...args, (r) => resolve(r)));
    // A call without a callback returns the async retval object the Lua
    // runtime awaits (citizen/scripting/lua/scheduler.lua); await it the same way.
    const retval = (rv) => new Promise((resolve) => rv.__cfx_async_retval((r, e) => resolve(r ? r[0] : 'error: ' + e)));
    if (typeof lookup('mysql-async', 'mysql_insert') === 'function') {
        check('mysql_insert returns the id', (await via('mysql-async', 'mysql_insert', 'INSERT INTO logs (seq) VALUES (?)', [9])) === 1);
        check('mysql_fetch_scalar', (await via('mysql-async', 'mysql_fetch_scalar', 'SELECT seq FROM logs WHERE id = ?', [1])) === 9);
        await via('mysql-async', 'mysql_execute', "INSERT INTO users VALUES ('c', 9)", []);
        check('mysql_execute returns rows changed', (await via('mysql-async', 'mysql_execute', 'UPDATE users SET money = 0 WHERE money > ?', [6])) === 2);
    }
    if (typeof lookup('ghmattimysql', 'execute') === 'function') {
        check('ghmattimysql execute returns rows', JSON.stringify(await via('ghmattimysql', 'execute', 'SELECT money FROM users ORDER BY identifier', [])) === '[{"money":6},{"money":0},{"money":0}]');
        check('ghmattimysql scalarSync resolves', (await retval(lookup('ghmattimysql', 'scalarSync')('SELECT money FROM users WHERE identifier = ?', ['a']))) === 6);
    }
    if (typeof lookup('oxmysql', 'store') === 'function') {
        const sql = 'SELECT money FROM users WHERE identifier = ?';
        check('store hands the query back', (await viaOx('store', sql)) === sql && lookup('oxmysql', 'store')(sql) === sql);
        check('mysql_store hands the query back', (await via('mysql-async', 'mysql_store', sql)) === sql);
        check('storeSync resolves to the query', (await lookup('ghmattimysql', 'storeSync')(sql)) === sql);
    }

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
