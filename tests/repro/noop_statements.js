'use strict';

// Some MariaDB statements have nothing to do on SQLite: SET NAMES, USE, LOCK
// TABLES, a DROP TRIGGER IF EXISTS. Those answer success and change nothing.
// Others did real work on MariaDB and were turned into SELECT 1 here, so the
// caller was told they ran: CALL, SIGNAL, SET @var, CREATE TRIGGER or
// PROCEDURE, an UPDATE ... SET ? left without its object, a TRUNCATE the
// rewrite could not read. Those now fail with a reason, and nothing reaches
// MariaDB. COMMIT and ROLLBACK sent through query answer like START
// TRANSACTION, and inside a transaction() list they no longer end the
// transaction cis_database holds.
// Usage: node tests/repro/noop_statements.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-noop-'));
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
    global.__fxInvoker = 'noop_script';
    fx.registry[kind](sql, params || [], (v, e) => res({ v, e }), 'noop_script', true);
    global.__fxInvoker = '';
});

const FAILS = [
    'CALL give_money(1, 500)',
    "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'no'",
    'SET @last = 5',
    "SET NAMES utf8mb4, @who = 'x'",
    'CREATE TRIGGER t_ai AFTER INSERT ON t FOR EACH ROW UPDATE t SET v = 0',
    'CREATE PROCEDURE give_money() BEGIN END',
    'CREATE FUNCTION f() RETURNS INT RETURN 1',
    'CREATE EVENT e ON SCHEDULE EVERY 1 HOUR DO DELETE FROM t',
    'CREATE OR REPLACE TABLE z (a INT)',
    'ALTER PROCEDURE give_money COMMENT \'x\'',
    'TRUNCATE t, u',
];
const SUCCEEDS = [
    'SET NAMES utf8mb4',
    "SET SESSION sql_mode = ''",
    'SET @@session.wait_timeout = 600',
    "SET NAMES 'a@b'",
    'USE game',
    'LOCK TABLES t WRITE',
    'UNLOCK TABLES',
    'START TRANSACTION',
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    'DROP TRIGGER IF EXISTS t_ai',
    'DROP PROCEDURE IF EXISTS give_money',
    'CREATE DATABASE IF NOT EXISTS game',
    'CREATE VIEW tv AS SELECT v FROM t',
    'ALTER VIEW tv AS SELECT id, v FROM t',
];

(async () => {
    check('engine ready', await fx.ready(20000));
    await call('query', 'CREATE TABLE t (id INTEGER PRIMARY KEY, v INT)');
    await call('query', 'INSERT INTO t (v) VALUES (1)');

    for (const sql of FAILS) {
        const r = await call('query', sql);
        check('fails with a reason: ' + sql, r.e && /cis_database: /.test(String(r.e)), JSON.stringify(r));
    }
    for (const sql of SUCCEEDS) {
        const r = await call('query', sql);
        check('succeeds: ' + sql, !r.e && r.v != null && !Array.isArray(r.v), JSON.stringify(r));
    }

    let r = await call('query', 'SELECT * FROM tv');
    check('ALTER VIEW replaced the view', Array.isArray(r.v) && r.v[0] && r.v[0].id === 1, JSON.stringify(r));
    r = await call('query', 'UPDATE t SET ?', []);
    check('UPDATE ... SET ? without its object fails with a reason', r.e && /cis_database: /.test(String(r.e)), JSON.stringify(r));
    r = await call('query', 'UPDATE t SET ? WHERE id = 1', ['v = 9']);
    check('UPDATE ... SET ? with a string fails with a reason', r.e && /cis_database: /.test(String(r.e)), JSON.stringify(r));
    r = await call('query', 'UPDATE t SET ? WHERE id = 1', [{}]);
    check('UPDATE ... SET ? with an empty object fails with a reason', r.e && /cis_database: /.test(String(r.e)), JSON.stringify(r));
    r = await call('query', 'UPDATE t SET ? WHERE id = 1', [{ v: 7, 'v = 0, id': 3 }]);
    check('UPDATE ... SET ? with a key that is not a column name fails', r.e && /cis_database: /.test(String(r.e)), JSON.stringify(r));
    r = await call('scalar', 'SELECT v FROM t WHERE id = 1');
    check('the row did not change', r.v === 1, JSON.stringify(r));
    r = await call('update', 'UPDATE t SET ? WHERE id = 1', [{ v: 4 }]);
    check('UPDATE ... SET ? with an object still runs', r.v === 1, JSON.stringify(r));
    await call('update', 'UPDATE t SET v = 1 WHERE id = 1');

    const tx = await new Promise((res) => {
        global.__fxInvoker = 'noop_script';
        fx.registry.transaction([
            { query: 'UPDATE t SET v = 2 WHERE id = 1', values: [] },
            { query: 'COMMIT', values: [] },
            { query: 'UPDATE t SET v = v + 1 WHERE id = ?', values: [1] },
            { query: 'INSERT INTO nope (a) VALUES (1)', values: [] },
        ], (ok) => res(ok));
        global.__fxInvoker = '';
    });
    check('the failing transaction reports false', tx === false, String(tx));
    r = await call('scalar', 'SELECT v FROM t WHERE id = 1');
    check('a COMMIT inside the list did not keep the first update', r.v === 1, JSON.stringify(r));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
