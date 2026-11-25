'use strict';

// qbx_management (server/storage.lua) creates player_jobs_activity with a
// foreign key to qbx_core's players (citizenid, its PRIMARY KEY), ON DELETE
// CASCADE. With players hydrated from MariaDB the table must be created on
// both sides and the key must hold in SQLite. The refusal "no SQLite form
// for a foreign key to players" is only right when players does not exist,
// where MariaDB refuses the key too (errno 150); see mysql2_missing.js for
// the boot that hit it.
// Usage: node tests/repro/qbx_fk.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-qbxfk-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE players (id INTEGER, citizenid VARCHAR(50) NOT NULL PRIMARY KEY, license VARCHAR(255) NOT NULL)');
m.exec("INSERT INTO players VALUES (1, 'ABC123', 'license:a'), (2, 'DEF456', 'license:b')");
m.close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;

const fx = require('../harness/fx.js');
const r = fx.registry;

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const q = (sql, p) => fx.call('query', sql, p || []);

// qbx_management storage.lua, createActivityTable, as shipped.
const CREATE = `
        CREATE TABLE IF NOT EXISTS \`player_jobs_activity\` (
            \`id\` int UNSIGNED NOT NULL AUTO_INCREMENT,
            \`citizenid\` VARCHAR(50) COLLATE utf8mb4_unicode_ci,
            \`job\` varchar(255) NOT NULL,
            \`last_checkin\` int NOT NULL,
            \`last_checkout\` int NULL DEFAULT NULL,
            FOREIGN KEY (\`citizenid\`) REFERENCES \`players\` (\`citizenid\`) ON DELETE CASCADE,
            PRIMARY KEY (\`id\`) USING BTREE,
            INDEX \`id\` (\`id\` DESC) USING BTREE,
            INDEX \`last_checkout\` (\`last_checkout\` ASC) USING BTREE,
            INDEX \`citizenid_job\` (\`citizenid\`, \`job\`) USING BTREE
        ) ENGINE = InnoDB AUTO_INCREMENT = 1 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_general_ci;
    `;

async function drained(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end && r.probe().replica > 0) await sleep(20);
    return r.probe().replica === 0;
}

(async () => {
    check('engine ready', await fx.ready(20000));
    const made = await q(CREATE);
    check('CREATE TABLE with the foreign key to players succeeds', made !== false && made != null, JSON.stringify(made));
    const ok = await fx.call('insert', 'INSERT INTO `player_jobs_activity` (`citizenid`, `job`, `last_checkin`, `last_checkout`) VALUES (?, ?, ?, ?)', ['ABC123', 'police', 100, 200]);
    check('a row for an existing citizenid inserts', ok === 1, JSON.stringify(ok));
    const orphan = await fx.call('insert', 'INSERT INTO `player_jobs_activity` (`citizenid`, `job`, `last_checkin`, `last_checkout`) VALUES (?, ?, ?, ?)', ['NOPE00', 'police', 100, 200]);
    check('a row for a citizenid players lacks is refused', orphan == null || orphan === false || orphan === 0, JSON.stringify(orphan));
    await q('DELETE FROM `players` WHERE `citizenid` = ?', ['ABC123']);
    const left = await q('SELECT COUNT(*) AS n FROM `player_jobs_activity`');
    check('deleting the player cascades', left && left[0] && Number(left[0].n) === 0, JSON.stringify(left));
    if (r.flushReplica) fx.asSelf(() => r.flushReplica());
    // The fake MariaDB is SQLite and cannot run MySQL DDL, so the copy of the
    // CREATE is checked on a live qbox, not here; the queue must still drain.
    check('the MariaDB queue drains', await drained(10000), 'replica=' + r.probe().replica);
    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
