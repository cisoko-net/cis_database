'use strict';

// Security review F2: the performance profile copies the database to
// /dev/shm/cis_database_hot.<pid>.<time>.sqlite on every boot and never
// removed it, so each restart left a full copy of player data in RAM.
// Boot now removes copies whose server process is gone (a copy of a server
// still running, such as a second FXServer on the same box, is kept), and
// shutdown removes its own. sweepHotCopies and removeDbFile are lifted out
// of server.js and run on a temp folder.
// Usage: node tests/repro/hot_copy_cleanup.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
function lift(name) {
    const a = src.indexOf('function ' + name + '(');
    if (a < 0) return '';
    const b = src.indexOf('\nfunction ', a + 10);
    return src.slice(a, b);
}

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

const body = lift('sweepHotCopies') + '\n' + lift('removeDbFile');
check('server.js has sweepHotCopies and removeDbFile', body.includes('function sweepHotCopies(') && body.includes('function removeDbFile('));
if (results[0]) {
    // eslint-disable-next-line no-new-func
    const lib = new Function('fs', 'path', body + '\nreturn { sweepHotCopies, removeDbFile };')(fs, path);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-hot-'));
    // Process ids above the kernel's limit (4194304 on Linux) never exist.
    const dead = 2147483000;
    const mk = (n) => { fs.writeFileSync(path.join(dir, n), 'x'); return n; };
    const stale = [mk('cis_database_hot.' + dead + '.1.sqlite'), mk('cis_database_hot.' + dead + '.1.sqlite-wal'), mk('cis_database_hot.' + dead + '.1.sqlite-shm'), mk('cis_database_hot.' + (dead + 1) + '.2.sqlite')];
    const live = mk('cis_database_hot.' + process.pid + '.3.sqlite');
    const other = [mk('cis_database_hot.notapid.sqlite'), mk('somebody_else.' + dead + '.sqlite'), mk('durable.sqlite')];
    const removed = lib.sweepHotCopies(dir);
    const left = fs.readdirSync(dir);
    check('copies of servers that are gone are removed, with their -wal and -shm', stale.every((n) => !left.includes(n)), 'removed ' + removed + ', left ' + left.join(' '));
    check('a copy of a server still running is kept', left.includes(live));
    check('files that are not hot copies are kept', other.every((n) => left.includes(n)));
    check('a missing folder is not an error', lib.sweepHotCopies(path.join(dir, 'nope')) === 0);

    lib.removeDbFile(path.join(dir, live));
    check('removeDbFile removes the file', !fs.existsSync(path.join(dir, live)));
    mk('gone.sqlite-wal');
    lib.removeDbFile(path.join(dir, 'gone.sqlite'));
    check('removeDbFile removes a -wal left without its file', !fs.existsSync(path.join(dir, 'gone.sqlite-wal')));
}

// Shutdown must remove the copy this server made.
const sd = src.slice(src.indexOf("selfExport('shutdown'"), src.indexOf("exports('probe'"));
check('shutdown removes this server\'s hot copy after the database closes', /backend\.close\(\)[\s\S]*removeDbFile\(hotFile\)/.test(sd));
check('boot sweeps /dev/shm and cache before making a new copy', /sweepHotCopies\('\/dev\/shm'\)[\s\S]{0,200}sweepHotCopies\(/.test(lift('hotCopy')));

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
