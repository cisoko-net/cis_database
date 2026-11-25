'use strict';

// Clone a corpus repository at a pinned commit and pull the SQL out of it.
// Only .lua, .js, .ts and .sql files are checked out (sparse, no history).
// Clones live in tests/corpus/.cache, which git ignores.
//
// A statement is a string literal whose text reads as SQL (keyword, then the
// clause that keyword needs), or a statement of a .sql file. A literal joined
// to code (`..`, `+`, `${}`) or holding a format directive (%s, %d) is built at
// run time: it is counted as dynamic and left out, since its text is unknown.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CACHE = path.join(__dirname, '.cache');
const EXT = /\.(lua|js|ts|sql)$/i;
// Test suites are not SQL a server runs.
const SKIP_DIR = /^(node_modules|\.git|dist|build|web|html|ui|nui|stream|tests?|__tests__|spec)$/i;
const MANIFEST = /^(fxmanifest|__resource)\.lua$/i;

function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Clone repo (owner/name) at sha, or at its default branch when sha is null.
 * @returns {{dir: string, sha: string}}
 */
function cloneAt(repo, sha) {
    const dir = path.join(CACHE, repo.replace('/', '__'));
    if (!fs.existsSync(path.join(dir, '.git'))) {
        fs.mkdirSync(dir, { recursive: true });
        git(['init', '-q'], dir);
        git(['remote', 'add', 'origin', 'https://github.com/' + repo + '.git'], dir);
        git(['config', 'core.sparseCheckout', 'true'], dir);
        fs.writeFileSync(path.join(dir, '.git', 'info', 'sparse-checkout'), '*.lua\n*.js\n*.ts\n*.sql\n');
    }
    const have = (() => { try { return git(['rev-parse', 'HEAD'], dir); } catch (e) { return ''; } })();
    if (sha && have === sha) return { dir, sha };
    git(['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', sha || 'HEAD'], dir);
    git(['checkout', '-q', '--force', 'FETCH_HEAD'], dir);
    return { dir, sha: git(['rev-parse', 'HEAD'], dir) };
}

// The source files of every FiveM resource in dir: a folder with an
// fxmanifest.lua or __resource.lua and everything under it. A repository with
// no manifest (a Discord bot, a library) gives nothing.
function walk(dir, out, inRes) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const res = inRes || entries.some((e) => e.isFile() && MANIFEST.test(e.name));
    for (const e of entries) {
        if (e.isDirectory()) {
            if (!SKIP_DIR.test(e.name)) walk(path.join(dir, e.name), out, res);
        } else if (res && EXT.test(e.name) && !/\.min\.js$/i.test(e.name)) {
            const p = path.join(dir, e.name);
            if (fs.statSync(p).size < 1 << 20) out.push(p);
        }
    }
    return out;
}

// Text reads as SQL: a statement keyword followed by the clause it needs.
const SQL_SHAPE = [
    /^\s*SELECT\b[\s\S]*\bFROM\s+[`\w]/i,
    /^\s*SELECT\s+[\s\S]*\(/i,
    /^\s*INSERT\s+(IGNORE\s+)?INTO\s+[`\w]/i,
    /^\s*REPLACE\s+INTO\s+[`\w]/i,
    /^\s*UPDATE\s+[`\w][\s\S]*\bSET\b/i,
    /^\s*DELETE\s+[\s\S]*\bFROM\s+[`\w]/i,
    /^\s*CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX)\b/i,
    /^\s*ALTER\s+TABLE\s+[`\w]/i,
    /^\s*DROP\s+(TABLE|INDEX)\b/i,
    /^\s*TRUNCATE\s+(TABLE\s+)?[`\w]/i,
    /^\s*SHOW\s+(FULL\s+)?(TABLES|COLUMNS|FIELDS|INDEX|INDEXES|KEYS|CREATE|VARIABLES|STATUS|DATABASES|TRIGGERS)\b/i,
    /^\s*(DESCRIBE|DESC)\s+`?\w+`?\s*;?\s*$/i,
];
function looksSql(s) {
    if (s.length < 12 || s.length > 262144) return false;
    // Prose in a lang file ("Select a vehicle from the list.") ends like a sentence.
    if (/[.!:]\s*$/.test(s)) return false;
    return SQL_SHAPE.some((re) => re.test(s));
}
const FORMAT = /%[-+ 0#]*\d*(\.\d+)?[sdiqfx]/;

function unescape(s) {
    return s.replace(/\\(\r?\n|.)/g, (m, c) => ({ n: '\n', t: '\t', r: '\r', '0': '\0' }[c] !== undefined ? { n: '\n', t: '\t', r: '\r', '0': '\0' }[c] : /\r?\n/.test(c) ? '\n' : c));
}

// String literals of Lua or JavaScript source, with whether each is joined to
// code around it. Comments are skipped.
function literals(src, lua) {
    const out = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        if (lua && c === '-' && src[i + 1] === '-') {
            const m = /^--\[(=*)\[/.exec(src.slice(i, i + 64));
            if (m) { const end = src.indexOf(']' + m[1] + ']', i); i = end < 0 ? n : end + m[1].length + 2; } else { const e = src.indexOf('\n', i); i = e < 0 ? n : e; }
            continue;
        }
        if (!lua && c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; }
        if (!lua && c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
        let start = i;
        let text = null;
        let dyn = false;
        if (lua && c === '[') {
            const m = /^\[(=*)\[/.exec(src.slice(i, i + 64));
            if (m) {
                const close = ']' + m[1] + ']';
                const end = src.indexOf(close, i + m[0].length);
                if (end < 0) break;
                text = src.slice(i + m[0].length, end).replace(/^\r?\n/, '');
                i = end + close.length;
            }
        }
        if (text === null && (c === '"' || c === "'" || (!lua && c === '`'))) {
            let j = i + 1;
            let raw = '';
            while (j < n && src[j] !== c) {
                if (src[j] === '\\') { raw += src[j] + (src[j + 1] || ''); j += 2; continue; }
                if (c === '`' && src[j] === '$' && src[j + 1] === '{') dyn = true;
                if (c !== '`' && src[j] === '\n') break;
                raw += src[j++];
            }
            if (j >= n || src[j] !== c) { i = j + 1; continue; }
            text = unescape(raw);
            i = j + 1;
        }
        if (text === null) { i++; continue; }
        const before = src.slice(Math.max(0, start - 200), start).replace(/\s+$/, '');
        const after = src.slice(i, i + 200).replace(/^\s+/, '');
        const join = lua ? /\.\.$/ : /\+$/;
        const joinAfter = lua ? /^\.\./ : /^\+/;
        if (join.test(before) || joinAfter.test(after) || (lua && /^:format\b/.test(after))) dyn = true;
        out.push({ text, dyn, line: src.slice(0, start).split('\n').length });
    }
    return out;
}

// Statements of a .sql file: split on ; outside strings and comments.
function sqlFileStatements(src) {
    const out = [];
    let cur = '';
    let i = 0;
    let line = 1;
    let curLine = 1;
    while (i < src.length) {
        const c = src[i];
        if (c === '\n') line++;
        if ((c === '-' && src[i + 1] === '-') || c === '#') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
        if (c === '/' && src[i + 1] === '*' && src[i + 2] !== '!') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; line += (src.slice(i, end).match(/\n/g) || []).length; i = end; continue; }
        if (c === "'" || c === '"' || c === '`') {
            let j = i + 1;
            while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
            const lit = src.slice(i, j + 1);
            line += (lit.match(/\n/g) || []).length;
            if (!cur.trim()) curLine = line;
            cur += lit;
            i = j + 1;
            continue;
        }
        if (c === ';') { if (cur.trim()) out.push({ text: cur.trim(), line: curLine }); cur = ''; i++; continue; }
        if (!cur.trim() && /\S/.test(c)) curLine = line;
        cur += c;
        i++;
    }
    if (cur.trim()) out.push({ text: cur.trim(), line: curLine });
    return out;
}

/**
 * Every SQL statement of a checkout, deduplicated by text.
 * @returns {{file: string, line: number, sql: string, from: 'code'|'sqlfile'}[]}
 */
function statementsOf(dir, counts) {
    const seen = new Set();
    const out = [];
    let dynamic = 0;
    for (const f of walk(dir, [])) {
        const src = fs.readFileSync(f, 'utf8');
        const rel = path.relative(dir, f).split(path.sep).join('/');
        if (/\.sql$/i.test(f)) {
            for (const s of sqlFileStatements(src)) {
                if (!looksSql(s.text) || seen.has(s.text)) continue;
                seen.add(s.text);
                out.push({ file: rel, line: s.line, sql: s.text, from: 'sqlfile' });
            }
            continue;
        }
        for (const l of literals(src, /\.lua$/i.test(f))) {
            if (!looksSql(l.text.trim())) continue;
            if (l.dyn || FORMAT.test(l.text)) { dynamic++; continue; }
            // The engine runs a text holding several statements one by one.
            for (const p of sqlFileStatements(l.text)) {
                if (!looksSql(p.text) || seen.has(p.text)) continue;
                seen.add(p.text);
                out.push({ file: rel, line: l.line + p.line - 1, sql: p.text, from: 'code' });
            }
        }
    }
    if (counts) counts.dynamic = (counts.dynamic || 0) + dynamic;
    return out;
}

module.exports = { cloneAt, statementsOf, sqlFileStatements, literals, looksSql, CACHE };

// Usage: node tests/corpus/fetch.js   (clones every repos.json entry at its sha)
if (require.main === module) {
    const repos = JSON.parse(fs.readFileSync(path.join(__dirname, 'repos.json'), 'utf8'));
    let i = 0;
    for (const r of repos) {
        cloneAt(r.repo, r.sha);
        console.log(++i + '/' + repos.length + ' ' + r.repo + ' ' + r.sha.slice(0, 7));
    }
}
