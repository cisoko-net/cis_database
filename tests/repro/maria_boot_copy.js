'use strict';

// The boot copy on a qbox-sized MariaDB (114 tables, 92,000 rows). 1.0.0-beta.2
// copied every table again on every boot: about 22 s on qbox with 10 to 17
// server thread pauses of 150 to 480 ms before ready, and the first boot with
// the AUTO_INCREMENT reserve then reloaded every table through Change Data
// Capture as well (96,742 rows).
//
// Checks, each boot on the same cache/ folder:
//   1. cold boot: every table copied, no pause of the thread at the hitch line
//   2. no CDC reload after it, though the reserve raised every counter
//   3. warm boot with nothing changed: no table copied, no pause
//   4. MariaDB edited while stopped (a row, an insert, an index): those three
//      tables are copied and read as MariaDB has them, the rest are not
//   5. a game write: its table is copied at the next boot, the rest are not
//
// Usage: node tests/repro/maria_boot_copy.js
//   FX_TRUST_MARIA (default mysql://root@127.0.0.1:3307) is a real MariaDB;
//   without one it prints SKIP. Database cm_bootcopy is dropped and made again.
//   BOOTCOPY_TRACE=1 prints the engine's console.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { fork } = require('child_process');

const URL_ = process.env.FX_TRUST_MARIA || 'mysql://root@127.0.0.1:3307';
const DB = 'cm_bootcopy';
// FXServer prints a hitch warning for a server frame past 150 ms; the
// engine's work in a frame is held to 25 ms, so 100 ms leaves room for the
// rest of the process.
const HITCH_MS = 100;

if (process.argv[2] === '--child') {
    // Longest time the thread went without running a timer, from the end of
    // the resource load until the engine is ready. The load itself (compiling
    // the scripts, opening the file) is one block FXServer also has for every
    // resource; it is reported apart as loadMs.
    let last = performance.now();
    let maxGap = 0;
    let over = 0;
    let on = true;
    let loadMs = null;
    const tick = setInterval(() => {
        const now = performance.now();
        const gap = now - last;
        last = now;
        if (!on) return;
        if (loadMs === null) { loadMs = gap; return; }
        if (gap > maxGap) maxGap = gap;
        if (gap >= HITCH_MS) over++;
    }, 2);
    const fx = require('../harness/fx.js');
    const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v, (k, x) => (typeof x === 'bigint' ? x.toString() : x)));
    fx.ready(300000).then((ok) => {
        on = false;
        clearInterval(tick);
        const p = ok ? fx.registry.probe() : {};
        process.send({ ready: ok, maxGap: Math.round(maxGap), over, loadMs: Math.round(loadMs || 0), ckpt: p.ckpt, ckptThread: p.ckpt_thread_n, copyMax: p.ckpt_copy_max_ms });
    });
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
    const c = await mysql.createConnection({ uri: URL_ + '/' + DB, dateStrings: true });
    try { return (await c.query(sql, params))[0]; } finally { await c.end().catch(() => {}); }
}

function engine(dir) {
    const child = fork(__filename, ['--child'], {
        env: Object.assign({}, process.env, {
            FX_RES_DIR: dir,
            FX_REAL_MARIA: '1',
            FX_CONVARS: JSON.stringify({
                mysql_connection_string: URL_ + '/' + DB,
                cis_database_cdc: '1',
                cis_database_cdc_ms: '200',
                cis_database_cdc_force_ms: '2000',
            }),
        }),
        stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    });
    const e = { out: '' };
    child.stdout.on('data', (d) => {
        e.out += d;
        if (process.env.BOOTCOPY_TRACE) process.stdout.write(d);
    });
    const waiting = new Map();
    let n = 0;
    e.readyP = new Promise((res) => child.on('message', (m) => {
        if ('ready' in m) { res(m); return; }
        const w = waiting.get(m.id);
        if (w) { waiting.delete(m.id); w(m); }
    }));
    e.call = (kind, sql, params) => new Promise((res) => { const id = ++n; waiting.set(id, res); child.send({ id, kind, sql, params }); });
    e.stop = () => new Promise((res) => { child.once('exit', res); child.kill(); });
    return e;
}

// 4 tables of 15,000 rows, 10 of 2,500 and 100 of 70: 114 tables, 92,000 rows.
const BIG = 4;
const MID = 10;
const SMALL = 100;
const tableNames = [];
async function seed() {
    const root = await mysql.createConnection(URL_ + '?multipleStatements=true');
    await root.query('DROP DATABASE IF EXISTS ' + DB + '; CREATE DATABASE ' + DB + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci; USE ' + DB);
    const make = async (name, rows, wide) => {
        tableNames.push(name);
        await root.query('CREATE TABLE `' + name + '` (id INT AUTO_INCREMENT PRIMARY KEY, citizenid VARCHAR(50) NOT NULL,'
            + ' owner VARCHAR(60) NULL, money INT NOT NULL DEFAULT 0, meta LONGTEXT NULL,'
            + ' updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,'
            + ' UNIQUE KEY citizenid (citizenid), KEY owner (owner))');
        const pad = 'x'.repeat(wide);
        for (let at = 0; at < rows; at += 1000) {
            const vals = [];
            for (let i = at; i < Math.min(rows, at + 1000); i++) {
                vals.push(['C' + i, 'license:' + (i % 997), i * 7, '{"n":' + i + ',"pad":"' + pad + '"}']);
            }
            await root.query('INSERT INTO `' + name + '` (citizenid, owner, money, meta) VALUES ?', [vals]);
        }
    };
    for (let i = 0; i < BIG; i++) await make('big_' + i, 15000, 300);
    for (let i = 0; i < MID; i++) await make('mid_' + i, 2500, 200);
    for (let i = 0; i < SMALL; i++) await make('small_' + String(i).padStart(3, '0'), 70, 80);
    await root.end();
}

function hydrated(out) {
    const m = /Database initialized: hydrated (\d+) tables \((\d+) rows\)/.exec(out);
    return m ? { tables: Number(m[1]), rows: Number(m[2]) } : null;
}
function hydrateMs(out) {
    const m = /hydrate (\d+) ms/.exec(out);
    return m ? Number(m[1]) : null;
}
function cdcRows(out) {
    let n = 0;
    const re = /Change Data Capture: synchronized (\d+) updated rows/g;
    let m;
    while ((m = re.exec(out))) n += Number(m[1]);
    return n;
}

async function same(e, table) {
    const want = await q('SELECT id, citizenid, owner, money FROM `' + table + '` ORDER BY id');
    const r = await e.call('query', 'SELECT id, citizenid, owner, money FROM `' + table + '` ORDER BY id', []);
    return r.err === undefined && JSON.stringify(r.v) === JSON.stringify(want);
}

async function countsMatch(e) {
    for (const t of tableNames) {
        const want = await q('SELECT COUNT(*) AS n, COALESCE(SUM(money), 0) AS s FROM `' + t + '`');
        const r = await e.call('query', 'SELECT COUNT(*) AS n, COALESCE(SUM(money), 0) AS s FROM `' + t + '`', []);
        if (r.err !== undefined || Number(r.v[0].n) !== Number(want[0].n) || Number(r.v[0].s) !== Number(want[0].s)) return t;
    }
    return null;
}

const results = [];
async function boot(dir, label) {
    const e = engine(dir);
    const r = await e.readyP;
    // The "Database initialized" line is printed just before ready.
    await sleep(200);
    const h = hydrated(e.out);
    const row = { label, ready: r.ready, hydrateMs: hydrateMs(e.out), tables: h && h.tables, rows: h && h.rows, maxGap: r.maxGap, over: r.over, loadMs: r.loadMs, ckpt: r.ckpt, ckptThread: r.ckptThread, copyMax: r.copyMax };
    results.push(row);
    check(label + ': ready', r.ready);
    // A checkpoint on the main connection syncs the WAL and the database on
    // the server thread: 113 to 199 ms on Windows during the copy. The pause
    // check above only catches it when the disk is slow; this one every time.
    check(label + ': no checkpoint on the server thread', r.ckpt === 'split' && r.ckptThread === 0, JSON.stringify(row));
    check(label + ': no pause of the thread at ' + HITCH_MS + ' ms or more', r.over === 0, JSON.stringify(row));
    return { e, row };
}

(async () => {
    if (!(await reachable())) { console.log('SKIP no MariaDB at ' + URL_); process.exit(0); }
    const t0 = Date.now();
    await seed();
    console.log('seeded ' + tableNames.length + ' tables in ' + (Date.now() - t0) + ' ms');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-bootcopy-'));

    // 1. Cold boot.
    let { e, row } = await boot(dir, 'cold boot');
    check('cold boot: every table copied', row.tables === tableNames.length && row.rows === 92000, JSON.stringify(row));
    // 2. The reserve raises every AUTO_INCREMENT in MariaDB. CDC must not take
    // that for an edit and copy every table again. Forced scans run every 2 s.
    await sleep(9000);
    check('no CDC reload after the reserve', cdcRows(e.out) === 0, cdcRows(e.out) + ' rows reloaded');
    check('cold boot: every table matches MariaDB', (await countsMatch(e)) === null, await countsMatch(e));
    await e.stop();

    // 3. Warm boot, nothing changed.
    ({ e, row } = await boot(dir, 'warm boot'));
    check('warm boot: no table copied', row.tables === 0, JSON.stringify(row));
    check('warm boot: every table matches MariaDB', (await countsMatch(e)) === null, await countsMatch(e));
    await e.stop();

    // 4. MariaDB edited while stopped.
    await q("UPDATE big_2 SET money = -5 WHERE citizenid = 'C14000'");
    await q("INSERT INTO small_042 (citizenid, owner, money) VALUES ('panel', 'license:panel', 77)");
    await q('ALTER TABLE mid_3 ADD INDEX money (money)');
    ({ e, row } = await boot(dir, 'after offline edits'));
    check('offline edits: the three edited tables copied', row.tables === 3, JSON.stringify(row));
    check('offline edits: big_2 reads the edited row', await same(e, 'big_2'));
    check('offline edits: small_042 reads the inserted row', await same(e, 'small_042'));
    // mid_3 changed only its index, so its sum did not move: the table
    // signature is what made it one of the three.
    // 5. A game write.
    const w = await e.call('update', "UPDATE mid_7 SET money = money + 1 WHERE citizenid = 'C10'", []);
    check('game write answered', w.err === undefined && w.v === 1, JSON.stringify(w));
    let landed = false;
    for (let i = 0; i < 150 && !landed; i++) {
        const x = await q("SELECT money FROM mid_7 WHERE citizenid = 'C10'");
        landed = x[0].money === 71;
        if (!landed) await sleep(100);
    }
    check('game write reached MariaDB', landed);
    await sleep(500);
    await e.stop();

    ({ e, row } = await boot(dir, 'after a game write'));
    check('game write: only its table copied', row.tables === 1, JSON.stringify(row));
    check('game write: mid_7 matches MariaDB', await same(e, 'mid_7'));
    check('game write: every table matches MariaDB', (await countsMatch(e)) === null, await countsMatch(e));
    await e.stop();

    for (const r of results) {
        console.log('  ' + r.label + ': hydrate ' + r.hydrateMs + ' ms, ' + r.tables + ' tables, ' + r.rows + ' rows, longest pause '
            + r.maxGap + ' ms, ' + r.over + ' at ' + HITCH_MS + ' ms or more, load ' + r.loadMs + ' ms, longest checkpoint copy ' + r.copyMax + ' ms');
    }
    fs.rmSync(dir, { recursive: true, force: true });
    const root = await mysql.createConnection(URL_);
    await root.query('DROP DATABASE IF EXISTS ' + DB);
    await root.end();
    if (failed) { console.log('FAIL maria_boot_copy: ' + failed + ' of ' + checks); process.exit(1); }
    console.log('PASS maria_boot_copy: ' + checks + ' checks');
})().catch((e) => { console.log('FAIL maria_boot_copy: ' + (e && e.stack)); process.exit(1); });
