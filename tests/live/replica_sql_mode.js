'use strict';

// Security review F1/S2, against a real MariaDB. Not part of npm test: it
// needs a server and creates, then drops, its own scratch database.
//
// A replica whose sql_mode has NO_BACKSLASH_ESCAPES (set on its session
// here, as a my.cnf could set it globally) is sent an outbox-style batch:
// mysql2's client-side format of a player string, on a multipleStatements
// connection. Without the session fix the string ends early and a second
// statement drops a table. With REPLICA_SESSION_SQL, lifted from server.js
// and run first as the pools run it, the string is stored as one value.
//
// Usage (root over the unix socket, as on the Cisoko box):
//   node tests/live/replica_sql_mode.js
// Or with a DSN for a user that may create and drop databases:
//   CIS_LIVE_DSN=mysql://user:pass@127.0.0.1:3306 node tests/live/replica_sql_mode.js

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
const m = /const REPLICA_SESSION_SQL = ("[^"]*")\s*\+\s*("[^"]*");/.exec(src);
if (!m) throw new Error('REPLICA_SESSION_SQL not found in server.js');
const REPLICA_SESSION_SQL = JSON.parse(m[1]) + JSON.parse(m[2]);

const DB = 'cis_f1_probe_' + process.pid;
const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

function base() {
    const dsn = process.env.CIS_LIVE_DSN;
    if (!dsn) return { socketPath: process.env.CIS_LIVE_SOCKET || '/run/mysqld/mysqld.sock', user: 'root' };
    const u = new URL(dsn);
    return { host: u.hostname, port: Number(u.port) || 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

async function tableExists(admin, name) {
    const [rows] = await admin.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?', [DB, name]);
    return Number(rows[0].n) === 1;
}

// One outbox flush as server.js sends it: formatted statements joined into
// one multi-statement query. preMode is the replica's configured sql_mode.
async function flushAs(preMode, guard) {
    const conn = await mysql.createConnection(Object.assign(base(), { database: DB, multipleStatements: true, charset: 'utf8mb4' }));
    try {
        await conn.query('SET SESSION sql_mode = ?', [preMode]);
        if (guard) await conn.query(REPLICA_SESSION_SQL);
        const [[mode]] = await conn.query('SELECT @@SESSION.sql_mode AS m');
        const evil = "x\\'); DROP TABLE victim; -- ";
        const sql = [conn.format('INSERT INTO players (name) VALUES (?)', [evil]), conn.format('SELECT ?', [1])].join('\n;\n');
        let err = null;
        try { await conn.query(sql); } catch (e) { err = e.message; }
        return { mode: mode.m, err, evil };
    } finally {
        await conn.end();
    }
}

(async () => {
    const admin = await mysql.createConnection(base());
    const [[v]] = await admin.query('SELECT VERSION() AS v');
    console.log('server ' + v.v);
    try {
        const reset = async () => {
            await admin.query('DROP DATABASE IF EXISTS `' + DB + '`');
            await admin.query('CREATE DATABASE `' + DB + '`');
            await admin.query('CREATE TABLE `' + DB + '`.players (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(200))');
            await admin.query('CREATE TABLE `' + DB + '`.victim (id INT)');
        };

        await reset();
        const red = await flushAs('STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES', false);
        const redDropped = !(await tableExists(admin, 'victim'));
        console.log('without the fix: session ' + red.mode + (red.err ? ', error ' + red.err : ''));
        check('control: without the fix a player string drops a table under NO_BACKSLASH_ESCAPES', redDropped);

        await reset();
        const green = await flushAs('STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES', true);
        const [rows] = await admin.query('SELECT name FROM `' + DB + '`.players');
        check('with REPLICA_SESSION_SQL the session drops NO_BACKSLASH_ESCAPES', !/NO_BACKSLASH_ESCAPES/.test(green.mode), green.mode);
        check('with REPLICA_SESSION_SQL the table survives', await tableExists(admin, 'victim'), green.err || '');
        check('with REPLICA_SESSION_SQL the player string is stored as one value', rows.length === 1 && rows[0].name === green.evil, JSON.stringify(rows));
        check('the rest of the mode is kept', /STRICT_TRANS_TABLES/.test(green.mode), green.mode);

        await reset();
        const ansi = await flushAs('ANSI,STRICT_TRANS_TABLES', true);
        check('ANSI and ANSI_QUOTES are dropped', !/(^|,)ANSI(_QUOTES)?(,|$)/.test(ansi.mode), ansi.mode);

        await reset();
        const plain = await flushAs('', true);
        check('an empty sql_mode stays valid', plain.err === null && plain.mode === '', JSON.stringify(plain.mode));

        // S3: replicaSqlText turns "..." into '...' and drops comments. The
        // rewritten text must read the same values as the original.
        const body = ['placeholderOffsets', 'replicaSqlText'].map((name) => {
            const i = src.indexOf('function ' + name + '(');
            let d = 0;
            let j = src.indexOf('{', i);
            for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; }
            return src.slice(i, j + 1);
        }).join('\n');
        // eslint-disable-next-line no-new-func
        const replicaSqlText = new Function(body + '\nreturn replicaSqlText;')();
        const conn = await mysql.createConnection(Object.assign(base(), { database: DB }));
        try {
            await conn.query(REPLICA_SESSION_SQL);
            const texts = ['SELECT "it\'s ?" AS a, "say ""hi""" AS b, "a\\"b\\\\c" AS c, \'x?\' AS d # why?\n',
                'SELECT 1 /* ? */ AS a, 2 -- ?\n + 3 AS b', 'SELECT "\\n\\t%_" AS a, "" AS b'];
            for (const t of texts) {
                const [x] = await conn.query(t);
                const [y] = await conn.query(replicaSqlText(t));
                check('rewritten text reads the same: ' + JSON.stringify(t), JSON.stringify(x) === JSON.stringify(y), JSON.stringify(y));
            }
        } finally {
            await conn.end();
        }
    } finally {
        await admin.query('DROP DATABASE IF EXISTS `' + DB + '`');
        await admin.end();
    }
    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
