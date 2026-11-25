'use strict';

// A SQLite cache older than MariaDB's mark for its outbox epoch: a cache/
// restored from a backup, a resource folder copied with its cache to another
// install on the same MariaDB, or a file that lost its last commits in a
// crash after MariaDB applied them. The outbox ids start again below the
// mark MariaDB holds for the epoch, so new writes counted as applied and were
// never sent (found by the bench on 2026-10-25). Each case boots server.js in
// a child process through tests/harness/fx.js against a fake MariaDB file
// that survives restarts.
// Usage: node tests/repro/outbox_rewind.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const HARNESS = path.join(__dirname, '..', 'harness', 'fx.js');

const PRELUDE = "const fx = require(" + JSON.stringify(HARNESS) + ");\n"
    + "const r = fx.registry;\n"
    + "const q = (sql, p) => fx.call('query', sql, p || []);\n"
    + "const out = (k, v) => console.log('@' + k + '=' + JSON.stringify(v));\n"
    + "const sleep = (ms) => new Promise((res) => setTimeout(res, ms));\n"
    + "const drained = async (ms) => { const end = Date.now() + (ms || 15000); while (Date.now() < end) { const p = r.probe(); if (p && p.replica === 0) return true; await sleep(50); } return false; };\n"
    + "const write = async (from, n) => { for (let i = from; i < from + n; i++) await fx.call('insert', 'INSERT INTO logs (seq, note) VALUES (?, ?)', [i, 'w']); };\n";

function runChild(env, body) {
    const code = PRELUDE
        + "(async () => {\nif (!(await fx.ready(20000))) throw new Error('not ready');\n"
        + body + "\n})().catch((e) => { console.log('CHILD ERROR ' + (e && e.stack)); process.exit(2); });";
    const r = spawnSync(process.execPath, ['-e', code], { env: Object.assign({}, process.env, env), encoding: 'utf8', timeout: 90000 });
    const text = (r.stdout || '') + (r.stderr || '');
    const vals = {};
    for (const m of text.matchAll(/^@(\w+)=(.*)$/gm)) vals[m[1]] = JSON.parse(m[2]);
    return { vals, text };
}

const EXIT = 'process.exit(0);';
const SEED = "CREATE TABLE logs (seq INT, note TEXT);"
    + "CREATE INDEX seq ON logs (seq);"
    + "CREATE TABLE users (identifier VARCHAR(64) PRIMARY KEY, money INT NOT NULL);"
    + "INSERT INTO users (identifier, money) VALUES ('alice', 100);";

function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-rewind-'));
    const mariaFile = path.join(dir, 'maria.sqlite');
    const m = new DatabaseSync(mariaFile);
    m.exec(SEED);
    m.close();
    return { dir, mariaFile, env: { FX_RES_DIR: dir, FX_MARIA_FILE: mariaFile } };
}

function maria(s, sql) {
    const m = new DatabaseSync(s.mariaFile);
    try { return m.prepare(sql).all(); } finally { m.close(); }
}

// The whole cache/ folder, as an owner's backup or a copied resource has it.
function saveCache(s) {
    const to = path.join(s.dir, 'cache-backup');
    fs.cpSync(path.join(s.dir, 'cache'), to, { recursive: true });
    return to;
}

function restoreCache(s, from) {
    const cache = path.join(s.dir, 'cache');
    fs.rmSync(cache, { recursive: true, force: true });
    fs.cpSync(from, cache, { recursive: true });
}

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

function done(s) {
    try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch (e) { /* Windows may hold the file a moment */ }
}

function childErr(...runs) {
    const bad = runs.find((x) => x.text.includes('CHILD ERROR'));
    return bad ? ' child: ' + bad.text.slice(-400) : '';
}

const COUNT = 'SELECT COUNT(*) AS n, COUNT(DISTINCT seq) AS d, SUM(seq >= 1000) AS late FROM logs';

// 1. cache/ restored from a backup, MariaDB up at boot.
{
    const s = setup();
    const b1 = runChild(s.env, "await write(0, 50); out('drained', await drained());" + EXIT);
    const backup = saveCache(s);
    const b2 = runChild(s.env, "await write(50, 50); out('drained', await drained());" + EXIT);
    restoreCache(s, backup);
    const b3 = runChild(s.env, "out('served', (await q('SELECT COUNT(*) AS n FROM logs'))[0].n);"
        + "await write(1000, 30); out('drained', await drained());" + EXIT);
    const b4 = runChild(s.env, "out('drained', await drained()); out('served', (await q('SELECT COUNT(*) AS n FROM logs'))[0].n);" + EXIT);
    const rows = maria(s, COUNT)[0];
    check('restored cache: writes after the restore reach MariaDB', b3.vals.drained === true && rows.n === 130 && rows.d === 130 && rows.late === 30,
        JSON.stringify(rows) + childErr(b1, b2, b3, b4));
    const local = new DatabaseSync(path.join(s.dir, 'cache', 'durable.sqlite'));
    const idx = local.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'logs' AND sql IS NOT NULL").all().map((x) => x.name);
    local.close();
    check('restored cache: the tables copied again keep their indexes', idx.length === 1, JSON.stringify(idx));
    check('restored cache: served data is MariaDB\'s, not the backup\'s',b3.vals.served === 100 && b4.vals.served === 130,
        'boot after restore served ' + b3.vals.served + ', next boot ' + b4.vals.served);
    done(s);
}

// 2. cache/ restored, MariaDB down at the first boot after the restore: the
// writes made then are not the ones MariaDB already has under the epoch.
{
    const s = setup();
    runChild(s.env, "await write(0, 50); out('drained', await drained());" + EXIT);
    const backup = saveCache(s);
    runChild(s.env, "await write(50, 50); out('drained', await drained());" + EXIT);
    restoreCache(s, backup);
    const b3 = runChild(Object.assign({ FX_MARIA_DOWN: '1' }, s.env), "await write(1000, 30); out('served', (await q('SELECT COUNT(*) AS n FROM logs'))[0].n);" + EXIT);
    const b4 = runChild(s.env, "out('drained', await drained());" + EXIT);
    const rows = maria(s, COUNT)[0];
    check('restored cache, MariaDB down: writes made while down reach MariaDB once', b3.vals.served === 80 && b4.vals.drained === true
        && rows.n === 130 && rows.d === 130 && rows.late === 30, JSON.stringify(rows) + ' served while down=' + b3.vals.served + childErr(b3, b4));
    done(s);
}

// 3. A plain restart is not taken for a rewind.
{
    const s = setup();
    runChild(s.env, "await write(0, 50); out('drained', await drained());" + EXIT);
    const b2 = runChild(s.env, "await write(50, 50); out('drained', await drained());" + EXIT);
    const rows = maria(s, COUNT)[0];
    check('plain restart: no rewind, every write once', rows.n === 100 && rows.d === 100 && !/rewound|older than MariaDB/i.test(b2.text),
        JSON.stringify(rows) + childErr(b2));
    done(s);
}

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
