# cis_database configuration

This page lists every setting cis_database reads: the keys in `config.json`, the server convars, and the permission for the in-game dashboard. The defaults are good for most servers. If you change nothing but `mysql_connection_string`, you have a working setup.

## How settings are read

Order of precedence, highest first:

1. A convar in `server.cfg` (for example `set cis_database_flush_ms "100"`).
2. The active profile's block in `config.json`.
3. The top-level block in `config.json`.
4. The built-in default.

Settings are read once when the resource starts. Restart `cis_database` after a change. Do it with the server quiet, because scripts that use the database wait while it starts.

A convar that is empty or missing counts as unset. For most numeric settings, `0` or a value that is not a number falls back to the default. The exceptions are noted in the tables.

If `config.json` is missing or is not valid JSON, the file is ignored and every default applies. Check the console for `config profile=...` on start to see what was loaded.

## The storage profile model

A profile is a named bundle of storage and copy settings. `config.json` ships with two: `durable` and `performance`.

`activeProfile` names the one in use. The convar `cis_database_profile` overrides it. If the name matches nothing under `profiles`, the `durable` block is used.

A profile can hold three blocks:

- `sqlite`: SQLite tuning for that profile only.
- `replication`: overrides for the top-level `replication` block.
- `changeDataCapture`: overrides for the top-level `changeDataCapture` block.

The merge works key by key. The top-level block is the base, and every key the profile sets replaces the same key. Keys the profile leaves out keep the top-level value. In the shipped file, `durable` sets no `replication` or `changeDataCapture`, so it uses the top-level blocks as they are. `performance` sets all of its own keys, so its values win.

The `sqlite` block is not shared: only the active profile's `sqlite` block is read.

Separately, the profile name decides the storage mode. A name of `performance` (also `off` or `shm`) selects the in-memory mode. Any other name selects the durable file mode. The convar `cis_database_mode` can set the storage mode on its own, without changing which `sqlite` block is read. Most people should leave it alone and use `cis_database_profile`.

### durable (default)

SQLite lives in a file at `cache/durable.sqlite`, in WAL mode. A write is answered to the calling script only after the WAL has been flushed to disk. A server crash or a power cut does not lose a write that was answered. Writes are copied to MariaDB in the background. The unsent ones are kept in an outbox inside the same SQLite file, so they survive a restart.

Use this unless you have a reason not to.

### performance

Read this part before you turn it on.

In this mode the database is held in memory, not in a durable file. `journal_mode` is `OFF` and `synchronous` is `0`. There is no journal and no flush, so nothing protects the data from a crash.

- If the server process, the machine or the power goes down, everything held only in memory is lost. That includes writes that had not yet been copied to MariaDB, and the outbox that lists them. A short window of the newest writes is gone for good.
- If a file is in use and the process dies in the middle of a write, that file can be left damaged.
- MariaDB is the recovery source. On the next start, with `mysql_connection_string` set, the resource creates an empty in-memory database and copies every table from MariaDB. Your data comes back as MariaDB last had it. Anything MariaDB had not received yet is not recovered.
- Without `mysql_connection_string`, `performance` mode has no recovery source. Do not run it that way for a live server.
- Startup is slower, because the whole database is copied from MariaDB each time.
- Memory use grows with your database. Plan for the full size of your data in RAM.
- `performance` mode in `config.json` also copies to MariaDB faster (smaller wait, bigger batches), which narrows the window of loss but does not remove it.

Choose `performance` only for a test server, a throwaway copy, or a setup where MariaDB is on reliable storage and losing a few seconds of writes on a crash is acceptable. For a live roleplay server, stay on `durable`.

In `performance` mode, the `sqlite.journal_mode` and `sqlite.synchronous` values in the file are not used: the resource always applies `OFF` and `0`. The `wal_autocheckpoint` key is not used either. In `durable` mode, `locking_mode` is not used.

## config.json

### Top level

| Key | Default | Type / range | What it does |
|---|---|---|---|
| `debug` | `false` | boolean | Prints extra lines tagged `[cis_database:debug]` to the console. Turn it on while you chase a problem and off again after. The convar `cis_database_debug` overrides it (`1` on, any other value off). |
| `frameBudgetMs` | `25` | number, `0` to `200` | How much of one server tick, in milliseconds, cis_database may use. When the budget is spent, the remaining queries wait for the next tick. This keeps a burst of queries from causing a hitch warning. `0` turns the limit off. Values above `200` are cut to `200`. A tick is about 50 ms, so `25` leaves half of it for everything else. Raise it on a lean server with fast hardware if you want more throughput. Lower it if you see hitch warnings. Trade-off: a lower value means smoother ticks but slower bursts. Convar: `cis_database_frame_ms`. |
| `sliceMs` | `4` | number, `0.5` to `50` | Not in the shipped file, but read if you add it. The longest stretch of work cis_database does without giving the server a turn. Past this, the rest of the work waits. Smaller values are gentler on the tick and add a little latency to big batches. Convar: `cis_database_slice_ms`. |
| `activeProfile` | `"durable"` | `"durable"` or `"performance"` | Which profile to use. See "The storage profile model". Convar: `cis_database_profile`. |

### `logging`

| Key | Default | Type / range | What it does |
|---|---|---|---|
| `logging.prefix` | `"[cis_database]"` | string | Text printed at the start of each log line. Change it only if you filter your console by prefix. |
| `logging.logSqlErrors` | `true` | boolean | Prints a line when MariaDB refuses a copied write, with the statement. Repeats of the same error are held back for 10 seconds. Set it to `false` to silence these lines. You then lose the first clue to a schema mismatch, so leave it on. Only an exact `false` turns it off. |
| `logging.slowQueryThresholdMs` | `100` | whole number of milliseconds, above `0` | A query that takes at least this long is listed under "slow queries" in the dashboard. It does not print to the console. A value of `0` or a non-number gives `100`. Lower it to see more queries in the list. |

### `replication`

This is the background copy of your writes to MariaDB. It only runs when `mysql_connection_string` is set.

| Key | Default (`performance`) | Type / range | What it does |
|---|---|---|---|
| `replication.flushIntervalMs` | `50` (`20`) | whole number, ms | How often the resource checks for writes waiting to be sent. Lower means MariaDB trails SQLite by less, at the cost of more small round trips. Convar: `cis_database_flush_ms`. |
| `replication.batchSize` | `64` (`128`) | whole number | How many queued writes go to MariaDB in one batch. When this many are waiting, the copy starts at once without waiting for the timer. A batch also stops at about 1 MB of SQL. Raise it for heavy write loads. Convar: `cis_database_batch`. |
| `replication.maxQueueEntries` | `4096` (`8192`) | whole number | Accepted and shown in the dashboard as the queue maximum. It does not cap the queue: waiting writes are kept in the SQLite outbox with no size limit beyond disk space. Changing it has no effect on behaviour. Convar: `cis_database_queue_max`. |
| `replication.poolConnections` | `4` (`8`) | whole number | Size of the MariaDB connection pool. Reads that SQLite cannot answer fall back to it. Copying writes uses one extra dedicated connection. Raise it only if MariaDB is the bottleneck for fallback reads. Each connection counts against MariaDB's `max_connections`. Convar: `cis_database_pool`. |

### `changeDataCapture` (CDC)

CDC watches MariaDB for changes made by someone else (a web panel, a script, a manual edit) and copies those tables into SQLite. Without it, SQLite would never see edits made straight in MariaDB. It runs on a timer and never on the query path. It needs `mysql_connection_string`.

A table this server just wrote to is skipped for a short time, so your own write is not copied back over itself. A table that still has writes waiting in the outbox is also skipped.

| Key | Default | Type / range | What it does |
|---|---|---|---|
| `changeDataCapture.enabled` | `true` | boolean | Turns CDC on or off. Turn it off if nothing else ever writes to the MariaDB database. Only an exact `false` turns it off. Convar: `cis_database_cdc` (`0` off, anything else on). |
| `changeDataCapture.pollIntervalMs` | `1000` | whole number, ms, `50` or more | How often MariaDB is checked for outside edits. A value below `50` becomes `1000`. Lower finds edits sooner and costs more queries against MariaDB. Convar: `cis_cdc_interval`, or `cis_database_cdc_ms` if the first is not set. |
| `changeDataCapture.dirtyTtlMs` | `2000` (`1000` in `performance`) | whole number, ms | How long a table you just wrote stays skipped by CDC. Raise it if your own writes seem to get overwritten by an old copy from MariaDB. Lower it if outside edits to busy tables take too long to show up. Convar: `cis_database_dirty_ttl_ms`. |
| `changeDataCapture.forceMs` | `10000` | whole number, ms, `0` off | A normal scan waits for a moment with no query and no open transaction, so on a busy server it may never run. Every this many ms a scan runs anyway; it waits only for an open transaction or a WAL step. A table the game writes during that scan's copy is left for the next one. Convar: `cis_database_cdc_force_ms`. |

The resource also keeps MariaDB's `AUTO_INCREMENT` counter for each copied table far above the highest id in SQLite. A row inserted straight into MariaDB then gets an id the game will never hand out, so the game's next insert into that table cannot clash with it. The raise is an `ALTER TABLE ... AUTO_INCREMENT`, and each one is recorded in the MariaDB table `__cis_id_reserve`. The database user needs the `ALTER` privilege; without it the console warns once and the reserve stays off. The gap is checked every `cis_database_id_reserve_ms` (default `5000`, `0` off) and is `cis_database_id_gap` ids wide (default `1000000`, at least `64`, smaller for column types that would overflow). If a copy is ever refused as a duplicate key, the console prints a warning and the dashboard shows the count.

### `profiles.<name>.sqlite`

These tune SQLite itself. Defaults below are for `durable`, with the `performance` value where it differs.

| Key | Default | Type / range | What it does |
|---|---|---|---|
| `journal_mode` | `"WAL"` (`"OFF"`) | SQLite journal mode | Used in `durable` only. `WAL` is what makes crash-safe writes and fast reads possible. Do not change it. In `performance` the value is ignored and `OFF` is applied. |
| `synchronous` | `"NORMAL"` (`"0"`) | SQLite setting | Used in `durable` only. The resource does its own WAL flush before it answers a write, so `NORMAL` is correct here. In `performance` the value is ignored and `0` is applied. |
| `wal_autocheckpoint` | `0` | whole number of pages | Used in `durable` only. `0` turns SQLite's own automatic checkpoint off, because cis_database runs its own, about every 256 writes, off the server thread. Leave it at `0`. |
| `locking_mode` | not set (`"EXCLUSIVE"`) | `NORMAL` or `EXCLUSIVE` | Used in `performance` only. `EXCLUSIVE` keeps the database locked to this one process. |
| `cache_size_kb` | `1048576` | KiB | SQLite's page cache size, in KiB. The default is 1 GiB. It is only used as needed, not reserved. Lower it on a small VPS. A value of `0` or one that is not a number gives the default. |
| `mmap_size_bytes` | `1073741824` (`2147483648`) | bytes | How much of the database file SQLite may map into memory. Faster reads for large files. It is address space, not memory taken up front. Lower it if your host limits virtual memory. |
| `busy_timeout_ms` | `5000` | ms | How long SQLite waits if the file is briefly locked before it reports an error. The default is fine. |
| `max_wal_bytes` | `104857600` (`0`) | bytes | Used in `durable`. The size at which the WAL file is trimmed back after a checkpoint. At boot the WAL is also filled with zeros up to a size not larger than this, so later writes do not have to grow the file. The convar `cis_database_wal_max_bytes` overrides it. `0` or less means 100 MiB. |

## Convars

Set these in `server.cfg` with `set`. Never use `setr` for `mysql_connection_string`: `setr` copies the value to every connected player, and the string holds your database password. Use `set` for all cis_database convars. Nothing here needs `setr`.

### Connection

| Convar | Default | What it does |
|---|---|---|
| `mysql_connection_string` | empty | Where your MariaDB or MySQL server is. When it is empty, or has no database name, the MariaDB copy is switched off. SQLite alone then holds the data, and the console prints `replica disabled`. The string is read when the resource starts. See the formats below. |

`mysql_connection_string` takes two forms.

URI form:

```
set mysql_connection_string "mysql://user:password@127.0.0.1:3306/yourdb?charset=utf8mb4"
```

- The scheme can be `mysql://` or `mysql2://`.
- The user and password are split at the first `:`. They are URL-decoded, so write special characters as `%40` for `@`, `%3A` for `:`, `%2F` for `/`. A plain `@` or `/` inside the password also works, because the last `@` before the `?` ends the user part.
- The port is optional and defaults to `3306`. The user defaults to `root` and the password to empty.
- After `?` you may add `user=`, `password=` (or `uid=`, `pwd=`, `username=`) and `database=`. A database in the path wins over one in the query.
- Other query options, like `charset=utf8mb4`, are accepted but ignored. The connection always uses `utf8mb4`.

Semicolon form:

```
set mysql_connection_string "server=127.0.0.1;port=3306;database=yourdb;user=cis;password=secret"
```

- Keys are not case sensitive. The host can be `server`, `host` or `data source`. The user can be `user`, `uid`, `user id` or `username`. The password can be `password` or `pwd`. The database can be `database` or `initial catalog`.
- Missing parts take the same defaults as above: host `127.0.0.1`, port `3306`, user `root`.

In both forms, `localhost` and `::1` are rewritten to `127.0.0.1`. Any other host name is used as written.

The oxmysql convars `mysql_debug`, `mysql_slow_query_warning`, `mysql_ui`, `mysql_transaction_isolation_level` and `mysql_log_size` are not read. Setting them does nothing. Use `cis_database_debug` and `logging.slowQueryThresholdMs` instead.

### Profile and storage

| Convar | Default | What it does |
|---|---|---|
| `cis_database_profile` | empty (uses `activeProfile`) | Picks the profile, same as `activeProfile`. |
| `cis_database_mode` | empty (follows the profile name) | `performance`, `off` or `shm` selects the in-memory mode. Anything else selects `durable`. This does not change which `sqlite` block is read. Prefer `cis_database_profile`. |
| `cis_database_ack` | `power` | `power`: a write is answered after the WAL is flushed to disk, so it survives a power cut. `process`: a write is answered as soon as it commits, which survives a server crash but not a power cut. `process` is a little faster. Any other value counts as `power`. Only matters in `durable`. |
| `cis_database_wal_prealloc` | `1` | `1` fills the WAL file with zeros at boot so commits only overwrite existing space. `0` turns it off. It costs a short delay at boot and some disk space, up to `max_wal_bytes`. |
| `cis_database_wal_max_bytes` | the profile's `max_wal_bytes` | Bytes. See `max_wal_bytes` above. |

### Statements

| Convar | Default | What it does |
|---|---|---|
| `cis_database_multi_statements` | `false` | `false`: one call runs one statement, as in oxmysql, whose `multipleStatements` is off by default. A text with a second statement after a `;` is refused with `ER_PARSE_ERROR`, as MariaDB refuses it, and nothing of it runs. This stops a value concatenated into the SQL from adding its own statement. A `;` inside a string, a `` `name` `` or a comment, and a trailing `;`, do not count. `true` runs every statement of the text in order, the same opt-in as oxmysql's `multipleStatements=true`. Read at start. |

### Copy to MariaDB and CDC

Each overrides the matching `config.json` key.

| Convar | Default | Matching key |
|---|---|---|
| `cis_database_flush_ms` | `50` | `replication.flushIntervalMs` |
| `cis_database_batch` | `64` | `replication.batchSize` |
| `cis_database_queue_max` | `4096` | `replication.maxQueueEntries` (no effect on behaviour) |
| `cis_database_pool` | `4` | `replication.poolConnections` |
| `cis_database_cdc` | `1` | `changeDataCapture.enabled`. `0` turns CDC off. |
| `cis_cdc_interval` | `1000` | `changeDataCapture.pollIntervalMs`. Wins over `cis_database_cdc_ms`. |
| `cis_database_cdc_ms` | `1000` | `changeDataCapture.pollIntervalMs` |
| `cis_database_dirty_ttl_ms` | `2000` | `changeDataCapture.dirtyTtlMs` |
| `cis_database_cdc_force_ms` | `10000` | `changeDataCapture.forceMs`. `0` turns forced scans off. |
| `cis_database_id_reserve_ms` | `5000` | none. How often the `AUTO_INCREMENT` reserve is checked. `0` turns it off. |
| `cis_database_id_gap` | `1000000` | none. How far above SQLite's highest id MariaDB's counter is kept. At least `64`. |
| `cis_database_maria_reads` | `1` | none. `0` answers every read SQLite can run on SQLite, even where MariaDB would answer otherwise ([HOW-IT-WORKS.md](HOW-IT-WORKS.md#reads-mariadb-answers)). Only for tests. |
| `cis_database_maria_read_ms` | `30000` | none. How long a read MariaDB answers may take, from asking for a connection to the last row, before it fails with the reason. |

### Tick budget and behaviour

| Convar | Default | What it does |
|---|---|---|
| `cis_database_frame_ms` | `25` | Same as `frameBudgetMs`. `0` turns the per-tick limit off. |
| `cis_database_slice_ms` | `4` | Same as `sliceMs`. Range `0.5` to `50`. |
| `cis_database_wake` | `udp` | How cis_database hands control back to the server between slices. `udp` uses a message sent to itself on `127.0.0.1` and is the fastest. `timer` and `io` are slower and exist for comparison. Leave it on `udp`. If it cannot open the sockets, it falls back by itself. |
| `cis_database_auto_index` | `1` | `1` lets cis_database add a speed-up index in SQLite for a query that keeps scanning a whole table. These indexes exist in SQLite only and are never sent to MariaDB. At most 4 per table and 32 in all, and none on tables over 100000 rows. `0` turns this off. |
| `cis_database_auto_index_ms` | `3` | A read must take at least this many milliseconds, three times, before an index is tried. Above `0`. |
| `cis_database_debug` | `0` | `1` turns on debug lines. |
| `cis_database_frame_trace` | `0` | `1` logs where each tick's time went, every 2 seconds, and writes `cache/frame_trace-*.json`. Use it to find hitches, then turn it off. It adds overhead. |

## Dashboard permission

The in-game dashboard opens with the command `/cis_db`. The server checks the ACE `cis_database.dashboard` for the player. Without it, the player is refused and the panel does not open. The console (source 0) cannot open it.

Grant it to a group or one player in `server.cfg`:

```
# everyone in the admin group
add_ace group.admin cis_database.dashboard allow

# or one player, by identifier
add_principal identifier.license:YOUR_LICENSE_HERE group.admin
```

If your admins are not already in `group.admin`, add them with `add_principal` as shown. Use a license identifier you trust, not a name.

## Recommended server.cfg

```
# Database. Use set, never setr: setr sends the value to every player.
set mysql_connection_string "mysql://user:password@127.0.0.1:3306/yourdb?charset=utf8mb4"

# Start cis_database before anything that uses the database.
# It provides oxmysql, so do not also start oxmysql.
ensure cis_database

# Dashboard access (/cis_db in game)
add_ace group.admin cis_database.dashboard allow
add_principal identifier.license:YOUR_LICENSE_HERE group.admin

# Optional. The defaults are fine for most servers.
# set cis_database_profile "durable"
# set cis_database_frame_ms "25"
```

Do not run `cis_database` next to a real `oxmysql`. Both answer to the same name.
