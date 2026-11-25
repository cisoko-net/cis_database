'use strict';

// MariaDB refuses a CREATE TABLE of a table that exists, an ADD COLUMN of a
// column that exists and an ADD INDEX or CREATE INDEX of an index name the
// table already has, unless the statement says IF NOT EXISTS. cis turned
// every "already exists" and "duplicate column" error into success, so a
// script that relies on the error (or has a typo in a table name it creates)
// saw a different answer than with oxmysql. The IF NOT EXISTS forms, and
// index names MariaDB keeps per table but SQLite keeps per database, still
// succeed.
// Usage: node tests/repro/ddl_exists_errors.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-ddlexists-'));
process.env.FX_RES_DIR = dir;
process.env.FX_REAL_MARIA = '1';
process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: '' });

const fx = require('../harness/fx.js');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const run = (sql) => new Promise((res) => {
    global.__fxInvoker = 'ddl_script';
    fx.registry.query(sql, [], (v, e) => res({ v, e }), 'ddl_script', true);
    global.__fxInvoker = '';
});
const fails = async (name, sql) => { const r = await run(sql); check(name, !!r.e, JSON.stringify(r)); };
const works = async (name, sql) => { const r = await run(sql); check(name, !r.e, JSON.stringify(r)); };

(async () => {
    check('engine ready', await fx.ready(20000));
    const ddl = 'CREATE TABLE things (id INT NOT NULL AUTO_INCREMENT, owner VARCHAR(50), name VARCHAR(50), PRIMARY KEY (id), KEY owner (owner), UNIQUE KEY uq_name (name))';
    await works('CREATE TABLE', ddl);
    await fails('CREATE TABLE of a table that exists fails', ddl);
    await works('CREATE TABLE IF NOT EXISTS of a table that exists works', ddl.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));
    await works('another table with the same index names works', ddl.replace('things', 'others'));
    await works('IF NOT EXISTS on that one works too', ddl.replace('things', 'others').replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));

    await works('ADD COLUMN', 'ALTER TABLE things ADD COLUMN extra INT DEFAULT 0');
    await fails('ADD COLUMN of a column that exists fails', 'ALTER TABLE things ADD COLUMN extra INT DEFAULT 0');
    await works('ADD COLUMN IF NOT EXISTS of a column that exists works', 'ALTER TABLE things ADD COLUMN IF NOT EXISTS extra INT DEFAULT 0');

    await works('ADD INDEX', 'ALTER TABLE things ADD INDEX idx_extra (extra)');
    await fails('ADD INDEX of a name the table has fails', 'ALTER TABLE things ADD INDEX idx_extra (extra)');
    await works('ADD INDEX IF NOT EXISTS of that name works', 'ALTER TABLE things ADD INDEX IF NOT EXISTS idx_extra (extra)');
    await works('ADD INDEX of that name on another table works', 'ALTER TABLE others ADD INDEX idx_extra (owner)');

    await works('CREATE INDEX', 'CREATE INDEX idx_both ON things (owner, name)');
    await fails('CREATE INDEX of a name the table has fails', 'CREATE INDEX idx_both ON things (owner, name)');
    await works('CREATE INDEX IF NOT EXISTS of that name works', 'CREATE INDEX IF NOT EXISTS idx_both ON things (owner, name)');
    await works('CREATE INDEX of that name on another table works', 'CREATE INDEX idx_both ON others (owner, name)');

    const ins = await run("INSERT INTO things (owner, name) VALUES ('a', 'b')");
    check('the table still takes writes', !ins.e, JSON.stringify(ins));

    const bad = results.filter((x) => !x).length;
    console.log(bad ? bad + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(bad ? 1 : 0);
})().catch((e) => {
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
