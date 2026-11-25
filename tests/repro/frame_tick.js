'use strict';

// The frame boundary comes from server.js's own setTick, not from a Lua
// Wait(0) thread. index.lua's thread called lua_poll every server tick and
// cost 0.23 ms per idle frame on qbox (profiler, 2026-11-01) against an idle
// budget of 0.02 ms. Checks: server.js registers one ticker, index.lua has no
// per-tick thread, the lua_poll export is gone, and calls queued past the
// frame budget are delivered by the ticker.
// Usage: node tests/repro/frame_tick.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-tick-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
m.close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;
process.env.FX_CONVARS = JSON.stringify({ cis_database_frame_ms: '5' });

const fx = require('../harness/fx.js');
const r = fx.registry;

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

(async () => {
    if (!(await fx.ready(20000))) throw new Error('not ready');
    check('server.js registers one setTick', fx.tickers.length === 1, String(fx.tickers.length));

    const lua = fs.readFileSync(path.join(__dirname, '..', '..', 'index.lua'), 'utf8')
        .replace(/--[^\n]*/g, '');
    check('index.lua has no per-tick thread', !/Wait\(\s*0\s*\)/.test(lua) && !/lua_poll/.test(lua));

    check('there is no lua_poll export', r.lua_poll === undefined);
    const all = [];
    for (let i = 0; i < 2000; i++) all.push(fx.call('insert', 'INSERT INTO t (v) VALUES (?)', ['row ' + i]));
    const p = r.probe();
    const done = await Promise.race([
        Promise.all(all).then(() => true),
        new Promise((res) => setTimeout(() => res(false), 20000)),
    ]);
    check('a burst past the frame budget queues (precondition)', p.queued > 0, 'queued ' + p.queued);
    check('queued calls are delivered by the ticker', done === true);

    const ok = results.every(Boolean);
    console.log(ok ? 'ALL PASS' : 'SOME FAILED');
    process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
