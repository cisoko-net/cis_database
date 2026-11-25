'use strict';

// Every repro check makes its own folder in the temp directory and most never
// remove it, so each npm test left hundreds of folders behind. tests/run.js
// now gives each check a temp directory of its own (TMP, TEMP and TMPDIR) and
// removes it when the check exits.
// Usage: node tests/repro/run_temp.js

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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-runtemp-'));
const marks = path.join(dir, 'marks.txt');
// The check writes where its temp folder is, then leaves it behind.
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, 'checks', 'leak.js'),
    "const fs = require('fs'), os = require('os'), path = require('path');\n"
    + "const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-leak-'));\n"
    + "fs.writeFileSync(path.join(d, 'x'), 'x');\n"
    + 'fs.appendFileSync(' + JSON.stringify(marks) + ', d + String.fromCharCode(10));\n'
    + "console.log('PASS made a folder'); console.log('all 1 passed');\n");
const r = spawnSync(process.execPath, [runner], {
    encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, { CIS_TEST_DIR: path.join(dir, 'checks'), CIS_TEST_ALLOW_SKIP: '' }),
});
check('the run passes', r.status === 0, 'exit ' + r.status + ' ' + JSON.stringify((r.stdout || '').trim()));
const made = fs.existsSync(marks) ? fs.readFileSync(marks, 'utf8').trim().split('\n') : [];
check('the check made a temp folder', made.length === 1 && !!made[0], JSON.stringify(made));
check('the folder is gone after the run', made.length === 1 && !fs.existsSync(made[0]), made[0]);
check('it was not in the shared temp directory', made.length === 1 && path.dirname(made[0]) !== path.resolve(os.tmpdir()), made[0]);
fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
