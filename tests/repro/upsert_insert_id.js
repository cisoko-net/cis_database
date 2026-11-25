'use strict';

// The insert id of INSERT ... ON DUPLICATE KEY UPDATE that updated. MariaDB
// 10.11 reports the AUTO_INCREMENT id of the row it found when the update
// changed it, 0 when the row kept its values, and leaves LAST_INSERT_ID() as
// it was (checked on 10.11.19). The engine reported 0 for every update, so a
// script that reads the id back (murderface-pets, a phone's reviews) got 0.
// Every number here is what 10.11.19 gave for the same statements. The rule keys on the table's AUTO_INCREMENT key; the tables here are made up.
// Usage: node tests/repro/upsert_insert_id.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-upsertid-'));
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

(async () => {
    await fx.ready(20000);
    await call('query', 'CREATE TABLE `pets` (`pet_id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY, `owner` VARCHAR(20) NOT NULL, `name` VARCHAR(20) NOT NULL, `hp` INT, UNIQUE KEY `one` (`owner`, `name`))');
    await call('query', "INSERT INTO pets (owner, name, hp) VALUES ('a', 'rex', 1), ('a', 'max', 1), ('b', 'rex', 1)");
    let h = await call('query', "INSERT INTO pets (owner, name, hp) VALUES ('a', 'max', 5) ON DUPLICATE KEY UPDATE hp = VALUES(hp)");
    check('an update that changed the row reports its id (2), affected 2', h && h.insertId === 2 && h.affectedRows === 2, JSON.stringify(h));
    h = await call('query', "INSERT INTO pets (owner, name, hp) VALUES ('a', 'max', 5) ON DUPLICATE KEY UPDATE hp = VALUES(hp)");
    check('an update that kept the values reports 0, affected 1', h && h.insertId === 0 && h.affectedRows === 1, JSON.stringify(h));
    let id = await call('insert', 'INSERT INTO pets (owner, name, hp) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE hp = ?', ['b', 'rex', 7, 7]);
    check('insert with ? in the update part gives the found id (3)', id === 3, JSON.stringify(id));
    h = await call('query', "INSERT INTO pets (owner, name, hp) VALUES ('c', 'odin', 1) ON DUPLICATE KEY UPDATE hp = VALUES(hp)");
    check('a new row reports its own id: 7, the conflicts spent 4 to 6 as InnoDB does', h && h.insertId === 7 && h.affectedRows === 1, JSON.stringify(h));
    await call('query', "INSERT INTO pets (owner, name, hp) VALUES ('a', 'rex', 9) ON DUPLICATE KEY UPDATE hp = VALUES(hp)");
    const last = await call('scalar', 'SELECT LAST_INSERT_ID()');
    check('LAST_INSERT_ID() stays the last inserted id', Number(last) === 7, JSON.stringify(last));
    const rows = await call('query', 'SELECT pet_id, hp FROM pets ORDER BY pet_id');
    check('the rows hold the updates', JSON.stringify(rows) === '[{"pet_id":1,"hp":9},{"pet_id":2,"hp":5},{"pet_id":3,"hp":7},{"pet_id":7,"hp":1}]', JSON.stringify(rows));

    // A table keyed by name: MariaDB has no id to give.
    await call('query', 'CREATE TABLE `stash` (`label` VARCHAR(20) NOT NULL PRIMARY KEY, `n` INT)');
    await call('query', "INSERT INTO stash VALUES ('x', 1)");
    h = await call('query', "INSERT INTO stash VALUES ('x', 2) ON DUPLICATE KEY UPDATE n = VALUES(n)");
    check('no AUTO_INCREMENT key: insert id 0, affected 2', h && h.insertId === 0 && h.affectedRows === 2, JSON.stringify(h));

    // A string in the update that looks like a WHERE is left alone.
    await call('query', 'CREATE TABLE `notes` (`id` INT AUTO_INCREMENT PRIMARY KEY, `k` VARCHAR(10) UNIQUE, `t` VARCHAR(40))');
    await call('query', "INSERT INTO notes (k, t) VALUES ('q', 'old')");
    h = await call('query', "INSERT INTO notes (k, t) VALUES ('q', 'a WHERE b') ON DUPLICATE KEY UPDATE t = VALUES(t)");
    const t = await call('scalar', "SELECT t FROM notes WHERE k = 'q'");
    check('a quoted WHERE in the values: id 1, value stored', h && h.insertId === 1 && t === 'a WHERE b', JSON.stringify([h, t]));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' failed' : 'all passed');
    process.exit(failed ? 1 : 0);
})();
