'use strict';

// Review L11: tests/run.js counted a check that printed SKIP (no MariaDB, no
// lua on PATH) as passed, so "all runs passed" could hide checks that never
// ran. A skip now fails the run unless CIS_TEST_ALLOW_SKIP=1 asks for a
// partial run, and each skip is named with its reason.
// Usage: node tests/repro/run_skip.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

const runner = path.join(__dirname, '..', 'run.js');
// Without the override run.js would run this whole folder, this file included.
const src = fs.readFileSync(runner, 'utf8');
check('run.js takes CIS_TEST_DIR', src.includes('CIS_TEST_DIR'));
if (results[0]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-runskip-'));
    fs.writeFileSync(path.join(dir, 'a_pass.js'), "console.log('PASS one'); console.log('all 1 passed');\n");
    fs.writeFileSync(path.join(dir, 'b_skip.js'), "console.log('SKIP no MariaDB at here');\n");
    const run = (extra) => spawnSync(process.execPath, [runner], {
        encoding: 'utf8', timeout: 60000,
        env: Object.assign({}, process.env, { CIS_TEST_DIR: dir, CIS_TEST_ALLOW_SKIP: '' }, extra || {}),
    });
    let r = run();
    const out = (r.stdout || '') + (r.stderr || '');
    check('a skip fails the run', r.status === 1, 'exit ' + r.status);
    check('the skip is named with its reason', /SKIP b_skip\.js .*no MariaDB at here/.test(out), JSON.stringify(out));
    check('the pass is still reported', /ok {3}a_pass\.js/.test(out));
    check('the summary counts the skip', /1 of 2 runs skipped/.test(out), JSON.stringify(out.trim().split('\n').pop()));
    r = run({ CIS_TEST_ALLOW_SKIP: '1' });
    check('CIS_TEST_ALLOW_SKIP=1 lets a partial run pass', r.status === 0, 'exit ' + r.status + ' ' + JSON.stringify(r.stdout));
    fs.writeFileSync(path.join(dir, 'b_skip.js'), "console.log('PASS two'); console.log('all 1 passed');\n");
    r = run();
    check('no skip: the run passes', r.status === 0 && /all 2 runs passed/.test(r.stdout), JSON.stringify(r.stdout));
}

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
