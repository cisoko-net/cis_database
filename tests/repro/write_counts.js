'use strict';

// Write results that oxmysql callers read, as MariaDB 10.11 gives them through
// mysql2 (measured on a real server, tests/corpus/match.js):
// - a statement of several rows whose ids are generated reports the first id,
//   in insertId and in LAST_INSERT_ID(); SQLite gives the last
// - ON DUPLICATE KEY UPDATE: inserted 1, changed 2, found and unchanged 1
//   (SQLite updated the row anyway and the engine said 2)
// Rules are keyed on the statement's shape; the tables here are made up.
// Usage: node tests/repro/write_counts.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-writecounts-'));
const mariaFile = path.join(dir, 'maria.sqlite');
new DatabaseSync(mariaFile).close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;

const fx = require('../harness/fx.js');
const r = fx.registry;
const call = (k, sql, p) => new Promise((res) => r[k](sql, p || [], (v, err) => res(err ? { err } : v), 'test', true));

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const hdr = (h) => (h && h.err ? 'err ' + h.err : h && h.affectedRows + '/' + h.insertId);

(async () => {
    await fx.ready(20000);
    await call('query', 'CREATE TABLE job_grades (id INT NOT NULL AUTO_INCREMENT, job_name VARCHAR(50), grade INT, PRIMARY KEY (id), UNIQUE KEY jg (job_name, grade))');
    await call('query', "INSERT INTO job_grades (job_name, grade) VALUES ('a', 0)");

    // Multi-row insert: the corpus sample (literal rows), params, IGNORE with a
    // duplicate, INSERT ... SELECT, and the insert export.
    let h = await call('query', "INSERT INTO job_grades (job_name, grade) VALUES ('b',0),('b',1),('b',2)");
    check('multi-row VALUES reports the first id', h.affectedRows === 3 && h.insertId === 2, hdr(h));
    const last = await call('scalar', 'SELECT LAST_INSERT_ID()');
    check('LAST_INSERT_ID() after it is the first id too', Number(last) === 2, JSON.stringify(last));
    h = await call('query', 'INSERT INTO job_grades (job_name, grade) VALUES (?, ?), (?, ?)', ['c', 0, 'c', 1]);
    check('multi-row with params reports the first id', h.affectedRows === 2 && h.insertId === 5, hdr(h));
    // Which ids a skipped row spends is the allocator's business (InnoDB and
    // SQLite differ); the id reported is the first row actually inserted.
    const idOf = async (job, grade) => Number(await call('scalar', 'SELECT id FROM job_grades WHERE job_name = ? AND grade = ?', [job, grade]));
    h = await call('query', "INSERT IGNORE INTO job_grades (job_name, grade) VALUES ('c',1),('d',0),('d',1)");
    check('multi-row IGNORE skips the duplicate, reports the first new id', h.affectedRows === 2 && h.insertId === await idOf('d', 0), hdr(h));
    h = await call('query', "INSERT INTO job_grades (job_name, grade) SELECT 'e', grade FROM job_grades WHERE job_name = 'b'");
    check('INSERT ... SELECT of several rows reports the first id', h.affectedRows === 3 && h.insertId === 10, hdr(h));
    const ins = await call('insert', "INSERT INTO job_grades (job_name, grade) VALUES ('f',0),('f',1)");
    check('insert export of several rows returns the first id', ins === 13, JSON.stringify(ins));
    h = await call('query', 'INSERT INTO job_grades (job_name, grade) VALUES (?, ?)', ['g', 0]);
    check('one row still reports its own id', h.affectedRows === 1 && h.insertId === 15, hdr(h));
    h = await call('query', "INSERT INTO job_grades (id, job_name, grade) VALUES (40, 'h', 0), (41, 'h', 1)");
    check('rows with their ids given keep the last-id answer', h.affectedRows === 2 && h.insertId === 41, hdr(h));

    // ODKU: the corpus sample (VALUES(col)), a constant, a qualified target,
    // a case-only change (a change for MariaDB), and one with a ? it cannot guard.
    await call('query', 'CREATE TABLE slots (identifier VARCHAR(60) PRIMARY KEY, slots INT, note VARCHAR(20))');
    const up = (p) => call('query', 'INSERT INTO `slots` (`identifier`, `slots`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `slots` = VALUES(`slots`)', p);
    check('ODKU new row counts 1', (await up(['x', 1])).affectedRows === 1);
    check('ODKU changed row counts 2', (await up(['x', 2])).affectedRows === 2);
    check('ODKU unchanged row counts 1', (await up(['x', 2])).affectedRows === 1);
    const v = await call('scalar', "SELECT slots FROM slots WHERE identifier = 'x'");
    check('ODKU kept the value', Number(v) === 2, JSON.stringify(v));
    h = await call('query', "INSERT INTO slots (identifier, slots, note) VALUES ('x', 9, 'n') ON DUPLICATE KEY UPDATE slots = 2");
    check('ODKU constant assignment, unchanged, counts 1', h.affectedRows === 1, hdr(h));
    h = await call('query', "INSERT INTO job_grades (job_name, grade) VALUES ('a', 0) ON DUPLICATE KEY UPDATE id = id");
    check('ODKU id = id (insert-or-keep) counts 1', h.affectedRows === 1, hdr(h));
    h = await call('query', "INSERT INTO slots (identifier, slots, note) VALUES ('x', 3, 'n') ON DUPLICATE KEY UPDATE slots.slots = VALUES(slots), note = VALUES(note)");
    check('ODKU qualified target, changed, counts 2', h.affectedRows === 2, hdr(h));
    h = await call('query', "INSERT INTO slots (identifier, slots, note) VALUES ('x', 3, 'N') ON DUPLICATE KEY UPDATE note = VALUES(note)");
    const note = await call('scalar', "SELECT note FROM slots WHERE identifier = 'x'");
    check('ODKU case-only change is a change (2, value written)', h.affectedRows === 2 && note === 'N', hdr(h) + ' ' + note);
    h = await call('update', 'INSERT INTO slots (identifier, slots) VALUES (?, ?) ON DUPLICATE KEY UPDATE slots = ?', ['x', 0, 4]);
    check('ODKU with a ? in the assignment still updates', h === 2 && Number(await call('scalar', "SELECT slots FROM slots WHERE identifier = 'x'")) === 4, JSON.stringify(h));
    // The corpus sample (qbx_core player_groups: `grade = ?`), unchanged and
    // changed, and variants: several ? assignments, a ? inside an expression,
    // a ? mixed with VALUES(col), and a ? in a string that is not a mark.
    h = await call('query', 'INSERT INTO slots (identifier, slots) VALUES (?, ?) ON DUPLICATE KEY UPDATE slots = ?', ['x', 0, 4]);
    check('ODKU slots = ?, unchanged, counts 1', h.affectedRows === 1, hdr(h));
    h = await call('query', 'INSERT INTO slots (identifier, slots, note) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE slots = ?, note = ?', ['x', 0, '', 4, 'N']);
    check('ODKU several ? assignments, unchanged, counts 1', h.affectedRows === 1, hdr(h));
    h = await call('query', 'INSERT INTO slots (identifier, slots, note) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE slots = ?, note = ?', ['x', 0, '', 4, 'm']);
    const n2 = await call('scalar', "SELECT note FROM slots WHERE identifier = 'x'");
    check('ODKU several ? assignments, one changed, counts 2 and writes it', h.affectedRows === 2 && n2 === 'm', hdr(h) + ' ' + n2);
    h = await call('query', 'INSERT INTO slots (identifier, slots) VALUES (?, ?) ON DUPLICATE KEY UPDATE slots = slots + ?', ['x', 0, 0]);
    check('ODKU slots = slots + ? adding 0 counts 1', h.affectedRows === 1, hdr(h));
    h = await call('query', 'INSERT INTO slots (identifier, slots) VALUES (?, ?) ON DUPLICATE KEY UPDATE slots = slots + ?', ['x', 0, 3]);
    const s3 = await call('scalar', "SELECT slots FROM slots WHERE identifier = 'x'");
    check('ODKU slots = slots + ? adding 3 counts 2 and adds once', h.affectedRows === 2 && Number(s3) === 7, hdr(h) + ' ' + s3);
    h = await call('query', "INSERT INTO slots (identifier, slots, note) VALUES (?, ?, 'x?') ON DUPLICATE KEY UPDATE slots = VALUES(slots), note = ?", ['x', 7, 'm']);
    check('ODKU VALUES(col) with a ? beside it, and a ? in a string, unchanged, counts 1', h.affectedRows === 1, hdr(h));
    h = await call('query', 'INSERT INTO slots (identifier, slots) VALUES (?, ?) ON DUPLICATE KEY UPDATE slots = ?', ['y', 5, 9]);
    const s4 = await call('scalar', "SELECT slots FROM slots WHERE identifier = 'y'");
    check('ODKU slots = ? on a new row inserts it (1, the VALUES value)', h.affectedRows === 1 && Number(s4) === 5, hdr(h) + ' ' + s4);

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' failed' : 'all passed');
    process.exit(failed ? 1 : 0);
})();
