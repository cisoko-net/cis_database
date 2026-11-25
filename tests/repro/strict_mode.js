'use strict';

// MariaDB's strict mode (STRICT_TRANS_TABLES, its default sql_mode) refuses a
// value its column cannot hold. The engine must refuse the same writes, or
// SQLite keeps a row the replica refuses. Every expected answer below is what
// MariaDB 10.11.14 did with the same statement on a test server: ok, or the error
// it gave. Then: INSERT IGNORE and UPDATE IGNORE are let through, a row stored
// before the checks existed still takes changes to its other columns, the
// checks follow ALTER TABLE and RENAME TABLE, and a boot that changes nothing
// leaves the triggers alone. Last, the triggers alone on node:sqlite with
// cis_strict() off, as for a MariaDB whose sql_mode is not strict.
// Usage: node tests/repro/strict_mode.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

const TABLE = 'CREATE TABLE strict_t (id INT AUTO_INCREMENT PRIMARY KEY, ti TINYINT, tu TINYINT UNSIGNED, i INT, d DECIMAL(5,2), dbl DOUBLE,'
    + " v VARCHAR(5), c CHAR(3), tx TINYTEXT, e ENUM('active','gone'), eb ENUM('A','b') COLLATE utf8mb4_bin, dt DATETIME, b TINYINT(1))";

// [statement, MariaDB's answer: 'ok' or the start of its message]
const CASES = [
    ['INSERT INTO strict_t (ti) VALUES (127.4)', 'ok'],
    ['INSERT INTO strict_t (ti) VALUES (127.5)', 'Out of range value'],
    ['INSERT INTO strict_t (ti) VALUES (-128.5)', 'Out of range value'],
    ['INSERT INTO strict_t (tu) VALUES (-1)', 'Out of range value'],
    ['INSERT INTO strict_t (tu) VALUES (-0.4)', 'Out of range value'],
    ["INSERT INTO strict_t (i) VALUES ('12abc')", 'Incorrect integer value'],
    ["INSERT INTO strict_t (i) VALUES ('')", 'Incorrect integer value'],
    ["INSERT INTO strict_t (i) VALUES (' 12 ')", 'ok'],
    ["INSERT INTO strict_t (i) VALUES ('1e3')", 'ok'],
    ["INSERT INTO strict_t (i) VALUES ('0x10')", 'Incorrect integer value'],
    ["INSERT INTO strict_t (i) VALUES ('true')", 'Incorrect integer value'],
    ["INSERT INTO strict_t (i) VALUES ('12.5')", 'ok'],
    ['INSERT INTO strict_t (d) VALUES (999.994)', 'ok'],
    ['INSERT INTO strict_t (d) VALUES (999.995)', 'Out of range value'],
    ['INSERT INTO strict_t (d) VALUES (-999.99)', 'ok'],
    ["INSERT INTO strict_t (d) VALUES ('abc')", 'Incorrect decimal value'],
    ["INSERT INTO strict_t (dbl) VALUES ('')", 'Incorrect double value'],
    ["INSERT INTO strict_t (v) VALUES ('abcdef')", 'Data too long'],
    ["INSERT INTO strict_t (v) VALUES ('abc   ')", 'ok'],
    ["INSERT INTO strict_t (v) VALUES ('abcde ')", 'ok'],
    ["INSERT INTO strict_t (v) VALUES ('ééééé')", 'ok'],
    ['INSERT INTO strict_t (v) VALUES (12345)', 'ok'],
    ['INSERT INTO strict_t (v) VALUES (123456)', 'Data too long'],
    ["INSERT INTO strict_t (c) VALUES ('abcd')", 'Data too long'],
    ["INSERT INTO strict_t (tx) VALUES (?)", 'Data too long', ['a'.repeat(256)]],
    ["INSERT INTO strict_t (tx) VALUES (?)", 'ok', ['a'.repeat(255)]],
    ["INSERT INTO strict_t (e) VALUES ('ACTIVE')", 'ok'],
    ["INSERT INTO strict_t (e) VALUES ('active ')", 'ok'],
    ["INSERT INTO strict_t (e) VALUES ('nope')", 'Data truncated'],
    ["INSERT INTO strict_t (e) VALUES ('')", 'Data truncated'],
    ['INSERT INTO strict_t (e) VALUES (0)', 'Data truncated'],
    ['INSERT INTO strict_t (e) VALUES (2)', 'ok'],
    ['INSERT INTO strict_t (e) VALUES (3)', 'Data truncated'],
    ["INSERT INTO strict_t (e) VALUES ('2')", 'ok'],
    ['INSERT INTO strict_t (e) VALUES (1.5)', 'ok'],
    ["INSERT INTO strict_t (eb) VALUES ('a')", 'Data truncated'],
    ["INSERT INTO strict_t (eb) VALUES ('b')", 'ok'],
    ["INSERT INTO strict_t (dt) VALUES ('')", 'Incorrect datetime value'],
    ["INSERT INTO strict_t (dt) VALUES ('garbage')", 'Incorrect datetime value'],
    ['INSERT INTO strict_t (b) VALUES (2)', 'ok'],
    ['INSERT INTO strict_t (b) VALUES (128)', 'Out of range value'],
    ["INSERT INTO strict_t (i) VALUES (1), ('x')", 'Incorrect integer value'],
    ['INSERT INTO strict_t (ti, i) VALUES (?, ?)', 'Out of range value', [300, 1]],
];

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-strict-'));
    const mariaFile = path.join(dir, 'maria.sqlite');
    const m = new DatabaseSync(mariaFile);
    m.exec('CREATE TABLE fake_columns (table_name TEXT, column_name TEXT, extra TEXT, column_default TEXT, generation_expression TEXT);');
    m.close();
    process.env.FX_RES_DIR = dir;
    process.env.FX_MARIA_FILE = mariaFile;
    const fx = require('../harness/fx.js');
    const r = fx.registry;
    const call = (k, sql, p) => new Promise((res) => r[k](sql, p || [], (v, err) => res({ v: err ? false : v, err }), 'test', true));
    const val = async (sql, p) => (await call('scalar', sql, p)).v;
    const ok = (x) => x.err == null && x.v !== false;
    const errText = (x) => String(x.err && (x.err.message || x.err) || '');
    await fx.ready(20000);

    check('CREATE TABLE', ok(await call('query', TABLE)));
    const before = await val('SELECT count(*) FROM strict_t');
    let refused = 0;
    for (const [sql, want, params] of CASES) {
        const got = await call('query', sql, params);
        const pass = want === 'ok' ? ok(got) : !ok(got) && errText(got).indexOf(want) >= 0 && errText(got).indexOf('for column') >= 0;
        if (want !== 'ok') refused++;
        check((want === 'ok' ? 'takes ' : 'refuses ') + sql + (params ? ' ' + JSON.stringify(params).slice(0, 30) : ''), pass, pass ? '' : JSON.stringify([got.v, errText(got)]));
    }
    const after = await val('SELECT count(*) FROM strict_t');
    check('a refused statement wrote nothing, a multi-row one included', after - before === CASES.length - refused, before + ' -> ' + after);

    const ig = await call('query', "INSERT IGNORE INTO strict_t (ti, v) VALUES (500, 'abcdefgh')");
    const igRow = await call('query', 'SELECT ti, v FROM strict_t WHERE id = ?', [ig.v && ig.v.insertId]);
    check('INSERT IGNORE stores a value that does not fit cut to fit, as MariaDB does', ok(ig) && JSON.stringify(igRow.v) === '[{"ti":127,"v":"abcde"}]', JSON.stringify([igRow.v, errText(ig)]));
    const upd = await call('query', 'UPDATE strict_t SET ti = 999 WHERE id = 1');
    check('UPDATE to a value that does not fit is refused', !ok(upd) && /Out of range value for column 'ti'/.test(errText(upd)), errText(upd));
    const updIg = await call('query', "UPDATE IGNORE strict_t SET ti = -999 WHERE ti = 127 AND v = 'abcde'");
    const updIgRow = await call('query', 'SELECT ti FROM strict_t WHERE id = ?', [ig.v && ig.v.insertId]);
    check('UPDATE IGNORE is let through and clamps', ok(updIg) && JSON.stringify(updIgRow.v) === '[{"ti":-128}]', JSON.stringify([updIgRow.v, errText(updIg)]));

    const drop = await call('query', 'ALTER TABLE strict_t DROP COLUMN v');
    check('ALTER TABLE DROP COLUMN of a checked column works', ok(drop), errText(drop));
    const add = await call('query', 'ALTER TABLE strict_t ADD COLUMN w VARCHAR(2) NULL');
    const wBad = await call('query', "INSERT INTO strict_t (w) VALUES ('abc')");
    const tiBad = await call('query', 'INSERT INTO strict_t (ti) VALUES (200)');
    check('after ALTER the new column and the old ones are checked', ok(add) && /Data too long for column 'w'/.test(errText(wBad)) && /column 'ti'/.test(errText(tiBad)), JSON.stringify([errText(add), errText(wBad), errText(tiBad)]));
    const mod = await call('query', 'ALTER TABLE strict_t MODIFY COLUMN ti SMALLINT');
    const tiNow = await call('query', 'INSERT INTO strict_t (ti) VALUES (200)');
    check('after MODIFY the column is checked as its new type', ok(mod) && ok(tiNow), JSON.stringify([errText(mod), errText(tiNow)]));
    const ren = await call('query', 'RENAME TABLE strict_t TO strict_r');
    const renBad = await call('query', 'INSERT INTO strict_r (tu) VALUES (-1)');
    const names = await call('query', "SELECT name FROM sqlite_temp_master WHERE type = 'trigger' AND name LIKE 'cis_strict:%' ORDER BY name");
    check('after RENAME TABLE the checks hold and the triggers carry the new name', ok(ren) && /column 'tu'/.test(errText(renBad))
        && JSON.stringify((names.v || []).map((x) => x.name)) === '["cis_strict:strict_r:insert","cis_strict:strict_r:store_insert","cis_strict:strict_r:store_update","cis_strict:strict_r:update"]', JSON.stringify([errText(renBad), names.v]));

    const sv = async () => val('SELECT schema_version FROM pragma_schema_version');
    const v1 = await sv();
    await call('query', "CREATE TABLE IF NOT EXISTS strict_r (id INT AUTO_INCREMENT PRIMARY KEY, ti SMALLINT, tu TINYINT UNSIGNED, i INT, d DECIMAL(5,2), dbl DOUBLE, c CHAR(3), tx TINYTEXT, e ENUM('active','gone'), eb ENUM('A','b') COLLATE utf8mb4_bin, dt DATETIME, b TINYINT(1), w VARCHAR(2) NULL)");
    const v2 = await sv();
    check('CREATE TABLE IF NOT EXISTS of a table as it is rebuilds no trigger', v1 != null && v1 === v2, v1 + ' -> ' + v2);

    // A NOT NULL column with no default left out of an INSERT: MariaDB 10.11
    // in strict mode refuses it (1364), upserts, several rows and REPLACE
    // too, naming the first such column; INSERT IGNORE stores '' and 0.
    await call('query', 'CREATE TABLE nd (id INT PRIMARY KEY, a VARCHAR(5) NOT NULL, r TEXT NOT NULL, n INT NOT NULL)');
    await call('query', "INSERT INTO nd VALUES (1, 'x', 'r', 1)");
    const ndOne = await call('query', "INSERT INTO nd (id, a) VALUES (2, 'y')");
    const ndMany = await call('query', "INSERT INTO nd (id, a) VALUES (3, 'y'), (4, 'z')");
    const ndUpsert = await call('query', "INSERT INTO nd (id, a) VALUES (1, 'y') ON DUPLICATE KEY UPDATE a = VALUES(a)");
    const ndReplace = await call('query', "REPLACE INTO nd (id, a) VALUES (5, 'q')");
    const noDefault = (x) => !ok(x) && errText(x) === "Field 'r' doesn't have a default value";
    check('INSERT leaving out a NOT NULL column with no default is refused', noDefault(ndOne) && noDefault(ndMany) && noDefault(ndUpsert) && noDefault(ndReplace),
        JSON.stringify([ndOne, ndMany, ndUpsert, ndReplace].map(errText)));
    const ndIgnore = await call('query', "INSERT IGNORE INTO nd (id, a) VALUES (6, 'y')");
    const ndRows = await call('query', 'SELECT id, a, r, n FROM nd ORDER BY id');
    check("INSERT IGNORE stores '' and 0 for them; the refused ones wrote nothing", ok(ndIgnore)
        && JSON.stringify(ndRows.v) === '[{"id":1,"a":"x","r":"r","n":1},{"id":6,"a":"y","r":"","n":0}]', JSON.stringify(ndRows.v));

    // What MariaDB 10.11.14 stores for values it takes (probed): a real
    // rounded to an integer column and to a DECIMAL's or DOUBLE(M,D)'s scale,
    // a 64-bit integer as given, an ENUM in the type's spelling or by its
    // position, trailing spaces cut past a VARCHAR's length. A stamp the
    // statement gives stays when another column is rounded.
    await call('query', "CREATE TABLE sv (id INT AUTO_INCREMENT PRIMARY KEY, i INT, d DECIMAL(10,1), d2 DECIMAL(10,2), big BIGINT, f DOUBLE(6,2), e ENUM('active','gone'),"
        + ' v VARCHAR(5), t TINYINT, stamp DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, note VARCHAR(10))');
    const svIns = [
        await call('query', "INSERT INTO sv (i, d, d2, big, f, e, v) VALUES (110.00000000000001, 5.25, ?, 9007199254740993, 1.235, 'ACTIVE', 'abc   ')", [0.1 + 0.2]),
        await call('query', 'INSERT INTO sv (e) VALUES (2)'),
        await call('query', "INSERT IGNORE INTO sv (t, v, e) VALUES (500, 'abcdefgh', 'nope')"),
        await call('query', "INSERT INTO sv (d, stamp) VALUES (5.25, '2020-01-01 00:00:00')"),
    ];
    const svRows = async (where) => (await call('query', "SELECT id, i, d, d2, CAST(big AS CHAR) big, f, e, v, t, DATE_FORMAT(stamp, '%Y-%m-%d %H:%i:%s') stamp FROM sv"
        + (where || '') + ' ORDER BY id')).v;
    const rows = await svRows();
    const want = [
        { id: 1, i: 110, d: 5.3, d2: 0.3, big: '9007199254740993', f: 1.24, e: 'active', v: 'abc  ', t: null },
        { id: 2, i: null, d: null, d2: null, big: null, f: null, e: 'gone', v: null, t: null },
        { id: 3, i: null, d: null, d2: null, big: null, f: null, e: '', v: 'abcde', t: 127 },
        { id: 4, i: null, d: 5.3, d2: null, big: null, f: null, e: null, v: null, t: null, stamp: '2020-01-01 00:00:00' },
    ];
    // The stored value, not its type: a DECIMAL reads as mysql2's string
    // (decimal_strings.js checks that), so a number compares by value.
    const same = (got, exp) => Array.isArray(got) && got.length === exp.length && exp.every((w, k) => Object.keys(w).every((key) => (typeof w[key] === 'number' && got[k][key] != null ? Number(got[k][key]) : got[k][key]) === w[key]));
    check('rows are stored as MariaDB stores them', svIns.every(ok) && same(rows, want), JSON.stringify([rows, svIns.map(errText)]));
    await call('query', "UPDATE sv SET d = 7.25, stamp = '2021-01-01 00:00:00' WHERE id = 4");
    const given = await svRows(' WHERE id = 4');
    check('an UPDATE that gives the stamp keeps it while another column is rounded', same(given, [{ d: 7.3, stamp: '2021-01-01 00:00:00' }]), JSON.stringify(given));
    await call('query', 'UPDATE IGNORE sv SET t = 999 WHERE id = 3');
    await call('query', 'UPDATE sv SET i = 3.5, f = 2.344 WHERE id = 3');
    const upd3 = await svRows(' WHERE id = 3');
    check('an UPDATE stores as MariaDB does: clamped under IGNORE, rounded', same(upd3, [{ t: 127, i: 4, f: 2.34 }]), JSON.stringify(upd3));
    await call('query', 'UPDATE sv SET d = 8.25 WHERE id = 4');
    const fresh = await svRows(' WHERE id = 4');
    check('an UPDATE that leaves the stamp out still stamps the row', same(fresh, [{ d: 8.3 }]) && fresh[0].stamp > '2025-01-01', JSON.stringify(fresh));

    // The triggers alone, as for a MariaDB whose sql_mode is not strict.
    const dialect = require('../../dialect.js');
    const db = new DatabaseSync(':memory:');
    let strict = 1;
    let depth = 0;
    db.function('cis_strict', () => strict);
    db.function('cis_store', (d) => (depth += d));
    db.function('cis_storing', () => depth);
    db.exec('CREATE TABLE plain (id INTEGER PRIMARY KEY, n INTEGER, s TEXT)');
    db.exec("INSERT INTO plain (id, n, s) VALUES (100, 1, 'abcdefgh')");
    const trg = dialect.strictTriggersSql('plain', [
        { column_name: 'id', column_type: 'int(11)', data_type: 'int' },
        { column_name: 'n', column_type: 'tinyint(4)', data_type: 'tinyint' },
        { column_name: 's', column_type: 'varchar(3)', data_type: 'varchar', char_len: 3 },
    ], ['id']);
    for (const s of trg) db.exec(s);
    const tryRun = (sql) => { try { db.exec(sql); return 'ok'; } catch (e) { return e.message; } };
    check('the rowid alias is not checked (a BEFORE INSERT trigger sees it as -1)', tryRun("INSERT INTO plain (n, s) VALUES (1, 'a')") === 'ok');
    check('strict: refused', /Out of range value for column 'n'/.test(tryRun('INSERT INTO plain (n) VALUES (300)')));
    check('a row stored before the checks still takes changes to its other columns', tryRun('UPDATE plain SET n = 5 WHERE id = 100') === 'ok');
    strict = 0;
    check('sql_mode not strict: taken, cut to fit', tryRun("INSERT INTO plain (id, n, s) VALUES (200, 300, 'abcd')") === 'ok'
        && JSON.stringify(db.prepare('SELECT n, s FROM plain WHERE id = 200').get()) === '{"n":127,"s":"abc"}' && depth === 0);

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    setTimeout(() => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows keeps the file open */ }
        process.exit(failed ? 1 : 0);
    }, 200);
})().catch((e) => { console.log('FAIL ' + e.stack); process.exit(1); });
