'use strict';

// fxmanifest `version` is the oxmysql version other resources compare with
// ox_lib's lib.checkDependency (ox_lib resource/version/shared.lua: the first
// x.y.z of the metadata, compared part by part). It must stay at or above the
// floors they ask for, and must not be the product version (`cis_version`).
// Floors read from source: ox_inventory v2.44.1 init.lua:175 asks 2.7.3,
// ox_doorlock server/main.lua:6 asks 2.4.0.
//
// Usage: node tests/repro/oxmysql_floor.js

const fs = require('fs');
const path = require('path');

const FLOORS = [['ox_inventory v2.44.1', '2.7.3'], ['ox_doorlock', '2.4.0']];

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

// lib.checkDependency's rule: true when current >= minimum.
function meets(current, minimum) {
    const cv = current.split('.').map(Number);
    const mv = minimum.split('.').map(Number);
    for (let i = 0; i < cv.length; i++) {
        if (cv[i] !== mv[i]) return !(Number.isNaN(cv[i]) || cv[i] < mv[i]);
    }
    return true;
}

const manifest = fs.readFileSync(path.join(__dirname, '..', '..', 'fxmanifest.lua'), 'utf8');
const ver = (manifest.match(/^version\s+'([^']*)'/m) || [])[1] || '';
const cisVer = (manifest.match(/^cis_version\s+'([^']*)'/m) || [])[1] || '';
const xyz = (ver.match(/\d+\.\d+\.\d+/) || ['unknown'])[0];

check('fxmanifest version is an oxmysql x.y.z', xyz !== 'unknown', ver);
check('fxmanifest version is not the product version', ver !== cisVer, ver + ' vs cis_version ' + cisVer);
for (const [who, floor] of FLOORS) check(who + ' floor ' + floor + ' is met', meets(xyz, floor), xyz);
check('the rule refuses a lower version', !meets('2.6.9', '2.7.3') && !meets('1.0.0', '2.7.3') && meets('2.7.3', '2.7.3'));

if (results.some((x) => !x)) process.exit(1);
console.log('oxmysql_floor: all ' + results.length + ' passed');
