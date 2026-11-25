'use strict';

// Security review N2: a utf8mb3 column (old SQL dumps make every table
// DEFAULT CHARSET=utf8mb3) cannot hold a character past U+FFFF, such as an
// emoji in a player's name or a phone message. SQLite took the write and
// answered ok; MariaDB refused its copy (1366 Incorrect string value), and
// the next boot copied the table from MariaDB, so the row the script was told
// was saved was gone. An ascii column refuses anything past U+007F the same
// way. The engine now refuses these writes as MariaDB does. Every expected
// answer below is what MariaDB 10.11.19 gave for the same statement under its
// default sql_mode (STRICT_TRANS_TABLES).
// Usage: node tests/repro/strict_charset.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

const TABLE = 'CREATE TABLE cs_t (id INT AUTO_INCREMENT PRIMARY KEY, a VARCHAR(20), b TEXT CHARACTER SET utf8mb4,'
    + ' c VARCHAR(20) CHARACTER SET ascii, d LONGTEXT) DEFAULT CHARSET=utf8mb3';
const TABLE4 = 'CREATE TABLE cs_m4 (id INT AUTO_INCREMENT PRIMARY KEY, a VARCHAR(20), o VARCHAR(20) COLLATE utf8_general_ci)'
    + ' DEFAULT CHARSET=utf8mb4';

// [statement, MariaDB's answer: 'ok' or the start of its message]
const CASES = [
    ["INSERT INTO cs_t (a) VALUES ('ok é')", 'ok'],
    ["INSERT INTO cs_t (a) VALUES ('中文ü')", 'ok'],
    ["INSERT INTO cs_t (a) VALUES ('hi 😀')", 'Incorrect string value'],
    ["INSERT INTO cs_t (d) VALUES ('a long message 😀')", 'Incorrect string value'],
    ['INSERT INTO cs_t (a) VALUES (?)', 'Incorrect string value', ['name 🚗']],
    ["INSERT INTO cs_t (b) VALUES ('hi 😀')", 'ok'],
    ["INSERT INTO cs_t (c) VALUES ('abc')", 'ok'],
    ["INSERT INTO cs_t (c) VALUES ('é')", 'Incorrect string value'],
    ["UPDATE cs_t SET a = 'x 😀' WHERE id = 1", 'Incorrect string value'],
    ["INSERT INTO cs_m4 (a) VALUES ('hi 😀')", 'ok'],
    ["INSERT INTO cs_m4 (o) VALUES ('hi 😀')", 'Incorrect string value'],
];

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-charset-'));
    const mariaFile = path.join(dir, 'maria.sqlite');
    const m = new DatabaseSync(mariaFile);
    m.exec('CREATE TABLE fake_columns (table_name TEXT, column_name TEXT, extra TEXT, column_default TEXT, generation_expression TEXT);');
    m.close();
    process.env.FX_RES_DIR = dir;
    process.env.FX_MARIA_FILE = mariaFile;
    const fx = require('../harness/fx.js');
    const r = fx.registry;
    const call = (k, sql, p) => new Promise((res) => r[k](sql, p || [], (v, err) => res({ v: err ? false : v, err }), 'test', true));
    const ok = (x) => x.err == null && x.v !== false;
    const errText = (x) => String(x.err && (x.err.message || x.err) || '');
    await fx.ready(20000);

    check('CREATE TABLE utf8mb3', ok(await call('query', TABLE)));
    check('CREATE TABLE utf8mb4 with a utf8 column', ok(await call('query', TABLE4)));
    for (const [sql, want, params] of CASES) {
        const got = await call('query', sql, params);
        const pass = want === 'ok' ? ok(got) : !ok(got) && errText(got).indexOf(want) >= 0 && errText(got).indexOf('for column') >= 0;
        check((want === 'ok' ? 'takes ' : 'refuses ') + sql + (params ? ' ' + JSON.stringify(params) : ''), pass, pass ? '' : JSON.stringify([got.v, errText(got)]));
    }
    const rows = await call('query', 'SELECT id, a FROM cs_t WHERE id = 1');
    check('the refused UPDATE left the row as it was', JSON.stringify(rows.v) === '[{"id":1,"a":"ok é"}]', JSON.stringify(rows.v));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
