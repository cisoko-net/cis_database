'use strict';

// WAL checkpoints with the syncs off the server thread (server.js, "one
// checkpoint cycle"). First the SQLite behaviour the cycle relies on, on
// plain node:sqlite connections; then the engine: a cycle runs, the main
// connection keeps writing during it, and every write is in the file after
// the process dies without a shutdown.
// Usage: node tests/repro/ckpt_split.js

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

function conns(file) {
    const main = new DatabaseSync(file);
    main.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0');
    main.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
    main.exec("INSERT OR IGNORE INTO meta VALUES ('epoch', 'x')");
    const ck = new DatabaseSync(file);
    ck.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=OFF');
    const pin = new DatabaseSync(file);
    pin.exec('PRAGMA busy_timeout=0');
    const ins = main.prepare('INSERT INTO t (v) VALUES (?)');
    const write = (n) => { for (let i = 0; i < n; i++) ins.run('row' + i); };
    const ckpt = () => ck.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    return { main, ck, pin, write, ckpt };
}

function sqliteSemantics() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-ckpt-'));
    const c = conns(path.join(dir, 'a.sqlite'));
    c.write(100);
    // Pin, write more, checkpoint: only the frames from before the pin move.
    c.pin.exec('BEGIN');
    c.pin.prepare('SELECT COUNT(*) FROM meta').get();
    c.write(50);
    const r1 = c.ckpt();
    check('a pinned read stops the checkpoint at the frames before it', r1.checkpointed > 0 && r1.checkpointed < r1.log, JSON.stringify(r1));
    // While pinned, a write after a full copy appends instead of starting over.
    const before = r1.log;
    c.write(1);
    const r2 = c.ckpt();
    check('the WAL is not started over while pinned', r2.log > before, 'log ' + before + ' -> ' + r2.log);
    c.pin.exec('COMMIT');
    const r3 = c.ckpt();
    check('after the pin ends every frame is copied', r3.checkpointed === r3.log, JSON.stringify(r3));
    c.write(1);
    const r4 = c.ckpt();
    check('and the next write starts the WAL over', r4.log < r3.log, 'log ' + r3.log + ' -> ' + r4.log);

    // A pin that starts after every frame was copied takes read-mark 0. It
    // does not hold a frame number, but it blocks every checkpoint until it
    // ends, so a cycle that pins then copies nothing, unsynced frames included.
    c.pin.exec('BEGIN');
    c.pin.prepare('SELECT COUNT(*) FROM meta').get();
    c.write(20);
    const r5 = c.ckpt();
    c.pin.exec('COMMIT');
    check('a pin on a fully copied WAL blocks the copy entirely', r5.checkpointed === 0 && r5.log > 0, JSON.stringify(r5));
    const r6 = c.ckpt();
    check('and the frames are copied once it ends', r6.checkpointed === r6.log, JSON.stringify(r6));
    c.pin.close();
    c.ck.close();
    c.main.close();
}

function engine() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-ckpt-eng-'));
    const mariaFile = path.join(dir, 'maria.sqlite');
    const m = new DatabaseSync(mariaFile);
    m.exec('CREATE TABLE users (identifier VARCHAR(64) PRIMARY KEY, money INT NOT NULL); CREATE TABLE logs (seq INT, note VARCHAR(16))');
    const ins = m.prepare('INSERT INTO users VALUES (?, ?)');
    for (let i = 0; i < 200; i++) ins.run('id' + i, 0);
    m.close();
    const env = Object.assign({}, process.env, {
        FX_RES_DIR: dir,
        FX_MARIA_FILE: mariaFile,
        FX_CONVARS: JSON.stringify({ mysql_connection_string: 'mysql://root@127.0.0.1/fake', cis_database_cdc: '0' }),
    });
    // Writes in waves; between waves the cycles started by the previous one
    // run while the next wave is already writing. Ends with SIGKILL: no
    // shutdown, no close, no final checkpoint.
    const child = "const fx = require(" + JSON.stringify(path.join(__dirname, '..', 'harness', 'fx.js')) + ");\n"
        + "const r = fx.registry;\n"
        + "const sleep = (ms) => new Promise((res) => setTimeout(res, ms));\n"
        + "(async () => {\n"
        + "if (!(await fx.ready(20000))) throw new Error('not ready');\n"
        + "for (let w = 0; w < 8; w++) {\n"
        + "  for (let i = 0; i < 300; i++) { const k = w * 300 + i; await fx.call('update', 'UPDATE users SET money = money + 1 WHERE identifier = ?', ['id' + (k % 200)]); await fx.call('insert', 'INSERT INTO logs (seq, note) VALUES (?, ?)', [k, 'w' + w]); }\n"
        + "  await sleep(80);\n"
        + "}\n"
        + "const end = Date.now() + 5000; while (Date.now() < end && r.probe().ckpt_n < 3) await sleep(20);\n"
        + "process.stdout.write('PROBE ' + JSON.stringify(r.probe()) + '\\n');\n"
        + "process.kill(process.pid, 'SIGKILL');\n"
        + "})().catch((e) => { console.log('ERR ' + e.message); process.exit(3); });\n";
    const r = spawnSync(process.execPath, ['-e', child], { env, encoding: 'utf8', timeout: 120000 });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('PROBE ')) || '';
    let probe = {};
    try { probe = JSON.parse(line.slice(6)); } catch (e) { /* stays empty */ }
    check('the engine checkpoints with the split cycle', probe.ckpt === 'split' && probe.ckpt_n >= 3, 'ckpt=' + probe.ckpt + ' n=' + probe.ckpt_n + ' copy_max=' + probe.ckpt_copy_max_ms + ' ms');
    const db = new DatabaseSync(path.join(dir, 'cache', 'durable.sqlite'));
    const ic = db.prepare('PRAGMA integrity_check').get();
    const logs = db.prepare('SELECT COUNT(*) AS n, SUM(seq) AS s FROM logs').get();
    const money = db.prepare('SELECT SUM(money) AS s FROM users').get();
    db.close();
    const n = 2400;
    check('the file is intact after kill -9', String(Object.values(ic)[0]) === 'ok', JSON.stringify(ic));
    check('every write is in it', Number(logs.n) === n && Number(logs.s) === n * (n - 1) / 2 && Number(money.s) === n,
        'logs=' + logs.n + ' sum=' + logs.s + ' money=' + money.s);
}

// Steady writes with no pause: a cycle copies up to its pin while writes
// append, so without the quiesced restart the WAL is never started over and
// grows without bound (about 13 KB a write here: 400 MB for 30000).
function steadyWrites() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-ckpt-wal-'));
    const mariaFile = path.join(dir, 'maria.sqlite');
    const m = new DatabaseSync(mariaFile);
    m.exec('CREATE TABLE users (identifier VARCHAR(64) PRIMARY KEY, money INT NOT NULL, meta TEXT)');
    const ins = m.prepare('INSERT INTO users VALUES (?, ?, ?)');
    for (let i = 0; i < 2000; i++) ins.run('id' + i, i, 'x'.repeat(300));
    m.close();
    const env = Object.assign({}, process.env, {
        FX_RES_DIR: dir,
        FX_MARIA_FILE: mariaFile,
        // Writes answered at commit: this is about the WAL restart, and 30000
        // sequential writes each waiting for a sync take minutes on Windows.
        FX_CONVARS: JSON.stringify({ mysql_connection_string: 'mysql://root@127.0.0.1/fake', cis_database_cdc: '0', cis_database_ack: 'process' }),
    });
    const child = "const fx = require(" + JSON.stringify(path.join(__dirname, '..', 'harness', 'fx.js')) + ");\n"
        + "const fs = require('fs');\n"
        + "(async () => {\n"
        + "if (!(await fx.ready(20000))) throw new Error('not ready');\n"
        + "let maxWal = 0;\n"
        + "const wal = " + JSON.stringify(path.join(dir, 'cache', 'durable.sqlite-wal')) + ";\n"
        + "for (let n = 0; n < 30000; n++) {\n"
        + "  await fx.call('update', 'UPDATE users SET money = ?, meta = ? WHERE identifier = ?', [n, 'y'.repeat(300) + n, 'id' + (n % 2000)]);\n"
        + "  if (n % 1000 === 0) maxWal = Math.max(maxWal, fs.statSync(wal).size);\n"
        + "}\n"
        + "const p = fx.registry.probe();\n"
        + "const db = new (require('node:sqlite').DatabaseSync)(" + JSON.stringify(path.join(dir, 'cache', 'durable.sqlite')) + ");\n"
        + "const sum = db.prepare('SELECT SUM(money) AS s FROM users').get().s;\n"
        + "process.stdout.write('WAL ' + JSON.stringify({ maxWal, restarts: p.wal_restarts, frames: p.wal_frames, sum: Number(sum) }) + '\\n');\n"
        + "process.exit(0);\n"
        + "})().catch((e) => { console.log('ERR ' + e.message); process.exit(3); });\n";
    const r = spawnSync(process.execPath, ['-e', child], { env, encoding: 'utf8', timeout: 300000 });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('WAL ')) || '';
    let w = {};
    try { w = JSON.parse(line.slice(4)); } catch (e) { /* stays empty */ }
    check('steady writes start the WAL over (quiesced restart)', w.restarts >= 1, 'restarts=' + w.restarts);
    check('and the WAL stays bounded', w.maxWal > 0 && w.maxWal < 100 * 1048576, 'largest ' + (w.maxWal / 1048576).toFixed(1) + ' MB');
    // The last write to each of the 2000 rows sets money to its n.
    const want = Array.from({ length: 2000 }, (_, i) => 28000 + i).reduce((a, b) => a + b, 0);
    check('every write is there', w.sum === want, 'sum=' + w.sum + ' want=' + want);
}

sqliteSemantics();
engine();
steadyWrites();
const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
