'use strict';

// oxmysql calls a plain callback only with a result. A failed query is
// printed, and reaches the callback as (nil, message) only when the caller
// opted in: the include's .await, or mysql_option 'return_callback_errors' in
// the caller's fxmanifest, sent as the flag after the resource name. cis ran
// every callback with (false, message), so
//   MySQL.scalar(sql, p, function(money) if not money then <create> end end)
// took the "create" branch on any error.
// Usage: node tests/repro/callback_errors.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-cberr-'));
const mariaFile = path.join(dir, 'maria.sqlite');
new DatabaseSync(mariaFile).close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;

const errors = [];
const origError = console.error;
const origLog = console.log;
function capture(orig) {
    return function (...a) {
        const s = a.join(' ');
        if (/no_such_table_x/.test(s) && !/^(PASS|FAIL) /.test(s)) errors.push(s);
        return orig.apply(console, a);
    };
}
console.error = capture(origError);
console.log = capture(origLog);

const fx = require('../harness/fx.js');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

// Calls the export as the include does: (nil, sql, params, cb, resource, flag).
function callFlag(method, sql, params, flag, waitMs) {
    return new Promise((resolve) => {
        let calls = [];
        global.__fxInvoker = 'some_script';
        fx.registry[method](null, sql, params, function (...a) { calls.push(a); }, 'some_script', flag);
        global.__fxInvoker = '';
        setTimeout(() => resolve(calls), waitMs || 150);
    });
}

(async () => {
    check('engine ready', await fx.ready(20000));
    const bad = 'SELECT money FROM no_such_table_x WHERE id = ?';

    const plain = await callFlag('scalar', bad, [1], false);
    check('plain callback is not called on an error', plain.length === 0, JSON.stringify(plain));
    check('the error is printed with the resource', errors.some((s) => /some_script/.test(s)), JSON.stringify(errors));

    const omitted = await callFlag('query', bad, [1], undefined);
    check('no flag: callback is not called on an error', omitted.length === 0, JSON.stringify(omitted));

    const opted = await callFlag('scalar', bad, [1], true);
    check('opted in: callback gets (nil, message)', opted.length === 1 && opted[0][0] === null
        && typeof opted[0][1] === 'string' && /no_such_table_x/.test(opted[0][1]), JSON.stringify(opted));

    const ok = await callFlag('scalar', 'SELECT 7', [], false);
    check('success still calls back with the result', ok.length === 1 && ok[0][0] === 7 && ok[0].length === 1, JSON.stringify(ok));

    let rejected = null;
    const ret = fx.registry.scalar_async(null, bad, [1]);
    rejected = await new Promise((done) => ret.__cfx_async_retval((v, err) => done(err ? String(err) : null)));
    check('promise form still rejects', rejected && /no_such_table_x/.test(rejected), rejected);

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
