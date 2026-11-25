'use strict';

// One statement is never split across slices, so a slow one holds the server
// thread for as long as it runs. The bench saw a 108 ms slice during its seed
// phase and nothing said which SQL it was. A statement, a transaction, an
// execMany list or a checkpoint copy that holds the thread for 50 ms or more
// now prints one line naming it, with every literal in the SQL shown as ?
// (a literal can be player text). A fast statement prints nothing.
// Usage: node tests/repro/slow_hold_log.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-slowhold-'));
process.env.FX_RES_DIR = dir;
process.env.FX_REAL_MARIA = '1';
process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: '' });

const lines = [];
for (const k of ['log', 'warn', 'error', 'info']) {
    const orig = console[k];
    console[k] = function (...a) {
        const s = a.join(' ');
        if (/held the server thread/.test(s)) lines.push(s);
        return orig.apply(console, a);
    };
}

const fx = require('../harness/fx.js');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const call = (kind, sql, params) => new Promise((res) => {
    global.__fxInvoker = 'slow_script';
    fx.registry[kind](sql, params || [], (v, e) => res({ v, e }), 'slow_script', true);
    global.__fxInvoker = '';
});

// A recursive count that runs well past 50 ms on any machine this suite runs on.
function slowSql(n) {
    return "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < " + n + ") SELECT COUNT(*) AS n FROM c WHERE 'secret-text' <> ''";
}

async function slowEnough() {
    // Grow the count until one run takes 120 ms, so the case is not flaky on a fast PC.
    let n = 200000;
    for (;;) {
        const t0 = performance.now();
        await call('scalar', slowSql(n));
        if (performance.now() - t0 >= 120 || n >= 64000000) return n;
        n *= 2;
    }
}

(async () => {
    check('engine ready', await fx.ready(20000));
    await call('query', 'CREATE TABLE t (id INTEGER PRIMARY KEY, v INT)');

    await call('scalar', 'SELECT 1');
    check('a fast statement prints nothing', lines.length === 0, JSON.stringify(lines));

    const n = await slowEnough();
    const q = lines.find((s) => /A query from slow_script/.test(s));
    check('a slow statement prints one line with the caller', !!q, JSON.stringify(lines));
    check('the line names the SQL shape', !!q && /WITH RECURSIVE c\(x\)/.test(q), q);
    check('literals in the SQL print as ?', !!q && !/secret-text/.test(q) && !new RegExp('\\b' + n + '\\b').test(q), q);
    check('the line gives the time in ms', !!q && /held the server thread for \d+ ms/.test(q), q);

    const before = lines.length;
    const tx = await new Promise((res) => {
        global.__fxInvoker = 'slow_script';
        fx.registry.transaction([
            { query: 'INSERT INTO t (v) VALUES (?)', values: [1] },
            { query: slowSql(n), values: [] },
        ], (ok) => res(ok));
        global.__fxInvoker = '';
    });
    check('the slow transaction committed', tx === true, String(tx));
    const t = lines.slice(before).find((s) => /A transaction of 2 statements from slow_script/.test(s));
    check('a slow transaction prints one line with its slowest statement', !!t && /WITH RECURSIVE/.test(t), JSON.stringify(lines.slice(before)));

    const before2 = lines.length;
    const many = await new Promise((res) => {
        global.__fxInvoker = 'slow_script';
        fx.registry.execMany([{ query: slowSql(n), values: [] }], (out, err) => res(err ? false : out));
        global.__fxInvoker = '';
    });
    check('the slow execMany ran', Array.isArray(many), JSON.stringify(many));
    const m = lines.slice(before2).find((s) => /An execMany of 1 statement from slow_script/.test(s));
    check('a slow execMany prints one line', !!m && /WITH RECURSIVE/.test(m), JSON.stringify(lines.slice(before2)));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
