'use strict';

// UUID() and UUID_SHORT(). The engine had neither: ND_MDT's
// ALTER TABLE user_licenses ... ADD COLUMN identifier ... DEFAULT UUID_SHORT()
// failed, so the column was missing and every later INSERT naming it failed
// too. MariaDB 10.11.19 gives UUID() as a version 1 UUID (36 characters, a
// new one per call) and UUID_SHORT() as a 64-bit integer one higher per call;
// an ADD COLUMN with either as default fills each row with its own value. The
// rule keys on the function, not the table; the tables here are made up.
// Usage: node tests/repro/uuid_functions.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-uuid-'));
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

const V1 = /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

(async () => {
    await fx.ready(20000);
    let row = await call('single', 'SELECT UUID() AS a, UUID() AS b');
    check('UUID() is a version 1 UUID, a new one per call', row && V1.test(row.a) && V1.test(row.b) && row.a !== row.b, JSON.stringify(row));
    row = await call('single', 'SELECT UUID_SHORT() AS a, UUID_SHORT() AS b');
    check('UUID_SHORT() goes up by one per call', row && BigInt(row.b) - BigInt(row.a) === 1n && BigInt(row.a) > 2n ** 53n, JSON.stringify(row));

    // The ND_MDT sample: ADD COLUMN ... DEFAULT UUID_SHORT() and a unique index.
    await call('query', 'CREATE TABLE `permits` (`id` int NOT NULL AUTO_INCREMENT, `type` varchar(60) NOT NULL, `owner` varchar(60) NOT NULL, PRIMARY KEY (`id`))');
    await call('query', "INSERT INTO permits (type, owner) VALUES ('drive', 'a'), ('weapon', 'a')");
    let h = await call('query', "ALTER TABLE `permits` ADD COLUMN `status` VARCHAR(10) NOT NULL DEFAULT 'valid' AFTER `owner`, ADD COLUMN `issued` TIMESTAMP NOT NULL DEFAULT current_timestamp() AFTER `type`, ADD COLUMN `identifier` VARCHAR(50) NOT NULL DEFAULT UUID_SHORT() AFTER `issued`, ADD UNIQUE INDEX `identifier` (`identifier`)");
    check('ALTER ... DEFAULT UUID_SHORT() with a unique index runs', !(h && h.err), JSON.stringify(h));
    const rows = await call('query', 'SELECT id, identifier FROM permits ORDER BY id');
    check('each row it had got its own value', rows.length === 2 && rows[0].identifier && rows[0].identifier !== rows[1].identifier, JSON.stringify(rows));
    h = await call('query', 'INSERT IGNORE INTO `permits` (`id`, `type`, `issued`, `identifier`, `owner`, `status`) VALUES (?, ?, ?, ?, ?, ?)', [9, 'boat', '2024-01-01 00:00:00', 'X1', 'b', 'valid']);
    check('an INSERT naming the new columns runs', h && h.affectedRows === 1, JSON.stringify(h));
    id = await call('insert', "INSERT INTO permits (type, owner) VALUES ('fly', 'c')");
    const nw = await call('scalar', 'SELECT identifier FROM permits WHERE id = ?', [id]);
    check('a new row gets a fresh value from the default', nw && nw !== rows[1].identifier && nw !== 'X1', JSON.stringify([id, nw]));

    // Variant: UUID() as a CHAR(36) default in CREATE TABLE.
    await call('query', 'CREATE TABLE `tokens` (`id` INT AUTO_INCREMENT PRIMARY KEY, `tok` CHAR(36) NOT NULL DEFAULT (UUID()))');
    await call('query', 'INSERT INTO tokens (id) VALUES (NULL), (NULL)');
    const tk = await call('query', 'SELECT tok FROM tokens ORDER BY id');
    check('CREATE ... DEFAULT (UUID()): each row its own', tk.length === 2 && V1.test(tk[0].tok) && tk[0].tok !== tk[1].tok, JSON.stringify(tk));

    // A whole number past 2^53 read back: mysql2 with supportBigNumbers (as
    // oxmysql runs it) gives a decimal string, a safe one stays a number. The
    // engine threw "Value is too large" for any such read.
    await call('query', 'CREATE TABLE `members` (`id` INT AUTO_INCREMENT PRIMARY KEY, `discord` BIGINT UNSIGNED, `n` BIGINT)');
    await call('query', 'INSERT INTO members (discord, n) VALUES (?, 5), (?, 6)', ['1234567890123456789', '987654321098765432']);
    const big = await call('query', 'SELECT discord, n FROM members ORDER BY id');
    check('BIGINT past 2^53 reads as its exact string, a small one as a number', Array.isArray(big) && big[0].discord === '1234567890123456789' && big[1].discord === '987654321098765432' && big[0].n === 5, JSON.stringify(big));
    const one = await call('scalar', 'SELECT discord FROM members WHERE n = ?', [6]);
    check('scalar of a big BIGINT is its exact string', one === '987654321098765432', JSON.stringify(one));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' failed' : 'all passed');
    process.exit(failed ? 1 : 0);
})();
var id;
