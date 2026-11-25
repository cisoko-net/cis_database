'use strict';

// Cost of the bulk-import path: cis_bench's seed, multi-row INSERTs of 250
// rows x 11 params with JSON text, the way a migration or a framework
// installer loads data. Prints ms per call and the engine's slice stats.
// Usage: node tests/bench/bulk.js   (node --cpu-prof ... to profile)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-bulk-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec(`CREATE TABLE cbench_players (citizenid VARCHAR(16) NOT NULL PRIMARY KEY, license VARCHAR(64) NOT NULL UNIQUE, name VARCHAR(64) NOT NULL,
  jobname VARCHAR(32) NOT NULL DEFAULT 'unemployed', money INT NOT NULL DEFAULT 0, bank INT NOT NULL DEFAULT 0, charinfo LONGTEXT, job LONGTEXT,
  metadata LONGTEXT, inventory LONGTEXT, position VARCHAR(128), last_updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX jobname ON cbench_players (jobname);`);
m.close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;

const fx = require('../harness/fx.js');
const r = fx.registry;

const JOBS = ['unemployed', 'unemployed', 'unemployed', 'police', 'ambulance', 'mechanic', 'taxi', 'realestate'];
const cid = (i) => 'C' + String(i).padStart(7, '0');
const charinfo = (i) => JSON.stringify({ firstname: 'First' + i, lastname: 'Last' + i, birthdate: '1990-01-01', gender: i % 2, nationality: 'American', phone: '555' + String(i).padStart(7, '0'), account: 'US' + String(i).padStart(10, '0') });
const metadata = (i) => JSON.stringify({ hunger: 100, thirst: 100, stress: i % 30, armor: 0, isdead: false, inlaststand: false, jailitems: {}, status: {}, phone: {}, fitbit: {}, commandbinds: {}, bloodtype: 'O+', walletid: 'W' + i, criminalrecord: { hasRecord: false }, licences: { driver: true, business: false, weapon: false } });
const inventory = (i) => JSON.stringify(Array.from({ length: 12 }, (_, k) => ({ slot: k + 1, name: k % 3 ? 'bread' : 'water', count: (i + k) % 20 + 1, metadata: {} })));

(async () => {
    if (!(await fx.ready(20000))) throw new Error('not ready');
    const B = 250;
    const N = Number(process.env.N) || 20000;
    const times = [];
    fx.asSelf(() => r.probe(true));
    for (let base = 1; base <= N; base += B) {
        const rows = [];
        const vals = [];
        for (let i = base; i < base + B; i++) {
            rows.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            const job = JOBS[i % JOBS.length];
            vals.push(cid(i), 'license:' + i, 'First' + i + ' Last' + i, job, 500 + i % 1000, 10000 + i % 50000, charinfo(i),
                JSON.stringify({ name: job, label: job, grade: { level: i % 4 } }), metadata(i), inventory(i), '{"x":0.0,"y":0.0,"z":0.0}');
        }
        const t0 = performance.now();
        await fx.call('query', 'INSERT INTO cbench_players (citizenid, license, name, jobname, money, bank, charinfo, job, metadata, inventory, position) VALUES ' + rows.join(','), vals);
        times.push(performance.now() - t0);
    }
    const p = fx.asSelf(() => r.probe(true));
    times.sort((a, b) => a - b);
    const sum = times.reduce((a, b) => a + b, 0);
    console.log('calls=' + times.length + ' mean=' + (sum / times.length).toFixed(2) + ' ms p50=' + times[times.length >> 1].toFixed(2) + ' max=' + times[times.length - 1].toFixed(2)
        + ' | per row ' + (sum / N * 1000).toFixed(1) + ' us | slice_max=' + p.slice_max_ms + ' ms queued=' + p.queued_total);
    const end = Date.now() + 60000;
    while (Date.now() < end && r.probe().replica > 0) await new Promise((res) => setTimeout(res, 50));
    console.log('outbox drained: ' + (r.probe().replica === 0));
    process.exit(0);
})();
