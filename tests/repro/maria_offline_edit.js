'use strict';

// MariaDB edited while the server is stopped: an admin fixes a row in
// HeidiSQL, a web panel adds one, or the owner ran oxmysql for a while and
// came back (README "Going back to oxmysql"). The next boot must answer
// MariaDB's rows, not the ones its cache/ held at the last stop.
//
// Usage: node tests/repro/maria_offline_edit.js
//   FX_TRUST_MARIA (default mysql://root@127.0.0.1:3307) is a real MariaDB;
//   without one it prints SKIP. Database cm_offline is dropped and made again.
//   With FX_MARIA_BIN and FX_MARIA_INI (see maria_kill.js) it also stops
//   mariadbd for a boot and starts it again.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { fork } = require('child_process');

const URL_ = process.env.FX_TRUST_MARIA || 'mysql://root@127.0.0.1:3307';
const DB = 'cm_offline';

if (process.argv[2] === '--child') {
    const fx = require('../harness/fx.js');
    const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v, (k, x) => (typeof x === 'bigint' ? x.toString() : x)));
    fx.ready(120000).then((ok) => process.send({ ready: ok }));
    process.on('message', (m) => {
        fx.registry[m.kind](m.sql, m.params || [], (v, e) => {
            process.send({ id: m.id, v: e != null ? undefined : plain(v), err: e != null ? String(e) : undefined });
        }, 'test', true);
    });
    return;
}

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
async function q(sql, params) {
    const c = await mysql.createConnection({ uri: URL_ + '/' + DB });
    try { return (await c.query(sql, params))[0]; } finally { await c.end().catch(() => {}); }
}

function engine(dir, extra) {
    const child = fork(__filename, ['--child'], {
        env: Object.assign({}, process.env, {
            FX_RES_DIR: dir,
            FX_REAL_MARIA: '1',
            FX_CONVARS: JSON.stringify(Object.assign({ mysql_connection_string: URL_ + '/' + DB, cis_database_cdc: '1' }, extra || {})),
        }),
        stdio: ['ignore', process.env.OFFLINE_TRACE ? 'inherit' : 'ignore', 'inherit', 'ipc'],
    });
    const waiting = new Map();
    let n = 0;
    const e = {};
    e.readyP = new Promise((res) => child.on('message', (m) => {
        if ('ready' in m) { res(m.ready); return; }
        const w = waiting.get(m.id);
        if (w) { waiting.delete(m.id); w(m); }
    }));
    e.call = (kind, sql, params) => new Promise((res) => { const id = ++n; waiting.set(id, res); child.send({ id, kind, sql, params }); });
    e.stop = () => new Promise((res) => { child.once('exit', res); child.kill(); });
    return e;
}

async function untilMaria(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await sleep(100); }
    return false;
}

async function round(backend) {
    const root = await mysql.createConnection(URL_ + '?multipleStatements=true');
    await root.query('DROP DATABASE IF EXISTS ' + DB + '; CREATE DATABASE ' + DB + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci; USE ' + DB);
    await root.query('CREATE TABLE off_players (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(40) NOT NULL, cash INT NOT NULL)');
    await root.query("INSERT INTO off_players (name, cash) VALUES ('ann', 100), ('bob', 200), ('cid', 300)");
    // A table the engine writes before the stop, then MariaDB edits.
    await root.query('CREATE TABLE off_log (id INT AUTO_INCREMENT PRIMARY KEY, msg VARCHAR(40) NOT NULL)');
    await root.end();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-offline-'));
    const extra = {};
    process.env.FX_BACKEND = backend === 'sqljs' ? 'sql.js' : '';
    const tag = backend + ': ';

    let e = engine(dir, extra);
    check(tag + 'first boot ready', await e.readyP);
    let r = await e.call('update', 'UPDATE off_players SET cash = cash + 1 WHERE name = ?', ['ann']);
    check(tag + 'engine update answered', r.err === undefined && r.v === 1, JSON.stringify(r));
    r = await e.call('insert', 'INSERT INTO off_log (msg) VALUES (?)', ['engine']);
    check(tag + 'engine insert answered', r.err === undefined && r.v === 1, JSON.stringify(r));
    check(tag + 'engine writes reached MariaDB', await untilMaria(async () => {
        const a = await q("SELECT cash FROM off_players WHERE name = 'ann'");
        const b = await q('SELECT COUNT(*) AS n FROM off_log');
        return a[0].cash === 101 && Number(b[0].n) === 1;
    }, 15000));
    await sleep(500);
    await e.stop();

    // Edits made in MariaDB while no engine runs.
    await q("UPDATE off_players SET cash = 999 WHERE name = 'bob'");
    await q("DELETE FROM off_players WHERE name = 'cid'");
    await q("INSERT INTO off_players (name, cash) VALUES ('dee', 400)");
    await q("INSERT INTO off_log (msg) VALUES ('panel')");

    e = engine(dir, extra);
    check(tag + 'second boot ready', await e.readyP);
    const want = await q('SELECT id, name, cash FROM off_players ORDER BY id');
    r = await e.call('query', 'SELECT id, name, cash FROM off_players ORDER BY id', []);
    check(tag + 'players after offline edits match MariaDB', r.err === undefined && JSON.stringify(r.v) === JSON.stringify(want),
        'engine ' + JSON.stringify(r.v) + '\n   maria  ' + JSON.stringify(want));
    const wantLog = await q('SELECT id, msg FROM off_log ORDER BY id');
    r = await e.call('query', 'SELECT id, msg FROM off_log ORDER BY id', []);
    check(tag + 'log after offline insert matches MariaDB', r.err === undefined && JSON.stringify(r.v) === JSON.stringify(wantLog),
        'engine ' + JSON.stringify(r.v) + '\n   maria  ' + JSON.stringify(wantLog));
    // A write after the boot lands once, with the id MariaDB would give.
    r = await e.call('insert', 'INSERT INTO off_log (msg) VALUES (?)', ['after']);
    check(tag + 'insert after boot answered', r.err === undefined && r.v > 0, JSON.stringify(r));
    const newId = r.v;
    check(tag + 'insert after boot reached MariaDB with its id', await untilMaria(async () => {
        const x = await q("SELECT id FROM off_log WHERE msg = 'after'");
        return x.length === 1 && x[0].id === newId;
    }, 15000), 'engine id ' + newId + ', maria ' + JSON.stringify(await q("SELECT id FROM off_log WHERE msg = 'after'")));
    await e.stop();

    // node:sqlite only (sql.js waits for MariaDB at boot): MariaDB edited
    // while stopped, then down at the next boot. The engine starts from its
    // file and takes a write; once MariaDB is back, CDC copies each table
    // (cdcRecheck) after the write is in, so reads converge on MariaDB.
    if (backend === 'node' && BIN && INI) {
        await q("UPDATE off_players SET cash = 555 WHERE name = 'bob'");
        killMaria();
        check(tag + 'mariadbd stopped', await waitDown());
        e = engine(dir, Object.assign({ cis_database_cdc: '1', cis_database_cdc_ms: '200', cis_database_debug: process.env.OFFLINE_TRACE ? '1' : '0' }, extra));
        check(tag + 'boot with MariaDB down ready', await e.readyP);
        r = await e.call('insert', 'INSERT INTO off_log (msg) VALUES (?)', ['down']);
        check(tag + 'insert with MariaDB down answered', r.err === undefined && r.v > 0, JSON.stringify(r));
        check(tag + 'mariadbd started again', await startMaria());
        // CDC waits for 2 s with no query (txBusy), so this asks every 3 s.
        const same = async () => {
            await sleep(3000);
            const a = await e.call('query', 'SELECT id, name, cash FROM off_players ORDER BY id', []);
            const b = await e.call('query', 'SELECT id, msg FROM off_log ORDER BY id', []);
            const ma = await q('SELECT id, name, cash FROM off_players ORDER BY id');
            const mb = await q('SELECT id, msg FROM off_log ORDER BY id');
            return JSON.stringify(a.v) === JSON.stringify(ma) && JSON.stringify(b.v) === JSON.stringify(mb)
                && mb.some((x) => x.msg === 'down') && ma.some((x) => x.cash === 555);
        };
        check(tag + 'reads converge on MariaDB after it is back', await untilMaria(same, 30000),
            'engine ' + JSON.stringify((await e.call('query', 'SELECT id, name, cash FROM off_players ORDER BY id', [])).v)
            + '\n   maria  ' + JSON.stringify(await q('SELECT id, name, cash FROM off_players ORDER BY id')));
        await e.stop();
    }
    fs.rmSync(dir, { recursive: true, force: true });
}

const { spawn } = require('child_process');
const BIN = process.env.FX_MARIA_BIN;
const INI = process.env.FX_MARIA_INI;
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
    const log = fs.openSync(path.join(shared, 'cis-offline-mariadbd.log'), 'a');
    spawn(BIN, ['--defaults-file=' + INI, '--console'], { detached: true, stdio: ['ignore', log, log], env: Object.assign({}, process.env, { TMP: shared, TEMP: shared, TMPDIR: shared }) }).unref();
    for (let i = 0; i < 600; i++) {
        try { await q('SELECT 1'); return true; } catch (e) { await sleep(100); }
    }
    return false;
}

(async () => {
    if (!(await reachable())) { console.log('SKIP no MariaDB at ' + URL_); process.exit(0); }
    await round('node');
    await round('sqljs');
    const root = await mysql.createConnection(URL_);
    await root.query('DROP DATABASE IF EXISTS ' + DB);
    await root.end();
    if (failed) { console.log('FAIL maria_offline_edit: ' + failed + ' of ' + checks); process.exit(1); }
    console.log('PASS maria_offline_edit: ' + checks + ' checks');
})().catch((e) => { console.log('FAIL maria_offline_edit: ' + (e && e.stack)); process.exit(1); });
