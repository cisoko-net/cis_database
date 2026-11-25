'use strict';

// A Lua caller whose last values are nil sends fewer params than the SQL has
// placeholders: `{ at, tx, actor, reason, ..., qty, nil, nil, nil, nil }`
// reaches Node as 10 values for 14 marks. oxmysql pads the missing ones with
// null (parseArguments). SQLite binds an unbound mark as NULL too, so the
// game saw the row, but mysql2 left the last four ? in the text and MariaDB
// refused the copy as a syntax error: on qbox, 2026-10-28, cis_inventory's
// ledger INSERT ("14 placeholders, 10 values"). The params are now padded
// with null before either side binds them.
// Usage: node tests/repro/short_params.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const HARNESS = path.join(__dirname, '..', 'harness', 'fx.js');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-shortp-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, at INT NOT NULL, item VARCHAR(32) NOT NULL, qty INT, serial VARCHAR(32), meta_hash VARCHAR(64))');
m.close();

const code = 'const fx = require(' + JSON.stringify(HARNESS) + ');\n'
    + 'const r = fx.registry;\n'
    + "const out = (k, v) => console.log('@' + k + '=' + JSON.stringify(v));\n"
    + 'const sleep = (ms) => new Promise((res) => setTimeout(res, ms));\n'
    + '(async () => {\n'
    + "if (!(await fx.ready(20000))) throw new Error('not ready');\n"
    + "const sql = 'INSERT INTO ledger (at, item, qty, serial, meta_hash) VALUES (?, ?, ?, ?, ?)';\n"
    + "out('a', await fx.call('insert', sql, [1, 'water', 2]));\n"
    // A Lua array with nil at the end arrives as an object keyed from 1.
    + "out('b', await fx.call('insert', sql, { 1: 2, 2: 'bread' }));\n"
    + "out('c', await fx.call('query', 'SELECT at, item, qty, serial FROM ledger ORDER BY id'));\n"
    + 'const end = Date.now() + 15000;\n'
    + 'while (Date.now() < end) { const p = r.probe(); if (p && p.replica === 0) break; await sleep(50); }\n'
    + 'await sleep(300);\n'
    + 'process.exit(0);\n'
    + "})().catch((e) => { console.log('CHILD ERROR ' + (e && e.stack)); process.exit(2); });";

const run = spawnSync(process.execPath, ['-e', code], {
    env: Object.assign({}, process.env, { FX_RES_DIR: dir, FX_MARIA_FILE: mariaFile }),
    encoding: 'utf8',
    timeout: 90000,
});
const text = (run.stdout || '') + (run.stderr || '');
const vals = {};
for (const mm of text.matchAll(/^@(\w+)=(.*)$/gm)) vals[mm[1]] = JSON.parse(mm[2]);

check('an insert with 3 values for 5 marks answers an id', vals.a === 1, JSON.stringify(vals.a));
check('a Lua table with trailing nils answers an id', vals.b === 2, JSON.stringify(vals.b));
check('SQLite holds both rows', Array.isArray(vals.c) && vals.c.length === 2 && vals.c[1].item === 'bread' && vals.c[0].serial == null, JSON.stringify(vals.c));
check('MariaDB refused no copy', !/MariaDB rejected a write/.test(text), (text.match(/MariaDB rejected[^\n]*/) || [''])[0].slice(0, 200));

const mr = new DatabaseSync(mariaFile);
const rows = mr.prepare('SELECT at, item, qty, serial, meta_hash FROM ledger ORDER BY id').all();
mr.close();
check('MariaDB has both rows, the missing values NULL', rows.length === 2 && rows[0].qty === 2 && rows[0].serial === null && rows[1].item === 'bread' && rows[1].qty === null, JSON.stringify(rows));

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
