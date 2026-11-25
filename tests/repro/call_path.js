'use strict';

// The .await fast path lib/MySQL.lua uses: cis_register once per resource,
// then cis_call returns [1, result] / [2, message] when the statement ran at
// once, [0, id] when the slice budget held it back (the resolver answers
// later), and [3] for a resource with no resolver. Results must be the same
// as the callback exports give.
// Usage: node tests/repro/call_path.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-callpath-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE users (identifier VARCHAR(64) PRIMARY KEY, money INT NOT NULL); CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, seq INT)');
const ins = m.prepare('INSERT INTO users VALUES (?, ?)');
for (let i = 0; i < 100; i++) ins.run('id' + i, i);
m.close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;
process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: 'mysql://root@127.0.0.1/fake', cis_database_cdc: '0' });

const fx = require('../harness/fx.js');
const r = fx.registry;

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Each check starts a fresh slice, so the budget does not hold it back.
const turn = () => new Promise((res) => setTimeout(res, 10));
let answers = [];
// A write is answered after the WAL sync (cis_database_ack power, the
// default), so it comes back as [0, id] and then through the resolver.
async function done(x) {
    if (!x || x[0] !== 0) return x;
    const end = Date.now() + 5000;
    while (Date.now() < end && !answers.some((a) => a.id === x[1])) await turn();
    const a = answers.find((y) => y.id === x[1]);
    if (!a) return ['timeout', x[1]];
    return a.err != null ? [2, a.err] : [1, a.result];
}

(async () => {
    if (!(await fx.ready(20000))) throw new Error('not ready');
    global.__fxInvoker = 'some_script';
    await turn();
    check('a resource without a resolver gets [3]', same(r.cis_call('query', 'SELECT 1 AS n', []), [3]));
    await turn();
    check('cis_register accepts a function', r.cis_register((id, result, err) => answers.push({ id, result, err })) === true);
    await turn();
    check('and refuses anything else', r.cis_register('nope') === false);

    const viaCb = await fx.call('query', 'SELECT identifier, money FROM users WHERE money < ? ORDER BY money', [3]);
    await turn();
    const fast = r.cis_call('query', 'SELECT identifier, money FROM users WHERE money < ? ORDER BY money', [3]);
    await turn();
    check('a query that runs at once is returned as [1, rows]', fast[0] === 1 && same(fast[1], viaCb), JSON.stringify(fast));
    await turn();
    check('single', same(r.cis_call('single', 'SELECT money FROM users WHERE identifier = ?', ['id7']), [1, { money: 7 }]));
    await turn();
    check('single with no row', same(r.cis_call('single', 'SELECT money FROM users WHERE identifier = ?', ['none']), [1, null]));
    await turn();
    check('scalar', same(r.cis_call('scalar', 'SELECT COUNT(*) FROM users', []), [1, 100]));
    await turn();
    const fsyncBefore = r.probe().fsync_n;
    const raw1 = r.cis_call('insert', 'INSERT INTO logs (seq) VALUES (?)', [1]);
    const id1 = await done(raw1);
    await turn();
    check('insert returns the id', same(id1, [1, 1]), JSON.stringify(id1));
    await turn();
    check('a write is answered once the WAL is synced', raw1[0] === 0 && r.probe().fsync_n > fsyncBefore, JSON.stringify(raw1) + ' fsyncs ' + fsyncBefore + ' -> ' + r.probe().fsync_n);
    await turn();
    check('update returns rows changed', same(await done(r.cis_call('update', 'UPDATE users SET money = money + 1 WHERE money < ?', [10])), [1, 10]));
    await turn();
    const tx = await done(r.cis_call('transaction', [{ query: 'UPDATE users SET money = ? WHERE identifier = ?', values: [500, 'id1'] }, { query: 'INSERT INTO logs (seq) VALUES (?)', values: [2] }]));
    await turn();
    check('transaction', same(tx, [1, true]), JSON.stringify(tx));
    await turn();
    // A read SQLite cannot run is asked of MariaDB, so its error comes back
    // through the resolver.
    const bad = r.cis_call('query', 'SELECT * FROM no_such_table', []);
    const badEnd = Date.now() + 5000;
    while (bad[0] === 0 && Date.now() < badEnd && !answers.some((a) => a.id === bad[1])) await turn();
    const badAnswer = bad[0] === 0 ? answers.find((a) => a.id === bad[1]) : null;
    await turn();
    check('an error is [2, message], or (id, nil, message) through the resolver',
        (bad[0] === 2 && /no such table/i.test(bad[1])) || (badAnswer && badAnswer.result === null && /no such table/i.test(badAnswer.err)),
        JSON.stringify(bad) + ' ' + JSON.stringify(badAnswer));
    answers = [];
    await turn();
    const badTx = r.cis_call('transaction', [{ query: 'UPDATE users SET money = 1 WHERE identifier = ?', values: ['id2'] }, { query: 'INSERT INTO nope VALUES (1)' }]);
    await turn();
    // oxmysql resolves a failed transaction as false (review H2).
    check('a failed transaction is [1, false] and rolls back', badTx[0] === 1 && badTx[1] === false
        && same(r.cis_call('scalar', 'SELECT money FROM users WHERE identifier = ?', ['id2']), [1, 3]), JSON.stringify(badTx));
    await turn();
    check('an unknown method is refused', r.cis_call('drop', 'x', [])[0] === 2);

    // A burst past the slice budget: the rest is held back and answered
    // through the resolver, in order, with the same results.
    await turn();
    const out = [];
    for (let i = 0; i < 4000; i++) out.push(r.cis_call('insert', 'INSERT INTO logs (seq) VALUES (?)', [1000 + i]));
    const held = out.filter((x) => x[0] === 0);
    const end = Date.now() + 10000;
    while (Date.now() < end && answers.length < held.length) await new Promise((res) => setTimeout(res, 10));
    const byId = new Map(answers.map((a) => [a.id, a]));
    const ids = out.map((x) => (x[0] === 1 ? x[1] : (byId.get(x[1]) || {}).result));
    const inOrder = ids.every((v, i) => i === 0 || v === ids[i - 1] + 1);
    await turn();
    check('a burst is partly held back and answered through the resolver', held.length > 0 && answers.length === held.length && answers.every((a) => a.err === null),
        held.length + ' of 4000 held, ' + answers.length + ' answered');
    await turn();
    check('every insert got its own id, in order', inOrder && ids.length === 4000, 'first ' + ids[0] + ' last ' + ids[ids.length - 1]);

    // A resource that registers with version 2 gets answers in batches:
    // fn(0, n, ids, results, errors), at most 32 at a time.
    global.__fxInvoker = 'batch_script';
    const calls = [];
    r.cis_register((id, a, b, c, d) => { calls.push(id === 0 ? { n: a, ids: b, results: c, errs: d } : { n: 1, ids: [id], results: [a], errs: [b] }); }, 2);
    await turn();
    const sent = [];
    for (let i = 0; i < 200; i++) sent.push(r.cis_call('insert', 'INSERT INTO logs (seq) VALUES (?)', [5000 + i]));
    const waiting = sent.filter((x) => x[0] === 0).map((x) => x[1]);
    const endB = Date.now() + 10000;
    const got = () => calls.reduce((s, c) => s + c.n, 0);
    while (Date.now() < endB && got() < waiting.length) await turn();
    const seen = new Set();
    calls.forEach((c) => c.ids.forEach((x) => seen.add(x)));
    check('answers come over in batches of at most 32', got() === waiting.length && waiting.every((x) => seen.has(x))
        && calls.length < waiting.length && calls.every((c) => c.n <= 32 && c.errs.every((e) => e == null)),
        waiting.length + ' answers in ' + calls.length + ' calls');
    const resultsInOrder = [];
    calls.forEach((c) => c.results.forEach((v) => resultsInOrder.push(v)));
    check('each batched insert has its id', resultsInOrder.every((v, i) => i === 0 || v === resultsInOrder[i - 1] + 1), 'first ' + resultsInOrder[0] + ' last ' + resultsInOrder[resultsInOrder.length - 1]);
    global.__fxInvoker = 'some_script';

    // A stopped resource loses its resolver.
    for (const h of fx.handlers.onResourceStop || []) h('some_script');
    await turn();
    check('a stopped resource has to register again', same(r.cis_call('scalar', 'SELECT 1', []), [3]));
    global.__fxInvoker = 'other_script';
    await turn();
    check('resolvers are per resource', same(r.cis_call('scalar', 'SELECT 1', []), [3]));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + e.stack); process.exit(1); });
