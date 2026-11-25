'use strict';
// The boot version check must warn a beta install when a newer beta or the
// final release is out, and stay quiet when the install is current or newer.
// versionParts alone dropped the prerelease, so 1.0.0-beta.1 read as equal
// to v1.0.0 and a beta user never heard the final release was out.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
const start = src.indexOf('function versionParts(');
const end = src.indexOf('function checkVersion(');
if (start < 0 || end < 0) throw new Error('version functions not found in server.js');
const versionOlder = new Function(src.slice(start, end) + '\nreturn versionOlder;')();

const cases = [
    ['1.0.0-beta.1', 'v1.0.0', true],
    ['1.0.0-beta.1', 'v1.0.0-beta.2', true],
    ['1.0.0-beta.2', 'v1.0.0-beta.10', true],
    ['1.0.0-beta.1', 'v1.0.0-beta.1', false],
    ['1.0.0-beta.2', 'v1.0.0-beta.1', false],
    ['1.0.0', 'v1.0.0-beta.9', false],
    ['1.0.0', 'v1.0.0', false],
    ['1.0.0', 'v1.0.1', true],
    ['1.0.1', 'v1.0.0', false],
    ['1.0.0-beta.1', 'v1.0.1-beta.1', true],
    ['1.0.0-alpha.3', 'v1.0.0-beta.1', true],
    ['1.0.0-beta', 'v1.0.0-beta.1', true],
    ['1.0.0-beta.1', 'v1.0.0-beta', false],
];

let failed = 0;
for (const [local, remote, want] of cases) {
    const got = versionOlder(local, remote);
    if (got !== want) {
        failed++;
        console.log('FAIL versionOlder(' + local + ', ' + remote + ') = ' + got + ', want ' + want);
    }
}
if (failed) {
    console.log('FAIL version_check: ' + failed + ' of ' + cases.length);
    process.exit(1);
}
console.log('PASS version_check: ' + cases.length + ' cases');
