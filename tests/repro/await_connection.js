'use strict';

// oxmysql's awaitConnection resolves true once the database answers, so
//   exports.oxmysql:awaitConnection()
// in a Lua thread waits and returns true. cis returned nothing at once, so a
// script that checked the value thought the database was down, and one that
// waited on it did not wait.
// Usage: node tests/repro/await_connection.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-awaitconn-'));
process.env.FX_RES_DIR = dir;
process.env.FX_REAL_MARIA = '1';
process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: '' });

const fx = require('../harness/fx.js');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

function settle(ret) {
    return new Promise((resolve) => {
        if (!ret || typeof ret.__cfx_async_retval !== 'function') return resolve({ none: true, ret });
        ret.__cfx_async_retval((v, err) => resolve({ v, err }));
    });
}

(async () => {
    // Asked before the engine is ready: the answer waits for it.
    const early = settle(fx.registry.awaitConnection(null));
    let cbArg = 'not called';
    fx.registry.awaitConnection(null, (v) => { cbArg = v; });
    check('engine ready', await fx.ready(20000));
    const e = await early;
    check('asked before ready: resolves [true] once ready', Array.isArray(e.v) && e.v[0] === true && !e.err, JSON.stringify(e));
    await new Promise((r) => setTimeout(r, 50));
    check('the callback form is called with true', cbArg === true, String(cbArg));

    const late = await settle(fx.registry.awaitConnection(null));
    check('asked after ready: resolves [true]', Array.isArray(late.v) && late.v[0] === true, JSON.stringify(late));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
