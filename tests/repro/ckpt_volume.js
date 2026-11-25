'use strict';

// Checkpoint cycles during a bulk import (server.js, noteWalWrite): the
// cycle trigger counts rows changed, so multi-row INSERTs start cycles while
// they run, the WAL starts over inside the preallocated file, and no single
// copy is large. Counted per statement, 320 statements of 250 rows ran with
// one cycle, the WAL grew past the preallocated file, and that cycle copied
// for 25 ms.
// Usage: node tests/repro/ckpt_volume.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-ckptvol-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE players (citizenid VARCHAR(16) NOT NULL PRIMARY KEY, name VARCHAR(64) NOT NULL, charinfo LONGTEXT, metadata LONGTEXT)');
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

(async () => {
    if (!(await fx.ready(20000))) throw new Error('not ready');
    const wal = path.join(dir, 'cache', 'durable.sqlite-wal');
    // The file is grown a step per turn after boot; start once it is done.
    const want = 32 + 4120 * Math.ceil(8192 * 1.25);
    const filled = Date.now() + 5000;
    while (Date.now() < filled && r.probe().wal_prealloc < want) await sleep(10);
    const boot = fs.statSync(wal).size;
    const p0 = fx.asSelf(() => r.probe(true));
    const B = 250;
    const N = 320;
    for (let s = 0; s < N; s++) {
        const rows = [];
        const vals = [];
        for (let k = 0; k < B; k++) {
            const i = s * B + k;
            rows.push('(?, ?, ?, ?)');
            vals.push('C' + String(i).padStart(7, '0'), 'Name ' + i, JSON.stringify({ firstname: 'F' + i, lastname: 'L' + i, phone: '555' + i, account: 'US' + i }), JSON.stringify({ hunger: 100, thirst: 100, stress: i % 30, bloodtype: 'O+', walletid: 'W' + i, licences: { driver: true } }));
        }
        await fx.call('query', 'INSERT INTO players (citizenid, name, charinfo, metadata) VALUES ' + rows.join(','), vals);
        // Let setImmediate and the thread pool run, as a server tick would.
        await sleep(2);
    }
    const p = r.probe();
    const cycles = p.ckpt_n - p0.ckpt_n;
    const size = fs.statSync(wal).size;
    check('multi-row INSERTs start checkpoint cycles while they run', cycles >= 10, cycles + ' cycles during ' + N + ' statements');
    check('the WAL starts over during the import', p.wal_restarts - p0.wal_restarts >= 1, 'restarts=' + (p.wal_restarts - p0.wal_restarts) + ' wal_frames=' + p.wal_frames);
    check('and stays inside the preallocated file', size === boot, 'boot=' + boot + ' now=' + size);
    check('no copy is large', p.ckpt_copy_max_ms < 10, 'copy_max=' + p.ckpt_copy_max_ms + ' ms');
    const n = await fx.call('scalar', 'SELECT COUNT(*) FROM players', []);
    check('every row is there', Number(n) === N * B, 'rows=' + n);
    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + e.stack); process.exit(1); });
