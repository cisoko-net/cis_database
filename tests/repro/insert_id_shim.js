'use strict';

// oxmysql's parseResponse answers `insert` with the insertId of the write's
// result header, so the `insert` export and the header a `query` of the same
// write returns must agree, as MariaDB 10.11 gives them through mysql2:
// - one row: affectedRows 1, insertId the new id
// - INSERT IGNORE where every row is a duplicate: affectedRows 0, insertId 0,
//   and `insert` returns 0 (engine invariant 1)
// - several rows: affectedRows the row count, insertId the first new id
// Usage: node tests/repro/insert_id_shim.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-insertid-'));
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
const hdr = (h) => (h && h.err ? 'err ' + h.err : h && h.affectedRows + '/' + h.insertId);
// The stored id of a plate. Ids are compared with the rows, never with fixed
// numbers: a statement that inserts nothing may still use up ids, as InnoDB does.
const idOf = async (plate) => Number(await call('scalar', 'SELECT id FROM plates WHERE plate = ?', [plate]));

(async () => {
    await fx.ready(20000);
    await call('query', 'CREATE TABLE plates (id INT NOT NULL AUTO_INCREMENT, plate VARCHAR(8) NOT NULL, PRIMARY KEY (id), UNIQUE KEY p (plate))');

    // One row.
    let h = await call('query', 'INSERT INTO plates (plate) VALUES (?)', ['AAA']);
    check('query: one row reports 1 affected and its id', h.affectedRows === 1 && h.insertId === await idOf('AAA'), hdr(h));
    let id = await call('insert', 'INSERT INTO plates (plate) VALUES (?)', ['BBB']);
    check('insert: one row returns its id', id === await idOf('BBB'), JSON.stringify(id));

    // INSERT IGNORE that inserts nothing.
    h = await call('query', 'INSERT IGNORE INTO plates (plate) VALUES (?)', ['AAA']);
    check('query: INSERT IGNORE of a duplicate reports 0/0', h.affectedRows === 0 && h.insertId === 0, hdr(h));
    id = await call('insert', 'INSERT IGNORE INTO plates (plate) VALUES (?)', ['BBB']);
    check('insert: INSERT IGNORE of a duplicate returns 0', id === 0, JSON.stringify(id));
    h = await call('query', 'INSERT IGNORE INTO plates (plate) VALUES (?), (?)', ['AAA', 'BBB']);
    check('query: multi-row INSERT IGNORE of duplicates only reports 0/0', h.affectedRows === 0 && h.insertId === 0, hdr(h));
    id = await call('insert', 'INSERT IGNORE INTO plates (plate) VALUES (?), (?)', ['AAA', 'BBB']);
    check('insert: multi-row INSERT IGNORE of duplicates only returns 0', id === 0, JSON.stringify(id));
    // A real insert after the no-op still gets the next id, not a stale one.
    id = await call('insert', 'INSERT INTO plates (plate) VALUES (?)', ['CCC']);
    check('insert after the no-op returns the new row id', id === await idOf('CCC') && id > await idOf('BBB'), JSON.stringify(id));
    h = await call('query', 'INSERT IGNORE INTO plates (plate) VALUES (?)', ['CCC']);
    check('query: a no-op after an insert does not repeat its id', h.affectedRows === 0 && h.insertId === 0, hdr(h));

    // Several rows.
    h = await call('query', 'INSERT INTO plates (plate) VALUES (?), (?), (?)', ['D1', 'D2', 'D3']);
    check('query: three rows report 3 affected and the first id', h.affectedRows === 3 && h.insertId === await idOf('D1') && await idOf('D3') === h.insertId + 2, hdr(h));
    id = await call('insert', 'INSERT INTO plates (plate) VALUES (?), (?)', ['E1', 'E2']);
    check('insert: two rows return the first id', id === await idOf('E1') && await idOf('E2') === id + 1, JSON.stringify(id));
    id = await call('insert', 'INSERT IGNORE INTO plates (plate) VALUES (?), (?), (?)', ['E1', 'F1', 'F2']);
    check('insert: multi-row IGNORE with one duplicate returns the first new id', id === await idOf('F1') && id > await idOf('E2'), JSON.stringify(id));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
