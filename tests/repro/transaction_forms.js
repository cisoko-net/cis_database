'use strict';

// The transaction forms oxmysql 2.14.3 accepts (src/utils/parseTransaction.ts):
// a list of { sql, params } pairs (a Lua sequence, so a 0-based array here),
// a list of strings that share the second argument as parameters, and
// { query, values } tables. Renewed-Banking sends the pair form; before the
// fix cis_database ran the params array as SQL ('near "bcso": syntax error')
// and dropped the shared parameters. Named keys may carry their @ or :
// ({ ['@id'] = 1 }), as oxmysql strips it. Both the callback export and the .await
// fast path (cis_call) are checked, and MariaDB must end with the same rows.
// Usage: node tests/repro/transaction_forms.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-txforms-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE accounts (id VARCHAR(50) PRIMARY KEY, amount INT NOT NULL, auth TEXT)');
m.exec("INSERT INTO accounts VALUES ('police', 10, '[]')");
// Renewed-Banking.sql, in the types the SQLite stand-in for MariaDB takes.
m.exec("CREATE TABLE bank_accounts_new (id VARCHAR(50) NOT NULL PRIMARY KEY, amount INT DEFAULT 0, transactions TEXT DEFAULT '[]', auth TEXT DEFAULT '[]', isFrozen INT DEFAULT 0, creator VARCHAR(50) DEFAULT NULL)");
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
const answers = [];
async function done(x) {
    if (!x || x[0] !== 0) return x;
    const end = Date.now() + 5000;
    while (Date.now() < end && !answers.some((a) => a.id === x[1])) await turn();
    const a = answers.find((y) => y.id === x[1]);
    if (!a) return ['timeout', x[1]];
    return a.err != null ? [2, a.err] : [1, a.result];
}
const rows = async () => fx.call('query', 'SELECT id, amount FROM accounts ORDER BY id', []);
const amountOf = async (id) => fx.call('scalar', 'SELECT amount FROM accounts WHERE id = ?', [id]);

(async () => {
    if (!(await fx.ready(20000))) throw new Error('not ready');
    global.__fxInvoker = 'Renewed-Banking';

    // Renewed-Banking server/main.lua: query[#query + 1] = { "INSERT ...", { group, ... } }
    const pairs = [
        ['INSERT INTO accounts (id, amount, auth) VALUES (?, ?, ?)', ['bcso', 0, '[]']],
        ['INSERT INTO accounts (id, amount, auth) VALUES (?, ?, ?)', ['ambulance', 5, '[]']],
    ];
    check('the { sql, params } pair form commits', (await fx.call('transaction', pairs)) === true);
    check('both pair rows are in SQLite', (await amountOf('bcso')) === 0 && (await amountOf('ambulance')) === 5, JSON.stringify(await rows()));

    const strings = ['UPDATE accounts SET amount = amount + ? WHERE id = ?', 'UPDATE accounts SET amount = amount + ? WHERE id = ?'];
    check('strings with shared parameters commit', (await fx.call('transaction', strings, [7, 'police'])) === true);
    check('each string ran with the shared parameters', (await amountOf('police')) === 24, String(await amountOf('police')));

    const named = ['UPDATE accounts SET amount = @n WHERE id = @id'];
    check('shared named parameters commit', (await fx.call('transaction', named, { '@n': 3, '@id': 'ambulance' })) === true);
    check('the named parameters bound', (await amountOf('ambulance')) === 3, String(await amountOf('ambulance')));
    // oxmysql's named-placeholders strips the @ or : of a key, on every method.
    check('a single update binds @-prefixed keys', (await fx.call('update', 'UPDATE accounts SET amount = :n WHERE id = @id', { ':n': 5, '@id': 'ambulance' })) === 1
        && (await amountOf('ambulance')) === 5, String(await amountOf('ambulance')));

    const objects = [{ query: 'UPDATE accounts SET amount = ? WHERE id = ?', values: [1, 'bcso'] }];
    check('the { query, values } form still commits', (await fx.call('transaction', objects, [99, 'police'])) === true);
    check('a table keeps its own values over the shared ones', (await amountOf('bcso')) === 1 && (await amountOf('police')) === 24);

    // The .await path of lib/MySQL.lua: cis_call('transaction', queries, parameters).
    await turn();
    r.cis_register((id, result, err) => answers.push({ id, result, err }));
    await turn();
    const fastPairs = await done(r.cis_call('transaction', [['INSERT INTO accounts (id, amount, auth) VALUES (?, ?, ?)', ['mechanic', 2, '[]']]], []));
    check('cis_call takes the pair form', JSON.stringify(fastPairs) === '[1,true]', JSON.stringify(fastPairs));
    await turn();
    const fastShared = await done(r.cis_call('transaction', ['UPDATE accounts SET amount = amount + ? WHERE id = ?'], [4, 'mechanic']));
    check('cis_call passes the shared parameters', JSON.stringify(fastShared) === '[1,true]' && (await amountOf('mechanic')) === 6,
        JSON.stringify(fastShared) + ' amount ' + (await amountOf('mechanic')));

    // Renewed-Banking server/main.lua:45, word for word: one 5-value pair per
    // missing job or gang account, then MySQL.transaction.await(query) with no
    // second argument. json.encode({}) is '[]' in FiveM.
    const rbSql = 'INSERT INTO bank_accounts_new (id, amount, transactions, auth, isFrozen, creator) VALUES (?, ?, ?, ?, ?, NULL) ';
    const rbQuery = ['bcso', 'lostmc'].map((group) => [rbSql, [group, 0, '[]', '[]', 0]]);
    await turn();
    const rb = await done(r.cis_call('transaction', rbQuery, null));
    check('the Renewed-Banking account setup commits on the .await path', JSON.stringify(rb) === '[1,true]', JSON.stringify(rb));
    const bankRows = async () => fx.call('query', 'SELECT id, amount, transactions, auth, isFrozen, creator FROM bank_accounts_new ORDER BY id', []);
    const rbWant = JSON.stringify([
        { id: 'bcso', amount: 0, transactions: '[]', auth: '[]', isFrozen: 0, creator: null },
        { id: 'lostmc', amount: 0, transactions: '[]', auth: '[]', isFrozen: 0, creator: null },
    ]);
    check('every value of the 5-value pair bound in order', JSON.stringify(await bankRows()) === rbWant, JSON.stringify(await bankRows()));

    const mariaRows = (sql) => {
        const mm = new DatabaseSync(mariaFile);
        try { return JSON.stringify(mm.prepare(sql).all()); } finally { mm.close(); }
    };
    const want = JSON.stringify(await rows());
    const bankWant = JSON.stringify(await bankRows());
    let got = '';
    let bankGot = '';
    const end = Date.now() + 10000;
    while (Date.now() < end) {
        got = mariaRows('SELECT id, amount FROM accounts ORDER BY id');
        bankGot = mariaRows('SELECT id, amount, transactions, auth, isFrozen, creator FROM bank_accounts_new ORDER BY id');
        if (got === want && bankGot === bankWant) break;
        await new Promise((res) => setTimeout(res, 100));
    }
    check('MariaDB ends with the same rows', got === want, got + ' vs ' + want);
    check('MariaDB ends with the same bank accounts', bankGot === bankWant, bankGot + ' vs ' + bankWant);

    const failed = results.filter((x) => !x).length;
    console.log(failed ? `transaction_forms: ${failed} FAILED` : `transaction_forms: all ${results.length} passed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack)); process.exit(1); });
