'use strict';

// Pre-release review of 28dbdb1, server side:
// H1  oxmysql v2.14.3 sets MySQL.execute = MySQL.query and MySQL.fetch =
//     MySQL.query (src/index.ts:111-113) and exports each with _async and
//     Sync variants. cis_database mapped execute to update, so
//     exports.oxmysql:execute('SELECT ...', cb) got a number, and fetch was
//     not exported at all.
// H2  oxmysql's rawTransaction resolves false when a statement fails
//     (src/database/rawTransaction.ts). qbx_core players.lua:321 and esx
//     createJob.lua:101 test that value; cis_database rejected instead, so
//     MySQL.transaction.await raised in the caller.
// H3  oxmysql has startTransaction(fn). cis_database cannot hold its one
//     SQLite connection open across the caller's awaits yet, so it exports a
//     stub that never runs fn, prints why, and returns false, instead of a
//     missing export that raises "attempt to call a nil value".
// M2  oxmysql refuses a transaction item with no SQL (parseArguments throws)
//     and nothing commits; cis_database skipped the item and committed the rest.
// Usage: node tests/repro/oxmysql_parity_review.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-parity-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE bank (id VARCHAR(50) PRIMARY KEY, money INT NOT NULL)');
m.exec("INSERT INTO bank VALUES ('a', 100), ('b', 0)");
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
const turn = () => new Promise((res) => setTimeout(res, 10));
const money = async (id) => fx.call('scalar', 'SELECT money FROM bank WHERE id = ?', [id]);
// What a promise settles with, without letting a rejection escape.
// A call without a callback may return the async retval object the Lua
// runtime awaits (citizen/scripting/lua/scheduler.lua); await it the same way.
const settled = (p) => (p && typeof p.__cfx_async_retval === 'function'
    ? new Promise((res) => p.__cfx_async_retval((v, e) => res(v ? ['resolved', v[0]] : ['rejected', String(e)])))
    : Promise.resolve(p).then((v) => ['resolved', v], (e) => ['rejected', String(e && e.message || e)]));

(async () => {
    if (!(await fx.ready(20000))) throw new Error('not ready');
    global.__fxInvoker = 'some_script';

    // H1
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'fxmanifest.lua'), 'utf8');
    const names = Array.from(/server_exports\s*\{([^}]*)\}/.exec(src)[1].matchAll(/'([^']+)'/g), (x) => x[1]);
    const want = ['execute', 'execute_async', 'executeSync', 'fetch', 'fetch_async', 'fetchSync'];
    const notListed = want.filter((n) => !names.includes(n));
    check('execute and fetch are in server_exports with _async and Sync', notListed.length === 0, 'missing: ' + (notListed.join(' ') || 'none'));
    const notExported = want.filter((n) => typeof r[n] !== 'function');
    check('execute and fetch are exported with _async and Sync', notExported.length === 0, 'missing: ' + (notExported.join(' ') || 'none'));
    const exec = typeof r.execute === 'function' ? await fx.call('execute', 'SELECT id, money FROM bank ORDER BY id', []) : null;
    check('execute runs as query and returns the rows', JSON.stringify(exec) === '[{"id":"a","money":100},{"id":"b","money":0}]', JSON.stringify(exec));
    const fetched = typeof r.fetch === 'function' ? await fx.call('fetch', 'SELECT money FROM bank WHERE id = ?', ['a']) : null;
    check('fetch runs as query and returns the rows', JSON.stringify(fetched) === '[{"money":100}]', JSON.stringify(fetched));
    const upd = typeof r.execute === 'function' ? await fx.call('execute', 'UPDATE bank SET money = money WHERE id = ?', ['a']) : null;
    check('execute of an UPDATE returns the result header, as query does', upd && typeof upd === 'object' && upd.affectedRows === 1, JSON.stringify(upd));
    const asyncRows = typeof r.execute_async === 'function' ? await settled(r.execute_async('SELECT money FROM bank WHERE id = ?', ['b'])) : null;
    check('execute_async resolves the rows', JSON.stringify(asyncRows) === '["resolved",[{"money":0}]]', JSON.stringify(asyncRows));

    // H2: a failing statement rolls back and resolves false on every path.
    const failing = [
        ['UPDATE bank SET money = money - 10 WHERE id = ?', ['a']],
        ['INSERT INTO bank (id, money) VALUES (?, ?)', ['a', 1]],
    ];
    let cbArgs = null;
    await new Promise((res) => r.transaction(failing, (...args) => { cbArgs = args; res(); }));
    check('a failed transaction calls back with false alone', JSON.stringify(cbArgs) === '[false]', JSON.stringify(cbArgs));
    check('the failed transaction rolled back', (await money('a')) === 100, String(await money('a')));
    const viaAsync = await settled(r.transaction_async(failing));
    check('transaction_async resolves false instead of rejecting', JSON.stringify(viaAsync) === '["resolved",false]', JSON.stringify(viaAsync));
    const viaSync = await settled(r.transactionSync(failing));
    check('transactionSync resolves false instead of rejecting', JSON.stringify(viaSync) === '["resolved",false]', JSON.stringify(viaSync));

    const answers = [];
    r.cis_register((id, result, err) => answers.push({ id, result, err }));
    await turn();
    let fast = r.cis_call('transaction', failing, null);
    if (fast && fast[0] === 0) {
        const end = Date.now() + 5000;
        while (Date.now() < end && !answers.some((a) => a.id === fast[1])) await turn();
        const a = answers.find((y) => y.id === fast[1]);
        fast = a ? (a.err != null ? [2, a.err] : [1, a.result]) : ['timeout'];
    }
    check('the .await path (cis_call) answers [1, false]', JSON.stringify(fast) === '[1,false]', JSON.stringify(fast));
    check('money is unchanged after every failed path', (await money('a')) === 100, String(await money('a')));

    // M2: an item with no SQL (a misspelt config key) rolls back the rest.
    const missing = [
        { query: 'UPDATE bank SET money = money - 10 WHERE id = ?', values: ['a'] },
        { qurey: 'UPDATE bank SET money = money + 10 WHERE id = ?', values: ['b'] },
    ];
    const m2 = await fx.call('transaction', missing);
    check('a transaction item with no SQL makes the transaction return false', m2 === false, JSON.stringify(m2));
    check('nothing of that transaction committed', (await money('a')) === 100 && (await money('b')) === 0,
        (await money('a')) + ' / ' + (await money('b')));
    const holey = { 1: ['UPDATE bank SET money = money - 10 WHERE id = ?', ['a']], 3: ['UPDATE bank SET money = money + 10 WHERE id = ?', ['b']] };
    const m2b = await fx.call('transaction', holey);
    check('a hole in a Lua list counts as an item with no SQL', m2b === false && (await money('a')) === 100, JSON.stringify(m2b) + ' ' + (await money('a')));

    // H3
    check('startTransaction is in server_exports', names.includes('startTransaction'));
    let ran = false;
    const st = typeof r.startTransaction === 'function' ? r.startTransaction(() => { ran = true; return true; }, 'some_script') : 'missing';
    check('startTransaction returns false and never runs the function', st === false && ran === false, JSON.stringify(st) + ' ran=' + ran);
    let stCb = null;
    if (typeof r.startTransaction === 'function') r.startTransaction(() => true, (v) => { stCb = v; });
    await turn();
    check('a callback, when given, gets false', stCb === false, JSON.stringify(stCb));

    // The happy path still commits.
    const ok = await fx.call('transaction', [['UPDATE bank SET money = money - 10 WHERE id = ?', ['a']], ['UPDATE bank SET money = money + 10 WHERE id = ?', ['b']]]);
    check('a good transaction still returns true and commits', ok === true && (await money('a')) === 90 && (await money('b')) === 10);

    const failed = results.filter((x) => !x).length;
    console.log(failed ? `oxmysql_parity_review: ${failed} FAILED` : `oxmysql_parity_review: all ${results.length} passed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack)); process.exit(1); });
