'use strict';

// Translate and prepare every corpus statement on a real node:sqlite database.
// Each repository gets its own database: its own DDL runs first, then every
// other repository's DDL (so a script finds the framework tables it builds
// on), errors there ignored. Then each statement is translated by dialect.js
// and prepared; DDL is run.
//
// A statement passes when it translates, is not refused, keeps its placeholder
// count and SQLite prepares it. "no such table" / "no such column" means the
// corpus lacks the schema (a table made at run time or by a resource outside
// the corpus): counted apart, not as a translate failure.
// Failures are grouped by their error with names and numbers taken out.
// Usage: node tests/corpus/translate.js [--json out.json] [--samples N]

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const dialect = require('../../dialect.js');
const { cloneAt, statementsOf } = require('./fetch.js');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const SAMPLES = Number(opt('--samples', 3));
const JSON_OUT = opt('--json', null);
const REPOS = opt('--repos', path.join(__dirname, 'repos.json'));

const DDL = /^\s*(CREATE|ALTER|DROP|TRUNCATE|RENAME)\b/i;
// "N columns but M values": another resource added columns to a shared table.
const SCHEMA_MISSING = /no such (table|column)|has no column named|no such index|has \d+ columns but \d+ values/i;

function openDb() {
    const db = new DatabaseSync(':memory:');
    for (const f of dialect.sqlFunctions) {
        try { db.function(f.name, { deterministic: true, useBigIntArguments: !!f.bigint }, f.fn); } catch (e) { /* stays unavailable */ }
    }
    if (typeof db.aggregate === 'function') {
        for (const a of dialect.sqlAggregates) {
            try { db.aggregate(a.name, { start: a.start, step: a.step, result: a.result }); } catch (e) { /* stays unavailable */ }
        }
    }
    for (const n of ['cis_last_insert_id', 'cis_strict', 'cis_storing']) db.function(n, () => 0);
    for (const n of ['cis_database', 'cis_collation', 'cis_version']) db.function(n, () => '');
    db.function('cis_store', { varargs: true }, () => null);
    db.function('MD5', (v) => (v == null ? null : String(v)));
    db.function('SHA2', (v) => (v == null ? null : String(v)));
    for (const v of dialect.infoSchemaViewsSql()) { try { db.exec(v); } catch (e) { /* view stays missing */ } }
    return db;
}

// The number of params a statement binds. A numbered ?N (the upsert change
// guard repeats ?3) binds param N again, so the count is the highest index,
// not the number of marks.
function marks(sql, sqliteText) {
    let n = 0;
    let top = 0;
    dialect.mapCode(sql, (chunk) => {
        for (const m of chunk.matchAll(/\?(\d+)?/g)) top = Math.max(top, m[1] ? Number(m[1]) : ++n);
        return chunk;
    }, sqliteText);
    return top;
}

// The engine turns :name and @name into ? before translating, as oxmysql's
// named-placeholders does; @@vars stay.
function positional(sql) {
    try {
        return dialect.mapCode(sql, (chunk) => chunk.replace(/(^|[^\w:@])[@:]([a-z_]\w*)/gi, '$1?'));
    } catch (e) { return sql; }
}

// Run one statement. Returns null on success, or { kind, msg }.
function attempt(db, rawSql) {
    const sql = positional(rawSql);
    let tr;
    try { tr = dialect.translate(sql); } catch (e) { return { kind: 'translate', msg: e.message }; }
    if (tr.blocked) return { kind: 'refused', msg: 'refused by isForbiddenSql' };
    try {
        if (marks(sql) !== marks(tr.sql, true)) return { kind: 'placeholders', msg: 'placeholder count changed', out: tr.sql };
    } catch (e) { /* mapCode cannot read it; prepare decides */ }
    try {
        if (DDL.test(sql)) {
            db.exec(tr.sql);
            for (const x of tr.extra || []) db.exec(x);
            dialect.forgetSchema();
        } else {
            db.prepare(tr.sql);
        }
    } catch (e) {
        if (/already exists|duplicate column/i.test(e.message)) return null;
        // A literal the script finishes in code (`'... VALUES ' .. list`) is a
        // fragment: the caller's own text is already cut short.
        if (/incomplete input/.test(e.message)) {
            try { db.prepare(sql); } catch (e2) { if (/incomplete input/.test(e2.message)) return { kind: 'fragment', msg: e.message }; }
        }
        return { kind: SCHEMA_MISSING.test(e.message) ? 'schema' : 'prepare', msg: e.message, out: tr.sql };
    }
    return null;
}

// The root pattern of an error: quoted names, numbers and long tails removed.
function pattern(f) {
    const m = f.msg
        .replace(/near "([^"]*)"/g, (x, t) => 'near "' + (/^[A-Z_]+$/i.test(t) && t === t.toUpperCase() ? t : 'X') + '"')
        .replace(/[`'"][^`'"]{0,80}[`'"]/g, (x) => (/^"[A-Z_]+"$/.test(x) ? x : 'X'))
        .replace(/\b\d+\b/g, 'N')
        .slice(0, 160);
    return f.kind + ': ' + m;
}

function main() {
    const repos = JSON.parse(fs.readFileSync(REPOS, 'utf8'));
    const all = [];
    const counts = {};
    for (const r of repos) {
        const { dir } = cloneAt(r.repo, r.sha);
        all.push({ repo: r.repo, group: r.group, stmts: statementsOf(dir, counts) });
    }
    const globalDdl = [];
    // Only statements that add schema: another repository's DROP must not
    // take a table away.
    for (const r of all) for (const s of r.stmts) if (/^\s*(CREATE|ALTER)\b/i.test(s.sql) && !/\bDROP\b/i.test(s.sql)) globalDdl.push(s.sql);

    const groups = new Map();
    let total = 0;
    let pass = 0;
    let schema = 0;
    let fragment = 0;
    let full = 0;
    let fullNoSchema = 0;
    const perRepo = [];
    for (const r of all) {
        const db = openDb();
        dialect.setSchemaProvider((t) => db.prepare('SELECT * FROM pragma_table_info(?)').all(t));
        dialect.forgetSchema();
        const own = r.stmts.filter((s) => DDL.test(s.sql));
        const rest = r.stmts.filter((s) => !DDL.test(s.sql));
        // The repository's own DDL is scored; the rest of the corpus is only the
        // schema it runs against.
        const results = own.map((s) => ({ s, f: attempt(db, s.sql) }));
        const ownSet = new Set(own.map((s) => s.sql));
        for (const sql of globalDdl) if (!ownSet.has(sql)) attempt(db, sql);
        for (const s of rest) results.push({ s, f: attempt(db, s.sql) });
        let bad = 0;
        let miss = 0;
        for (const { s, f } of results) {
            total++;
            if (!f) { pass++; continue; }
            if (f.kind === 'schema') { schema++; miss++; continue; }
            if (f.kind === 'fragment') { fragment++; continue; }
            bad++;
            const k = pattern(f);
            let g = groups.get(k);
            if (!g) groups.set(k, (g = { pattern: k, count: 0, repos: new Set(), samples: [] }));
            g.count++;
            g.repos.add(r.repo);
            if (g.samples.length < SAMPLES) g.samples.push({ repo: r.repo, file: s.file + ':' + s.line, sql: s.sql.slice(0, 600), out: f.out && f.out.slice(0, 600), msg: f.msg });
        }
        if (!bad) fullNoSchema++;
        if (!bad && !miss) full++;
        perRepo.push({ repo: r.repo, group: r.group, statements: results.length, failed: bad, schemaMissing: miss });
        db.close();
    }
    const scored = total - schema - fragment;
    const pct = (a, b) => (b ? (100 * a / b).toFixed(2) : '0.00') + ' %';
    const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
    console.log('repos ' + all.length + ', statements ' + total + ' (dynamic, left out: ' + (counts.dynamic || 0) + ')');
    console.log('translate+prepare ' + pass + '/' + scored + ' = ' + pct(pass, scored) + '  (not scored: schema missing ' + schema + ', fragments ' + fragment + ')');
    console.log('repos with no failure ' + fullNoSchema + '/' + all.length + ' = ' + pct(fullNoSchema, all.length) + '  (and no schema gap: ' + full + ')');
    console.log('\nfailures by pattern (' + sorted.length + ' patterns):');
    for (const g of sorted) {
        console.log('\n' + g.count + ' x ' + g.repos.size + ' repos  ' + g.pattern);
        for (const s of g.samples) console.log('   ' + s.repo + ' ' + s.file + '\n     ' + s.sql.replace(/\s+/g, ' ').slice(0, 220));
    }
    if (JSON_OUT) {
        fs.writeFileSync(JSON_OUT, JSON.stringify({
            total, pass, schema, fragment, scored, repos: all.length, fullNoSchema, full, dynamic: counts.dynamic || 0,
            groups: sorted.map((g) => ({ ...g, repos: [...g.repos] })), perRepo,
        }, null, 2));
    }
}

if (require.main === module) main();
module.exports = { attempt, openDb, pattern, positional };
