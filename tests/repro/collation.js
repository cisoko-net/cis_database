'use strict';

// Text in a utf8mb4_general_ci column orders and compares as MariaDB does:
// letters fold to upper case, so [ _ ~ sort after them; accents fold for
// ORDER BY and ranges; trailing spaces do not count. Every expected answer
// below is what MariaDB 10.11.14 gave for the same rows and statement. A
// _bin column keeps byte order and case, a runtime-created table compares
// without case as MariaDB does, and an alias, a qualified name, an integer
// column and a positional ORDER BY are each handled as MariaDB handles them.
// A utf8mb4_unicode_ci column (its own, or the table's) sorts by UCA 4.0.0
// weights: punctuation before digits before letters, and ß as ss.
// Usage: node tests/repro/collation.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

const ROWS = ['[1]', '1', '_x', 'abc', 'Abd', 'é', 'E', 'ss', 'ß', 'Zed', 'zz', 'a😀', 'b', '~', 'a ', 'A'];
const BY_NAME = '1|a |A|abc|Abd|a😀|b|é|E|ß|ss|Zed|zz|[1]|_x|~';
const BY_NAME_DESC = '~|_x|[1]|zz|Zed|ss|ß|é|E|b|a😀|Abd|abc|a |A|1';
const BY_TAG = '1|A|Abd|E|Zed|[1]|_x|a |abc|a😀|b|ss|zz|~|ß|é';
const BY_U = '_x|[1]|~|1|a |A|abc|Abd|a😀|b|é|E|ss|ß|Zed|zz';
const BY_U_DESC = 'zz|Zed|ss|ß|é|E|b|a😀|Abd|abc|a |A|1|~|[1]|_x';

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-coll-'));
    const mariaFile = path.join(dir, 'maria.sqlite');
    const m = new DatabaseSync(mariaFile);
    m.exec('CREATE TABLE fake_columns (table_name TEXT, column_name TEXT, extra TEXT, column_default TEXT, generation_expression TEXT);');
    m.close();
    process.env.FX_RES_DIR = dir;
    process.env.FX_MARIA_FILE = mariaFile;
    const fx = require('../harness/fx.js');
    const dialect = require('../../dialect.js');
    const r = fx.registry;
    const call = (k, sql, p) => new Promise((res) => r[k](sql, p || [], (v, err) => res({ v: err ? false : v, err }), 'test', true));
    const val = async (sql, p) => (await call('scalar', sql, p)).v;
    const list = async (sql, p, col) => ((await call('query', sql, p)).v || []).map((x) => x[col]).join('|');
    const ok = (x) => x.err == null && x.v !== false;
    const errText = (x) => String(x.err && (x.err.message || x.err) || '');
    await fx.ready(20000);

    const key = dialect.generalCiKey;
    check('the key folds case, accents and ß, drops trailing spaces, and weighs a character outside the BMP FFFD',
        key('abc') === 'ABC' && key('é') === 'E' && key('ß') === 'S' && key('a  ') === 'A' && key('a😀b') === 'A�B' && key(5n) === 5n && key(null) === null,
        JSON.stringify([key('é'), key('ß'), key('a😀b')]));
    const ukey = dialect.unicodeCiKey;
    check('the unicode_ci key weighs ß as ss, é as e, a as A, and drops trailing spaces',
        ukey('ß') === ukey('ss') && ukey('é') === ukey('E') && ukey('a') === ukey('A') && ukey('a  ') === ukey('a') && ukey('_') < ukey('1') && ukey('1') < ukey('a') && ukey(5n) === 5n && ukey(null) === null);

    check('CREATE TABLE', ok(await call('query', 'CREATE TABLE coll_t (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(32), tag VARCHAR(32) COLLATE utf8mb4_bin, n INT, u VARCHAR(32) COLLATE utf8mb4_unicode_ci)')));
    for (let i = 0; i < ROWS.length; i++) await call('query', 'INSERT INTO coll_t (name, tag, n, u) VALUES (?, ?, ?, ?)', [ROWS[i], ROWS[i], i + 1, ROWS[i]]);

    const byName = await list('SELECT name FROM coll_t ORDER BY name, id', [], 'name');
    check('ORDER BY a general_ci column', byName === BY_NAME, byName);
    const desc = await list('SELECT name FROM coll_t ORDER BY name DESC, id', [], 'name');
    check('ORDER BY ... DESC', desc === BY_NAME_DESC, desc);
    const byTag = await list('SELECT tag FROM coll_t ORDER BY tag, id', [], 'tag');
    check('ORDER BY a _bin column keeps byte order', byTag === BY_TAG, byTag);
    const alias = await list('SELECT name AS label FROM coll_t ORDER BY label, id', [], 'label');
    check('ORDER BY an output alias of the column', alias === BY_NAME, alias);
    const qual = await list('SELECT p.name FROM coll_t p ORDER BY p.name, p.id', [], 'name');
    check('ORDER BY a qualified name', qual === BY_NAME, qual);
    const shadow = await list('SELECT tag AS name FROM coll_t ORDER BY name, id', [], 'name');
    check('ORDER BY an alias that hides a column sorts by the alias, as MariaDB does', shadow === BY_TAG, shadow);
    const pos = await list('SELECT name FROM coll_t ORDER BY 1, id', [], 'name');
    check('ORDER BY 1 is a position, not a value', pos === BY_NAME, pos);
    const ints = await list('SELECT n FROM coll_t WHERE n <= 12 ORDER BY n DESC', [], 'n');
    check('ORDER BY an integer column is unchanged', ints === '12|11|10|9|8|7|6|5|4|3|2|1', ints);
    const sub = await list('SELECT name FROM (SELECT name, id FROM coll_t ORDER BY name LIMIT 3) s ORDER BY id', [], 'name');
    check('ORDER BY ... LIMIT in a subquery', sub === '1|a |A', sub);

    // [statement, params, MariaDB's count]
    const COUNTS = [
        ["SELECT COUNT(*) FROM coll_t WHERE name > '[1]'", [], 2],
        ['SELECT COUNT(*) FROM coll_t WHERE name > ?', ['[1]'], 2],
        ["SELECT COUNT(*) FROM coll_t WHERE name BETWEEN 'a' AND 'b'", [], 6],
        ["SELECT COUNT(*) FROM coll_t WHERE name <= 'a'", [], 3],
        ["SELECT COUNT(*) FROM coll_t WHERE name < '_'", [], 14],
        ["SELECT COUNT(*) FROM coll_t WHERE 'Z' < name", [], 5],
        ["SELECT COUNT(*) FROM coll_t WHERE name NOT BETWEEN '1' AND 'Z'", [], 5],
        ['SELECT COUNT(*) FROM coll_t WHERE name >= ? AND n < ?', ['z', 12], 4],
        ["SELECT COUNT(*) FROM coll_t WHERE name = 'ABC'", [], 1],
        ["SELECT COUNT(*) FROM coll_t WHERE tag = 'ABC'", [], 0],
        ["SELECT COUNT(*) FROM coll_t WHERE tag > 'Z'", [], 12],
    ];
    for (const [sql, p, want] of COUNTS) {
        const got = await val(sql, p);
        check(sql + (p.length ? ' ' + JSON.stringify(p) : ''), Number(got) === want, String(got));
    }

    const byU = await list('SELECT u FROM coll_t ORDER BY u, id', [], 'u');
    check('ORDER BY a unicode_ci column', byU === BY_U, byU);
    const byUDesc = await list('SELECT u FROM coll_t ORDER BY u DESC, id', [], 'u');
    check('ORDER BY a unicode_ci column DESC', byUDesc === BY_U_DESC, byUDesc);
    const uAlias = await list('SELECT p.u AS label FROM coll_t p ORDER BY label, p.id', [], 'label');
    check('ORDER BY an alias of a qualified unicode_ci column', uAlias === BY_U, uAlias);
    await call('query', 'CREATE TABLE coll_w (id INT AUTO_INCREMENT PRIMARY KEY, w VARCHAR(32)) COLLATE utf8mb4_unicode_ci');
    for (const v of ROWS) await call('query', 'INSERT INTO coll_w (w) VALUES (?)', [v]);
    const byW = await list('SELECT w FROM coll_w ORDER BY w, id', [], 'w');
    check('ORDER BY a column of a unicode_ci table', byW === BY_U, byW);
    const U_COUNTS = [
        ["SELECT COUNT(*) FROM coll_t WHERE u > '[1]'", [], 14],
        ["SELECT COUNT(*) FROM coll_t WHERE u BETWEEN 'a' AND 'b'", [], 6],
        ['SELECT COUNT(*) FROM coll_t WHERE u <= ?', ['a'], 6],
        ["SELECT COUNT(*) FROM coll_t WHERE u < '_'", [], 0],
        ["SELECT COUNT(*) FROM coll_t WHERE 'Z' < u", [], 2],
        ["SELECT COUNT(*) FROM coll_t WHERE u BETWEEN 'ss' AND 'ss'", [], 2],
        ["SELECT COUNT(*) FROM coll_t WHERE u >= '1' AND u < 'a'", [], 1],
        ["SELECT COUNT(*) FROM coll_w WHERE w > 'E'", [], 4],
        ["SELECT COUNT(*) FROM coll_t WHERE name BETWEEN 'ss' AND 'ss'", [], 1],
    ];
    for (const [sql, p, want] of U_COUNTS) {
        const got = await val(sql, p);
        check(sql + (p.length ? ' ' + JSON.stringify(p) : ''), Number(got) === want, String(got));
    }

    const upd = await call('update', "UPDATE coll_t SET n = n + 100 WHERE name > '[1]'");
    check('UPDATE ... WHERE name > \'[1]\' changes the rows MariaDB changes', upd.v === 2, JSON.stringify([upd.v, errText(upd)]));
    const del = await call('update', 'DELETE FROM coll_t ORDER BY name DESC LIMIT 1');
    const left = await val("SELECT COUNT(*) FROM coll_t WHERE name = '~'");
    check('DELETE ... ORDER BY name DESC LIMIT 1 takes the row MariaDB takes', del.v === 1 && Number(left) === 0, JSON.stringify([del.v, left, errText(del)]));

    await call('query', 'CREATE TABLE coll_u (k VARCHAR(10) PRIMARY KEY, j JSON, b VARCHAR(10) BINARY)');
    const u1 = await call('query', "INSERT INTO coll_u (k) VALUES ('Abc')");
    const u2 = await call('query', "INSERT INTO coll_u (k) VALUES ('abc')");
    check('a key on a general_ci column refuses a value that differs only in case', ok(u1) && !ok(u2), errText(u2));
    const ddl = String(await val("SELECT sql FROM sqlite_master WHERE name = 'coll_u'"));
    check('JSON and BINARY columns tell case apart', /"k" TEXT COLLATE NOCASE/.test(ddl) && /"j" TEXT(?! COLLATE)/.test(ddl) && /"b" TEXT(?! COLLATE)/.test(ddl), ddl);
    const add = await call('query', 'ALTER TABLE coll_t ADD COLUMN extra VARCHAR(10)');
    await call('query', "UPDATE coll_t SET extra = 'x' WHERE n = 1");
    const added = await val("SELECT COUNT(*) FROM coll_t WHERE extra = 'X'");
    check('a column ALTER TABLE adds compares without case', ok(add) && Number(added) === 1, JSON.stringify([added, errText(add)]));
    const after = await list('SELECT name FROM coll_t WHERE n < 100 ORDER BY name, id', [], 'name');
    check('ORDER BY still holds after ALTER TABLE', after === BY_NAME.replace('|[1]|_x|~', '|[1]'), after);

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
