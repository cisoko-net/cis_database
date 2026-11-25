'use strict';

// Translation rules found by the SQL corpus (tests/corpus). Each rule is keyed
// on the shape of the SQL, never on a table or column name, so every case runs
// the corpus sample and at least two variants with other names and types, on
// a real node:sqlite database. A form with no exact SQLite meaning must still
// fail with a reason.
// Usage: node tests/repro/corpus_rules.js

const { DatabaseSync } = require('node:sqlite');
const dialect = require('../../dialect.js');

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

function openDb() {
    const db = new DatabaseSync(':memory:');
    for (const f of dialect.sqlFunctions) db.function(f.name, { deterministic: true, useBigIntArguments: !!f.bigint }, f.fn);
    db.function('cis_last_insert_id', () => 0);
    dialect.setSchemaProvider((t) => db.prepare('SELECT * FROM pragma_table_info(?)').all(t));
    dialect.forgetSchema();
    return db;
}
function run(db, sql, params) {
    const tr = dialect.translate(sql);
    const st = db.prepare(tr.sql);
    const out = st.columns().length ? st.all(...(params || [])) : st.run(...(params || []));
    for (const x of tr.extra || []) db.exec(x);
    if (/^\s*(CREATE|ALTER)\b/i.test(sql)) dialect.forgetSchema();
    return out;
}
function tryRun(db, sql, params) {
    try { return run(db, sql, params); } catch (e) { return 'ERR ' + e.message; }
}
const plain = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? Number(x) : x)));

// ---- ADD COLUMN ... GENERATED ALWAYS AS (expr) STORED ----------------------
// MariaDB computes the column for the rows already there and for every later
// write. SQLite cannot add a STORED one; a VIRTUAL one reads the same values.
{
    const db = openDb();
    run(db, 'CREATE TABLE addon_account_data (id INT AUTO_INCREMENT PRIMARY KEY, account_name VARCHAR(100), money INT, owner VARCHAR(60) NULL)');
    run(db, "INSERT INTO addon_account_data (account_name, money, owner) VALUES ('a', 1, NULL), ('b', 2, 'char1:x')");
    const r = tryRun(db, "ALTER TABLE addon_account_data ADD COLUMN owner_key VARCHAR(60) GENERATED ALWAYS AS (COALESCE(owner, '')) STORED");
    check('sample: STORED generated column is added', typeof r !== 'string', String(r));
    run(db, "INSERT INTO addon_account_data (account_name, money, owner) VALUES ('c', 3, 'char2:y')");
    const got = plain(tryRun(db, 'SELECT owner_key FROM addon_account_data ORDER BY id'));
    check('sample: old and new rows read the computed value', JSON.stringify(got) === JSON.stringify([{ owner_key: '' }, { owner_key: 'char1:x' }, { owner_key: 'char2:y' }]), JSON.stringify(got));
    const u = tryRun(db, 'CREATE UNIQUE INDEX uq_owner ON addon_account_data (account_name, owner_key)');
    check('sample: a unique index on the column works', typeof u !== 'string', String(u));
    const dup = tryRun(db, "INSERT INTO addon_account_data (account_name, money, owner) VALUES ('a', 9, NULL)");
    check('sample: the index refuses a duplicate computed key', typeof dup === 'string' && /UNIQUE/i.test(dup), String(dup));
}
{
    const db = openDb();
    run(db, 'CREATE TABLE `shop_lines` (`id` INT PRIMARY KEY, `qty` INT NOT NULL, `price` INT NOT NULL)');
    run(db, 'INSERT INTO shop_lines (id, qty, price) VALUES (1, 3, 5)');
    const r = tryRun(db, 'ALTER TABLE `shop_lines` ADD `total` INT AS (`qty` * `price`) PERSISTENT');
    check('variant: PERSISTENT, backticks, arithmetic', typeof r !== 'string', String(r));
    run(db, 'UPDATE shop_lines SET qty = 4 WHERE id = 1');
    const got = plain(tryRun(db, 'SELECT total FROM shop_lines'));
    check('variant: value follows an UPDATE of its inputs', JSON.stringify(got) === '[{"total":20}]', JSON.stringify(got));
}
{
    const db = openDb();
    run(db, 'CREATE TABLE vehicles (plate VARCHAR(8), props LONGTEXT)');
    run(db, 'INSERT INTO vehicles VALUES (?, ?)', ['AB12', '{"model":"adder","fuel":50}']);
    const r = tryRun(db, "ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS model VARCHAR(50) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(props, '$.model'))) STORED, ADD INDEX idx_model (model)");
    check('variant: IF NOT EXISTS, JSON expression, index in the same ALTER', typeof r !== 'string', String(r));
    const got = plain(tryRun(db, "SELECT plate FROM vehicles WHERE model = 'adder'"));
    check('variant: the JSON value is readable and searchable', JSON.stringify(got) === '[{"plate":"AB12"}]', JSON.stringify(got));
    const again = tryRun(db, "ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS model VARCHAR(50) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(props, '$.model'))) STORED");
    // pragma_table_info leaves generated columns out, so SQLite itself answers
    // "duplicate column"; the engine's ALTER path turns that into a no-op.
    check('variant: IF NOT EXISTS again changes nothing', typeof again !== 'string' || /duplicate column/.test(again), String(again));
}
{
    const db = openDb();
    run(db, 'CREATE TABLE logs (id INT, msg TEXT)');
    const r = tryRun(db, 'ALTER TABLE logs ADD COLUMN seen DATETIME AS (NOW()) STORED');
    check('refused: a STORED column of NOW() fails with a reason', typeof r === 'string' && /no SQLite form/.test(r), String(r));
    const r2 = tryRun(db, 'ALTER TABLE logs ADD COLUMN pick DOUBLE GENERATED ALWAYS AS (RAND() * id) STORED');
    check('refused: a STORED column of RAND() fails with a reason', typeof r2 === 'string' && /no SQLite form/.test(r2), String(r2));
}

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' checks failed' : 'all ' + results.length + ' checks passed');
process.exit(failed ? 1 : 0);
