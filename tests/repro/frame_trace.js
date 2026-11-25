'use strict';

// Checks the per-frame trace (cis_database_frame_trace 1): known stalls land
// in the right category, categories never add up to more than the frame, and
// cache/frame_trace.json is written. The harness polls every 4 ms like
// index.lua's Wait(0) thread.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const HARNESS = path.join(__dirname, '..', 'harness', 'fx.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-trace-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE users (identifier VARCHAR(64) PRIMARY KEY, n INT NOT NULL)');
const ins = m.prepare('INSERT INTO users VALUES (?, ?)');
m.exec('BEGIN');
for (let i = 0; i < 20000; i++) ins.run('id' + i, i);
m.exec('COMMIT');
m.close();

const body = `
const fx = require(${JSON.stringify(HARNESS)});
const r = fx.registry;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const spin = (ms) => { const t = performance.now(); while (performance.now() - t < ms) {} };
(async () => {
    await fx.ready(20000);
    await sleep(2200);
    // A callback that blocks 30 ms: a hitch charged to cb.
    await new Promise((done) => r.single('SELECT n FROM users WHERE identifier = ?', ['id1'], () => { spin(30); done(); }));
    await sleep(50);
    // A slow statement: about ten million row visits, charged to sqlite.
    await new Promise((done) => r.scalar('SELECT COUNT(*) FROM users a, users b WHERE a.n < ? AND (a.n + b.n) % 7 = 3', [500], done));
    await sleep(50);
    for (let i = 0; i < 2000; i++) await new Promise((done) => r.single('SELECT n FROM users WHERE identifier = ?', ['id' + i], done));
    await sleep(2300);
    const cacheDir = require('path').join(process.env.FX_RES_DIR, 'cache');
    const tf = require('fs').readdirSync(cacheDir).find((n) => n.startsWith('frame_trace-') && n.endsWith('.json'));
    console.log('@file=' + JSON.stringify(require('fs').readFileSync(require('path').join(cacheDir, tf), 'utf8')));
    process.exit(0);
})();`;

const r = spawnSync(process.execPath, ['-e', body], {
    env: Object.assign({}, process.env, { FX_RES_DIR: dir, FX_MARIA_FILE: mariaFile, FX_CONVARS: JSON.stringify({ cis_database_frame_trace: '1' }) }),
    encoding: 'utf8', timeout: 120000,
});
const text = (r.stdout || '') + (r.stderr || '');
fs.rmSync(dir, { recursive: true, force: true });

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

const fm = text.match(/^@file=(.*)$/m);
check('frame_trace.json written', !!fm, fm ? '' : text.slice(-600));
const lines = text.split('\n').filter((l) => l.includes('frame_trace t='));
check('summary lines logged', lines.length >= 2, lines.length + ' lines; first: ' + (lines[0] || '').slice(0, 200));
if (fm) {
    const doc = JSON.parse(JSON.parse(fm[1]));
    const worst = [].concat(...doc.windows.map((w) => w.worst));
    const cbHitch = worst.find((f) => f.cb >= 25);
    check('30 ms callback shows as a cb hitch', !!cbHitch, JSON.stringify(cbHitch || worst.slice(0, 3)));
    const sqlHitch = worst.find((f) => f.sqlite >= 15);
    check('slow statement shows as a sqlite hitch', !!sqlHitch, JSON.stringify(sqlHitch || worst.slice(0, 3)));
    const over = worst.filter((f) => f.sqlite + f.js + f.cb + f.poll + f.replica + f.ckpt > f.gap + 0.5);
    check('categories never exceed the frame', over.length === 0, JSON.stringify(over.slice(0, 2)));
    const t = doc.total;
    check('total counts the 2000+ calls', t.perFrame.calls * t.frames >= 2000, 'calls=' + (t.perFrame.calls * t.frames).toFixed(0) + ' frames=' + t.frames);
    console.log('total: ' + JSON.stringify({ frames: t.frames, hitches: t.hitches, maxGap: t.maxGap, buckets: t.buckets, perFrame: t.perFrame }));
}
const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
