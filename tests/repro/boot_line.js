'use strict';

// The first line cis_database prints at boot names its own version and the
// oxmysql version it stands in for, both read from fxmanifest.lua
// (cis_version, version), so a server console shows which database answered
// as oxmysql. Before, nothing in the boot log named either.
// Usage: node tests/repro/boot_line.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..', '..');
const HARNESS = path.join(__dirname, '..', 'harness', 'fx.js');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

const manifest = fs.readFileSync(path.join(ROOT, 'fxmanifest.lua'), 'utf8');
const meta = (key) => (new RegExp('^' + key + "\\s+'([^']+)'", 'm').exec(manifest) || [])[1] || '';
const own = meta('cis_version');
const ox = meta('version');
check('fxmanifest.lua sets cis_version and version', own && ox, own + ' ' + ox);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-bootline-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body VARCHAR(32) NOT NULL)');
m.close();

// The harness leaves cis_version unset, so no check asks GitHub for the latest
// release. This child answers both keys as FXServer does and stubs https.get,
// so the version check after ready sends no request.
const code = "const https = require('https');\n"
    + "https.get = () => { const req = new (require('events'))(); req.destroy = () => {}; return req; };\n"
    + 'const META = ' + JSON.stringify({ cis_version: own, version: ox }) + ';\n'
    + 'let inner = null;\n'
    + "Object.defineProperty(global, 'GetResourceMetadata', { configurable: true,\n"
    + '    get: () => (res, key, i) => (key in META ? META[key] : inner ? inner(res, key, i) : null),\n'
    + '    set: (fn) => { inner = fn; } });\n'
    + 'const fx = require(' + JSON.stringify(HARNESS) + ');\n'
    + '(async () => {\n'
    + "if (!(await fx.ready(20000))) throw new Error('not ready');\n"
    + 'process.exit(0);\n'
    + "})().catch((e) => { console.log('CHILD ERROR ' + (e && e.stack)); process.exit(2); });";

const proc = spawnSync(process.execPath, ['-e', code], {
    env: Object.assign({}, process.env, { FX_RES_DIR: dir, FX_MARIA_FILE: mariaFile }),
    encoding: 'utf8',
    timeout: 90000,
});
const text = (proc.stdout || '') + (proc.stderr || '');
const lines = text.split(/\r?\n/).filter((l) => l.startsWith('[cis_database'));
const want = '[cis_database] cis_database ' + own + ' provides oxmysql ' + ox + ', mysql-async and ghmattimysql';
check('the first boot line names the version and what it provides', lines[0] === want, JSON.stringify(lines[0]) + ' wanted ' + JSON.stringify(want));
check('the engine came up', proc.status === 0 && lines.some((l) => l.startsWith('[cis_database] Ready.')), proc.status === 0 ? '' : text.slice(-600));

fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
