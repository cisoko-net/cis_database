'use strict';

// A boot copy leaves no long WAL behind. The copy's rows went into the WAL
// and never started it over, so a stop without a clean close (a kill, a
// crash, FXServer closed from its window) left every frame of the copy in
// cache/durable.sqlite-wal, and the next start replayed them on the server
// thread inside PRAGMA journal_mode=WAL: 115 ms against 7 ms after a clean
// close, the load growing 39, 91, 141 ms over three killed boots.
//
// Checks: a cold boot of 165,500 rows in 114 tables, then the process is killed. The WAL
// left behind holds at most WAL_LIVE frames (the live part: frames after the
// header whose salts match it), and the next boot's load, the block before the
// first timer runs, stays under LOAD_MS. The load opened the split
// checkpoint's two connections before its first yield too: 75 ms.
//
// The cold boot also hands the thread back at most once per YIELD_ROWS rows
// copied. FXServer runs the Node event loop once per server tick, so every
// setImmediate waits for the next tick: the copy yielded after each 100 rows
// whatever the time spent, and a qbox cold copy of 92,189 rows took 61 s.
// Usage: node tests/repro/boot_wal_replay.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const TABLES = 4;
const ROWS = 40000;
const SMALL = 110;
// Two restart windows (WAL_RESTART_FRAMES) of 8192 frames.
const WAL_LIVE = 16384;
const LOAD_MS = 65;
const YIELD_ROWS = 400;

if (process.argv[2] === '--child') {
    let last = performance.now();
    let loadMs = null;
    let yields = 0;
    const realImmediate = global.setImmediate;
    // Only the engine's own (the harness loads server.js through eval): the
    // fake MariaDB of the harness yields per query.
    global.setImmediate = (...a) => {
        if (/eval at /.test(String(new Error().stack).split('\n')[2] || '')) yields++;
        return realImmediate(...a);
    };
    const tick = setInterval(() => {
        const now = performance.now();
        if (loadMs === null) loadMs = now - last;
        last = now;
    }, 2);
    const fx = require('../harness/fx.js');
    fx.ready(300000).then((ok) => {
        clearInterval(tick);
        process.send({ ready: ok, loadMs: Math.round(loadMs || 0), yields }, () => {
            // No shutdown, no close: the WAL stays as the copy left it.
            process.kill(process.pid, 'SIGKILL');
        });
    });
    return;
}

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

// Frames after the header whose salts match the header's: what a reopen
// replays.
function liveFrames(file) {
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { return 0; }
    if (buf.length < 32) return 0;
    const page = buf.readUInt32BE(8);
    const s1 = buf.readUInt32BE(16);
    const s2 = buf.readUInt32BE(20);
    let n = 0;
    for (let off = 32; off + 24 + page <= buf.length; off += 24 + page) {
        if (buf.readUInt32BE(off + 8) !== s1 || buf.readUInt32BE(off + 12) !== s2) break;
        n++;
    }
    return n;
}

function boot(dir, mariaFile) {
    return new Promise((res) => {
        const child = fork(__filename, ['--child'], {
            env: Object.assign({}, process.env, { FX_RES_DIR: dir, FX_MARIA_FILE: mariaFile }),
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let msg = null;
        let err = '';
        child.stderr.on('data', (d) => { err += d; });
        child.on('message', (m) => { msg = m; });
        child.on('exit', () => res(Object.assign({ ready: false, err: err.slice(-400) }, msg || {})));
    });
}

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-walreplay-'));
    const mariaFile = path.join(dir, 'maria.sqlite');
    const m = new DatabaseSync(mariaFile);
    const pad = 'x'.repeat(120);
    for (let t = 0; t < TABLES; t++) {
        m.exec('CREATE TABLE t' + t + ' (id INTEGER PRIMARY KEY AUTOINCREMENT, owner VARCHAR(64) NOT NULL, data TEXT, n INT NOT NULL)');
        m.exec('CREATE INDEX t' + t + '_owner ON t' + t + ' (owner)');
        const ins = m.prepare('INSERT INTO t' + t + ' (owner, data, n) VALUES (?, ?, ?)');
        m.exec('BEGIN');
        for (let i = 0; i < ROWS; i++) ins.run('license:' + ((i * 7919) % 100003).toString(16), pad + i, i);
        m.exec('COMMIT');
    }
    // A qbox-sized schema: opening a connection reads every table's.
    m.exec('BEGIN');
    for (let t = 0; t < SMALL; t++) {
        m.exec('CREATE TABLE s' + t + ' (id INTEGER PRIMARY KEY AUTOINCREMENT, citizenid VARCHAR(50) NOT NULL, money INT NOT NULL DEFAULT 0, data LONGTEXT)');
        m.exec('CREATE INDEX s' + t + '_cid ON s' + t + ' (citizenid)');
        const ins = m.prepare('INSERT INTO s' + t + ' (citizenid, money, data) VALUES (?, ?, ?)');
        for (let i = 0; i < 50; i++) ins.run('C' + i, i, 'y'.repeat(100));
    }
    m.exec('COMMIT');
    m.close();

    const wal = path.join(dir, 'cache', 'durable.sqlite-wal');
    const cold = await boot(dir, mariaFile);
    check('cold boot is ready', cold.ready, cold.err);
    const maxYields = Math.floor((TABLES * ROWS + SMALL * 50) / YIELD_ROWS);
    check('the cold copy yields at most once per ' + YIELD_ROWS + ' rows', cold.ready && cold.yields <= maxYields, cold.yields + ' yields, at most ' + maxYields);
    const frames = liveFrames(wal);
    check('a killed cold boot leaves at most ' + WAL_LIVE + ' live WAL frames', cold.ready && frames <= WAL_LIVE, frames + ' frames');

    const warm = await boot(dir, mariaFile);
    check('the boot after it is ready', warm.ready, warm.err);
    check('its load holds the thread under ' + LOAD_MS + ' ms', warm.ready && warm.loadMs < LOAD_MS, 'cold ' + cold.loadMs + ' ms, after the kill ' + warm.loadMs + ' ms');

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
