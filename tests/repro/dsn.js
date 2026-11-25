'use strict';

// Finding 4.2.17: a password with an unencoded / or @ spilled into the host
// and database (and so into the "replica pool" log line). parseDsn and
// clampDsn are lifted out of server.js and run on their own.
// Usage: node tests/repro/dsn.js

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
function lift(name) {
    const a = src.indexOf('function ' + name + '(');
    const b = src.indexOf('\nfunction ', a + 10);
    return src.slice(a, b);
}
// eslint-disable-next-line no-new-func
const parseDsn = new Function(lift('decodeDsnPart') + '\n' + lift('parseDsn') + '\n' + lift('clampDsn') + '\nreturn parseDsn;')();

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const show = (d) => JSON.stringify({ host: d.host, port: d.port, user: d.user, database: d.database, pw: d.password ? d.password.length + ' chars' : '' });

let d = parseDsn('mysql://root:pa/ss@10.0.0.5:3307/game');
check('password with / stays in the password', d.password === 'pa/ss' && d.host === '10.0.0.5' && d.port === 3307 && d.database === 'game', show(d));
d = parseDsn('mysql://root:p@ss@10.0.0.5/game');
check('password with @ stays in the password', d.password === 'p@ss' && d.host === '10.0.0.5' && d.database === 'game', show(d));
d = parseDsn('mysql://10.0.0.5/game?user=root&password=@Pw@&charset=utf8mb4');
check('@ in the query-string password is not user info', d.password === '@Pw@' && d.user === 'root' && d.host === '10.0.0.5' && d.database === 'game', show(d));
d = parseDsn('mysql://root:p%2Fw@10.0.0.5/game');
check('encoded password still decodes', d.password === 'p/w' && d.database === 'game', show(d));
d = parseDsn('mysql://10.0.0.5:3306/game');
check('no user info', d.user === 'root' && d.password === '' && d.host === '10.0.0.5' && d.database === 'game', show(d));
d = parseDsn('server=10.0.0.5;database=game;userid=root;password=a/b@c');
check('key=value form', d.password === 'a/b@c' && d.database === 'game' && d.host === '10.0.0.5', show(d));

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
