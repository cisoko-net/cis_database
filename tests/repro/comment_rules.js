'use strict';

// Security review S5: dialect.js read MySQL comments with the rules reversed.
// MySQL starts a '--' comment only when the second dash is followed by a space
// or a control character, so 'SELECT 1--1' is 1 - (-1) = 2; '#' starts a
// comment anywhere outside a string, so 'SELECT 5#x' is 5. mapCode (caller
// SQL) and stripSqlComments (the first step of translate) treated every '--'
// as a comment and '#' only after a space. Each case runs the translation on
// a real node:sqlite database and compares with MariaDB's answer.
// Usage: node tests/repro/comment_rules.js

const path = require('path');
const dialect = require(path.join(__dirname, '..', '..', 'dialect.js'));
let DatabaseSync;
try {
    ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
    console.log('SKIP node:sqlite missing');
    process.exit(0);
}

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

const db = new DatabaseSync(':memory:');
function run(sql, params) {
    const t = dialect.translate(sql);
    try {
        const row = db.prepare(t.sql).get(...(params || []));
        return { v: row ? Object.values(row)[0] : undefined, sql: t.sql };
    } catch (e) {
        return { v: 'ERR ' + e.message, sql: t.sql };
    }
}

// Expected values are MariaDB's for the same text.
const cases = [
    ['SELECT 1--1', 2],
    ['SELECT 1-- 1', 1],
    ['SELECT 1--\t1', 1],
    ['SELECT 1---1', 0],
    ['SELECT 5#x', 5],
    ['SELECT 5 #x', 5],
    ["SELECT 'a#b--c'", 'a#b--c'],
];
for (const [sql, want] of cases) {
    const r = run(sql);
    check(JSON.stringify(sql) + ' is ' + JSON.stringify(want), r.v === want, JSON.stringify(r));
}

// Placeholders: what mapCode hands its callback is what binds.
function marks(sql) {
    let n = 0;
    dialect.mapCode(sql, (chunk) => { n += (chunk.match(/\?/g) || []).length; return chunk; });
    return n;
}
check('mapCode sees both ? in "?--?"', marks('SELECT ?--?') === 2, String(marks('SELECT ?--?')));
check('mapCode skips ? after #', marks('SELECT ?#?') === 1, String(marks('SELECT ?#?')));
check('mapCode skips ? after "-- "', marks('SELECT ? -- ?') === 1, String(marks('SELECT ? -- ?')));
const mapped = dialect.mapCode('SELECT 1--1', (c) => c);
check('mapCode output keeps the minus signs for SQLite', db.prepare(mapped).get()[Object.keys(db.prepare(mapped).get())[0]] === 2, mapped);
const p = run('SELECT ?--?', [5, 3]);
check('"?--?" binds both values', p.v === 8, JSON.stringify(p));
// Translated SQL (sqliteText) follows SQLite's rule: '--' is always a comment.
check('sqliteText keeps SQLite comments', dialect.mapCode('SELECT 1 --x', (c) => c, true) === 'SELECT 1 --x');

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
