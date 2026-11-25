'use strict';

// Pre-release review of 28dbdb1, M1: the outbox replayed a statement's text,
// so MariaDB computed NOW() and CURRENT_TIMESTAMP when the write reached it,
// not when the game made it. A ban written with NOW() + INTERVAL 1 DAY while
// MariaDB was away for six hours expired six hours later there, and the next
// boot copied MariaDB's row back. Replay now pins MariaDB's clock to the
// moment SQLite committed the write (SET timestamp) and resets it after.
// Usage: node tests/repro/replay_clock.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-clock-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE bans (id VARCHAR(50) PRIMARY KEY, at TEXT)');
m.close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;
process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: 'mysql://root@127.0.0.1/fake', cis_database_cdc: '0' });

const fx = require('../harness/fx.js');
const r = fx.registry;

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
async function drained(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (r.probe().replica === 0) return true; await sleep(50); }
    return false;
}
const mariaAt = (id) => {
    const db = new DatabaseSync(mariaFile);
    try { return db.prepare('SELECT at FROM bans WHERE id = ?').get(id); } finally { db.close(); }
};
const secs = (text) => Date.parse(String(text).replace(' ', 'T') + 'Z') / 1000;

(async () => {
    if (!(await fx.ready(20000))) throw new Error('not ready');
    global.__fxInvoker = 'some_script';

    process.env.FX_MARIA_WRITES = 'down';
    const made = Date.now() / 1000;
    await fx.call('update', 'INSERT INTO bans (id, at) VALUES (?, NOW())', ['late']);
    await sleep(3000);
    process.env.FX_MARIA_WRITES = 'up';
    check('the write reaches MariaDB once it is back', await drained(15000));
    const row = mariaAt('late');
    const gap = row ? secs(row.at) - made : NaN;
    check('MariaDB stores the time the game wrote it, not the time it arrived', Math.abs(gap) < 1.5, 'gap=' + gap.toFixed(2) + ' s at=' + (row && row.at));

    await fx.call('update', 'INSERT INTO bans (id, at) VALUES (?, NOW())', ['now']);
    check('a later write drains', await drained(15000));
    const row2 = mariaAt('now');
    const gap2 = row2 ? secs(row2.at) - Date.now() / 1000 : NaN;
    check('the pinned clock does not stick to the connection', Math.abs(gap2) < 1.5, 'gap=' + gap2.toFixed(2) + ' s');

    const failed = results.filter((x) => !x).length;
    console.log(failed ? `replay_clock: ${failed} FAILED` : `replay_clock: all ${results.length} passed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack)); process.exit(1); });
