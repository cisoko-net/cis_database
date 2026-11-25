'use strict';

// Every path through padParams (server.js), the guard that fits a caller's
// value list to the statement's placeholders before SQLite and the MariaDB
// copy see it, as oxmysql's parseArguments does (v2.14.3): as many values as
// marks passes as is, fewer are padded with null, more throw "Expected N
// parameters, but received M.", and a statement with no mark drops its
// values. The quick count takes every ?; a statement with a quote or a
// comment is counted again by placeholderOffsets, which skips a ? inside a
// string, an identifier or a comment. Padding is counted before IN (?) lists
// expand. Each write is checked on the MariaDB copy too (invariant 2).
// Usage: node tests/repro/pad_params.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-pad-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec([
    'CREATE TABLE users (identifier VARCHAR(64) PRIMARY KEY, money INT NOT NULL)',
    "INSERT INTO users VALUES ('a', 10), ('b', 20), ('c', 30)",
    'CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, msg VARCHAR(64), n INT)',
].join(';\n'));
m.close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;
process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: 'mysql://root@127.0.0.1/fake', cis_database_cdc: '0' });

const fx = require('../harness/fx.js');
const r = fx.registry;

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const show = (x) => JSON.stringify(x);

// MySQL.<method>(sql, p, cb) with the include's error flag: a failure comes
// back as { err }.
const call = (kind, sql, p) => new Promise((res) => r[kind](sql, p, (v, e) => res(e != null ? { err: String(e) } : { v }), 'pad_res', true));
// MySQL.<method>.await on the fast path.
const answers = [];
async function callFast(kind, sql, p) {
    const x = r.cis_call(kind, sql, p);
    if (!x || x[0] === 2) return { err: String(x && x[1]) };
    if (x[0] === 1) return { v: x[1] };
    const end = Date.now() + 5000;
    while (Date.now() < end && !answers.some((a) => a.id === x[1])) await sleep(10);
    const a = answers.find((y) => y.id === x[1]);
    if (!a) return { err: 'no answer for call ' + x[1] };
    return a.err != null && a.err !== '' ? { err: String(a.err) } : { v: a.result };
}
const mariaRows = (sql) => {
    const mm = new DatabaseSync(mariaFile);
    try { return show(mm.prepare(sql).all()); } finally { mm.close(); }
};
async function drained(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end && r.probe().replica > 0) await sleep(20);
    return r.probe().replica === 0;
}

// [name, sql, params, want]; want is the rows, or { err } for a substring of
// the error.
const READS = [
    ['as many values as marks (quick count)', 'SELECT ? AS a, ? AS b', [1, 2], [{ a: 1, b: 2 }]],
    ['a quote with no ? in it, counted again', "SELECT 'x' AS s, ? AS a", [1], [{ s: 'x', a: 1 }]],
    ['? in a single-quoted string', "SELECT '?' AS s, ? AS a", [1], [{ s: '?', a: 1 }]],
    ['? in a double-quoted string', 'SELECT "?" AS s, ? AS a', [1], [{ s: '?', a: 1 }]],
    ['? in a backtick name', 'SELECT ? AS `q?`', [1], [{ 'q?': 1 }]],
    ['? in a block comment', 'SELECT ? AS a /* ? */', [1], [{ a: 1 }]],
    ['? in a dash comment', 'SELECT ? AS a -- ?\n', [1], [{ a: 1 }]],
    ['? in a hash comment', 'SELECT ? AS a # ?\n', [1], [{ a: 1 }]],
    ['? after a backslash-escaped quote', "SELECT 'it\\'s ?' AS s, ? AS a", [1], [{ s: "it's ?", a: 1 }]],
    ['? after a doubled quote', "SELECT 'it''s ?' AS s, ? AS a", [1], [{ s: "it's ?", a: 1 }]],
    ['no mark: values dropped', 'SELECT 1 AS n', [5], [{ n: 1 }]],
    ['no mark outside a string: values dropped', "SELECT '?' AS s", [5], [{ s: '?' }]],
    ['more values than marks raises', 'SELECT ? AS a', [1, 2], { err: 'Expected 1 parameters, but received 2.' }],
    ['more values than marks outside a string raises', "SELECT '?' AS s, ? AS a", [1, 2], { err: 'Expected 1 parameters, but received 2.' }],
    ['fewer values are padded with null', 'SELECT ? AS a, ? AS b', [1], [{ a: 1, b: null }]],
    ['padded beside a ? in a string', "SELECT '?' AS s, ? AS a, ? AS b", [1], [{ s: '?', a: 1, b: null }]],
    ['no values at all are padded', 'SELECT ? AS a', [], [{ a: null }]],
    ['quick count stops early, then padded', "SELECT '???' AS s, ? AS a", [], [{ s: '???', a: null }]],
    ['padding counted before IN (?) expands', 'SELECT identifier FROM users WHERE identifier IN (?) OR identifier = ? ORDER BY identifier', [['a', 'c']], [{ identifier: 'a' }, { identifier: 'c' }]],
    ['an IN list and one value too many raises', 'SELECT identifier FROM users WHERE identifier IN (?)', [['a'], 'x'], { err: 'Expected 1 parameters, but received 2.' }],
];

function judge(label, got, want) {
    if (want && !Array.isArray(want) && typeof want === 'object' && 'err' in want) {
        check(label, got.err != null && got.err.includes(want.err), show(got));
    } else {
        check(label, got.err == null && show(got.v) === show(want), show(got));
    }
}

(async () => {
    check('engine ready', await fx.ready(20000));
    global.__fxInvoker = 'pad_res';
    r.cis_register((id, result, err) => answers.push({ id, result, err }));

    for (const [name, sql, p, want] of READS) judge('query: ' + name, await call('query', sql, p), want);
    for (const [name, sql, p, want] of READS) judge('fast path: ' + name, await callFast('query', sql, p), want);

    // Writes: SQLite and the MariaDB copy must end with the same rows.
    const ins = 'INSERT INTO logs (msg, n) VALUES (?, ?)';
    judge('insert padded with null', await call('insert', ins, ['only']), 1);
    judge('insert with ? in a string, padded', await call('insert', "INSERT INTO logs (msg, n) VALUES ('q?', ?)", []), 2);
    judge('insert with ? in a comment', await call('insert', ins + ' /* ? */', ['c', 3]), 3);
    judge('prepare insert padded with null', await call('prepare', ins, ['p1']), 4);
    judge('rawExecute insert padded with null', (await call('rawExecute', ins, ['r1'])).err ? { err: 'failed' } : { v: 'ok' }, 'ok');
    judge('update with one value too many raises', await call('update', 'UPDATE logs SET n = ? WHERE msg = ?', [1, 'only', 3]), { err: 'Expected 2 parameters, but received 3.' });
    judge('delete with no mark drops its values', await call('update', "DELETE FROM logs WHERE msg = 'none?'", [9]), 0);
    judge('update padded with null', await call('update', 'UPDATE logs SET n = ? WHERE msg = ?', [7]), 0);
    judge('update with ? in a string', await call('update', "UPDATE logs SET n = ? WHERE msg = 'q?'", [8]), 1);

    const logsSql = 'SELECT id, msg, n FROM logs ORDER BY id';
    const want = '[{"id":1,"msg":"only","n":null},{"id":2,"msg":"q?","n":8},{"id":3,"msg":"c","n":3},{"id":4,"msg":"p1","n":null},{"id":5,"msg":"r1","n":null}]';
    const local = await call('query', logsSql, []);
    check('SQLite holds the padded rows, and the refused update changed nothing', show(local.v) === want, show(local));
    if (r.flushReplica) fx.asSelf(() => r.flushReplica());
    check('the MariaDB queue drains', await drained(10000), 'replica ' + r.probe().replica);
    check('MariaDB has the same rows', mariaRows(logsSql) === want, mariaRows(logsSql));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
