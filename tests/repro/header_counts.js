'use strict';

// A write through query or rawExecute answers with mysql2's header, as
// oxmysql hands it over. An UPDATE's header names the rows it changed
// (changedRows) and says so in info, as MariaDB's "Rows matched: 1
// Changed: 1  Warnings: 0". cis always answered changedRows 0 and info '',
// so a script that read changedRows saw no change.
// Usage: node tests/repro/header_counts.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-header-'));
process.env.FX_RES_DIR = dir;
process.env.FX_REAL_MARIA = '1';
process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: '' });

const fx = require('../harness/fx.js');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

(async () => {
    check('engine ready', await fx.ready(20000));
    await fx.call('query', 'CREATE TABLE h (id INTEGER PRIMARY KEY, v INT)');
    await fx.call('query', 'INSERT INTO h (id, v) VALUES (1, 1), (2, 1), (3, 5)');

    const up = await fx.call('query', 'UPDATE h SET v = 2 WHERE v = ?', [1]);
    check('UPDATE header: affectedRows 2', up && up.affectedRows === 2, JSON.stringify(up));
    check('UPDATE header: changedRows 2', up && up.changedRows === 2, JSON.stringify(up));
    check('UPDATE header: info names matched and changed rows', up && up.info === 'Rows matched: 2  Changed: 2  Warnings: 0', JSON.stringify(up));

    const raw = await fx.call('rawExecute', 'UPDATE h SET v = 3 WHERE id = ?', [3]);
    check('rawExecute UPDATE header too', raw && raw.changedRows === 1 && raw.info === 'Rows matched: 1  Changed: 1  Warnings: 0', JSON.stringify(raw));

    const del = await fx.call('query', 'DELETE FROM h WHERE id = ?', [3]);
    check('DELETE header: changedRows 0, info empty, as MariaDB', del && del.affectedRows === 1 && del.changedRows === 0 && del.info === '', JSON.stringify(del));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
