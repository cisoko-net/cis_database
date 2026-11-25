# cis_bench

A benchmark that compares database drivers on a real FXServer, with the
server's own resources running, the way players would load it. The same
Lua resource (`cis_bench/server.lua`) runs against oxmysql and against
cis_database; between passes only the `@<driver>/lib/MySQL.lua` include and
the `ensure` line change.

## What it runs

Each boot seeds 20,000 players and 40,000 vehicles (plus bank and phone
history), warms up, measures 10 s of idle server ticks, then:

| Workload | What it stands for |
|---|---|
| Single call, 12 statements | One script awaiting one query at a time: player load by id and by license, vehicle list, phone messages, JSON field, `IN (?)` list, count, top-10, player save, inventory save, message insert, bank transfer transaction. |
| Live server, 64 / 128 / 256 players | One thread per player, 60 calls each from an 80/20 read/write mix with random think time, all at once. |
| Join storm | 128 players connect in the same second; each join runs the seven calls a framework does for a new player. |
| Save storm | 256 players saved at once (the txAdmin restart warning, a periodic save-all). |
| Payday | One script paying 5,000 players in a loop of awaits. |
| Saturation | 32 threads calling back to back for 10 s. |

For every workload it records per-call latency (mean, p50, p95, p99, max),
calls per second where it applies, and the server frames during it: a long
frame is one more than 16.7 ms past this boot's idle tick. The run script also
records FXServer and MariaDB CPU time for the measured part.

Writes are deterministic (a thread only sets rows it owns, shared rows only
take increments), so every driver and every round must end with the same
data. The resource prints checksums of the final tables, the run script reads
the same checksums from MariaDB with the `mysql` client, and the report checks
that they all agree. For cis_database the MariaDB check runs after its outbox
has drained, so it proves the copy is complete and identical.

## Running it

Prerequisites, on a Linux box you can stop for an hour or so (the bench takes
the server's game port, stops every other txAdmin server on the box and
restarts the server several times):

- An FXServer build (35245 or newer) set up as a txAdmin server under systemd,
  or any FXServer you can start with a `run.sh` (`BENCH_RUN`, below).
- MariaDB with a database the server already uses, and the `mysql` client.
  By default the script connects as root over the local socket; use
  `BENCH_DBENV` for another user.
- An oxmysql release (the comparison driver) in the server's `resources/`,
  or a folder you point `BENCH_OXMYSQL` at.
- cis_database installed in the server's `resources/` and `ensure ox_lib` in
  its `server.cfg` (the bench inserts the driver before that line).
- python3, `curl`, `systemctl`/`journalctl` (unless you use `BENCH_RUN`), and
  a checkout of this repository, run as root.

Install cis_database without `cache/`, or with that server's own `cache/`. A `cache/` copied from an earlier install on the same MariaDB is
older than MariaDB: builds with the fix for that case (after 2c51f67) find it
at boot and copy every table again from MariaDB, which adds a full copy to the
first boot; older builds, including 2c51f67 measured in `results/`, count the
new writes as already copied and the copy check fails. For those, delete the
epoch first
(`sqlite3 cache/durable.sqlite "DELETE FROM __cis_meta WHERE k = 'epoch'"`).

```
sudo BENCH_DATA=/path/to/server-data BENCH_SERVER=myserver BENCH_DB=mydatabase bash bench/run_bench.sh 5
```

`BENCH_DATA` is the server-data folder, the one that holds `server.cfg` and
`resources/` (required; the script stops with an error without it).
`BENCH_SERVER` names the server (default `server`): it gives the default
systemd unit, `txadmin@<BENCH_SERVER>`, and the default MariaDB database
name. Set `BENCH_UNIT` if your unit is called something else and `BENCH_DB`
if your database is not named like the server. FXServer runs as the owner of
`BENCH_DATA` unless you set `BENCH_USER`. Set `BENCH_FXROOT` to the folder
with FXServer's `BUILD` file if you want the build number in the run's
`env.txt`.

Five rounds, each one oxmysql boot and one cis_database boot, alternating
which goes first. The console is read from journald. Before the first boot the script checks that
nobody is connected to the running server, stops it, copies `server.cfg`, and
moves the server's own oxmysql out of its `[ox]` category (linked back in as
`resources/oxmysql`, so only the `ensure` line decides which driver starts).
At the end `server.cfg` and oxmysql go back where they were and the server
that was running before starts again. Results land in
`$BENCH_DIR/bench_<date>/` (`BENCH_DIR` defaults to `$HOME/bench`; `BENCH_OUT` sets the folder itself): one JSON file per boot, the console log of each
boot, `REPORT.md` with medians and ranges, and `summary.json`. The
results folder also holds a copy of `server.cfg` with its secrets, so it is
root-only; publish only `REPORT.md` and `summary.json`.

The `BENCH_*` variables listed at the top of `bench/server.sh` also select an
FXServer started from `run.sh` without txAdmin (`BENCH_RUN`) or a MariaDB
user other than root (`BENCH_DBENV`, a file with `DB_USER` and `DB_PASSWORD`). The ones at the top of `bench/run_bench.sh` change the
run itself: `BENCH_FRAME_MS=20` benches cis_database at another frame budget
(written to `server.cfg` as `cis_database_frame_ms` for its passes only), and
`BENCH_FIRST_ROUND=5` with `BENCH_OUT` set to an earlier run's folder finishes
a run that stopped after round 4.

Published runs, with the method, the hardware and every round, are in
[results/README.md](results/README.md).

## Comparing cis_database builds

`run_gens.sh` runs any number of cis_database trees, and oxmysql if named,
one per boot, the order rotating every round:

```
bash bench/run_gens.sh -r 1 g4=$HOME/bench/pkg_a/cis_database g5=$HOME/bench/pkg_b/cis_database oxmysql
```

Every pass is a clean boot: FXServer stopped, the page cache dropped, and a
cis_database tree copied fresh with no `cache/`, so SQLite hydrates every
table from MariaDB and every build starts from the same data. A cache is only
removed after `sqlite3` and MariaDB's `__cis_replica_state` show every
outbox row in it was applied; otherwise the run stops and leaves it alone. At
the end the installed build is put back with a fresh cache, `server.cfg` is
restored, and the server that was running before starts again. `GENS.md` has one column per build;
for cis_database the log also has the engine's own counters per phase
(`engine ...` lines: slice, wake, checkpoint), and every long frame is
printed with the bench resource's Lua heap before and after it, so a Lua GC
cycle in the bench shows as a large drop.

## Reading the numbers

oxmysql confirms a write once MariaDB has committed it. cis_database, by
default (`cis_database_ack power`), confirms once an fdatasync of its SQLite
WAL covers the write, so a confirmed write survives a power cut, and copies
it to MariaDB right after; the report shows how long that copy took to finish
after the last workload. `env.txt` records the ack mode of each run. With
`cis_database_ack process` it confirms at commit (safe across a crash of the
server process only), which is what builds up to 2c51f67, the ones in
`results/`, did.
