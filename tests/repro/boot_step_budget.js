'use strict';

// The boot steps after the copy (strict-mode triggers, ANALYZE, column meta)
// yielded on their own 25 ms clock, apart from the frame budget the copy
// charges, and only after a step had already run past it. On the qbox cold
// boot of 2026-10-28 (3bf7ac1) the end of the copy ran 25-30.5 ms ticks, and
// locally 38 ms turns. Here every CREATE TRIGGER is made slow (4 ms of CPU, four triggers a table),
// so one table's trigger rebuild is a long step: a turn of the event loop
// during boot must still stay near the frame budget.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const HARNESS = path.join(__dirname, '..', 'harness', 'fx.js');
const TABLES = 40;
const FRAME = 25;
// One statement of the copy, the harness's 4 ms frame tick and the fake
// MariaDB run on the same thread; a step that started past the frame adds
// at least one whole slow step (16 ms or more): 38-47 ms before the fix,
// 21-33 ms after, over 6 runs each on Windows.
const LIMIT = FRAME + 10;
const SLOW_MS = 4;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-boot-step-'));
const mariaFile = path.join(dir, 'maria.sqlite');
{
    const m = new DatabaseSync(mariaFile);
    m.exec('BEGIN');
    for (let t = 0; t < TABLES; t++) {
        m.exec('CREATE TABLE t' + t + ' (id INTEGER PRIMARY KEY AUTOINCREMENT, citizenid VARCHAR(50) NOT NULL, name VARCHAR(255), money INT NOT NULL DEFAULT 0, label VARCHAR(100))');
        const st = m.prepare('INSERT INTO t' + t + ' (citizenid, name, money, label) VALUES (?, ?, ?, ?)');
        for (let i = 0; i < 50; i++) st.run('C' + i, 'n' + i, i, 'L' + i);
    }
    m.exec('COMMIT');
    m.close();
}

const SLOW = "const sq = require('node:sqlite');\n"
    + "const realExec = sq.DatabaseSync.prototype.exec; sq.DatabaseSync.prototype.exec = function (sql) {\n"
    + "  if (/^\s*CREATE TRIGGER/i.test(sql)) { const e = performance.now() + " + SLOW_MS + "; while (performance.now() < e); }\n"
    + "  return realExec.call(this, sql); };\n";

const code = SLOW + "const fx = require(" + JSON.stringify(HARNESS) + ");\n"
    + "let last = 0; let maxGap = 0; let at = 0; let watching = true; let loaded = false;\n"
    // Every turn of the loop: the first gap is server.js loading, not boot work.
    + "const tick = () => { const n = performance.now(); if (last && watching) { const g = n - last; if (!loaded) loaded = true; else if (g > maxGap) { maxGap = g; at = n; } } last = n; if (watching) setImmediate(tick); };\n"
    + "setImmediate(tick);\n"
    + "(async () => { if (!(await fx.ready(120000))) throw new Error('not ready');\n"
    + "const trig = await fx.call('scalar', \"SELECT COUNT(*) FROM sqlite_temp_master WHERE type = 'trigger' AND tbl_name = 't" + (TABLES - 1) + "'\", []);\n"
    + "await new Promise((r) => setTimeout(r, 200)); watching = false;\n"
    + "console.log('@' + JSON.stringify({ maxGap: Math.round(maxGap * 10) / 10, trig }));\n"
    + "process.exit(0); })().catch((e) => { console.log('CHILD ERROR ' + (e && e.stack)); process.exit(2); });";

const env = Object.assign({}, process.env, {
    FX_RES_DIR: dir, FX_MARIA_FILE: mariaFile,
    FX_CONVARS: JSON.stringify({ cis_database_frame_ms: String(FRAME) }),
});
const r = spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8', timeout: 180000 });
const text = (r.stdout || '') + (r.stderr || '');
const m = text.match(/^@(.*)$/m);
const v = m ? JSON.parse(m[1]) : {};
let fails = 0;
function check(name, ok, detail) {
    if (!ok) fails++;
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
check('strict-mode triggers built for the last table', Number(v.trig) > 0, String(v.trig) + (m ? '' : ' ' + text.slice(-800)));
check('cold boot with slow trigger steps: no turn over ' + LIMIT + ' ms', typeof v.maxGap === 'number' && v.maxGap <= LIMIT, 'maxGap=' + v.maxGap);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
process.exit(fails ? 1 : 0);
