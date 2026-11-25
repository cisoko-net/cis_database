'use strict';

// SQL as the big FiveM frameworks and scripts send it (es_extended, qbx_core
// and qb-core, ox_inventory, ND_Core, phone, garage, housing and banking
// scripts), translated by dialect.js and run on a real node:sqlite database
// with the MySQL functions server.js registers. Every expected value is what
// MariaDB returns for the same statement. Then, on the engine: a read SQLite
// cannot run is answered by MariaDB, and a write SQLite cannot run fails for
// its caller and reaches neither database.
// Usage: node tests/repro/dialect_market.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const dialect = require('../../dialect.js');

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

const db = new DatabaseSync(':memory:');
for (const f of dialect.sqlFunctions) db.function(f.name, { deterministic: true, useBigIntArguments: !!f.bigint }, f.fn);
if (typeof db.aggregate === 'function') {
    for (const a of dialect.sqlAggregates) db.aggregate(a.name, { start: a.start, step: a.step, result: a.result });
}
db.function('cis_last_insert_id', () => 0);
db.function('cis_set_insert_id', (v) => v);
dialect.setSchemaProvider((t) => db.prepare('SELECT * FROM pragma_table_info(?)').all(t));

const plain = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? Number(x) : x)));

function marks(sql, sqliteText) {
    let n = 0;
    dialect.mapCode(sql, (chunk) => { n += (chunk.match(/\?/g) || []).length; return chunk; }, sqliteText);
    return n;
}

// Placeholder count must survive every translation (engine invariant 5).
const markErrors = [];
function exec(sql, params) {
    const tr = dialect.translate(sql);
    if (marks(sql) !== marks(tr.sql, true)) markErrors.push(sql + ' -> ' + tr.sql);
    const st = db.prepare(tr.sql);
    const out = st.columns().length ? st.all(...(params || [])) : st.run(...(params || []));
    for (const x of tr.extra || []) db.exec(x);
    return plain(out);
}
function rows(sql, params) {
    try { return exec(sql, params); } catch (e) { return 'ERR ' + e.message; }
}
function one(sql, params) {
    const r = rows(sql, params);
    if (!Array.isArray(r)) return r;
    return r.length ? Object.values(r[0])[0] : undefined;
}
function eq(name, got, want) {
    check(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}
// A statement with no exact SQLite form must be refused by SQLite (so the
// engine sends a read to MariaDB) rather than answer something else.
function refused(name, sql) {
    const r = rows(sql);
    let tr;
    try { tr = dialect.translate(sql).sql; } catch (e) { tr = e.message; }
    check(name, typeof r === 'string' && r.startsWith('ERR'), 'got ' + JSON.stringify(r) + ' sql ' + tr);
}

const utcNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

// Schemas as the resources create them.
exec("CREATE TABLE IF NOT EXISTS `users` (`identifier` varchar(60) NOT NULL, `accounts` longtext DEFAULT NULL, `group` varchar(50) DEFAULT 'user', `inventory` longtext DEFAULT NULL, `job` varchar(20) DEFAULT 'unemployed', `job_grade` int(11) DEFAULT 0, `metadata` longtext DEFAULT NULL, `position` longtext NULL DEFAULT NULL, `status` varchar(16) DEFAULT 'idle', `active` varchar(16) DEFAULT 'yes', `bio` text DEFAULT NULL, `last_seen` timestamp NULL DEFAULT NULL, PRIMARY KEY (`identifier`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
exec("CREATE TABLE IF NOT EXISTS `owned_vehicles` (`owner` varchar(60) NOT NULL, `plate` varchar(12) NOT NULL, `vehicle` longtext, `type` varchar(20) NOT NULL DEFAULT 'car', `stored` tinyint(1) NOT NULL DEFAULT 0, `parking` varchar(60) DEFAULT NULL, `trunk` longtext, PRIMARY KEY (`plate`)) ENGINE=InnoDB");
exec("CREATE TABLE IF NOT EXISTS `ox_inventory` (`owner` varchar(60) DEFAULT NULL, `name` varchar(100) NOT NULL, `data` longtext DEFAULT NULL, `lastupdated` timestamp NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP(), UNIQUE KEY `owner` (`owner`,`name`)) ENGINE=InnoDB");
exec("CREATE TABLE IF NOT EXISTS `players` (`citizenid` varchar(50) NOT NULL, `license` varchar(255) NOT NULL, `name` varchar(255) NOT NULL, `money` text NOT NULL, `charinfo` text DEFAULT NULL, `metadata` text NOT NULL, `last_updated` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(), PRIMARY KEY (`citizenid`)) ENGINE=InnoDB");
exec("CREATE TABLE IF NOT EXISTS `bank_accounts` (`id` int(11) NOT NULL AUTO_INCREMENT, `citizenid` varchar(11) DEFAULT NULL, `account_name` varchar(50) DEFAULT NULL, `account_balance` int(11) NOT NULL DEFAULT 0, `account_type` enum('shared','job','gang') NOT NULL, PRIMARY KEY (`id`), UNIQUE KEY `account_name` (`account_name`)) ENGINE=InnoDB");
exec("CREATE TABLE IF NOT EXISTS `phone_messages` (`id` int(11) NOT NULL AUTO_INCREMENT, `number` varchar(15) NOT NULL, `message` text NOT NULL, `time` timestamp NOT NULL DEFAULT current_timestamp(), PRIMARY KEY (`id`)) ENGINE=InnoDB");
exec("CREATE TABLE IF NOT EXISTS `stats` (`id` int(11) NOT NULL AUTO_INCREMENT, `v` double NOT NULL, `label` varchar(20) DEFAULT NULL, PRIMARY KEY (`id`))");

// es_extended
exec("INSERT INTO `users` (`identifier`, `accounts`, `group`, `metadata`, `last_seen`) VALUES (?, ?, ?, ?, ?)",
    ['char1:abc', '{"bank":500,"money":20}', 'admin', '{"hunger":50,"isdead":false,"jailed":true,"phone":"5551234","name":"Bob"}', '2024-01-01 10:00:00']);
exec("INSERT INTO users (identifier, last_seen) VALUES ('char1:old', '2020-06-01 00:00:00'), ('char1:new', ?)", [utcNow()]);
const save = exec("UPDATE `users` SET `accounts` = ?, `job` = ?, `job_grade` = ?, `group` = ?, `position` = ?, `inventory` = ?, `metadata` = ? WHERE `identifier` = ?",
    ['{"bank":600,"money":5}', 'police', 2, 'admin', '{"x":1.5,"y":2,"z":3}', '[]', '{"hunger":40,"isdead":false,"jailed":true,"phone":"5551234","name":"Bob"}', 'char1:abc']);
eq('es_extended save: UPDATE with the group column', save.changes, 1);
eq('es_extended load: SELECT `group`, job', rows("SELECT `group`, `job`, `job_grade` FROM `users` WHERE `identifier` = ?", ['char1:abc']), [{ group: 'admin', job: 'police', job_grade: 2 }]);
eq('double-quoted text is a string, not the column of that name', one('SELECT COUNT(*) FROM users WHERE status = "active"'), 0);
eq('double-quoted text in UPDATE ... SET', exec('UPDATE users SET job = "unemployed" WHERE identifier = "char1:old"').changes, 1);
eq('it\'s inside "..."', one('SELECT "it\'s" AS v'), "it's");
eq('INSERT IGNORE skips a duplicate key', exec("INSERT IGNORE INTO users (identifier) VALUES (?)", ['char1:abc']).changes, 0);
eq('backticks and USE INDEX', one("SELECT `identifier` FROM `users` USE INDEX (PRIMARY) WHERE `identifier` = ?", ['char1:abc']), 'char1:abc');
eq('FORCE INDEX FOR ORDER BY', one("SELECT identifier FROM users FORCE INDEX FOR ORDER BY (`PRIMARY`) ORDER BY identifier LIMIT 1"), 'char1:abc');

// ON DUPLICATE KEY UPDATE
exec("INSERT INTO bank_accounts (citizenid, account_name, account_balance, account_type) VALUES ('ABC123', 'police', 1000, 'job')");
const up = exec("INSERT INTO bank_accounts (account_name, account_balance, account_type) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE account_balance = account_balance + VALUES(account_balance)", ['police', 250, 'job']);
eq('upsert on a UNIQUE key that is not the primary key updates in place', rows("SELECT id, citizenid, account_balance FROM bank_accounts"), [{ id: 1, citizenid: 'ABC123', account_balance: 1250 }]);
eq('... and changed one row', up.changes, 1);
exec("INSERT INTO ox_inventory (owner, name, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)", ['char1:abc', 'stash', '[{"slot":1}]']);
exec("INSERT INTO ox_inventory (owner, name, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)", ['char1:abc', 'stash', '[{"slot":2}]']);
eq('ox_inventory stash upsert (UNIQUE owner, name)', rows("SELECT owner, name, data FROM ox_inventory"), [{ owner: 'char1:abc', name: 'stash', data: '[{"slot":2}]' }]);
exec("INSERT INTO players (citizenid, license, name, money, metadata) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), money = VALUES(money), metadata = VALUES(metadata)",
    ['QB1', 'license:1', 'Ann', '{"cash":10}', '{"hunger":100,"isdead":false,"jailtime":0}']);
exec("INSERT INTO players (citizenid, license, name, money, metadata) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), money = VALUES(money), metadata = VALUES(metadata)",
    ['QB1', 'license:other', 'Ann B', '{"cash":20}', '{"hunger":90,"isdead":false,"jailtime":0}']);
eq('qbx_core save upsert keeps columns it does not name', rows("SELECT license, name, money FROM players WHERE citizenid = 'QB1'"), [{ license: 'license:1', name: 'Ann B', money: '{"cash":20}' }]);
// The change guard skips a no-op update, so SQLite counts 0; server.js reports
// found-and-unchanged as 1, as MariaDB does through mysql2 (write_counts.js).
eq('ON DUPLICATE KEY UPDATE id = id (insert-or-keep idiom) writes nothing', exec("INSERT INTO bank_accounts (account_name, account_balance, account_type) VALUES ('police', 1, 'job') ON DUPLICATE KEY UPDATE id = id").changes, 0);
eq('... leaves the row alone', one("SELECT account_balance FROM bank_accounts WHERE account_name = 'police'"), 1250);
eq('ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id) keeps the id', (exec("INSERT INTO bank_accounts (account_name, account_type) VALUES ('police', 'job') ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)"), one("SELECT id FROM bank_accounts WHERE account_name = 'police'")), 1);
exec("INSERT INTO bank_accounts (account_name, account_balance, account_type) SELECT CONCAT('gang_', citizenid), 5, 'gang' FROM players ON DUPLICATE KEY UPDATE account_balance = account_balance + 1");
eq('INSERT ... SELECT ... ON DUPLICATE KEY UPDATE', one("SELECT account_balance FROM bank_accounts WHERE account_name = 'gang_QB1'"), 5);

// JSON
eq('JSON_EXTRACT number', one("SELECT JSON_EXTRACT(metadata, '$.hunger') FROM users WHERE identifier = 'char1:abc'"), 40);
eq('JSON_UNQUOTE(JSON_EXTRACT(...)) string', one("SELECT JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.name')) FROM users WHERE identifier = 'char1:abc'"), 'Bob');
eq('col->>path', one("SELECT metadata->>'$.phone' FROM users WHERE identifier = 'char1:abc'"), '5551234');
eq('col->path in WHERE', one("SELECT identifier FROM users WHERE metadata->'$.phone' = ?", ['5551234']), 'char1:abc');
eq('JSON_EXTRACT with a double-quoted path (ND_Core)', one('SELECT JSON_EXTRACT(metadata, "$.hunger") FROM users WHERE identifier = ?', ['char1:abc']), 40);
eq('JSON_SET then read back', (exec("UPDATE players SET metadata = JSON_SET(metadata, '$.jailtime', ?) WHERE citizenid = ?", [15, 'QB1']), one("SELECT JSON_EXTRACT(metadata, '$.jailtime') FROM players WHERE citizenid = 'QB1'")), 15);
eq('JSON boolean compared with true', one("SELECT COUNT(*) FROM users WHERE JSON_EXTRACT(metadata, '$.jailed') = true"), 1);
eq('a literal that looks like an arrow is not rewritten', one("SELECT 'a->''$.b''' AS v"), "a->'$.b'");
// A JSON true or false in a SELECT item comes back as a marker that
// server.js turns into a boolean (checked on the engine below).
const asBool = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === dialect.JSON_TRUE ? true : v === dialect.JSON_FALSE ? false : v]));
eq('JSON_EXTRACT and col->path give true and false in a SELECT item',
    rows("SELECT JSON_EXTRACT(metadata, '$.isdead') AS dead, JSON_EXTRACT(metadata, '$.jailed') jailed, metadata->'$.isdead' AS d2 FROM users WHERE identifier = 'char1:abc'").map(asBool),
    [{ dead: false, jailed: true, d2: false }]);
eq('... and every other JSON type as json_extract returns it',
    rows("SELECT JSON_EXTRACT(metadata, '$.hunger') AS h, JSON_EXTRACT(metadata, '$.name') AS n, JSON_EXTRACT(metadata, '$.nope') AS x, JSON_EXTRACT('{\"o\":{\"k\":1},\"z\":null,\"f\":1.5}', '$.o') AS o, JSON_EXTRACT('{\"z\":null}', '$.z') AS z, JSON_EXTRACT('{\"f\":1.5}', ?) AS f FROM users WHERE identifier = 'char1:abc'", ['$.f']),
    [{ h: 40, n: 'Bob', x: null, o: '{"k":1}', z: null, f: 1.5 }]);
exec('CREATE TABLE kv (id INT PRIMARY KEY, `value` TEXT, `type` TEXT)');
exec("INSERT INTO kv VALUES (1, '{\"on\":true}', 'x')");
eq('... also from a column named value', rows('SELECT JSON_EXTRACT(`value`, ?) AS enabled, `type` FROM kv', ['$.on']).map(asBool), [{ enabled: true, type: 'x' }]);
eq('inside another call or in WHERE it stays 1 or 0', rows("SELECT COALESCE(JSON_EXTRACT(metadata, '$.isdead'), 1) AS c FROM users WHERE JSON_EXTRACT(metadata, '$.jailed') = 1 AND identifier = 'char1:abc'"), [{ c: 0 }]);

// Dates (MySQL's results; NOW() is UTC here, as on a server whose time zone is UTC)
eq('DATE_SUB(literal, INTERVAL n DAY)', one("SELECT DATE_SUB('2024-03-10 12:00:00', INTERVAL 30 DAY)"), '2024-02-09 12:00:00');
eq('DATE_SUB(?, INTERVAL ? DAY) keeps the sign and the ? order', one('SELECT DATE_SUB(?, INTERVAL ? DAY)', ['2024-01-10 00:00:00', 3]), '2024-01-07 00:00:00');
eq('DATE_ADD(?, INTERVAL ? HOUR)', one('SELECT DATE_ADD(?, INTERVAL ? HOUR)', ['2024-01-10 00:00:00', 5]), '2024-01-10 05:00:00');
eq('DATE_ADD(..., INTERVAL 1 WEEK)', one("SELECT DATE_ADD('2024-01-01 00:00:00', INTERVAL 1 WEEK)"), '2024-01-08 00:00:00');
eq('DATE_ADD(..., INTERVAL -1 DAY)', one("SELECT DATE_ADD('2024-01-01 00:00:00', INTERVAL -1 DAY)"), '2023-12-31 00:00:00');
eq('DATE_ADD(date, INTERVAL 1 MONTH) stays a date', one("SELECT DATE_ADD('2024-01-15', INTERVAL 1 MONTH)"), '2024-02-15');
eq('ts - INTERVAL 2 HOUR', one("SELECT CAST('2024-01-01 10:00:00' AS CHAR) - INTERVAL 2 HOUR"), '2024-01-01 08:00:00');
eq('? + INTERVAL ? MINUTE', one('SELECT ? + INTERVAL ? MINUTE', ['2024-01-01 10:00:00', 90]), '2024-01-01 11:30:00');
eq('NOW() - INTERVAL 1 DAY is a datetime, not a number', /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(one('SELECT NOW() - INTERVAL 1 DAY')), true);
eq('CURDATE() + INTERVAL 1 DAY is a date', /^\d{4}-\d\d-\d\d$/.test(one('SELECT CURDATE() + INTERVAL 1 DAY')), true);
exec("INSERT INTO phone_messages (number, message, time) VALUES ('1', 'old', datetime('now', '-10 days')), ('1', 'new', datetime('now', '-1 days'))".replace(/datetime\('now', '(-\d+) days'\)/g, (m, n) => "'" + new Date(Date.now() + Number(n) * 86400000).toISOString().slice(0, 19).replace('T', ' ') + "'"));
eq('phone cleanup: DELETE ... < DATE_SUB(NOW(), INTERVAL 7 DAY) deletes only old rows', (exec('DELETE FROM phone_messages WHERE time < DATE_SUB(NOW(), INTERVAL 7 DAY)'), rows('SELECT message FROM phone_messages')), [{ message: 'new' }]);
eq('last_seen < NOW() - INTERVAL 30 DAY', rows('SELECT identifier FROM users WHERE last_seen < NOW() - INTERVAL 30 DAY ORDER BY identifier'), [{ identifier: 'char1:abc' }, { identifier: 'char1:old' }]);
eq('TIMESTAMPDIFF(SECOND, ?, ?) keeps the ? order', one('SELECT TIMESTAMPDIFF(SECOND, ?, ?)', ['2024-01-01 00:00:00', '2024-01-01 00:01:00']), 60);
eq('TIMESTAMPDIFF(HOUR, ...) is whole hours', one("SELECT TIMESTAMPDIFF(HOUR, '2024-01-01 00:00:00', '2024-01-01 01:59:59')"), 1);
eq('TIMESTAMPDIFF(MINUTE, ...) truncates toward zero', one("SELECT TIMESTAMPDIFF(MINUTE, '2024-01-01 00:01:30', '2024-01-01 00:00:00')"), -1);
eq('TIMESTAMPADD(MINUTE, 30, ...)', one("SELECT TIMESTAMPADD(MINUTE, 30, '2024-01-01 00:00:00')"), '2024-01-01 00:30:00');
eq('DATEDIFF counts calendar days', one("SELECT DATEDIFF('2024-01-02 01:00:00', '2024-01-01 23:00:00')"), 1);
// MariaDB's clock is the server's local time (time_zone SYSTEM): NOW() and
// FROM_UNIXTIME print local text, UNIX_TIMESTAMP(x) reads x as local.
const pad2 = (n) => String(n).padStart(2, '0');
const localText = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
const fromLocal = (s) => Date.parse(s.replace(' ', 'T'));
eq('UNIX_TIMESTAMP(datetime) reads local time', one("SELECT UNIX_TIMESTAMP('2024-01-01 00:00:00')"), fromLocal('2024-01-01 00:00:00') / 1000);
eq('UNIX_TIMESTAMP() is now', Math.abs(one('SELECT UNIX_TIMESTAMP()') - Date.now() / 1000) < 5, true);
eq('UNIX_TIMESTAMP(NOW()) is now', Math.abs(one('SELECT UNIX_TIMESTAMP(NOW())') - Date.now() / 1000) < 5, true);
eq('FROM_UNIXTIME(n) prints local time', one('SELECT FROM_UNIXTIME(1704067200)'), localText(new Date(1704067200000)));
eq('FROM_UNIXTIME(?, fmt)', one("SELECT FROM_UNIXTIME(?, '%Y-%m-%d')", [1704067200]), localText(new Date(1704067200000)).slice(0, 10));
eq('UNIX_TIMESTAMP(FROM_UNIXTIME(n)) round trip', one('SELECT UNIX_TIMESTAMP(FROM_UNIXTIME(1704067200))'), 1704067200);
eq('NOW() is the current local time', Math.abs(fromLocal(one('SELECT NOW()')) - Date.now()) < 5000, true);
eq('bare CURRENT_TIMESTAMP is local time', Math.abs(fromLocal(one('SELECT CURRENT_TIMESTAMP')) - Date.now()) < 5000, true);
eq('CURDATE() and bare CURRENT_DATE are the local date', rows('SELECT CURDATE() AS a, CURRENT_DATE AS b'), [{ a: localText(new Date()).slice(0, 10), b: localText(new Date()).slice(0, 10) }]);
eq('UTC_TIMESTAMP() stays UTC', Math.abs(Date.parse(one('SELECT UTC_TIMESTAMP()') + 'Z') - Date.now()) < 5000, true);
eq("a column named like 'localtime' text is left alone", one("SELECT 'localtime CURRENT_TIMESTAMP'"), 'localtime CURRENT_TIMESTAMP');
eq('CURRENT_TIMESTAMP() and CURRENT_TIMESTAMP', JSON.stringify(rows('SELECT CURRENT_TIMESTAMP() = CURRENT_TIMESTAMP AS same')), '[{"same":1}]');
eq('YEAR(NOW())', one('SELECT YEAR(NOW())'), new Date().getFullYear());
exec('CREATE TABLE clock_defaults (id INT AUTO_INCREMENT PRIMARY KEY, made DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, day DATE DEFAULT (CURDATE()), note VARCHAR(10))');
exec("INSERT INTO clock_defaults (note) VALUES ('x')");
const madeRow = rows('SELECT made, day FROM clock_defaults')[0] || {};
eq('DEFAULT CURRENT_TIMESTAMP and DEFAULT (CURDATE()) fill local time', Math.abs(fromLocal(madeRow.made || '') - Date.now()) < 5000 && madeRow.day === localText(new Date()).slice(0, 10), true);
eq('MONTH(col), DAY(col), HOUR(col)', rows("SELECT MONTH(last_seen) AS m, DAY(last_seen) AS d, HOUR(last_seen) AS h FROM users WHERE identifier = 'char1:abc'"), [{ m: 1, d: 1, h: 10 }]);
eq("DATE_FORMAT(d, '%d/%m/%Y %H:%i')", one("SELECT DATE_FORMAT('2024-03-05 07:08:09', '%d/%m/%Y %H:%i')"), '05/03/2024 07:08');
eq("DATE_FORMAT(d, '%e.%c.%Y %l:%i %p')", one("SELECT DATE_FORMAT('2024-03-05 07:08:09', '%e.%c.%Y %l:%i %p')"), '5.3.2024 7:08 AM');
eq("STR_TO_DATE(s, '%Y-%m-%d')", one("SELECT STR_TO_DATE('2024-01-02', '%Y-%m-%d')"), '2024-01-02');
eq('TIME_TO_SEC', one("SELECT TIME_TO_SEC('01:00:30')"), 3630);

// Strings and escapes
eq('\\n and \\t are a newline and a tab', one("SELECT 'a\\nb\\tc'"), 'a\nb\tc');
eq("\\' and '' both give a quote", one("SELECT 'it\\'s' = 'it''s'"), 1);
eq('\\\\ is one backslash, also at the end of a literal', rows("SELECT 'C:\\\\temp\\\\' AS p, UPPER('x') AS u"), [{ p: 'C:\\temp\\', u: 'X' }]);
eq('\\% and \\_ keep the backslash', one("SELECT 'a\\_b'"), 'a\\_b');
eq("LIKE 'a\\_%' matches a literal underscore only", (exec("INSERT INTO stats (v, label) VALUES (1, 'a_x'), (2, 'abx')"), rows("SELECT label FROM stats WHERE label LIKE 'a\\_%'")), [{ label: 'a_x' }]);
exec("UPDATE users SET bio = 'join my group, text me, count 3, users.x, VALUE(1), NOW() 0x41' WHERE identifier = 'char1:abc'");
eq('keywords inside a literal are stored as written', one("SELECT bio FROM users WHERE identifier = 'char1:abc'"), 'join my group, text me, count 3, users.x, VALUE(1), NOW() 0x41');
eq('0x41 in code is a blob', JSON.stringify(rows('SELECT hex(0x41) AS h')), '[{"h":"41"}]');
eq('LEFT, RIGHT, LOCATE', rows("SELECT LEFT('abcdef', 2) AS l, RIGHT('abcdef', 2) AS r, RIGHT('abc', 0) AS r0, LOCATE('cd', 'abcdef') AS p"), [{ l: 'ab', r: 'ef', r0: '', p: 3 }]);
eq('LPAD and RPAD', rows("SELECT LPAD('5', 3, '0') AS a, LPAD('12345', 3, '0') AS b, RPAD('ab', 5, 'xy') AS c"), [{ a: '005', b: '123', c: 'abxyx' }]);
eq('SUBSTRING_INDEX', rows("SELECT SUBSTRING_INDEX('a.b.c', '.', 2) AS a, SUBSTRING_INDEX('a.b.c', '.', -1) AS b, SUBSTRING_INDEX('abc', '.', 1) AS c"), [{ a: 'a.b', b: 'c', c: 'abc' }]);
eq('UNHEX', JSON.stringify(rows("SELECT hex(UNHEX('4142')) AS h")), '[{"h":"4142"}]');
eq('CONCAT, IFNULL, IF, GREATEST', rows("SELECT CONCAT('a', 'b') AS c, IFNULL(NULL, 'x') AS i, IF(1 > 0, 'y', 'n') AS f, GREATEST(1, 5, 3) AS g"), [{ c: 'ab', i: 'x', f: 'y', g: 5 }]);

// Numbers
eq('TRUNCATE cuts toward zero', rows('SELECT TRUNCATE(1.999, 1) AS a, TRUNCATE(-1.999, 0) AS b, TRUNCATE(1.15, 2) AS c, TRUNCATE(123, -1) AS d'), [{ a: 1.9, b: -1, c: 1.15, d: 120 }]);
exec("DELETE FROM stats");
for (const v of [2, 4, 4, 4, 5, 5, 7, 9]) exec('INSERT INTO stats (v) VALUES (?)', [v]);
if (typeof db.aggregate === 'function') {
    eq('STDDEV, VARIANCE, VAR_SAMP', rows('SELECT STDDEV(v) AS sd, VARIANCE(v) AS var, VAR_SAMP(v) AS vs FROM stats'), [{ sd: 2, var: 4, vs: 32 / 7 }]);
} else {
    refused('STDDEV without DatabaseSync.aggregate goes to MariaDB', 'SELECT STDDEV(v) FROM stats');
}
eq('MOD', one('SELECT MOD(7, 3)'), 1);

// LIMIT on a write, a join DELETE, GROUP_CONCAT
exec('DELETE FROM stats');
for (const [v, label] of [[1, 'a'], [2, 'b'], [3, 'a'], [4, 'c'], [5, 'a']]) exec('INSERT INTO stats (v, label) VALUES (?, ?)', [v, label]);
exec("DELETE FROM stats WHERE label = 'a' ORDER BY v DESC LIMIT ?", [2]);
eq('DELETE ... ORDER BY ... LIMIT ? deletes only that many, the right ones', rows('SELECT v FROM stats ORDER BY v'), [{ v: 1 }, { v: 2 }, { v: 4 }]);
exec("UPDATE stats SET label = ? WHERE label <> 'z' ORDER BY v LIMIT 1", ['z']);
eq('UPDATE ... ORDER BY ... LIMIT 1 changes one row', rows("SELECT v FROM stats WHERE label = 'z'"), [{ v: 1 }]);
exec('DELETE FROM stats LIMIT 1');
eq('DELETE ... LIMIT 1 without ORDER BY deletes one row', one('SELECT COUNT(*) FROM stats'), 2);
exec('CREATE TABLE IF NOT EXISTS `wash` (`id` int(11) NOT NULL AUTO_INCREMENT, `amount` int(11), PRIMARY KEY (`id`))');
exec('CREATE TABLE IF NOT EXISTS `wash_ops` (`operation_id` varchar(64) NOT NULL, PRIMARY KEY (`operation_id`))');
exec('INSERT INTO wash (amount) VALUES (10), (20), (30)');
exec("INSERT INTO wash_ops (operation_id) VALUES ('legacy:1'), ('legacy:3'), ('other:2')");
exec("DELETE w FROM wash w JOIN wash_ops p ON p.operation_id = CONCAT('legacy:', w.id)");
eq('DELETE w FROM w JOIN p ON ... deletes the joined rows only', rows('SELECT id FROM wash ORDER BY id'), [{ id: 2 }]);
exec("DELETE wash FROM wash LEFT JOIN wash_ops ON wash_ops.operation_id = CONCAT('other:', wash.id) WHERE wash_ops.operation_id IS NULL");
eq('DELETE t FROM t LEFT JOIN u ... WHERE u.x IS NULL keeps the matched row', rows('SELECT id FROM wash ORDER BY id'), [{ id: 2 }]);
refused('DELETE a, b FROM a JOIN b has no SQLite form', 'DELETE wash, wash_ops FROM wash JOIN wash_ops ON 1 = 1');
exec('DELETE FROM stats');
for (const [v, label] of [[3, 'c'], [1, 'a'], [2, 'b'], [4, 'a']]) exec('INSERT INTO stats (v, label) VALUES (?, ?)', [v, label]);
eq('GROUP_CONCAT(x ORDER BY y SEPARATOR s)', one("SELECT GROUP_CONCAT(label ORDER BY v DESC SEPARATOR '|') FROM stats"), 'a|c|b|a');
eq('GROUP_CONCAT(DISTINCT x ORDER BY x)', one('SELECT GROUP_CONCAT(DISTINCT label ORDER BY label) FROM stats'), 'a,b,c');
eq('GROUP_CONCAT(a, b) joins the arguments', one('SELECT GROUP_CONCAT(label, CAST(v AS SIGNED) ORDER BY v) FROM stats'), 'a1,b2,c3,a4');
// Month and weekday names as MariaDB's default lc_time_names (en_US) prints them.
eq("DATE_FORMAT(d, '%d %b %Y %H:%i')", one("SELECT DATE_FORMAT('2026-03-01 14:05:09', '%d %b %Y %H:%i')"), '01 Mar 2026 14:05');
eq("DATE_FORMAT(d, '%W %M %e, %y')", one("SELECT DATE_FORMAT('2026-12-06 00:00:00', '%W %M %e, %y')"), 'Sunday December 6, 26');
eq("DATE_FORMAT(d, '%a %b')", one("SELECT DATE_FORMAT('2026-09-12', '%a %b')"), 'Sat Sep');
eq('DATE_FORMAT(NULL, names) is NULL', one("SELECT DATE_FORMAT(NULL, '%d %b %Y')"), null);
// HAVING with no GROUP BY and no aggregate filters rows and can name an alias.
exec('CREATE TABLE people (id INT PRIMARY KEY, fn VARCHAR(20), ln VARCHAR(20), off TINYINT)');
exec("INSERT INTO people VALUES (1, 'Al', 'Bo', 0), (2, 'Cy', 'Dee', 0), (3, 'Al', 'Zed', 1)");
eq('HAVING alias with no GROUP BY', rows("SELECT id, CONCAT_WS(' ', fn, ln) AS full FROM people WHERE off = 0 OR id = 3 HAVING full LIKE ? ORDER BY id DESC LIMIT 5", ['Al%']), [{ id: 3, full: 'Al Zed' }, { id: 1, full: 'Al Bo' }]);
eq('HAVING on an aggregate with no GROUP BY', rows('SELECT COUNT(*) AS n FROM people HAVING n > ?', [2]), [{ n: 3 }]);
refused('GROUP_CONCAT(DISTINCT x SEPARATOR s) goes to MariaDB', "SELECT GROUP_CONCAT(DISTINCT label SEPARATOR '; ') FROM stats");

// No exact SQLite form: refused, never answered differently.
refused('DATE_FORMAT with a day-of-month suffix', "SELECT DATE_FORMAT('2024-03-05', '%D %M')");
refused('TIMESTAMPDIFF(MONTH, ...)', "SELECT TIMESTAMPDIFF(MONTH, '2024-01-31', '2024-02-29')");
refused('INTERVAL with a compound unit', "SELECT DATE_ADD('2024-01-01', INTERVAL '1:30' HOUR_MINUTE)");
refused('CONVERT_TZ', "SELECT CONVERT_TZ('2024-01-01 00:00:00', '+00:00', '+02:00')");
refused('a DIV b', 'SELECT 7 DIV 2');
check('\\0 in a literal is refused, not stored as 0', (() => { try { dialect.translate("SELECT 'a\\0b'"); return false; } catch (e) { return /NUL/.test(e.message); } })());
check('placeholder count survives every translation', markErrors.length === 0, markErrors.join(' | '));

// The engine: a read SQLite refuses goes to MariaDB; a write does not.
(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-market-'));
    const mariaFile = path.join(dir, 'maria.sqlite');
    const m = new DatabaseSync(mariaFile);
    m.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL, meta TEXT); INSERT INTO notes (body, meta) VALUES ('hello', '{\"isdead\":false,\"jailed\":true,\"n\":3}');");
    m.close();
    process.env.FX_RES_DIR = dir;
    process.env.FX_MARIA_FILE = mariaFile;
    const fx = require('../harness/fx.js');
    const r = fx.registry;
    const call = (k, sql, p) => new Promise((res) => r[k](sql, p || [], (v, err) => res({ v: err ? false : v, err }), 'test', true));
    await fx.ready(20000);

    // maria_only exists on the fake MariaDB only (tests/harness/fx.js).
    const q1 = await call('query', 'SELECT maria_only(body) AS v FROM notes', []);
    check('a read SQLite cannot run is answered by MariaDB', !q1.err && JSON.stringify(q1.v) === '[{"v":"maria:hello"}]', JSON.stringify(q1));
    const q2 = await call('scalar', 'SELECT maria_only(body) AS v FROM notes', []);
    check('... again, from the remembered route, as a scalar', !q2.err && q2.v === 'maria:hello', JSON.stringify(q2));
    const w = await call('update', 'UPDATE notes SET body = maria_only(body)', []);
    const mariaBody = (() => { const x = new DatabaseSync(mariaFile); const b = x.prepare('SELECT body FROM notes').get().body; x.close(); return b; })();
    const sqliteBody = await call('scalar', 'SELECT body FROM notes', []);
    check('a write SQLite cannot run fails for its caller', w.err && w.v === false, JSON.stringify(w));
    check('... and reaches neither database', mariaBody === 'hello' && sqliteBody.v === 'hello', 'maria=' + mariaBody + ' sqlite=' + sqliteBody.v);
    const bad = await call('query', 'SELECT no_such_fn(body) FROM notes', []);
    check('a read neither can run returns an error, not nil and not a crash', bad.v === false && typeof bad.err === 'string' && bad.err.length > 0, JSON.stringify(bad));
    const up2 = await call('update', 'UPDATE notes SET body = "world" WHERE id = 1', []);
    const after = await call('scalar', 'SELECT body FROM notes WHERE id = 1', []);
    check('"world" in a caller UPDATE is stored as text', !up2.err && up2.v === 1 && after.v === 'world', JSON.stringify([up2, after]));

    // JSON booleans reach the caller as booleans, so false is false in Lua.
    const js = await call('scalar', "SELECT JSON_EXTRACT(meta, '$.isdead') FROM notes", []);
    check('scalar JSON_EXTRACT of false is false', !js.err && js.v === false, JSON.stringify(js));
    const jr = await call('single', "SELECT JSON_EXTRACT(meta, '$.isdead') AS dead, meta->'$.jailed' AS jailed, JSON_EXTRACT(meta, '$.n') AS n FROM notes", []);
    check('single row: false, true and a number', !jr.err && jr.v && jr.v.dead === false && jr.v.jailed === true && jr.v.n === 3, JSON.stringify(jr));
    const jq = await call('query', "SELECT id, JSON_EXTRACT(meta, '$.jailed') AS jailed FROM notes", []);
    check('query rows: true', !jq.err && JSON.stringify(jq.v) === '[{"id":1,"jailed":true}]', JSON.stringify(jq));
    const jp = await call('prepare', "SELECT JSON_EXTRACT(meta, '$.isdead') FROM notes WHERE id = ?", [1]);
    check('prepare of one column: false', !jp.err && jp.v === false, JSON.stringify(jp));
    const jw = await call('scalar', "SELECT COUNT(*) FROM notes WHERE JSON_EXTRACT(meta, '$.jailed') = true AND JSON_EXTRACT(meta, '$.isdead') = false", []);
    check('WHERE ... = true / = false still match', !jw.err && jw.v === 1, JSON.stringify(jw));

    // MariaDB names a column as the SELECT spells it (ox_mdt: stateId on a
    // column declared stateid); SQLite used the declared spelling.
    await call('query', 'CREATE TABLE spell (stateid VARCHAR(7), Fine INT)', []);
    await call('insert', "INSERT INTO spell VALUES ('A1', 5)", []);
    const sp = await call('single', 'SELECT stateId, s.fine, `FINE` + 0 AS total FROM spell s', []);
    check('a result column is named as the SELECT spells it', !sp.err && JSON.stringify(sp.v) === '{"stateId":"A1","fine":5,"total":5}', JSON.stringify(sp));

    // An expression column is named after its text as written, as MariaDB
    // names it; VERSION() says MariaDB (esx_lib picks its DEFAULT format by it).
    const named = await call('single', 'SELECT COUNT(`stateid`), IFNULL(Fine, 0), VERSION() FROM spell', []);
    check('expression columns keep the caller text as their name', !named.err && named.v && named.v['COUNT(`stateid`)'] === 1
        && named.v['IFNULL(Fine, 0)'] === 5 && /MariaDB/.test(named.v['VERSION()']), JSON.stringify(named));
    const bin = await call('scalar', "SELECT COUNT(*) FROM spell WHERE BINARY stateid = 'a1'", []);
    const binCi = await call('scalar', "SELECT COUNT(*) FROM spell WHERE stateid = 'A1'", []);
    const coll = await call('scalar', "SELECT COUNT(*) FROM spell WHERE stateid COLLATE utf8mb4_bin = 'A1'", []);
    check('BINARY x and COLLATE x_bin compare byte for byte', bin.v === 0 && binCi.v === 1 && coll.v === 1, JSON.stringify([bin, binCi, coll]));

    // UPDATE ... JOIN ... ON x = ? SET y = ?: the ON clause moves after SET in
    // SQLite, and each value must still reach its own ? (esx_vehicleshop).
    await call('query', 'CREATE TABLE acct (name VARCHAR(20), owner VARCHAR(20), money INT)', []);
    await call('query', 'CREATE TABLE pay (op VARCHAR(20), amount INT)', []);
    await call('insert', "INSERT INTO acct VALUES ('dealer', NULL, 0)", []);
    await call('insert', "INSERT INTO pay VALUES ('op1', 50)", []);
    const ju = await call('update', "UPDATE acct a JOIN pay p ON p.op = ? SET a.money = a.money + p.amount + ? WHERE a.name = 'dealer' AND a.owner IS NULL", ['op1', 7]);
    const money = await call('scalar', "SELECT money FROM acct WHERE name = 'dealer'", []);
    check('UPDATE ... JOIN ... ON x = ? SET y = ? keeps each value on its own ?', ju.v === 1 && money.v === 57, JSON.stringify([ju, money]));

    // A table with no AUTO_INCREMENT key reports insert id 0, as MariaDB does.
    const noKey = await call('insert', "INSERT INTO spell VALUES ('B2', 1)", []);
    const noKeyQ = await call('query', "INSERT INTO spell VALUES ('B3', 1)", []);
    check('insert into a table with no numbered key returns id 0', noKey.v === 0 && noKeyQ.v && noKeyQ.v.insertId === 0, JSON.stringify([noKey, noKeyQ.v]));

    // A JS Date param is stored as mysql2 sends it: local time, whole seconds.
    await call('query', 'CREATE TABLE stamps (at DATETIME)', []);
    await call('insert', 'INSERT INTO stamps (at) VALUES (?)', [new Date(2026, 0, 5, 10, 4, 5, 678)]);
    const at = await call('scalar', "SELECT COUNT(*) FROM stamps WHERE at = '2026-01-05 10:04:05'", []);
    check('a Date param is stored as local YYYY-MM-DD HH:MM:SS', at.v === 1, JSON.stringify(await call('scalar', 'SELECT at FROM stamps', [])));

    // ON DUPLICATE KEY UPDATE: 1 for an inserted row, 2 for an updated one.
    await call('query', 'CREATE TABLE odku (k VARCHAR(10) PRIMARY KEY, v INT)', []);
    const odku = 'INSERT INTO odku (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)';
    const o1 = await call('query', odku, ['a', 1]);
    const o2 = await call('query', odku, ['a', 2]);
    const o3 = await call('update', odku, ['a', 3]);
    check('ON DUPLICATE KEY UPDATE affects 1 inserting, 2 updating', o1.v && o1.v.affectedRows === 1 && o2.v && o2.v.affectedRows === 2 && o3.v === 2,
        JSON.stringify([o1.v && o1.v.affectedRows, o2.v && o2.v.affectedRows, o3.v]));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    setTimeout(() => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows keeps the file open */ }
        process.exit(failed ? 1 : 0);
    }, 200);
})().catch((e) => { console.log('FAIL engine ' + e.stack); process.exit(1); });
