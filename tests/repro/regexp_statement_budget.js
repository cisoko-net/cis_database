'use strict';

// Security review N1: the REGEXP matcher capped its work per call, at
// RX_MAX_WORK steps (pattern size times value length), but a statement calls
// it once per row. `WHERE note REGEXP ?` with a large player-supplied pattern
// over a table of long values stayed under the cap on every row and held the
// server thread for the sum of all of them. The cap is now shared by every
// call in one synchronous run (one statement), and the next run starts over.
// Usage: node tests/repro/regexp_statement_budget.js

const { DatabaseSync } = require('node:sqlite');
const dialect = require('../../dialect.js');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

const ROWS = 200;
const db = new DatabaseSync(':memory:');
for (const f of dialect.sqlFunctions) db.function(f.name, { deterministic: true, useBigIntArguments: !!f.bigint }, f.fn);
db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, note TEXT)');
const ins = db.prepare('INSERT INTO notes (note) VALUES (?)');
db.exec('BEGIN');
for (let i = 0; i < ROWS; i++) ins.run('b'.repeat(20000));
db.exec('COMMIT');
const sel = db.prepare(dialect.translate('SELECT id FROM notes WHERE note REGEXP ?').sql);

// About 2,000 program steps against 20,000 characters: 40 million steps a
// row, under the per-call cap, and every state stays live on each character.
const big = '(?:' + 'b?'.repeat(600) + ')c';

(async () => {
    const t = Date.now();
    let err = null;
    let rows = null;
    try { rows = sel.all(big); } catch (e) { err = e.message; }
    const ms = Date.now() - t;
    check('a REGEXP statement over many long rows is cut off under 3000 ms', ms < 3000, ms + ' ms, ' + (err ? 'error ' + err : rows.length + ' rows'));
    check('it fails with a reason that names REGEXP', err && /REGEXP/.test(err), err);

    // The budget belongs to that statement: the next one, after the event
    // loop turned, matches as usual.
    await new Promise((r) => setImmediate(r));
    const small = sel.all('^b+$');
    check('the next statement matches every row', small.length === ROWS, small.length + ' rows');
    const one = db.prepare('SELECT regexp(?, ?) AS r').get('^b{3}$', 'bbb').r;
    check('a single small match still answers 1', one === 1, String(one));

    // The budget counts steps taken, not the worst case: an ordinary pattern
    // over a big table of identifiers still answers.
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, license TEXT)');
    const ul = db.prepare('INSERT INTO users (license) VALUES (?)');
    db.exec('BEGIN');
    for (let i = 0; i < 50000; i++) ul.run('license:' + i.toString(16).repeat(20));
    db.exec('COMMIT');
    await new Promise((r) => setImmediate(r));
    let n = null;
    try { n = db.prepare(dialect.translate('SELECT COUNT(*) AS c FROM users WHERE license REGEXP ?').sql).get('[0-9]{3}$').c; } catch (e) { n = e.message; }
    check('an ordinary pattern over 50,000 rows answers', typeof n === 'number' && n > 0, String(n));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
