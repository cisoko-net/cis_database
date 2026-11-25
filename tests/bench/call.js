'use strict';

// Per-call cost of the export path, one call at a time: each call is issued
// alone in its own turn of the event loop, so the slice budget never queues
// it and the time is the engine's own work from export entry to callback.
// Prints µs per call (median of 9 rounds) for typical game statements.
// Usage: node tests/bench/call.js   (CASE=pk_update,insert_log runs only those)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-call-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec(`CREATE TABLE players (citizenid VARCHAR(50) PRIMARY KEY, license VARCHAR(255), name VARCHAR(255), money TEXT, charinfo TEXT, job TEXT, metadata TEXT, last_updated TIMESTAMP);
CREATE TABLE player_vehicles (id INTEGER PRIMARY KEY AUTOINCREMENT, citizenid VARCHAR(50), plate VARCHAR(8) UNIQUE, garage VARCHAR(50), fuel INT, engine FLOAT, body FLOAT, state INT);
CREATE INDEX pv_cid ON player_vehicles (citizenid);
CREATE TABLE bank_log (id INTEGER PRIMARY KEY AUTOINCREMENT, citizenid VARCHAR(50), amount INT, reason VARCHAR(64), at INT);`);
const ip = m.prepare('INSERT INTO players VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const iv = m.prepare('INSERT INTO player_vehicles (citizenid, plate, garage, fuel, engine, body, state) VALUES (?, ?, ?, ?, ?, ?, ?)');
m.exec('BEGIN');
for (let i = 0; i < 5000; i++) {
    ip.run('C' + i, 'license:' + i, 'Name ' + i, JSON.stringify({ cash: 500, bank: 5000 + i, crypto: 0 }),
        JSON.stringify({ firstname: 'A', lastname: 'B' + i, birthdate: '1990-01-01', gender: 0, nationality: 'US', phone: '555' + i }),
        JSON.stringify({ name: i % 5 ? 'unemployed' : 'police', grade: { level: 1 } }),
        JSON.stringify({ hunger: 100, thirst: 100, stress: 0, armor: 0, isdead: false }), '2026-10-22 00:00:00');
    for (let k = 0; k < 2; k++) iv.run('C' + i, 'P' + i + 'X' + k, 'pillbox', 100, 1000, 1000, 1);
}
m.exec('COMMIT');
m.close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;

const fx = require('../harness/fx.js');
const r = fx.registry;
const tick = () => new Promise((res) => setImmediate(res));

const CASES = [
    ['pk_select', (i, cb) => r.single('SELECT * FROM players WHERE citizenid = ?', ['C' + (i % 5000)], cb)],
    ['scalar', (i, cb) => r.scalar('SELECT money FROM players WHERE citizenid = ?', ['C' + (i % 5000)], cb)],
    ['index_list', (i, cb) => r.query('SELECT plate, fuel, engine FROM player_vehicles WHERE citizenid = ?', ['C' + (i % 5000)], cb)],
    ['pk_update', (i, cb) => r.update('UPDATE players SET money = ? WHERE citizenid = ?', ['{"cash":' + i + ',"bank":1}', 'C' + (i % 5000)], cb)],
    ['player_save', (i, cb) => r.update('UPDATE players SET money = ?, charinfo = ?, job = ?, metadata = ?, last_updated = NOW() WHERE citizenid = ?',
        ['{"cash":' + i + '}', '{"firstname":"A"}', '{"name":"police"}', '{"hunger":' + (i % 100) + '}', 'C' + (i % 5000)], cb)],
    ['insert_log', (i, cb) => r.insert('INSERT INTO bank_log (citizenid, amount, reason, at) VALUES (?, ?, ?, ?)', ['C' + (i % 5000), i, 'atm', i], cb)],
    ['in_list', (i, cb) => r.query('SELECT citizenid FROM players WHERE citizenid IN (?)', [['C' + (i % 5000), 'C' + ((i + 1) % 5000), 'C' + ((i + 2) % 5000)]], cb)],
    ['transfer_tx', (i, cb) => r.transaction([
        { query: 'UPDATE players SET money = ? WHERE citizenid = ?', values: ['{"bank":' + i + '}', 'C' + (i % 5000)] },
        { query: 'UPDATE players SET money = ? WHERE citizenid = ?', values: ['{"bank":' + (i + 1) + '}', 'C' + ((i + 7) % 5000)] },
        { query: 'INSERT INTO bank_log (citizenid, amount, reason, at) VALUES (?, ?, ?, ?)', values: ['C' + (i % 5000), i, 'transfer', i] },
    ], cb)],
];

async function round(fn, n) {
    let total = 0;
    for (let i = 0; i < n; i++) {
        await tick();
        const t0 = process.hrtime.bigint();
        await new Promise((res) => fn(i, res));
        total += Number(process.hrtime.bigint() - t0);
    }
    return total / n / 1000;
}

(async () => {
    await fx.ready(30000);
    const N = 3000;
    const out = [];
    const only = process.env.CASE ? process.env.CASE.split(",") : null;
    for (const [name, fn] of CASES) {
        if (only && !only.includes(name)) continue;
        await round(fn, 500);
        const rounds = [];
        for (let k = 0; k < 9; k++) rounds.push(await round(fn, N));
        rounds.sort((a, b) => a - b);
        out.push(name + '=' + rounds[4].toFixed(2));
    }
    console.log('us_per_call ' + out.join(' '));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows */ }
    process.exit(0);
})();
