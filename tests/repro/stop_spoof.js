'use strict';

// Security review E2: any resource can TriggerEvent('onResourceStop', 'x').
// server.js dropped x's resolver on that event, so x's .await calls that were
// held back hung, and lib/MySQL.lua rejected every pending call in every
// consumer when the name was cis_database. Both now act only when the named
// resource is really stopping, as index.lua does.
// Usage: node tests/repro/stop_spoof.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-stopspoof-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE users (identifier VARCHAR(64) PRIMARY KEY, money INT NOT NULL)');
m.close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;
process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: 'mysql://root@127.0.0.1/fake', cis_database_cdc: '0' });

const states = {};
global.GetResourceState = (name) => states[name] || 'started';
const fx = require('../harness/fx.js');
const r = fx.registry;

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const turn = () => new Promise((res) => setTimeout(res, 10));

(async () => {
    if (!(await fx.ready(20000))) throw new Error('not ready');
    global.__fxInvoker = 'victim';
    await turn();
    check('victim registers a resolver', r.cis_register(() => {}) === true);
    await turn();
    check('victim gets answers', r.cis_call('scalar', 'SELECT 1', [])[0] === 1);

    global.emit('onResourceStop', 'victim');
    await turn();
    const spoofed = r.cis_call('scalar', 'SELECT 1', []);
    check('a spoofed onResourceStop keeps the resolver', spoofed[0] === 1, JSON.stringify(spoofed));

    states.victim = 'stopping';
    global.emit('onResourceStop', 'victim');
    await turn();
    const real = r.cis_call('scalar', 'SELECT 1', []);
    check('a real stop drops it', real[0] === 3, JSON.stringify(real));

    // lib/MySQL.lua runs inside each consumer; the guard is checked in its text.
    const lua = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'MySQL.lua'), 'utf8');
    const h = lua.slice(lua.indexOf("AddEventHandler('onResourceStop'"));
    const body = h.slice(0, h.indexOf('\nend)'));
    check('lib/MySQL.lua rejects pending calls only on a real stop',
        /GetResourceState\(name\) ~= 'stopping'/.test(body) && body.indexOf('stopping') < body.indexOf(':reject('), body.split('\n').slice(0, 6).join(' | '));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
