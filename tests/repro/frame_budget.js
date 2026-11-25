'use strict';

// The per-frame budget (server.js, FRAME_MS): within one server frame (the
// time between two frame ticks) cis_database stops after FRAME_MS of
// work and the rest waits for the next frame, even when the slice budget
// would allow more. A burst of calls made in one synchronous block, the way
// the Lua threads of one tick call in, stands in for a heavy frame; the
// slice budget is set to its 50 ms maximum so only the frame budget can
// stop it. Run once with cis_database_frame_ms 10 and once with 0 (off).
// Usage: node tests/repro/frame_budget.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

if (process.env.FRAME_CHILD) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-frame-'));
    const mariaFile = path.join(dir, 'maria.sqlite');
    const m = new DatabaseSync(mariaFile);
    m.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const ins = m.prepare('INSERT INTO t VALUES (?, ?)');
    m.exec('BEGIN');
    for (let i = 1; i <= 20000; i++) ins.run(i, 'x'.repeat(200) + i);
    m.exec('COMMIT');
    m.close();
    process.env.FX_RES_DIR = dir;
    process.env.FX_MARIA_FILE = mariaFile;
    process.env.FX_CONVARS = JSON.stringify({
        mysql_connection_string: 'mysql://root@127.0.0.1/fake', cis_database_cdc: '0',
        cis_database_slice_ms: '50', cis_database_auto_index: '0',
    });
    if (process.env.FRAME_CHILD !== 'default') {
        const c = JSON.parse(process.env.FX_CONVARS);
        c.cis_database_frame_ms = process.env.FRAME_CHILD;
        process.env.FX_CONVARS = JSON.stringify(c);
    }
    const fx = require('../harness/fx.js');
    const r = fx.registry;
    (async () => {
        if (!(await fx.ready(20000))) throw new Error('not ready');
        await new Promise((res) => setTimeout(res, 200));
        // A full scan per call, about 1 ms each.
        const N = 400;
        const got = new Array(N);
        let answered = 0;
        // Start right after a frame tick, as a tick's Lua threads do.
        await new Promise((res) => { const t = fx.tickers; const f = t[0]; t[0] = function () { const v = f.apply(this, arguments); t[0] = f; setImmediate(res); return v; }; });
        const t0 = performance.now();
        let ranNow = 0;
        for (let i = 0; i < N; i++) {
            r.scalar("SELECT COUNT(*) FROM t WHERE v LIKE ?", ['%' + (i % 10) + '%'], (v) => { got[i] = v; answered++; });
            if (answered === i + 1) ranNow++;
        }
        const syncMs = performance.now() - t0;
        const end = Date.now() + 20000;
        while (Date.now() < end && answered < N) await new Promise((res) => setTimeout(res, 5));
        const expect = [];
        const db = new DatabaseSync(path.join(dir, 'cache', 'durable.sqlite'));
        for (let k = 0; k < 10; k++) expect.push(Number(db.prepare("SELECT COUNT(*) AS n FROM t WHERE v LIKE ?").get('%' + k + '%').n));
        db.close();
        const right = got.every((v, i) => Number(v) === expect[i % 10]);
        process.stdout.write('RESULT ' + JSON.stringify({ syncMs, ranNow, answered, right, probe: { frame_ms: r.probe().frame_ms, wake_n: r.probe().wake_n } }) + '\n');
        process.exit(0);
    })().catch((e) => { console.log('ERR ' + e.stack); process.exit(3); });
    return;
}

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
function run(frameMs) {
    const r = spawnSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { FRAME_CHILD: frameMs }), encoding: 'utf8', timeout: 120000 });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT ')) || '';
    try { return JSON.parse(line.slice(7)); } catch (e) { return { err: (r.stdout || '').slice(-400) + (r.stderr || '').slice(-400) }; }
}

const on = run('10');
const off = run('0');
const dflt = run('default');
check('a heavy frame stops after the frame budget', on.syncMs < 25 && on.ranNow < 400, JSON.stringify(on).slice(0, 300));
check('without it the same frame runs to the slice budget', off.syncMs >= 40, 'frame_ms 0: ' + (off.syncMs || 0).toFixed(1) + ' ms, ran ' + off.ranNow + ' at once');
check('every held call is answered in the next frames, with the right result', on.answered === 400 && on.right === true, 'answered=' + on.answered + ' right=' + on.right);
check('the default budget is 25 ms and holds a heavy frame to about that', dflt.probe && dflt.probe.frame_ms === 25 && dflt.syncMs < 40, 'frame_ms=' + (dflt.probe && dflt.probe.frame_ms) + ' sync=' + (dflt.syncMs || 0).toFixed(1) + ' ms');
check('the slice wake is not re-armed over and over while a frame is full', on.probe && on.probe.wake_n < 200, 'wake_n=' + (on.probe && on.probe.wake_n));
const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
