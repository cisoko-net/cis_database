<p align="center"><a target="_blank" rel="noopener" href="https://cisoko.net"><img src="docs/img/banner.svg" alt="cis_database: SQLite for FiveM, with a MariaDB replica" width="100%"></a></p>

<p align="center">
<a target="_blank" rel="noopener" href="https://github.com/cisoko-net/cis_database/releases/latest"><img src="docs/img/badge-version.svg" alt="version 1.0.0"></a>
<a target="_blank" rel="noopener" href="https://github.com/cisoko-net/cis_database/blob/main/LICENSE.md"><img src="docs/img/badge-license.svg" alt="license: source-available"></a>
<a target="_blank" rel="noopener" href="https://docs.fivem.net/docs/server-download/"><img src="docs/img/badge-fxserver.svg" alt="FXServer 35245+"></a>
</p>

<p align="center">
<a target="_blank" rel="noopener" href="https://github.com/cisoko-net/cis_database/releases/latest/download/cis_database.zip"><img src="docs/img/button-download.svg" alt="Download"></a>
<a target="_blank" rel="noopener" href="https://cisoko.net/docs/cis-database/"><img src="docs/img/button-docs.svg" alt="Documentation"></a>
<a target="_blank" rel="noopener" href="https://cisoko.net"><img src="docs/img/button-website.svg" alt="Website"></a>
<a target="_blank" rel="noopener" href="https://discord.cisoko.net"><img src="docs/img/button-discord.svg" alt="Discord"></a>
<a target="_blank" rel="noopener" href="https://github.com/cisoko-net/cis_database"><img src="docs/img/button-github.svg" alt="GitHub"></a>
</p>

# cis_database

cis_database replaces oxmysql on your FiveM server. It is free.

- Your resources do not change. They keep calling `oxmysql`, `mysql-async` and `ghmattimysql`.
- Your resources read from SQLite inside FXServer. A read does not wait for MariaDB.
- MariaDB stays your main database. A background worker copies each write to MariaDB.
- To go back, start `oxmysql` again in place of cis_database. MariaDB has your data the whole time.

## Benchmark results

One live qbox server with its full `server.cfg`, run once with oxmysql and once with cis_database. Same machine, same resources, same workload. FXServer 35245, 5 rounds, median, 2026-11-02.

### Faster under load

<p align="center"><img src="docs/img/bench-p99.svg" alt="p99 call latency: oxmysql 23.2, 57.0 and 89.4 ms; cis_database 15.9, 21.2 and 32.3 ms at 64, 128 and 256 players" width="760"></p>

p99 is the slowest 1 % of database calls. When it is high, players feel lag. At 256 players the p99 is **32.3 ms** with cis_database and **89.4 ms** with oxmysql.

### Fewer stutters

<p align="center"><img src="docs/img/bench-stutter.svg" alt="Hitch warnings: oxmysql 14, cis_database 1. Long server frames at 256 players: oxmysql 9, cis_database 0" width="760"></p>

A long frame is a server tick that runs more than 16.7 ms (one 60 FPS frame) over the idle tick. Players feel it as a short freeze.

- At 256 players: **0 long frames** with cis_database, 9 with oxmysql.
- Time past the tick at 256 players: 0.0 ms with cis_database, 855.9 ms with oxmysql.
- Hitch warnings over a full boot: **1** with cis_database (longest 183 ms), 14 with oxmysql (longest 500 ms).

### Less CPU

<p align="center"><img src="docs/img/bench-cpu.svg" alt="CPU for the same workload: FXServer 55.81 s with oxmysql, 47.45 s with cis_database; MariaDB 31.09 s with oxmysql, 13.99 s with cis_database" width="760"></p>

- FXServer: 47.45 s of CPU with cis_database, 55.81 s with oxmysql.
- MariaDB: 13.99 s with cis_database, 31.09 s with oxmysql. Reads do not go to MariaDB.

### More calls, faster reads

<p align="center"><img src="docs/img/bench-speed.svg" alt="Calls per second: oxmysql 1,954, cis_database 2,692. One player read p50: oxmysql 1640.0 µs, cis_database 145.3 µs" width="760"></p>

Calls per second is how many database calls the server finishes in one second. p50 is the typical call: half of the calls were faster.

- **2,692** calls per second with cis_database, 1,954 with oxmysql (32 threads).
- One player read (p50): **145.3 µs** with cis_database, 1640.0 µs with oxmysql. That is about 11 times faster.

All figures come from [bench/results/2026-11-02-8c73b74-frame25/REPORT.md](https://github.com/cisoko-net/cis_database/blob/main/bench/results/2026-11-02-8c73b74-frame25/REPORT.md). Build hashes such as `8c73b74` are labels of pre-release builds of this code, not commits in this public repository. The run measured build `8c73b74` (1.0.0-beta.3). Later changes, listed in [CHANGELOG.md](CHANGELOG.md), include changes to the call path (how `prepare` and `rawExecute` run a list of parameter lists, the statement cache, how MariaDB-routed reads bind values); 1.0.0 itself has not been benchmarked again.

## Where oxmysql is better

cis_database is better on 63 of 82 measured metrics. oxmysql is better on 18, and 1 ties.

| Test | oxmysql | cis_database |
|---|---|---|
| One save from one thread (`save_player`, p50) | 1632.5 µs | 1922.5 µs |
| 5000 updates one after another (a payday loop) | 9603.6 ms | 10646.8 ms |
| Bulk import: 20,000 players and 40,000 vehicles | 6,433 ms | 9,256 ms |
| FXServer memory when idle | 386 MB | 517 MB |
| Server tick when idle | 50.1 ms | 50.2 ms |

<details>
<summary>All 18 metrics where oxmysql is better</summary>

13 latencies of single calls from one thread (`read_vehicles`, `json_hunger` and `save_inventory` mean, p50 and p99, `count_police` p99, `save_player` p50, `send_message` mean and p50), the 5000-update payday loop, the bulk import, the idle server tick, FXServer memory at idle and MariaDB memory after the workloads. The tie is long frames in the join storm.

</details>

Why:

- cis_database waits for the disk on every write. A save is safe before your resource continues.
- cis_database spreads a long burst of writes over many server ticks, so no tick runs long.
- The SQLite copy lives inside FXServer. That uses about 130 MB more memory when idle. At peak, FXServer uses less: 552 MB with cis_database, 605 MB with oxmysql.
- At start, cis_database copies the tables from MariaDB. After that, it copies a table again only when MariaDB changed it. Start the server before players join.

## Is it for you?

| Your server | Good fit? |
|---|---|
| Uses oxmysql, `mysql-async` or `ghmattimysql` | Yes, no edits to your resources |
| Has lag or hitches when many players are online | Yes, this is the main gain |
| Imports big data files often | Maybe. Bulk import is slower |
| Has very little free RAM | Maybe. Idle memory is about 130 MB higher |
| Needs `MySQL.startTransaction` | Not yet. Use `MySQL.transaction` |

## Install

> **Warning:** back up your MariaDB database before the first start. You can then go back to it if something goes wrong.

1. Stop `oxmysql` and remove its `ensure` line. If its folder is inside a category that `server.cfg` starts as a whole, such as `ensure [standalone]`, also move the folder out of that category, for example to `resources/[disabled]`, which no `ensure` line names. Without the move, the category line still starts oxmysql.
2. [Download `cis_database.zip`](https://github.com/cisoko-net/cis_database/releases/latest/download/cis_database.zip) from the latest release and put the `cis_database` folder in `resources`. The folder must be named `cis_database`. GitHub's "Source code" downloads unpack as `cis_database-1.0.0`: rename that folder to `cis_database`. A clone also holds the tests and benchmarks, which a server never runs.
3. Set the connection string in `server.cfg`:

   ```
   set mysql_connection_string "mysql://cis:password@127.0.0.1:3306/yourdb?charset=utf8mb4"
   ```

   `cis` is a MariaDB user of its own with rights on that database only; see [docs/SECURITY-NOTES.md](docs/SECURITY-NOTES.md).

4. Start cis_database before every resource that uses SQL. Put this line where `ensure oxmysql` was:

   ```
   ensure cis_database
   ```

   Some recipes have no `ensure oxmysql` line. The QBCore recipe starts oxmysql through `ensure [standalone]`, after `ensure qb-core`. There, put `ensure cis_database` above the framework's first line (`ensure qb-core`).

5. Type `cis_database_doctor` in the server console. Each line shows `OK`, `WARN` or `FAIL`, and the fix.

cis_database adds two small tables of its own to your MariaDB database, `__cis_replica_state` and `__cis_id_reserve`. Of your own tables it changes only the `AUTO_INCREMENT` counter ([docs/INSTALL.md](docs/INSTALL.md#what-it-adds-to-mariadb)).

Requirements, TLS for a remote MariaDB, and how to go back to oxmysql: [docs/INSTALL.md](docs/INSTALL.md).

## More details

<details>
<summary><b>Is my data safe?</b></summary>

- A write is on disk before your resource gets the answer. cis_database syncs the SQLite log first. MariaDB gives the same promise with `innodb_flush_log_at_trx_commit=1`.
- MariaDB can be offline. Then the writes wait in an outbox in the same file. A crash or a MariaDB outage loses nothing. The writes go to MariaDB when it answers again.
- cis_database limits its own work per server frame. A burst of queries is spread over frames.

</details>

<details>
<summary><b>Does it work with my resources? (tested on 154 resources)</b></summary>

We took 154 public resources at fixed versions: frameworks, inventories, phones, garages, housing and banking. We ran each of their SQL statements twice: once through cis_database, and once on MariaDB 10.11 through mysql2 with the oxmysql options.

- 2965 of 3016 statements (98.31 %) gave the same answer.
- 141 of the 154 resources matched on every statement.
- Most of the other 51 are `NOW()` values one or two seconds apart. Some are writes with test values that MariaDB strict mode refuses.

Each type of difference is in [docs/KNOWN-GAPS.md](docs/KNOWN-GAPS.md). Run the test yourself: `node tests/corpus/match.js`.

</details>

<details>
<summary><b>Known gaps</b></summary>

- `MySQL.startTransaction` returns `false`. Use `MySQL.transaction` with a list of queries.
- SQLite keeps `DECIMAL` as a 64-bit float. Values up to 15 significant digits come back exact. With MariaDB set, MariaDB answers math on a `DECIMAL`.
- An edit made in MariaDB while the server runs (a web panel, HeidiSQL) reaches the game at the next scan, at most about 10 s later. Edits made while the server is stopped are always read at the next start.
- One `INSERT` with thousands of rows is never split. It can still cause one long frame. Send it as several statements.

Full list: [docs/KNOWN-GAPS.md](docs/KNOWN-GAPS.md).

</details>

## Compatibility

| Item | Status |
|---|---|
| FXServer | Build 35245 or newer. Node 22 is part of that build. OneSync is not necessary. |
| oxmysql API | Drop-in, except `startTransaction`, which returns `false` ([docs/KNOWN-GAPS.md](docs/KNOWN-GAPS.md)). `@oxmysql/lib/MySQL.lua`, `exports.oxmysql`, `mysql-async` and `ghmattimysql` calls work. |
| Frameworks | The SQL of es_extended, qbx_core, ox_inventory and ND_Core is checked against MariaDB answers recorded in the test (`tests/repro/dialect_market.js`). |
| Live test | qbox server with its whole `server.cfg` ([benchmark report](https://github.com/cisoko-net/cis_database/blob/main/bench/results/2026-11-02-8c73b74-frame25/REPORT.md)). |
| Database | MariaDB or MySQL. cis_database can also run with no MariaDB. |

> **Warning:** never start cis_database together with a real `oxmysql`. Both resources provide the name `oxmysql`.

The resource also ships an optional admin dashboard (`ui_page`, `client/dashboard.lua` and `web/dist`, about 310 KB with its fonts) that every player downloads. Only an admin who has the ACE `cis_database.dashboard` can open it with `/cis_db`. Grant it in `server.cfg`:

```cfg
add_ace group.admin cis_database.dashboard allow
```

A player without the ACE who types `/cis_db` gets the chat line `no permission: needs ace cis_database.dashboard` (also printed in F8).

Your own resources can call `exports.cis_database` directly. The API is in [API.md](API.md).

## Configuration

The default settings are correct for most servers. The only setting you must give is `mysql_connection_string`.

Every `config.json` key and convar is in [docs/CONFIG.md](docs/CONFIG.md).

## Documentation

| Topic | Page |
|---|---|
| Overview | [cisoko.net/docs/cis-database](https://cisoko.net/docs/cis-database/) |
| Install | [cisoko.net/docs/cis-database/install](https://cisoko.net/docs/cis-database/install/) |
| Configuration | [cisoko.net/docs/cis-database/configuration](https://cisoko.net/docs/cis-database/configuration/) |
| Exports | [cisoko.net/docs/cis-database/exports](https://cisoko.net/docs/cis-database/exports/) |
| MariaDB replica | [cisoko.net/docs/cis-database/mariadb-replica](https://cisoko.net/docs/cis-database/mariadb-replica/) |
| Move from oxmysql | [cisoko.net/docs/cis-database/migrate-from-oxmysql](https://cisoko.net/docs/cis-database/migrate-from-oxmysql/) |
| Common errors | [cisoko.net/docs/cis-database/common-errors](https://cisoko.net/docs/cis-database/common-errors/) |
| Benchmark | [cisoko.net/docs/cis-database/benchmark](https://cisoko.net/docs/cis-database/benchmark/) |

In this repository:

- [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md): durable writes, the outbox, the boot copy, and which reads MariaDB answers.
- [docs/SQL-DIALECT.md](docs/SQL-DIALECT.md): the MySQL to SQLite translation and the statement corpus test.
- [docs/KNOWN-GAPS.md](docs/KNOWN-GAPS.md): where cis_database still answers differently from MariaDB.
- [docs/SECURITY-NOTES.md](docs/SECURITY-NOTES.md): a MariaDB user of its own, `cache/`, and the dashboard.
- [bench/README.md](https://github.com/cisoko-net/cis_database/blob/main/bench/README.md): how to run the benchmark yourself.

## FAQ

<details>
<summary><b>Is MariaDB still my main database?</b></summary>

Yes. MariaDB keeps every write it accepts, and every start copies from it. To go back to oxmysql, start it again in place of cis_database ([docs/INSTALL.md](docs/INSTALL.md#going-back-to-oxmysql)).

</details>

<details>
<summary><b>What happens to a write if the server crashes?</b></summary>

cis_database answers a write after it is on disk. Writes that MariaDB has not received stay in an outbox and go to MariaDB after the next start. A write MariaDB refuses (strict mode, a foreign key, a duplicate key) is counted on the dashboard and logged, and is gone after the next start, which copies that table again from MariaDB. See [docs/KNOWN-GAPS.md](docs/KNOWN-GAPS.md).

</details>

<details>
<summary><b>Why does the manifest show version 2.14.3?</b></summary>

Some resources need oxmysql 2.7.3 or newer. The product version is `1.0.0`.

</details>

## Support and licence

- Help: [Discord](https://discord.cisoko.net).
- Bugs and pull requests: [CONTRIBUTING.md](CONTRIBUTING.md).
- Security problems: [SECURITY.md](SECURITY.md).
- Licence: Cisoko Platform Source-Available License 1.0, in [LICENSE.md](LICENSE.md).
- More FiveM resources by Cisoko: [cisoko.net](https://cisoko.net).

The API is the one that [oxmysql](https://github.com/overextended/oxmysql) by Overextended (LGPL-3.0) defined. cis_database implements it from oxmysql's documentation and from observed behaviour; where exact parity needed it, oxmysql's published source was read to learn what a call returns. No oxmysql code is copied into cis_database. The consumer include, `lib/MySQL.lua`, was written from that documentation by someone who had not read oxmysql's own include.

Author: Cisoko. Source: https://github.com/cisoko-net/cis_database.
