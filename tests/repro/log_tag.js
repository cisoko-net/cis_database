'use strict';

// Warning and debug lines carry the level inside the resource tag, as
// "[cis_database:warn]". The tag used to be built by appending ":warn]" to
// the whole prefix, which printed "[cis_database]:warn]".
// Usage: node tests/repro/log_tag.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-logtag-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE users (identifier VARCHAR(64) PRIMARY KEY, money INT NOT NULL)');
m.close();
// A config.json that does not parse makes the engine warn during boot.
fs.writeFileSync(path.join(dir, 'config.json'), '{ "activeProfile": "durable", }');
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;

const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(' ')); };

const fx = require('../harness/fx.js');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

(async () => {
    const ready = await fx.ready(20000);
    console.warn = origWarn;
    check('engine ready', ready);
    const line = warnings.find((l) => l.includes('config.json is not valid JSON')) || '';
    check('config warning was printed', line !== '', warnings.slice(0, 3).join(' | '));
    check('warning tag is [cis_database:warn]', line.startsWith('[cis_database:warn] '), JSON.stringify(line.slice(0, 40)));
    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.warn = origWarn;
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
