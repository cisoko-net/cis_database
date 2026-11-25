'use strict';

// Security review F1/S2: mysql2 formats params client-side with backslash
// escapes, and the outbox runs batches with multipleStatements. On a MariaDB
// whose sql_mode has NO_BACKSLASH_ESCAPES, a player string such as
// x\'); DROP TABLE players; --  ended the literal and ran as a second
// statement. Every connection the replica pools open must first drop
// NO_BACKSLASH_ESCAPES, ANSI_QUOTES and ANSI from its session.
// The live half, against a real MariaDB, is tests/live/replica_sql_mode.js.
// Usage: node tests/repro/replica_sql_mode.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-sqlmode-'));
    const mariaFile = path.join(dir, 'maria.sqlite');
    const m = new DatabaseSync(mariaFile);
    m.exec('CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT)');
    m.close();
    process.env.FX_RES_DIR = dir;
    process.env.FX_MARIA_FILE = mariaFile;
    const fx = require('../harness/fx.js');
    const r = fx.registry;
    const call = (k, sql, p) => new Promise((res) => r[k](sql, p || [], (v, err) => res({ v: err ? false : v, err }), 'test', true));
    await fx.ready(20000);

    const evil = "x\\'); DROP TABLE players; -- ";
    await call('insert', 'INSERT INTO players (name) VALUES (?)', [evil]);
    const end = Date.now() + 15000;
    while (Date.now() < end) {
        const p = r.probe();
        if (p && p.replica === 0) break;
        await sleep(50);
    }
    const sent = fx.sessionSql();
    check('replica pools set the session sql_mode on the connections they open', sent.length > 0, sent.length + ' sent');
    const ok = sent.every((s) => /^SET SESSION sql_mode\b/.test(s) && s.includes('NO_BACKSLASH_ESCAPES') && s.includes('ANSI_QUOTES') && s.includes(',ANSI,'));
    check('each one removes NO_BACKSLASH_ESCAPES, ANSI_QUOTES and ANSI', ok, sent[0]);
    const mm = new DatabaseSync(mariaFile);
    const row = mm.prepare('SELECT name FROM players').get();
    mm.close();
    check('the player string reached MariaDB as one value', row && row.name === evil, JSON.stringify(row));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
