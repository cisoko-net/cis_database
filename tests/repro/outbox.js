'use strict';

// Replication outbox: every write MariaDB has not confirmed is a SQLite row
// committed with the write. Covers findings 4.1.3 (IN lists), 4.1.5/4.1.7/
// 4.1.8/4.1.9/4.1.10 (spill files, now gone), 4.1.12 (TRUNCATE), 4.1.13
// (writes answered by MariaDB), 4.2.14 (internal exports) and the hard-kill
// loss of the in-memory queue seen live on 2026-10-22. Each case boots
// server.js in a child process through tests/harness/fx.js against a fake
// MariaDB file that survives restarts.
// Usage: node tests/repro/outbox.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const HARNESS = path.join(__dirname, '..', 'harness', 'fx.js');

const PRELUDE = "const fx = require(" + JSON.stringify(HARNESS) + ");\n"
    + "const r = fx.registry;\n"
    + "const q = (sql, p) => fx.call('query', sql, p || []);\n"
    + "const callE = (name, ...a) => new Promise((done) => r[name](...a, (v, err) => done({ v, err: err || null }), 'test', true));\n"
    + "const out = (k, v) => console.log('@' + k + '=' + JSON.stringify(v));\n"
    + "const sleep = (ms) => new Promise((res) => setTimeout(res, ms));\n"
    + "const drained = async (ms) => { const end = Date.now() + (ms || 15000); while (Date.now() < end) { const p = r.probe(); if (p && p.replica === 0) return true; await sleep(50); } return false; };\n";

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

const KILL = "process.kill(process.pid, 'SIGKILL');";
const EXIT = 'process.exit(0);';
const SEED = "CREATE TABLE users (identifier VARCHAR(64) PRIMARY KEY, money INT NOT NULL, avatar BLOB);"
    + "INSERT INTO users (identifier, money) VALUES ('alice', 100), ('bob', 200), ('carol', 300), ('dave', 400);"
    + "CREATE TABLE logs (seq INT, note TEXT);"
    + "CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(32) UNIQUE);";

function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-outbox-'));
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

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

function done(s) {
    try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch (e) { /* Windows may hold the file a moment */ }
}

// 1. Acknowledged writes, then a hard kill before the flusher runs.
{
    const s = setup();
    runChild(s.env, "for (let i = 0; i < 300; i++) await fx.call('insert', 'INSERT INTO logs (seq, note) VALUES (?, ?)', [i, 'k']);" + KILL);
    const r2 = runChild(s.env, "out('drained', await drained());" + EXIT);
    const rows = maria(s, 'SELECT COUNT(*) AS n, COUNT(DISTINCT seq) AS d FROM logs')[0];
    check('hard kill: every acknowledged write reaches MariaDB once', rows.n === 300 && rows.d === 300 && r2.vals.drained === true, JSON.stringify(rows) + ' drained=' + r2.vals.drained);
    done(s);
}

// 2. Killed right after a MariaDB commit, before SQLite records it.
{
    const s = setup();
    runChild(Object.assign({ FX_MARIA_WRITES: 'down' }, s.env), "for (let i = 0; i < 200; i++) await fx.call('insert', 'INSERT INTO logs (seq, note) VALUES (?, ?)', [i, 'x']);" + EXIT);
    const r2 = runChild(Object.assign({ FX_MARIA_KILL_AFTER_COMMIT: '1' }, s.env), "await sleep(5000);" + EXIT);
    const afterKill = maria(s, 'SELECT COUNT(*) AS n FROM logs')[0].n;
    runChild(s.env, "out('drained', await drained());" + EXIT);
    const rows = maria(s, 'SELECT COUNT(*) AS n, COUNT(DISTINCT seq) AS d FROM logs')[0];
    check('kill after MariaDB commit: no row sent twice', afterKill > 0 && rows.n === 200 && rows.d === 200, 'after kill=' + afterKill + ' final=' + JSON.stringify(rows) + (r2.text.includes('CHILD ERROR') ? r2.text.slice(-300) : ''));
    done(s);
}

// 3. MariaDB down for 4200 updates of one row, clean stop, restart with it up.
{
    const s = setup();
    runChild(Object.assign({ FX_MARIA_WRITES: 'down' }, s.env), "for (let i = 0; i < 4200; i++) await fx.call('update', 'UPDATE users SET money = ? WHERE identifier = ?', [i, 'alice']);" + EXIT);
    runChild(s.env, "out('drained', await drained(30000));" + EXIT);
    const v = maria(s, "SELECT money FROM users WHERE identifier = 'alice'")[0].money;
    check('outage of 4200 writes replays in order', v === 4199, 'money=' + v);
    done(s);
}

// 4. A BLOB parameter written during an outage.
{
    const s = setup();
    runChild(Object.assign({ FX_MARIA_WRITES: 'down' }, s.env), "await fx.call('update', 'UPDATE users SET avatar = ? WHERE identifier = ?', [Buffer.from([0, 1, 2, 250, 255]), 'bob']);" + KILL);
    runChild(s.env, "out('drained', await drained());" + EXIT);
    const v = maria(s, "SELECT hex(avatar) AS h FROM users WHERE identifier = 'bob'")[0].h;
    check('BLOB parameter reaches MariaDB as bytes', v === '000102FAFF', 'hex=' + v);
    done(s);
}

// 5. IN (?) bound to a list changes the same rows on both sides.
{
    const s = setup();
    const r = runChild(s.env, "out('n', await fx.call('update', 'UPDATE users SET money = 0 WHERE identifier IN (?)', [['alice', 'bob', 'carol']]));"
        + "out('drained', await drained());" + EXIT);
    const zero = maria(s, 'SELECT identifier FROM users WHERE money = 0 ORDER BY identifier').map((x) => x.identifier).join(',');
    check('IN (?) list: SQLite changed 3 rows', r.vals.n === 3, 'n=' + r.vals.n);
    check('IN (?) list: MariaDB changed the same 3 rows', zero === 'alice,bob,carol', zero);
    done(s);
}

// 6. A comma inside a string is one value, as in oxmysql.
{
    const s = setup();
    const r = runChild(s.env, "out('rows', await q('SELECT identifier FROM users WHERE identifier IN (?)', ['alice,bob']));" + EXIT);
    check('IN (?) with a comma string is not split', Array.isArray(r.vals.rows) && r.vals.rows.length === 0, JSON.stringify(r.vals.rows));
    done(s);
}

// 7. TRUNCATE empties SQLite as well as MariaDB.
{
    const s = setup();
    const r = runChild(s.env, "await fx.call('insert', 'INSERT INTO logs (seq, note) VALUES (1, ?)', ['a']);"
        + "await fx.call('query', 'TRUNCATE TABLE logs', []);"
        + "out('rows', await q('SELECT COUNT(*) AS n FROM logs'));"
        + "out('drained', await drained());" + EXIT);
    const m = maria(s, 'SELECT COUNT(*) AS n FROM logs')[0].n;
    check('TRUNCATE empties SQLite', r.vals.rows && r.vals.rows[0] && r.vals.rows[0].n === 0, JSON.stringify(r.vals.rows));
    check('TRUNCATE empties MariaDB', m === 0, 'maria=' + m);
    done(s);
}

// 8. A write SQLite refuses is not run on MariaDB instead.
{
    const s = setup();
    const r = runChild(s.env, "fx.maria().exec('CREATE TABLE only_maria (id INT)');"
        + "out('ins', await callE('insert', 'INSERT INTO only_maria (id) VALUES (?)', [1]));"
        + "out('again', await callE('insert', 'INSERT INTO only_maria (id) VALUES (?)', [2]));" + EXIT);
    const m = maria(s, 'SELECT COUNT(*) AS n FROM only_maria')[0].n;
    check('write refused by SQLite fails for the caller', r.vals.ins && r.vals.ins.err && r.vals.again && r.vals.again.err, JSON.stringify([r.vals.ins, r.vals.again]) + (r.vals.again ? '' : ' ' + r.text.slice(-600)));
    check('write refused by SQLite never reaches MariaDB', m === 0, 'maria rows=' + m);
    done(s);
}

// 9. Internal exports refuse other resources.
{
    const s = setup();
    const r = runChild(s.env, "global.__fxInvoker = 'some_script';"
        + "out('hydrate', await callE('hydrate'));"
        + "out('flush', await callE('flushReplica'));"
        + "out('reload', await callE('reloadTable', 'users'));"
        + "out('snap', r.cis_dash_snapshot() === false);"
        + "out('stop', r.shutdown() === false);"
        + "global.__fxInvoker = '';"
        + "out('emptyStop', r.shutdown() === false);"
        + "global.__fxInvoker = 'cis_database';"
        + "out('own', await callE('flushReplica'));"
        + "out('alive', await q('SELECT COUNT(*) AS n FROM users'));" + EXIT);
    const v = r.vals;
    const refused = (x) => x && x.v === false && /internal/.test(String(x.err));
    check('hydrate, flushReplica, reloadTable refuse another resource', refused(v.hydrate) && refused(v.flush) && refused(v.reload), JSON.stringify([v.hydrate, v.flush, v.reload]));
    check('dashboard snapshot and shutdown refuse another resource', v.snap === true && v.stop === true && v.emptyStop === true, JSON.stringify([v.snap, v.stop, v.emptyStop]));
    check('own resource still reaches internal exports', v.own && v.own.v === true && v.alive && v.alive[0].n === 4, JSON.stringify([v.own, v.alive]));
    done(s);
}

// 10. LAST_INSERT_ID and insert ids are the caller's rows, not outbox rows.
{
    const s = setup();
    const r = runChild(s.env, "out('id1', await fx.call('insert', 'INSERT INTO items (name) VALUES (?)', ['a']));"
        + "out('id2', await fx.call('insert', 'INSERT INTO items (name) VALUES (?)', ['b']));"
        + "out('last', await fx.call('scalar', 'SELECT LAST_INSERT_ID()', []));"
        + "await fx.call('update', 'UPDATE users SET money = 1 WHERE identifier = ?', ['dave']);"
        + "out('lastAfterUpdate', await fx.call('scalar', 'SELECT LAST_INSERT_ID()', []));"
        + "out('dup', await fx.call('insert', 'INSERT IGNORE INTO items (name) VALUES (?)', ['a']));" + EXIT);
    const v = r.vals;
    check('insert returns the new row id', v.id1 === 1 && v.id2 === 2, JSON.stringify([v.id1, v.id2]));
    check('LAST_INSERT_ID() is the caller\'s last insert', v.last === 2 && v.lastAfterUpdate === 2, JSON.stringify([v.last, v.lastAfterUpdate]));
    check('INSERT IGNORE of a duplicate returns 0', v.dup === 0, JSON.stringify(v.dup));
    done(s);
}

// 11. Spill files left by an older build are moved into the outbox.
{
    const s = setup();
    fs.mkdirSync(path.join(s.dir, 'cache'), { recursive: true });
    runChild(Object.assign({ FX_MARIA_WRITES: 'down' }, s.env), EXIT);
    fs.writeFileSync(path.join(s.dir, 'cache', 'replica.spill.0.jsonl'),
        JSON.stringify({ sql: 'UPDATE users SET money = ? WHERE identifier = ?', params: [7, 'carol'], from: 'old' }) + '\n'
        + JSON.stringify({ sql: 'UPDATE users SET money = ? WHERE identifier = ?', params: [8, 'carol'], from: 'old' }) + '\n');
    runChild(s.env, "out('drained', await drained());" + EXIT);
    const v = maria(s, "SELECT money FROM users WHERE identifier = 'carol'")[0].money;
    const left = fs.readdirSync(path.join(s.dir, 'cache')).filter((n) => n.startsWith('replica.spill'));
    check('old spill files replay in order and are removed', v === 8 && left.length === 0, 'money=' + v + ' files=' + left.join(','));
    done(s);
}

// 12. Callers cannot read or write cis_database's own tables.
{
    const s = setup();
    const r = runChild(s.env, "out('read', await callE('query', 'SELECT * FROM __cis_outbox', []));"
        + "out('write', await callE('update', 'DELETE FROM __cis_outbox', []));" + EXIT);
    check('outbox is closed to callers', r.vals.read && r.vals.read.err && r.vals.write && r.vals.write.err, JSON.stringify([r.vals.read, r.vals.write]));
    done(s);
}

// 13. A transaction is all or nothing in MariaDB too.
{
    const s = setup();
    runChild(Object.assign({ FX_MARIA_WRITES: 'down' }, s.env),
        "out('tx', await fx.call('transaction', [{ query: 'UPDATE users SET money = money - 50 WHERE identifier = ?', values: ['alice'] }, { query: 'UPDATE users SET money = money + 50 WHERE identifier = ?', values: ['bob'] }]));" + KILL);
    runChild(s.env, "out('drained', await drained());" + EXIT);
    const v = maria(s, "SELECT identifier, money FROM users WHERE identifier IN ('alice', 'bob') ORDER BY identifier");
    check('transaction reaches MariaDB whole after a kill', JSON.stringify(v) === '[{"identifier":"alice","money":50},{"identifier":"bob","money":250}]', JSON.stringify(v));
    done(s);
}

// 14. A batch is one round trip; 640 queued writes do not take 640.
{
    const s = setup();
    runChild(Object.assign({ FX_MARIA_WRITES: 'down' }, s.env), "for (let i = 0; i < 640; i++) await fx.call('insert', 'INSERT INTO logs (seq, note) VALUES (?, ?)', [i, 'b']);" + EXIT);
    // The flusher starts before hydration, so the drain can begin before
    // ready: count from boot, hydration's own queries included.
    const r = runChild(s.env, "out('drained', await drained()); out('trips', fx.roundTrips());" + EXIT);
    const rows = maria(s, 'SELECT COUNT(*) AS n, COUNT(DISTINCT seq) AS d FROM logs')[0];
    check('640 outbox rows reach MariaDB in a few round trips', rows.n === 640 && rows.d === 640 && r.vals.trips > 0 && r.vals.trips <= 40, JSON.stringify(rows) + ' trips=' + r.vals.trips);
    done(s);
}

// 15. One statement MariaDB rejects is dropped alone; the rest of its batch lands.
{
    const s = setup();
    runChild(Object.assign({ FX_MARIA_WRITES: 'down' }, s.env),
        "for (let i = 0; i < 30; i++) await fx.call('insert', 'INSERT INTO logs (seq, note) VALUES (?, ?)', [i, 'g']);"
        + "await fx.call('insert', 'INSERT INTO items (name) VALUES (?)', ['dup']);"
        + "for (let i = 30; i < 60; i++) await fx.call('insert', 'INSERT INTO logs (seq, note) VALUES (?, ?)', [i, 'g']);" + EXIT);
    // MariaDB gets a conflicting row first, so the outbox insert of 'dup' fails there.
    const mm = new DatabaseSync(s.mariaFile);
    mm.exec("INSERT INTO items (name) VALUES ('dup')");
    mm.close();
    const r = runChild(s.env, "out('drained', await drained());" + EXIT);
    const rows = maria(s, 'SELECT COUNT(*) AS n FROM logs')[0].n;
    check('rejected statement is skipped, the other 60 land', rows === 60 && r.vals.drained === true, 'logs=' + rows + ' drained=' + r.vals.drained);
    done(s);
}

// 16. MariaDB uses up AUTO_INCREMENT ids SQLite does not (an upsert that
// updated, an ignored duplicate), so a replayed INSERT got a later id than
// SQLite's and a later UPDATE ... WHERE id = ? changed another row there.
// The fake's counter is moved past SQLite's after hydration, the way InnoDB's
// moves; every row must still land with SQLite's id.
{
    const s = setup();
    const r = runChild(s.env,
        "const { DatabaseSync } = require('node:sqlite');"
        + "const mm = new DatabaseSync(process.env.FX_MARIA_FILE);"
        + "mm.exec(\"DELETE FROM sqlite_sequence WHERE name = 'items'; INSERT INTO sqlite_sequence (name, seq) VALUES ('items', 40)\");"
        + "mm.close();"
        + "out('a', await fx.call('insert', 'INSERT INTO items (name) VALUES (?)', ['a']));"
        + "await q('INSERT INTO items (name) VALUES (?), (?), (?)', ['b', 'c', 'd']);"
        + "await q('INSERT INTO items (name) VALUES (?)', ['e']);"
        + "await q('INSERT INTO items (id, name) VALUES (?, ?)', [20, 'f']);"
        + "await q('INSERT INTO logs (seq, note) VALUES (?, ?)', [1, 'after explicit id']);"
        + "await q('INSERT INTO items (name) VALUES (?)', ['g']);"
        + "await fx.call('transaction', [{ query: 'INSERT INTO items (name) VALUES (?)', values: ['h'] }, { query: 'UPDATE items SET name = ? WHERE id = ?', values: ['a2', 1] }]);"
        + "out('cis', await fx.call('query', 'SELECT id, name FROM items ORDER BY id', []));"
        + "out('drained', await drained());" + EXIT);
    const v = maria(s, 'SELECT id, name FROM items ORDER BY id');
    check('replica rows keep the ids SQLite gave them', r.vals.drained === true && r.vals.a === 1
        && JSON.stringify(v) === JSON.stringify(r.vals.cis) && v.length === 8,
        'cis=' + JSON.stringify(r.vals.cis) + ' maria=' + JSON.stringify(v));
    done(s);
}

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
