'use strict';

// Run every corpus statement twice and compare the answers: once through the
// engine (server.js booted by tests/harness/fx.js, SQLite with a real MariaDB
// replica) and once on MariaDB itself through mysql2 with oxmysql's own pool
// options and typeCast. Same schema, same seeded rows, same params, same order.
//
// Needs a local MariaDB 10.11 with root and no password (default
// 127.0.0.1:3307, --maria to change). It creates and drops the databases
// cm_ref and cm_eng there; never point it at a database that matters.
//
// Per repository: the databases start empty. Its own DDL runs, then the DDL
// of the corpus for the tables its statements name (errors ignored), then three
// rows are seeded in every table, typed by column. Then each statement runs on
// both sides. Params are filled from context: `col = ?` and an INSERT's column
// list take that column's seeded value, LIMIT takes 10, the rest 1. Named
// placeholders are made positional first, as the engine does.
//
// A statement matches when both sides fail, or both answer the same: rows
// compared sorted (Date as ms, BigInt as number), writes by affectedRows and
// insertId.
// Usage: node tests/corpus/match.js [--repos list.json] [--only owner/name]
//        [--json out.json] [--samples N] [--maria host:port]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const MARIA = opt('--maria', '127.0.0.1:3307');
const [HOST, PORT] = MARIA.split(':');
const REF = 'cm_ref';
const ENG = 'cm_eng';

const DDL = /^\s*(CREATE|ALTER|DROP|TRUNCATE|RENAME)\b/i;
const { positional } = require('./translate.js');

// The values the API gives for each column type (tests/harness/result_cast.js).
const typeCast = require('../harness/result_cast.js').makeQueryCast({ bitBy: 'field' });

async function connect(db) {
    const mysql = require('mysql2/promise');
    return mysql.createConnection({
        host: HOST, port: Number(PORT), user: 'root', database: db, multipleStatements: false,
        supportBigNumbers: true, jsonStrings: true, typeCast, namedPlaceholders: false, charset: 'utf8mb4_general_ci',
    });
}

// The tables a statement names, by shape: after FROM, JOIN, INTO, UPDATE, TABLE.
function tablesOf(sql) {
    const out = new Set();
    const re = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?)\s+`?(\w+)`?/gi;
    let m;
    while ((m = re.exec(sql))) out.add(m[1].toLowerCase());
    return out;
}

// One seeded value for a column, row n (1..3).
function seedValue(c, n) {
    const t = c.data_type;
    if (c.column_type === 'tinyint(1)') return n % 2;
    if (/int$/.test(t)) return n;
    if (/^(decimal|float|double)$/.test(t)) return n + 0.5;
    if (/^(datetime|timestamp)$/.test(t)) return '2026-01-0' + n + ' 10:00:00';
    if (t === 'date') return '2026-01-0' + n;
    if (t === 'time') return '10:00:0' + n;
    if (t === 'year') return 2020 + n;
    if (t === 'enum' || t === 'set') { const m = /^\w+\('((?:[^']|'')*)'/.exec(c.column_type); return m ? m[1].replace(/''/g, "'") : ''; }
    if (t === 'bit') return n % 2;
    if (/text|json/.test(t)) return '{"k":' + n + '}';
    const v = 'v' + n;
    return c.max_len ? v.slice(0, Math.max(1, c.max_len)) : v;
}

// The ? marks outside strings and comments, each with the text before it.
function marksOf(sql) {
    const out = [];
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (ch === "'" || ch === '"' || ch === '`') {
            for (i++; i < sql.length && sql[i] !== ch; i++) if (sql[i] === '\\') i++;
        } else if (ch === '-' && sql[i + 1] === '-') {
            while (i < sql.length && sql[i] !== '\n') i++;
        } else if (ch === '/' && sql[i + 1] === '*') {
            const e = sql.indexOf('*/', i + 2);
            i = e < 0 ? sql.length : e + 1;
        } else if (ch === '?') {
            out.push(i);
        }
    }
    return out;
}

function paramsFor(sql, cols) {
    const marks = marksOf(sql);
    if (!marks.length) return [];
    const val = (name) => {
        const c = cols.get(String(name).toLowerCase());
        return c ? seedValue(c, 1) : 1;
    };
    // INSERT ... (a, b, c) VALUES (?, ?, ?): position in the column list.
    const ins = /^\s*(?:INSERT|REPLACE)\b[^(]*\(([^)]*)\)\s*VALUES\s*\(/i.exec(sql);
    const insCols = ins ? ins[1].split(',').map((s) => s.trim().replace(/`/g, '')) : null;
    const valuesAt = ins ? ins[0].length : -1;
    return marks.map((at) => {
        const before = sql.slice(Math.max(0, at - 200), at);
        if (/\bLIMIT\s*(\?\s*,\s*)?$|\bOFFSET\s*$/i.test(before)) return 10;
        // A function's argument (FROM_UNIXTIME(?)) is not the column's value.
        if (/\b(?!IN\b|VALUES\b)\w+\s*\(\s*$/i.test(before)) return 1;
        if (insCols && at >= valuesAt) {
            const close = sql.indexOf(')', valuesAt);
            if (close < 0 || at < close) {
                const k = marksOf(sql.slice(valuesAt, at)).length;
                if (k < insCols.length) return val(insCols[k]);
            }
        }
        const m = /`?(\w+)`?\s*(?:=|<>|!=|<=|>=|<|>|\bLIKE|\bIN\s*\(\s*(?:\?\s*,\s*)*)\s*$/i.exec(before);
        if (m) return val(m[1]);
        return 1;
    });
}

const plainify = (v) => {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'bigint') return Number(v);
    if (v instanceof Uint8Array) return [...v];
    if (Array.isArray(v)) return v.map(plainify);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = plainify(v[k]); return o; }
    return v;
};

// A result in a comparable form.
function shape(r) {
    if (r.err !== undefined) return { err: true };
    const v = r.value;
    if (Array.isArray(v)) {
        const rows = v.map((row) => JSON.stringify(plainify(row)));
        rows.sort();
        return { rows };
    }
    if (v && typeof v === 'object' && 'affectedRows' in v) return { affected: Number(v.affectedRows), id: Number(v.insertId || 0) };
    return { value: JSON.stringify(plainify(v)) };
}

// ---- child: the engine side -----------------------------------------------
async function child(jobFile) {
    const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
    const fx = require('../harness/fx.js');
    if (!(await fx.ready(60000))) {
        fs.writeFileSync(job.out, JSON.stringify({ boot: 'engine not ready' }));
        process.exit(0);
    }
    // The export answers with Citizen's async wrapper, as a Lua .await sees it.
    const q = (sql, params) => Promise.race([
        new Promise((res, rej) => fx.registry.query(sql, params || []).__cfx_async_retval((v, e) => (e != null ? rej(new Error(e)) : res(v[0])))),
        new Promise((res, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
    ]);
    const out = { setup: [], results: [] };
    for (const s of job.setup) { try { const v = await q(s.sql, s.params); out.setup.push(s.params.length && v && v.affectedRows === 0 ? "no row" : null); } catch (e) { out.setup.push(String(e.message || e)); } }
    for (const s of job.stmts) {
        const before = fx.registry.probe().maria_reads;
        try { out.results.push({ value: plainify(await q(s.sql, s.params)) }); } catch (e) { out.results.push({ err: String(e.message || e).slice(0, 300) }); }
        if (fx.registry.probe().maria_reads > before) out.results[out.results.length - 1].maria = true;
    }
    fs.writeFileSync(job.out, JSON.stringify(out));
    process.exit(0);
}

// ---- parent: the reference side and the comparison --------------------------
async function main() {
    const { cloneAt, statementsOf } = require('./fetch.js');
    const SAMPLES = Number(opt('--samples', 3));
    const JSON_OUT = opt('--json', null);
    const ONLY = opt('--only', null);
    const repos = JSON.parse(fs.readFileSync(opt('--repos', path.join(__dirname, 'repos.json')), 'utf8'));
    const all = [];
    for (const r of repos) all.push({ repo: r.repo, stmts: statementsOf(cloneAt(r.repo, r.sha).dir, {}) });
    const globalDdl = [];
    for (const r of all) {
        for (const s of r.stmts) {
            const m = /^\s*(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE)\s+`?(\w+)`?/i.exec(s.sql);
            if (m && !/\bDROP\b/i.test(s.sql)) globalDdl.push({ table: m[1].toLowerCase(), sql: s.sql });
        }
    }

    const admin = await connect(undefined);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-match-'));
    let routed = 0, routedBad = 0, reads = 0;
    let total = 0, matched = 0, skipped = 0, bothErr = 0, full = 0, ran = 0, setupDiff = 0;
    const groups = new Map();
    const setupGroups = new Map();
    const perRepo = [];
    for (const r of all) {
        if (ONLY && r.repo !== ONLY) continue;
        ran++;
        for (const d of [REF, ENG]) {
            await admin.query('DROP DATABASE IF EXISTS `' + d + '`');
            await admin.query('CREATE DATABASE `' + d + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');
        }
        const named = new Set();
        for (const s of r.stmts) for (const t of tablesOf(s.sql)) named.add(t);
        const own = r.stmts.filter((s) => DDL.test(s.sql));
        const ownSet = new Set(own.map((s) => s.sql));
        const setupDdl = own.map((s) => s.sql);
        for (const g of globalDdl) if (named.has(g.table) && !ownSet.has(g.sql)) setupDdl.push(g.sql);
        const rest = r.stmts.filter((s) => !DDL.test(s.sql));

        // Schema on the reference first: its columns type the seed and params.
        const ref = await connect(REF);
        const refSetup = [];
        for (const sql of setupDdl) { try { await ref.query(sql); refSetup.push(null); } catch (e) { refSetup.push(String(e.message)); } }
        const [colRows] = await ref.query(
            'SELECT table_name AS t, column_name AS c, data_type, column_type, extra, character_maximum_length AS max_len FROM information_schema.columns WHERE table_schema = ? ORDER BY table_name, ordinal_position', [REF]);
        const cols = new Map();
        const byTable = new Map();
        for (const c of colRows) {
            c.data_type = String(c.data_type).toLowerCase();
            c.column_type = String(c.column_type).toLowerCase();
            c.max_len = c.max_len == null ? null : Number(c.max_len);
            if (!cols.has(c.c.toLowerCase())) cols.set(c.c.toLowerCase(), c);
            // AUTO_INCREMENT columns get explicit ids, so a parent-only table
            // still has rows for its children to point at.
            if (/generated|virtual|persistent|stored/i.test(c.extra || '')) continue;
            if (!byTable.has(c.t)) byTable.set(c.t, []);
            byTable.get(c.t).push(c);
        }
        // Parents before children: a row whose foreign key fails is dropped by
        // INSERT IGNORE, and MariaDB spends an AUTO_INCREMENT id on it anyway.
        const [fkRows] = await ref.query(
            'SELECT table_name AS t, referenced_table_name AS p FROM information_schema.key_column_usage WHERE table_schema = ? AND referenced_table_name IS NOT NULL', [REF]);
        const parents = new Map();
        for (const f of fkRows) { if (!parents.has(f.t)) parents.set(f.t, new Set()); if (f.p !== f.t) parents.get(f.t).add(f.p); }
        const order = [];
        const placed = new Set();
        const place = (t, depth) => {
            if (placed.has(t) || depth > 50) return;
            placed.add(t);
            for (const p of parents.get(t) || []) place(p, depth + 1);
            order.push(t);
        };
        for (const t of byTable.keys()) place(t, 0);
        const seed = [];
        for (const t of order) {
            const cs = byTable.get(t);
            if (!cs) continue;
            if (t.startsWith('__cis')) continue;
            for (let n = 1; n <= 3; n++) {
                seed.push({ sql: 'INSERT IGNORE INTO `' + t + '` (' + cs.map((c) => '`' + c.c + '`').join(', ') + ') VALUES (' + cs.map(() => '?').join(', ') + ')', params: cs.map((c) => seedValue(c, n)) });
            }
        }
        const stmts = [];
        for (const s of own) stmts.push({ s, sql: s.sql, params: [] });
        for (const s of rest) {
            // Named placeholders become ? on both sides, as the engine and
            // oxmysql's named-placeholders do before anything else.
            const sql = positional(s.sql);
            if (sql !== s.sql) skipped++;
            stmts.push({ s, sql, params: paramsFor(sql, cols) });
        }

        // Engine side: a fresh resource dir, booting against the empty cm_eng.
        // The repo's DDL runs again there (it is the first statements), the
        // corpus DDL and the seed run as setup.
        const resDir = fs.mkdtempSync(path.join(tmp, 'res-'));
        const jobFile = path.join(resDir, 'job.json');
        const outFile = path.join(resDir, 'out.json');
        const engSetup = setupDdl.filter((sql) => !ownSet.has(sql)).map((sql) => ({ sql, params: [] }));
        // Own DDL first on the engine too, so both sides built the schema the same way.
        const engOwn = own.map((s) => ({ sql: s.sql, params: [] }));
        fs.writeFileSync(jobFile, JSON.stringify({ out: outFile, setup: engOwn.concat(engSetup, seed), stmts: stmts.slice(own.length).map((x) => ({ sql: x.sql, params: x.params })) }));
        // Reference side: same order (own DDL already ran above; seed, then statements).
        const refOwn = [];
        for (const s of seed) { try { const [v] = await ref.query(s.sql, s.params); refSetup.push(v.affectedRows === 0 ? "no row" : null); } catch (e) { refSetup.push(String(e.message)); } }
        for (const x of stmts.slice(own.length)) {
            try { const [v] = await ref.query(x.sql, x.params); refOwn.push({ value: plainify(v) }); } catch (e) { refOwn.push({ err: String(e.message).slice(0, 300) }); }
        }
        await ref.end();

        const env = Object.assign({}, process.env, {
            FX_RES_DIR: resDir, FX_REAL_MARIA: '1',
            FX_CONVARS: JSON.stringify({ mysql_connection_string: 'mysql://root@' + HOST + ':' + PORT + '/' + ENG, cis_database_cdc: '0' }),
        });
        const c = spawnSync(process.execPath, [__filename, '--child', jobFile], { env, encoding: 'utf8', timeout: 600000 });
        let eng = null;
        try { eng = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (e) { /* reported below */ }
        const list = stmts.slice(own.length);
        let bad = 0;
        if (!eng || eng.boot) {
            const why = eng ? eng.boot : 'child died: ' + String(c.stderr || c.error || '').slice(-300);
            bad = list.length;
            total += list.length;
            const k = 'boot: ' + why.split('\n')[0].slice(0, 120);
            if (!groups.has(k)) groups.set(k, { pattern: k, count: 0, repos: new Set(), samples: [] });
            groups.get(k).count += list.length;
            groups.get(k).repos.add(r.repo);
        } else {
            // Schema and seed: not scored, but a step only one side took
            // explains the statements after it.
            const setupList = setupDdl.map((sql) => ({ sql })).concat(seed);
            for (let i = 0; i < setupList.length; i++) {
                if ((refSetup[i] === null) === (eng.setup[i] === null)) continue;
                setupDiff++;
                const k = 'setup: ' + (refSetup[i] === null ? 'engine fails: ' + pattern(eng.setup[i]) : 'MariaDB fails, engine takes it');
                if (!setupGroups.has(k)) setupGroups.set(k, { pattern: k, count: 0, repos: new Set(), samples: [] });
                const g = setupGroups.get(k);
                g.count++;
                g.repos.add(r.repo);
                if (g.samples.length < SAMPLES) g.samples.push({ repo: r.repo, file: 'setup', sql: setupList[i].sql.slice(0, 600), maria: String(refSetup[i]), engine: String(eng.setup[i]) });
            }
            for (let i = 0; i < list.length; i++) {
                total++;
                if (/^\s*(SELECT|WITH)\b/i.test(list[i].sql)) reads++;
                const a = shape(refOwn[i]);
                const b = shape(eng.results[i]);
                if (eng.results[i].maria) routed++;
                if (eng.results[i].maria && JSON.stringify(a) !== JSON.stringify(b)) routedBad++;
                if (JSON.stringify(a) === JSON.stringify(b)) { matched++; if (a.err) bothErr++; continue; }
                bad++;
                const kind = a.err ? 'engine answers, MariaDB errors'
                    : b.err ? 'engine errors: ' + pattern(eng.results[i].err)
                        : a.rows && b.rows ? (a.rows.length !== b.rows.length ? 'row count differs' : 'row values differ')
                            : a.affected !== undefined && b.affected !== undefined
                                ? (a.affected !== b.affected ? 'affectedRows ' + a.affected + ' vs ' + b.affected : 'insertId differs') + ': ' + verbOf(list[i].sql)
                                : 'result differs';
                if (!groups.has(kind)) groups.set(kind, { pattern: kind, count: 0, repos: new Set(), samples: [] });
                const g = groups.get(kind);
                g.count++;
                g.repos.add(r.repo);
                if (g.samples.length < SAMPLES) {
                    g.samples.push({
                        repo: r.repo, file: list[i].s.file + ':' + list[i].s.line, sql: list[i].sql.slice(0, 600), params: list[i].params,
                        // Long enough that a sample of a few rows still parses.
                        maria: JSON.stringify(refOwn[i]).slice(0, 8000), engine: JSON.stringify(eng.results[i]).slice(0, 8000),
                    });
                }
            }
        }
        if (!bad) full++;
        perRepo.push({ repo: r.repo, statements: list.length, mismatched: bad });
        process.stdout.write(ran + ' ' + r.repo + ' ' + (list.length - bad) + '/' + list.length + '\n');
    }
    await admin.query('DROP DATABASE IF EXISTS `' + REF + '`');
    await admin.query('DROP DATABASE IF EXISTS `' + ENG + '`');
    await admin.end();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp */ }

    const pct = (a, b) => (b ? (100 * a / b).toFixed(2) : '0.00') + ' %';
    const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
    console.log('\nrepos ' + ran + ', statements compared ' + total + ' (named placeholders made positional: ' + skipped + ')');
    console.log('match ' + matched + '/' + total + ' = ' + pct(matched, total) + '  (both sides error: ' + bothErr + ')');
    console.log('reads ' + reads + ', answered by MariaDB ' + routed + ' (' + pct(routed, reads) + '), of those mismatched ' + routedBad);
    console.log('repos fully matching ' + full + '/' + ran + ' = ' + pct(full, ran));
    console.log('\nmismatches by kind (' + sorted.length + '):');
    for (const g of sorted) {
        console.log('\n' + g.count + ' x ' + g.repos.size + ' repos  ' + g.pattern);
        for (const s of g.samples) console.log('   ' + s.repo + ' ' + s.file + '\n     ' + s.sql.replace(/\s+/g, ' ').slice(0, 220) + '\n     maria  ' + s.maria.slice(0, 200) + '\n     engine ' + s.engine.slice(0, 200));
    }
    const setupSorted = [...setupGroups.values()].sort((a, b) => b.count - a.count);
    console.log('\nsetup steps only one side took (not scored): ' + setupDiff);
    for (const g of setupSorted) {
        console.log('\n' + g.count + ' x ' + g.repos.size + ' repos  ' + g.pattern);
        for (const s of g.samples) console.log('   ' + s.repo + '\n     ' + s.sql.replace(/\s+/g, ' ').slice(0, 220) + '\n     maria  ' + s.maria.slice(0, 200) + '\n     engine ' + s.engine.slice(0, 200));
    }
    if (JSON_OUT) {
        fs.writeFileSync(JSON_OUT, JSON.stringify({
            total, matched, bothErr, reads, routed, routedBad, skipped, repos: ran, full, setupDiff,
            groups: sorted.map((g) => ({ ...g, repos: [...g.repos] })),
            setupGroups: setupSorted.map((g) => ({ ...g, repos: [...g.repos] })), perRepo,
        }, null, 2));
    }
}

// The statement's shape: its verb and the clauses that change a write's count.
function verbOf(sql) {
    const v = /^\s*(\w+)(\s+(IGNORE|INTO))?/i.exec(sql);
    let k = v ? (v[1] + (v[3] && /ignore/i.test(v[3]) ? ' IGNORE' : '')).toUpperCase() : '?';
    if (/\bON\s+DUPLICATE\s+KEY\b/i.test(sql)) k += ' ODKU';
    if (/^\s*(INSERT|REPLACE)\b[\s\S]*\bSELECT\b/i.test(sql)) k += ' SELECT';
    if (/^\s*(UPDATE|DELETE)\b[\s\S]*\bJOIN\b/i.test(sql)) k += ' JOIN';
    return k;
}

// An error message with names and numbers taken out.
function pattern(msg) {
    return String(msg)
        .replace(/[`'"][^`'"]{0,80}[`'"]/g, 'X')
        .replace(/\b\d+\b/g, 'N')
        .slice(0, 140);
}

if (require.main === module) {
    const i = args.indexOf('--child');
    (i >= 0 ? child(args[i + 1]) : main()).catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { paramsFor, seedValue, tablesOf, shape };
