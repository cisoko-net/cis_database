'use strict';

// MariaDB going away never costs a write and never gives a wrong answer.
// A TCP proxy sits between the engine and a real MariaDB and is turned off,
// slowed, hung or made to cut connections mid-query. Each engine runs in a
// child process so a boot can be made with MariaDB down.
//
//   down at boot, SQLite file present: the engine starts, takes writes, a read
//     only MariaDB can answer fails with the reason, and once MariaDB is back
//     every write is in it once.
//   down at first install (no SQLite file): nothing answers until MariaDB has
//     been copied, then the held call answers.
//   down mid-run, and cut mid-query (before and after MariaDB commits): every
//     write reaches MariaDB exactly once; hits = hits + 1 shows a duplicate.
//   slow: a routed read waits and gives MariaDB's answer.
//   hung: a routed read fails after cis_database_maria_read_ms, with the reason.
//   MariaDB error mid-query (KILL QUERY): the read fails with the reason.
//
// Usage: node tests/repro/maria_outage.js
//   FX_TRUST_MARIA (default mysql://root@127.0.0.1:3307) names a MariaDB it
//   may write to (database cm_outage is dropped and made again). Without a
//   reachable MariaDB it prints SKIP.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { fork } = require('child_process');

const URL_ = process.env.FX_TRUST_MARIA || 'mysql://root@127.0.0.1:3307';
const DB = 'cm_outage';

// ---- Child: one engine, driven over IPC ----------------------------------
if (process.argv[2] === '--child') {
    const fx = require('../harness/fx.js');
    const plain = (v) => {
        if (v === null || v === undefined) return null;
        if (typeof v === 'bigint') return v.toString();
        if (Array.isArray(v)) return v.map(plain);
        if (typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = plain(v[k]); return o; }
        return v;
    };
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
function reachable(url) {
    const u = new URL(url);
    return new Promise((res) => {
        const s = net.connect(Number(u.port || 3306), u.hostname, () => { s.destroy(); res(true); });
        s.setTimeout(2000);
        s.on('error', () => res(false));
        s.on('timeout', () => { s.destroy(); res(false); });
    });
}

// mode: up | down (refuse and drop) | slow | hang (no replies) | cut (drop a
// connection when it sends a query) | cutReply (drop it when MariaDB answers
// a query, so the statement ran but the engine never heard).
function startProxy(host, port) {
    const p = { mode: 'up', delay: 0, pairs: new Set(), cuts: 0 };
    p.server = net.createServer((c) => {
        if (p.mode === 'down') { c.destroy(); return; }
        const s = net.connect(port, host);
        const pair = { c, s, fromC: 0, fromS: 0 };
        p.pairs.add(pair);
        const kill = () => { if (!p.pairs.delete(pair)) return; c.destroy(); s.destroy(); };
        for (const x of [c, s]) { x.on('error', kill); x.on('close', kill); }
        const send = (to, d) => { if (p.mode === 'slow') setTimeout(() => to.write(d), p.delay); else to.write(d); };
        c.on('data', (d) => {
            pair.fromC++;
            // The first client packet is the handshake reply.
            if (p.mode === 'cut' && pair.fromC > 1) { p.cuts++; kill(); return; }
            send(s, d);
        });
        s.on('data', (d) => {
            pair.fromS++;
            if (p.mode === 'hang' && pair.fromS > 2) return;
            if (p.mode === 'cutReply' && pair.fromS > 2) { p.cuts++; kill(); return; }
            send(c, d);
        });
    });
    p.set = (mode, delay) => {
        p.mode = mode;
        p.delay = delay || 0;
        if (mode === 'down') for (const x of [...p.pairs]) { x.c.destroy(); x.s.destroy(); p.pairs.delete(x); }
    };
    return new Promise((res) => p.server.listen(0, '127.0.0.1', () => { p.port = p.server.address().port; res(p); }));
}

let failed = 0;
let checks = 0;
function check(name, ok, detail) {
    checks++;
    if (ok) return;
    failed++;
    console.log('FAIL ' + name + (detail ? '\n   ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function engine(dir, proxyPort, extra) {
    const child = fork(__filename, ['--child'], {
        env: Object.assign({}, process.env, {
            FX_RES_DIR: dir,
            FX_REAL_MARIA: '1',
            FX_CONVARS: JSON.stringify(Object.assign({ mysql_connection_string: 'mysql://root@127.0.0.1:' + proxyPort + '/' + DB, cis_database_cdc: '0' }, extra || {})),
        }),
        stdio: ['ignore', process.env.OUTAGE_TRACE ? 'inherit' : 'ignore', 'inherit', 'ipc'],
    });
    const waiting = new Map();
    let n = 0;
    const e = { child, isReady: false };
    e.readyP = new Promise((res) => child.on('message', (m) => {
        if ('ready' in m) { e.isReady = m.ready; res(m.ready); return; }
        const w = waiting.get(m.id);
        if (w) { waiting.delete(m.id); w(m); }
    }));
    e.call = (kind, sql, params) => new Promise((res) => { const id = ++n; if (process.env.OUTAGE_TRACE) console.log('  call', kind, sql.slice(0, 50)); waiting.set(id, res); child.send({ id, kind, sql, params }); });
    e.probe = () => new Promise((res) => { const id = ++n; waiting.set(id, (m) => res(m.v)); child.send({ id, op: 'probe' }); });
    e.stop = () => new Promise((res) => { child.once('exit', res); child.kill(); });
    return e;
}

(async () => {
    if (!(await reachable(URL_))) { console.log('SKIP no MariaDB at ' + URL_); process.exit(0); }
    const mysql = require('mysql2/promise');
    const u = new URL(URL_);
    const root = await mysql.createConnection(URL_ + '?multipleStatements=true');
    await root.query('DROP DATABASE IF EXISTS ' + DB + '; CREATE DATABASE ' + DB + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci; USE ' + DB);
    await root.query('CREATE TABLE ledger (id INT AUTO_INCREMENT PRIMARY KEY, k VARCHAR(20) NOT NULL UNIQUE, amount DECIMAL(10,2) NOT NULL, hits INT NOT NULL DEFAULT 0)');
    await root.query("INSERT INTO ledger (k, amount) VALUES ('seed', 1.10)");
    const proxy = await startProxy(u.hostname, Number(u.port || 3306));

    // What MariaDB must hold at the end: k -> [amount, hits].
    const want = new Map([['seed', ['1.10', 0]]]);
    let next = 0;
    const write = async (e, label) => {
        if (process.env.OUTAGE_TRACE) console.log('write', label, next);
        const k = 'k' + (next++);
        const amount = ((next % 97) + 0.25).toFixed(2);
        const r = await e.call('insert', 'INSERT INTO ledger (k, amount) VALUES (?, ?)', [k, amount]);
        check(label + ': insert answered', r.err === undefined && r.v > 0, JSON.stringify(r));
        want.set(k, [amount, 0]);
        const u2 = await e.call('update', 'UPDATE ledger SET hits = hits + 1 WHERE k = ?', [k]);
        check(label + ': update answered', u2.err === undefined && u2.v === 1, JSON.stringify(u2));
        want.get(k)[1]++;
        const u3 = await e.call('update', 'UPDATE ledger SET hits = hits + 1 WHERE k = ?', ['seed']);
        check(label + ': seed update answered', u3.err === undefined && u3.v === 1, JSON.stringify(u3));
        want.get('seed')[1]++;
    };
    const mariaRows = async () => {
        const [rows] = await root.query('SELECT k, amount, hits FROM ledger ORDER BY k');
        return rows;
    };
    const wantRows = () => [...want].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, [amount, hits]]) => ({ k, amount, hits }));
    // Waits for MariaDB to hold exactly what the engine took.
    const converged = async (label, ms) => {
        const end = Date.now() + (ms || 90000);
        let rows;
        while (Date.now() < end) {
            rows = await mariaRows();
            if (JSON.stringify(rows) === JSON.stringify(wantRows())) return true;
            await sleep(250);
        }
        const w = wantRows();
        const dup = rows.filter((r) => { const x = want.get(r.k); return x && r.hits > x[1]; }).length;
        check(label + ': MariaDB holds every write once', false, 'rows ' + rows.length + ' want ' + w.length + ', rows with extra hits ' + dup);
        return false;
    };
    const SUM = 'SELECT SUM(amount) AS v FROM ledger';
    const mariaSum = async () => (await root.query(SUM))[0][0].v;

    // 1. A first boot with MariaDB up writes the SQLite file.
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-outage-'));
    let e = engine(dirA, proxy.port);
    check('boot with MariaDB up is ready', await e.readyP);
    await write(e, 'up');
    check('up: routed read is MariaDB\'s', JSON.stringify((await e.call('scalar', SUM, [])).v) === JSON.stringify(await mariaSum()));
    await converged('up');
    await e.stop();

    // 2. MariaDB down at boot, SQLite file present.
    // sql.js holds the database in memory and loads the snapshot of an earlier
    // boot, which lacks the writes since; it waits for MariaDB instead.
    proxy.set('down');
    e = engine(dirA, proxy.port);
    if (process.env.FX_BACKEND === 'sql.js') {
        let early = null;
        const held = e.call('scalar', 'SELECT COUNT(*) FROM ledger', []).then((r) => { early = r; return r; });
        await sleep(3000);
        check('down at boot, in memory: not ready on the old snapshot', !e.isReady);
        check('down at boot, in memory: a call is held, not answered from the old snapshot', early === null, JSON.stringify(early));
        proxy.set('up');
        check('down at boot, in memory: ready once MariaDB answers', await e.readyP);
        const r0 = await held;
        check('down at boot, in memory: the held call answers MariaDB\'s count', r0.v === want.size, JSON.stringify(r0));
        proxy.set('down');
    }
    check('down at boot: starts from the SQLite file', await e.readyP);
    for (let i = 0; i < 20; i++) await write(e, 'down at boot');
    const c1 = await e.call('scalar', 'SELECT COUNT(*) FROM ledger', []);
    check('down at boot: a read SQLite answers as MariaDB does still answers', c1.v === want.size, JSON.stringify(c1));
    const s1 = await e.call('scalar', SUM, []);
    check('down at boot: a read only MariaDB answers fails, no value', s1.err !== undefined && s1.v === undefined, JSON.stringify(s1));
    check('down at boot: the error names the reason', /answered by MariaDB \(.+\) and MariaDB failed/.test(s1.err || ''), s1.err);
    proxy.set('up');
    await converged('down at boot, then up');
    const s2 = await e.call('scalar', SUM, []);
    check('back up: the routed read is MariaDB\'s', JSON.stringify(s2.v) === JSON.stringify(await mariaSum()), JSON.stringify(s2));

    // 3. Down mid-run, then cut mid-query, before and after MariaDB runs it.
    for (const mode of ['down', 'cut', 'cutReply']) {
        proxy.set(mode);
        for (let i = 0; i < 25; i++) await write(e, mode + ' mid-run');
        const r = await e.call('scalar', SUM, []);
        check(mode + ': a read only MariaDB answers fails, no value', r.err !== undefined && r.v === undefined, JSON.stringify(r));
        proxy.set('up');
        await converged(mode + ' mid-run, then up');
    }
    check('cut modes did cut connections', proxy.cuts > 0, 'cuts ' + proxy.cuts);

    // 4. Slow: the read waits and is MariaDB's.
    proxy.set('slow', 400);
    await write(e, 'slow');
    const t0 = Date.now();
    const s3 = await e.call('scalar', SUM, []);
    check('slow: the routed read is MariaDB\'s', JSON.stringify(s3.v) === JSON.stringify(await mariaSum()), JSON.stringify(s3) + ' after ' + (Date.now() - t0) + ' ms');
    proxy.set('up');
    await converged('slow');

    // 5. MariaDB errors mid-query: KILL QUERY on a routed read.
    const slowRead = e.call('query', 'SELECT SLEEP(5) AS z, SUM(amount) AS v FROM ledger', []);
    let killed = false;
    for (let i = 0; i < 40 && !killed; i++) {
        await sleep(100);
        const [pl] = await root.query("SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE 'SELECT SLEEP(5)%'");
        if (pl.length) { await root.query('KILL QUERY ' + pl[0].ID); killed = true; }
    }
    const k1 = await slowRead;
    check('killed query: found and killed', killed);
    // MariaDB answers a killed SLEEP with 1 and no error; any answer must
    // then be MariaDB's own, never SQLite's.
    check('killed query: an error with the reason or MariaDB\'s own row', k1.err !== undefined ? /MariaDB failed/.test(k1.err) : Array.isArray(k1.v) && k1.v.length === 1 && k1.v[0].z === 1, JSON.stringify(k1));
    await e.stop();

    // 6. Hung MariaDB: the read gives up after cis_database_maria_read_ms.
    e = engine(dirA, proxy.port, { cis_database_maria_read_ms: '1500' });
    check('restart is ready', await e.readyP);
    proxy.set('hang');
    const t1 = Date.now();
    const h1 = await e.call('scalar', SUM, []);
    const took = Date.now() - t1;
    check('hung: a read only MariaDB answers fails, no value', h1.err !== undefined && h1.v === undefined, JSON.stringify(h1));
    check('hung: it fails within the read limit', took < 15000, took + ' ms');
    proxy.set('up');
    await write(e, 'after hang');
    await converged('after hang');
    const h2 = await e.call('scalar', SUM, []);
    check('after hang: the routed read is MariaDB\'s', JSON.stringify(h2.v) === JSON.stringify(await mariaSum()), JSON.stringify(h2));
    await e.stop();

    // 7. First install with MariaDB down: nothing answers until MariaDB is copied.
    proxy.set('down');
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-outage-'));
    e = engine(dirB, proxy.port);
    let answered = null;
    const held = e.call('scalar', 'SELECT COUNT(*) FROM ledger', []).then((r) => { answered = r; return r; });
    await sleep(3000);
    check('first install, MariaDB down: not ready', !e.isReady);
    check('first install, MariaDB down: a call is held, not answered from an empty database', answered === null, JSON.stringify(answered));
    proxy.set('up');
    const r7 = await held;
    check('first install, MariaDB back: the held call answers MariaDB\'s count', r7.v === want.size, JSON.stringify(r7));
    await e.stop();

    proxy.server.close();
    await root.query('DROP DATABASE IF EXISTS ' + DB);
    await root.end();
    if (failed) { console.log(failed + ' of ' + checks + ' failed'); process.exit(1); }
    console.log('all passed (' + checks + ' checks, ' + (next) + ' writes, ' + proxy.cuts + ' cut connections, ' + (process.env.FX_BACKEND || 'node:sqlite') + ')');
    process.exit(0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack)); process.exit(1); });
