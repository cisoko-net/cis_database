'use strict';

// The dashboard page posts its NUI callbacks to https://cis_database/<name>
// (web/src/nui.ts, GetParentResourceName()). Security review E8 narrowed the
// CSP to connect-src https://cis_database, but a CSP host source allows only
// letters, digits and '-' (CSP3 host-char), so CEF dropped it as an invalid
// source (owner's F8 on qbox, 2026-11-12) and connect-src fell back to no
// source at all: every callback fetch was refused. No host source can name
// a folder with '_', so connect-src is the https: scheme again, and every
// other source on the page must be valid CSP grammar.
// Checks the Vite entry and the committed build.
// Usage: node tests/repro/dash_csp.js

const fs = require('fs');
const path = require('path');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

// CSP3 source-expression grammar, enough for this page: keywords, schemes,
// host sources (host-char = ALPHA / DIGIT / "-") and data:.
const KEYWORD = /^'(none|self|unsafe-inline|unsafe-eval|strict-dynamic|unsafe-hashes|report-sample|wasm-unsafe-eval)'$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:$/i;
const HOST = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(?:\d+|\*))?(?:\/[^\s;,]*)?$/i;
const validSource = (s) => KEYWORD.test(s) || SCHEME.test(s) || HOST.test(s);

// Does a source list allow a fetch to this URL? Invalid sources are dropped,
// as the browser does; an empty list allows nothing.
function allows(list, url) {
    const u = new URL(url);
    return list.filter(validSource).some((s) => {
        if (SCHEME.test(s)) return s.toLowerCase() === u.protocol;
        if (s === '*') return true;
        if (KEYWORD.test(s)) return false;
        const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^:/]+)/i.exec(s);
        if (m[1] && m[1].toLowerCase() + ':' !== u.protocol) return false;
        if (m[2] === '*') return true;
        if (m[2].startsWith('*.')) return u.hostname.endsWith(m[2].slice(1));
        return m[2].toLowerCase() === u.hostname;
    });
}

for (const rel of ['web/index.html', 'web/dist/index.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
    const m = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html);
    const csp = m ? m[1] : '';
    check(rel + ' has a CSP', !!m);
    const dirs = csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => d.split(/\s+/));
    const bad = [];
    for (const d of dirs) for (const s of d.slice(1)) if (!validSource(s)) bad.push(d[0] + ' ' + s);
    check(rel + ' has no invalid CSP source', bad.length === 0, bad.join(', '));
    const connect = (dirs.find((d) => d[0] === 'connect-src') || ['connect-src']).slice(1);
    check(rel + ' lets the NUI callback fetch reach https://cis_database/', allows(connect, 'https://cis_database/dashClose'), connect.join(' '));
    check(rel + ' connect-src allows no plain http or other scheme', !allows(connect, 'http://example.com/') && !allows(connect, 'ws://example.com/'), connect.join(' '));
    check(rel + ' keeps default-src none', /default-src 'none'/.test(csp), csp);
    check(rel + ' keeps script-src self only', /script-src 'self';/.test(csp), csp);
    // The panel bundles Inter and JetBrains Mono; under default-src 'none'
    // the game browser drops them without font-src 'self'.
    const font = (dirs.find((d) => d[0] === 'font-src') || ['font-src']).slice(1);
    check(rel + " lets the bundled fonts load (font-src 'self' only)", font.length === 1 && font[0] === "'self'", font.join(' '));
}

// Every @font-face in the built CSS points at a file shipped beside it, by a
// relative path (nui:// origin, no CDN).
const assets = path.join(__dirname, '..', '..', 'web', 'dist', 'assets');
const css = fs.readdirSync(assets).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(assets, f), 'utf8')).join('\n');
const fontUrls = [...css.matchAll(/@font-face\s*{[^}]*}/g)].flatMap((b) => [...b[0].matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((u) => u[1]));
check('the built CSS declares the bundled fonts', fontUrls.length >= 2, fontUrls.join(' '));
const badFont = fontUrls.filter((u) => !/^\.\.?\//.test(u) || !fs.existsSync(path.join(assets, u)));
check('every font url is relative and shipped in web/dist/assets', badFont.length === 0, badFont.join(' '));
const nui = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'nui.ts'), 'utf8');
check('fetchNui still posts to https://<resource>/', nui.includes('fetch(`https://${name}/${event}`'));

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
