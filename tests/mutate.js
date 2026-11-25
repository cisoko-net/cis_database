'use strict';

// The mutation gate. Each row of tests/mutations.json is a known defect:
// `file`, a `find` text that must match exactly once, its `replace`, and the
// `tests` (files in tests/repro) that guard against it. The row is applied
// to a copy of the repository and those tests must FAIL. A row whose tests
// still pass is a SURVIVOR: the check that should catch the defect does not.
// A row whose `find` no longer matches exactly once is STALE. Both fail the
// gate. Rows run their own tests, not the whole suite: a timing check that
// fails by chance on a busy PC would otherwise count as a kill.
//
// Usage: node tests/mutate.js [id ...]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'mutations.json'), 'utf8'));
const only = process.argv.slice(2);
const ids = new Set();
for (const r of rows) {
    if (ids.has(r.id)) { console.error('duplicate id ' + r.id); process.exit(2); }
    ids.add(r.id);
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'cache']);
function copyTree(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        if (SKIP_DIRS.has(e.name)) continue;
        const s = path.join(src, e.name);
        const d = path.join(dst, e.name);
        if (e.isDirectory()) copyTree(s, d);
        else if (e.isFile()) fs.copyFileSync(s, d);
    }
}

let bad = 0;
const results = [];
for (const r of rows) {
    if (only.length && !only.includes(r.id)) continue;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-mut-'));
    let status;
    let detail = '';
    try {
        copyTree(root, dir);
        fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
        const file = path.join(dir, r.file);
        const text = fs.readFileSync(file, 'utf8');
        const n = text.split(r.find).length - 1;
        if (n !== 1) {
            status = 'STALE';
            detail = 'find matches ' + n + ' times';
        } else {
            fs.writeFileSync(file, text.replace(r.find, () => r.replace));
            const failing = [];
            for (const t of r.tests) {
                const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-mut-t-'));
                const env = Object.assign({}, process.env, { TMP: tmp, TEMP: tmp, TMPDIR: tmp });
                const p = spawnSync(process.execPath, [path.join(dir, 'tests', 'repro', t)], { encoding: 'utf8', timeout: 300000, env });
                try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* left in temp */ }
                const out = (p.stdout || '') + (p.stderr || '');
                if (/^SKIP/m.test(out) && p.status === 0) { status = 'SKIP'; detail = t + ' skipped'; break; }
                if (p.status !== 0) failing.push(t);
            }
            if (!status) {
                status = failing.length ? 'KILLED' : 'SURVIVOR';
                detail = failing.length ? 'red: ' + failing.join(', ') : 'tests still pass: ' + r.tests.join(', ');
            }
        }
    } finally {
        // Remove the junction first, and the copy only once it is gone, so a
        // recursive delete can never reach the real node_modules.
        let linked = false;
        try { fs.lstatSync(path.join(dir, 'node_modules')); linked = true; } catch (e) { /* never made */ }
        if (linked) { try { fs.unlinkSync(path.join(dir, 'node_modules')); linked = false; } catch (e) { console.log('     could not unlink ' + dir + '/node_modules: copy left'); } }
        if (!linked) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { console.log('     could not remove ' + dir); } }
    }
    if (status !== 'KILLED') bad++;
    results.push(status);
    console.log(status.padEnd(8) + ' ' + r.id + '  ' + r.why + '  (' + detail + ')');
}
const killed = results.filter((s) => s === 'KILLED').length;
console.log(killed + ' of ' + results.length + ' killed');
process.exit(bad ? 1 : 0);
