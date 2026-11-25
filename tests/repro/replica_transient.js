'use strict';

// A MariaDB that is read-only for a while (--read-only, a failover, a
// replica promoted late) or out of disk refuses writes with errors that go
// away on their own: 1290 ER_OPTION_PREVENTS_STATEMENT, 1792 read-only
// transaction, 1021 ER_DISK_FULL, 1114 ER_RECORD_FILE_FULL, 1053 server
// shutdown, 1927 connection killed. The outbox treated every error that was
// not a lost connection or a lock as a refused statement: it logged the
// write as rejected, marked it applied and dropped it, so MariaDB lost every
// write made while it was read-only (engine invariant 3). Those errors must
// keep the entry in the outbox and retry it with backoff.
// The fake MariaDB (tests/harness/fx.js) refuses its first writes with each
// of those errnos in turn.
// Usage: node tests/repro/replica_transient.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const HARNESS = path.join(__dirname, '..', 'harness', 'fx.js');

const PRELUDE = "const fx = require(" + JSON.stringify(HARNESS) + ");\n"
    + "const r = fx.registry;\n"
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

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

// Each errno in turn: writes queue in the outbox while MariaDB is down, then
// MariaDB is back but refuses its first 2 writes with that errno.
const CODES = [1290, 1792, 1836, 1021, 1114, 1053, 1927];
for (const errno of CODES) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-transient-'));
    const mariaFile = path.join(dir, 'maria.sqlite');
    {
        const m = new DatabaseSync(mariaFile);
        m.exec('CREATE TABLE logs (seq INT, note TEXT);');
        m.close();
    }
    const env = { FX_RES_DIR: dir, FX_MARIA_FILE: mariaFile };

    runChild(Object.assign({ FX_MARIA_WRITES: 'down' }, env),
        "for (let i = 0; i < 10; i++) await fx.call('insert', 'INSERT INTO logs (seq, note) VALUES (?, ?)', [i, 'ok']);"
        + 'process.exit(0);');

    const r2 = runChild(Object.assign({ FX_MARIA_READONLY: '2', FX_MARIA_READONLY_ERRNO: String(errno) }, env),
        "out('drained', await drained(30000));"
        + 'process.exit(0);');

    const m = new DatabaseSync(mariaFile);
    const rows = m.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT seq) AS d FROM logs').get();
    m.close();

    const t = errno + ': ';
    check(t + 'outbox drains once MariaDB takes writes again', r2.vals.drained === true, 'drained=' + r2.vals.drained + (r2.text.includes('CHILD ERROR') ? ' ' + r2.text.slice(-300) : ''));
    check(t + 'every write reaches MariaDB after the spell', rows.n === 10 && rows.d === 10, JSON.stringify(rows));
    check(t + 'no write was logged as refused', !/refused|rejected/i.test(r2.text), (r2.text.match(/.*(refused|rejected).*/i) || [''])[0].slice(0, 200));
    check(t + 'the spell was seen (warning logged)', /did not take the outbox/.test(r2.text), '');

    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows may hold the file a moment */ }
}

const failed = results.filter((ok) => !ok).length;
if (failed) { console.log(failed + ' of ' + results.length + ' failed'); process.exit(1); }
console.log('all ' + results.length + ' passed');
