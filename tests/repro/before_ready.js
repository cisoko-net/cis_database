'use strict';

// Findings 4.4.36-38: entry points called before the engine is ready.
// Each case boots server.js through tests/harness/fx.js against a slow fake
// MariaDB and calls in at once, while boot is still running:
//   spill phase: a spill file is replayed before SQLite opens (backend is null)
//   hydrate phase: SQLite is open and tables are still being copied
// Every call must wait for ready, settle once, and see the copied data.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const HARNESS = path.join(__dirname, '..', 'harness', 'fx.js');

function runChild(env, body) {
    const code = "const fx = require(" + JSON.stringify(HARNESS) + ");\n"
        + "const r = fx.registry;\n"
        + "const out = (k, v) => console.log('@' + k + '=' + JSON.stringify(v === undefined ? null : v));\n"
        + "const sleep = (ms) => new Promise((res) => setTimeout(res, ms));\n"
        + "const q = (sql, p) => fx.call('query', sql, p || []);\n"
        + "const wasReady = r.isReady();\n"
        + "(async () => {\nout('calledBeforeReady', !wasReady);\n"
        + body + "\n})().catch((e) => { console.log('CHILD ERROR ' + (e && e.stack)); process.exit(2); });";
    const r = spawnSync(process.execPath, ['-e', code], { env: Object.assign({}, process.env, env), encoding: 'utf8', timeout: 60000 });
    const text = (r.stdout || '') + (r.stderr || '');
    const vals = {};
    for (const m of text.matchAll(/^@(\w+)=(.*)$/gm)) vals[m[1]] = JSON.parse(m[2]);
    return { vals, text };
}

function setup(withSpill) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-ready-'));
    const mariaFile = path.join(dir, 'maria.sqlite');
    const m = new DatabaseSync(mariaFile);
    m.exec("CREATE TABLE users (identifier VARCHAR(64) PRIMARY KEY, money INT NOT NULL); INSERT INTO users VALUES ('alice', 100);");
    m.exec("CREATE TABLE bank_accounts_new (id VARCHAR(50) PRIMARY KEY, amount INT DEFAULT 0, transactions TEXT); INSERT INTO bank_accounts_new VALUES ('acc1', 500, '[]');");
    m.exec('CREATE TABLE log (id INTEGER PRIMARY KEY, n INT NOT NULL)');
    m.close();
    if (withSpill) {
        fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'cache', 'replica.spill.0.jsonl'),
            JSON.stringify({ sql: 'UPDATE users SET money = money WHERE identifier = ?', params: ['alice'], from: 'test' }) + '\n');
    }
    return { dir, mariaFile, env: { FX_RES_DIR: dir, FX_MARIA_FILE: mariaFile, FX_MARIA_DELAY_MS: '60' } };
}

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
function run(name, withSpill, body, verify) {
    const s = setup(withSpill);
    const r = runChild(s.env, body);
    if (r.vals.calledBeforeReady !== true) check(name + ' (setup: call landed before ready)', false, r.text.slice(-300));
    verify(r.vals, r.text);
    fs.rmSync(s.dir, { recursive: true, force: true });
}

// Renewed-Banking's startup statement, as it calls it.
const CREATE_BANK = "CREATE TABLE IF NOT EXISTS `bank_accounts_new` (`id` varchar(50) NOT NULL, `amount` int(11) DEFAULT 0, `transactions` longtext DEFAULT '[]', PRIMARY KEY (`id`));";

// 1. transaction while the spill replays and SQLite is not open yet.
run('transaction before SQLite opens', true, `
    const res = await new Promise((done) => r.transaction([{ query: "UPDATE users SET money = 150 WHERE identifier = 'alice'" }], (ok, err) => done({ ok, err })));
    out('tx', res);
    out('rows', await q("SELECT money FROM users WHERE identifier = 'alice'"));
    process.exit(0);
`, (v) => {
    check('transaction before SQLite opens: succeeds', v.tx && v.tx.ok === true, JSON.stringify(v.tx));
    check('transaction before SQLite opens: write applied', JSON.stringify(v.rows) === '[{"money":150}]', JSON.stringify(v.rows));
});

// 2. Renewed-Banking: CREATE TABLE IF NOT EXISTS in a transaction while hydrate runs.
run('startup CREATE TABLE during hydrate', false, `
    const res = await new Promise((done) => r.transaction([{ query: ${JSON.stringify(CREATE_BANK)} }], (ok, err) => done({ ok, err })));
    out('tx', res);
    out('rows', await q('SELECT id, amount FROM bank_accounts_new'));
    process.exit(0);
`, (v) => {
    check('startup CREATE TABLE during hydrate: succeeds', v.tx && v.tx.ok === true, JSON.stringify(v.tx));
    check('startup CREATE TABLE during hydrate: MariaDB rows are there', JSON.stringify(v.rows) === '[{"id":"acc1","amount":500}]', JSON.stringify(v.rows));
});

// 3. execMany while hydrate runs.
run('execMany during hydrate', false, `
    const res = await new Promise((done) => r.execMany([{ kind: 'insert', sql: 'INSERT INTO log (n) VALUES (?)', params: [7] }], (v, err) => done({ v, err })));
    out('many', res);
    out('rows', await q('SELECT n FROM log'));
    process.exit(0);
`, (v) => {
    check('execMany during hydrate: succeeds', v.many && Array.isArray(v.many.v), JSON.stringify(v.many));
    check('execMany during hydrate: row written', JSON.stringify(v.rows) === '[{"n":7}]', JSON.stringify(v.rows));
});

// 4. No-callback form (query_async / *Sync / oxmysql's own include) settles.
run('no-callback query during hydrate', false, `
    const ret = r.query_async('SELECT money FROM users', []);
    const got = await Promise.race([
        new Promise((done) => ret.__cfx_async_retval((v, err) => done({ v, err }))),
        (async () => { await fx.ready(20000); await sleep(3000); return 'never settled'; })(),
    ]);
    out('async', got);
    process.exit(0);
`, (v) => {
    check('no-callback query during hydrate: settles with rows', v.async && v.async.v && JSON.stringify(v.async.v) === '[[{"money":100}]]', JSON.stringify(v.async));
});

// 5. Writes issued before ready, a few ms apart, run in the order they were issued.
run('write order before ready', false, `
    const pending = [];
    for (let i = 0; i < 20; i++) {
        pending.push(new Promise((done) => r.insert('INSERT INTO log (n) VALUES (?)', [i], done)));
        pending.push(new Promise((done) => r.update("UPDATE users SET money = ? WHERE identifier = 'alice'", [i], done)));
        await sleep(7);
    }
    out('readyBeforeLast', r.isReady());
    await Promise.all(pending);
    out('log', (await q('SELECT n FROM log ORDER BY id')).map((x) => x.n));
    out('money', (await q("SELECT money FROM users WHERE identifier = 'alice'"))[0].money);
    process.exit(0);
`, (v) => {
    const want = Array.from({ length: 20 }, (_, i) => i);
    check('write order before ready: setup (still hydrating after the last call)', v.readyBeforeLast === false, 'ready=' + v.readyBeforeLast);
    check('write order before ready: inserts in issue order', JSON.stringify(v.log) === JSON.stringify(want), JSON.stringify(v.log));
    check('write order before ready: last update wins', v.money === 19, 'money=' + v.money);
});

// 6. awaitConnection called the way API.md documents it: (nil, cb).
run('awaitConnection(nil, cb)', false, `
    const got = await Promise.race([
        new Promise((done) => r.awaitConnection(null, () => done('called'))),
        (async () => { await fx.ready(20000); await sleep(2000); return 'never called'; })(),
    ]);
    out('await', got);
    process.exit(0);
`, (v) => {
    check('awaitConnection(nil, cb): callback runs once ready', v.await === 'called', JSON.stringify(v.await));
});

// 7. The internal hydrate export before boot has started copying.
run('hydrate export before SQLite opens', true, `
    global.__fxInvoker = 'cis_database';
    const res = await new Promise((done) => r.hydrate((v, err) => done({ v, err })));
    out('hydrate', res);
    process.exit(0);
`, (v) => {
    check('hydrate export before SQLite opens: waits and answers', v.hydrate && v.hydrate.v && typeof v.hydrate.v === 'object', JSON.stringify(v.hydrate));
});

// 8. A stop before ready fails waiting calls instead of leaving them hanging.
run('shutdown before ready', false, `
    const waiting = [
        new Promise((done) => r.query('SELECT 1 AS x', [], (v, err) => done({ kind: 'query', v, err }), 'test', true)),
        new Promise((done) => r.transaction([{ query: 'SELECT 1' }], (ok, err) => done({ kind: 'tx', ok, err }))),
    ];
    global.__fxInvoker = 'cis_database';
    r.shutdown();
    const got = await Promise.race([Promise.all(waiting), sleep(3000).then(() => 'hung')]);
    out('stop', got);
    process.exit(0);
`, (v) => {
    const ok = Array.isArray(v.stop) && v.stop.every((x) => x.err && /not ready/.test(String(x.err)));
    check('shutdown before ready: waiting calls fail with "engine not ready"', ok, JSON.stringify(v.stop));
});

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
