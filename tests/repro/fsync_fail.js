'use strict';

// A write is answered only after an fdatasync of the WAL covers it
// (README: "answers a write after it is on disk"). When that fdatasync
// failed, cis counted the error and answered the write anyway, and let its
// outbox row go to MariaDB. Now a failed sync answers nothing and sends
// nothing: the sync is retried, the writes are answered by the first one that
// succeeds, and cis_database_doctor reports the failures.
// Usage: node tests/repro/fsync_fail.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Fail every write-ack sync while failing is true (only pumpWal's).
let failing = false;
let failed = 0;
const realSync = fs.fdatasync;
fs.fdatasync = function (fd, cb) {
    if (!/\bpumpWal\b/.test(new Error().stack) || !failing) return realSync.call(fs, fd, cb);
    failed++;
    setImmediate(() => { const e = new Error('EIO: i/o error, fdatasync'); e.code = 'EIO'; cb(e); });
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-fsyncfail-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, seq INT)');
m.close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;
process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: 'mysql://root@127.0.0.1/fake', cis_database_cdc: '0' });

const commands = {};
global.RegisterCommand = (name, fn, restricted) => { commands[name] = { fn, restricted }; };

const fx = require('../harness/fx.js');
const r = fx.registry;

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const mariaLogs = () => {
    const db = new DatabaseSync(mariaFile);
    const n = db.prepare('SELECT COUNT(*) AS n FROM logs').get().n;
    db.close();
    return Number(n);
};
function doctor() {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try { commands.cis_database_doctor.fn(0, []); } finally { console.log = orig; }
    return lines.find((l) => /fdatasync/.test(l)) || '';
}

(async () => {
    check('engine ready', await fx.ready(20000));
    await new Promise((res) => r.insert(null, 'INSERT INTO logs (seq) VALUES (?)', [0], () => res(), 'test'));
    await sleep(400);
    const base = mariaLogs();
    check('doctor: no failed sync yet is OK', /OK /.test(doctor()), doctor());

    failing = true;
    let answered = false;
    r.insert(null, 'INSERT INTO logs (seq) VALUES (?)', [1], () => { answered = true; }, 'test');
    await sleep(600);
    check('the sync failed at least once', failed >= 1, String(failed));
    check('a write its sync failed for is not answered', answered === false);
    check('its row does not reach MariaDB', mariaLogs() === base, mariaLogs() + ' vs ' + base);
    const d = doctor();
    check('doctor reports the failed syncs as a FAIL', /FAIL/.test(d) && /fdatasync/.test(d), d);

    failing = false;
    for (let i = 0; i < 40 && !answered; i++) await sleep(100);
    check('a later sync that succeeds answers the write', answered === true);
    for (let i = 0; i < 30 && mariaLogs() === base; i++) await sleep(100);
    check('then its row reaches MariaDB', mariaLogs() === base + 1, String(mariaLogs()));

    const bad = results.filter((x) => !x).length;
    console.log(bad ? bad + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(bad ? 1 : 0);
})().catch((e) => {
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
