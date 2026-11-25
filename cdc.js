'use strict';

/**
 * MariaDB to SQLite catch-up. Runs on a timer, never on the query path.
 * A table this process just wrote is skipped until dirtyTtlMs elapses,
 * so a write is not copied back over itself.
 *
 * Change Data Capture (CDC) here means polling, not a binlog reader: every
 * pollMs it fingerprints each MariaDB table and, when one differs from the
 * last scan, reloads that table into SQLite. It exists so that edits made
 * outside the server (an admin tool, a web panel, a manual UPDATE) show up in
 * the in-process SQLite copy that every script query reads. server.js starts
 * it after hydration, passes the open SQLite backend and the set of tables the
 * engine itself wrote, and calls tick() or reload(name) from internal exports.
 * It never writes to MariaDB and skips cis_database's own __cis_ tables.
 */

function identOk(name) {
    return typeof name === 'string' && /^[A-Za-z0-9_]+$/.test(name);
}

/**
 * MariaDB's CHECKSUM TABLE of each table, 50 tables per statement.
 * @param {import('mysql2/promise').Connection} conn
 * @param {string} database
 * @param {string[]} names Base table names. Not quoted.
 * @returns {Promise<Map<string,string>>} Lowercased name to its sum; a table MariaDB could not sum is left out.
 */
async function checksumTables(conn, database, names, log) {
    const out = new Map();
    const prefix = String(database) + '.';
    for (let i = 0; i < names.length; i += 50) {
        const part = names.slice(i, i + 50).filter(identOk);
        if (!part.length) continue;
        try {
            const [rows] = await conn.query('CHECKSUM TABLE ' + part.map((n) => '`' + n + '`').join(', '));
            for (const r of rows || []) {
                const full = String(r.Table != null ? r.Table : r.table);
                const sum = r.Checksum != null ? r.Checksum : r.checksum;
                if (sum == null || !full.startsWith(prefix)) continue;
                out.set(full.slice(prefix.length).toLowerCase(), String(sum));
            }
        } catch (e) {
            if (log && log.debug) log.debug('CHECKSUM TABLE not read: ' + (e && e.message));
        }
    }
    return out;
}

/**
 * Start the catch-up timer.
 * @param {object} opts
 * @param {object} opts.mysql2mod mysql2/promise module.
 * @param {{host:string,port:number,user:string,password:string,database:string,ssl?:object}} opts.dsn
 *   The replica's DSN; ssl is mysql2's TLS setting, set when the DSN asks for it.
 * @param {{exec:Function,run:Function}} opts.backend Open SQLite backend.
 * @param {Set<string>} opts.dirtyTables Tables written by this process, lowercased.
 * @param {number} opts.pollMs Milliseconds between scans. Below 50 becomes 1000.
 * @param {number} opts.dirtyTtlMs How long a self-written table is skipped.
 * @param {{info:Function,debug:Function,warn:Function,error:Function}} opts.log
 * @param {Function} [opts.txBusy] True while the server is too busy for a scan.
 * @param {Function} [opts.hardBusy] True while a copy cannot run at all (an open SQLite transaction).
 * @param {number} [opts.forceMs] At least this often a scan runs past txBusy, waiting only for hardBusy. 0 never.
 * @param {Promise} [opts.baseline] Settles when the first fingerprints may be taken.
 * @param {Map<string,string>} [opts.sums] MariaDB's CHECKSUM TABLE of each table SQLite holds the same rows of, lowercased names. Kept current.
 * @param {Function} [opts.onSynced] (table, sum) after a copy left SQLite with the rows of that sum.
 * @returns {{stop:Function,tick:Function,reload:Function}} stop() clears the timer. tick() is one scan. reload(name) copies one table now.
 */
function startCdc(opts) {
    const {
        mysql2mod, dsn, backend, dialect, dirtyTables, pollMs, dirtyTtlMs, log, txBusy, pending, recheck,
        hardBusy, forceMs, sums,
    } = opts;
    if (!mysql2mod || !dsn || !backend) return { stop() {} };
    const fps = Object.create(null);
    const dirtyAt = Object.create(null);
    const DIRTY_TTL_MS = dirtyTtlMs > 0 ? dirtyTtlMs : 2000;
    let timer = null;
    let busy = false;
    const interval = pollMs >= 50 ? pollMs : 1000;
    // A busy server never has the quiet txBusy waits for, so at least every
    // forceMs a scan runs anyway. It waits only for what a copy cannot run
    // beside (hardBusy: an open SQLite transaction, a WAL step), and gives up
    // a table the game writes while it is being copied.
    const FORCE_MS = forceMs > 0 ? forceMs : 0;
    let lastFull = Date.now();
    let forced = false;
    let copyStart = 0;

    function blocked() {
        if (forced) return typeof hardBusy === 'function' && hardBusy();
        return typeof txBusy === 'function' && txBusy();
    }

    // The game wrote this table since its copy began, or still has writes
    // for it in the outbox. Rows read from MariaDB before that write would
    // undo it, in a forced scan or not: the copy awaits each page.
    function writtenSince(table) {
        const k = String(table).toLowerCase();
        if (typeof pending === 'function' && pending(k)) return true;
        return !!dirtyAt[k] && dirtyAt[k] >= copyStart;
    }

    function noteDirty(table) {
        if (!table || !identOk(String(table))) return;
        const k = String(table).toLowerCase();
        dirtyAt[k] = Date.now();
        if (dirtyTables) dirtyTables.add(k);
    }

    // cis_database's own tables (outbox, replica state, hydrate staging).
    function isInternal(table) {
        return String(table).toLowerCase().startsWith('__cis_');
    }

    function sqliteHasRows(table) {
        if (!identOk(table) || !backend || typeof backend.get !== 'function') return false;
        const qn = '"' + table.replace(/"/g, '""') + '"';
        try {
            return !!backend.get('SELECT 1 AS n FROM ' + qn + ' LIMIT 1', []);
        } catch (e) {
            return false;
        }
    }

    function dirtyBlocks(table) {
        if (!table) return false;
        const k = String(table).toLowerCase();
        // Writes to this table still wait in the outbox. MariaDB is behind
        // SQLite there, so copying it now would undo them.
        if (typeof pending === 'function' && pending(k)) return true;
        const at = dirtyAt[k];
        if (!at && !(dirtyTables && dirtyTables.has(k))) return false;
        if (at && (Date.now() - at) >= DIRTY_TTL_MS) {
            if (dirtyTables) dirtyTables.delete(k);
            delete dirtyAt[k];
            return false;
        }
        if (!at) dirtyAt[k] = Date.now();
        return true;
    }

    /**
     * Identity of a table's contents, as far as information_schema can see.
     * UPDATE_TIME does not move on an InnoDB UPDATE, so the MariaDB
     * INNODB_SYS_TABLESTATS.MODIFIED_COUNTER is appended. A server without
     * that view still returns the three information_schema fields.
     * @param {import('mysql2/promise').Connection} conn
     * @param {string} table Base table name. Not quoted.
     * @returns {Promise<string>} Four fields joined by '#'.
     */
    async function fingerprint(conn, table) {
        const [meta] = await conn.query(
            'SELECT UPDATE_TIME, TABLE_ROWS, AUTO_INCREMENT FROM information_schema.tables WHERE table_schema = ? AND table_name = ? LIMIT 1',
            [dsn.database, table]
        );
        const m = meta && meta[0] ? meta[0] : {};
        let modified = 'NULL';
        try {
            const [stats] = await conn.query(
                'SELECT MODIFIED_COUNTER FROM information_schema.INNODB_SYS_TABLESTATS WHERE NAME = ? LIMIT 1',
                [dsn.database + '/' + table]
            );
            const s = stats && stats[0] ? stats[0] : {};
            if (s.MODIFIED_COUNTER != null || s.modified_counter != null) {
                modified = String(s.MODIFIED_COUNTER != null ? s.MODIFIED_COUNTER : s.modified_counter);
            }
        } catch (e) { /* not MariaDB or no privilege */ }
        return String(m.UPDATE_TIME || m.update_time || 'NULL')
            + '#' + String(m.TABLE_ROWS != null ? m.TABLE_ROWS : m.table_rows != null ? m.table_rows : 'NULL')
            + '#' + String(m.AUTO_INCREMENT != null ? m.AUTO_INCREMENT : m.auto_increment != null ? m.auto_increment : 'NULL')
            + '#' + modified;
    }

    /**
     * Copy one MariaDB table into SQLite inside a single transaction.
     * Creates the SQLite table when it does not exist, with the MariaDB
     * PRIMARY KEY, so a row whose key SQLite has is updated in place
     * (INSERT ... ON CONFLICT DO UPDATE). The copy never deletes a row to
     * make room for another: INSERT OR REPLACE did, and that delete ran the
     * child tables' ON DELETE CASCADE (a players reload wiped
     * player_vehicles in SQLite while MariaDB kept the cars).
     * A table with no unique key is emptied and copied again.
     * @param {import('mysql2/promise').Connection} conn
     * @param {string} table
     * @returns {Promise<number>} Rows written, or -1 when the transaction failed. 0 when the table is empty or still inside its dirty window.
     */
    async function reloadTable(conn, table) {
        if (!identOk(table) || isInternal(table)) return 0;
        // Every page reads one snapshot, so an outside insert or delete
        // between pages cannot shift OFFSET and hide a row from the scan
        // (the delete pass would then remove that row from SQLite).
        await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
        try {
            return await reloadPages(conn, table);
        } finally {
            try { await conn.query('COMMIT'); } catch (e) { /* connection closed */ }
        }
    }

    async function reloadPages(conn, table) {
        if (forced ? writtenSince(table) : dirtyBlocks(table)) return 0;
        if (blocked()) {
            backoffUntil = Date.now() + Math.max(interval * 5, 5000);
            return -1;
        }
        copyStart = Date.now();
        const qn = '"' + table.replace(/"/g, '""') + '"';
        const quoted = '`' + table.replace(/`/g, '``') + '`';
        const PAGE = 500;
        let offset = 0;
        let keys = null;
        let ins = null;
        let pk = [];
        let n = 0;
        let failed = 0;
        let firstError = '';
        const seen = [];
        // Rows that failed, most often on another UNIQUE key (a plate) a row
        // MariaDB deleted still holds in SQLite. They are tried again once
        // the delete pass has removed such rows.
        const retry = [];
        // Set when SQLite has no PRIMARY KEY or UNIQUE index on MariaDB's key
        // (its schema changed outside), so ON CONFLICT has no target: each row
        // is then updated by key, and inserted when no row has that key.
        let byKey = null;
        // MariaDB's unique keys, read before the first page: the pages are
        // read in PRIMARY KEY order, each starting after the last key of the
        // page before (keyset paging). LIMIT/OFFSET with no ORDER BY gave no
        // row order, and on a table with no snapshot (MyISAM, Aria) a DELETE
        // between pages shifted OFFSET past a live row; the delete pass then
        // removed that row from SQLite, with its ON DELETE CASCADE children.
        let idx = null;
        try {
            [idx] = await conn.query(
                'SELECT index_name, non_unique, column_name, seq_in_index FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? AND non_unique = 0 ORDER BY index_name, seq_in_index',
                [dsn.database, table]
            );
        } catch (e) { /* no statistics view */ }
        const primary = [];
        for (let i = 0; i < (idx || []).length; i++) {
            const row = idx[i];
            const iname = String(row.INDEX_NAME || row.index_name || '');
            const col = row.COLUMN_NAME || row.column_name;
            if (iname.toUpperCase() === 'PRIMARY' && identOk(col)) primary.push(String(col));
        }
        const mq = (c) => '`' + c.replace(/`/g, '``') + '`';
        // WHERE (a > ?) OR (a = ? AND b > ?) ...: the rows after the last key.
        const after = primary.map((c, i) => '(' + primary.slice(0, i).map((p) => mq(p) + ' = ? AND ').join('') + mq(c) + ' > ?)').join(' OR ');
        const byPrimary = primary.length ? ' ORDER BY ' + primary.map(mq).join(', ') : '';
        let lastKey = null;
        const keyOf = (row) => {
            const names = Object.keys(row);
            return primary.map((c) => {
                if (c in row) return row[c];
                const lc = c.toLowerCase();
                for (let i = 0; i < names.length; i++) if (names[i].toLowerCase() === lc) return row[names[i]];
                return undefined;
            });
        };
        const put = (vals) => {
            if (!byKey) {
                try { backend.run(ins, vals); return; } catch (e) {
                    if (!pk.length || !/ON CONFLICT clause does not match/i.test(e && e.message ? e.message : String(e))) throw e;
                    const q = (c) => '"' + c.replace(/"/g, '""') + '"';
                    const rest = keys.filter((k) => pk.indexOf(k) < 0);
                    const where = ' WHERE ' + pk.map((c) => q(c) + ' = ?').join(' AND ');
                    byKey = {
                        rest: rest.map((k) => keys.indexOf(k)),
                        at: pk.map((c) => keys.indexOf(c)),
                        upd: rest.length ? 'UPDATE ' + qn + ' SET ' + rest.map((c) => q(c) + ' = ?').join(', ') + where : null,
                        has: 'SELECT 1 AS x FROM ' + qn + where + ' LIMIT 1',
                        add: 'INSERT INTO ' + qn + ' (' + keys.map(q).join(',') + ') VALUES (' + keys.map(() => '?').join(',') + ')',
                    };
                }
            }
            const key = byKey.at.map((i) => vals[i]);
            const found = byKey.upd
                ? Number((backend.run(byKey.upd, byKey.rest.map((i) => vals[i]).concat(key)) || {}).changes || 0) > 0
                : !!backend.get(byKey.has, key);
            if (!found) backend.run(byKey.add, vals);
        };
        while (true) {
            if (blocked() || writtenSince(table)) {
                backoffUntil = Date.now() + Math.max(interval * 5, 5000);
                return -1;
            }
            let rows;
            if (primary.length) {
                const params = [];
                if (lastKey) for (let i = 0; i < primary.length; i++) for (let j = 0; j <= i; j++) params.push(lastKey[j]);
                [rows] = await conn.query('SELECT * FROM ' + quoted + (lastKey ? ' WHERE ' + after : '') + byPrimary + ' LIMIT ' + PAGE, params);
            } else {
                [rows] = await conn.query('SELECT * FROM ' + quoted + ' LIMIT ' + PAGE + ' OFFSET ' + offset);
            }
            if (blocked() || writtenSince(table)) {
                backoffUntil = Date.now() + Math.max(interval * 5, 5000);
                return -1;
            }
            if (!rows || !rows.length) {
                // An empty MariaDB table empties the SQLite copy too.
                if (offset === 0) {
                    // A table SQLite lacks or holds no rows of needs nothing. A
                    // DELETE that throws rolls back its own transaction only.
                    if (sqliteHasRows(table)) {
                        let begun = false;
                        try {
                            backend.exec('BEGIN IMMEDIATE');
                            begun = true;
                            backend.exec('DELETE FROM ' + qn);
                            backend.exec('COMMIT');
                        } catch (e) {
                            if (begun) { try { backend.exec('ROLLBACK'); } catch (e2) { /* ignore */ } }
                        }
                    }
                }
                break;
            }
            if (!keys) {
                // SQLite computes its generated columns and refuses values for them.
                let generated = new Set();
                try {
                    generated = new Set((backend.all('SELECT name FROM pragma_table_xinfo(?) WHERE hidden IN (2, 3)', [table]) || [])
                        .map((r) => String(r.name).toLowerCase()));
                } catch (e) { /* no generated columns known */ }
                keys = Object.keys(rows[0]).filter((k) => identOk(k) && !generated.has(k.toLowerCase()));
                if (!keys.length) return 0;
                const cols = keys.map((k) => '"' + k.replace(/"/g, '""') + '"').join(',');
                const ph = keys.map(() => '?').join(',');
                try {
                    const groups = Object.create(null);
                    const order = [];
                    for (let i = 0; i < (idx || []).length; i++) {
                        const row = idx[i];
                        const iname = String(row.INDEX_NAME || row.index_name || '');
                        const keyName = iname.toUpperCase() === 'PRIMARY' ? 'PRIMARY' : iname;
                        const col = row.COLUMN_NAME || row.column_name;
                        if (!groups[keyName]) { groups[keyName] = []; order.push(keyName); }
                        if (identOk(col) && keys.indexOf(col) >= 0) groups[keyName].push(col);
                    }
                    if (groups.PRIMARY && groups.PRIMARY.length) pk = groups.PRIMARY;
                    else {
                        for (let i = 0; i < order.length; i++) {
                            if (groups[order[i]] && groups[order[i]].length) { pk = groups[order[i]]; break; }
                        }
                    }
                } catch (e) { /* no statistics view */ }
                ins = 'INSERT INTO ' + qn + ' (' + cols + ') VALUES (' + ph + ')';
                if (pk.length) {
                    // The key columns already match; every other column takes
                    // MariaDB's value. A row that clashes on another UNIQUE
                    // key fails here instead of deleting the row that holds it.
                    const rest = keys.filter((k) => pk.indexOf(k) < 0).map((k) => '"' + k.replace(/"/g, '""') + '"');
                    ins += ' ON CONFLICT (' + pk.map((c) => '"' + c.replace(/"/g, '""') + '"').join(',') + ') DO '
                        + (rest.length ? 'UPDATE SET ' + rest.map((c) => c + ' = excluded.' + c).join(', ') : 'NOTHING');
                }
                const sample = rows[0];
                const ddlCols = keys.map((k) => {
                    const v = sample[k];
                    const sqlType = typeof v === 'number' ? (Number.isInteger(v) ? 'INTEGER' : 'REAL') : (Buffer.isBuffer(v) || v instanceof Uint8Array) ? 'BLOB' : 'TEXT';
                    return '"' + k.replace(/"/g, '""') + '" ' + sqlType;
                }).join(',');
                const ddl = pk.length
                    ? ddlCols + ', PRIMARY KEY (' + pk.map((c) => '"' + c.replace(/"/g, '""') + '"').join(',') + ')'
                    : ddlCols;
                try {
                    backend.exec('CREATE TABLE IF NOT EXISTS ' + qn + ' (' + ddl + ')');
                } catch (e) {
                    const msg = e && e.message ? e.message : String(e);
                    if (log && log.warn) log.warn('Change Data Capture could not reload ' + table + ': ' + msg);
                    return -1;
                }
            }
            const CHUNK = 40;
            for (let r = 0; r < rows.length;) {
                if (blocked() || writtenSince(table)) {
                    backoffUntil = Date.now() + Math.max(interval * 5, 5000);
                    return -1;
                }
                let began = false;
                try {
                    backend.exec('BEGIN IMMEDIATE');
                    began = true;
                    if (!pk.length && offset === 0 && r === 0) backend.exec('DELETE FROM ' + qn);
                    const end = Math.min(rows.length, r + CHUNK);
                    for (; r < end; r++) {
                        const vals = [];
                        for (let k = 0; k < keys.length; k++) vals.push(rows[r][keys[k]]);
                        // A row that fails still marks its key seen: MariaDB
                        // has that key, so the delete pass must keep it.
                        if (pk.length === 1) {
                            const at = keys.indexOf(pk[0]);
                            if (at >= 0) seen.push(vals[at]);
                        } else if (pk.length > 1) {
                            const idxs = pk.map((c) => keys.indexOf(c));
                            if (idxs.every((at) => at >= 0)) seen.push(JSON.stringify(idxs.map((at) => vals[at])));
                        }
                        try {
                            put(vals);
                            n++;
                        } catch (e) {
                            retry.push(vals);
                        }
                    }
                    backend.exec('COMMIT');
                } catch (e) {
                    const msg = e && e.message ? e.message : String(e);
                    if (/transaction within a transaction/i.test(msg)) {
                        backoffUntil = Date.now() + Math.max(interval * 5, 5000);
                    }
                    if (log && log.warn) log.warn('Change Data Capture could not reload ' + table + ': ' + msg);
                    else if (log) log('[cis_database:warn] Change Data Capture could not reload ' + table + ': ' + msg);
                    if (began) {
                        try { backend.exec('ROLLBACK'); } catch (e2) { /* ignore */ }
                    }
                    return -1;
                }
                await new Promise((res) => setImmediate(res));
            }
            offset += rows.length;
            if (primary.length) {
                lastKey = keyOf(rows[rows.length - 1]);
                // A key the rows do not carry cannot page: stop rather than loop.
                if (lastKey.some((v) => v === undefined || v === null)) {
                    backoffUntil = Date.now() + Math.max(interval * 5, 5000);
                    return -1;
                }
            }
            if (rows.length < PAGE) break;
        }
        // Rows deleted in MariaDB: remove every SQLite row whose key the scan
        // above did not see, unless the game wrote the table during the last
        // page's wait: its new row is not in MariaDB yet.
        // A failed row's key is in seen too, so this pass deletes only rows
        // whose key MariaDB no longer has, failures or not.
        if (blocked() || writtenSince(table)) return -1;
        if (seen.length && pk.length >= 1 && pk.every(identOk)) {
            const where = pk.length === 1
                ? '"' + pk[0].replace(/"/g, '""') + '" NOT IN (SELECT k FROM cis_cdc_seen)'
                : 'json_array(' + pk.map((c) => '"' + c.replace(/"/g, '""') + '"').join(', ') + ') NOT IN (SELECT k FROM cis_cdc_seen)';
            try {
                backend.exec('CREATE TEMP TABLE IF NOT EXISTS cis_cdc_seen (k PRIMARY KEY)');
                backend.exec('DELETE FROM cis_cdc_seen');
                backend.exec('BEGIN IMMEDIATE');
                for (let i = 0; i < seen.length; i++) backend.run('INSERT OR IGNORE INTO cis_cdc_seen (k) VALUES (?)', [seen[i]]);
                backend.exec('DELETE FROM ' + qn + ' WHERE ' + where);
                backend.exec('COMMIT');
            } catch (e) {
                try { backend.exec('ROLLBACK'); } catch (e2) { /* ignore */ }
            }
        }
        if (retry.length) {
            let began = false;
            try {
                backend.exec('BEGIN IMMEDIATE');
                began = true;
                for (let i = 0; i < retry.length; i++) {
                    try {
                        put(retry[i]);
                        n++;
                    } catch (e) {
                        if (!failed) firstError = e && e.message ? e.message : String(e);
                        failed++;
                    }
                }
                backend.exec('COMMIT');
            } catch (e) {
                if (began) {
                    try { backend.exec('ROLLBACK'); } catch (e2) { /* ignore */ }
                }
                if (!failed) firstError = e && e.message ? e.message : String(e);
                failed = retry.length;
            }
        }
        if (failed) {
            // The table is tried again on every poll until it copies, so the
            // warning prints at most once a minute per table.
            const now = Date.now();
            if (!(warnedAt[table] > now - 60000)) {
                warnedAt[table] = now;
                const msg = 'Change Data Capture could not copy ' + failed + ' row' + (failed === 1 ? '' : 's') + ' of ' + table
                    + ' (first: ' + firstError + '); the table is tried again on the next change check.';
                if (log && log.warn) log.warn(msg);
                else if (log) log('[cis_database:warn] ' + msg);
            }
        }
        return failed ? -1 : n;
    }

    // Set when a SQLite transaction is open (txBusy). reloadTable would clash
    // with it, so scans pause for a few intervals instead of failing.
    let backoffUntil = 0;
    // Last copy-failure warning per table (reloadPages).
    const warnedAt = Object.create(null);

    // One scan: list the base tables, fingerprint each, and reload those whose
    // fingerprint changed since the last scan.
    async function tick() {
        if (busy || !backend || !based) return;
        forced = FORCE_MS > 0 && (Date.now() - lastFull) >= FORCE_MS;
        if (!forced && Date.now() < backoffUntil) return;
        if (blocked()) return;
        busy = true;
        let whole = true;
        let conn;
        try {
            conn = await mysql2mod.createConnection({
                host: dsn.host, port: dsn.port, user: dsn.user, password: dsn.password, database: dsn.database, ssl: dsn.ssl,
                // As hydration reads rows: dates as MariaDB's text, BIGINT digits whole.
                dateStrings: true, supportBigNumbers: true,
            });
            const [tables] = await conn.query(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'",
                [dsn.database]
            );
            let applied = 0;
            for (let i = 0; i < tables.length; i++) {
                if (blocked()) { whole = false; break; }
                const name = tables[i].TABLE_NAME || tables[i].table_name;
                if (!name || isInternal(name)) continue;
                const fp = await fingerprint(conn, name);
                if (forced ? (typeof pending === 'function' && pending(String(name).toLowerCase())) : dirtyBlocks(name)) continue;
                if (fps[name] === fp) continue;
                // Hydrate already copied the table. The first sighting records
                // the fingerprint so CDC does not copy those rows again. A
                // table hydrate kept (recheck) was not copied, so it is.
                const lname = String(name).toLowerCase();
                if (fps[name] == null && sqliteHasRows(name) && !(recheck && recheck.has(lname))) {
                    fps[name] = fp;
                    continue;
                }
                // The fingerprint also moves when no row did: our own
                // AUTO_INCREMENT reserve, a TABLE_ROWS estimate, a statistics
                // recalc resetting MODIFIED_COUNTER. MariaDB's checksum still
                // the one SQLite holds the rows of means nothing to copy.
                const known = sums && !(recheck && recheck.has(lname)) ? sums.get(lname) : undefined;
                const before = sums ? (await checksumTables(conn, dsn.database, [name], log)).get(lname) : undefined;
                if (known != null && before === known) {
                    fps[name] = fp;
                    continue;
                }
                const n = await reloadTable(conn, name);
                if (n < 0) continue;
                if (n > 0 && typeof opts.onTable === 'function') opts.onTable(name, n);
                applied += n;
                fps[name] = fp;
                if (recheck) recheck.delete(lname);
                if (sums) {
                    // The same sum after the copy as before it: no row changed
                    // while it ran, so SQLite holds that sum's rows.
                    const after = before != null ? (await checksumTables(conn, dsn.database, [name], log)).get(lname) : undefined;
                    if (after != null && after === before) {
                        sums.set(lname, after);
                        if (typeof opts.onSynced === 'function') opts.onSynced(name, after);
                    } else {
                        sums.delete(lname);
                    }
                }
            }
            // Every table was looked at, copied or not: the next forced scan is
            // forceMs away. A table the game kept writing is tried again then.
            if (whole) lastFull = Date.now();
            if (applied && log && log.info) log.info('Change Data Capture: synchronized ' + applied + ' updated rows from MariaDB.');
            else if (!applied && log && log.debug) log.debug('Change Data Capture scan complete: 0 external modifications detected.');
        } catch (e) {
            if (log && log.error) log.error('Change Data Capture failed: ' + (e && e.message));
            else if (log) log('[cis_database] Change Data Capture failed: ' + (e && e.message));
        } finally {
            try { if (conn) await conn.end(); } catch (e) { /* ignore */ }
            busy = false;
        }
    }

    timer = setInterval(tick, interval);
    if (timer.unref) timer.unref();
    setTimeout(tick, 8000);
    // Fingerprints of what hydrate copied, taken once at start. Without them
    // the first scan records whatever MariaDB holds then as already copied,
    // and on a busy server that scan may come after a row was written there.
    // It waits for opts.baseline (the first AUTO_INCREMENT reserve, whose
    // ALTER moves the fingerprint), 5 s at most.
    let based = false;
    async function baselineFps() {
        let conn;
        try {
            conn = await mysql2mod.createConnection({
                host: dsn.host, port: dsn.port, user: dsn.user, password: dsn.password, database: dsn.database, ssl: dsn.ssl,
            });
            const [tables] = await conn.query(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'",
                [dsn.database]
            );
            for (let i = 0; i < tables.length; i++) {
                const name = tables[i].TABLE_NAME || tables[i].table_name;
                if (!name || isInternal(name)) continue;
                if (fps[name] != null || !sqliteHasRows(name) || (recheck && recheck.has(String(name).toLowerCase()))) continue;
                fps[name] = await fingerprint(conn, name);
            }
        } catch (e) {
            if (log && log.debug) log.debug('Change Data Capture baseline skipped: ' + (e && e.message));
        } finally {
            try { if (conn) await conn.end(); } catch (e) { /* ignore */ }
            based = true;
        }
    }
    Promise.race([Promise.resolve(opts.baseline).catch(() => {}), new Promise((r) => setTimeout(r, 5000))]).then(baselineFps);
    async function reload(tableName) {
        if (!mysql2mod || !dsn || !backend) return 0;
        if (tableName && dirtyTables) dirtyTables.delete(String(tableName).toLowerCase());
        let conn;
        try {
            conn = await mysql2mod.createConnection({
                host: dsn.host, port: dsn.port, user: dsn.user, password: dsn.password, database: dsn.database, ssl: dsn.ssl,
                dateStrings: true, supportBigNumbers: true,
            });
            if (tableName && identOk(tableName)) {
                forced = false;
                const n = await reloadTable(conn, tableName);
                fps[tableName] = await fingerprint(conn, tableName);
                return n;
            }
            await tick();
            return true;
        } finally {
            try { if (conn) await conn.end(); } catch (e) { /* ignore */ }
        }
    }

    return {
        tick,
        reload,
        noteDirty,
        stop() { if (timer) clearInterval(timer); },
    };
}

module.exports = { startCdc, checksumTables };
