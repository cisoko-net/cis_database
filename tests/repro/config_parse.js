'use strict';

// A config.json that does not parse (a trailing comma, a stray quote) was
// dropped without a word: every setting fell back to its default and the
// owner never knew their edits were ignored. loadConfig now warns, naming the
// parse error, and still starts on the defaults. A missing file stays quiet.
// Usage: node tests/repro/config_parse.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
function lift(name) {
    const a = src.indexOf('function ' + name + '(');
    const b = src.indexOf('\nfunction ', a + 10);
    return src.slice(a, b);
}

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

function run(body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-cfg-'));
    if (body != null) fs.writeFileSync(path.join(dir, 'config.json'), body);
    const warned = [];
    const log = { warn: (m) => warned.push(m), info() {}, debug() {}, error() {} };
    // eslint-disable-next-line no-new-func
    const load = new Function('fs', 'path', 'log', 'resPath', 'convar',
        lift('configValue') + '\n' + lift('bootLine') + '\n' + lift('loadConfig') + '\nloadConfig(); return { cfg, FRAME_MS };')(
        fs, path, log, () => dir, (n, fb) => fb);
    fs.rmSync(dir, { recursive: true, force: true });
    return { warned, out: load };
}

let r = run('{ "frameBudgetMs": 30, }');
check('broken config.json warns', r.warned.some((m) => /config\.json/.test(m)), JSON.stringify(r.warned));
check('and starts on the defaults', r.out.FRAME_MS === 25 && r.out.cfg.profile === 'durable', 'frame=' + r.out.FRAME_MS);
r = run('{ "frameBudgetMs": 30 }');
check('good config.json is read quietly', r.out.FRAME_MS === 30 && r.warned.length === 0, JSON.stringify(r.warned));
r = run(null);
check('missing config.json is quiet', r.warned.length === 0 && r.out.FRAME_MS === 25, JSON.stringify(r.warned));

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
