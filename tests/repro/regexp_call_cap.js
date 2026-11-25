'use strict';

// REGEXP caps one call at pattern size times value length (RX_MAX_WORK). A
// call over the cap is refused before it starts, with its own reason, not
// after it has spent the whole statement budget. mutations.json M17 turns
// the cap off.
// Usage: node tests/repro/regexp_call_cap.js

const { DatabaseSync } = require('node:sqlite');
const dialect = require('../../dialect.js');

const db = new DatabaseSync(':memory:');
for (const f of dialect.sqlFunctions) db.function(f.name, { deterministic: true, useBigIntArguments: !!f.bigint }, f.fn);
db.exec('CREATE TABLE t (v TEXT)');
db.prepare('INSERT INTO t (v) VALUES (?)').run('a'.repeat(30000));
const sel = db.prepare(dialect.translate('SELECT v FROM t WHERE v REGEXP ?').sql);

const t = Date.now();
let err = null;
try { sel.all('a?'.repeat(1500) + 'b'); } catch (e) { err = e.message; }
const ms = Date.now() - t;
const ok1 = !!err && /too large to match/.test(err);
const ok2 = ms < 250;
console.log((ok1 ? 'PASS ' : 'FAIL ') + 'an over-cap call is refused as too large  ' + err);
console.log((ok2 ? 'PASS ' : 'FAIL ') + 'and refused in under 250 ms  ' + ms + ' ms');
process.exit(ok1 && ok2 ? 0 : 1);
