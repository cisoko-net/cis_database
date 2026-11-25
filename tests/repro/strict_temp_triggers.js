'use strict';

// The strict-mode triggers live on the main connection only (TEMP triggers),
// not in the file's schema. SQLite parses the whole schema on each
// connection's first statement, and the checkpoint connections open at every
// boot: on qbox the strict triggers were 727 KB of a 773 KB schema (468
// triggers), and each connection's first statement held a warm boot tick for
// about 50 ms inside FXServer.
//
// Checks: a boot that makes strict tables leaves no cis_strict: trigger in
// the file, a file with triggers from an earlier build loses them at the next
// boot, and on that boot the checks still refuse what MariaDB refuses, keep
// storing what MariaDB stores, and follow ALTER TABLE.
// Usage: node tests/repro/strict_temp_triggers.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const TABLES = 40;

if (process.argv[2] === '--child') {
    const fx = require('../harness/fx.js');
    const r = fx.registry;
    const call = (k, sql, p) => new Promise((res) => r[k](sql, p || [], (v, err) => res({ v: err ? false : v, err }), 'test', true));
    const errText = (x) => String(x.err && (x.err.message || x.err) || '');
    fx.ready(60000).then(async (ok) => {
        const out = { ready: ok };
        if (ok && process.env.STEP === 'create') {
            for (let i = 0; i < TABLES; i++) {
                const cols = [];
                for (let k = 0; k < 12; k++) cols.push('v' + k + ' VARCHAR(5)', 'n' + k + ' TINYINT', 'd' + k + ' DECIMAL(5,1)');
                await call('query', 'CREATE TABLE s' + i + ' (id INT AUTO_INCREMENT PRIMARY KEY, ' + cols.join(', ') + ')');
            }
            out.made = errText(await call('query', "INSERT INTO s0 (v0, n0, d0) VALUES ('abc', 1, 1.25)")) || 'ok';
        }
        if (ok && process.env.STEP === 'check') {
            out.tooLong = errText(await call('query', "INSERT INTO s1 (v3) VALUES ('abcdefgh')"));
            out.range = errText(await call('query', 'UPDATE s0 SET n5 = 300 WHERE id = 1'));
            await call('query', 'INSERT INTO s2 (n4) VALUES (3.6)');
            out.stored = (await call('query', 'SELECT n4 FROM s2')).v;
            await call('query', 'ALTER TABLE s3 ADD COLUMN w VARCHAR(2) NULL');
            out.altered = errText(await call('query', "INSERT INTO s3 (w) VALUES ('abc')"));
        }
        process.send(out, () => process.kill(process.pid, 'SIGKILL'));
    });
    return;
}

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

function boot(dir, mariaFile, step) {
    return new Promise((res) => {
        const child = fork(__filename, ['--child'], {
            env: Object.assign({}, process.env, { FX_RES_DIR: dir, FX_MARIA_FILE: mariaFile, STEP: step }),
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let msg = null;
        let err = '';
        child.stderr.on('data', (d) => { err += d; });
        child.on('message', (m) => { msg = m; });
        child.on('exit', () => res(Object.assign({ ready: false, err: err.slice(-400) }, msg || {})));
    });
}

// What a fresh connection finds in the file: the strict triggers' bytes, and
// the time its first statement takes to parse the schema.
function fileSchema(file) {
    const db = new DatabaseSync(file);
    const t0 = performance.now();
    db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
    const firstMs = performance.now() - t0;
    const s = db.prepare("SELECT count(*) AS n, coalesce(sum(length(sql)), 0) AS bytes FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'cis\\_strict:%' ESCAPE '\\'").get();
    const all = db.prepare('SELECT coalesce(sum(length(sql)), 0) AS bytes FROM sqlite_master').get();
    db.close();
    return { n: Number(s.n), bytes: Number(s.bytes), all: Number(all.bytes), firstMs: Math.round(firstMs * 10) / 10 };
}

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-strict-temp-'));
    const mariaFile = path.join(dir, 'maria.sqlite');
    const m = new DatabaseSync(mariaFile);
    m.exec('CREATE TABLE fake_columns (table_name TEXT, column_name TEXT, extra TEXT, column_default TEXT, generation_expression TEXT);');
    m.close();
    const file = path.join(dir, 'cache', 'durable.sqlite');

    const first = await boot(dir, mariaFile, 'create');
    check('the boot that makes ' + TABLES + ' strict tables is ready', first.ready && first.made === 'ok', first.made || first.err);
    const made = fileSchema(file);
    check('the file holds no strict-mode trigger', made.n === 0, made.n + ' triggers, ' + made.bytes + ' of ' + made.all + ' schema bytes, first statement ' + made.firstMs + ' ms');

    // A file from an earlier build kept them in its schema.
    const old = new DatabaseSync(file);
    old.exec('CREATE TRIGGER IF NOT EXISTS "cis_strict:s0:insert" BEFORE INSERT ON "s0" FOR EACH ROW WHEN 0 BEGIN SELECT 1; END');
    old.exec('CREATE TRIGGER IF NOT EXISTS "cis_strict:s1:store_insert" AFTER INSERT ON "s1" FOR EACH ROW WHEN 0 BEGIN SELECT 1; END');
    old.close();

    const next = await boot(dir, mariaFile, 'check');
    check('the next boot is ready', next.ready, next.ready ? '' : next.err);
    const after = fileSchema(file);
    check('it drops strict-mode triggers an earlier build left in the file', after.n === 0, after.n + ' triggers left');
    check('a value too long is still refused', /Data too long for column 'v3'/.test(next.tooLong || ''), next.tooLong);
    check('an UPDATE out of range is still refused', /Out of range value for column 'n5'/.test(next.range || ''), next.range);
    check('a value is still stored as MariaDB stores it', JSON.stringify(next.stored) === '[{"n4":4}]', JSON.stringify(next.stored));
    check('a column ALTER TABLE adds is checked', /Data too long for column 'w'/.test(next.altered || ''), next.altered);

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows keeps the file open */ }
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
