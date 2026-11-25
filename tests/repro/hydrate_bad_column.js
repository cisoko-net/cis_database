'use strict';

// A MariaDB column whose name cis_database will not quote into SQL (a space,
// a non-ASCII letter, a reserved key such as __proto__) was left out of the
// SQLite table, but the copy still listed it in every INSERT, taken from the
// row MariaDB returned. Each INSERT failed, so the copy failed, and a first
// install retried it forever behind "MariaDB still not answering" while
// MariaDB was answering. The copy leaves that column out of the INSERT too,
// says so once, and the rest of the table arrives.
// Usage: node tests/repro/hydrate_bad_column.js

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-badcol-'));
const mariaFile = path.join(dir, 'maria.sqlite');
{
    const m = new DatabaseSync(mariaFile);
    m.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT, "my note" TEXT)');
    m.exec("INSERT INTO notes (id, body, \"my note\") VALUES (1, 'a', 'x'), (2, 'b', 'y')");
    m.exec('CREATE TABLE other (id INTEGER PRIMARY KEY, v TEXT)');
    m.exec("INSERT INTO other (id, v) VALUES (1, 'z')");
    m.close();
}
const code = 'const fx = require(' + JSON.stringify(HARNESS) + ');\n'
    + "const out = (k, v) => console.log('@' + k + '=' + JSON.stringify(v));\n"
    + "const run = (k, kind, sql, p) => new Promise((res) => fx.registry[kind](sql, p, (v, e) => { out(k, e != null ? { err: String(e) } : { v }); res(); }, 'test', true));\n"
    + '(async () => {\n'
    + "out('ready', !!(await fx.ready(15000)));\n"
    + "await run('notes', 'query', 'SELECT id, body FROM notes ORDER BY id', []);\n"
    + "await run('other', 'scalar', 'SELECT v FROM other WHERE id = 1', []);\n"
    + 'process.exit(0);\n'
    + "})().catch((e) => { console.log('CHILD ERROR ' + (e && e.stack)); process.exit(2); });";
const proc = spawnSync(process.execPath, ['-e', code], {
    env: Object.assign({}, process.env, { FX_RES_DIR: dir, FX_MARIA_FILE: mariaFile }),
    encoding: 'utf8',
    timeout: 60000,
});
const text = (proc.stdout || '') + (proc.stderr || '');
const vals = {};
for (const mm of text.matchAll(/^@(\w+)=(.*)$/gm)) vals[mm[1]] = JSON.parse(mm[2]);
check('a first install becomes ready', vals.ready === true, 'ready=' + vals.ready);
check('the table with the odd column is copied', vals.notes && JSON.stringify(vals.notes.v) === JSON.stringify([{ id: 1, body: 'a' }, { id: 2, body: 'b' }]), JSON.stringify(vals.notes));
check('the other table is copied', vals.other && vals.other.v === 'z', JSON.stringify(vals.other));
check('the left-out column is named in a warning', /my note/.test(text) && !/still not answering/.test(text), (text.match(/.*(my note|not answering).*/) || [''])[0].slice(0, 200));

fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
