'use strict';

// Security review S4: expandBulk found the `?` for SET ? and VALUES ? with
// its own scanner, which counted a `?` inside a comment or a backtick name.
// `UPDATE users /* who? */ SET ? WHERE id = ?` bound the object to the
// comment's `?`, and SQLite ran it as SELECT 1: the write was lost while the
// replica applied it. expandBulk now uses placeholderOffsets, the scanner
// translation uses. expandBulk is lifted out of server.js and its output runs
// on node:sqlite.
// Usage: node tests/repro/bulk_comments.js

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const dialect = require('../../dialect.js');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
function grab(name) {
    const i = src.indexOf('function ' + name + '(');
    let d = 0;
    let j = src.indexOf('{', i);
    for (; j < src.length; j++) {
        if (src[j] === '{') d++;
        else if (src[j] === '}' && --d === 0) break;
    }
    return src.slice(i, j + 1);
}
// eslint-disable-next-line no-new-func
const expandBulk = new Function('dialect', ['plainObject', 'quoteAssign', 'placeholderOffsets', 'expandBulk'].map(grab).join('\n') + '\nreturn expandBulk;')(dialect);

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

function run(sql, params, setup) {
    const db = new DatabaseSync(':memory:');
    for (const f of dialect.sqlFunctions) db.function(f.name, { deterministic: true, useBigIntArguments: !!f.bigint }, f.fn);
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, `who?` TEXT, note TEXT)');
    db.exec("INSERT INTO users (id, name) VALUES (1, 'old')");
    if (setup) setup(db);
    const e = expandBulk(sql, params);
    const t = dialect.translate(e.sql);
    db.prepare(t.sql).run(...e.params);
    const rows = db.prepare('SELECT id, name, note FROM users ORDER BY id').all().map((r) => Object.assign({}, r));
    db.close();
    return { e, t: t.sql, rows };
}

const cases = [
    ['block comment with ?', 'UPDATE users /* who? */ SET ? WHERE id = ?', [{ name: 'new' }, 1], (r) => r.rows[0].name === 'new'],
    ['line comment with ?', 'UPDATE users SET ? -- who?\nWHERE id = ?', [{ name: 'new' }, 1], (r) => r.rows[0].name === 'new'],
    ['hash comment with ?', 'UPDATE users SET ? # who?\nWHERE id = ?', [{ name: 'new' }, 1], (r) => r.rows[0].name === 'new'],
    ['backtick name with ?', 'UPDATE users SET ? WHERE `who?` IS NULL AND id = ?', [{ name: 'new' }, 1], (r) => r.rows[0].name === 'new'],
    ['string with ? after SET ?', "UPDATE users SET ? WHERE name <> 'why?' AND id = ?", [{ name: 'new' }, 1], (r) => r.rows[0].name === 'new'],
    ['escaped quote in a string', "UPDATE users SET ? WHERE name <> 'it\\'s?' AND id = ?", [{ name: 'new' }, 1], (r) => r.rows[0].name === 'new'],
    ['VALUES ? after a comment with ?', 'INSERT INTO users (id, name) /* ? */ VALUES ?', [[[2, 'a'], [3, 'b']]], (r) => r.rows.length === 3 && r.rows[2].name === 'b'],
    ['plain SET ?', 'UPDATE users SET ? WHERE id = ?', [{ name: 'new', note: 'n' }, 1], (r) => r.rows[0].name === 'new' && r.rows[0].note === 'n'],
];
for (const [name, sql, params, ok] of cases) {
    let r = null;
    let err = null;
    try { r = run(sql, params); } catch (e) { err = e.message; }
    check(name, r && ok(r), err || (r.t + '  ' + JSON.stringify(r.e.params) + '  ' + JSON.stringify(r.rows)));
}

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
