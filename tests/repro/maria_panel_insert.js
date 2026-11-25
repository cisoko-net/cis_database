'use strict';

// An INSERT made straight in MariaDB (a web panel, HeidiSQL) while the server
// is busy. CDC waits for 2 s with no query, so on a busy server it never
// copies the panel row. The next game insert into that table takes the same
// AUTO_INCREMENT id in SQLite; its copy to MariaDB then hits a duplicate key.
// Both writes must end up in MariaDB, and the game must read what MariaDB has.
// The fix keeps MariaDB's counter far above SQLite's (reserveIds) and forces
// a CDC scan every cis_database_cdc_force_ms. With the reserve off, the
// duplicate must be a warning in the log, not a quiet "already applied".
//
// Usage: node tests/repro/maria_panel_insert.js
//   FX_TRUST_MARIA (default mysql://root@127.0.0.1:3307) is a real MariaDB;
//   without one it prints SKIP. Database cm_panel is dropped and made again.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { fork } = require('child_process');

const URL_ = process.env.FX_TRUST_MARIA || 'mysql://root@127.0.0.1:3307';
const DB = 'cm_panel';

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
            FX_BACKEND: '',
            FX_CONVARS: JSON.stringify(Object.assign({
                mysql_connection_string: URL_ + '/' + DB, cis_database_cdc: '1', cis_database_cdc_ms: '200', cis_database_cdc_force_ms: '2000',
            }, extra || {})),
        }),
        stdio: ['ignore', process.env.PANEL_TRACE ? 'inherit' : 'ignore', 'pipe', 'ipc'],
    });
    const e = { err: '' };
    child.stderr.on('data', (d) => { e.err += d; if (process.env.PANEL_TRACE) process.stderr.write(d); });
    const waiting = new Map();
    let n = 0;
    e.readyP = new Promise((res) => child.on('message', (m) => {
        if ('ready' in m) { res(m.ready); return; }
        const w = waiting.get(m.id);
        if (w) { waiting.delete(m.id); w(m); }
    }));
    e.call = (kind, sql, params) => new Promise((res) => { const id = ++n; waiting.set(id, res); child.send({ id, kind, sql, params }); });
    e.stop = () => new Promise((res) => { child.once('exit', res); child.kill(); });
    return e;
}

async function untilTrue(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await sleep(200); }
    return false;
}

(async () => {
    if (!(await reachable())) { console.log('SKIP no MariaDB at ' + URL_); process.exit(0); }
    const root = await mysql.createConnection(URL_ + '?multipleStatements=true');
    await root.query('DROP DATABASE IF EXISTS ' + DB + '; CREATE DATABASE ' + DB + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci; USE ' + DB);
    await root.query('CREATE TABLE pan_items (id INT AUTO_INCREMENT PRIMARY KEY, owner VARCHAR(40) NOT NULL, item VARCHAR(40) NOT NULL)');
    await root.query("INSERT INTO pan_items (owner, item) VALUES ('ann', 'phone')");
    await root.end();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-panel-'));
    const e = engine(dir);
    check('boot ready', await e.readyP);

    // A busy server: a read every 100 ms, so CDC never sees 2 s with no query.
    let busy = true;
    const load = (async () => { while (busy) { await e.call('query', 'SELECT id FROM pan_items WHERE owner = ?', ['ann']); await sleep(100); } })();

    const aiOf = async () => Number(((await q("SELECT auto_increment AS a FROM information_schema.tables WHERE table_schema = ? AND table_name = 'pan_items'", [DB]))[0] || {}).a) || 0;
    check('MariaDB AUTO_INCREMENT is raised above SQLite after boot', await untilTrue(async () => (await aiOf()) > 1000, 10000), 'ai ' + (await aiOf()));
    await sleep(1000);
    await q("INSERT INTO pan_items (owner, item) VALUES ('panel', 'gift')");
    await sleep(1500);
    const r = await e.call('insert', 'INSERT INTO pan_items (owner, item) VALUES (?, ?)', ['bob', 'radio']);
    check('game insert answered', r.err === undefined && r.v > 0, JSON.stringify(r));
    const gameId = r.v;

    const both = async () => {
        const rows = await q('SELECT id, owner, item FROM pan_items ORDER BY id');
        return rows.some((x) => x.owner === 'panel') && rows.some((x) => x.owner === 'bob' && x.id === gameId);
    };
    check('MariaDB holds the panel row and the game row, with the id the game was given', await untilTrue(both, 10000),
        'game id ' + gameId + ', maria ' + JSON.stringify(await q('SELECT id, owner, item FROM pan_items ORDER BY id')));

    const same = async () => {
        const a = await e.call('query', 'SELECT id, owner, item FROM pan_items ORDER BY id', []);
        const m = await q('SELECT id, owner, item FROM pan_items ORDER BY id');
        return JSON.stringify(a.v) === JSON.stringify(m);
    };
    check('the game reads what MariaDB holds while busy', await untilTrue(same, 10000),
        'engine ' + JSON.stringify((await e.call('query', 'SELECT id, owner, item FROM pan_items ORDER BY id', [])).v)
        + '\n   maria  ' + JSON.stringify(await q('SELECT id, owner, item FROM pan_items ORDER BY id')));

    busy = false;
    await load;
    await e.stop();

    // After a restart the game copy is MariaDB's: the game's write must be there.
    const e2 = engine(dir);
    check('second boot ready', await e2.readyP);
    const after = await e2.call('query', "SELECT id FROM pan_items WHERE owner = 'bob'", []);
    check('the game write survives a restart', after.err === undefined && after.v.length === 1 && after.v[0].id === gameId, JSON.stringify(after));
    // A game insert after the restart reaches MariaDB under its own id.
    const r3 = await e2.call('insert', 'INSERT INTO pan_items (owner, item) VALUES (?, ?)', ['cat', 'map']);
    check('a game insert after the restart reaches MariaDB with its id', r3.err === undefined && await untilTrue(async () =>
        (await q("SELECT id FROM pan_items WHERE owner = 'cat'")).some((x) => x.id === r3.v), 10000), JSON.stringify(r3));
    await e2.stop();
    fs.rmSync(dir, { recursive: true, force: true });

    // With the reserve and forced scans off, the clash is not silent.
    const r0 = await mysql.createConnection(URL_ + '/' + DB);
    await r0.query('DROP TABLE pan_items');
    await r0.query('CREATE TABLE pan_items (id INT AUTO_INCREMENT PRIMARY KEY, owner VARCHAR(40) NOT NULL, item VARCHAR(40) NOT NULL)');
    await r0.query("INSERT INTO pan_items (owner, item) VALUES ('ann', 'phone')");
    await r0.end();
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-panel-'));
    const e3 = engine(dir3, { cis_database_id_reserve_ms: '0', cis_database_cdc_force_ms: '0' });
    check('third boot ready', await e3.readyP);
    busy = true;
    const load3 = (async () => { while (busy) { await e3.call('query', 'SELECT id FROM pan_items WHERE owner = ?', ['ann']); await sleep(100); } })();
    await sleep(1000);
    await q("INSERT INTO pan_items (owner, item) VALUES ('panel', 'gift')");
    await e3.call('insert', 'INSERT INTO pan_items (owner, item) VALUES (?, ?)', ['bob', 'radio']);
    check('a duplicate on an outbox insert is logged as a warning', await untilTrue(async () => /refused a write .* as a duplicate/.test(e3.err), 10000),
        e3.err.slice(-600));
    busy = false;
    await load3;
    await e3.stop();
    fs.rmSync(dir3, { recursive: true, force: true });
    const r2 = await mysql.createConnection(URL_);
    await r2.query('DROP DATABASE IF EXISTS ' + DB);
    await r2.end();
    if (failed) { console.log('FAIL maria_panel_insert: ' + failed + ' of ' + checks); process.exit(1); }
    console.log('PASS maria_panel_insert: ' + checks + ' checks');
})().catch((e) => { console.log('FAIL maria_panel_insert: ' + (e && e.stack)); process.exit(1); });
