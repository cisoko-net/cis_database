'use strict';

// Pre-release review of 28dbdb1, M1: the outbox sent MariaDB the text
// UUID(), UUID_SHORT() or RAND(), so MariaDB made its own value and the row
// had another key there than in the game. Later UPDATEs by that key hit no
// row on MariaDB, and the next boot copied MariaDB's keys back. In an
// INSERT ... VALUES each call now becomes a bound value made once, so both
// sides store the same one. UPDATE and INSERT ... SELECT keep the call: one
// value for every row would change what they do.
// Usage: node tests/repro/replay_volatile.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-volatile-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE things (n VARCHAR(20) PRIMARY KEY, u VARCHAR(40), s BIGINT, r DOUBLE, note VARCHAR(40))');
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
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
async function drained(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (r.probe().replica === 0) return true; await sleep(50); }
    return false;
}
const mariaRow = (n) => {
    const db = new DatabaseSync(mariaFile);
    try { const st = db.prepare('SELECT u, s, r, note FROM things WHERE n = ?'); st.setReadBigInts(true); const x = st.get(n); if (x) x.r = x.r == null ? null : Number(x.r); return x; } finally { db.close(); }
};
const same = (a, b) => !!a && !!b && String(a.u) === String(b.u) && String(a.s) === String(b.s) && Number(a.r) === Number(b.r) && a.note === b.note;
const show = (x) => x ? `u=${x.u} s=${x.s} r=${x.r} note=${x.note}` : 'none';

(async () => {
    if (!(await fx.ready(20000))) throw new Error('not ready');
    global.__fxInvoker = 'some_script';

    await fx.call('update', 'INSERT INTO things (n, u, s, r, note) VALUES (?, UUID(), UUID_SHORT(), RAND(), ?)', ['one', 'after']);
    await fx.call('update', "INSERT INTO things (n, u, s, r, note) VALUES ('two', uuid( ), NULL, NULL, 'UUID()'), (?, UUID(), NULL, rand(), ?)", ['three', 'x']);
    check('the writes reach MariaDB', await drained(15000));
    for (const n of ['one', 'two', 'three']) {
        const lite = await fx.call('single', 'SELECT u, s, r, note FROM things WHERE n = ?', [n]);
        const mar = mariaRow(n);
        check(`row ${n} has the same values on both sides`, same(lite, mar), 'sqlite ' + show(lite) + ' | maria ' + show(mar));
    }
    const two = await fx.call('single', 'SELECT u FROM things WHERE n = ?', ['two']);
    const three = await fx.call('single', 'SELECT u FROM things WHERE n = ?', ['three']);
    check('each UUID() in a multi-row VALUES gets its own value', two && three && two.u !== three.u && /^[0-9a-f-]{36}$/.test(String(two.u)));
    const one = await fx.call('single', 'SELECT note FROM things WHERE n = ?', ['one']);
    check('a parameter after the calls keeps its place', one && one.note === 'after');

    const failed = results.filter((x) => !x).length;
    console.log(failed ? `replay_volatile: ${failed} FAILED` : `replay_volatile: all ${results.length} passed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack)); process.exit(1); });
