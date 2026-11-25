'use strict';

// An idle server leaves no long WAL behind. SQLite starts the WAL over only
// when a write begins with every frame copied, so the frames of the last burst
// of writes stayed valid while the server sat idle, and a stop without a clean
// close (systemctl restart, a crash) replayed them all on the server thread at
// the next start: on qbox a warm boot held one tick for 125 to 135 ms across
// PRAGMA journal_mode=WAL and the first read of the checkpoint connections,
// after a 42 MB WAL.
//
// Checks: a boot, a burst of writes, then idle until two checkpoint cycles
// have run, then the process is killed. The WAL left behind holds at most
// WAL_LIVE live frames (726 before the fix: the outbox deletes after the
// burst were never copied, and nothing started the WAL over), and the next
// boot is ready. Locally a few hundred frames cost only a few ms to replay,
// so the frame count is the check, not the load time.
// Usage: node tests/repro/idle_wal_restart.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROWS = 20000;
const WRITES = 6000;
const IDLE_MS = 9000;
const WAL_LIVE = 16;

if (process.argv[2] === '--child') {
    let last = performance.now();
    let loadMs = null;
    const tick = setInterval(() => {
        const now = performance.now();
        if (loadMs === null) loadMs = now - last;
        last = now;
    }, 2);
    const fx = require('../harness/fx.js');
    fx.ready(120000).then(async (ok) => {
        clearInterval(tick);
        const burst = process.env.WAL_BURST === '1';
        if (ok && burst) {
            const pad = 'z'.repeat(200);
            const all = [];
            for (let i = 0; i < WRITES; i++) all.push(fx.call('update', 'UPDATE t0 SET data = ? WHERE id = ?', [pad + i, 1 + ((i * 7) % ROWS)]));
            await Promise.all(all);
            await new Promise((r) => setTimeout(r, IDLE_MS));
        }
        process.send({ ready: ok, loadMs: Math.round(loadMs || 0) }, () => {
            // No shutdown, no close: the WAL stays as the idle server left it.
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
        if (buf.readUInt32BE(off + 4 + 4) !== s1 || buf.readUInt32BE(off + 12) !== s2) break;
        if (buf.readUInt32BE(off) === 0) break;
        n++;
    }
    return n;
}

function boot(dir, mariaFile, burst) {
    return new Promise((res) => {
        const child = fork(__filename, ['--child'], {
            env: Object.assign({}, process.env, { FX_RES_DIR: dir, FX_MARIA_FILE: mariaFile, WAL_BURST: burst ? '1' : '0' }),
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-idlewal-'));
    const mariaFile = path.join(dir, 'maria.sqlite');
    const m = new DatabaseSync(mariaFile);
    m.exec('CREATE TABLE t0 (id INTEGER PRIMARY KEY AUTOINCREMENT, owner VARCHAR(64) NOT NULL, data TEXT, n INT NOT NULL)');
    const ins = m.prepare('INSERT INTO t0 (owner, data, n) VALUES (?, ?, ?)');
    m.exec('BEGIN');
    for (let i = 0; i < ROWS; i++) ins.run('license:' + i.toString(16), 'x'.repeat(120), i);
    m.exec('COMMIT');
    m.close();

    const wal = path.join(dir, 'cache', 'durable.sqlite-wal');
    const first = await boot(dir, mariaFile, true);
    check('the boot with a write burst is ready', first.ready, first.err);
    const frames = liveFrames(wal);
    check('a server killed after ' + IDLE_MS + ' ms idle leaves at most ' + WAL_LIVE + ' live WAL frames', first.ready && frames <= WAL_LIVE, frames + ' frames');

    const next = await boot(dir, mariaFile, false);
    check('the boot after it is ready', next.ready, next.err);

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
