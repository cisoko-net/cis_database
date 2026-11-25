'use strict';

// MySQL opens a '--' comment only when a space, a control character or the
// end of the text follows the second dash; 'UPDATE t SET v = 1--? WHERE id = ?'
// is v = 1 - (-?) with two placeholders. translate() keeps that rule
// (comment_rules.js), but the scans in server.js that rewrite the replica
// text, expand IN (?) lists and bind UUID() treated every '--' as a comment:
// the replica copy lost the rest of the line, a list went to the wrong ?, and
// a UUID() value took the wrong place. Expected values are MariaDB's.
// Usage: node tests/repro/dash_placeholders.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-dash-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v INT, s VARCHAR(40)); INSERT INTO t (v, s) VALUES (1, 'a'), (1, 'b')");
m.close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;
process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: 'mysql://root@127.0.0.1/fake', cis_database_cdc: '0' });

const fx = require('../harness/fx.js');
const dialect = require('../../dialect.js');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
async function drained(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fx.registry.probe().replica === 0) return true; await sleep(50); }
    return false;
}
const call = (kind, sql, params) => new Promise((res) => {
    global.__fxInvoker = 'dash_script';
    fx.registry[kind](sql, params || [], (v, e) => res({ v, e }), 'dash_script', true);
    global.__fxInvoker = '';
});
const mariaRows = () => {
    const db = new DatabaseSync(mariaFile);
    try { return db.prepare('SELECT id, v, s FROM t ORDER BY id').all(); } finally { db.close(); }
};

(async () => {
    check('engine ready', await fx.ready(20000));

    let r = await call('scalar', 'SELECT ?--?', [5, 2]);
    check('SELECT ?--? binds both placeholders (7)', r.v === 7, JSON.stringify(r));
    r = await call('scalar', 'SELECT ? -- ?\n', [4]);
    check('a real -- comment still hides its ?', r.v === 4, JSON.stringify(r));
    r = await call('scalar', 'SELECT v FROM t WHERE id = :a--:b', { a: 0, b: 1 });
    check('named :a--:b binds both (0 - (-1) = 1 finds the row)', r.v === 1, JSON.stringify(r));
    r = await call('scalar', 'SELECT COUNT(*) FROM t WHERE v = 0--? AND id IN (?)', [1, [1, 3]]);
    check('IN (?) after --? gets the list, not the number', r.v === 1, JSON.stringify(r));
    r = await call('scalar', "SELECT 1--'2'");
    check("SELECT 1--'2' is 3", r.v === 3, JSON.stringify(r));
    r = await call('scalar', "SELECT CONCAT('x', 1--'\\'')");
    check('a string after -- keeps its MySQL escape', r.v === 'x1', JSON.stringify(r));
    check('WITH ... --1 is still a read', !dialect.isWriteStatement('WITH a AS (SELECT 1--1) SELECT * FROM a'));

    r = await call('update', 'UPDATE t SET v = 1--? WHERE id = ?', [4, 1]);
    check('UPDATE with 1--? changes one row', r.v === 1, JSON.stringify(r));
    r = await call('insert', 'INSERT INTO t (v, s) VALUES (1--?, UUID())', [2]);
    check('INSERT with 1--? and UUID() inserts', r.v === 3, JSON.stringify(r));
    r = await call('query', 'SELECT id, v, s FROM t ORDER BY id');
    const local = r.v || [];
    check('SQLite: v = 5 for id 1, 1 for id 2, 3 for id 3', local.length === 3 && local[0].v === 5 && local[1].v === 1 && local[2].v === 3, JSON.stringify(local));
    check('SQLite: the UUID() went to s', local[2] && /^[0-9a-f-]{36}$/.test(String(local[2].s)), JSON.stringify(local[2]));
    check('the writes reach MariaDB', await drained(15000));
    const remote = mariaRows();
    check('MariaDB holds the same rows', JSON.stringify(remote) === JSON.stringify(local), JSON.stringify(remote));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
