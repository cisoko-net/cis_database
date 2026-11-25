'use strict';

// A Lua caller whose first values are nil: { nil, 'b' } reaches JS as a map
// with key 2 only. Lua keys start at 1, so 'b' is the second value. It was
// bound to the first mark, and every later value moved one mark left.
// Usage: node tests/repro/lua_nil_first.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-luanil-'));
const mariaFile = path.join(dir, 'maria.sqlite');
new DatabaseSync(mariaFile).close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;

const fx = require('../harness/fx.js');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

(async () => {
    check('engine ready', await fx.ready(20000));
    const a = await fx.call('query', 'SELECT ? AS a, ? AS b', { 2: 'b' });
    check('{ [2] = b } binds nil, b', a && a[0] && a[0].a === null && a[0].b === 'b', JSON.stringify(a));
    const b = await fx.call('query', 'SELECT ? AS a, ? AS b, ? AS c', { 1: 'a', 3: 'c' });
    check('{ a, nil, c } binds a, nil, c', b && b[0] && b[0].a === 'a' && b[0].b === null && b[0].c === 'c', JSON.stringify(b));
    const c = await fx.call('query', 'SELECT ? AS a, ? AS b', ['x', 'y']);
    check('a JS array is unchanged', c && c[0] && c[0].a === 'x' && c[0].b === 'y', JSON.stringify(c));
    const d = await fx.call('query', 'SELECT ? AS a, ? AS b', { 0: 'x', 1: 'y' });
    check('a 0-based map is unchanged', d && d[0] && d[0].a === 'x' && d[0].b === 'y', JSON.stringify(d));
    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
