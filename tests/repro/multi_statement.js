'use strict';

// Pre-release review of 28dbdb1, H4: cis_database ran every statement of a
// multi-statement text, where oxmysql (mysql2, multipleStatements off by
// default) sends it to MariaDB, which refuses it as a syntax error. A
// resource that concatenates a player string into SQL then let
// x'; UPDATE users SET money = 999999 WHERE identifier = 'me run the UPDATE.
// The splitter knew only ' and ", so a ; in a `name` or a comment split one
// statement in two. And the outbox replays a batch as one multi-statement
// text, so MariaDB decided the statement boundaries again; a statement that
// could hold one now goes alone on a connection that refuses a second one.
// With cis_database_multi_statements true (run as: node multi_statement.js optin)
// the operator gets the old behaviour back, with the better splitter.
// Usage: node tests/repro/multi_statement.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const optin = process.argv[2] === 'optin';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-multi-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE bank (id VARCHAR(50) PRIMARY KEY, money INT NOT NULL, note TEXT)');
m.exec("INSERT INTO bank VALUES ('a', 100, NULL), ('b', 0, NULL)");
m.close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;
const convars = { mysql_connection_string: 'mysql://root@127.0.0.1/fake', cis_database_cdc: '0' };
if (optin) convars.cis_database_multi_statements = 'true';
process.env.FX_CONVARS = JSON.stringify(convars);

const fx = require('../harness/fx.js');

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const money = async (id) => fx.call('scalar', 'SELECT money FROM bank WHERE id = ?', [id]);
// The _async exports reject with the error, where a callback only gets false.
// A call without a callback may return the async retval object the Lua
// runtime awaits; await it the same way.
const attempt = (name, sql, params) => {
    const p = fx.registry[name + '_async'](sql, params);
    return p && typeof p.__cfx_async_retval === 'function'
        ? new Promise((res) => p.__cfx_async_retval((v, e) => res(v ? ['ok', v[0]] : ['error', String(e)])))
        : Promise.resolve(p).then((v) => ['ok', v], (e) => ['error', String(e && e.message || e)]);
};
const mariaRows = (sql) => {
    const mm = new DatabaseSync(mariaFile);
    try { return JSON.stringify(mm.prepare(sql).all()); } finally { mm.close(); }
};
async function replicated(sql, want) {
    let got = '';
    const end = Date.now() + 10000;
    while (Date.now() < end) {
        got = mariaRows(sql);
        if (got === want) break;
        await new Promise((res) => setTimeout(res, 50));
    }
    return got;
}

(async () => {
    if (!(await fx.ready(20000))) throw new Error('not ready');
    global.__fxInvoker = 'some_script';

    // A plate concatenated into the SQL by a careless resource.
    const plate = "x'; UPDATE bank SET money = 999999 WHERE id = 'b";
    const injected = await attempt('query', "SELECT money FROM bank WHERE id = '" + plate + "'", []);
    const two = await attempt('update', "UPDATE bank SET money = 1 WHERE id = 'a'; UPDATE bank SET money = 2 WHERE id = 'b'", []);
    if (!optin) {
        check('a concatenated injection is refused as a syntax error', injected[0] === 'error' && /ER_PARSE_ERROR/.test(injected[1]) && /syntax/.test(injected[1]), JSON.stringify(injected));
        check('the injected UPDATE did not run', (await money('b')) === 0, String(await money('b')));
        check('two statements in one text are refused', two[0] === 'error' && /UPDATE bank SET money = 2/.test(two[1]), JSON.stringify(two));
        check('neither statement ran', (await money('a')) === 100 && (await money('b')) === 0, (await money('a')) + ' / ' + (await money('b')));
        check('the error names the opt-in convar', /cis_database_multi_statements/.test(two[1]), two[1]);
    } else {
        check('opt-in: both statements run', two[0] === 'ok' && (await money('a')) === 1 && (await money('b')) === 2, JSON.stringify(two));
    }

    // One statement, whatever its ; and comments, is never split or refused.
    const trailing = await attempt('scalar', 'SELECT money FROM bank WHERE id = ?;', ['a']);
    check('a trailing ; is one statement', trailing[0] === 'ok' && typeof trailing[1] === 'number', JSON.stringify(trailing));
    const trailingComment = await attempt('scalar', 'SELECT money FROM bank WHERE id = ?; -- the balance', ['a']);
    check('a trailing ; then a comment is one statement', trailingComment[0] === 'ok' && typeof trailingComment[1] === 'number', JSON.stringify(trailingComment));
    // (A ; in a table name is refused by the DDL translator on its own.)
    const tick = await attempt('query', "SELECT money AS `a;b` FROM bank WHERE id = 'a'", []);
    check('a ; inside a `name` does not split the statement', tick[0] === 'ok' && Array.isArray(tick[1]) && tick[1].length === 1 && typeof tick[1][0]['a;b'] === 'number', JSON.stringify(tick));
    const tick2 = await attempt('query', "SELECT money AS `x``;y` FROM bank WHERE id = 'a'", []);
    check('and a doubled backtick does not end the name', tick2[0] === 'ok' && Array.isArray(tick2[1]) && typeof tick2[1][0]['x`;y'] === 'number', JSON.stringify(tick2));
    const block = await attempt('scalar', 'SELECT /* a; b */ money FROM bank WHERE id = ?', ['a']);
    check('a ; inside a /* comment */ does not split', block[0] === 'ok' && typeof block[1] === 'number', JSON.stringify(block));
    const dash = await attempt('scalar', 'SELECT money -- a; b\nFROM bank WHERE id = ?', ['a']);
    check('a ; inside a -- comment does not split', dash[0] === 'ok' && typeof dash[1] === 'number', JSON.stringify(dash));
    const hash = await attempt('scalar', 'SELECT money # a; b\nFROM bank WHERE id = ?', ['a']);
    check('a ; inside a # comment does not split', hash[0] === 'ok' && typeof hash[1] === 'number', JSON.stringify(hash));
    const lit = await attempt('update', "UPDATE bank SET note = 'x; y' WHERE id = 'a'", []);
    check('a ; inside a string does not split', lit[0] === 'ok' && lit[1] === 1, JSON.stringify(lit));

    // Replay: a value that holds a ; and comment markers is escaped into one
    // string literal, so it may share a batch. A statement whose own text has
    // a ; or a comment outside its strings goes alone, on a connection that
    // runs one statement per query, so MariaDB never re-decides where it ends.
    const evil = "z'; DELETE FROM bank; -- \n;\n# ";
    await fx.call('update', 'UPDATE bank SET note = ? WHERE id = ?', [evil, 'b']);
    await fx.call('update', 'UPDATE bank SET money = money + 1 WHERE id = ?; -- payday', ['b']);
    await fx.call('update', 'UPDATE bank SET money = money + 5 WHERE id = ?', ['a']);
    const want = JSON.stringify(await fx.call('query', 'SELECT id, money, note FROM bank ORDER BY id', []));
    const got = await replicated('SELECT id, money, note FROM bank ORDER BY id', want);
    check('MariaDB ends with the same rows', got === want, got + ' vs ' + want);
    const sent = fx.sent().filter((x) => /money = money \+ 1 WHERE/.test(x.sql));
    check('the statement with its own ; and comment went alone, on a single-statement connection',
        sent.length > 0 && sent.every((x) => !x.multi), JSON.stringify(sent.map((x) => [x.multi, x.sql.slice(0, 120)])));
    const escaped = fx.sent().filter((x) => /DELETE FROM bank/.test(x.sql));
    check('the value with a ; in it reached MariaDB inside one string', escaped.length > 0, String(escaped.length));
    const batched = fx.sent().filter((x) => x.multi && /money = money \+ 5/.test(x.sql));
    check('a plain statement still goes in the batch', batched.length > 0, String(batched.length));

    let childOk = true;
    if (!optin) {
        const child = spawnSync(process.execPath, [__filename, 'optin'], { encoding: 'utf8', timeout: 60000 });
        process.stdout.write((child.stdout || '').split('\n').filter((l) => /^(PASS|FAIL)/.test(l)).map((l) => '  optin ' + l).join('\n') + '\n');
        childOk = child.status === 0;
        check('the opt-in run passes', childOk, 'exit ' + child.status);
    }

    const failed = results.filter((x) => !x).length;
    console.log(failed ? `multi_statement: ${failed} FAILED` : `multi_statement: all ${results.length} passed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack)); process.exit(1); });
