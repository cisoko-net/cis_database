'use strict';

// An upsert that inserts was told apart from one that updated by
// last_insert_rowid() changing. The outbox insert after every write sets it
// to the outbox row's id, so when the upsert's new row got the same number
// (a fresh table and a young outbox), the insert was read as an update:
// insertId 0 and affectedRows 2, and the MariaDB copy got no insert id pin.
// last_insert_rowid() is now set to an id no row has before each upsert.
// FX_BACKEND=sql.js runs the same cases on the fallback.
// Usage: node tests/repro/upsert_fresh_id.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-upfresh-'));
const mariaFile = path.join(dir, 'maria.sqlite');
new DatabaseSync(mariaFile).close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;

const fx = require('../harness/fx.js');
const r = fx.registry;
const call = (k, sql, p) => new Promise((res) => r[k](sql, p || [], (v, err) => res(err ? { err } : v), 'test', true));

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const hdr = (h) => (h && h.err ? 'err ' + h.err : h && h.affectedRows + '/' + h.insertId);
const UPSERT = (t) => 'INSERT INTO ' + t + ' (name, n) VALUES (?, 1) ON DUPLICATE KEY UPDATE n = n + 1';

(async () => {
    check('engine ready', await fx.ready(20000));
    // Each new table's first row gets id 1 and lands one outbox row later
    // than the last, so one of them meets the outbox id.
    let misread = 0;
    let detail = '';
    for (let k = 0; k < 8; k++) {
        const t = 'up' + k;
        await call('query', 'CREATE TABLE ' + t + ' (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(16) NOT NULL UNIQUE, n INT NOT NULL)');
        for (let j = 0; j < k; j++) await call('insert', 'INSERT INTO ' + t + ' (name, n) VALUES (?, 0)', ['pre' + j]);
        const h = await call('query', UPSERT(t), ['fresh']);
        const id = Number(await call('scalar', 'SELECT id FROM ' + t + ' WHERE name = ?', ['fresh']));
        if (!(h.affectedRows === 1 && h.insertId === id)) { misread++; detail += t + ' ' + hdr(h) + ' id ' + id + '; '; }
    }
    check('an upsert that inserts reports 1 affected and its id', misread === 0, detail);
    const id = await call('insert', UPSERT('up0'), ['other']);
    const want = Number(await call('scalar', 'SELECT id FROM up0 WHERE name = ?', ['other']));
    check('insert export returns the new id of an upsert', id === want, id + ' vs ' + want);
    const u = await call('query', UPSERT('up0'), ['fresh']);
    const fresh = Number(await call('scalar', 'SELECT id FROM up0 WHERE name = ?', ['fresh']));
    // MariaDB reports the id of the row an upsert changed (markUpsertRow).
    check('an upsert that updates reports 2 affected and the row id', u.affectedRows === 2 && u.insertId === fresh, hdr(u));
    const z = await call('insert', UPSERT('up0'), ['fresh']);
    check('insert export returns the row id for an upsert that updated', z === fresh, JSON.stringify(z));
    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
