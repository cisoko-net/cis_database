'use strict';

// Security review F3: no mysql2 connection carried TLS options and parseDsn
// dropped ?ssl=, so a replica on another machine got game data and the
// password in plain text, and nothing said so. parseDsn now reads ssl (and
// sslmode) in both DSN forms, every connection to MariaDB passes it, and
// boot warns when the host is not this machine and TLS is off.
// Usage: node tests/repro/dsn_tls.js

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const cdcSrc = fs.readFileSync(path.join(root, 'cdc.js'), 'utf8');
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

const parts = ['decodeDsnPart', 'dsnSsl', 'parseDsn', 'clampDsn', 'isLoopbackHost'].map(lift);
check('server.js has dsnSsl and isLoopbackHost', parts[1] !== '' && parts[4] !== '');
if (parts.every(Boolean)) {
    // eslint-disable-next-line no-new-func
    const { parseDsn, isLoopbackHost } = new Function(parts.join('\n') + '\nreturn { parseDsn, isLoopbackHost };')();
    const ssl = (s) => JSON.stringify(parseDsn(s).ssl);
    check('ssl=true turns TLS on, certificates checked', ssl('mysql://u:p@db.example.com/game?ssl=true') === '{}', ssl('mysql://u:p@db.example.com/game?ssl=true'));
    check('ssl=1 in key=value form', ssl('host=10.0.0.5;database=game;user=u;password=p;ssl=1') === '{}');
    check('sslmode=REQUIRED', ssl('mysql://u:p@10.0.0.5/game?sslmode=REQUIRED') === '{}');
    const j = 'mysql://u:p@10.0.0.5/game?ssl=' + encodeURIComponent('{"rejectUnauthorized":false}');
    check('ssl as JSON options', ssl(j) === '{"rejectUnauthorized":false}', ssl(j));
    check('ssl=false leaves TLS off', parseDsn('mysql://u:p@10.0.0.5/game?ssl=false').ssl === undefined);
    check('no ssl leaves TLS off', parseDsn('mysql://u:p@10.0.0.5/game').ssl === undefined);
    check('bad JSON leaves TLS off, no throw', parseDsn('mysql://u:p@10.0.0.5/game?ssl={oops').ssl === undefined);
    check('the password is untouched', parseDsn('mysql://u:p@10.0.0.5/game?ssl=true').password === 'p');
    const loop = ['127.0.0.1', '127.0.1.1', 'localhost', '::1', '::ffff:127.0.0.1'];
    const away = ['10.0.0.5', 'db.example.com', '128.0.0.1', '127.example.com'];
    check('loopback hosts', loop.every(isLoopbackHost), loop.filter((h) => !isLoopbackHost(h)).join(','));
    check('remote hosts', away.every((h) => !isLoopbackHost(h)), away.filter(isLoopbackHost).join(','));
}

// Every connection option block passes ssl.
function blocks(text, file) {
    const out = [];
    const re = /mysql2mod\.create(?:Pool|Connection)\(/g;
    let m;
    while ((m = re.exec(text))) {
        const end = text.indexOf('})', m.index);
        out.push({ at: file + ':' + text.slice(0, m.index).split('\n').length, body: text.slice(m.index, end) });
    }
    return out;
}
const all = blocks(src, 'server.js').concat(blocks(cdcSrc, 'cdc.js'));
const bare = all.filter((b) => !/\bssl\b|mariaLink\(/.test(b.body)).map((b) => b.at);
check('every MariaDB connection passes ssl (' + all.length + ' sites)', all.length >= 5 && bare.length === 0, bare.join(' '));
check('boot warns about a remote host without TLS', /isLoopbackHost\(dsn\.host\)/.test(src) && /plain text/.test(src));

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
