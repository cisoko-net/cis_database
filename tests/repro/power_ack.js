'use strict';

// Power-cut durability (server.js, pumpWal): a write is answered only after
// an fdatasync of the WAL that started after its commit has finished, reads
// are not held back by it, and the outbox reaches MariaDB only up to rows a
// finished sync covers. fs.fdatasync is held here to stand in for a slow
// disk; a power cut while it is held could lose exactly the writes nobody
// was told about yet.
// Usage: node tests/repro/power_ack.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Hold every write-ack fdatasync callback while held is true. Only syncs
// started by pumpWal are counted and held: the WAL checkpoint cycle
// (runWalCycle, every 3 s when idle) syncs the same files, and on a loaded
// machine one of its syncs landed inside a held window and was counted as a
// third write sync.
let held = false;
const parked = [];
let syncsDone = 0;
let syncCalls = 0;
const realSync = fs.fdatasync;
fs.fdatasync = function (fd, cb) {
    if (!/\bpumpWal\b/.test(new Error().stack)) return realSync.call(fs, fd, cb);
    const n = ++syncCalls;
    realSync.call(fs, fd, (e) => {
        const done = () => { syncsDone++; cb(e); };
        if (held) parked.push({ n, done }); else done();
    });
};
const release = () => { held = false; parked.splice(0).forEach((p) => p.done()); };
const releaseCall = (n) => { const i = parked.findIndex((p) => p.n === n); if (i >= 0) parked.splice(i, 1)[0].done(); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-power-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE users (identifier VARCHAR(64) PRIMARY KEY, money INT NOT NULL); CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, seq INT)');
m.prepare('INSERT INTO users VALUES (?, ?)').run('alice', 100);
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
const mariaLogs = () => {
    const db = new DatabaseSync(mariaFile);
    const n = db.prepare('SELECT COUNT(*) AS n FROM logs').get().n;
    db.close();
    return Number(n);
};

(async () => {
    if (!(await fx.ready(20000))) throw new Error('not ready');
    check('writes wait for the sync by default', r.probe().ack === 'power');
    await sleep(300);

    held = true;
    let answered = 0;
    let insertId = null;
    r.insert('INSERT INTO logs (seq) VALUES (?)', [1], (id) => { answered++; insertId = id; });
    r.update('UPDATE users SET money = money + 5 WHERE identifier = ?', ['alice'], () => { answered++; });
    let txDone = false;
    r.transaction([{ query: 'INSERT INTO logs (seq) VALUES (?)', values: [2] }, { query: 'UPDATE users SET money = money - 1 WHERE identifier = ?', values: ['alice'] }], () => { txDone = true; });
    let readAt = null;
    const t0 = Date.now();
    r.scalar('SELECT money FROM users WHERE identifier = ?', ['alice'], (v) => { readAt = { v, ms: Date.now() - t0 }; });
    await sleep(600);
    check('no write is answered while its sync is pending', answered === 0 && !txDone && parked.length > 0, 'answered=' + answered + ' parked syncs=' + parked.length);
    check('a read is answered at once and sees the committed writes', readAt && readAt.v === 104 && readAt.ms < 300, JSON.stringify(readAt));
    check('MariaDB gets nothing a sync has not covered', mariaLogs() === 0, 'maria logs=' + mariaLogs());

    release();
    const end = Date.now() + 5000;
    while (Date.now() < end && (answered < 2 || !txDone)) await sleep(10);
    check('the writes are answered once the sync finishes', answered === 2 && txDone && insertId === 1, 'answered=' + answered + ' tx=' + txDone + ' id=' + insertId);
    const end2 = Date.now() + 10000;
    while (Date.now() < end2 && (mariaLogs() < 2 || r.probe().replica > 0)) await sleep(20);
    check('and then reach MariaDB', mariaLogs() === 2, 'maria logs=' + mariaLogs());

    // Group commit: many writes waiting together share syncs.
    const before = syncsDone;
    let n = 0;
    const N = 500;
    for (let i = 0; i < N; i++) r.insert('INSERT INTO logs (seq) VALUES (?)', [100 + i], () => { n++; });
    const end3 = Date.now() + 10000;
    while (Date.now() < end3 && n < N) await sleep(5);
    const used = syncsDone - before;
    check('a burst of writes shares syncs (group commit)', n === N && used < N / 5, N + ' writes answered after ' + used + ' syncs');

    // A write that commits while a sync is running gets a sync of its own at
    // once; that sync also covers the writes before it, so it answers them
    // even if the first sync is still running. Two at most in flight.
    // The burst can leave a second sync still running after its last answer;
    // under load it finished inside the held window and was parked too.
    const idle = Date.now() + 5000;
    while (Date.now() < idle && syncsDone < syncCalls) await sleep(5);
    await sleep(100);
    held = true;
    const first = syncCalls;
    let aDone = false;
    let bDone = false;
    let cDone = false;
    r.insert('INSERT INTO logs (seq) VALUES (?)', [9001], () => { aDone = true; });
    await sleep(50);
    r.insert('INSERT INTO logs (seq) VALUES (?)', [9002], () => { bDone = true; });
    await sleep(50);
    r.insert('INSERT INTO logs (seq) VALUES (?)', [9003], () => { cDone = true; });
    const waitParked = Date.now() + 3000;
    while (Date.now() < waitParked && parked.length < syncCalls - first) await sleep(5);
    check('a write during a running sync starts its own sync, two at most', syncCalls - first === 2 && parked.length === 2, 'syncs started=' + (syncCalls - first) + ' parked=' + parked.length);
    releaseCall(first + 2);
    await sleep(50);
    check('the later sync answers every write committed before it started', aDone && bDone && !cDone, 'a=' + aDone + ' b=' + bDone + ' c=' + cDone);
    const waitC = Date.now() + 3000;
    while (Date.now() < waitC && syncCalls - first < 3) await sleep(5);
    check('the write after both waits for the next sync', !cDone && syncCalls - first === 3, 'c=' + cDone + ' syncs=' + (syncCalls - first));
    release();
    const endC = Date.now() + 3000;
    while (Date.now() < endC && !cDone) await sleep(5);
    held = false;
    release();
    check('and is answered by it', cDone);

    // process mode answers at commit (kept for comparison).
    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + e.stack); process.exit(1); });
