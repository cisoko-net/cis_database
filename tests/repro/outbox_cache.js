'use strict';

// The flush's decoded-row cache (server.js, obCache): rows outboxAdd just
// wrote go to MariaDB from memory, not read back and parsed. First the
// SQLite behaviour it relies on (AUTOINCREMENT gives a rolled-back id to
// the next row, never the id of a committed one); then the engine with
// MariaDB writes down while rows pile up, values of every type, and more
// pending rows than the cache holds: once MariaDB is back it must hold
// exactly what SQLite holds.
// Usage: node tests/repro/outbox_cache.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function autoincrement() {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE o (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)');
    const ins = db.prepare('INSERT INTO o (body) VALUES (?)');
    const a = Number(ins.run('a').lastInsertRowid);
    db.exec('BEGIN');
    const b = Number(ins.run('b').lastInsertRowid);
    db.exec('ROLLBACK');
    const c = Number(ins.run('c').lastInsertRowid);
    db.exec('SAVEPOINT s');
    const d = Number(ins.run('d').lastInsertRowid);
    db.exec('ROLLBACK TO s');
    db.exec('RELEASE s');
    const e = Number(ins.run('e').lastInsertRowid);
    db.prepare('DELETE FROM o WHERE id <= ?').run(e);
    const f = Number(ins.run('f').lastInsertRowid);
    check('a rolled-back id goes to the next row', b === a + 1 && c === b && d === c + 1 && e === d, [a, b, c, d, e].join(','));
    check('the id of a committed row is never handed out again, even once deleted', f === e + 1, 'after delete: ' + f);
}

autoincrement();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-obcache-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(64), qty INT, price DOUBLE, note TEXT, flag TINYINT, raw BLOB, doc LONGTEXT)');
m.close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;
process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: 'mysql://root@127.0.0.1/fake', cis_database_cdc: '0' });

const fx = require('../harness/fx.js');
const r = fx.registry;

const dump = (db) => db.prepare('SELECT id, name, qty, price, note, flag, hex(raw) AS raw, doc FROM items ORDER BY id').all().map((x) => JSON.stringify(Object.assign({}, x)));

async function drained(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end && r.probe().replica > 0) await sleep(20);
    return r.probe().replica === 0;
}

(async () => {
    if (!(await fx.ready(20000))) throw new Error('not ready');
    process.env.FX_MARIA_WRITES = 'down';
    for (let i = 0; i < 200; i++) {
        await fx.call('insert', 'INSERT INTO items (name, qty, price, note, flag, raw, doc) VALUES (?, ?, ?, ?, ?, ?, ?)', [
            'item ' + i + (i % 7 === 0 ? " it's \"quoted\" \\ é ✓" : ''),
            i % 5 === 0 ? null : i * 3,
            i % 3 === 0 ? i / 7 : -i - 0.5,
            i % 4 === 0 ? null : 'line1\nline2\t' + i,
            i % 2 === 0,
            Buffer.from([i & 255, 0, 255, 10, 13]),
            JSON.stringify({ i, tags: ['a', 'b'], nested: { ok: true, s: 'x y' } }),
        ]);
    }
    await fx.call('update', 'UPDATE items SET qty = qty + ? WHERE id <= ?', [1000, 50]);
    await fx.call('transaction', [{ query: 'UPDATE items SET note = ? WHERE id = ?', values: ['tx', 3] }, { query: 'DELETE FROM items WHERE id = ?', values: [4] }]);
    const p1 = r.probe();
    check('rows written while MariaDB is down are held decoded', p1.ob_cache >= 200 && p1.replica >= 200, 'ob_cache=' + p1.ob_cache + ' replica=' + p1.replica);
    delete process.env.FX_MARIA_WRITES;
    r.flushReplica && r.flushReplica();
    check('MariaDB gets every row once it is back', await drained(20000), 'replica=' + r.probe().replica);
    const local = new DatabaseSync(path.join(dir, 'cache', 'durable.sqlite'));
    const maria = new DatabaseSync(mariaFile);
    const a = dump(local);
    const b = dump(maria);
    const diff = a.findIndex((x, i) => x !== b[i]);
    check('and holds exactly what SQLite holds, value for value', a.length === 199 && b.length === 199 && diff < 0, 'sqlite=' + a.length + ' maria=' + b.length + (diff >= 0 ? ' first diff: ' + a[diff] + ' vs ' + b[diff] : ''));
    check('applied rows leave the cache', r.probe().ob_cache === 0 && r.probe().ob_cache_bytes === 0, 'ob_cache=' + r.probe().ob_cache + ' bytes=' + r.probe().ob_cache_bytes);

    // More pending than the cache holds (32 MB): the rest is read back.
    process.env.FX_MARIA_WRITES = 'down';
    const big = 'z'.repeat(400 * 1024);
    for (let i = 0; i < 100; i++) await fx.call('insert', 'INSERT INTO items (name, doc) VALUES (?, ?)', ['big ' + i, big + i]);
    const p2 = r.probe();
    check('the cache stops at its cap', p2.ob_cache_bytes <= 32 * 1024 * 1024 && p2.ob_cache < 100 && p2.replica >= 100, 'ob_cache=' + p2.ob_cache + ' bytes=' + p2.ob_cache_bytes + ' replica=' + p2.replica);
    delete process.env.FX_MARIA_WRITES;
    r.flushReplica && r.flushReplica();
    check('rows past the cap reach MariaDB too', await drained(30000), 'replica=' + r.probe().replica);
    const a2 = dump(local);
    const b2 = dump(maria);
    const diff2 = a2.findIndex((x, i) => x !== b2[i]);
    check('and MariaDB still matches SQLite', a2.length === 299 && b2.length === 299 && diff2 < 0, 'sqlite=' + a2.length + ' maria=' + b2.length + (diff2 >= 0 ? ' first diff at ' + diff2 : ''));
    local.close();
    maria.close();
    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + e.stack); process.exit(1); });
