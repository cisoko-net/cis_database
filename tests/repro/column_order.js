'use strict';

// ALTER TABLE ... FIRST / AFTER x places the column where MariaDB puts it.
// SELECT * then lists the columns in MariaDB's order, and an INSERT ... VALUES
// without a column list fills them in that order (qbx_core adds players.userId
// AFTER id; ESX scripts add columns AFTER one of users'). The rule keys on the
// clause; the tables here are made up. What the table had stays: its rows,
// indexes, keys pointing at it, its ON UPDATE column and its id sequence.
// Usage: node tests/repro/column_order.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-colorder-'));
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
const keys = async (t) => {
    const rows = await call('query', 'SELECT * FROM ' + t + ' LIMIT 1');
    return rows && rows.err ? 'err ' + rows.err : Object.keys(rows[0] || {}).join(',');
};
const ordinal = async (t) => {
    const rows = await call('query', 'SELECT column_name AS c FROM information_schema.columns WHERE table_name = ? ORDER BY ordinal_position', [t]);
    return rows && rows.err ? 'err ' + rows.err : rows.map((x) => x.c || x.COLUMN_NAME).join(',');
};

(async () => {
    await fx.ready(20000);
    await call('query', 'CREATE TABLE owners (id INT NOT NULL AUTO_INCREMENT, citizenid VARCHAR(20) NOT NULL, name VARCHAR(40), '
        + 'updated TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (id), UNIQUE KEY cid (citizenid))');
    await call('query', 'CREATE TABLE cars (id INT NOT NULL AUTO_INCREMENT, citizenid VARCHAR(20), plate VARCHAR(8), PRIMARY KEY (id), '
        + 'CONSTRAINT fk_cars FOREIGN KEY (citizenid) REFERENCES owners (citizenid) ON DELETE CASCADE)');
    await call('query', "INSERT INTO owners (citizenid, name) VALUES ('A1', 'ann'), ('B2', 'bob'), ('C3', 'cid')");
    await call('query', "DELETE FROM owners WHERE citizenid = 'C3'");
    await call('query', "INSERT INTO cars (citizenid, plate) VALUES ('A1', 'P1'), ('B2', 'P2')");

    // The corpus sample: ADD COLUMN IF NOT EXISTS ... AFTER id.
    let h = await call('query', 'ALTER TABLE owners ADD COLUMN IF NOT EXISTS userId INT UNSIGNED DEFAULT NULL AFTER id');
    check('ADD ... AFTER runs', !(h && h.err), h && h.err);
    check('ADD ... AFTER id: SELECT * lists it second', await keys('owners') === 'id,userId,citizenid,name,updated', await keys('owners'));
    check('information_schema gives the same order', await ordinal('owners') === 'id,userId,citizenid,name,updated', await ordinal('owners'));
    // Variant: FIRST.
    await call('query', "ALTER TABLE owners ADD COLUMN tag VARCHAR(5) NOT NULL DEFAULT 'x' FIRST");
    check('ADD ... FIRST lists it first', await keys('owners') === 'tag,id,userId,citizenid,name,updated', await keys('owners'));
    // Variant: several clauses in one ALTER, one AFTER a column the ALTER added.
    await call('query', 'ALTER TABLE owners ADD COLUMN a1 INT AFTER citizenid, ADD COLUMN a2 INT AFTER a1, ADD COLUMN a3 INT');
    check('several ADD ... AFTER in one ALTER', await keys('owners') === 'tag,id,userId,citizenid,a1,a2,name,updated,a3', await keys('owners'));
    // Variant: MODIFY and CHANGE move a column that is there.
    await call('query', 'ALTER TABLE owners MODIFY COLUMN a3 INT AFTER tag');
    check('MODIFY ... AFTER moves it', await keys('owners') === 'tag,a3,id,userId,citizenid,a1,a2,name,updated', await keys('owners'));
    await call('query', 'ALTER TABLE owners CHANGE COLUMN a2 b2 INT FIRST');
    check('CHANGE ... FIRST renames and moves it', await keys('owners') === 'b2,tag,a3,id,userId,citizenid,a1,name,updated', await keys('owners'));
    await call('query', 'ALTER TABLE owners DROP COLUMN b2, DROP COLUMN a3, DROP COLUMN a1, DROP COLUMN tag');

    // What the table had stays.
    const rows = await call('query', 'SELECT id, citizenid, name FROM owners ORDER BY id');
    check('the rows stay', JSON.stringify(rows) === '[{"id":1,"citizenid":"A1","name":"ann"},{"id":2,"citizenid":"B2","name":"bob"}]', JSON.stringify(rows));
    h = await call('query', "INSERT INTO owners (citizenid, name) VALUES ('A1', 'dup')");
    check('the unique key still refuses a duplicate', !!(h && h.err), JSON.stringify(h));
    // Positional INSERT: values land in MariaDB's order.
    h = await call('query', "INSERT INTO owners VALUES (NULL, 7, 'D4', 'dee', NULL)");
    const d4 = (await call('query', "SELECT id, userId, name FROM owners WHERE citizenid = 'D4'"))[0];
    check('INSERT VALUES without a column list fills in MariaDB order', d4 && d4.userId === 7 && d4.name === 'dee', JSON.stringify(d4));
    check('the id sequence keeps its gap', d4 && d4.id === 4 && h.insertId === 4, JSON.stringify(d4) + ' ' + (h && h.insertId));
    await call('query', "UPDATE owners SET name = 'ann2' WHERE citizenid = 'A1'");
    const up = await call('scalar', "SELECT updated FROM owners WHERE citizenid = 'A1'");
    check('the ON UPDATE column still stamps', typeof up === 'number' && Math.abs(up - Date.now()) < 10000, JSON.stringify(up));
    const cars = await call('scalar', 'SELECT COUNT(*) FROM cars');
    check('the rows of the table keyed on it stay', Number(cars) === 2, JSON.stringify(cars));
    await call('query', "DELETE FROM owners WHERE citizenid = 'B2'");
    const left = await call('query', 'SELECT plate FROM cars ORDER BY id');
    check('its key still cascades', JSON.stringify(left) === '[{"plate":"P1"}]', JSON.stringify(left));
    h = await call('query', "INSERT INTO cars (citizenid, plate) VALUES ('NOBODY', 'P9')");
    check('its key still refuses a missing owner', !!(h && h.err), JSON.stringify(h));

    // Inside a transaction foreign_keys cannot be turned off: a table other
    // keys point at keeps SQLite's order and every row of both tables.
    const tx = await new Promise((res) => r.transaction(['ALTER TABLE owners ADD COLUMN z INT FIRST'], [], (v, err) => res(err ? { err } : v)));
    check('in a transaction the ALTER still runs', tx === true || !(tx && tx.err), JSON.stringify(tx));
    check('in a transaction a keyed table keeps its rows and those keyed on it',
        Number(await call('scalar', 'SELECT COUNT(*) FROM owners')) === 2 && Number(await call('scalar', 'SELECT COUNT(*) FROM cars')) === 1);
    // A table no key points at moves in a transaction too; a generated column
    // and a column added with a time default keep their values.
    await call('query', 'CREATE TABLE logs (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, msg VARCHAR(20), len INT AS (LENGTH(msg)) VIRTUAL)');
    await call('query', "INSERT INTO logs (msg) VALUES ('hello'), ('hi')");
    await call('query', 'ALTER TABLE logs ADD COLUMN at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER id');
    check('a time-default column added AFTER id', await keys('logs') === 'id,at,msg,len', await keys('logs'));
    const lg = await call('query', 'SELECT msg, len, at FROM logs ORDER BY id');
    check('the generated column and the filled default keep their values', lg.length === 2 && lg[0].len === 5 && lg[1].len === 2
        && typeof lg[0].at === 'number', JSON.stringify(lg));
    await call('query', "INSERT INTO logs (msg) VALUES ('new')");
    const nw = (await call('query', "SELECT at, len FROM logs WHERE msg = 'new'"))[0];
    check('a later INSERT still gets the time default', nw && typeof nw.at === 'number' && nw.len === 3, JSON.stringify(nw));
    await new Promise((res) => r.transaction(['ALTER TABLE logs MODIFY msg VARCHAR(30) FIRST'], [], () => res()));
    check('in a transaction a table no key points at moves', await keys('logs') === 'msg,id,at,len', await keys('logs'));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' failed' : 'all passed');
    process.exit(failed ? 1 : 0);
})();
