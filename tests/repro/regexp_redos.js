'use strict';

// Security review S1: `WHERE x REGEXP ?` with a player-supplied pattern ran
// on the JS RegExp engine, which backtracks without a limit. `^(a+)+$`
// against 28 a's and a "!" held the FXServer thread for 10.7 s. REGEXP now
// runs on a matcher whose time grows with pattern size times value length.
// The second half checks that ordinary patterns still answer as MariaDB does.
// Usage: node tests/repro/regexp_redos.js

const { DatabaseSync } = require('node:sqlite');
const dialect = require('../../dialect.js');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

const db = new DatabaseSync(':memory:');
for (const f of dialect.sqlFunctions) db.function(f.name, { deterministic: true, useBigIntArguments: !!f.bigint }, f.fn);
db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
const ins = db.prepare('INSERT INTO users (name) VALUES (?)');
ins.run('a'.repeat(26) + '!');
ins.run('a'.repeat(3000) + '!');
ins.run('x'.repeat(5000));
const sel = db.prepare(dialect.translate('SELECT id FROM users WHERE name REGEXP ?').sql);

// Each of these backtracks exponentially or in a high power of the length on
// a backtracking engine. A safe matcher answers each in a few milliseconds.
const evil = ['^(a+)+$', '(a|a)*$', '(a|aa)+$', '(a*)*b', '^(\\w+\\s?)+$', 'a*a*a*a*a*a*a*a*a*b', '(.*a){12}', '^((a+)+)+$'];
for (const p of evil) {
    const t = Date.now();
    let rows;
    let err = null;
    try { rows = sel.all(p); } catch (e) { err = e.message; }
    const ms = Date.now() - t;
    check('REGEXP ' + p + ' answers in under 250 ms', ms < 250, ms + ' ms, ' + (err ? 'error ' + err : (rows.length + ' rows')));
}

// A huge counted repeat is refused rather than expanded without bound.
let big = null;
try { sel.all('(a{1000}){1000}'); } catch (e) { big = e.message; }
check('a pattern that expands past the size cap is refused with a reason', big && /REGEXP/.test(big), big);

// Ordinary patterns, against what MariaDB returns. MariaDB's _ci collations
// ignore case, so REGEXP does too.
const one = (p, v) => db.prepare('SELECT regexp(?, ?) AS r').get(p, v).r;
const cases = [
    ['^[0-9]{4}-', '2024-01', 1], ['^[0-9]{4}-', '202-01', 0],
    ['^A', 'ab', 1], ['b$', 'ab', 1], ['^b', 'ab', 0],
    ['^[[:alpha:]]+$', 'abcXYZ', 1], ['^[[:alpha:]]+$', 'abc1', 0],
    ['^[[:digit:][:space:]]+$', '12 34', 1], ['[[:<:]]cat[[:>:]]', 'a cat sat', 1], ['[[:<:]]cat[[:>:]]', 'concat', 0],
    ['colou?r', 'color', 1], ['colou?r', 'colour', 1], ['colou?r', 'colouur', 0],
    ['^(ab|cd)+$', 'abcdab', 1], ['^(ab|cd)+$', 'abca', 0],
    ['^a.c$', 'abc', 1], ['^a.c$', 'ac', 0], ['^a\\.c$', 'a.c', 1], ['^a\\.c$', 'abc', 0],
    ['^[^0-9]+$', 'abc', 1], ['^[^0-9]+$', 'ab1', 0],
    ['^\\d{3}-\\d{4}$', '555-1234', 1], ['^\\d{3}-\\d{4}$', '555-12345', 0],
    ['^\\w+@\\w+\\.com$', 'a_b@x.com', 1], ['\\s', 'nospace', 0], ['\\S+', '  x ', 1],
    ['^x{2,3}$', 'x', 0], ['^x{2,3}$', 'xx', 1], ['^x{2,3}$', 'xxx', 1], ['^x{2,3}$', 'xxxx', 0], ['^x{2,}$', 'xxxxx', 1],
    ['^(?:ab)*c$', 'ababc', 1], ['^[a-c-]+$', 'a-b', 1], ['^[]a]+$', ']a', 1],
    ['', 'anything', 1], ['ABC', 'xxabcxx', 1], ['^$', '', 1], ['a|b|c', 'zzc', 1], ['\\bfoo\\b', 'a foo b', 1], ['\\Bfoo', 'afoo', 1],
    ['^[A-Z]{3}[0-9]{5}$', 'ABC12345', 1], ['^license:[a-f0-9]{40}$', 'license:' + 'a1'.repeat(20), 1],
    ['^.*?x$', 'aax', 1], ['^a+?$', 'aaa', 1], ['^\\(1\\)$', '(1)', 1], ['^[\\]]$', ']', 1], ['^\\t$', '\t', 1],
];
let bad = [];
for (const [p, v, want] of cases) {
    let got;
    try { got = one(p, v); } catch (e) { got = 'error ' + e.message; }
    if (got !== want) bad.push(JSON.stringify(p) + ' on ' + JSON.stringify(v) + ' gave ' + got + ', MariaDB ' + want);
}
check('ordinary patterns answer as MariaDB does (' + cases.length + ' cases)', bad.length === 0, bad.join('; '));
check('NULL pattern or value gives NULL', one(null, 'a') === null && one('a', null) === null);

// Syntax this matcher does not run is refused with a reason, never matched wrongly.
for (const p of ['(a)\\1', '(?=a)', '(?<=a)b', 'a++', '(a']) {
    let err = null;
    try { one(p, 'aa'); } catch (e) { err = e.message; }
    check('unsupported or broken pattern ' + p + ' is an error that names REGEXP', err && /REGEXP/.test(err), err);
}

// The same through the engine as a resource calls it, so the function
// server.js registers on its own connection is the safe one too.
const fs = require('fs');
const os = require('os');
const path = require('path');
(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-rx-'));
    const mariaFile = path.join(dir, 'maria.sqlite');
    new DatabaseSync(mariaFile).close();
    process.env.FX_RES_DIR = dir;
    process.env.FX_MARIA_FILE = mariaFile;
    const fx = require('../harness/fx.js');
    const r = fx.registry;
    const call = (k, sql, p) => new Promise((res) => r[k](sql, p || [], (v, err) => res({ v: err ? false : v, err }), 'test', true));
    await fx.ready(20000);
    await call('query', 'CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT)');
    await call('insert', 'INSERT INTO players (name) VALUES (?)', ['a'.repeat(28) + '!']);
    const t = Date.now();
    const q = await call('query', 'SELECT id FROM players WHERE name REGEXP ?', ['^(a+)+$']);
    const ms = Date.now() - t;
    check('engine: player pattern ^(a+)+$ answers in under 250 ms', ms < 250 && Array.isArray(q.v) && q.v.length === 0, ms + ' ms ' + JSON.stringify(q));
    const g = await call('query', 'SELECT id FROM players WHERE name RLIKE ?', ['^A+!$']);
    check('engine: RLIKE still matches, ignoring case', Array.isArray(g.v) && g.v.length === 1, JSON.stringify(g));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
