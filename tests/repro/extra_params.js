'use strict';

// More values than the SQL has placeholders is a mistake in the caller:
// oxmysql 2.14.3 throws "Expected N parameters, but received M."
// (src/utils/parseArguments.ts) and runs nothing. cis_database failed with
// SQLite's "column index out of range", and sent a read that failed so to
// MariaDB, which ignores the extra values and answers. A statement with no
// placeholder takes any params in oxmysql; cis_database refused it.
// Usage: node tests/repro/extra_params.js

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-extrap-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body VARCHAR(32) NOT NULL)');
m.close();

const code = 'const fx = require(' + JSON.stringify(HARNESS) + ');\n'
    + "const out = (k, v) => console.log('@' + k + '=' + JSON.stringify(v));\n"
    + "const run = (k, kind, sql, p) => new Promise((res) => fx.registry[kind](sql, p, (v, e) => { out(k, e != null ? { err: String(e) } : { v }); res(); }, 'test', true));\n"
    + '(async () => {\n'
    + "if (!(await fx.ready(20000))) throw new Error('not ready');\n"
    + "await run('ins', 'insert', 'INSERT INTO notes (body) VALUES (?)', ['a', 'b']);\n"
    + "await run('sel', 'query', 'SELECT ? AS x', [1, 2, 3]);\n"
    + "await run('in', 'query', 'SELECT id FROM notes WHERE id IN (?) AND body = ?', [[1, 2], 'a', 'extra']);\n"
    + "await run('none', 'scalar', 'SELECT COUNT(*) FROM notes', [5]);\n"
    + "await run('ok', 'insert', 'INSERT INTO notes (body) VALUES (?)', ['c']);\n"
    + "await run('rows', 'query', 'SELECT body FROM notes ORDER BY id', []);\n"
    + 'process.exit(0);\n'
    + "})().catch((e) => { console.log('CHILD ERROR ' + (e && e.stack)); process.exit(2); });";

const proc = spawnSync(process.execPath, ['-e', code], {
    env: Object.assign({}, process.env, { FX_RES_DIR: dir, FX_MARIA_FILE: mariaFile }),
    encoding: 'utf8',
    timeout: 90000,
});
const text = (proc.stdout || '') + (proc.stderr || '');
const vals = {};
for (const mm of text.matchAll(/^@(\w+)=(.*)$/gm)) vals[mm[1]] = JSON.parse(mm[2]);
const err = (k) => (vals[k] && vals[k].err) || '';

check('an insert with 2 values for 1 mark fails as in oxmysql', err('ins').includes('Expected 1 parameters, but received 2.'), JSON.stringify(vals.ins));
check('a select with 3 values for 1 mark fails', err('sel').includes('Expected 1 parameters, but received 3.'), JSON.stringify(vals.sel));
check('IN (?) counts as one mark, as in oxmysql, and the extra value fails', err('in').includes('Expected 2 parameters, but received 3.'), JSON.stringify(vals.in));
check('a statement with no mark takes any params', vals.none && vals.none.v === 0, JSON.stringify(vals.none));
check('a matching insert still runs', vals.ok && vals.ok.v === 1, JSON.stringify(vals.ok));
check('the refused insert left no row', vals.rows && JSON.stringify(vals.rows.v) === '[{"body":"c"}]', JSON.stringify(vals.rows));
if (proc.status !== 0) check('child ran', false, text.slice(-600));

fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
