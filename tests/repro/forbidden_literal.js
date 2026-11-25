'use strict';

// The guard that refuses ATTACH, DETACH, load_extension, VACUUM INTO and
// cis_database's own __cis_ tables matched those words anywhere outside a
// comment, string values included: a player note reading "please attach the
// file" was refused as blocked SQL. The words are refused in code only, and a
// statement counts as code if either MySQL's or SQLite's reading of its
// quotes leaves the word outside a string, so a backslash cannot hide one.
// SQLite also calls a quoted function name ("load_extension"(...)), so the
// guard sees through the quotes.
// Usage: node tests/repro/forbidden_literal.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const dialect = require('../../dialect.js');

const HARNESS = path.join(__dirname, '..', 'harness', 'fx.js');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

const refused = [
    "ATTACH DATABASE 'x.db' AS y",
    "attach 'x.db' as y",
    'DETACH DATABASE y',
    "SELECT load_extension('x')",
    "SELECT \"load_extension\"('x')",
    "SELECT `load_extension` ('x')",
    "VACUUM INTO 'x.db'",
    "VACUUM main INTO 'x.db'",
    "vacuum temp into 'x.db'",
    'VACUUM "main" INTO \'x.db\'',
    "VACUUM `main` INTO 'x.db'",
    "VACUUM [main] INTO 'x.db'",
    "VACUUM\"main\"INTO'x.db'",
    "VACUUM /* c */ main /* c */ INTO 'x.db'",
    "SELECT 1; VACUUM main INTO 'x.db'",
    'SELECT * FROM __cis_outbox',
    'SELECT * FROM `__cis_outbox`',
    "SELECT 'a\\' ATTACH DATABASE 'x.db' AS y",
    "SELECT 'a' /* c */ ATTACH",
];
for (const s of refused) check('refused: ' + s, dialect.isForbiddenSql(s));

const allowed = [
    "INSERT INTO notes (body) VALUES ('please attach the file')",
    "SELECT 'detach me' AS w",
    "SELECT \"Attach it\" AS w",
    "SELECT 'load_extension(1)' AS w",
    "SELECT 'it''s __cis_ text' AS w",
    "SELECT 'vacuum into the bag' AS w",
    "SELECT 'vacuum main into the bag' AS w",
    'VACUUM',
    'VACUUM main',
];
for (const s of allowed) check('allowed: ' + s, !dialect.isForbiddenSql(s));

// The same through the engine: the write runs, the value round-trips.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-forbid-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body VARCHAR(64) NOT NULL)');
m.close();
const code = 'const fx = require(' + JSON.stringify(HARNESS) + ');\n'
    + "const out = (k, v) => console.log('@' + k + '=' + JSON.stringify(v));\n"
    + "const run = (k, kind, sql, p) => new Promise((res) => fx.registry[kind](sql, p, (v, e) => { out(k, e != null ? { err: String(e) } : { v }); res(); }, 'test', true));\n"
    + '(async () => {\n'
    + "if (!(await fx.ready(20000))) throw new Error('not ready');\n"
    + "await run('ins', 'insert', \"INSERT INTO notes (body) VALUES ('please attach the file')\", []);\n"
    + "await run('sel', 'scalar', \"SELECT body FROM notes WHERE body LIKE '%attach%'\", []);\n"
    + "await run('att', 'query', \"ATTACH DATABASE 'x.db' AS y\", []);\n"
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
check('a write whose value says "attach" runs', vals.ins && vals.ins.v === 1, JSON.stringify(vals.ins));
check('the value reads back', vals.sel && vals.sel.v === 'please attach the file', JSON.stringify(vals.sel));
check('a real ATTACH is still blocked', vals.att && /blocked SQL/.test(vals.att.err || ''), JSON.stringify(vals.att));
if (proc.status !== 0) check('child ran', false, text.slice(-600));

fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
