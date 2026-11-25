'use strict';

// Result values come back cast by the column's MariaDB type, as oxmysql
// returns them:
// DATETIME and TIMESTAMP as epoch ms, DATE as ms at local 00:00, TINYINT(1)
// and BOOLEAN as a boolean; TINYINT(4) stays a number. prepare goes through
// mysql2's execute() cast, which turns the dates only. Two paths:
// - hydrated: the table is made in MariaDB, the engine learns its types on boot
// - engine DDL: the table is made by a CREATE TABLE sent through the engine
// The cast keys on the declared type only; the tables and columns here are
// made up, and an alias or a join still finds the column a value is read from.
//
// Usage: node tests/repro/type_casts.js
//   FX_TYPES_MARIA=mysql://root@127.0.0.1:3307 runs it against a real MariaDB
//   (database cm_types is dropped and made again) and also checks that
//   mysql2 with tests/harness/result_cast.js gives MariaDB's side the same values.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const REAL = process.env.FX_TYPES_MARIA || '';
const DB = 'cm_types';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-typecasts-'));
process.env.FX_RES_DIR = dir;

const DT = '2024-05-06 07:08:09';
const TS = '2023-11-12 13:14:15';
const D = '2024-02-29';
const ms = (s) => new Date(s).getTime();
const day = (s) => new Date(s + ' 00:00:00').getTime();

// The made-in-MariaDB table, with two rows: one of values, one of NULLs.
const ROWS = "(1, '" + DT + "', '" + TS + "', '" + D + "', 1, 3, 0), (2, NULL, NULL, NULL, NULL, NULL, NULL)";

// The values the API gives, for the MariaDB-side check.
const oxTypeCast = require('../harness/result_cast.js').makeQueryCast({ bitBy: 'field' });

async function setupMaria() {
    if (REAL) {
        const mysql = require('mysql2/promise');
        const c = await mysql.createConnection(REAL);
        await c.query('DROP DATABASE IF EXISTS ' + DB);
        await c.query('CREATE DATABASE ' + DB);
        await c.query('USE ' + DB);
        await c.query('CREATE TABLE h_shift (id INT PRIMARY KEY, clock_in DATETIME NULL, seen TIMESTAMP NULL DEFAULT NULL, born DATE NULL, on_duty TINYINT(1) NULL, grade TINYINT(4) NULL, banned BOOLEAN NULL)');
        await c.query('INSERT INTO h_shift VALUES ' + ROWS);
        const [rows] = await c.query({ sql: 'SELECT * FROM h_shift ORDER BY id', typeCast: oxTypeCast });
        await c.end();
        process.env.FX_REAL_MARIA = '1';
        process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: REAL.replace(/\/?$/, '/' + DB), cis_database_cdc: '0' });
        return rows;
    }
    const mariaFile = path.join(dir, 'maria.sqlite');
    const m = new DatabaseSync(mariaFile);
    // The fake MariaDB reports each column's declared type as MariaDB would.
    m.exec('CREATE TABLE h_shift (id int PRIMARY KEY, clock_in datetime, seen timestamp, born date, on_duty tinyint(1), grade tinyint(4), banned tinyint(1))');
    m.exec('INSERT INTO h_shift VALUES ' + ROWS);
    m.close();
    process.env.FX_MARIA_FILE = mariaFile;
    return null;
}

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail));
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (v) => JSON.stringify(v);

(async () => {
    const mariaRows = await setupMaria();
    const fx = require('../harness/fx.js');
    const r = fx.registry;
    const call = (k, sql, p) => new Promise((res) => r[k](sql, p || [], (v, err) => res(err ? { err } : v), 'test', true));
    await fx.ready(30000);

    const want1 = { id: 1, clock_in: ms(DT), seen: ms(TS), born: day(D), on_duty: true, grade: 3, banned: false };
    const want2 = { id: 2, clock_in: null, seen: null, born: null, on_duty: null, grade: null, banned: null };
    if (mariaRows) {
        check('MariaDB with oxmysql typeCast gives the values this test expects', same(mariaRows, [want1, want2]), show(mariaRows));
    }

    // Engine DDL: the same columns, made through the engine, BOOLEAN spelled out.
    const made = await call('query', 'CREATE TABLE e_shift (id INT PRIMARY KEY, clock_in DATETIME NULL, seen TIMESTAMP NULL DEFAULT NULL, born DATE NULL, on_duty TINYINT(1) NULL, grade TINYINT(4) NULL, banned BOOLEAN NULL)');
    check('engine CREATE TABLE', !made.err, show(made));
    await call('query', 'INSERT INTO e_shift VALUES ' + ROWS);
    // A date written as a parameter and read back.
    await call('query', 'INSERT INTO e_shift (id, clock_in, born, on_duty) VALUES (?, ?, ?, ?)', [3, DT, D, true]);

    for (const t of ['h_shift', 'e_shift']) {
        const tag = t === 'h_shift' ? 'hydrated: ' : 'engine DDL: ';
        let v = await call('query', 'SELECT * FROM ' + t + ' WHERE id IN (1, 2) ORDER BY id');
        check(tag + 'query casts DATETIME, TIMESTAMP, DATE, TINYINT(1), BOOLEAN; keeps TINYINT(4); NULL stays NULL', same(v, [want1, want2]), show(v));
        v = await call('single', 'SELECT clock_in AS started, on_duty AS working FROM ' + t + ' WHERE id = 1');
        check(tag + 'an alias keeps its column\'s cast', same(v, { started: ms(DT), working: true }), show(v));
        v = await call('single', 'SELECT a.born, x.banned FROM ' + t + ' a JOIN ' + t + ' x ON x.id = a.id WHERE a.id = 1');
        check(tag + 'a join casts each column by its own table', same(v, { born: day(D), banned: false }), show(v));
        v = await call('scalar', 'SELECT on_duty FROM ' + t + ' WHERE id = 1');
        check(tag + 'scalar of a TINYINT(1) is a boolean', v === true, show(v));
        v = await call('scalar', 'SELECT seen FROM ' + t + ' WHERE id = 1');
        check(tag + 'scalar of a TIMESTAMP is epoch ms', v === ms(TS), show(v));
        v = await call('prepare', 'SELECT clock_in, born, on_duty FROM ' + t + ' WHERE id = ?', [1]);
        check(tag + 'prepare casts the dates, leaves TINYINT(1) a number', same(v, { clock_in: ms(DT), born: day(D), on_duty: 1 }), show(v));
        v = await call('rawExecute', 'SELECT seen, banned FROM ' + t + ' WHERE id = ?', [1]);
        check(tag + 'rawExecute casts the dates, leaves BOOLEAN a number', same(v, [{ seen: ms(TS), banned: 0 }]), show(v));
    }
    const v = await call('single', 'SELECT clock_in, born, on_duty FROM e_shift WHERE id = 3');
    check('engine DDL: values written as parameters read back cast', same(v, { clock_in: ms(DT), born: day(D), on_duty: true }), show(v));

    // A column added later is cast from then on; a renamed one keeps its type.
    await call('query', 'ALTER TABLE e_shift ADD COLUMN left_at DATETIME NULL');
    await call('query', "UPDATE e_shift SET left_at = '" + TS + "' WHERE id = 1");
    let w = await call('scalar', 'SELECT left_at FROM e_shift WHERE id = 1');
    check('ALTER TABLE ADD COLUMN DATETIME is cast', w === ms(TS), show(w));
    await call('query', 'ALTER TABLE e_shift CHANGE COLUMN left_at clock_out DATETIME NULL');
    w = await call('scalar', 'SELECT clock_out FROM e_shift WHERE id = 1');
    check('a renamed DATETIME column is still cast', w === ms(TS), show(w));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' failed' : 'all passed');
    if (REAL) {
        try {
            const mysql = require('mysql2/promise');
            const c = await mysql.createConnection(REAL);
            await c.query('DROP DATABASE IF EXISTS ' + DB);
            await c.end();
        } catch (e) { /* left for the next run to drop */ }
    }
    process.exit(failed ? 1 : 0);
})();
