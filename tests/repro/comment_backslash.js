'use strict';

// The comment stripper ended a string at a backslash-escaped quote. In
// 'I\'m #1' the \' closed the string, so the # opened a comment that took the
// rest of the line, WHERE clause included. MySQL reads \' as a quote inside
// the string (invariant 4), so # -- and slash-star after it are text.
// Usage: node tests/repro/comment_backslash.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-cmtbs-'));
const mariaFile = path.join(dir, 'maria.sqlite');
new DatabaseSync(mariaFile).close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;

const fx = require('../harness/fx.js');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const ids = (rows) => (rows || []).map((r) => r.id).join(',');

(async () => {
    check('engine ready', await fx.ready(20000));
    await fx.call('query', 'CREATE TABLE notes (id INT PRIMARY KEY, body VARCHAR(64))');
    await fx.call('insert', 'INSERT INTO notes (id, body) VALUES (?, ?), (?, ?), (?, ?)',
        [1, "I'm #1", 2, "I'm #1", 3, 'other']);
    for (const [name, text] of [['#', "I\\'m #1"], ['-- ', "I\\'m -- 1"], ['slash-star', "I\\'m /* 1"]]) {
        const body = text.replace(/\\'/g, "'");
        await fx.call('update', 'UPDATE notes SET body = ? WHERE id IN (1, 2)', [body]);
        const sel = await fx.call('query', "SELECT id FROM notes WHERE body = '" + text + "' AND id = 2");
        check(name + ' after \\\' stays in the string (SELECT)', ids(sel) === '2', ids(sel));
        const upd = await fx.call('update', "UPDATE notes SET body = 'x' WHERE body = '" + text + "' AND id = 1");
        const rows = await fx.call('query', 'SELECT id, body FROM notes ORDER BY id');
        const bodies = rows.map((r) => r.body).join('|');
        check(name + ' after \\\' keeps the WHERE (UPDATE)', upd === 1 && bodies === 'x|' + body + '|other', upd + ' ' + bodies);
    }
    const dq = await fx.call('query', 'SELECT id FROM notes WHERE body = "I\\"m" # tail\n OR id = 3');
    check('\\" in a double-quoted string, then a real # comment', ids(dq) === '3', ids(dq));
    const bt = await fx.call('query', 'SELECT `id` FROM notes WHERE id = 3 # a \\` b');
    check('a backslash in a comment after a name', ids(bt) === '3', ids(bt));
    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
