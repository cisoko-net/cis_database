'use strict';

// oxmysql 2.14.3 runs MySQL.prepare and MySQL.rawExecute once per parameter
// list when it is given a list of lists, in order and with no transaction,
// and answers one result per list (src/utils/parseExecute.ts,
// src/database/rawExecute.ts). es_extended's ESX.AddItems
// (server/modules/items/registry.lua:124) inserts its items so:
// MySQL.prepare.await('INSERT IGNORE INTO items (name,label,weight,rare,can_remove) VALUES (?,?,?,?,?)', { { 5 values }, ... }),
// and ox_inventory saves players, trunks and stashes the same way.
// cis_database counted the lists as values and failed with "Expected 5
// parameters, but received 15." (printed under esx_shops on the 1.0.0 live
// run); with no more lists than marks it ran them but answered one summed
// count. Checked through the callback export, the .await fast path
// (cis_call) and execMany; MariaDB must end with every list's row.
// Usage: node tests/repro/prepare_batches.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-batches-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
// es_extended's items, ox_inventory's stashes and the player and vehicle
// columns they save, in the types the SQLite stand-in for MariaDB takes.
m.exec('CREATE TABLE items (name VARCHAR(50) NOT NULL PRIMARY KEY, label VARCHAR(50) NOT NULL, weight INT NOT NULL DEFAULT 1, rare TINYINT NOT NULL DEFAULT 0, can_remove TINYINT NOT NULL DEFAULT 1)');
m.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body VARCHAR(32) NOT NULL)');
m.exec('CREATE TABLE users (identifier VARCHAR(60) NOT NULL PRIMARY KEY, inventory TEXT)');
m.exec("INSERT INTO users VALUES ('char1', '[]'), ('char2', '[]'), ('char3', '[]')");
// ox_inventory names its key: UNIQUE KEY `owner` (`owner`, `name`). A named
// index keeps both columns in one key in the stand-in's schema listing.
m.exec('CREATE TABLE ox_inventory (owner VARCHAR(60), name VARCHAR(100) NOT NULL, data TEXT)');
m.exec('CREATE UNIQUE INDEX owner ON ox_inventory (owner, name)');
m.exec('CREATE TABLE owned_vehicles (plate VARCHAR(12) NOT NULL PRIMARY KEY, mileage FLOAT DEFAULT 0)');
m.exec("INSERT INTO owned_vehicles VALUES ('ABC 123', 0), ('XYZ 789', 0)");
m.close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;

const fx = require('../harness/fx.js');
const r = fx.registry;

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const show = (x) => JSON.stringify(x);

// MySQL.<method>(sql, p, cb) through the export with the include's error
// flag, as the .await fallback sends it: a failure comes back as { err }.
const callE = (kind, sql, p) => new Promise((res) => r[kind](sql, p, (v, e) => res(e != null ? { err: String(e) } : { v }), 'es_extended', true));
// MySQL.<method>(sql, p, cb) with no error flag: a failure is printed and
// the callback never runs.
const callPlain = (kind, sql, p) => new Promise((res) => {
    const t = setTimeout(() => res({ err: 'the callback never ran' }), 3000);
    r[kind](sql, p, (v) => { clearTimeout(t); res({ v }); }, 'es_extended');
});
// MySQL.<method>.await on the fast path: cis_call answers [1, result] at
// once, [2, error], or [0, id] and the result later through the resolver.
const answers = [];
async function callFast(kind, sql, p) {
    const x = r.cis_call(kind, sql, p);
    if (!x || x[0] === 2) return { err: String(x && x[1]) };
    if (x[0] === 1) return { v: x[1] };
    if (x[0] !== 0) return { err: 'cis_call answered ' + show(x) };
    const end = Date.now() + 5000;
    while (Date.now() < end && !answers.some((a) => a.id === x[1])) await sleep(10);
    const a = answers.find((y) => y.id === x[1]);
    if (!a) return { err: 'no answer for call ' + x[1] };
    return a.err != null && a.err !== '' ? { err: String(a.err) } : { v: a.result };
}
const query = async (sql, p) => (await callE('query', sql, p || [])).v;
const idsOf = async (bodies) => ((await query('SELECT id FROM notes WHERE body IN (?) ORDER BY id', [bodies])) || []).map((x) => x.id);
const mariaRows = (sql) => {
    const mm = new DatabaseSync(mariaFile);
    try { return show(mm.prepare(sql).all()); } finally { mm.close(); }
};
async function drained(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end && r.probe().replica > 0) await sleep(20);
    return r.probe().replica === 0;
}

(async () => {
    check('engine ready', await fx.ready(20000));
    global.__fxInvoker = 'es_extended';
    r.cis_register((id, result, err) => answers.push({ id, result, err }));
    await sleep(10);

    // Portable SQL first: the stand-in MariaDB runs SQLite syntax, and the
    // replica keeps the order, so these writes are checked on MariaDB too.
    const ins = await callE('prepare', 'INSERT INTO notes (body) VALUES (?)', [['a'], ['b'], ['c']]);
    const abc = await idsOf(['a', 'b', 'c']);
    check('prepare.await with 3 lists inserts 3 rows and answers their ids', abc.length === 3 && show(ins.v) === show(abc), show(ins) + ' ids ' + show(abc));

    const upd = await callPlain('prepare', 'UPDATE users SET inventory = ? WHERE identifier = ?', [['[1]', 'char1'], ['[2]', 'char2'], ['[3]', 'char3']]);
    check('prepare with a callback and 3 lists answers one count per list', show(upd.v) === '[1,1,1]', show(upd));

    const fast = await callFast('prepare', 'INSERT INTO notes (body) VALUES (?)', [['d'], ['e'], ['f']]);
    const def = await idsOf(['d', 'e', 'f']);
    check('prepare.await on the fast path (cis_call) takes 3 lists', def.length === 3 && show(fast.v) === show(def), show(fast) + ' ids ' + show(def));

    const one = await callE('prepare', 'UPDATE owned_vehicles SET mileage = ? WHERE plate = ?', [[123.5, 'ABC 123']]);
    check('one nested list is one set of values', one.v === 1, show(one));

    const raw = await callE('rawExecute', 'INSERT INTO notes (body) VALUES (?)', [['g'], ['h']]);
    const gh = await idsOf(['g', 'h']);
    check('rawExecute with 2 lists answers one header per list',
        gh.length === 2 && Array.isArray(raw.v) && raw.v.length === 2 && raw.v.every((h, i) => h && h.affectedRows === 1 && h.insertId === gh[i]),
        show(raw) + ' ids ' + show(gh));

    const rawFast = await callFast('rawExecute', 'UPDATE users SET inventory = ? WHERE identifier = ?', [['[4]', 'char1'], ['[5]', 'char2']]);
    check('rawExecute on the fast path answers one header per list',
        Array.isArray(rawFast.v) && rawFast.v.length === 2 && rawFast.v.every((h) => h && h.affectedRows === 1), show(rawFast));

    // A Lua table with keys set by hand comes over as an object: the outer
    // list, and an inner list whose missing values oxmysql sends as NULL.
    const mapped = await callE('prepare', 'UPDATE owned_vehicles SET mileage = ? WHERE plate = ?', { 1: [1.5, 'ABC 123'], 2: { 1: 2.5, 2: 'XYZ 789' } });
    check('lists given as Lua maps run once each', show(mapped.v) === '[1,1]', show(mapped));
    const holes = await callE('rawExecute', 'UPDATE users SET inventory = ? WHERE identifier = ?', [{ 2: 'char3' }, ['[6]', 'char1']]);
    const char3 = await query("SELECT inventory FROM users WHERE identifier = 'char3'");
    check('a missing value in a list binds NULL',
        Array.isArray(holes.v) && holes.v.length === 2 && holes.v.every((h) => h && h.affectedRows === 1) && show(char3) === '[{"inventory":null}]',
        show(holes) + ' ' + show(char3));

    // oxmysql answers each list's rows; one row stays in its own list.
    const reads = await callE('prepare', 'SELECT body FROM notes WHERE id = ?', [[abc[0]], [abc[1]]]);
    check('a read with 2 lists answers each list\'s rows', show(reads.v) === '[[{"body":"a"}],[{"body":"b"}]]', show(reads));

    // execMany is cis_database's own: one result per item, so a prepare item
    // with 2 lists answers what MySQL.prepare would.
    const many = await new Promise((res) => r.execMany([{ kind: 'prepare', query: 'UPDATE owned_vehicles SET mileage = ? WHERE plate = ?', values: [[7.5, 'ABC 123'], [8.5, 'XYZ 789']] }],
        (v, e) => res(e != null ? { err: String(e) } : { v })));
    check('an execMany prepare item with 2 lists answers one count per list', show(many.v) === '[[1,1]]', show(many));

    const usersSql = 'SELECT identifier, inventory FROM users ORDER BY identifier';
    const carsSql = 'SELECT plate, mileage FROM owned_vehicles ORDER BY plate';
    const notesSql = 'SELECT id, body FROM notes ORDER BY id';
    check('SQLite holds what every list wrote',
        show(await query(usersSql)) === '[{"identifier":"char1","inventory":"[6]"},{"identifier":"char2","inventory":"[5]"},{"identifier":"char3","inventory":null}]'
        && show(await query(carsSql)) === '[{"plate":"ABC 123","mileage":7.5},{"plate":"XYZ 789","mileage":8.5}]'
        && show((await query(notesSql) || []).map((x) => x.body)) === '["a","b","c","d","e","f","g","h"]',
        show(await query(usersSql)) + ' ' + show(await query(carsSql)) + ' ' + show(await query(notesSql)));

    if (r.flushReplica) fx.asSelf(() => r.flushReplica());
    check('the MariaDB queue drains', await drained(10000), 'replica ' + r.probe().replica);
    check('MariaDB has every list\'s note, with the same ids', mariaRows(notesSql) === show(await query(notesSql)), mariaRows(notesSql));
    check('MariaDB has every list\'s user update', mariaRows(usersSql) === show(await query(usersSql)), mariaRows(usersSql));
    check('MariaDB has every list\'s mileage', mariaRows(carsSql) === show(await query(carsSql)), mariaRows(carsSql));

    // MySQL-only syntax last: the stand-in MariaDB cannot run INSERT IGNORE
    // or ON DUPLICATE KEY UPDATE, so these are checked on SQLite only.
    const ESX_ITEMS = 'INSERT IGNORE INTO items (name,label,weight,rare,can_remove) VALUES (?,?,?,?,?)';
    const item = (n) => ['item' + n, 'Item ' + n, 1, 0, 1];
    const fifteen = Array.from({ length: 15 }, (_, i) => item(i + 1));
    const zeros = (n) => show(new Array(n).fill(0));
    const count = async () => (await callE('scalar', 'SELECT COUNT(*) FROM items', [])).v;
    const esx = await callE('prepare', ESX_ITEMS, fifteen);
    check('the es_extended items insert with 15 lists of 5 values runs', show(esx.v) === zeros(15), show(esx));
    check('it wrote 15 items', (await count()) === 15, String(await count()));
    const again = await callPlain('prepare', ESX_ITEMS, fifteen);
    check('the same lists on the next boot skip every duplicate', show(again.v) === zeros(15) && (await count()) === 15, show(again) + ' count ' + (await count()));
    const fastEsx = await callFast('prepare', ESX_ITEMS, [item(16), item(17), item(18)]);
    check('the items insert runs on the fast path', show(fastEsx.v) === '[0,0,0]' && (await count()) === 18, show(fastEsx) + ' count ' + (await count()));

    // ox_inventory's saveInventories: UPSERT_STASH by rawExecute, then the
    // affectedRows of each header.
    const UPSERT_STASH = 'INSERT INTO ox_inventory (data, owner, name) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)';
    const stash1 = await callE('rawExecute', UPSERT_STASH, [['[1]', 'char1', 'locker'], ['[2]', 'char2', 'locker']]);
    check('the ox_inventory stash upsert with 2 lists answers 2 headers', Array.isArray(stash1.v) && show(stash1.v.map((h) => h && h.affectedRows)) === '[1,1]', show(stash1));
    const stash2 = await callE('rawExecute', UPSERT_STASH, [['[3]', 'char1', 'locker'], ['[4]', 'char2', 'locker'], ['[5]', 'char3', 'locker'], ['[6]', 'char1', 'glovebox']]);
    check('an upsert that changed its row counts 2, a new row 1', Array.isArray(stash2.v) && show(stash2.v.map((h) => h && h.affectedRows)) === '[2,2,1,1]', show(stash2));
    const stashes = await query('SELECT owner, name, data FROM ox_inventory ORDER BY owner, name');
    check('the stash rows hold the last data', show(stashes) === show([
        { owner: 'char1', name: 'glovebox', data: '[6]' },
        { owner: 'char1', name: 'locker', data: '[3]' },
        { owner: 'char2', name: 'locker', data: '[4]' },
        { owner: 'char3', name: 'locker', data: '[5]' },
    ]), show(stashes));

    const bad = await callE('prepare', ESX_ITEMS, [item(19), item(20).concat(['extra'])]);
    check('a list with 6 values for 5 marks fails as in oxmysql', bad.err && bad.err.includes('Expected 5 parameters, but received 6.'), show(bad));
    const kept = await callE('scalar', "SELECT COUNT(*) FROM items WHERE name = 'item19'", []);
    check('the lists before the failed one stay written, as in oxmysql', kept.v === 1, show(kept));

    const flat = await callE('prepare', 'SELECT body FROM notes WHERE id = ?', [abc[0]]);
    check('a flat list is still one set: one value for a one-column row', flat.v === 'a', show(flat));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
