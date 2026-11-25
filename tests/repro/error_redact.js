'use strict';

// Security review F5: when MariaDB rejected a replica write, the console line
// carried its error text, and MariaDB quotes the value it refused ("Incorrect
// integer value: 'player text' for column ..."). logSqlErrors is on by
// default, so player data reached the server console and its log files.
// redactSqlError replaces quoted values with '?' and keeps the names of
// columns, keys and tables; cis_database_debug 1 shows the full text.
// Usage: node tests/repro/error_redact.js

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
function grab(name) {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) return '';
    let d = 0;
    let j = src.indexOf('{', i);
    for (; j < src.length; j++) {
        if (src[j] === '{') d++;
        else if (src[j] === '}' && --d === 0) break;
    }
    return src.slice(i, j + 1);
}

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

const body = grab('redactSqlError');
check('server.js has redactSqlError', body !== '');
if (body) {
    // eslint-disable-next-line no-new-func
    const make = (debug) => new Function('DEBUG', body + '\nreturn redactSqlError;')(debug);
    const redact = make(false);
    const cases = [
        ["Incorrect integer value: 'my secret note' for column `game`.`users`.`money` at row 1",
            "Incorrect integer value: '?' for column `game`.`users`.`money` at row 1"],
        ["Duplicate entry 'steam:110000abc' for key 'PRIMARY'", "Duplicate entry '?' for key 'PRIMARY'"],
        ["Incorrect string value: '\\xF0\\x9F\\x98' for column 'name' at row 1", "Incorrect string value: '?' for column 'name' at row 1"],
        ["Truncated incorrect DOUBLE value: 'it''s 5'", "Truncated incorrect DOUBLE value: '?'"],
        ["Table 'game.no_such' doesn't exist", "Table 'game.no_such' doesn't exist"],
        ["Unknown column 'nope' in 'field list'", "Unknown column 'nope' in 'field list'"],
        ['Data too long for column \'name\' at row 1', 'Data too long for column \'name\' at row 1'],
    ];
    for (const [msg, want] of cases) {
        const got = redact(msg);
        check('redacts ' + JSON.stringify(msg.slice(0, 40)), got === want, JSON.stringify(got));
    }
    const full = cases[0][0];
    check('debug shows the full text', make(true)(full) === full);
}

check('logRejected logs the redacted text', /redactSqlError\(/.test(grab('logRejected')) && !/\+ why \+/.test(grab('logRejected')));
check('backoffReplica logs the redacted text', /redactSqlError\(/.test(grab('backoffReplica')));

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
