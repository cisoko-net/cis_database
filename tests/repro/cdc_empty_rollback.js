'use strict';

// The change copy of a table MariaDB holds no rows of empties the SQLite copy:
// BEGIN IMMEDIATE, DELETE, COMMIT. When the table is not in SQLite yet the
// DELETE throws, and the transaction stayed open, so the game's next write ran
// inside it and BEGIN failed until the 5 s rescue ended it. It must roll back.
// Usage: node tests/repro/cdc_empty_rollback.js

const { DatabaseSync } = require('node:sqlite');
const { startCdc } = require('../../cdc.js');

const db = new DatabaseSync(':memory:');
const backend = {
    exec: (s) => db.exec(s),
    run: (s, p) => db.prepare(s).run(...(p || [])),
    get: (s, p) => db.prepare(s).get(...(p || [])),
    all: (s, p) => db.prepare(s).all(...(p || [])),
};
const conn = {
    async query() { return [[]]; },
    async end() {},
};
const mysql2mod = { createConnection: async () => conn };
const quiet = { info() {}, debug() {}, warn() {}, error() {} };

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

function inTransaction() {
    try {
        db.exec('BEGIN');
        db.exec('ROLLBACK');
        return false;
    } catch (e) {
        return true;
    }
}

(async () => {
    const cdc = startCdc({
        mysql2mod, dsn: { host: 'x', port: 3306, user: 'u', password: '', database: 'd' }, backend,
        dirtyTables: new Set(), pollMs: 3600000, dirtyTtlMs: 2000, log: quiet, baseline: Promise.resolve(),
    });
    await cdc.reload('ghost_table');
    check('no transaction is left open after an empty table SQLite lacks', !inTransaction());
    db.exec('CREATE TABLE kept (id INTEGER PRIMARY KEY)');
    db.exec('INSERT INTO kept VALUES (1)');
    await cdc.reload('kept');
    const n = db.prepare('SELECT COUNT(*) AS n FROM kept').get().n;
    check('an empty MariaDB table still empties the SQLite copy', n === 0, 'n=' + n);
    check('no transaction is left open after that either', !inTransaction());
    cdc.stop();
    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
