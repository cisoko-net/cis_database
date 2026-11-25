'use strict';

// A Lua table reaches JS as an object keyed '1', '2', ... and luaValues
// filled the gaps up to the largest key. { [2000000000] = 'x' } built a
// two-billion-slot array on the server thread: a hang, then out of memory.
// MySQL takes at most 65535 placeholders, so a larger key is refused with a
// reason before any array is built. { nil, 'b' } still binds NULL, 'b'.
// Usage: node tests/repro/lua_sparse_params.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-sparse-'));
const mariaFile = path.join(dir, 'maria.sqlite');
new DatabaseSync(mariaFile).close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;

const fx = require('../harness/fx.js');
const r = fx.registry;
const call = (k, sql, p) => new Promise((res) => r[k](sql, p, (v, err) => res(err ? { err: String(err) } : v), 'test', true));

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const HUGE = { 2000000000: 'x' };

async function timed(fn) {
    const t = Date.now();
    const v = await fn();
    return { v, ms: Date.now() - t };
}

(async () => {
    check('engine ready', await fx.ready(20000));
    await call('query', 'CREATE TABLE t (id INT PRIMARY KEY, a VARCHAR(8), b VARCHAR(8))', []);
    let q = await timed(() => call('query', 'SELECT ? AS v', HUGE));
    check('a sparse params table is refused fast', q.v && q.v.err && /65535/.test(q.v.err) && q.ms < 2000, JSON.stringify(q.v).slice(0, 120) + ' ' + q.ms + 'ms');
    q = await timed(() => call('query', 'SELECT id FROM t WHERE id IN (?)', [HUGE]));
    check('a sparse IN list is refused fast', q.v && q.v.err && /65535/.test(q.v.err) && q.ms < 2000, JSON.stringify(q.v).slice(0, 120) + ' ' + q.ms + 'ms');
    q = await timed(() => call('transaction', { 2000000000: 'INSERT INTO t (id) VALUES (9)' }));
    check('a sparse transaction list is refused fast', q.v !== true && q.ms < 2000, JSON.stringify(q.v).slice(0, 120) + ' ' + q.ms + 'ms');
    const many = (items) => Promise.race([
        new Promise((res) => r.execMany(items, (v, err) => res({ v, err: err ? String(err) : null }))),
        new Promise((res) => setTimeout(() => res({ hung: true }), 3000)),
    ]);
    let m = await many({ 2000000000: { query: 'INSERT INTO t (id) VALUES (8)' } });
    check('a sparse execMany list calls back false with the reason', m.v === false && /65535/.test(m.err || ''), JSON.stringify(m).slice(0, 120));
    // execMany kinds: only the named result shapes.
    m = await many([{ kind: 'transaction', sql: 'INSERT INTO t (id) VALUES (7); INSERT INTO t (id) VALUES (6)' }]);
    check('execMany refuses kind transaction', m.v === false && /kind/.test(m.err || ''), JSON.stringify(m).slice(0, 120));
    m = await many([{ kind: 'nope', sql: 'SELECT 1' }]);
    check('execMany refuses an unknown kind', m.v === false && /kind/.test(m.err || ''), JSON.stringify(m).slice(0, 120));
    m = await many([{ kind: 'scalar', sql: 'SELECT 5' }, { sql: 'SELECT 6 AS v' }]);
    check('execMany still runs scalar and the default query', m.v && m.v[0] === 5 && m.v[1][0].v === 6, JSON.stringify(m).slice(0, 120));
    const n = await call('scalar', 'SELECT COUNT(*) FROM t', []);
    check('nothing was written', Number(n) === 0, String(n));
    // Lua { nil, 'b' } arrives with key 2 only.
    await call('insert', 'INSERT INTO t (id, a, b) VALUES (1, ?, ?)', { 2: 'b' });
    const row = await call('single', 'SELECT a, b FROM t WHERE id = 1', []);
    check('{ nil, \'b\' } still binds NULL, b', row && row.a === null && row.b === 'b', JSON.stringify(row));
    const ids = await call('query', 'SELECT id FROM t WHERE id IN (?)', [{ 1: 1, 3: 5 }]);
    check('a small sparse IN list still works', Array.isArray(ids) && ids.length === 1, JSON.stringify(ids));
    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
