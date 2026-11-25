'use strict';

// A customer table named audit_log, or one whose name ends in _bench, is a
// game table like any other. 1.0.0-beta.3 left both out of the boot copy, the
// change scan and the id reserve: a write to such a table failed, because the
// game copy had no table to write to.
//
// Checks:
//   1. the boot copy takes all three tables (audit_log, fines_bench, players)
//   2. a write to audit_log and to fines_bench succeeds and reaches MariaDB
//      with the next free id
//   3. a row edited in MariaDB while the server runs reaches the game copy
//
// Usage: node tests/repro/maria_table_names.js
//   FX_TRUST_MARIA (default mysql://root@127.0.0.1:3307) is a real MariaDB;
//   without one it prints SKIP. Database cm_names is dropped and made again.
//   NAMES_TRACE=1 prints the engine's console.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { fork } = require('child_process');

const URL_ = process.env.FX_TRUST_MARIA || 'mysql://root@127.0.0.1:3307';
const DB = 'cm_names';

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
                cis_database_cdc_force_ms: '1000',
            }),
        }),
        stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    });
    const e = { out: '' };
    child.stdout.on('data', (d) => {
        e.out += d;
        if (process.env.NAMES_TRACE) process.stdout.write(d);
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

async function seed() {
    const root = await mysql.createConnection(URL_ + '?multipleStatements=true');
    await root.query('DROP DATABASE IF EXISTS ' + DB + '; CREATE DATABASE ' + DB + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci; USE ' + DB);
    for (const t of ['audit_log', 'fines_bench', 'players']) {
        await root.query('CREATE TABLE `' + t + '` (id INT AUTO_INCREMENT PRIMARY KEY, note VARCHAR(60) NOT NULL)');
        await root.query('INSERT INTO `' + t + '` (note) VALUES (?), (?)', [t + ' 1', t + ' 2']);
    }
    await root.end();
}

(async () => {
    if (!(await reachable())) { console.log('SKIP no MariaDB at ' + URL_); return; }
    await seed();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-names-'));
    const e = engine(dir);
    try {
        const r = await e.readyP;
        check('engine ready', r.ready, e.out.slice(-800));
        if (!r.ready) return;

        const m = /Database initialized: hydrated (\d+) tables/.exec(e.out);
        check('the boot copy takes all three tables', m && Number(m[1]) === 3, m ? m[0] : 'no hydrate line');

        for (const t of ['audit_log', 'fines_bench']) {
            const w = await e.call('insert', 'INSERT INTO `' + t + '` (note) VALUES (?)', [t + ' game']);
            check('a write to ' + t + ' succeeds with the next free id', w.err === undefined && w.v === 3, w.err || JSON.stringify(w.v));
        }
        let rows = [];
        for (let i = 0; i < 100; i++) {
            rows = await q("SELECT 'a' AS t, id, note FROM audit_log WHERE id = 3 UNION ALL SELECT 'f', id, note FROM fines_bench WHERE id = 3");
            if (rows.length === 2) break;
            await sleep(100);
        }
        check('both game writes reach MariaDB', rows.length === 2, JSON.stringify(rows));

        // The change scan takes its baseline up to 5 s after ready and first
        // runs 8 s after it; an edit before then is part of the baseline.
        await sleep(9000);
        await q("UPDATE audit_log SET note = 'edited in MariaDB' WHERE id = 1");
        let seen = null;
        for (let i = 0; i < 200; i++) {
            const g = await e.call('scalar', 'SELECT note FROM audit_log WHERE id = 1', []);
            seen = g.v;
            if (seen === 'edited in MariaDB') break;
            await sleep(100);
        }
        check('a MariaDB edit to audit_log reaches the game copy', seen === 'edited in MariaDB', String(seen));
    } finally {
        await e.stop();
        const root = await mysql.createConnection(URL_);
        await root.query('DROP DATABASE IF EXISTS ' + DB).catch(() => {});
        await root.end();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    if (failed) { console.log(failed + ' of ' + checks + ' checks failed'); process.exitCode = 1; } else console.log('all ' + checks + ' passed');
})().catch((err) => { console.log('FAIL ' + (err && err.stack || err)); process.exitCode = 1; });
