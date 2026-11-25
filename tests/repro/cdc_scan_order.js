'use strict';

// The change copy read a MariaDB table in pages of 500 with LIMIT/OFFSET and
// no ORDER BY, then deleted every SQLite row whose key no page returned.
// Two ways a page can miss a row MariaDB still has:
//  A. A table with no MVCC (MyISAM, Aria) ignores the consistent snapshot,
//     so an outside DELETE between two pages shifts OFFSET past a live row.
//  B. Without ORDER BY, SQL gives no row order, so two pages of the same
//     snapshot may overlap and leave a row out.
// The missed row was then deleted from SQLite, and with foreign_keys on its
// child rows went with it through ON DELETE CASCADE. The scan now pages by
// the PRIMARY KEY (keyset: WHERE key > last ORDER BY key), which needs no
// snapshot and no implied order.
// Usage: node tests/repro/cdc_scan_order.js

const { DatabaseSync } = require('node:sqlite');
const { startCdc } = require('../../cdc.js');

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
const backend = {
    exec: (s) => db.exec(s),
    run: (s, p) => db.prepare(s).run(...(p || [])),
    get: (s, p) => db.prepare(s).get(...(p || [])),
    all: (s, p) => db.prepare(s).all(...(p || [])),
};

// A small SQL engine for the scan's SELECT: WHERE (keyset on the ORDER BY
// columns, its last tuple taken from the params), ORDER BY, LIMIT, OFFSET.
// With no ORDER BY the row order changes on every call, as SQL allows.
const maria = { players: [], tags: [] };
const keysOf = { players: [['PRIMARY', 'id']], tags: [['PRIMARY', 'a'], ['PRIMARY', 'b']] };
let calls = 0;
let afterPage = null;
const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
const conn = {
    async query(sql, params) {
        const m = /^SELECT \* FROM `([^`]+)`( WHERE .+?)?( ORDER BY (.+?))? LIMIT (\d+)(?: OFFSET (\d+))?$/.exec(sql);
        if (m) {
            calls++;
            let rows = maria[m[1]].slice();
            const order = m[4] ? m[4].split(',').map((c) => c.trim().replace(/^`|`$/g, '')) : null;
            if (order) {
                const tup = (r) => order.map((c) => r[c]);
                const byTup = (p, q) => { for (let i = 0; i < p.length; i++) { const c = cmp(p[i], q[i]); if (c) return c; } return 0; };
                rows.sort((p, q) => byTup(tup(p), tup(q)));
            }
            if (m[2]) {
                // Evaluate the WHERE as written: (`a` = ? AND `b` > ?) OR ...,
                // binding the params left to right.
                const ps = (params || []).slice();
                const terms = m[2].replace(/^ WHERE /, '').split(' OR ').map((t) => t.replace(/^\(|\)$/g, '').split(' AND ').map((c) => {
                    const cm = /^`([^`]+)` (=|>|>=|<) \?$/.exec(c);
                    if (!cm) throw new Error('fake engine: cannot read ' + c);
                    return { col: cm[1], op: cm[2], v: ps.shift() };
                }));
                if (ps.length) throw new Error('fake engine: ' + ps.length + ' params left over');
                const test = (r, c) => {
                    const x = cmp(r[c.col], c.v);
                    return c.op === '=' ? x === 0 : c.op === '>' ? x > 0 : c.op === '>=' ? x >= 0 : x < 0;
                };
                rows = rows.filter((r) => terms.some((t) => t.every((c) => test(r, c))));
            }
            if (!order && calls % 2 === 0) rows.reverse();
            const off = m[6] ? Number(m[6]) : 0;
            const page = rows.slice(off, off + Number(m[5])).map((r) => Object.assign({}, r));
            if (afterPage) { const f = afterPage; afterPage = null; f(); }
            return [page];
        }
        if (/information_schema\.statistics/.test(sql)) {
            const k = keysOf[params && params[1]] || [];
            const seq = Object.create(null);
            return [k.map(([name, col]) => {
                seq[name] = (seq[name] || 0) + 1;
                return { INDEX_NAME: name, non_unique: 0, COLUMN_NAME: col, seq_in_index: seq[name] };
            })];
        }
        return [[]];
    },
    async end() {},
};
const mysql2mod = { createConnection: async () => conn };
const quiet = { info() {}, debug() {}, warn() {}, error() {} };

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}
const one = (sql) => db.prepare(sql).get();

function seed() {
    db.exec('DELETE FROM vehicles');
    db.exec('DELETE FROM players');
    maria.players = [];
    for (let id = 1; id <= 600; id++) {
        maria.players.push({ id, name: 'p' + id });
        db.prepare('INSERT INTO players VALUES (?, ?)').run(id, 'p' + id);
        db.prepare('INSERT INTO vehicles VALUES (?, ?)').run(id, id);
    }
    calls = 0;
}

(async () => {
    db.exec('CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec('CREATE TABLE vehicles (id INTEGER PRIMARY KEY, owner INTEGER REFERENCES players (id) ON DELETE CASCADE)');
    db.exec('CREATE TABLE tags (a TEXT, b INTEGER, PRIMARY KEY (a, b))');

    const cdc = startCdc({
        mysql2mod, dsn: { host: 'x', port: 3306, user: 'u', password: '', database: 'd' }, backend,
        dirtyTables: new Set(), pollMs: 3600000, dirtyTtlMs: 50, log: quiet, baseline: Promise.resolve(),
    });

    // A: MariaDB deletes player 5 after the first page was read, on a table
    // with no snapshot. Player 501 must stay, with its car.
    seed();
    afterPage = () => { maria.players = maria.players.filter((r) => r.id !== 5); };
    const a = await cdc.reload('players');
    check('A: a delete between pages keeps every live row', one('SELECT COUNT(*) AS n FROM players WHERE id <> 5').n === 599,
        'players=' + one('SELECT COUNT(*) AS n FROM players').n + ' n=' + a);
    check('A: the row after the page edge is still there', !!one('SELECT 1 AS x FROM players WHERE id = 501'));
    check('A: its child row survives the delete pass', !!one('SELECT 1 AS x FROM vehicles WHERE owner = 501'));
    // Player 5 was on the page already read, so this reload keeps it; the
    // next one removes it, with its car, as MariaDB did.
    await cdc.reload('players');
    check('A: the next reload removes the row MariaDB deleted, with its child', !one('SELECT 1 AS x FROM players WHERE id = 5')
        && !one('SELECT 1 AS x FROM vehicles WHERE owner = 5') && one('SELECT COUNT(*) AS n FROM players').n === 599);

    // B: no change in MariaDB, but each query returns its rows in another
    // order, as SQL allows without ORDER BY.
    seed();
    const b = await cdc.reload('players');
    check('B: an unordered engine loses no row', one('SELECT COUNT(*) AS n FROM players').n === 600 && b === 600,
        'players=' + one('SELECT COUNT(*) AS n FROM players').n + ' n=' + b);
    check('B: no child row is cascaded away', one('SELECT COUNT(*) AS n FROM vehicles').n === 600,
        'vehicles=' + one('SELECT COUNT(*) AS n FROM vehicles').n);

    // C: a composite key pages by every key column; 1,200 rows in 3 pages,
    // with a key value repeated across a page edge.
    maria.tags = [];
    for (let i = 0; i < 1200; i++) maria.tags.push({ a: 'k' + String(Math.floor(i / 7)).padStart(4, '0'), b: i % 7 });
    calls = 0;
    const c = await cdc.reload('tags');
    check('C: a composite key copies every row', one('SELECT COUNT(*) AS n FROM tags').n === 1200 && c === 1200,
        'tags=' + one('SELECT COUNT(*) AS n FROM tags').n + ' n=' + c);
    // k0071 spans the first page edge (rows 497-503). MariaDB deletes the 7
    // rows of k0010 once page 1 is read: page 2 must still start at k0071.
    afterPage = () => { maria.tags = maria.tags.filter((r) => r.a !== 'k0010'); };
    await cdc.reload('tags');
    check('C: a delete between pages loses no live composite-key row', one("SELECT COUNT(*) AS n FROM tags WHERE a <> 'k0010'").n === 1193,
        'tags=' + one("SELECT COUNT(*) AS n FROM tags WHERE a <> 'k0010'").n);
    await cdc.reload('tags');
    check('C: the next reload applies that delete', one('SELECT COUNT(*) AS n FROM tags').n === 1193
        && !one("SELECT 1 AS x FROM tags WHERE a = 'k0010'"), 'tags=' + one('SELECT COUNT(*) AS n FROM tags').n);

    const fk = db.prepare('PRAGMA foreign_key_check').all();
    check('no foreign key is left dangling', fk.length === 0, JSON.stringify(fk));

    cdc.stop();
    const bad = results.filter((ok) => !ok).length;
    console.log(bad ? 'FAIL ' + bad + ' of ' + results.length : 'ALL ' + results.length + ' PASS');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
