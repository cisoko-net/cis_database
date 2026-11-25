'use strict';

// Security review E5 and E6. Any resource could call probe(true) and reset
// the performance counters (slice_max_ms, wake_*, ckpt_copy_max_ms) that the
// dashboard and the benchmarks read, and call lua_poll to run the drain
// outside the frame tick and skew the slice budget. probe stays readable by
// any resource (benchmark tools read it), but only cis_database itself may
// reset it. lua_poll is gone: the frame tick is server.js's own setTick.
// Usage: node tests/repro/internal_probe.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-probe-'));
const mariaFile = path.join(dir, 'maria.sqlite');
const m = new DatabaseSync(mariaFile);
m.exec('CREATE TABLE users (identifier VARCHAR(64) PRIMARY KEY, money INT NOT NULL)');
m.close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;
process.env.FX_CONVARS = JSON.stringify({ mysql_connection_string: 'mysql://root@127.0.0.1/fake', cis_database_cdc: '0' });

const fx = require('../harness/fx.js');
const r = fx.registry;

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const turn = () => new Promise((res) => setTimeout(res, 10));

(async () => {
    if (!(await fx.ready(20000))) throw new Error('not ready');
    // A burst past the slice budget arms slices, so wake_n grows.
    let next = 0;
    async function burst() {
        const all = [];
        for (let i = 0; i < 3000; i++) all.push(fx.call('insert', 'INSERT INTO users VALUES (?, ?)', ['id' + next++, i]));
        await Promise.all(all);
        await turn();
        return r.probe().wake_n;
    }
    // Resets as `who`, and reports the wake count before and after.
    function resetAs(who) {
        global.__fxInvoker = who;
        const w0 = r.probe().wake_n;
        r.probe(true);
        return [w0, r.probe().wake_n];
    }
    const show = (x) => x[0] + ' -> ' + x[1];

    await burst();
    global.__fxInvoker = 'other_script';
    const p = r.probe();
    check('another resource can read probe', p && p.ready === true, JSON.stringify({ ready: p.ready, wake_n: p.wake_n }));
    check('a burst moves wake_n (precondition)', p.wake_n > 0, String(p.wake_n));
    const other = resetAs('other_script');
    check('another resource cannot reset the counters', other[1] === other[0] && other[0] > 0, show(other));
    check('there is no lua_poll export', r.lua_poll === undefined);

    const own = resetAs('cis_database');
    check('cis_database itself can reset the counters', own[0] > 0 && own[1] === 0, show(own));

    // The bench resource is granted the reset with an ACE, and only it.
    global.IsPrincipalAceAllowed = (principal, object) => principal === 'resource.cis_bench' && object === 'cis_database.probe';
    await burst();
    const stranger = resetAs('other_script');
    check('the ACE does not grant other resources', stranger[1] === stranger[0] && stranger[0] > 0, show(stranger));
    const bench = resetAs('cis_bench');
    check('a resource granted cis_database.probe can reset the counters', bench[0] > 0 && bench[1] === 0, show(bench));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
