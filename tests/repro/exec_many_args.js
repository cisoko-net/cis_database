'use strict';

// Pre-release review of 28dbdb1, M4: API.md showed
// exports.cis_database:execMany(nil, { ... }, cb). The colon call already
// passes the export table as the argument FXServer drops, so the export got
// (nil, list, cb): the list arrived as the callback, nothing ran, and nothing
// said so. The export now takes the list as its first or second argument,
// and raises in the caller when neither is a list.
// Usage: node tests/repro/exec_many_args.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-execmany-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE bank (id VARCHAR(50) PRIMARY KEY, money INT NOT NULL)');
m.exec("INSERT INTO bank VALUES ('a', 100), ('b', 100)");
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
const money = async (id) => fx.call('scalar', 'SELECT money FROM bank WHERE id = ?', [id]);
// Calls execMany and waits for its callback; a throw comes back as ['threw', message].
const run = (...args) => new Promise((res) => {
    const timer = setTimeout(() => res(['no callback']), 3000);
    const cb = (result, err) => { clearTimeout(timer); res(['cb', result, err]); };
    try {
        r.execMany(...args.map((a) => (a === 'CB' ? cb : a)));
    } catch (e) {
        clearTimeout(timer);
        res(['threw', String(e && e.message || e)]);
    }
});
const add = (n) => [
    { query: 'UPDATE bank SET money = money + ? WHERE id = ?', values: [n, 'a'] },
    { query: 'UPDATE bank SET money = money - ? WHERE id = ?', values: [n, 'b'] },
];

(async () => {
    if (!(await fx.ready(20000))) throw new Error('not ready');
    global.__fxInvoker = 'some_script';

    const first = await run(add(10), 'CB');
    check('the list as the first argument runs', first[0] === 'cb' && Array.isArray(first[1]) && first[1].length === 2, JSON.stringify(first));
    check('and both statements applied', (await money('a')) === 110 && (await money('b')) === 90);

    const second = await run(null, add(5), 'CB');
    check('the list after a nil runs too', second[0] === 'cb' && Array.isArray(second[1]) && second[1].length === 2, JSON.stringify(second));
    check('and both statements applied', (await money('a')) === 115 && (await money('b')) === 85);

    const none = await run(null, null, 'CB');
    check('no list raises in the caller', none[0] === 'threw' && /execMany/.test(none[1]) && /list/.test(none[1]), JSON.stringify(none));
    const str = await run('UPDATE bank SET money = 0', 'CB');
    check('a string instead of a list raises', str[0] === 'threw' && /string/.test(str[1]), JSON.stringify(str));
    check('nothing ran for either', (await money('a')) === 115);

    const empty = await run([], 'CB');
    check('an empty list answers an empty result', empty[0] === 'cb' && Array.isArray(empty[1]) && empty[1].length === 0, JSON.stringify(empty));

    const api = fs.readFileSync(path.join(__dirname, '..', '..', 'API.md'), 'utf8');
    check('API.md no longer shows execMany(nil, ...)', !/execMany\(nil/.test(api) && /cis_database:execMany\(\{/.test(api));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? `exec_many_args: ${failed} FAILED` : `exec_many_args: all ${results.length} passed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack)); process.exit(1); });
