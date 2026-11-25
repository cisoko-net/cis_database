'use strict';

// The change copy reads MariaDB a page at a time, then deletes every SQLite
// row whose key it did not see. Outside a forced scan, a row the game wrote
// while the copy waited for MariaDB's last page was deleted with them: only
// a forced scan asked writtenSince before the DELETE. Both modes now give
// the table up when the game wrote it since the copy began.
// Usage: node tests/repro/cdc_pause_insert.js

const { DatabaseSync } = require('node:sqlite');
const { startCdc } = require('../../cdc.js');

const db = new DatabaseSync(':memory:');
const backend = {
    exec: (s) => db.exec(s),
    run: (s, p) => db.prepare(s).run(...(p || [])),
    get: (s, p) => db.prepare(s).get(...(p || [])),
    all: (s, p) => db.prepare(s).all(...(p || [])),
};
let cdc = null;
let onPage = null;
const conn = {
    async query(sql) {
        if (/^SELECT \* FROM/.test(sql)) {
            // The game writes while this page is on its way.
            if (onPage) { onPage(); onPage = null; }
            return [[{ id: 1, v: 'maria' }]];
        }
        return [[]];
    },
    async end() {},
};
const mysql2mod = { createConnection: async () => conn };
const quiet = { info() {}, debug() {}, warn() {}, error() {} };

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const ids = (t) => db.prepare('SELECT id FROM ' + t + ' ORDER BY id').all().map((r) => r.id).join(',');

(async () => {
    cdc = startCdc({
        mysql2mod, dsn: { host: 'x', port: 3306, user: 'u', password: '', database: 'd' }, backend,
        dirtyTables: new Set(), pollMs: 3600000, dirtyTtlMs: 50, log: quiet, baseline: Promise.resolve(),
    });
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.exec("INSERT INTO t VALUES (1, 'old'), (3, 'gone in maria')");
    onPage = () => {
        db.exec("INSERT INTO t VALUES (2, 'game')");
        cdc.noteDirty('t');
    };
    await cdc.reload('t');
    check('a row the game wrote during the last page survives', ids('t').split(',').indexOf('2') >= 0, ids('t'));
    // Later, with no write during the copy, MariaDB's delete still lands.
    await new Promise((r) => setTimeout(r, 120));
    db.exec('DELETE FROM t WHERE id = 2');
    await cdc.reload('t');
    check('a quiet copy still removes rows MariaDB deleted', ids('t') === '1', ids('t'));
    const v = db.prepare('SELECT v FROM t WHERE id = 1').get();
    check('and takes MariaDB\'s values', v && v.v === 'maria', JSON.stringify(v));
    cdc.stop();
    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
