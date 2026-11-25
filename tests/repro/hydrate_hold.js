'use strict';

// The hydrate export copies the tables MariaDB gained since boot while the
// server answers calls. A copied table has no strict-mode or foreign-key
// triggers until the copy ends, so a write that reached it in between went in
// unchecked: a value too long for its column was kept. Calls now wait for the
// export, in arrival order, and isReady stays true while they wait.
//
// Two exports. In the first, calls queued just before it (more than a slice
// runs) wait in the queue. In the second the queue is empty, so calls made
// while it runs wait at the ready gate.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const HARNESS = path.join(__dirname, '..', 'harness', 'fx.js');
const TABLES = 40;
const ROWS = 400;
const LONG = 'x'.repeat(60);
const PRE = 4000;

// Tables MariaDB gains after boot. The export copies every table with no
// write waiting for MariaDB, so these at least.
function addTables(mariaFile, prefix) {
    const m = new DatabaseSync(mariaFile);
    m.exec('BEGIN');
    for (let t = 0; t < TABLES; t++) {
        m.exec('CREATE TABLE ' + prefix + t + ' (id INTEGER PRIMARY KEY AUTOINCREMENT, citizenid VARCHAR(50) NOT NULL, label VARCHAR(100))');
        const st = m.prepare('INSERT INTO ' + prefix + t + ' (citizenid, label) VALUES (?, ?)');
        for (let i = 0; i < ROWS; i++) st.run('C' + i, 'L' + i);
    }
    m.exec('COMMIT');
    m.close();
}

if (require.main !== module) {
    module.exports = { addTables };
} else {
    main();
}

function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-hydrate-hold-'));
    const mariaFile = path.join(dir, 'maria.sqlite');
    const m = new DatabaseSync(mariaFile);
    m.exec('CREATE TABLE base (id INTEGER PRIMARY KEY AUTOINCREMENT, citizenid VARCHAR(50) NOT NULL, label VARCHAR(100))');
    m.close();
    const env = { FX_RES_DIR: dir, FX_MARIA_FILE: mariaFile };

    const ins = (table, cid, label) => "fx.call('insert', 'INSERT INTO " + table + " (citizenid, label) VALUES (?, ?)', [" + cid + ", " + label + "])";
    const code = "const fx = require(" + JSON.stringify(HARNESS) + ");\n"
        + "const out = (k, v) => console.log('@' + k + '=' + JSON.stringify(v));\n"
        + "const add = (p) => require(" + JSON.stringify(__filename) + ").addTables(" + JSON.stringify(mariaFile) + ", p);\n"
        + "const longIn = (t) => fx.call('scalar', 'SELECT COUNT(*) FROM ' + t + ' WHERE length(citizenid) > 50', []);\n"
        + "(async () => {\nif (!(await fx.ready(60000))) throw new Error('not ready');\n"
        + "out('before', await " + ins('base', "'" + LONG + "'", "'before'") + ");\n"
        // First export: a burst made in one go just before it, with a value
        // too long for h0 every 50 calls, spread through the queue.
        + "add('h');\nlet busy = true; let preEarly = 0; const pre = [];\n"
        + "for (let i = 0; i < " + PRE + "; i++) {\n"
        + "  pre.push(" + ins('base', "'pre'", "'p' + i") + ".then(() => { if (busy) preEarly++; }));\n"
        + "  if (i % 50 === 49) pre.push(" + ins('h0', "'" + LONG + "'", "'q' + i") + "); }\n"
        + "out('hydrateA', await fx.asSelf(() => fx.call('hydrate')));\nbusy = false;\nawait Promise.all(pre);\n"
        + "out('preEarly', preEarly);\nout('longA', await longIn('h0'));\n"
        // Second export, queue empty: two calls a millisecond until it ends,
        // a value too long for g0 (copied first, so its window was the
        // longest) and a valid row into base, whose ids give the run order.
        + "add('g');\nbusy = true; let n = 0; let notReady = 0; const answers = [];\n"
        + "const hy = fx.asSelf(() => fx.call('hydrate')).then((r) => { busy = false; return r; });\n"
        + "const tick = setInterval(() => { if (!busy) return; if (!fx.registry.isReady()) notReady++; const i = n++;\n"
        + "  answers.push(" + ins('g0', "'" + LONG + "'", "'w' + i") + ");\n"
        + "  answers.push(" + ins('base', "'ord'", "'o' + i") + "); }, 1);\n"
        + "out('hydrateB', await hy);\nclearInterval(tick);\nawait Promise.all(answers);\n"
        + "out('sent', n);\nout('notReady', notReady);\nout('longB', await longIn('g0'));\n"
        + "const rows = await fx.call('query', \"SELECT label FROM base WHERE citizenid = 'ord' ORDER BY id\", []);\n"
        + "out('order', (rows || []).map((r) => Number(String(r.label).slice(1))));\n"
        + "out('after', await " + ins('g0', "'" + LONG + "'", "'after'") + ");\n"
        + "process.exit(0);\n})().catch((e) => { console.log('CHILD ERROR ' + (e && e.stack)); process.exit(2); });";
    const r = spawnSync(process.execPath, ['-e', code], { env: Object.assign({}, process.env, env), encoding: 'utf8', timeout: 240000 });
    const text = (r.stdout || '') + (r.stderr || '');
    const v = {};
    for (const x of text.matchAll(/^@(\w+)=(.*)$/gm)) v[x[1]] = JSON.parse(x[2]);

    const results = [];
    const check = (name, ok, detail) => {
        results.push(ok);
        console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
    };
    const refused = (x) => !(Number(x) > 0);
    check('strict mode refuses a value too long before the exports', v.before !== undefined && refused(v.before),
        JSON.stringify(v.before) + (v.before === undefined ? ' ' + text.slice(-600) : ''));
    check('the first export copied its tables', v.hydrateA && v.hydrateA.tables >= TABLES, JSON.stringify(v.hydrateA));
    check('calls queued before the first export waited for it', Number(v.preEarly) < PRE, v.preEarly + ' of ' + PRE + ' ran before it ended');
    check('no queued value too long went in', Number(v.longA) === 0, String(v.longA));
    check('the second export copied its tables', v.hydrateB && v.hydrateB.tables >= 2 * TABLES, JSON.stringify(v.hydrateB));
    check('calls were sent while the second export ran', Number(v.sent) > 0, String(v.sent));
    check('no value too long went in while it ran', Number(v.longB) === 0, String(v.longB));
    check('calls made during it ran in arrival order', Array.isArray(v.order) && v.order.length === v.sent && v.order.every((x, i) => x === i),
        v.sent + ' sent, ' + JSON.stringify(v.order || []).slice(0, 120));
    check('isReady stayed true during it', v.notReady === 0, String(v.notReady));
    check('strict mode refuses a value too long after the exports', v.after !== undefined && refused(v.after), JSON.stringify(v.after));

    fs.rmSync(dir, { recursive: true, force: true });
    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
}
