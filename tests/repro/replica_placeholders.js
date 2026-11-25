'use strict';

// Security review S3: SQLite binds the ? that placeholderOffsets finds, which
// skips "..." strings and # and -- comments. mysql2 formats the replica's
// copy with sql-escaper, which binds a ? inside "..." or after # and reads
// --x (no space) as code. So `UPDATE t SET a = ? WHERE b = "x?"` bound the
// value twice on MariaDB: the write was rejected there, or worse, applied
// with shifted values, and the copies diverged. The replica now gets the
// text rewritten by replicaSqlText: "..." strings become '...' strings and
// comments are removed, so both sides bind the same ?.
// Usage: node tests/repro/replica_placeholders.js

const fs = require('fs');
const path = require('path');
const S = require('sql-escaper');

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

const body = grab('placeholderOffsets') + '\n' + grab('replicaSqlText');
check('server.js has replicaSqlText', body.includes('function replicaSqlText('));
if (results[0]) {
    // eslint-disable-next-line no-new-func
    const lib = new Function('dialect', body + '\nreturn { placeholderOffsets, replicaSqlText };')(require('../../dialect.js'));
    const cases = [
        ['UPDATE t SET a = ? WHERE b = "x?"', [1], "UPDATE t SET a = 1 WHERE b = 'x?'"],
        ['UPDATE t SET a = ? # why?\nWHERE id = ?', [1, 2], 'UPDATE t SET a = 1  \nWHERE id = 2'],
        ['UPDATE t SET a = ? -- why?\nWHERE id = ?', [1, 2], 'UPDATE t SET a = 1  \nWHERE id = 2'],
        // --x is code on both sides: 1--? is 1 - (-?).
        ['UPDATE t SET a = 1--? WHERE id = ?', [4, 2], 'UPDATE t SET a = 1--4 WHERE id = 2'],
        ['UPDATE t SET a = ? /*! why? */ WHERE id = ?', [1, 2], 'UPDATE t SET a = 1   WHERE id = 2'],
        ['SELECT "it\'s ?", ?', ['v'], "SELECT 'it\\'s ?', 'v'"],
        ['SELECT "say ""hi?""", ?', ['v'], "SELECT 'say \"hi?\"', 'v'"],
        ['SELECT "a\\"b?", ?', ['v'], "SELECT 'a\\\"b?', 'v'"],
        ["SELECT 'x?', `c?`, ?", ['v'], "SELECT 'x?', `c?`, 'v'"],
        ['SELECT ?', ["x\\'); DROP TABLE t; -- "], "SELECT 'x\\\\\\'); DROP TABLE t; -- '"],
    ];
    for (const [sql, params, want] of cases) {
        const text = lib.replicaSqlText(sql);
        const got = S.format(text, params);
        const ours = lib.placeholderOffsets(sql).length;
        check('replica binds what SQLite binds: ' + JSON.stringify(sql), got === want && ours === params.length, JSON.stringify(got));
    }
    const plain = 'UPDATE players SET money = ? WHERE citizenid = ?';
    check('plain SQL is returned unchanged (same string)', lib.replicaSqlText(plain) === plain);
}

// Both replica send paths use it.
check('applyStmt sends replicaSqlText', /conn\.query\(replicaSqlText\(st\.sql\), st\.params\)/.test(grab('applyStmt')));
check('applyOutboxBatch formats replicaSqlText', /conn\.format\(replicaSqlText\(st\.sql\), st\.params\)/.test(grab('applyOutboxBatch')));

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
