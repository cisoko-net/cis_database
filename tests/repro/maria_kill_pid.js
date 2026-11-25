'use strict';

// Final review 407c8ec #6: a test that kills MariaDB with `taskkill /IM`
// kills every process with that image name, including a MariaDB the
// developer runs for something else. Tests kill the one listening on the
// test port, by PID.
//
// Usage: node tests/repro/maria_kill_pid.js

const fs = require('fs');
const path = require('path');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

const dir = path.join(__dirname);
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js') && n !== path.basename(__filename))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!/taskkill|killMaria/.test(src)) continue;
    check(f + ' kills MariaDB by PID, not by image name', !/['"]\/IM['"]/.test(src));
}
const helper = require('../harness/maria_pid');
check('the port is read from the test URL', helper.portOf('mysql://root@127.0.0.1:3307') === 3307 && helper.portOf('mysql://u:p@localhost:3399/db') === 3399);
const sample = [
    '  TCP    0.0.0.0:3306           0.0.0.0:0              LISTENING       4410',
    '  TCP    127.0.0.1:3307         0.0.0.0:0              LISTENING       9120',
    '  TCP    127.0.0.1:3307         127.0.0.1:51000        ESTABLISHED     9120',
    '  TCP    127.0.0.1:33070        0.0.0.0:0              LISTENING       7777',
].join('\r\n');
check('netstat: the PID listening on the test port, no other', JSON.stringify(helper.listeningPids(sample, 3307)) === '[9120]', JSON.stringify(helper.listeningPids(sample, 3307)));

if (results.some((x) => !x)) process.exit(1);
console.log('maria_kill_pid: all ' + results.length + ' passed');
