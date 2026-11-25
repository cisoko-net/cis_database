# cis_database API

Product version **1.0.0** (`cis_version` in `fxmanifest.lua`; its `version '2.14.3'` is the oxmysql version ox_inventory checks for). Two ways to call it. Existing resources keep the oxmysql include. A resource that does not want oxmysql calls `exports.cis_database` and never loads `MySQL.lua`.

All of these are server calls. There is no client database API.

## 1. MySQL include

In the calling resource:

```lua
server_script '@oxmysql/lib/MySQL.lua'
```

`@cis_database/lib/MySQL.lua` is the same file. Use that form when the resource should not mention oxmysql.

`MySQL.query`, `MySQL.single`, `MySQL.scalar`, `MySQL.insert`, `MySQL.update`, `MySQL.prepare`, `MySQL.transaction`, and `MySQL.rawExecute` each take `(sql, params, callback)`. `params` and `callback` can be left out. Each method also has `.await`, which must run inside a coroutine (`CreateThread`, an event handler, or a command).

```lua
MySQL.update('UPDATE users SET accounts = ? WHERE identifier = ?', { json.encode(accounts), identifier })

local row = MySQL.single.await('SELECT * FROM users WHERE identifier = ?', { identifier })
```

| Call | Returns |
|---|---|
| `MySQL.query` | array of rows. Empty is `{}`. For an `INSERT`, `UPDATE`, `DELETE` or DDL statement, the mysql2 header oxmysql returns: `{ affectedRows, insertId, ... }`. |
| `MySQL.single` | one row, or nil. |
| `MySQL.scalar` | the first column of the first row. |
| `MySQL.insert` | the new numeric id. `0` when nothing was inserted (`INSERT IGNORE` of a duplicate). |
| `MySQL.update` | the number of rows changed. |
| `MySQL.prepare` | for a read: the rows when there are several, one value when the one row has one column, otherwise the row, nil when there is none. The insert id for an `INSERT`, the number of rows changed for an `UPDATE` or `DELETE`. |
| `MySQL.transaction` | `true`, or `false` when a statement fails. A failure rolls every statement in the list back and prints the error in the server console. |
| `MySQL.rawExecute` | rows for a read, the `{ affectedRows, insertId, ... }` header for a write. One statement per call: a second statement after a `;` is refused with `ER_PARSE_ERROR` unless `cis_database_multi_statements` is `true` ([CONFIG.md](docs/CONFIG.md)). |
| `MySQL.ready(cb)` | calls `cb` once the engine is ready. `MySQL.ready.await()` returns `true`. |

`sql` can be a string, or a table `{ query = '...', values = {} }`. The keys `sql`, `parameters`, and `params` are accepted too.

`MySQL.prepare` and `MySQL.rawExecute` also take a list of parameter lists, `{ { 'a', 1 }, { 'b', 2 } }`, as oxmysql does, and run the statement once per list, in order. No transaction holds the lists together: a list that fails stops the batch, the lists before it stay written, and its error is the call's error. `prepare` then returns one entry per list: the insert id for an `INSERT`, the number of rows changed for an `UPDATE` or `DELETE`, and for any other statement what that list gave. `rawExecute` returns the header or the rows of each list. A batch always runs on SQLite, never on MariaDB.

Names kept for older scripts:

| Name | Same as |
|---|---|
| `MySQL.execute`, `MySQL.fetch` | `MySQL.query` |
| `MySQL.fetchAll` | `MySQL.query` |
| `MySQL.fetchSingle` | `MySQL.single` |
| `MySQL.fetchScalar` | `MySQL.scalar` |
| `MySQL.Async.execute` | `MySQL.update` |
| `MySQL.Sync.execute` | `MySQL.update.await` |

`MySQL.Async` also has `fetchAll`, `fetchScalar`, `fetchSingle`, `insert`, `transaction`, and `prepare`. `MySQL.Sync` has the same names and each one awaits.

With cis_database, each `.await` form answers in the same call when the statement ran at once, which is nearly always: the include calls `cis_call` (below) and gets the result back as the export's return value, instead of handing the export a new Lua callback for every call. A call the slice budget holds back is answered a moment later through one callback the include registers per resource. The results and errors are the same either way; the callback forms (`MySQL.query(sql, params, cb)`) are unchanged.

Parameters use `?`. `IN (?)` bound to a table of values becomes `IN (?, ?, ...)`, on SQLite and on the MariaDB copy alike; a string is one value even when it contains a comma, as in oxmysql. A named parameter `@id` or `:id` is accepted when `params` is a table with that key. A value with no `?` left for it is an error, `Expected 1 parameters, but received 2.`, as in oxmysql; a missing value at the end is `NULL`, and a statement with no `?` ignores its values. A `SET ?` whose value is a table of column names is expanded to `` `name` = ? `` for each key. A `VALUES ?` whose value is an array of rows is expanded to one placeholder group per row.

## 2. Direct exports

Use this when the resource should not depend on the oxmysql names.

FiveM drops the first argument of an export, so the call needs a leading `nil`. Without it, the SQL string is discarded.

```lua
exports.cis_database:query(nil, 'SELECT identifier FROM users WHERE id = ?', { id }, function(rows)
end)

local rows = Citizen.Await(exports.cis_database:query_async(nil, 'SELECT identifier FROM users WHERE id = ?', { id }))
```

The same three forms exist for `single`, `scalar`, `update`, `insert`, `prepare`, `transaction`, and `rawExecute`:

| Form | How the result comes back |
|---|---|
| `query` | the callback. The call itself returns nothing. |
| `query_async` | a promise. `Citizen.Await` gives the rows. |
| `querySync` | the same promise as `query_async`. The name does not block the server thread. |

`fetchAll`, `fetchSingle`, and `fetchScalar` are the mysql-async names for `query`, `single`, and `scalar`. `execute` and `fetch` are `query`, as in oxmysql, each with `_async` and `Sync` forms.

`MySQL.store(query, cb)` in the include keeps the query and hands back a number (to `cb` and as the return value); any later `MySQL.*` call takes that number in place of the SQL, as with oxmysql. A number the include never handed back raises an error. The `store` export, kept for scripts written against mysql-async and ghmattimysql, passes the query itself back, and a later export call runs it as SQL.

Every export above also answers as `exports.oxmysql:<name>`. Scripts written against the other drivers get the names oxmysql 2.14.3 gives them, with oxmysql's results:

| Called as | Runs |
|---|---|
| `exports['mysql-async']:mysql_execute` / `mysql_insert` / `mysql_fetch_all` / `mysql_fetch_scalar` / `mysql_transaction` / `mysql_store` | `update` / `insert` / `query` / `scalar` / `transaction` / `store` |
| `exports.ghmattimysql:execute` / `scalar` / `transaction` / `store` | `query` / `scalar` / `transaction` / `store` |
| `exports.ghmattimysql:executeSync` / `scalarSync` / `transactionSync` / `storeSync` | `querySync` / `scalarSync` / `transactionSync` / `storeSync` |

`isReady()` returns `true` only after the copy from MariaDB has finished. `awaitConnection()` returns `true` once that is so: `exports.oxmysql:awaitConnection()` in a thread waits for it, and `awaitConnection(cb)` calls `cb(true)`.

`execMany` and `queryMany` are the same function. They are not part of oxmysql. Pass an array of `{ query = '...', values = {} }` and a callback. The statements run in one transaction. The callback receives one result per statement, or `false` and an error string if any statement fails. A call without a list raises in the caller.

```lua
exports.cis_database:execMany({
    { query = 'UPDATE users SET accounts = ? WHERE identifier = ?', values = { accounts, identifier } },
    { query = 'INSERT INTO logs (identifier, kind) VALUES (?, ?)', values = { identifier, 'save' } },
}, function(results, err)
end)
```

`transaction` takes that same array, and the other two oxmysql forms: a list of `{ 'sql', { values } }` pairs, or a list of SQL strings followed by one values table that every string uses. It returns `true`, or `false` when a statement fails, an item has no SQL, or a transaction is already open; the reason is printed in the server console.

`cis_register(fn)` and `cis_call(method, sql, params)` are the path the include's `.await` forms use; another resource may use them too. `cis_register` stores `fn` as the calling resource's resolver and returns `true`. `cis_call` runs `method` (`query`, `single`, `scalar`, `insert`, `update`, `prepare`, `transaction`, `rawExecute`; for `transaction`, `sql` is the list) and returns a table:

| Return | Meaning |
|---|---|
| `{ 1, result }` | done; the same result the callback export gives |
| `{ 2, message }` | failed |
| `{ 0, id }` | held back by the slice budget; the resolver is called later with `(id, result)` or `(id, nil, message)` |
| `{ 3 }` | the calling resource has no resolver (cis_database restarted): register again |

A resolver is dropped when its resource stops.

## 3. Not for other resources

These exports answer another resource with `false` and `cis_database: <name> is internal`:

- `shutdown`
- `flushReplica`
- `reloadTable`, `hydrate`
- `cis_dash_snapshot`, `cis_dash_watch` (the `/cis_db` panel)

An empty invoker is refused as well.

The `/cis_db` panel itself opens only for a player with the ACE `cis_database.dashboard`, checked on the server when it opens and on every update. Grant it in `server.cfg` with `add_ace group.admin cis_database.dashboard allow`. A player without it gets `no permission: needs ace cis_database.dashboard` in chat and F8.

While `hydrate` copies tables from MariaDB, every other call waits for it and then runs in arrival order. A copied table has no strict-mode or foreign-key checks until the copy ends. `isReady` stays true while calls wait. Nothing calls `hydrate` at runtime. A full copy holds calls for as long as the boot copy takes, so run it only with no players on.

`probe` exists for the test harness and the benchmark. A game resource does not need it. Any resource may read `probe()`; `probe(true)` resets the counters only when cis_database itself calls it or the caller is granted `add_ace resource.<name> cis_database.probe allow` (the benchmark adds this line for `cis_bench`). `probe()` reports, among others, `replica` (writes still in the outbox for MariaDB), `queued` (calls waiting for the next slice), `slice_max_ms` (the longest slice since the last `probe(true)`), `frame_ms` (the per-frame budget), `wake_avg_ms` / `wake_max_ms` (how long the next slice waited for its wake), `ckpt` (`split` when checkpoint syncs run on the thread pool), `ckpt_n`, `ckpt_copy_max_ms`, `wal_frames`, `wal_restarts`, `wal_prealloc` (bytes the WAL file was grown to at boot), `ack`, `fsync_n`, `fsync_avg_ms` / `fsync_max_ms` (time from starting a WAL sync to its completion reaching this thread), `fsync_errors` and `acks_waiting`.

## 4. Errors

A failed query does not call the callback of `MySQL.query`, `single`, `scalar`, `insert`, `update`, `prepare` or `rawExecute`, or of the export with the same name; the error is printed in the server console, as with oxmysql. A resource with `mysql_option 'return_callback_errors'` in its fxmanifest gets the callback as `(nil, message)` instead; a direct export call asks for the same by passing `true` after the resource name: `exports.cis_database:query(nil, sql, params, cb, GetCurrentResourceName(), true)`. `.await` and the `_async` and `Sync` exports reject with the message. `transaction` calls back with `false`, and `execMany` with `false, message`. A read that SQLite cannot run is sent to MariaDB when the replica is connected, and the MariaDB result is what the caller gets. A write that SQLite refuses is a failure and is never run on MariaDB instead.

`MySQL.update` and the other write calls return as soon as SQLite has the row, together with its outbox entry. Reading MariaDB from outside the server in that same moment can still show the old row. The background copy is the thing that catches MariaDB up, and it survives a crash or a restart.
