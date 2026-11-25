'use strict';

// Finding 4.1.1: hydrate drops a SQLite table that holds writes MariaDB has not
// confirmed yet. Each case boots server.js in a child process through
// tests/harness/fx.js against a fake MariaDB that persists between boots.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const HARNESS = path.join(__dirname, '..', 'harness', 'fx.js');

function runChild(env, body) {
    const code = "const fx = require(" + JSON.stringify(HARNESS) + ");\n"
        + "const q = (sql, p) => fx.call('query', sql, p || []);\n"
        + "const out = (k, v) => console.log('@' + k + '=' + JSON.stringify(v));\n"
        + "(async () => {\nconst t0 = Date.now();\nif (!(await fx.ready(20000))) throw new Error('not ready');\nout('readyMs', Date.now() - t0);\n"
        + body + "\n})().catch((e) => { console.log('CHILD ERROR ' + (e && e.stack)); process.exit(2); });";
    const r = spawnSync(process.execPath, ['-e', code], { env: Object.assign({}, process.env, env), encoding: 'utf8', timeout: 60000 });
    const text = (r.stdout || '') + (r.stderr || '');
    const vals = {};
    for (const m of text.matchAll(/^@(\w+)=(.*)$/gm)) vals[m[1]] = JSON.parse(m[2]);
    return { vals, text };
}

const CRASH = "await new Promise((r) => setTimeout(r, 300)); process.kill(process.pid, 'SIGKILL');";
const EXIT = 'process.exit(0);';

function setup(seed) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-hydrate-'));
    const mariaFile = path.join(dir, 'maria.sqlite');
    const m = new DatabaseSync(mariaFile);
    m.exec(seed || "CREATE TABLE users (identifier VARCHAR(64) PRIMARY KEY, money INT NOT NULL); INSERT INTO users VALUES ('alice', 100);");
    m.close();
    return { dir, mariaFile, env: { FX_RES_DIR: dir, FX_MARIA_FILE: mariaFile } };
}

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const ids = (rows) => (rows || []).map((r) => r.identifier).join(',');

// 1. Insert acknowledged while MariaDB refuses writes, crash, reboot.
{
    const s = setup();
    const r1 = runChild(Object.assign({ FX_MARIA_WRITES: 'down' }, s.env),
        "out('insert', await fx.call('insert', 'INSERT INTO users (identifier, money) VALUES (?, ?)', ['bob', 250]));"
        + "out('rows', await q('SELECT identifier FROM users ORDER BY identifier'));" + CRASH);
    check('first install copies MariaDB', ids(r1.vals.rows) === 'alice,bob', ids(r1.vals.rows));
    const r2 = runChild(s.env, "out('rows', await q('SELECT identifier FROM users ORDER BY identifier'));" + EXIT);
    check('unconfirmed insert survives reboot', ids(r2.vals.rows) === 'alice,bob', ids(r2.vals.rows) || r2.text.slice(-400));
    check('reboot does not wait on a hydrate retry', r2.vals.readyMs < 1500, 'readyMs=' + r2.vals.readyMs);
    fs.rmSync(s.dir, { recursive: true, force: true });
}

// 2. Delete that empties a table, acknowledged but not in MariaDB, crash, reboot.
{
    const s = setup();
    runChild(Object.assign({ FX_MARIA_WRITES: 'down' }, s.env),
        "out('deleted', await fx.call('update', 'DELETE FROM users WHERE identifier = ?', ['alice']));" + CRASH);
    const r2 = runChild(s.env, "out('rows', await q('SELECT identifier FROM users'));" + EXIT);
    check('unconfirmed delete stays deleted', Array.isArray(r2.vals.rows) && r2.vals.rows.length === 0, JSON.stringify(r2.vals.rows) || r2.text.slice(-400));
    fs.rmSync(s.dir, { recursive: true, force: true });
}

// 3. A table created in MariaDB while the server was off is copied on the next boot.
{
    const s = setup();
    runChild(s.env, EXIT);
    const m = new DatabaseSync(s.mariaFile);
    m.exec("CREATE TABLE vehicles (plate VARCHAR(8) PRIMARY KEY, owner VARCHAR(64)); INSERT INTO vehicles VALUES ('ABC123', 'alice');");
    m.close();
    const r2 = runChild(s.env, "out('rows', await q('SELECT plate FROM vehicles'));" + EXIT);
    check('new MariaDB table copied on reboot', JSON.stringify(r2.vals.rows) === '[{"plate":"ABC123"}]', JSON.stringify(r2.vals.rows) || r2.text.slice(-400));
    fs.rmSync(s.dir, { recursive: true, force: true });
}

// 4. A copy cut short leaves only a staging table, which the next boot replaces.
{
    const s = setup("CREATE TABLE users (identifier VARCHAR(64) PRIMARY KEY, money INT NOT NULL); INSERT INTO users VALUES ('alice', 100), ('bob', 5), ('carol', 7);");
    fs.mkdirSync(path.join(s.dir, 'cache'), { recursive: true });
    const d = new DatabaseSync(path.join(s.dir, 'cache', 'durable.sqlite'));
    d.exec("CREATE TABLE __cis_hydrate_users (identifier TEXT PRIMARY KEY, money INTEGER); INSERT INTO __cis_hydrate_users VALUES ('alice', 100);");
    d.close();
    const r = runChild(s.env, "out('rows', await q('SELECT identifier FROM users ORDER BY identifier'));" + EXIT);
    check('interrupted copy is redone in full', ids(r.vals.rows) === 'alice,bob,carol', ids(r.vals.rows) || r.text.slice(-400));
    // Callers cannot read cis_database's own tables, so the file is opened here.
    const after = new DatabaseSync(path.join(s.dir, 'cache', 'durable.sqlite'));
    const stage = after.prepare("SELECT name FROM sqlite_master WHERE name LIKE '__cis_hydrate_%'").all();
    after.close();
    check('no staging table left behind', stage.length === 0, JSON.stringify(stage));
    fs.rmSync(s.dir, { recursive: true, force: true });
}

// 5. The runtime hydrate export does not replace unconfirmed rows.
{
    const s = setup();
    const r = runChild(Object.assign({ FX_MARIA_WRITES: 'down' }, s.env),
        "await fx.call('insert', 'INSERT INTO users (identifier, money) VALUES (?, ?)', ['bob', 250]);"
        + "out('hydrate', await fx.call('hydrate'));"
        + "out('rows', await q('SELECT identifier FROM users ORDER BY identifier'));" + EXIT);
    check('runtime hydrate keeps unconfirmed rows', ids(r.vals.rows) === 'alice,bob', ids(r.vals.rows) + ' hydrate=' + JSON.stringify(r.vals.hydrate));
    fs.rmSync(s.dir, { recursive: true, force: true });
}

// 6. MariaDB fully down on reboot: the existing SQLite file is served.
{
    const s = setup();
    runChild(s.env, EXIT);
    const r = runChild(Object.assign({ FX_MARIA_DOWN: '1' }, s.env), "out('rows', await q('SELECT identifier FROM users'));" + EXIT);
    check('reboot with MariaDB down serves SQLite', ids(r.vals.rows) === 'alice', (ids(r.vals.rows) || r.text.slice(-400)) + ' readyMs=' + r.vals.readyMs);
    fs.rmSync(s.dir, { recursive: true, force: true });
}

// 7. durable.sqlite deleted while an old hydrate.sqlite snapshot is still in
//    cache/: MariaDB has newer rows, and those must be served, not the snapshot.
{
    const s = setup();
    runChild(s.env, EXIT);
    const m = new DatabaseSync(s.mariaFile);
    m.exec("UPDATE users SET money = 999 WHERE identifier = 'alice'; INSERT INTO users VALUES ('dave', 7);");
    m.close();
    for (const f of ['durable.sqlite', 'durable.sqlite-wal', 'durable.sqlite-shm']) fs.rmSync(path.join(s.dir, 'cache', f), { force: true });
    const r = runChild(s.env, "out('rows', await q('SELECT identifier, money FROM users ORDER BY identifier'));" + EXIT);
    check('missing durable file is refilled from MariaDB, not an old snapshot', JSON.stringify(r.vals.rows) === '[{"identifier":"alice","money":999},{"identifier":"dave","money":7}]', JSON.stringify(r.vals.rows) || r.text.slice(-400));
    fs.rmSync(s.dir, { recursive: true, force: true });
}

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
