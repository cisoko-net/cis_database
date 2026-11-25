'use strict';

// MySQL DDL as resources send it, run through the engine: CREATE TABLE with
// the clauses MariaDB dumps and framework installers carry, ALTER TABLE with
// several clauses, ON UPDATE CURRENT_TIMESTAMP, and hydration of the same
// from MariaDB. Every expected value is what MariaDB does with the statement.
// Usage: node tests/repro/ddl.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-ddl-'));
    const mariaFile = path.join(dir, 'maria.sqlite');
    const m = new DatabaseSync(mariaFile);
    // qb-core players: AUTO_INCREMENT id beside PRIMARY KEY (citizenid), and
    // an ON UPDATE column. A house table with an expression default.
    m.exec(`PRAGMA foreign_keys = OFF;
        CREATE TABLE players (id INTEGER, citizenid TEXT NOT NULL PRIMARY KEY, name TEXT, last_updated TEXT);
        INSERT INTO players VALUES (7, 'ABC', 'old', '2020-01-01 00:00:00');
        CREATE TABLE houses (id INTEGER PRIMARY KEY, has_access TEXT);
        CREATE TABLE job_groups (name TEXT PRIMARY KEY, label TEXT);
        CREATE TABLE job_members (id INTEGER PRIMARY KEY, grp TEXT REFERENCES job_groups (name) ON DELETE CASCADE ON UPDATE CASCADE);
        INSERT INTO job_groups VALUES ('police', 'LSPD');
        INSERT INTO job_members (grp) VALUES ('police'), ('police');
        CREATE TABLE crew (grp TEXT, member TEXT, PRIMARY KEY (grp, member));
        CREATE TABLE crew_notes (grp TEXT REFERENCES crew (grp) ON DELETE CASCADE, note TEXT);
        INSERT INTO crew VALUES ('a', 'x'), ('a', 'y');
        INSERT INTO crew_notes VALUES ('a', 'n');
        CREATE TABLE accts (account_name TEXT, owner TEXT, owner_key TEXT);
        INSERT INTO accts VALUES ('cash', NULL, '');
        CREATE TABLE fake_columns (table_name TEXT, column_name TEXT, extra TEXT, column_default TEXT, generation_expression TEXT);
        INSERT INTO fake_columns (table_name, column_name, extra, column_default) VALUES ('players', 'id', 'auto_increment', NULL),
            ('players', 'last_updated', 'on update current_timestamp()', 'current_timestamp()'),
            ('houses', 'has_access', '', 'json_array()');
        INSERT INTO fake_columns VALUES ('accts', 'owner_key', 'STORED GENERATED', NULL, 'coalesce(\`owner\`,'''')');
    `);
    m.close();
    process.env.FX_RES_DIR = dir;
    process.env.FX_MARIA_FILE = mariaFile;
    const fx = require('../harness/fx.js');
    const r = fx.registry;
    const call = (k, sql, p) => new Promise((res) => r[k](sql, p || [], (v, err) => res({ v: err ? false : v, err }), 'test', true));
    const val = async (sql, p) => (await call('scalar', sql, p)).v;
    const ok = (x) => x.err == null && x.v !== false;
    await fx.ready(20000);

    // Hydrated from MariaDB
    const ins = await call('insert', "INSERT INTO players (citizenid, name) VALUES ('NEW', 'n')");
    check('hydrate: the AUTO_INCREMENT id that is not the primary key is numbered', ins.v === 8, JSON.stringify(ins));
    const dup = await call('insert', "INSERT INTO players (citizenid, name) VALUES ('ABC', 'again')");
    check('hydrate: the primary key it stands beside stays unique', dup.v === false, JSON.stringify(dup));
    await call('update', "UPDATE players SET name = 'renamed' WHERE citizenid = 'ABC'");
    const stamped = await val("SELECT last_updated FROM players WHERE citizenid = 'ABC'");
    check('hydrate: ON UPDATE CURRENT_TIMESTAMP stamps the row when another column changes', stamped !== '2020-01-01 00:00:00' && Math.abs(Date.parse(String(stamped).replace(' ', 'T')) - Date.now()) < 10000, stamped);
    await call('update', "UPDATE players SET last_updated = '2020-01-01 00:00:00' WHERE citizenid = 'ABC'");
    check('... but not when the statement sets the column itself', await val("SELECT last_updated FROM players WHERE citizenid = 'ABC'") === '2020-01-01 00:00:00');
    await call('update', "UPDATE players SET name = 'renamed' WHERE citizenid = 'ABC'");
    check('... nor when no value changes', await val("SELECT last_updated FROM players WHERE citizenid = 'ABC'") === '2020-01-01 00:00:00');
    await call('insert', 'INSERT INTO houses (id) VALUES (1)');
    check('hydrate: an expression default (json_array()) fills a column the INSERT leaves out', await val('SELECT has_access FROM houses WHERE id = 1') === '[]');

    await call('update', "UPDATE job_groups SET name = 'lspd' WHERE name = 'police'");
    check('hydrate: a foreign key ON UPDATE CASCADE follows the parent', await val("SELECT COUNT(*) FROM job_members WHERE grp = 'lspd'") === 2);
    const orphan = await call('insert', "INSERT INTO job_members (grp) VALUES ('nope')");
    check('hydrate: a row MariaDB would refuse for its foreign key is refused', orphan.v === false, JSON.stringify(orphan));
    const crewOrphan = await call('insert', "INSERT INTO crew_notes (grp, note) VALUES ('zz', 'n')");
    await call('update', "DELETE FROM crew WHERE grp = 'a' AND member = 'x'");
    check('hydrate: a foreign key to part of a primary key refuses orphans and cascades per parent row, as InnoDB does',
        crewOrphan.v === false && await val('SELECT COUNT(*) FROM crew_notes') === 0, JSON.stringify(crewOrphan));
    await call('insert', "INSERT INTO accts (account_name, owner) VALUES ('bank', NULL), ('black', 'char1:abc')");
    const keys = await call('query', 'SELECT account_name, owner_key FROM accts ORDER BY account_name', []);
    check('hydrate: a generated column (esx owner_key) is computed for rows written after hydration',
        JSON.stringify(keys.v) === '[{"account_name":"bank","owner_key":""},{"account_name":"black","owner_key":"char1:abc"},{"account_name":"cash","owner_key":""}]',
        JSON.stringify(keys));
    const ignored = await call('query', "INSERT IGNORE INTO job_members (grp) VALUES ('nope')");
    const ignoredMany = await call('query', "INSERT IGNORE INTO job_members (grp) VALUES ('nope'), ('lspd')");
    check('INSERT IGNORE of one row with a missing parent skips it, as MariaDB does; several rows still fail',
        ignored.v && ignored.v.affectedRows === 0 && ignoredMany.v === false, JSON.stringify([ignored, ignoredMany]));
    await call('update', "DELETE FROM job_groups WHERE name = 'lspd'");
    check('hydrate: ON DELETE CASCADE removes the children', await val('SELECT COUNT(*) FROM job_members') === 0);

    // CREATE TABLE as ox_core writes it
    const chars = await call('query', "CREATE TABLE IF NOT EXISTS `characters` ( `charId` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, `citizenid` VARCHAR(50) NOT NULL, `firstName` VARCHAR(50) NOT NULL, `lastName` VARCHAR(50) NOT NULL, `fullName` VARCHAR(101) AS (CONCAT(`firstName`, ' ', `lastName`)) STORED, `statuses` LONGTEXT COLLATE utf8mb4_bin DEFAULT JSON_OBJECT() NOT NULL CHECK (JSON_VALID(`statuses`)), `lastPlayed` DATETIME DEFAULT CURRENT_TIMESTAMP() NOT NULL, UNIQUE KEY `characters_citizenid_unique` (`citizenid`), CONSTRAINT `characters_players_fk` FOREIGN KEY (`citizenid`) REFERENCES `players` (`citizenid`) ON UPDATE CASCADE ON DELETE CASCADE ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    check('ox_core characters: generated column, JSON default, CHECK, UNIQUE KEY, FOREIGN KEY', ok(chars), JSON.stringify(chars));
    await call('insert', "INSERT INTO characters (citizenid, firstName, lastName) VALUES ('ABC', 'Jo', 'Doe')");
    const ch = (await call('single', "SELECT fullName, statuses FROM characters WHERE citizenid = 'ABC'")).v;
    check('... the generated column and the JSON_OBJECT() default', ch && ch.fullName === 'Jo Doe' && ch.statuses === '{}', JSON.stringify(ch));
    const badJson = await call('update', "UPDATE characters SET statuses = 'not json' WHERE citizenid = 'ABC'");
    check('... CHECK (JSON_VALID) refuses what MariaDB refuses', badJson.v === false, JSON.stringify(badJson));
    await call('update', "DELETE FROM players WHERE citizenid = 'ABC'");
    check('... ON DELETE CASCADE follows the parent', await val("SELECT COUNT(*) FROM characters WHERE citizenid = 'ABC'") === 0);

    // ps-mdt: a foreign key to a column with only a plain index
    await call('query', 'CREATE TABLE IF NOT EXISTS `mdt_penal_codes` ( `code` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL, `label` varchar(100) NOT NULL, PRIMARY KEY (`code`), KEY `label` (`label`) ) ENGINE=InnoDB');
    const charges = await call('query', 'CREATE TABLE IF NOT EXISTS `mdt_reports_charges` ( `reportid` int(10) unsigned NOT NULL, `charge` varchar(100) DEFAULT NULL, KEY `charge` (`charge`), CONSTRAINT `fk_charge` FOREIGN KEY (`charge`) REFERENCES `mdt_penal_codes` (`label`) ON DELETE CASCADE ON UPDATE CASCADE ) ENGINE=InnoDB');
    const pc = await call('insert', "INSERT INTO mdt_penal_codes (code, label) VALUES ('P.C. 1001', 'Simple Assault')");
    const rc = await call('insert', "INSERT INTO mdt_reports_charges (reportid, charge) VALUES (1, 'Simple Assault')");
    check('ps-mdt: a foreign key to a non-unique column leaves both tables writable', ok(charges) && ok(pc) && ok(rc), JSON.stringify([charges, pc, rc]));
    const rcBad = await call('insert', "INSERT INTO mdt_reports_charges (reportid, charge) VALUES (2, 'No Such Charge')");
    const rcNull = await call('insert', 'INSERT INTO mdt_reports_charges (reportid, charge) VALUES (3, NULL)');
    await call('update', "UPDATE mdt_penal_codes SET label = 'Assault' WHERE code = 'P.C. 1001'");
    const followed = await val('SELECT charge FROM mdt_reports_charges WHERE reportid = 1');
    await call('update', "DELETE FROM mdt_penal_codes WHERE code = 'P.C. 1001'");
    check('... and keeps it: orphans refused, NULL allowed, ON UPDATE and ON DELETE CASCADE follow',
        rcBad.v === false && ok(rcNull) && followed === 'Assault' && await val('SELECT COUNT(*) FROM mdt_reports_charges') === 1,
        JSON.stringify([rcBad, rcNull, followed]));
    // ox_mdt: reports -> criminals (declared) -> charges (by the first column of criminals' key)
    await call('query', 'CREATE TABLE ox_r (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, title VARCHAR(50))');
    await call('query', 'CREATE TABLE ox_rc (reportid INT UNSIGNED NOT NULL, stateid VARCHAR(7) NOT NULL, PRIMARY KEY (reportid, stateid), FOREIGN KEY (reportid) REFERENCES ox_r (id) ON DELETE CASCADE)');
    await call('query', 'CREATE TABLE ox_ch (reportid INT UNSIGNED NOT NULL, stateid VARCHAR(7) NOT NULL, charge VARCHAR(20), KEY (reportid), CONSTRAINT a FOREIGN KEY (reportid) REFERENCES ox_rc (reportid) ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT b FOREIGN KEY (stateid) REFERENCES ox_rc (stateid) ON DELETE CASCADE ON UPDATE CASCADE)');
    await call('insert', "INSERT INTO ox_r (title) VALUES ('t')");
    await call('insert', "INSERT INTO ox_rc VALUES (1, 'A'), (1, 'B')");
    await call('insert', "INSERT INTO ox_ch VALUES (1, 'A', 'x')");
    await call('update', 'DELETE FROM ox_r WHERE id = 1');
    check('ox_mdt: deleting a report cascades through criminals to charges', await val('SELECT COUNT(*) FROM ox_ch') === 0);
    // A RESTRICT key to a non-unique column refuses the parent delete.
    await call('query', 'CREATE TABLE ox_hold (stateid VARCHAR(7), FOREIGN KEY (stateid) REFERENCES ox_rc (stateid))');
    await call('insert', "INSERT INTO ox_r (id, title) VALUES (2, 'u')");
    await call('insert', "INSERT INTO ox_rc VALUES (2, 'C')");
    await call('insert', "INSERT INTO ox_hold VALUES ('C')");
    const held = await call('update', "DELETE FROM ox_rc WHERE stateid = 'C'");
    const dropped = await call('query', 'DROP TABLE ox_hold');
    const freed = await call('update', "DELETE FROM ox_rc WHERE stateid = 'C'");
    check('... RESTRICT refuses the parent delete; after DROP TABLE of the child it goes through',
        held.v === false && ok(dropped) && freed.v === 1, JSON.stringify([held, dropped, freed]));
    const missing = await call('query', 'CREATE TABLE vehicle_financing (vehicleId int(11) NOT NULL, PRIMARY KEY (vehicleId), FOREIGN KEY (vehicleId) REFERENCES player_vehicles (id) ON DELETE CASCADE)');
    const made = await val("SELECT COUNT(*) FROM sqlite_master WHERE name = 'vehicle_financing'");
    check('a foreign key to a table that does not exist fails, as in MariaDB', missing.v === false && /player_vehicles/.test(missing.err) && made === 0, JSON.stringify(missing));

    // npwd: quoted COLLATE, and the same index name in two tables
    const n1 = await call('query', "CREATE TABLE IF NOT EXISTS `npwd_notes` ( `id` int(11) NOT NULL AUTO_INCREMENT, `identifier` varchar(48) NOT NULL COLLATE 'utf8mb4_general_ci', `title` varchar(255) NOT NULL, PRIMARY KEY (id), INDEX `identifier` (`identifier`) )");
    const n2 = await call('query', "CREATE TABLE IF NOT EXISTS `npwd_calls` ( `id` int(11) NOT NULL AUTO_INCREMENT, `identifier` varchar(48) DEFAULT NULL COLLATE 'utf8mb4_general_ci', `start` varchar(255) DEFAULT NULL, end varchar(255) DEFAULT NULL, PRIMARY KEY (id), INDEX `identifier` (`identifier`) ) COLLATE='utf8mb4_general_ci' ENGINE=InnoDB AUTO_INCREMENT=31");
    const idx = await call('query', "SHOW INDEX FROM npwd_calls WHERE Key_name = 'identifier'");
    check("npwd: COLLATE 'x', and index identifier in two tables", ok(n1) && ok(n2) && Array.isArray(idx.v) && idx.v.length === 1, JSON.stringify([n1, n2, idx]));
    const call31 = await call('insert', "INSERT INTO npwd_calls (identifier, `start`, `end`) VALUES ('a', '1', '2')");
    check('... AUTO_INCREMENT=31 starts the ids at 31', call31.v === 31, JSON.stringify(call31));

    // A DATETIME or TIMESTAMP reads back as epoch ms, as oxmysql gives it.
    // The sql.js fallback has no column origins and returns the stored text
    // (README, "differs").
    const sqljs = process.env.FX_BACKEND === 'sql.js';
    const asMs = (x) => (sqljs && typeof x === 'string' ? new Date(x).getTime() : x);
    const recentMs = (x) => typeof asMs(x) === 'number' && Math.abs(asMs(x) - Date.now()) < 10000;

    // ox_mdt: FULLTEXT inside CREATE TABLE, DEFAULT curtime()
    const rep = await call('query', 'CREATE TABLE IF NOT EXISTS `ox_mdt_reports` ( `id` int (10) unsigned NOT NULL AUTO_INCREMENT, `title` varchar(50) NOT NULL, `date` datetime DEFAULT curtime(), PRIMARY KEY (`id`) USING BTREE, FULLTEXT INDEX `title_desc` (`title`) )');
    await call('insert', "INSERT INTO ox_mdt_reports (title) VALUES ('t')");
    const rd = await val("SELECT `date` FROM ox_mdt_reports WHERE title = 't'");
    check('ox_mdt: FULLTEXT INDEX and DEFAULT curtime() on a datetime', ok(rep) && Number.isFinite(asMs(rd)), JSON.stringify([rep, rd]));

    // ALTER TABLE
    const alter1 = "ALTER TABLE mdt_reports_charges ADD COLUMN IF NOT EXISTS title VARCHAR(255) NOT NULL DEFAULT '' AFTER reportid, ADD COLUMN IF NOT EXISTS images LONGTEXT NULL DEFAULT NULL AFTER charge";
    const a1 = await call('query', alter1);
    const a2 = await call('query', alter1);
    const colsAfter = (await call('query', "SELECT name FROM pragma_table_info('mdt_reports_charges')")).v.map((x) => x.name);
    check('ALTER: two ADD COLUMN IF NOT EXISTS clauses, run twice', ok(a1) && ok(a2) && colsAfter.join(',') === 'reportid,title,charge,images', JSON.stringify([a1, a2, colsAfter]));
    await call('insert', "INSERT INTO npwd_notes (identifier, title) VALUES ('x', 'before')");
    const a3 = await call('query', 'ALTER TABLE npwd_notes ADD COLUMN created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await call('insert', "INSERT INTO npwd_notes (identifier, title) VALUES ('x', 'after')");
    const created = (await call('query', 'SELECT title, created FROM npwd_notes ORDER BY id')).v;
    check('ALTER: ADD COLUMN ... DEFAULT CURRENT_TIMESTAMP fills old rows and new ones', ok(a3) && created.length === 2 && created.every((x) => recentMs(x.created)), JSON.stringify([a3, created]));
    const a4 = await call('query', 'ALTER TABLE npwd_notes ADD COLUMN upd TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP');
    await call('update', "UPDATE npwd_notes SET title = 'changed' WHERE title = 'before'");
    const upd = await val("SELECT upd FROM npwd_notes WHERE title = 'changed'");
    const upd2 = await val("SELECT upd FROM npwd_notes WHERE title = 'after'");
    check('ALTER: ADD COLUMN ... ON UPDATE CURRENT_TIMESTAMP stamps only the changed row', ok(a4) && recentMs(upd) && upd2 == null, JSON.stringify([a4, upd, upd2]));
    const a5 = await call('query', 'ALTER TABLE npwd_notes CHANGE `upd` `updated_at` TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP');
    await call('update', "UPDATE npwd_notes SET title = 'later' WHERE title = 'after'");
    check('ALTER: a renamed ON UPDATE column keeps stamping', ok(a5) && recentMs(await val("SELECT updated_at FROM npwd_notes WHERE title = 'later'")), JSON.stringify(a5));
    await call('query', 'CREATE INDEX idx_two ON npwd_notes (identifier, title)');
    const a6 = await call('query', 'ALTER TABLE npwd_notes DROP COLUMN title');
    const left = (await call('query', "SELECT name FROM pragma_index_info('npwd_notes_idx_two')")).v.map((x) => x.name);
    check('ALTER: DROP COLUMN takes the column out of its indexes, as MariaDB does', ok(a6) && left.join(',') === 'identifier', JSON.stringify([a6, left]));
    await call('query', 'CREATE TABLE IF NOT EXISTS items (name varchar(50) NOT NULL, label varchar(50) NOT NULL) ENGINE=InnoDB');
    const a7 = await call('query', 'ALTER TABLE `items` ADD PRIMARY KEY (`name`)');
    await call('insert', "INSERT INTO items VALUES ('bread', 'Bread')");
    const dupItem = await call('insert', "INSERT INTO items VALUES ('bread', 'Again')");
    check('ALTER: ADD PRIMARY KEY makes the column unique', ok(a7) && dupItem.v === false, JSON.stringify([a7, dupItem]));
    const a8 = await call('query', 'ALTER TABLE `items` DROP PRIMARY KEY');
    const dupItem2 = await call('insert', "INSERT INTO items VALUES ('bread', 'Again')");
    check('ALTER: DROP PRIMARY KEY lifts it', ok(a8) && ok(dupItem2), JSON.stringify([a8, dupItem2]));
    const db1 = await call('query', 'ALTER DATABASE `es_extended` DEFAULT CHARACTER SET UTF8MB4');
    const db2 = await call('query', 'DROP PROCEDURE IF EXISTS esx_hardening');
    check('ALTER DATABASE and DROP PROCEDURE are MariaDB business and do not fail', ok(db1) && ok(db2), JSON.stringify([db1, db2]));

    // Reads
    await call('query', 'CREATE TABLE IF NOT EXISTS bolos (id int(11) NOT NULL AUTO_INCREMENT, creator varchar(7), PRIMARY KEY (id))');
    await call('query', 'CREATE TABLE IF NOT EXISTS bolo_images (id int(11) NOT NULL AUTO_INCREMENT, boloId int(11), image varchar(255), PRIMARY KEY (id))');
    await call('insert', "INSERT INTO bolos (creator) VALUES ('A1'), ('B2')");
    await call('insert', "INSERT INTO bolo_images (boloId, image) VALUES (1, 'x.png'), (1, 'y.png')");
    const grouped = await call('query', 'SELECT a.id, a.creator, JSON_ARRAYAGG(d.image) AS images FROM `bolos` a LEFT JOIN `bolo_images` d ON d.boloId = a.id GROUP BY `id` ORDER BY `id` DESC');
    check('GROUP BY id and ORDER BY id mean the selected a.id, as in MariaDB', ok(grouped) && grouped.v.length === 2 && grouped.v[0].id === 2 && grouped.v[1].images === '["x.png","y.png"]', JSON.stringify(grouped));
    check("REGEXP '^[0-9]{4}-' ", await val("SELECT '2024-01' REGEXP '^[0-9]{4}-'") === 1 && await val("SELECT 'ab' NOT REGEXP '^A'") === 0);
    check('LAST_DAY', await val("SELECT LAST_DAY('2024-02-10')") === '2024-02-29');

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    setTimeout(() => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows keeps the file open */ }
        process.exit(failed ? 1 : 0);
    }, 200);
})().catch((e) => { console.log('FAIL ' + e.stack); process.exit(1); });
