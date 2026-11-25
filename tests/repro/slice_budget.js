'use strict';

// One time budget across every path: a burst of calls from one tick, chains
// of callbacks that each issue the next statement (what sequential .await
// loops do), transactions and execMany all yield the thread after about
// cis_database_slice_ms, keep arrival order, and finish. The longest stretch
// the event loop is held is measured with a 1 ms interval probe.
// Usage: node tests/repro/slice_budget.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-slice-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE users (identifier VARCHAR(64) PRIMARY KEY, money INT NOT NULL); CREATE TABLE logs (seq INT, who VARCHAR(16))');
const ins = m.prepare('INSERT INTO users VALUES (?, ?)');
m.exec('BEGIN');
for (let i = 0; i < 2000; i++) ins.run('id' + i, i);
m.exec('COMMIT');
m.close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;
process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: 'mysql://root@127.0.0.1/fake', cis_database_cdc: '0', cis_database_slice_ms: '4' });

const fx = require('../harness/fx.js');
const r = fx.registry;

// The budget is 4 ms; one statement and its callback may finish past it.
const LIMIT = 8;
// Timers must keep running between slices. A wake that runs the next slice
// without giving the event loop a turn (a datagram read in the same pass as
// the one before it) held it for 100 ms and more here; timer granularity on
// Windows is about 15 ms.
const GAP_LIMIT = 80;
function gapCheck(name, x) {
    check(name + ': timers run between slices (loop gap under ' + GAP_LIMIT + ' ms)', x.worst < GAP_LIMIT, 'loop gap ' + x.worst.toFixed(1) + ' ms');
}
const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

// Longest gap between 1 ms interval firings while fn's work runs (coarse on
// Windows, where timers tick every ~15 ms), and the longest slice the engine
// itself measured.
async function heldMs(fn) {
    fx.asSelf(() => r.probe(true));
    let last = performance.now();
    let worst = 0;
    const probe = setInterval(() => {
        const now = performance.now();
        worst = Math.max(worst, now - last);
        last = now;
    }, 1);
    const t0 = performance.now();
    await fn();
    const total = performance.now() - t0;
    clearInterval(probe);
    worst = Math.max(worst, performance.now() - last);
    const slice = fx.asSelf(() => r.probe(true)).slice_max_ms;
    return { worst, total, slice };
}

(async () => {
    await fx.ready(20000);
    // Warm the statement and translation caches.
    await new Promise((res) => r.single('SELECT * FROM users WHERE identifier = ?', ['id1'], res));
    await new Promise((res) => r.update('UPDATE users SET money = ? WHERE identifier = ?', [1, 'id1'], res));

    // 1. 6000 calls issued from one tick (callback form, no await in between).
    let issueMs = 0;
    const burst = await heldMs(() => new Promise((res) => {
        let left = 6000;
        const t0 = performance.now();
        for (let i = 0; i < 6000; i++) {
            r.single('SELECT money FROM users WHERE identifier = ?', ['id' + (i % 2000)], () => { if (--left === 0) res(); });
        }
        issueMs = performance.now() - t0;
    }));
    check('burst of 6000 calls: issuing them holds the thread < 15 ms', issueMs < 15, 'issue=' + issueMs.toFixed(1) + ' ms');
    check('burst of 6000 calls: longest slice under ' + LIMIT + ' ms', burst.slice < LIMIT, 'slice=' + burst.slice + ' ms, loop gap ' + burst.worst.toFixed(1) + ' ms total=' + burst.total.toFixed(0) + ' ms');
    gapCheck('burst of 6000 calls', burst);

    // 2. 60 chains of 100 sequential statements, each issued from the previous callback.
    const chains = await heldMs(() => new Promise((res) => {
        let running = 60;
        for (let c = 0; c < 60; c++) {
            let n = 0;
            const next = () => {
                if (n === 100) { if (--running === 0) res(); return; }
                const k = n++;
                r.update('UPDATE users SET money = ? WHERE identifier = ?', [k, 'id' + c], next);
            };
            next();
        }
    }));
    check('60 chains x 100 statements: longest slice under ' + LIMIT + ' ms', chains.slice < LIMIT, 'slice=' + chains.slice + ' ms, loop gap ' + chains.worst.toFixed(1) + ' ms total=' + chains.total.toFixed(0) + ' ms');
    gapCheck('60 chains x 100 statements', chains);
    const last = await new Promise((res) => r.query('SELECT identifier, money FROM users WHERE identifier IN (?, ?)', ['id0', 'id59'], res));
    check('chains finish with their last value', JSON.stringify(last.map((x) => x.money)) === '[99,99]', JSON.stringify(last));

    // 3. Ordered writes past the budget: every row lands, in issue order.
    const order = await heldMs(() => new Promise((res) => {
        let left = 4000;
        for (let i = 0; i < 4000; i++) {
            r.insert('INSERT INTO logs (seq, who) VALUES (?, ?)', [i, 'o'], () => { if (--left === 0) res(); });
        }
    }));
    const seq = await new Promise((res) => r.query('SELECT seq FROM logs ORDER BY rowid', [], res));
    let inOrder = seq.length === 4000;
    for (let i = 0; inOrder && i < seq.length; i++) if (seq[i].seq !== i) inOrder = false;
    check('4000 queued inserts keep issue order', inOrder, 'rows=' + seq.length);
    check('4000 inserts: longest slice under ' + LIMIT + ' ms', order.slice < LIMIT, 'slice=' + order.slice + ' ms, loop gap ' + order.worst.toFixed(1) + ' ms');
    gapCheck('4000 inserts', order);
    // Final review 407c8ec #7: the fake pool opened a SQLite connection per
    // call and never closed it, so this test timed the harness, not the
    // slices. A pool keeps its idle connections.
    check('the fake MariaDB pool reuses its connections', fx.opens() < 50, 'opens=' + fx.opens());

    // 4. Transactions and execMany from one tick.
    const txs = await heldMs(() => new Promise((res) => {
        let left = 1500;
        const one = () => { if (--left === 0) res(); };
        for (let i = 0; i < 1000; i++) {
            r.transaction([
                { query: 'UPDATE users SET money = money - 1 WHERE identifier = ?', values: ['id' + (i % 50)] },
                { query: 'UPDATE users SET money = money + 1 WHERE identifier = ?', values: ['id' + (50 + (i % 50))] },
            ], one);
        }
        for (let i = 0; i < 500; i++) r.execMany([{ kind: 'scalar', sql: 'SELECT money FROM users WHERE identifier = ?', params: ['id' + i] }], one);
    }));
    check('1000 transactions + 500 execMany: longest slice under ' + LIMIT + ' ms', txs.slice < LIMIT, 'slice=' + txs.slice + ' ms, loop gap ' + txs.worst.toFixed(1) + ' ms total=' + txs.total.toFixed(0) + ' ms');
    gapCheck('1000 transactions + 500 execMany', txs);

    // 5. A stop with calls still queued runs them before closing.
    let stopped = 0;
    for (let i = 0; i < 3000; i++) r.update('UPDATE users SET money = ? WHERE identifier = ?', [-i, 'id1999'], () => { stopped++; });
    global.__fxInvoker = 'cis_database';
    r.shutdown();
    check('queued calls run before shutdown closes the database', stopped === 3000, 'ran=' + stopped);

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    setTimeout(() => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows */ }
        process.exit(failed ? 1 : 0);
    }, 300);
})();
