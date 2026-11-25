'use strict';

// WAL preallocation (server.js, preallocWal): the WAL file is grown with
// zeros at boot, 4 MB per turn, so every commit's fdatasync overwrites
// blocks the file already has. First the SQLite behaviour that relies on, on
// plain node:sqlite connections; then the engine: the file is grown before
// the engine is ready, and every answered write is in it after the process
// dies without a shutdown.
// Usage: node tests/repro/wal_prealloc.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

const ZERO_MB = 40;

function grow(file, bytes) {
    const fd = fs.openSync(file, 'r+');
    const zero = Buffer.alloc(1 << 20);
    let off = fs.fstatSync(fd).size;
    while (off < bytes) off += fs.writeSync(fd, zero, 0, Math.min(zero.length, bytes - off), off);
    fs.closeSync(fd);
}

// A child writes, grows the WAL with zeros past its last frame, writes
// more, and dies with kill -9. Reopening must find every row and nothing
// else, and the frames written after the zeros went inside the file.
function sqliteSemantics() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-prealloc-'));
    const file = path.join(dir, 'a.sqlite');
    const child = "const { DatabaseSync } = require('node:sqlite'); const fs = require('fs');\n"
        + "const file = " + JSON.stringify(file) + ";\n"
        + "const db = new DatabaseSync(file);\n"
        + "db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0; PRAGMA journal_size_limit=104857600');\n"
        + "db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');\n"
        + "const ins = db.prepare('INSERT INTO t (v) VALUES (?)');\n"
        + "for (let i = 0; i < 100; i++) ins.run('a' + i);\n"
        + "(" + grow.toString() + ")(file + '-wal', " + ZERO_MB + " * 1048576);\n"
        + "const before = fs.statSync(file + '-wal').size;\n"
        + "for (let i = 0; i < 100; i++) ins.run('b' + i);\n"
        + "const ck = new DatabaseSync(file);\n"
        + "const r = ck.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();\n"
        + "for (let i = 0; i < 50; i++) ins.run('c' + i);\n"
        + "process.stdout.write('SIZES ' + JSON.stringify({ before, after: fs.statSync(file + '-wal').size, ckpt: r }) + '\\n');\n"
        + "process.kill(process.pid, 'SIGKILL');\n";
    const r = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8', timeout: 60000 });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('SIZES ')) || '';
    let sizes = {};
    try { sizes = JSON.parse(line.slice(6)); } catch (e) { /* stays empty */ }
    check('frames after the zeros overwrite them; the file does not grow', sizes.before === ZERO_MB * 1048576 && sizes.after === sizes.before, JSON.stringify(sizes) + (r.stderr ? ' ' + r.stderr.slice(-200) : ''));
    check('a write after a full copy starts the WAL over and keeps the file', sizes.ckpt && sizes.ckpt.checkpointed === sizes.ckpt.log && sizes.after === sizes.before, JSON.stringify(sizes.ckpt));
    const db = new DatabaseSync(file);
    const ic = db.prepare('PRAGMA integrity_check').get();
    const rows = db.prepare("SELECT COUNT(*) AS n, SUM(v LIKE 'a%') AS a, SUM(v LIKE 'b%') AS b, SUM(v LIKE 'c%') AS c FROM t").get();
    db.close();
    check('after kill -9 the file is intact', String(Object.values(ic)[0]) === 'ok', JSON.stringify(ic));
    check('and holds every row, and no row from the zeros', Number(rows.n) === 250 && Number(rows.a) === 100 && Number(rows.b) === 100 && Number(rows.c) === 50, JSON.stringify(rows));
}

function engine() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-prealloc-engine-'));
    const mariaFile = path.join(dir, 'maria.sqlite');
    const m = new DatabaseSync(mariaFile);
    m.exec('CREATE TABLE users (identifier VARCHAR(64) PRIMARY KEY, money INT NOT NULL); CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, seq INT, note TEXT)');
    const ins = m.prepare('INSERT INTO users VALUES (?, ?)');
    for (let i = 0; i < 200; i++) ins.run('id' + i, 0);
    m.close();
    const env = Object.assign({}, process.env, {
        FX_RES_DIR: dir,
        FX_MARIA_FILE: mariaFile,
        FX_CONVARS: JSON.stringify({ mysql_connection_string: 'mysql://root@127.0.0.1/fake', cis_database_cdc: '0' }),
    });
    // Answered writes, some from many callers at once, then SIGKILL: no
    // shutdown, no close, no final checkpoint.
    const child = "const fx = require(" + JSON.stringify(path.join(__dirname, '..', 'harness', 'fx.js')) + ");\n"
        + "const fs = require('fs'); const path = require('path');\n"
        + "const r = fx.registry;\n"
        + "(async () => {\n"
        + "if (!(await fx.ready(20000))) throw new Error('not ready');\n"
        + "const wal = path.join(" + JSON.stringify(dir) + ", 'cache', 'durable.sqlite-wal');\n"
        + "const boot = fs.statSync(wal).size;\n"
        + "for (let k = 0; k < 1500; k++) { await fx.call('update', 'UPDATE users SET money = money + 1 WHERE identifier = ?', ['id' + (k % 200)]); await fx.call('insert', 'INSERT INTO logs (seq, note) VALUES (?, ?)', [k, 's']); }\n"
        + "const burst = []; for (let k = 1500; k < 3000; k++) burst.push(fx.call('insert', 'INSERT INTO logs (seq, note) VALUES (?, ?)', [k, 'b']));\n"
        + "await Promise.all(burst);\n"
        + "const end = Date.now() + 5000; while (Date.now() < end && r.probe().wal_prealloc < " + (32 + 4120 * Math.ceil(8192 * 1.25)) + ") await new Promise((res) => setTimeout(res, 10));\n"
        + "process.stdout.write('STATE ' + JSON.stringify({ boot, now: fs.statSync(wal).size, probe: r.probe() }) + '\\n');\n"
        + "process.kill(process.pid, 'SIGKILL');\n"
        + "})().catch((e) => { console.log('ERR ' + e.message); process.exit(3); });\n";
    const r = spawnSync(process.execPath, ['-e', child], { env, encoding: 'utf8', timeout: 180000 });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('STATE ')) || '';
    let st = { probe: {} };
    try { st = JSON.parse(line.slice(6)); } catch (e) { /* stays empty */ }
    const p = st.probe || {};
    const want = 32 + 4120 * Math.ceil(8192 * 1.25);
    check('the WAL is grown before the engine is ready', st.boot === want && p.wal_prealloc === want, 'size at ready=' + st.boot + ' want=' + want + ' wal_prealloc=' + p.wal_prealloc + (line ? '' : ' ' + (r.stdout || '').slice(-300) + (r.stderr || '').slice(-300)));
    check('commits stay inside it', st.now === want, 'ready=' + st.boot + ' now=' + st.now);
    check('writes were answered after WAL syncs', p.ack === 'power' && p.fsync_n > 0 && p.fsync_errors === 0, 'fsync_n=' + p.fsync_n + ' avg=' + p.fsync_avg_ms + ' ms max=' + p.fsync_max_ms + ' ms');
    const db = new DatabaseSync(path.join(dir, 'cache', 'durable.sqlite'));
    const ic = db.prepare('PRAGMA integrity_check').get();
    const logs = db.prepare('SELECT COUNT(*) AS n, SUM(seq) AS s FROM logs').get();
    const money = db.prepare('SELECT SUM(money) AS s FROM users').get();
    db.close();
    check('the file is intact after kill -9', String(Object.values(ic)[0]) === 'ok', JSON.stringify(ic));
    check('every answered write is in it', Number(logs.n) === 3000 && Number(logs.s) === 3000 * 2999 / 2 && Number(money.s) === 1500,
        'logs=' + logs.n + ' sum=' + logs.s + ' money=' + money.s);
}

sqliteSemantics();
engine();
const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
