'use strict';

// Security review F7: applyModePragmas pasted config.json's sqlite values
// (journal_mode, synchronous, locking_mode, wal_autocheckpoint) into PRAGMA
// text, so a bad value ran as SQL on the game database. config.json is the
// server owner's file, but a typo or a pasted value should not become SQL.
// Each value is now checked against SQLite's own list; anything else falls
// back to the default with a warning.
// Usage: node tests/repro/pragma_allowlist.js

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
function lift(name) {
    const a = src.indexOf('function ' + name + '(');
    const b = src.indexOf('\nfunction ', a + 10);
    return src.slice(a, b);
}

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

function run(mode, sqlite) {
    const ran = [];
    const warned = [];
    const log = { warn: (m) => warned.push(m), info() {}, debug() {}, error() {} };
    // eslint-disable-next-line no-new-func
    const apply = new Function('cfg', 'storageMode', 'log', lift('applyModePragmas') + '\nreturn applyModePragmas;')({ sqlite }, mode, log);
    apply({ exec: (s) => ran.push(s) });
    return { ran, warned };
}
const has = (r, s) => r.ran.indexOf(s) >= 0;
const odd = (r) => r.ran.filter((s) => !/^PRAGMA [a-z_]+=-?[A-Za-z0-9]+$/.test(s));

let r = run('durable', { journal_mode: 'WAL', synchronous: 'NORMAL', wal_autocheckpoint: 0 });
check('good durable values pass', has(r, 'PRAGMA journal_mode=WAL') && has(r, 'PRAGMA synchronous=NORMAL') && has(r, 'PRAGMA wal_autocheckpoint=0') && r.warned.length === 0, r.ran.join('; '));
r = run('durable', { journal_mode: 'truncate', synchronous: '2', wal_autocheckpoint: 1000 });
check('other valid values pass', has(r, 'PRAGMA journal_mode=TRUNCATE') && has(r, 'PRAGMA synchronous=2') && has(r, 'PRAGMA wal_autocheckpoint=1000'), r.ran.join('; '));
r = run('durable', { journal_mode: 'WAL; DROP TABLE users', synchronous: 'NORMAL; DELETE FROM x', wal_autocheckpoint: '0; DROP TABLE y' });
check('injected durable values never run', odd(r).length === 0, odd(r).join(' | '));
check('they fall back to the defaults', has(r, 'PRAGMA journal_mode=WAL') && has(r, 'PRAGMA synchronous=NORMAL') && has(r, 'PRAGMA wal_autocheckpoint=0'), r.ran.join('; '));
check('and say so', r.warned.length >= 3, r.warned.length + ' warnings');
r = run('performance', { locking_mode: 'EXCLUSIVE; DROP TABLE users', synchronous: 'OFF' });
check('injected locking_mode never runs', odd(r).length === 0 && has(r, 'PRAGMA locking_mode=EXCLUSIVE'), odd(r).join(' | '));
check('performance keeps synchronous=0', has(r, 'PRAGMA synchronous=0'), r.ran.join('; '));

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
