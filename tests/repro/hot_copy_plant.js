'use strict';

// Security review N4: the performance profile copied the database to
// /dev/shm/cis_database_hot.<pid>.<ms>.sqlite. /dev/shm is writable by every
// local account, and the name was guessable (the pid, the boot time), so
// another account could create that file first, or a symlink of that name,
// and copyFileSync wrote the player data into it, owned by that account, or
// through the link into any file the server can write. The name now carries
// random bytes and the copy refuses an existing file (COPYFILE_EXCL), then
// takes a fresh name. hotCopy is lifted out of server.js and run with
// /dev/shm mapped to a temp folder.
// Usage: node tests/repro/hot_copy_plant.js

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-plant-'));
const shmDir = path.join(root, 'shm');
const resDir = path.join(root, 'res');
fs.mkdirSync(shmDir);
fs.mkdirSync(path.join(resDir, 'cache'), { recursive: true });
const dbFile = path.join(root, 'durable.sqlite');
fs.writeFileSync(dbFile, 'PLAYER DATA');

// /dev/shm lands in shmDir; everything else is the real path module.
const fakePath = Object.assign({}, path, {
    join: (a, ...rest) => (a === '/dev/shm' ? path.join(shmDir, ...rest) : path.join(a, ...rest)),
});
const NOW = 1761600000000;
const FakeDate = { now: () => NOW };
// eslint-disable-next-line no-new-func
const make = new Function('require', 'fs', 'path', 'Date', 'resPath', 'chmodPrivate', 'sweepHotCopies', 'state',
    'let storageMode = "performance"; let hotFile = null;\n' + lift('hotCopy')
    + '\nreturn () => { const f = hotCopy(state.src); state.hot = hotFile; return f; };');
const state = { src: dbFile };
const run = make(require, fs, fakePath, FakeDate, () => resDir, () => {}, () => 0, state);

// The other account plants the name it can guess.
const guess = 'cis_database_hot.' + process.pid + '.' + NOW + '.sqlite';
fs.writeFileSync(path.join(shmDir, guess), 'ATTACKER');
const a = run();
check('the planted file keeps its own contents', fs.readFileSync(path.join(shmDir, guess), 'utf8') === 'ATTACKER');
check('the copy goes to a file of its own', a && path.basename(a) !== guess && fs.readFileSync(a, 'utf8') === 'PLAYER DATA', a);

// Same pid, same millisecond: the names still differ, so none is guessable.
const b = run();
check('two copies in the same millisecond get different names', a !== b, path.basename(a) + ' / ' + path.basename(b));

// A boot sweep still finds the new names.
const m = /^cis_database_hot\.(\d+)\.\d+\.sqlite(?:-wal|-shm|-journal)?$/;
const sweep = lift('sweepHotCopies');
const re = (/\/\^cis_database_hot[^\n]*?\$\//.exec(sweep) || [''])[0];
// eslint-disable-next-line no-eval
const rx = re ? eval(re) : m;
check('sweepHotCopies matches the new name and its -wal', rx.test(path.basename(a)) && rx.test(path.basename(a) + '-wal') && rx.exec(path.basename(a))[1] === String(process.pid), re);

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
