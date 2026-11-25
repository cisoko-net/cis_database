'use strict';

// Ship gate row 8: the console command cis_database_doctor checks the setup
// traps the engine cannot fix itself and names the fix for each one. Here
// the install has a real oxmysql started beside it and a config.json that
// does not parse; the rest of the setup is sound.
// Usage: node tests/repro/doctor.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-doctor-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE users (identifier VARCHAR(64) PRIMARY KEY, money INT NOT NULL)');
m.close();
fs.writeFileSync(path.join(dir, 'config.json'), '{ "activeProfile": "durable", }');
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;

const commands = {};
global.RegisterCommand = (name, fn, restricted) => { commands[name] = { fn, restricted }; };
// A real oxmysql resource, in its own folder, started beside cis_database.
global.GetResourceState = (name) => (name === 'oxmysql' ? 'started' : 'missing');
const otherPath = path.join(os.tmpdir(), 'resources', 'oxmysql');

const fx = require('../harness/fx.js');
const ownPath = global.GetResourcePath;
global.GetResourcePath = (name) => (name === 'oxmysql' ? otherPath : ownPath(name));

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

function run(source) {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try { commands.cis_database_doctor.fn(source, []); } finally { console.log = orig; }
    return lines;
}
const line = (lines, re) => lines.find((l) => re.test(l)) || '';

(async () => {
    if (!(await fx.ready(20000))) throw new Error('not ready');
    const cmd = commands.cis_database_doctor;
    check('cis_database_doctor is registered as a restricted command', !!cmd && cmd.restricted === true);
    if (!cmd) { console.log('1 of 1 failed'); process.exit(1); }

    check('a player gets no answer', run(1).length === 0);

    const out = run(0);
    const all = out.join('\n');
    const oxm = line(out, /oxmysql/i);
    check('a real oxmysql beside it is a FAIL with the fix', /FAIL/.test(oxm) && /ensure oxmysql/.test(oxm), oxm);
    const cfg = line(out, /config\.json/);
    check('a config.json that does not parse is a FAIL with the parse error', /FAIL/.test(cfg) && /JSON|position|Unexpected|Expected/.test(cfg), cfg);
    check('the SQLite file is OK', /OK .*node:sqlite/.test(line(out, /node:sqlite|sql\.js|memory/)), line(out, /node:sqlite|sql\.js|memory/));
    check('the split checkpoint is OK', /OK /.test(line(out, /checkpoint/i)), line(out, /checkpoint/i));
    check('the MariaDB copy is OK', /OK /.test(line(out, /MariaDB copy/)), line(out, /MariaDB copy/));
    check('the folder name is OK', /OK /.test(line(out, /folder/)), line(out, /folder/));
    check('the summary counts two problems', /2 problems/.test(all), out[out.length - 1]);

    // With the real oxmysql gone the same check passes.
    global.GetResourceState = () => 'missing';
    const after = run(0);
    check('no oxmysql started: that check is OK', /OK /.test(line(after, /oxmysql/i)), line(after, /oxmysql/i));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
