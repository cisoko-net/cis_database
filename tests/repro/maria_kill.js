'use strict';

// The real MariaDB server process is killed and started again while the
// engine runs. maria_outage.js does the same through a TCP proxy; this one
// stops mariadbd itself, so InnoDB recovery, a commit cut by the kill and the
// pool reconnecting to a new server are all real.
//
//   killed mid-run: numbered inserts and an ON DUPLICATE KEY UPDATE counter
//     keep answering; after the restart MariaDB holds every row once, with the
//     ids the engine gave, and the counter equals the number of writes.
//   killed mid-query: a read only MariaDB answers fails with the reason, no
//     value.
//   boot with mariadbd stopped: the engine starts from its SQLite file (sql.js
//     waits for MariaDB instead), takes writes, a read only MariaDB answers
//     fails with the reason, and once mariadbd is back every write is in it
//     once.
//   slow: a table locked by another connection holds a routed read past
//     cis_database_maria_read_ms; it fails with the reason, then answers
//     MariaDB's value once unlocked.
//
// Usage: node tests/repro/maria_kill.js
//   FX_MARIA_BIN (mariadbd executable) and FX_MARIA_INI (its --defaults-file)
//   start the server; without both it prints SKIP. FX_TRUST_MARIA (default
//   mysql://root@127.0.0.1:3307) is that server; database cm_kill is dropped
//   and made again. The server is left running at the end.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { fork, spawn } = require('child_process');

const URL_ = process.env.FX_TRUST_MARIA || 'mysql://root@127.0.0.1:3307';
const DB = 'cm_kill';
const BIN = process.env.FX_MARIA_BIN;
const INI = process.env.FX_MARIA_INI;

// ---- Child: one engine, driven over IPC ----------------------------------
if (process.argv[2] === '--child') {
    const fx = require('../harness/fx.js');
    const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v, (k, x) => (typeof x === 'bigint' ? x.toString() : x)));
    fx.ready(600000).then((ok) => process.send({ ready: ok }));
    process.on('message', (m) => {
        if (m.op === 'probe') { process.send({ id: m.id, v: fx.registry.probe ? fx.registry.probe() : null }); return; }
        fx.registry[m.kind](m.sql, m.params || [], (v, e) => {
            process.send({ id: m.id, v: e != null ? undefined : plain(v), err: e != null ? String(e) : undefined });
        }, 'test', true);
    });
    return;
}

// ---- Parent ---------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const U = new URL(URL_);

function reachable() {
    return new Promise((res) => {
        const s = net.connect(Number(U.port || 3306), U.hostname, () => { s.destroy(); res(true); });
        s.setTimeout(1500);
        s.on('error', () => res(false));
        s.on('timeout', () => { s.destroy(); res(false); });
    });
}

let failed = 0;
let checks = 0;
function check(name, ok, detail) {
    checks++;
    if (ok) return;
    failed++;
    console.log('FAIL ' + name + (detail ? '\n   ' + detail : ''));
}

const mysql = require('mysql2/promise');
// A new connection per call: the server under test dies between calls.
async function q(sql, params) {
    const c = await mysql.createConnection({ uri: URL_ + '/' + DB, supportBigNumbers: true, bigNumberStrings: true });
    try { return (await c.query(sql, params))[0]; } finally { await c.end().catch(() => {}); }
}

// By PID, on the test port only (tests/harness/maria_pid.js).
function killMaria() {
    require('../harness/maria_pid').killListening(URL_);
}
async function waitDown() {
    for (let i = 0; i < 100; i++) { if (!(await reachable())) return true; await sleep(100); }
    return false;
}
async function startMaria() {
    // mariadbd outlives this check: it keeps the run's shared temp directory,
    // not the one tests/run.js removes when the check exits.
    const shared = process.env.CIS_SHARED_TMP || os.tmpdir();
    const log = fs.openSync(path.join(shared, 'cis-kill-mariadbd.log'), 'a');
    spawn(BIN, ['--defaults-file=' + INI, '--console'], { detached: true, stdio: ['ignore', log, log], env: Object.assign({}, process.env, { TMP: shared, TEMP: shared, TMPDIR: shared }) }).unref();
    // No database in the URL: on the first start cm_kill does not exist yet.
    for (let i = 0; i < 600; i++) {
        try { const c = await mysql.createConnection(URL_); await c.end(); return true; } catch (e) { await sleep(100); }
    }
    return false;
}

function engine(dir, extra) {
    const child = fork(__filename, ['--child'], {
        env: Object.assign({}, process.env, {
            FX_RES_DIR: dir,
            FX_REAL_MARIA: '1',
            FX_CONVARS: JSON.stringify(Object.assign({ mysql_connection_string: URL_ + '/' + DB, cis_database_cdc: '0' }, extra || {})),
        }),
        stdio: ['ignore', process.env.KILL_TRACE ? 'inherit' : 'ignore', 'inherit', 'ipc'],
    });
    const waiting = new Map();
    let n = 0;
    const e = { isReady: false };
    e.readyP = new Promise((res) => child.on('message', (m) => {
        if ('ready' in m) { e.isReady = m.ready; res(m.ready); return; }
        const w = waiting.get(m.id);
        if (w) { waiting.delete(m.id); w(m); }
    }));
    e.call = (kind, sql, params) => new Promise((res) => { const id = ++n; waiting.set(id, res); child.send({ id, kind, sql, params }); });
    e.stop = () => new Promise((res) => { child.once('exit', res); child.kill(); });
    return e;
}

(async () => {
    if (!BIN || !INI) { console.log('SKIP FX_MARIA_BIN and FX_MARIA_INI not set'); process.exit(0); }
    if (!(await reachable()) && !(await startMaria())) { console.log('SKIP mariadbd does not start'); process.exit(0); }
    const root = await mysql.createConnection(URL_ + '?multipleStatements=true');
    await root.query('DROP DATABASE IF EXISTS ' + DB + '; CREATE DATABASE ' + DB + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci; USE ' + DB);
    // No unique key on seq, so a write copied twice shows as a second row.
    await root.query('CREATE TABLE kill_rows (id INT AUTO_INCREMENT PRIMARY KEY, tag VARCHAR(20) NOT NULL, seq INT NOT NULL, amount DECIMAL(10,2) NOT NULL)');
    await root.query('CREATE TABLE kill_totals (tag VARCHAR(20) PRIMARY KEY, hits INT NOT NULL DEFAULT 0)');
    await root.end();

    const ids = new Map(); // tag -> engine insert ids
    const counts = new Map(); // tag -> writes answered
    const write = async (e, tag, seq) => {
        const amount = ((seq % 97) + 0.25).toFixed(2);
        const r = await e.call('insert', 'INSERT INTO kill_rows (tag, seq, amount) VALUES (?, ?, ?)', [tag, seq, amount]);
        check(tag + ': insert ' + seq + ' answered', r.err === undefined && r.v > 0, JSON.stringify(r));
        if (!ids.has(tag)) ids.set(tag, []);
        ids.get(tag).push(r.v);
        const t = await e.call('update', 'INSERT INTO kill_totals (tag, hits) VALUES (?, 1) ON DUPLICATE KEY UPDATE hits = hits + 1', [tag]);
        check(tag + ': counter ' + seq + ' answered', t.err === undefined && t.v >= 1, JSON.stringify(t));
        counts.set(tag, (counts.get(tag) || 0) + 1);
    };
    // Waits for MariaDB to hold each of the tag's writes exactly once.
    const converged = async (tag, ms) => {
        const n = counts.get(tag);
        const want = JSON.stringify({ rows: n, seqs: n, sum: String(n * (n + 1) / 2), hits: n, ids: ids.get(tag).slice().sort((a, b) => a - b) });
        const end = Date.now() + (ms || 120000);
        let got;
        while (Date.now() < end) {
            try {
                const [r] = await q('SELECT COUNT(*) AS rows_, COUNT(DISTINCT seq) AS seqs, SUM(seq) AS s FROM kill_rows WHERE tag = ?', [tag]);
                const h = await q('SELECT hits FROM kill_totals WHERE tag = ?', [tag]);
                const idRows = await q('SELECT id FROM kill_rows WHERE tag = ? ORDER BY id', [tag]);
                got = JSON.stringify({ rows: Number(r.rows_), seqs: Number(r.seqs), sum: String(r.s), hits: h.length ? h[0].hits : 0, ids: idRows.map((x) => x.id) });
                if (got === want) return true;
            } catch (e) { got = String(e); }
            await sleep(250);
        }
        check(tag + ': MariaDB holds every write once, with the engine\'s ids', false, 'got  ' + got + '\n   want ' + want);
        return false;
    };
    const SUM = "SELECT SUM(amount) AS v FROM kill_rows WHERE tag = 'seed'";
    const routedFails = (label, r) => {
        check(label + ': a read only MariaDB answers fails, no value', r.err !== undefined && r.v === undefined, JSON.stringify(r));
        check(label + ': the error names the reason', /answered by MariaDB \(.+\) and MariaDB failed/.test(r.err || ''), r.err);
    };

    // 1. Killed mid-run.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-kill-'));
    let e = engine(dir);
    check('boot with MariaDB up is ready', await e.readyP);
    await write(e, 'seed', 1);
    await converged('seed');
    const N1 = 600;
    let killedAt = 0;
    for (let seq = 1; seq <= N1; seq++) {
        await write(e, 'run', seq);
        if (seq === 150) { killMaria(); killedAt = seq; }
        if (seq % 20 === 0) await sleep(5);
    }
    check('mid-run: mariadbd went down', await waitDown());
    routedFails('mid-run, down', await e.call('scalar', SUM, []));
    check('mid-run: mariadbd starts again', await startMaria());
    await converged('run');

    // 2. Killed mid-query.
    const slow = e.call('query', "SELECT SLEEP(5) AS z, SUM(amount) AS v FROM kill_rows WHERE tag = 'seed'", []);
    await sleep(800);
    killMaria();
    routedFails('mid-query kill', await slow);
    check('mid-query: mariadbd starts again', await startMaria());
    for (let seq = 1; seq <= 50; seq++) await write(e, 'after', seq);
    await converged('after');
    const s2 = await e.call('scalar', SUM, []);
    check('after restart: the routed read is MariaDB\'s', s2.v === (await q(SUM))[0].v, JSON.stringify(s2));
    await e.stop();

    // 3. Boot with mariadbd stopped, SQLite file present.
    killMaria();
    check('boot down: mariadbd is down', await waitDown());
    e = engine(dir);
    if (process.env.FX_BACKEND === 'sql.js') {
        // sql.js holds the database in memory; its old snapshot lacks recent
        // writes, so it waits for MariaDB.
        let early = null;
        const held = e.call('scalar', "SELECT COUNT(*) FROM kill_rows WHERE tag = 'run'", []).then((r) => { early = r; return r; });
        await sleep(3000);
        check('boot down, in memory: not ready on the old snapshot', !e.isReady);
        check('boot down, in memory: a call is held', early === null, JSON.stringify(early));
        check('boot down, in memory: mariadbd starts', await startMaria());
        check('boot down, in memory: ready once MariaDB answers', await e.readyP);
        const r0 = await held;
        check('boot down, in memory: the held call answers MariaDB\'s count', r0.v === N1, JSON.stringify(r0));
        killMaria();
        check('boot down, in memory: mariadbd down again', await waitDown());
    }
    check('boot down: starts from the SQLite file', await e.readyP);
    for (let seq = 1; seq <= 200; seq++) await write(e, 'boot', seq);
    const c3 = await e.call('scalar', "SELECT COUNT(*) FROM kill_rows WHERE tag = 'boot'", []);
    check('boot down: a read SQLite answers as MariaDB does still answers', c3.v === 200, JSON.stringify(c3));
    routedFails('boot down', await e.call('scalar', SUM, []));
    check('boot down: mariadbd starts', await startMaria());
    await converged('boot');
    for (const tag of ['seed', 'run', 'after']) await converged(tag, 5000);
    await e.stop();

    // 4. Slow: another connection holds a write lock on the table.
    e = engine(dir, { cis_database_maria_read_ms: '1500' });
    check('restart is ready', await e.readyP);
    const locker = await mysql.createConnection(URL_ + '/' + DB);
    await locker.query('LOCK TABLES kill_rows WRITE');
    const t0 = Date.now();
    const r4 = await e.call('scalar', SUM, []);
    const took = Date.now() - t0;
    routedFails('locked table', r4);
    check('locked table: it fails within the read limit', took < 15000, took + ' ms');
    await locker.query('UNLOCK TABLES');
    await locker.end();
    for (let seq = 1; seq <= 20; seq++) await write(e, 'unlocked', seq);
    await converged('unlocked');
    const s4 = await e.call('scalar', SUM, []);
    check('unlocked: the routed read is MariaDB\'s', s4.v === (await q(SUM))[0].v, JSON.stringify(s4));
    await e.stop();

    await q('DROP DATABASE IF EXISTS ' + DB);
    let writes = 0;
    for (const v of counts.values()) writes += v;
    if (failed) { console.log(failed + ' of ' + checks + ' failed'); process.exit(1); }
    console.log('all passed (' + checks + ' checks, ' + writes + ' writes, mariadbd killed ' + (process.env.FX_BACKEND === 'sql.js' ? 4 : 3) + ' times, first at write ' + killedAt + ', ' + (process.env.FX_BACKEND || 'node:sqlite') + ')');
    process.exit(0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack)); process.exit(1); });
