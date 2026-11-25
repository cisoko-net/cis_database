'use strict';

// SQLite-only indexes for SELECTs that read a whole table (server.js,
// noteSlowRead / adviseIndex): created after three slow calls, used by
// SQLite's plan, never sent to MariaDB, hidden from SHOW INDEX and
// information_schema, the same rows before and after, and out of the way of
// ALTER TABLE.
// Usage: node tests/repro/auto_index.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-autoidx-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec(`CREATE TABLE players (citizenid VARCHAR(16) PRIMARY KEY, phone VARCHAR(16), bank INT NOT NULL, notes TEXT);
CREATE TABLE small (id INT PRIMARY KEY, v INT)`);
const ins = m.prepare('INSERT INTO players VALUES (?, ?, ?, ?)');
m.exec('BEGIN');
for (let i = 0; i < 60000; i++) ins.run('C' + i, '555' + i, (i * 7919) % 100000, 'x'.repeat(200));
m.exec('COMMIT');
m.close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;
// A low threshold so the test does not depend on how fast this machine scans.
process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: 'mysql://root@127.0.0.1/fake', cis_database_cdc: '0', cis_database_auto_index_ms: '0.5', cis_database_debug: process.env.DBG || '0' });

const fx = require('../harness/fx.js');

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const q = (sql, p) => fx.call('query', sql, p || []);
const sqlite = () => new DatabaseSync(path.join(dir, 'cache', 'durable.sqlite'));
const autoIndexes = () => {
    const db = sqlite();
    const rows = db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE '__cis_auto_%'").all();
    db.close();
    return rows;
};

async function timed(sql, p) {
    const t0 = performance.now();
    const rows = await q(sql, p);
    return { rows, ms: performance.now() - t0 };
}

(async () => {
    if (!(await fx.ready(30000))) throw new Error('not ready');
    const RICH = 'SELECT citizenid, bank FROM players ORDER BY bank DESC LIMIT 10';
    const before = [];
    for (let i = 0; i < 4; i++) before.push(await timed(RICH));
    await sleep(200);
    const idx = autoIndexes();
    check('a leaderboard that read the whole table gets an index on its ORDER BY column', idx.some((x) => /\(\s*"bank"\s*\)/.test(x.sql)), JSON.stringify(idx.map((x) => x.sql)));
    const after = await timed(RICH);
    check('it returns the same rows', JSON.stringify(after.rows) === JSON.stringify(before[0].rows));
    check('and is faster', after.ms < before[0].ms, before[0].ms.toFixed(2) + ' ms -> ' + after.ms.toFixed(2) + ' ms');

    const PHONE = 'SELECT citizenid FROM players WHERE phone = ?';
    const want = await q(PHONE, ['5554242']);
    for (let i = 0; i < 4; i++) await q(PHONE, ['555' + (1000 + i)]);
    await sleep(200);
    check('a lookup on an unindexed column gets an index on it', autoIndexes().some((x) => /\(\s*"phone"\s*\)/.test(x.sql)));
    check('same rows after', JSON.stringify(await q(PHONE, ['5554242'])) === JSON.stringify(want), JSON.stringify(want));

    for (let i = 0; i < 6; i++) await q('SELECT COUNT(*) AS n FROM players');
    for (let i = 0; i < 6; i++) await q('SELECT * FROM small WHERE v = ?', [1]);
    await sleep(200);
    check('no index for a query with nothing to index, or a fast one', autoIndexes().length === 2, autoIndexes().map((x) => x.name).join(', '));

    const maria = new DatabaseSync(mariaFile);
    const mariaIdx = maria.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '__cis_%'").all();
    maria.close();
    check('nothing reached MariaDB', mariaIdx.length === 0, JSON.stringify(mariaIdx));
    const shown = await q('SHOW INDEX FROM players');
    check('SHOW INDEX does not list them', !JSON.stringify(shown).includes('__cis_'), JSON.stringify(shown));
    const info = await q("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_NAME = 'players'");
    check('information_schema.STATISTICS does not list them', !JSON.stringify(info).includes('__cis_'), JSON.stringify(info));
    let refused = '';
    try { await fx.registry.query('DROP INDEX __cis_auto_players_bank', []); } catch (e) { refused = e.message; }
    const stillThere = autoIndexes().length === 2;
    check('a caller cannot drop one', stillThere, refused);

    const alter = await q('ALTER TABLE players DROP COLUMN bank');
    check('ALTER TABLE DROP COLUMN on an indexed column still works', alter && alter.affectedRows !== undefined && !autoIndexes().some((x) => /bank/.test(x.sql)), JSON.stringify(alter));
    const cols = await q('SELECT * FROM players LIMIT 1');
    check('the column is gone', cols.length === 1 && !('bank' in cols[0]), JSON.stringify(Object.keys(cols[0] || {})));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + e.stack); process.exit(1); });
