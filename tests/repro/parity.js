'use strict';

// oxmysql parity and schema fidelity found while building bench/cis_bench:
// - query/rawExecute of a write returns the mysql2 header, as oxmysql does
// - multi-row INSERT into a table with an omitted DEFAULT column works
// - CREATE TABLE keeps its UNIQUE KEY and KEY indexes (they used to run
//   before the table existed and fail silently)
// - hydrate keeps MariaDB column defaults (finding 4.1.11) and UNIQUE
//   indexes reported as NON_UNIQUE = 0 under an upper-case column name
// - a cached statement plan is rebuilt after ALTER TABLE
// Usage: node tests/repro/parity.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-parity-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, owner VARCHAR(32) NOT NULL UNIQUE, balance INT NOT NULL DEFAULT 250, kind VARCHAR(16) NOT NULL DEFAULT 'checking', created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);"
    + "INSERT INTO accounts (owner) VALUES ('alice');");
m.close();
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

    // Hydrate copied the defaults and the UNIQUE index.
    const ins = await call('insert', 'INSERT INTO accounts (owner) VALUES (?)', ['bob']);
    const bob = await call('single', 'SELECT balance, kind, created FROM accounts WHERE owner = ?', ['bob']);
    check('hydrate keeps column defaults', bob && bob.balance === 250 && bob.kind === 'checking' && typeof bob.created === 'string' && bob.created.length >= 19, JSON.stringify(bob) + ' id=' + ins);
    const dup = await call('insert', 'INSERT IGNORE INTO accounts (owner) VALUES (?)', ['bob']);
    check('hydrate keeps UNIQUE (duplicate ignored, insert returns 0)', dup === 0, JSON.stringify(dup));

    // query of a write returns the header.
    const hdr = await call('query', 'UPDATE accounts SET balance = balance + 1 WHERE owner IN (?)', [['alice', 'bob']]);
    check('query of an UPDATE returns { affectedRows }', hdr && hdr.affectedRows === 2 && hdr.insertId === 0, JSON.stringify(hdr));
    const hdr2 = await call('query', 'INSERT INTO accounts (owner) VALUES (?)', ['carol']);
    // 4, not 3: the ignored duplicate spent id 3, as InnoDB does (10.11.19 gives 4).
    check('query of an INSERT returns { insertId }', hdr2 && hdr2.affectedRows === 1 && hdr2.insertId === 4, JSON.stringify(hdr2));
    const upd = await call('update', 'UPDATE accounts SET balance = 0 WHERE owner = ?', ['nobody']);
    check('update still returns a number', upd === 0, JSON.stringify(upd));
    const none = await call('query', 'SELECT * FROM accounts WHERE owner = ?', ['nobody']);
    check('query with no rows returns []', Array.isArray(none) && none.length === 0, JSON.stringify(none));
    const zero = await call('scalar', 'SELECT COUNT(*) FROM accounts WHERE owner = ?', ['nobody']);
    check('COUNT scalar with no rows returns 0', zero === 0, JSON.stringify(zero));

    // CREATE TABLE with KEY/UNIQUE KEY, then a multi-row insert that leaves a DEFAULT column out.
    await call('query', "CREATE TABLE shop_items (id INT NOT NULL AUTO_INCREMENT, sku VARCHAR(16) NOT NULL, shop VARCHAR(16) NOT NULL, price INT NOT NULL DEFAULT 10, added TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (id), UNIQUE KEY sku (sku), KEY shop (shop)) ENGINE=InnoDB");
    const multi = await call('query', 'INSERT INTO shop_items (sku, shop) VALUES (?, ?), (?, ?), (?, ?)', ['a', 'x', 'b', 'x', 'c', 'y']);
    check('multi-row INSERT with an omitted DEFAULT column', multi && multi.affectedRows === 3, JSON.stringify(multi));
    const prices = await call('query', 'SELECT price FROM shop_items ORDER BY id', []);
    check('omitted column took its DEFAULT on every row', JSON.stringify(prices) === '[{"price":10},{"price":10},{"price":10}]', JSON.stringify(prices));
    const dupSku = await call('insert', 'INSERT INTO shop_items (sku, shop) VALUES (?, ?)', ['a', 'z']);
    check('UNIQUE KEY from CREATE TABLE is enforced', dupSku && dupSku.err && /UNIQUE/i.test(dupSku.err), JSON.stringify(dupSku));
    const d = new DatabaseSync(path.join(dir, 'cache', 'durable.sqlite'));
    const idx = d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'shop_items' ORDER BY name").all().map((x) => x.name);
    const planShop = d.prepare("EXPLAIN QUERY PLAN SELECT id FROM shop_items WHERE shop = 'x'").all().map((x) => x.detail).join(';');
    d.close();
    check('KEY from CREATE TABLE exists and is used', idx.includes('shop_items_shop') && /USING (COVERING )?INDEX shop_items_shop/.test(planShop), idx.join(',') + ' | ' + planShop);

    // A cached plan for an INSERT is rebuilt after ALTER TABLE adds a NOT NULL column.
    const insSql = 'INSERT INTO shop_items (sku, shop) VALUES (?, ?)';
    await call('insert', insSql, ['d', 'x']);
    await call('query', "ALTER TABLE shop_items ADD COLUMN stock INT NOT NULL DEFAULT 5", []);
    const after = await call('insert', insSql, ['e', 'x']);
    const stock = await call('scalar', 'SELECT stock FROM shop_items WHERE sku = ?', ['e']);
    check('plan rebuilt after ALTER TABLE', typeof after === 'number' && after > 0 && stock === 5, 'id=' + JSON.stringify(after) + ' stock=' + stock);

    // Finding 4.2.16: long whitespace runs made dialect regexes backtrack.
    const t0 = Date.now();
    const wsUpd = await call('update', 'UPDATE accounts SET balance = ?' + ' '.repeat(80000) + 'WHERE owner = ?', [9, 'alice']);
    const wsCreate = await call('query', 'CREATE TABLE IF NOT EXISTS ws_test (id INT' + ' '.repeat(80000) + ')', []);
    const wsMs = Date.now() - t0;
    check('80 KB of spaces in UPDATE and CREATE: done in < 200 ms', wsUpd === 1 && wsCreate && wsCreate.affectedRows === 0 && wsMs < 200, 'ms=' + wsMs + ' ' + JSON.stringify([wsUpd, wsCreate && wsCreate.affectedRows]));
    const lit = await call('scalar', "SELECT CONCAT(?, '" + ' '.repeat(40) + "x')", ['a']);
    check('spaces inside a string literal are kept', lit === 'a' + ' '.repeat(40) + 'x', JSON.stringify(lit));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    setTimeout(() => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows */ }
        process.exit(failed ? 1 : 0);
    }, 200);
})();
