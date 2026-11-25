'use strict';

// Security review F4: parseDsn split user info at the last @ before the first
// ?, so a ? in the password moved the split, and the "replica pool" log line
// printed part of the password as the host or database. A % that was not an
// escape threw URIError and stopped the boot. In the key=value form a ; in
// the password cut it short. parseDsn is lifted out of server.js.
// Usage: node tests/repro/dsn_passwords.js

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
function lift(name) {
    const a = src.indexOf('function ' + name + '(');
    if (a < 0) return '';
    const b = src.indexOf('\nfunction ', a + 10);
    return src.slice(a, b);
}
// eslint-disable-next-line no-new-func
const parseDsn = new Function(lift('decodeDsnPart') + '\n' + lift('parseDsn') + '\n' + lift('clampDsn') + '\nreturn parseDsn;')();

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const show = (d) => JSON.stringify({ host: d.host, port: d.port, user: d.user, database: d.database, password: d.password });

const cases = [
    ['/ and ? in the password', 'mysql://game:Pa/ssw?rd@10.0.0.5/game', { user: 'game', password: 'Pa/ssw?rd', host: '10.0.0.5', database: 'game' }],
    ['? in the password', 'mysql://user:S3cr?tPass@10.0.0.5:3307/game', { user: 'user', password: 'S3cr?tPass', host: '10.0.0.5', port: 3307, database: 'game' }],
    ['# in the password', 'mysql://user:Sec#ret@10.0.0.5/game', { user: 'user', password: 'Sec#ret', host: '10.0.0.5', database: 'game' }],
    ['% that is not an escape', 'mysql://user:50%off@10.0.0.5/game', { user: 'user', password: '50%off', host: '10.0.0.5', database: 'game' }],
    ['%-encoded password still decodes', 'mysql://user:a%2Fb%40c@10.0.0.5/game', { user: 'user', password: 'a/b@c', host: '10.0.0.5', database: 'game' }],
    ['@ in the password', 'mysql://u:p@ss@10.0.0.5/game', { user: 'u', password: 'p@ss', host: '10.0.0.5', database: 'game' }],
    ['@, / and ? together', 'mysql://u:p@h/x?y@10.0.0.5/game', { user: 'u', password: 'p@h/x?y', host: '10.0.0.5', database: 'game' }],
    ['@ in a query-string value with user info', 'mysql://u:p@10.0.0.5/game?password=x@y', { user: 'u', password: 'x@y', host: '10.0.0.5', database: 'game' }],
    ['@ only in the query string', 'mysql://10.0.0.5/game?user=root&password=@Pw@', { user: 'root', password: '@Pw@', host: '10.0.0.5', database: 'game' }],
    ['% in the query string', 'mysql://10.0.0.5/game?user=root&password=50%off', { user: 'root', password: '50%off', host: '10.0.0.5', database: 'game' }],
    ['; in a key=value password', 'server=10.0.0.5;uid=u;password=ab;cd;database=game', { user: 'u', password: 'ab;cd', host: '10.0.0.5', database: 'game' }],
    ['key=value with no ;', 'server=10.0.0.5;uid=u;password=abc;database=game', { user: 'u', password: 'abc', host: '10.0.0.5', database: 'game' }],
    ['plain URL', 'mysql://root:pw@localhost:3306/qbox', { user: 'root', password: 'pw', host: '127.0.0.1', port: 3306, database: 'qbox' }],
];
for (const [name, dsn, want] of cases) {
    let d = null;
    let err = null;
    try { d = parseDsn(dsn); } catch (e) { err = e.name + ' ' + e.message; }
    const ok = d && Object.keys(want).every((k) => d[k] === want[k]);
    check(name, ok, err || show(d));
}

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
