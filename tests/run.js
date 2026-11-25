'use strict';

// Runs every tests/repro check in its own process and exits non-zero if any
// of them fails. The timing scripts in tests/bench are run by hand.
// Usage: npm test   (or node tests/run.js)
//
// The checks in SQL_JS run a second time on the sql.js fallback
// (FX_BACKEND=sql.js in tests/harness/fx.js). The others read the durable
// file, its WAL or its fsyncs, which sql.js does not have.
//
// A check that prints SKIP (no MariaDB at FX_TRUST_MARIA, no lua on PATH)
// did not run, so it fails the run: the release gate needs every check.
// CIS_TEST_ALLOW_SKIP=1 makes a partial run pass, with each skip named.
// CIS_TEST_DIR runs another folder of checks (tests/repro/run_skip.js).
//
// Each check gets a temp directory of its own (TMP, TEMP, TMPDIR), removed
// when it exits: the checks make their folders there and leave them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SQL_JS = ['before_ready.js', 'collation.js', 'ddl.js', 'decimal_aggregates.js', 'dialect_market.js', 'info_schema.js', 'prepare_batches.js', 'strict_mode.js'];

const dir = process.env.CIS_TEST_DIR || path.join(__dirname, 'repro');
const allowSkip = process.env.CIS_TEST_ALLOW_SKIP === '1';
const files = fs.readdirSync(dir).filter((n) => n.endsWith('.js')).sort();
const runs = files.map((f) => ({ f, backend: null }))
    .concat(SQL_JS.filter((f) => files.includes(f)).map((f) => ({ f, backend: 'sql.js' })));
// A process a check leaves running (mariadbd) uses this one instead.
const shared = process.env.CIS_SHARED_TMP || os.tmpdir();
let failed = 0;
let skipped = 0;
for (const { f, backend } of runs) {
    const t0 = Date.now();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-test-'));
    const env = Object.assign({}, process.env, { TMP: tmp, TEMP: tmp, TMPDIR: tmp, CIS_SHARED_TMP: shared }, backend ? { FX_BACKEND: backend } : {});
    const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8', timeout: 600000, env });
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { console.log('     could not remove ' + tmp + ': ' + e.message); }
    const text = (r.stdout || '') + (r.stderr || '');
    const lines = text.split('\n').filter((l) => /^(PASS|FAIL|all \d+ passed|\d+ of \d+ failed)/.test(l));
    const skip = text.split('\n').find((l) => l.startsWith('SKIP'));
    const ok = r.status === 0;
    const name = backend ? f + ' [' + backend + ']' : f;
    const secs = ' (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s) ';
    if (!ok) failed++;
    else if (skip) skipped++;
    if (ok && skip) console.log('SKIP ' + name + secs + skip.slice(4).trim());
    else console.log((ok ? 'ok   ' : 'FAIL ') + name + secs + (lines[lines.length - 1] || ''));
    if (!ok) lines.filter((l) => l.startsWith('FAIL')).forEach((l) => console.log('     ' + l));
}
if (failed) console.log(failed + ' of ' + runs.length + ' runs failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
else if (skipped) console.log(skipped + ' of ' + runs.length + ' runs skipped' + (allowSkip ? ' (CIS_TEST_ALLOW_SKIP=1)' : ': a skip fails the gate; CIS_TEST_ALLOW_SKIP=1 allows a partial run'));
else console.log('all ' + runs.length + ' runs passed');
process.exit(failed || (skipped && !allowSkip) ? 1 : 0);
