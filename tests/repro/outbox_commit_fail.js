'use strict';

// Engine invariant 3: an outbox row is deleted only after MariaDB committed
// it. When MariaDB refuses one statement in a batch, the outbox falls back to
// sending the entries one by one in one transaction (applyOutboxRun). If the
// COMMIT of that transaction fails, the rows must stay in the outbox and be
// sent again; marking them applied before the commit loses every write in it.
// The fake MariaDB (tests/harness/fx.js) refuses the 'bad' row with
// ER_DUP_ENTRY and fails its first COMMIT with ER_LOCK_DEADLOCK.
// Usage: node tests/repro/outbox_commit_fail.js

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-commit-fail-'));
const mariaFile = path.join(dir, 'maria.sqlite');
{
    const m = new DatabaseSync(mariaFile);
    m.exec('CREATE TABLE logs (seq INT, note TEXT);');
    m.close();
}
const env = { FX_RES_DIR: dir, FX_MARIA_FILE: mariaFile };

// Writes queue in the outbox while MariaDB is down: 20 good rows and one
// that MariaDB will refuse.
runChild(Object.assign({ FX_MARIA_WRITES: 'down' }, env),
    "for (let i = 0; i < 20; i++) await fx.call('insert', 'INSERT INTO logs (seq, note) VALUES (?, ?)', [i, i === 10 ? 'bad' : 'ok']);"
    + 'process.exit(0);');

// MariaDB is back. The batch is refused (the bad row), the one-by-one
// transaction's first COMMIT fails, the flusher retries.
const r2 = runChild(Object.assign({ FX_MARIA_REJECT: "'bad'", FX_MARIA_FAIL_COMMIT: '1' }, env),
    "out('drained', await drained(20000));"
    + "out('outbox', r.probe().replica);"
    + 'process.exit(0);');

const m = new DatabaseSync(mariaFile);
const rows = m.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT seq) AS d FROM logs').get();
const bad = m.prepare("SELECT COUNT(*) AS n FROM logs WHERE note = 'bad'").get().n;
m.close();

check('outbox drains after the failed COMMIT', r2.vals.drained === true, 'drained=' + r2.vals.drained + (r2.text.includes('CHILD ERROR') ? ' ' + r2.text.slice(-300) : ''));
check('every good write reaches MariaDB after the failed COMMIT', rows.n === 19 && rows.d === 19, JSON.stringify(rows));
check('the refused row stays refused', bad === 0, 'bad=' + bad);
check('the failed COMMIT happened (warning logged)', /did not take the outbox/.test(r2.text), '');

try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows may hold the file a moment */ }

const failed = results.filter((ok) => !ok).length;
if (failed) { console.log(failed + ' of ' + results.length + ' failed'); process.exit(1); }
console.log('all ' + results.length + ' passed');
