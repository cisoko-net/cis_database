'use strict';

// Boot held the server thread for one long block after hydrate: the column
// meta, the strict-mode triggers of every table, ANALYZE and the boot fsyncs
// ran back to back with no turn of the event loop between them. FXServer
// printed a 300-540 ms hitch warning on every boot of the 2026-10-27 bench.
// Each case boots server.js through tests/harness/fx.js against a fake
// MariaDB shaped like a qbox database, watches the event loop with a 2 ms
// timer from the first line after server.js loads until shortly after ready,
// and fails on any gap longer than the frame budget plus a margin.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const HARNESS = path.join(__dirname, '..', 'harness', 'fx.js');
const TABLES = 112;
const ROWS = 12000;
const FRAME = 25;
// Above the budget: a slice may overrun it by one statement, and the
// harness's own timers and the fake MariaDB run on the same thread.
const LIMIT = FRAME + 20;
const PRE_READY = 40;

function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-boot-hitch-'));
    const mariaFile = path.join(dir, 'maria.sqlite');
    const m = new DatabaseSync(mariaFile);
    m.exec('BEGIN');
    for (let t = 0; t < TABLES; t++) {
        m.exec('CREATE TABLE t' + t + ' (id INTEGER PRIMARY KEY AUTOINCREMENT, citizenid VARCHAR(50) NOT NULL, name VARCHAR(255),'
            + ' money INT NOT NULL DEFAULT 0, data LONGTEXT, updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP, flag TINYINT(1) DEFAULT 0, label VARCHAR(100))');
        m.exec('CREATE INDEX t' + t + '_cid ON t' + t + ' (citizenid)');
        m.exec('CREATE UNIQUE INDEX t' + t + '_lab ON t' + t + ' (label)');
    }
    const per = Math.floor(ROWS / TABLES);
    for (let t = 0; t < TABLES; t++) {
        const st = m.prepare('INSERT INTO t' + t + ' (citizenid, name, money, data, flag, label) VALUES (?, ?, ?, ?, ?, ?)');
        for (let i = 0; i < per; i++) st.run('C' + (i % 50), 'name' + i, i, '{"a":' + i + '}', i & 1, 'L' + i);
    }
    m.exec('COMMIT');
    m.close();
    return { dir, mariaFile, env: { FX_RES_DIR: dir, FX_MARIA_FILE: mariaFile, FX_CONVARS: JSON.stringify({ cis_database_frame_ms: String(FRAME) }) } };
}

// Every fdatasync answers late, the WAL's last (a sync left unawaited then
// shows), and each one records whether it had
// answered when the engine said ready; a blocking one has answered by then.
// Boot must have waited for its syncs.
const SLOW_SYNC = "const fs = require('fs'); const fdPath = new Map(); const syncs = [];\n"
    + "const realOpen = fs.openSync; fs.openSync = function (p, ...a) { const fd = realOpen.call(fs, p, ...a); fdPath.set(fd, String(p)); return fd; };\n"
    + "const realSync = fs.fdatasync; fs.fdatasync = function (fd, cb) { const s = { path: fdPath.get(fd) || '', done: false }; syncs.push(s);\n"
    + "  realSync.call(fs, fd, (e) => setTimeout(() => { s.done = true; cb(e); }, /-wal$/.test(s.path) ? 600 : 300)); };\n"
    + "const realSyncSync = fs.fdatasyncSync; fs.fdatasyncSync = function (fd) { realSyncSync.call(fs, fd); syncs.push({ path: fdPath.get(fd) || '', done: true }); };\n";

// The disk fills while a chunk of column types is written: the COMMIT of the
// chunk that holds t50 fails once, as SQLITE_FULL leaves the transaction open.
const COMMIT_FULL = "const sq = require('node:sqlite'); const syncs = []; let armed = false; let fired = false;\n"
    + "const realRun = sq.StatementSync.prototype.run; sq.StatementSync.prototype.run = function (...a) {\n"
    + "  if (!fired && a[0] === 't50' && /__cis_columns/.test(this.sourceSQL)) armed = true; return realRun.apply(this, a); };\n"
    + "const realExec = sq.DatabaseSync.prototype.exec; sq.DatabaseSync.prototype.exec = function (sql) {\n"
    + "  if (armed && /^\\s*COMMIT\\s*$/i.test(sql)) { armed = false; fired = true; throw new Error('database or disk is full'); } return realExec.call(this, sql); };\n";

function runChild(env, body, pre) {
    const code = (pre || '') + "const fx = require(" + JSON.stringify(HARNESS) + ");\n"
        + "const out = (k, v) => console.log('@' + k + '=' + JSON.stringify(v));\n"
        + "let last = Date.now(); let maxGap = 0; let watching = true;\n"
        + "setInterval(() => { const n = Date.now(); if (watching && n - last > maxGap) maxGap = n - last; last = n; }, 2);\n"
        // Run order, not answer order: the insert ids show the order the
        // statements ran in. A deferred answer may come back after a later one.
        // A burst before ready, then one call a millisecond through boot, the
        // drain of the queue and after: none may run ahead of an earlier one.
        + "const answers = []; const tag = 'ord' + process.pid; let n = 0; let ticking = true;\n"
        + "const send = () => { const i = n++; answers.push(fx.call('insert', 'INSERT INTO t0 (citizenid, label) VALUES (?, ?)', [tag, tag + '-' + i])); };\n"
        + "for (let i = 0; i < " + PRE_READY + "; i++) send();\n"
        + "const ticker = setInterval(() => { if (ticking) send(); }, 1);\n"
        + (pre ? "answers[0].then(() => out('syncedAtFirstAck', syncs.filter((s) => s.done).map((s) => s.path)));\n" : '')
        + "(async () => {\nif (!(await fx.ready(120000))) throw new Error('not ready');\n"
        + (pre ? "out('syncedAtReady', syncs.filter((s) => s.done).map((s) => s.path));\n" : '')
        + "await new Promise((r) => setTimeout(r, 300));\nticking = false; clearInterval(ticker);\n"
        + "await new Promise((r) => setTimeout(r, 300));\nwatching = false;\nout('maxGap', maxGap);\n"
        + "await Promise.all(answers);\n"
        + "const rows = await fx.call('query', 'SELECT label FROM t0 WHERE citizenid = ? ORDER BY id', [tag]);\n"
        + "out('sent', n);\n"
        + "out('order', (rows || []).map((r) => Number(String(r.label).slice(tag.length + 1))));\n"
        + body + "\n})().catch((e) => { console.log('CHILD ERROR ' + (e && e.stack)); process.exit(2); });";
    const r = spawnSync(process.execPath, ['-e', code], { env: Object.assign({}, process.env, env), encoding: 'utf8', timeout: 180000 });
    const text = (r.stdout || '') + (r.stderr || '');
    const vals = {};
    for (const m of text.matchAll(/^@(\w+)=(.*)$/gm)) vals[m[1]] = JSON.parse(m[2]);
    return { vals, text };
}

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

// The first and the last table: the column meta is written in chunks and the
// triggers one table at a time, so a step cut short misses the last one.
const LAST = TABLES - 1;
const LONG = 'x'.repeat(60);
// A label per boot: the unique index on label must not be what refuses the row.
const strictProbe = (tag) => "out('long0', await fx.call('insert', 'INSERT INTO t0 (citizenid, label) VALUES (?, ?)', ['" + LONG + "', 'long0-" + tag + "']));"
    + "out('longLast', await fx.call('insert', 'INSERT INTO t" + LAST + " (citizenid, label) VALUES (?, ?)', ['" + LONG + "', 'longLast-" + tag + "']));";
const strictOk = (v) => !(Number(v.long0) > 0) && !(Number(v.longLast) > 0);
const META_WANT = JSON.stringify([{ table_name: 't0', column_type: 'varchar(100)', char_len: 100 }, { table_name: 't' + LAST, column_type: 'varchar(100)', char_len: 100 }]);
const inOrder = (o, sent) => Array.isArray(o) && o.length === sent && sent > PRE_READY && o.every((n, i) => n === i);
const s = setup();

// 1. First boot: every table is copied from MariaDB.
{
    const r = runChild(s.env,
        "out('ins', await fx.call('insert', 'INSERT INTO t1 (citizenid, label) VALUES (?, ?)', ['acked', 'acked-1']));"
        + strictProbe('copy')
        + "out('stat', await fx.call('scalar', \"SELECT COUNT(DISTINCT tbl) FROM sqlite_stat1 WHERE tbl LIKE 't%'\", []));"
        + "process.kill(process.pid, 'SIGKILL');");
    check('copy boot: no event-loop gap over ' + LIMIT + ' ms', typeof r.vals.maxGap === 'number' && r.vals.maxGap <= LIMIT,
        'maxGap=' + r.vals.maxGap + (r.vals.maxGap == null ? ' ' + r.text.slice(-600) : ''));
    check('copy boot: calls made before ready, during the drain and after run in arrival order', inOrder(r.vals.order, r.vals.sent), r.vals.sent + ' sent, ' + JSON.stringify(r.vals.order).slice(0, 120));
    check('copy boot: insert acknowledged', Number(r.vals.ins) > 0, String(r.vals.ins));
    check('copy boot: strict mode refuses a value too long for the first and the last table', strictOk(r.vals), JSON.stringify([r.vals.long0, r.vals.longLast]));
    check('copy boot: every copied table has statistics', Number(r.vals.stat) === TABLES, String(r.vals.stat));
}

// Drop the strict-mode triggers of the first and the last table, as a file
// from another build has other ones.
function dropStrict() {
    const f = new DatabaseSync(path.join(s.dir, 'cache', 'durable.sqlite'));
    for (const t of f.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('t0', 't" + LAST + "') AND name NOT LIKE '%on_update%'").all()) {
        f.exec('DROP TRIGGER "' + t.name.replace(/"/g, '""') + '"');
    }
    f.close();
}

// The column types MariaDB reported are kept in the file for the first and the
// last table. The next boots find the strict-mode triggers missing, and one
// chunk of the column types fails to write (a full disk, say): t50's label
// write fails alone; its other columns, whose MariaDB defaults changed, are
// written in a chunk whose COMMIT then fails. That chunk must leave the file
// as it was.
{
    const m = new DatabaseSync(s.mariaFile);
    m.exec('CREATE TABLE fake_columns (table_name TEXT, column_name TEXT, column_default TEXT, extra TEXT)');
    for (const c of ['citizenid', 'name', 'money', 'data', 'flag']) m.prepare('INSERT INTO fake_columns VALUES (?, ?, ?, NULL)').run('t50', c, "'changed'");
    m.close();
    const f = new DatabaseSync(path.join(s.dir, 'cache', 'durable.sqlite'));
    const meta = f.prepare("SELECT table_name, column_type, char_len FROM __cis_columns WHERE column_name = 'label' AND table_name IN ('t0', 't" + LAST + "') ORDER BY table_name").all();
    check('copy boot: column types kept for the first and the last table', JSON.stringify(meta) === META_WANT, JSON.stringify(meta));
    f.exec("CREATE TRIGGER meta_fault BEFORE UPDATE ON __cis_columns WHEN NEW.table_name = 't50' AND NEW.column_name = 'label' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    f.exec("CREATE TRIGGER meta_fault_ins BEFORE INSERT ON __cis_columns WHEN NEW.table_name = 't50' AND NEW.column_name = 'label' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    f.close();
    dropStrict();
}

// 2. Second boot keeps the SQLite file; the acknowledged insert survived the kill.
{
    const r = runChild(s.env,
        "out('acked', await fx.call('query', 'SELECT citizenid FROM t1 WHERE label = ?', ['acked-1']));"
        + strictProbe('kept')
        + "out('after', await fx.call('insert', 'INSERT INTO t2 (citizenid, label) VALUES (?, ?)', ['after', 'after-fault']));"
        + "process.kill(process.pid, 'SIGKILL');", COMMIT_FULL);
    check('kept boot: no event-loop gap over ' + LIMIT + ' ms', typeof r.vals.maxGap === 'number' && r.vals.maxGap <= LIMIT,
        'maxGap=' + r.vals.maxGap + (r.vals.maxGap == null ? ' ' + r.text.slice(-600) : ''));
    check('kept boot: calls made before ready, during the drain and after run in arrival order', inOrder(r.vals.order, r.vals.sent), r.vals.sent + ' sent, ' + JSON.stringify(r.vals.order).slice(0, 120));
    check('insert acknowledged before a kill survives it', JSON.stringify(r.vals.acked) === '[{"citizenid":"acked"}]', JSON.stringify(r.vals.acked));
    check('kept boot: strict-mode triggers rebuilt for a file from another build', strictOk(r.vals), JSON.stringify([r.vals.long0, r.vals.longLast]));
    check('kept boot: insert after a failed column-type write acknowledged', Number(r.vals.after) > 0, String(r.vals.after));
    const f = new DatabaseSync(path.join(s.dir, 'cache', 'durable.sqlite'));
    const changed = f.prepare("SELECT column_name FROM __cis_columns WHERE table_name = 't50' AND column_default LIKE '%changed%'").all();
    const kept = f.prepare("SELECT COUNT(*) AS n FROM __cis_columns WHERE table_name = 't50'").get().n;
    // Read from the file, not through a boot that may copy the row back from MariaDB.
    const inFile = f.prepare("SELECT citizenid FROM t2 WHERE label = 'after-fault'").all();
    f.close();
    check('kept boot: insert acknowledged after a failed column-type chunk is in the file after a kill', JSON.stringify(inFile) === '[{"citizenid":"after"}]', JSON.stringify(inFile));
    check('kept boot: a failed column-type chunk is rolled back, the old types stay', changed.length === 0 && kept > 0, JSON.stringify({ changed, kept }));
}

// 3. Kept boot with slow disk syncs and no WAL prealloc (whose own sync would
// cover the WAL): ready waits until the database file and its WAL are synced.
{
    const env = Object.assign({}, s.env, { FX_CONVARS: JSON.stringify({ cis_database_frame_ms: String(FRAME), cis_database_wal_prealloc: '0' }) });
    const r = runChild(env,
        "out('fault', await fx.call('query', 'SELECT citizenid FROM t2 WHERE label = ?', ['after-fault']));"
        + "process.exit(0);", SLOW_SYNC);
    const done = r.vals.syncedAtReady || [];
    const firstAck = r.vals.syncedAtFirstAck || [];
    check('insert acknowledged after a failed column-type write survives a restart', JSON.stringify(r.vals.fault) === '[{"citizenid":"after"}]', JSON.stringify(r.vals.fault));
    check('first answer comes after the database file and the WAL are synced',
        firstAck.some((p) => /durable.sqlite$/.test(p)) && firstAck.some((p) => /durable.sqlite-wal$/.test(p)), JSON.stringify(firstAck));
    check('boot synced the database file before ready', done.some((p) => /durable\.sqlite$/.test(p)), JSON.stringify(done));
    check('boot synced the WAL before ready', done.some((p) => /durable\.sqlite-wal$/.test(p)), JSON.stringify(done));
}

// 4. Kept boot with no MariaDB: nothing is copied, and the triggers of a file
// from another build are rebuilt all the same.
{
    dropStrict();
    const env = Object.assign({}, s.env, { FX_CONVARS: JSON.stringify({ cis_database_frame_ms: String(FRAME), mysql_connection_string: '' }) });
    const r = runChild(env, strictProbe('solo') + "process.exit(0);");
    check('boot without MariaDB: no event-loop gap over ' + LIMIT + ' ms', typeof r.vals.maxGap === 'number' && r.vals.maxGap <= LIMIT,
        'maxGap=' + r.vals.maxGap + (r.vals.maxGap == null ? ' ' + r.text.slice(-600) : ''));
    check('boot without MariaDB: strict-mode triggers rebuilt', strictOk(r.vals), JSON.stringify([r.vals.long0, r.vals.longLast]));
}

fs.rmSync(s.dir, { recursive: true, force: true });
const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
