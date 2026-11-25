'use strict';

// Hot-path cost of the export entry, in-process: boots server.js through the
// harness (no MariaDB delay), seeds 5000 users, then times N callback-form
// calls of a PK select and a PK update, per call, best of several rounds.
// Usage: node tests/bench/submit.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-bench-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE users (identifier VARCHAR(64) PRIMARY KEY, accounts TEXT NOT NULL)');
const ins = m.prepare('INSERT INTO users VALUES (?, ?)');
m.exec('BEGIN');
for (let i = 0; i < 5000; i++) ins.run('id' + i, '{"bank":' + i + '}');
m.exec('COMMIT');
m.close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;
process.env.FX_MARIA_WRITES = 'down';

const fx = require('../harness/fx.js');
const r = fx.registry;

function round(n, fn) {
    return new Promise((resolve) => {
        let left = n;
        const t0 = process.hrtime.bigint();
        const done = () => { if (--left === 0) resolve(Number(process.hrtime.bigint() - t0) / 1000 / n); };
        for (let i = 0; i < n; i++) fn(i, done);
    });
}

(async () => {
    await fx.ready(20000);
    const N = 20000;
    const sel = (i, done) => r.single('SELECT * FROM users WHERE identifier = ?', ['id' + (i % 5000)], done);
    const tx = (i, done) => r.transaction([{ query: 'UPDATE users SET accounts = ? WHERE identifier = ?', values: ['{"t":' + i + '}', 'id' + (i % 5000)] }, { query: 'UPDATE users SET accounts = ? WHERE identifier = ?', values: ['{"u":' + i + '}', 'id' + ((i + 1) % 5000)] }], done);
    const upd = (i, done) => r.update('UPDATE users SET accounts = ? WHERE identifier = ?', ['{"bank":' + i + '}', 'id' + (i % 5000)], done);
    for (let w = 0; w < 2; w++) { await round(N, sel); await round(N, upd); await round(N, tx); }
    const best = { sel: Infinity, upd: Infinity, tx: Infinity };
    for (let k = 0; k < 7; k++) {
        best.sel = Math.min(best.sel, await round(N, sel));
        best.upd = Math.min(best.upd, await round(N, upd));
        best.tx = Math.min(best.tx, await round(N, tx));
    }
    console.log('select_pk_us=' + best.sel.toFixed(2) + ' update_pk_us=' + best.upd.toFixed(2) + ' transaction2_us=' + best.tx.toFixed(2));
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
})();
