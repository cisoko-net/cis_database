'use strict';

// The change copy wrote each MariaDB row with INSERT OR REPLACE. On a key
// conflict REPLACE deletes the SQLite row first, and with foreign_keys on
// that delete runs every child table's ON DELETE CASCADE: a reload of
// players wiped player_vehicles in SQLite while MariaDB kept the cars
// (qbox, 2026-11-07). The copy now updates the row in place (INSERT ...
// ON CONFLICT DO UPDATE), and never deletes a row to make room for another.
// The tables use the live qbox DDL: players' MariaDB key (citizenid) is a
// UNIQUE index in SQLite, beside an INTEGER PRIMARY KEY id.
// Usage: node tests/repro/cdc_upsert_cascade.js

const { DatabaseSync } = require('node:sqlite');
const { startCdc } = require('../../cdc.js');

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
const backend = {
    exec: (s) => db.exec(s),
    run: (s, p) => db.prepare(s).run(...(p || [])),
    get: (s, p) => db.prepare(s).get(...(p || [])),
    all: (s, p) => db.prepare(s).all(...(p || [])),
};

// MariaDB as the copy sees it: each table's rows and its first unique key.
const maria = {
    players: {
        key: [['PRIMARY', 'citizenid']],
        rows: [
            { id: 1, citizenid: 'ABC123', money: '{"cash":900}' },
            { id: 2, citizenid: 'NEW001', money: '{"cash":5}' },
        ],
    },
    player_vehicles: {
        key: [['PRIMARY', 'id'], ['plate', 'plate']],
        rows: [
            { id: 9, citizenid: 'ABC123', plate: 'BUFFALO1', garage: 'pillbox' },
        ],
    },
    tags: { key: [['PRIMARY', 'a'], ['PRIMARY', 'b']], rows: [{ a: 'x', b: 'y' }] },
    loose: { key: [['PRIMARY', 'k']], rows: [{ k: 'a', v: 'new' }] },
    drift: { key: [['PRIMARY', 'id']], rows: [{ id: 1, name: 'a' }, { id: 2, name: 'a' }] },
};
const conn = {
    async query(sql, params) {
        const from = /^SELECT \* FROM `([^`]+)`/.exec(sql);
        if (from) {
            const t = maria[from[1]];
            // The first page: OFFSET 0, or a keyset page with no WHERE yet.
            return [(/OFFSET 0$/.test(sql) || !/ WHERE /.test(sql)) && t ? t.rows.map((r) => Object.assign({}, r)) : []];
        }
        if (/information_schema\.statistics/.test(sql)) {
            const t = maria[params && params[1]];
            const seq = Object.create(null);
            return [t ? t.key.map(([name, col]) => {
                seq[name] = (seq[name] || 0) + 1;
                return { INDEX_NAME: name, non_unique: 0, COLUMN_NAME: col, seq_in_index: seq[name] };
            }) : []];
        }
        return [[]];
    },
    async end() {},
};
const mysql2mod = { createConnection: async () => conn };
const warned = [];
const log = { info() {}, debug() {}, warn(m) { warned.push(String(m)); }, error() {} };

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const col = (sql) => db.prepare(sql).all().map((r) => Object.values(r).join(':')).join(',');

(async () => {
    db.exec('CREATE TABLE "players" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "citizenid" TEXT COLLATE NOCASE NOT NULL, "money" TEXT COLLATE NOCASE NOT NULL)');
    db.exec('CREATE UNIQUE INDEX "players_PRIMARY" ON "players" ("citizenid")');
    db.exec('CREATE TABLE "player_vehicles" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "citizenid" TEXT COLLATE NOCASE, "plate" TEXT COLLATE NOCASE NOT NULL, "garage" TEXT COLLATE NOCASE,'
        + ' FOREIGN KEY ("citizenid") REFERENCES "players" ("citizenid") ON DELETE CASCADE ON UPDATE CASCADE)');
    db.exec('CREATE UNIQUE INDEX "player_vehicles_plate" ON "player_vehicles" ("plate")');
    db.exec('CREATE TABLE "vehicle_financing" ("vehicleId" INTEGER NOT NULL, "balance" INTEGER,'
        + ' FOREIGN KEY ("vehicleId") REFERENCES "player_vehicles" ("id") ON DELETE CASCADE ON UPDATE CASCADE)');
    db.exec('CREATE TABLE "tags" ("a" TEXT, "b" TEXT, PRIMARY KEY ("a", "b"))');
    // No SQLite constraint matches MariaDB's key here (a schema changed
    // outside), so no ON CONFLICT target exists for it.
    db.exec('CREATE TABLE "loose" ("k" TEXT, "v" TEXT)');
    db.exec('CREATE TABLE "drift" ("id" INTEGER PRIMARY KEY, "name" TEXT)');
    db.exec('CREATE UNIQUE INDEX "drift_name" ON "drift" ("name")');

    db.exec("INSERT INTO players VALUES (1, 'ABC123', '{\"cash\":100}'), (3, 'GONE01', '{\"cash\":1}')");
    db.exec("INSERT INTO player_vehicles VALUES (9, 'ABC123', 'BUFFALO1', 'pillbox'), (11, 'GONE01', 'OLDCAR1', 'pillbox')");
    db.exec('INSERT INTO vehicle_financing VALUES (9, 5000)');
    db.exec("INSERT INTO tags VALUES ('x', 'y')");
    db.exec("INSERT INTO loose VALUES ('a', 'old')");
    db.exec("INSERT INTO drift VALUES (1, 'a')");

    const cdc = startCdc({
        mysql2mod, dsn: { host: 'x', port: 3306, user: 'u', password: '', database: 'd' }, backend,
        dirtyTables: new Set(), pollMs: 3600000, dirtyTtlMs: 50, log, baseline: Promise.resolve(),
    });

    const n = await cdc.reload('players');
    check('a players reload keeps the citizen\'s cars', col("SELECT id FROM player_vehicles WHERE citizenid = 'ABC123'") === '9',
        col('SELECT id, citizenid FROM player_vehicles'));
    check('the players row takes MariaDB\'s values in place', col("SELECT id, money FROM players WHERE citizenid = 'ABC123'") === '1:{"cash":900}',
        col('SELECT id, citizenid, money FROM players'));
    check('a citizen new in MariaDB is inserted', col("SELECT id FROM players WHERE citizenid = 'NEW001'") === '2');
    check('a citizen MariaDB deleted is still removed, with its cars', col("SELECT id FROM players WHERE citizenid = 'GONE01'") === ''
        && col("SELECT id FROM player_vehicles WHERE citizenid = 'GONE01'") === '', col('SELECT citizenid FROM players'));
    check('the reload counts every row', n === 2, String(n));

    await cdc.reload('player_vehicles');
    check('a player_vehicles reload keeps the car\'s financing', col('SELECT vehicleId, balance FROM vehicle_financing') === '9:5000',
        col('SELECT vehicleId, balance FROM vehicle_financing'));

    // MariaDB deleted car 9 and gave its plate to a new car 12. Car 12 first
    // clashes with SQLite's car 9 on the plate; the delete pass removes car 9
    // (MariaDB has no id 9), and car 12 is copied on the retry. Before the
    // retry, a failure skipped the delete pass and the table never copied.
    maria.player_vehicles.rows = [{ id: 12, citizenid: 'ABC123', plate: 'BUFFALO1', garage: 'legion' }];
    const reuse = await cdc.reload('player_vehicles');
    check('a plate MariaDB moved to a new car copies in one reload', col('SELECT id, plate FROM player_vehicles ORDER BY id') === '12:BUFFALO1',
        col('SELECT id, plate FROM player_vehicles'));
    check('the deleted car\'s financing goes with it, as in MariaDB', col('SELECT vehicleId FROM vehicle_financing') === '',
        col('SELECT vehicleId FROM vehicle_financing'));
    check('the plate reload counts the copied row', reuse === 1, String(reuse));

    // Car 12 takes a new plate and a new car 13 its old one, the new car
    // first in MariaDB's order: car 13 clashes until car 12 is updated.
    maria.player_vehicles.rows = [
        { id: 13, citizenid: 'ABC123', plate: 'BUFFALO1', garage: 'legion' },
        { id: 12, citizenid: 'ABC123', plate: 'SWAP2', garage: 'legion' },
    ];
    const swap = await cdc.reload('player_vehicles');
    check('a plate swap copies both cars', col('SELECT id, plate FROM player_vehicles ORDER BY id') === '12:SWAP2,13:BUFFALO1' && swap === 2,
        col('SELECT id, plate FROM player_vehicles') + ' n=' + swap);

    // SQLite has a UNIQUE index MariaDB lacks (a schema changed outside):
    // the clash cannot clear, so the row fails and nothing is deleted.
    warned.length = 0;
    const clash = await cdc.reload('drift');
    check('a clash that cannot clear deletes nothing', col('SELECT id, name FROM drift ORDER BY id') === '1:a', col('SELECT id, name FROM drift'));
    check('a failed row fails the reload', clash === -1, String(clash));
    check('a failed row is logged with its error', warned.some((m) => /drift/.test(m) && /UNIQUE/i.test(m)), warned.join(' | '));
    await cdc.reload('drift');
    check('a table still failing warns at most once a minute', warned.length === 1, String(warned.length));

    await cdc.reload('tags');
    check('a table that is all key keeps its row', col('SELECT a, b FROM tags') === 'x:y', col('SELECT a, b FROM tags'));

    await cdc.reload('loose');
    check('a key SQLite has no constraint for updates in place, no duplicate', col('SELECT k, v FROM loose') === 'a:new', col('SELECT k, v FROM loose'));

    const fk = db.prepare('PRAGMA foreign_key_check').all();
    check('no foreign key is left dangling', fk.length === 0, JSON.stringify(fk));

    cdc.stop();
    const bad = results.filter((ok) => !ok).length;
    console.log(bad ? 'FAIL ' + bad + ' of ' + results.length : 'ALL ' + results.length + ' PASS');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
