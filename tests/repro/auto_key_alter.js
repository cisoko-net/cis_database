'use strict';

// A key numbered by ALTER TABLE, and a key nobody numbers. A phpMyAdmin dump
// creates the table bare, then ADD PRIMARY KEY (id) and MODIFY id ...
// AUTO_INCREMENT, AUTO_INCREMENT=14; qb-vault adds id and then MODIFY id ...
// AUTO_INCREMENT PRIMARY KEY. Before, the column stayed a plain one: an INSERT
// that left it out failed ("Field 'id' doesn't have a default value"). And an
// INT PRIMARY KEY with no AUTO_INCREMENT (cdn-fuel's location) reported
// SQLite's rowid as insert id, where MariaDB reports 0. The rules key on the
// clauses and the declared key; the tables here are made up.
// Usage: node tests/repro/auto_key_alter.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-autokey-'));
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
    // The dump: bare table, rows with ids, then the key and the counter.
    await call('query', 'CREATE TABLE `packs` (`id` int(11) NOT NULL, `name` varchar(50) NOT NULL, `got` tinyint(1) NOT NULL)');
    await call('query', "INSERT INTO `packs` (`id`, `name`, `got`) VALUES (3, 'a', 1), (9, 'b', 0)");
    await call('query', 'ALTER TABLE `packs` ADD PRIMARY KEY (`id`)');
    let h = await call('query', 'ALTER TABLE `packs` MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=14');
    check('MODIFY ... AUTO_INCREMENT, AUTO_INCREMENT=14 runs', !(h && h.err), JSON.stringify(h));
    let id = await call('insert', "INSERT INTO packs (name, got) VALUES ('c', 1)");
    check('an INSERT that leaves id out gets 14 (the dump sample)', id === 14, JSON.stringify(id));
    h = await call('query', "INSERT INTO packs (name, got) VALUES ('d', 0)");
    check('the next is 15, in the header too', h && h.insertId === 15, JSON.stringify(h));
    const rows = await call('query', 'SELECT id, name FROM packs ORDER BY id');
    check('the rows it had keep their ids', JSON.stringify(rows.map((x) => x.id)) === '[3,9,14,15]', JSON.stringify(rows));
    h = await call('query', "INSERT INTO packs (id, name, got) VALUES (9, 'dup', 0)");
    check('the key still refuses a duplicate', !!(h && h.err), JSON.stringify(h));
    const col = await call('query', "SELECT extra FROM information_schema.columns WHERE table_name = 'packs' AND column_name = 'id'");
    check('information_schema says auto_increment', col[0] && /auto_increment/i.test(String(col[0].extra || col[0].EXTRA)), JSON.stringify(col));

    // Variant: added later, then made the key in one MODIFY; rows numbered in order.
    await call('query', 'CREATE TABLE `safes` (`owner` varchar(20) NOT NULL, `code` varchar(10) NOT NULL)');
    await call('query', "INSERT INTO safes VALUES ('A', '1'), ('B', '2')");
    await call('query', 'ALTER TABLE `safes` ADD COLUMN `id` int(11) AFTER `owner`');
    h = await call('query', 'ALTER TABLE `safes` MODIFY `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY');
    check('MODIFY ... AUTO_INCREMENT PRIMARY KEY runs', !(h && h.err), JSON.stringify(h));
    const sf = await call('query', 'SELECT * FROM safes ORDER BY id');
    check('the rows there are numbered 1, 2 and the column stays where it was', JSON.stringify(sf) === '[{"owner":"A","id":1,"code":"1"},{"owner":"B","id":2,"code":"2"}]', JSON.stringify(sf));
    id = await call('insert', "INSERT INTO safes (owner, code) VALUES ('C', '3')");
    check('the next insert gets 3', id === 3, JSON.stringify(id));

    // Variant: ADD COLUMN ... AUTO_INCREMENT PRIMARY KEY in one clause, on a
    // table whose primary key was another column: that key stays unique.
    await call('query', 'CREATE TABLE `cards` (`code` varchar(10) NOT NULL PRIMARY KEY, `n` int)');
    await call('query', "INSERT INTO cards VALUES ('x', 1), ('y', 2)");
    h = await call('query', 'ALTER TABLE `cards` ADD `id` INT NOT NULL AUTO_INCREMENT UNIQUE FIRST');
    check('ADD ... AUTO_INCREMENT UNIQUE FIRST runs', !(h && h.err), JSON.stringify(h));
    const cd = await call('query', 'SELECT * FROM cards ORDER BY id');
    check('rows numbered, column first', JSON.stringify(cd) === '[{"id":1,"code":"x","n":1},{"id":2,"code":"y","n":2}]', JSON.stringify(cd));
    h = await call('query', "INSERT INTO cards (code, n) VALUES ('x', 9)");
    check('the old primary key still refuses a duplicate', !!(h && h.err), JSON.stringify(h));
    id = await call('insert', "INSERT INTO cards (code, n) VALUES ('z', 3)");
    check('and an insert gets id 3', id === 3, JSON.stringify(id));

    // An INT PRIMARY KEY no one numbers: insert id 0, LAST_INSERT_ID() unchanged.
    await call('query', 'CREATE TABLE `stations` (`location` int(11) NOT NULL, `label` varchar(30), PRIMARY KEY (`location`))');
    h = await call('query', "INSERT INTO `stations` (`location`, `label`) VALUES (4, 'Little Seoul')");
    check('INT PRIMARY KEY without AUTO_INCREMENT: insertId 0 (the cdn-fuel sample)', h && h.insertId === 0, JSON.stringify(h));
    id = await call('insert', "INSERT INTO stations (location, label) VALUES (5, 'Strawberry')");
    check('insert gives 0 too', id === 0, JSON.stringify(id));
    const last = await call('scalar', 'SELECT LAST_INSERT_ID()');
    check('LAST_INSERT_ID() is still the last numbered id', Number(last) === 3, JSON.stringify(last));
    await call('query', 'CREATE TABLE `marks` (`id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY, `v` INT)');
    id = await call('insert', 'INSERT INTO marks (v) VALUES (1)');
    check('a table created with AUTO_INCREMENT still reports its id', id === 1, JSON.stringify(id));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' failed' : 'all passed');
    process.exit(failed ? 1 : 0);
})();
