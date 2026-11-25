# Benchmark results: cis_database vs oxmysql

The build hashes in this file (`8c73b74`, `ae3a7a5`, `9e226f1`, `5f34b49`, `2c51f67` and the fix commits named below) are labels of pre-release builds of this code. They are not commits in this public repository. The 2026-11-02 run measured the release candidate; its only later changes are documented in [CHANGELOG.md](../../CHANGELOG.md).

## 2026-11-02, build `8c73b74` (1.0.0-beta.3)

The run the README figures come from. Five rounds, driver order alternating
each round, the default `cis_database_ack power` and a 25 ms frame budget, on
the same kind of host as the earlier runs: AMD EPYC 7302, 6 cores, 16 GiB,
Ubuntu 24.04.5, FXServer build 35245, txAdmin 8.1.1, MariaDB 10.11.14, oxmysql
2.14.3, a qbox server with its whole `server.cfg` (165 resources on disk).
Started 2026-11-02 02:38 (UTC+3). Folder:
[2026-11-02-8c73b74-frame25](2026-11-02-8c73b74-frame25/REPORT.md). Better on
63 of 82 metrics; oxmysql is better on 18 and one ties (long frames in the
join storm).

Medians over the five rounds:

| Metric | ox | cis `8c73b74` |
|---|---:|---:|
| read_player p50, �s | 1640 | 145 |
| save_player p50, �s | 1632 | 1922 |
| bank_transfer p50, �s | 6922 | 2126 |
| 256 players p99, �s | 89384 | 32255 |
| 256 players long frames | 9 | 0 |
| Join storm, ms | 506 | 341 |
| Save storm, ms | 615 | 504 |
| Payday, ms | 9604 | 10647 |
| Saturation, calls/s | 1954 | 2692 |
| Bulk import, ms | 6433 | 9256 |
| Idle tick, ms | 50.1 | 50.2 |
| Hitch warnings (whole boot) | 14 | 1 |
| Longest hitch warning, ms | 500 | 183 |
| FXServer CPU, s | 55.81 | 47.45 |
| MariaDB CPU, s | 31.09 | 13.99 |
| FXServer memory at idle, MB | 386 | 517 |
| FXServer memory, peak, MB | 605 | 552 |

Where oxmysql leads: 13 single-call latencies from one thread (`read_vehicles`,
`json_hunger` and `save_inventory` mean, p50 and p99, `count_police` p99,
`save_player` p50, `send_message` mean and p50), the payday loop, the bulk
import, the idle tick (50.1 against 50.2 ms), FXServer memory at idle and
MariaDB memory after the workloads (1010 MB for both, 998 to 1010 against
1005 to 1016).

Data check: one final checksum across all 10 runs; cis_database's MariaDB copy
matched what it served in 5 of 5 runs, oxmysql's MariaDB matched in 5 of 5;
no errors. The copy to MariaDB was complete 133 ms (median) after the last
workload. `env.txt` does not record the oxmysql package version or the commit
of the bench scripts (`bench scripts: commit not recorded (modified)`).

## 2026-10-28, build `ae3a7a5` (1.0.0-beta.2 in its report)

A pre-release build, labelled 1.0.0-beta.2 in its `REPORT.md`, with the
changes CHANGELOG lists under 1.0.0-beta.3: the boot copy of changed tables only, the boot work handed
back every frame, the idle WAL started over, and strict-mode triggers kept
out of the file's schema. Same host and setup as the `9e226f1` runs below,
default `cis_database_ack power`, 25 ms frame budget, five rounds, driver
order alternating each round. Started 2026-10-28 17:37 (UTC+3). Folder:
[2026-10-28-ae3a7a5-frame25](2026-10-28-ae3a7a5-frame25/REPORT.md). Better
on 61 of 78.

Medians over the five rounds, with the `9e226f1` 25 ms run beside it:

| Metric | ox | cis `ae3a7a5` | cis `9e226f1` |
|---|---:|---:|---:|
| read_player p50, µs | 1620 | 118 | 118 |
| save_player p50, µs | 1599 | 1899 | 1893 |
| bank_transfer p50, µs | 6796 | 2011 | 2063 |
| 256 players p99, µs | 73291 | 29531 | 31356 |
| 256 players long frames | 6 | 0 | 0 |
| Join storm, ms | 511 | 301 | 339 |
| Save storm, ms | 501 | 452 | 454 |
| Payday, ms | 9112 | 9973 | 10012 |
| Saturation, calls/s | 2102 | 3101 | 2945 |
| Bulk import, ms | 6142 | 9486 | 9797 |
| Hitch warnings (whole boot) | 4 | 1 | 14 |
| Longest hitch warning, ms | 277 | 173 | 298 |
| FXServer CPU, s | 52.70 | 43.43 | 45.24 |
| MariaDB CPU, s | 29.20 | 12.37 | 13.01 |

The ox column is this run's oxmysql. What changed against `9e226f1`: a boot
copies only the tables MariaDB changed, so the 10 to 17 hitch warnings of
the every-boot copy are gone; cis_database's boots now give 1 or 2 warnings
against oxmysql's 1 to 9. The per-call and live-player numbers are the same
within the ranges. Data check: one final checksum across all 10 runs;
cis_database's MariaDB copy matched what it served in 5 of 5; no errors.
The bench scripts ran from a copy with LF line endings
(`bench scripts: ? (modified)` in `env.txt`); their content is the commit's.

## 2026-10-28, build `9e226f1` (1.0.0-beta.2)

The 1.0.0-beta.2 build, an internal build that was never published. Same host and setup as the 2026-10-27 runs,
default `cis_database_ack power`, five rounds per frame
budget, driver order alternating each round.

| Frame budget | Folder | Started (UTC+3) | Better on |
|---|---|---|---|
| 25 ms (default) | [2026-10-28-frame25](2026-10-28-frame25/REPORT.md) | 2026-10-28 08:24 | 60 of 78 |
| 20 ms | [2026-10-28-frame20](2026-10-28-frame20/REPORT.md) | 2026-10-28 08:51 | 55 of 78 |
| 35 ms | [2026-10-28-frame35](2026-10-28-frame35/REPORT.md) | 2026-10-28 09:18 | 61 of 78 |

Medians over the five rounds:

| Metric | ox 20 | cis 20 | ox 25 | cis 25 | ox 35 | cis 35 |
|---|---:|---:|---:|---:|---:|---:|
| read_player p50, µs | 1620 | 119 | 1647 | 118 | 1638 | 120 |
| save_player p50, µs | 1622 | 1871 | 1614 | 1893 | 1618 | 1895 |
| bank_transfer p50, µs | 6805 | 2060 | 6886 | 2063 | 6853 | 2030 |
| 256 players p99, µs | 76303 | 28674 | 79973 | 31356 | 83591 | 30403 |
| 256 players long frames | 9 | 0 | 9 | 0 | 10 | 0 |
| Join storm, ms | 505 | 337 | 467 | 339 | 561 | 347 |
| Save storm, ms | 548 | 561 | 524 | 454 | 627 | 376 |
| Payday, ms | 9527 | 10113 | 9400 | 10012 | 9578 | 10312 |
| Saturation, calls/s | 2017 | 2608 | 1972 | 2945 | 2017 | 2924 |
| Bulk import, ms | 6176 | 10373 | 6262 | 9797 | 6115 | 8759 |
| Hitch warnings (whole boot) | 4 | 14 | 2 | 14 | 5 | 14 |
| Longest hitch warning, ms | 256 | 364 | 264 | 298 | 318 | 341 |
| FXServer CPU, s | 53.85 | 44.99 | 54.87 | 45.24 | 55.59 | 46.82 |
| MariaDB CPU, s | 30.34 | 12.69 | 31.14 | 13.01 | 32.02 | 13.30 |

What changed against `5f34b49`: since 1.0.0-beta.1 every boot copies each
table from MariaDB again. On this server that copy took about 21.8 s (114
tables, about 92,000 rows) on every boot after the first of each budget, and
gave 10 to 17 server-thread hitch warnings of 150 to 484 ms, all before the
resource reported ready. The `5f34b49` boots kept their copy and were ready
in about 3 s with 1 or 2 warnings. The extra copy also shows in FXServer and
MariaDB CPU and lowers saturation; the per-call and live-player numbers are
the same within the ranges. Data check: one final checksum across all 30
runs; cis_database's MariaDB copy matched what it served in every run; no
errors.

## 2026-10-27, build `5f34b49`

To refresh after the post-playtest bench on the pre-release build. These runs
measure `5f34b49`; the fixes listed below landed after it and are not in
these numbers.

Same host, OS, FXServer, MariaDB and oxmysql as the earlier runs (Setup,
below). cis_database `5f34b49` with the default
`cis_database_ack power` (a write is answered after an fdatasync of the WAL).
Five rounds per frame budget, driver order alternating each round. Each
folder has `REPORT.md`, `env.txt` and `summary.json`; the `reproduce` line
names the server's folders as placeholders. `env.txt` marks the bench
scripts as modified from the commit (`bench scripts: ? (modified)`).

| Frame budget | Folder | Started (UTC+3) | Better on |
|---|---|---|---|
| 25 ms (default) | [2026-10-27-frame25](2026-10-27-frame25/REPORT.md) | 2026-10-27 20:36 | 66 of 78 |
| 20 ms | [2026-10-27-frame20](2026-10-27-frame20/REPORT.md) | 2026-10-27 21:01 | 64 of 78 |
| 35 ms | [2026-10-27-frame35](2026-10-27-frame35/REPORT.md) | 2026-10-27 21:26 | 66 of 78 |

Medians over the five rounds:

| Metric | ox 20 | cis 20 | ox 25 | cis 25 | ox 35 | cis 35 |
|---|---:|---:|---:|---:|---:|---:|
| read_player p50, µs | 1619 | 105 | 1635 | 102 | 1628 | 107 |
| save_player p50, µs | 1639 | 1919 | 1600 | 1898 | 1601 | 1890 |
| bank_transfer p50, µs | 6880 | 1956 | 6877 | 1969 | 6850 | 1947 |
| 256 players p99, µs | 69211 | 18278 | 72572 | 17901 | 94687 | 16516 |
| 256 players long frames | 7 | 0 | 9 | 0 | 8 | 0 |
| Join storm, ms | 544 | 335 | 502 | 238 | 495 | 239 |
| Save storm, ms | 520 | 456 | 591 | 405 | 564 | 356 |
| Payday, ms | 9314 | 9890 | 9536 | 9903 | 9613 | 9966 |
| Saturation, calls/s | 2100 | 2957 | 2077 | 3722 | 2088 | 5236 |
| Bulk import, ms | 5893 | 10037 | 5874 | 9455 | 5814 | 8051 |
| Hitch warnings (whole boot) | 2 | 1 | 0 | 2 | 6 | 1 |
| Longest hitch warning, ms | 171 | 456 | 0 | 509 | 399 | 446 |
| FXServer CPU, s | 53.41 | 34.89 | 54.27 | 36.28 | 53.94 | 37.86 |
| MariaDB CPU, s | 30.35 | 7.15 | 31.05 | 7.37 | 30.31 | 7.39 |

Data check, all three runs: one distinct final checksum across every run of
both drivers, cis_database's MariaDB copy matched what it served in 5 of 5
runs, and no run had an error. The copy to MariaDB was complete 389 ms
(20 ms budget), 680 ms (25 ms) and 1059 ms (35 ms) after the last workload,
medians.

- **Where oxmysql leads.** Single writes from one thread (`save_player`,
  `save_inventory`, `send_message` p50, about 0.85x), the 5000-update payday
  loop (0.94x to 0.96x) and the bulk import (0.59x to 0.72x). With
  `ack power`, a single write waits for an fdatasync, which is what moved
  these behind oxmysql.
- **Hitch warnings.** cis_database's count is 1 or 2 per boot at every
  budget; its longest warning (446 to 509 ms) is at startup. oxmysql's count
  ranged from 0 to 13 per boot. The whole-boot count includes startup and the
  seed, so it varies most between rounds.
- **Startup probe.** The same build was booted outside FXServer on the
  bench host (Node 22, `tests/harness/fx.js`) against a MariaDB stand-in of
  112 tables and 90,000 rows, timing every event-loop gap over 50 ms. A boot
  that copies every table took 2819 ms, with one gap of 257 ms. A boot that
  kept its SQLite file took 252 ms, with one gap of 121 ms.

Landed after `5f34b49`, not measured here:

- `1ce6a28`: boot work sliced under the frame budget.
- `df0958f`: calls wait while the hydrate export runs.
- `aa3848a`, `6549a93`, `e687b40`: oxmysql's return types and MariaDB's
  write counts and insert ids; `ON DUPLICATE KEY UPDATE`, `AUTO_INCREMENT`
  alters, column order, `DECIMAL` strings, `UUID()`, big integers.
- `a9ea150`: reads SQLite would answer differently go to MariaDB.
- 1.0.0-beta.1: every boot copies each table from MariaDB again, unless the
  table has writes still waiting for MariaDB. A restart now costs the copy
  boot of the probe above, not the kept one.

## 2026-10-24 and 2026-10-25, build `2c51f67`

Three runs of `bench/run_bench.sh 5` on the same server, one per cis_database
frame budget (20, 25 and 35 ms). Each run is five rounds; each round boots the
server once with oxmysql and once with cis_database, alternating which goes
first. oxmysql has no frame budget, so its three columns are three separate
measurements of the same setup and show how much a run varies from night to
night.

| Frame budget | Folder | Started | Rounds |
|---|---|---|---|
| 20 ms | [2026-10-25-frame20](2026-10-25-frame20/REPORT.md) | 2026-10-25 00:15 | 5 |
| 25 ms (default) | [2026-10-24](2026-10-24/REPORT.md) | 2026-10-24 20:07 | 5 (round 5 run at 23:40 with the same build, server and config) |
| 35 ms | [2026-10-25-frame35](2026-10-25-frame35/REPORT.md) | 2026-10-25 00:41 | 5 |

Each folder has the full `REPORT.md` (78 metrics, medians with ranges) and
`summary.json` (every run's value for every metric). Times are server time
(UTC+3).

## Setup

| | |
|---|---|
| Host | VPS: AMD EPYC 7302, 6 cores, 16 GiB RAM |
| OS | Ubuntu 24.04.5 LTS |
| FXServer | build 35245 |
| Server | Qbox, with its whole `server.cfg` |
| MariaDB | 10.11.14, same host |
| oxmysql | 2.14.3 |
| cis_database | pre-release build `2c51f67`, `durable` profile (WAL, `synchronous=NORMAL`); writes confirmed at commit, before the `cis_database_ack power` default |
| Frame budget | `frameBudgetMs` 25 in `config.json`; 20 and 35 set through the convar `cis_database_frame_ms` (`BENCH_FRAME_MS`) |

## Method

- One Lua resource (`bench/cis_bench`) runs the same workloads through
  `MySQL.*.await` with whichever driver is started. Only the `ensure` line
  differs between the two boots of a round.
- cis_database was installed from the same `2c51f67` package for each run,
  with the outbox epoch removed from its `cache/` first, so its writes were
  never counted as copies MariaDB already had from an earlier run. The
  reasons are in [the bench README](../README.md#running-it).
- Latency is timed around each call in the calling Lua thread (`os.nanotime`).
- A long frame is a server tick more than 16.7 ms past the boot's idle tick,
  seen by a `Wait(0)` thread.
- Hitch warnings are FXServer's own `server thread hitch warning` lines over
  the whole boot, startup and seeding included.
- CPU is FXServer plus `mariadbd` process time from the idle measurement to
  the end of the workloads.
- Every write is deterministic. All runs of both drivers must end with the
  same table checksums, and the run script reads MariaDB's checksums through
  the `mysql` client after cis_database's copy has drained.
- The run refuses to start while a player is connected. At the end it puts
  `server.cfg` and oxmysql back and starts the server that was running.

Rerun on the server, as root, from a checkout of this repository:
`bash bench/run_bench.sh 5` (add `BENCH_FRAME_MS=20` for another budget).

## Medians

| Metric | ox 20 | cis 20 | ox 25 | cis 25 | ox 35 | cis 35 |
|---|---:|---:|---:|---:|---:|---:|
| Hitch warnings | 8 | 2 | 10 | 4 | 3 | 3 |
| Saturation, calls/s | 1990 | 2690 | 2073 | 3580 | 1987 | 4770 |
| 256 players p99, µs | 93849 | 20792 | 82081 | 17855 | 76690 | 19008 |
| 256 players long frames | 13 | 0 | 11 | 0 | 11 | 0 |
| Join storm, ms | 565 | 338 | 515 | 286 | 561 | 247 |
| Save storm, ms | 625 | 554 | 635 | 449 | 654 | 361 |
| Payday, ms | 10308 | 10998 | 9854 | 10435 | 10255 | 10504 |
| Bulk import, ms | 6145 | 10176 | 6040 | 9945 | 6288 | 8561 |
| FXServer CPU, s | 59.54 | 38.48 | 55.91 | 37.14 | 58.11 | 40.35 |
| MariaDB CPU, s | 33.31 | 7.93 | 30.00 | 7.64 | 33.29 | 8.32 |

Better on: cis_database on 66 of 78 metrics at 20 ms, 66 of 78 at 25 ms,
66 of 78 at 35 ms. oxmysql stays ahead on bulk import, the 5000-update
payday loop and most single-thread write latencies. Hitch warnings count the
whole boot, startup included, and vary most from round to round: at 35 ms the
medians tie at 3, with cis_database's range narrower (1 to 5 against 1 to 10).

Data check, all three runs: one distinct final checksum across every run of
both drivers, cis_database's MariaDB copy matched what it served in 5 of 5
runs, and no run had an error.

## Hitch warnings by phase

Every `server thread hitch warning` of the 30 boots above, placed in the bench
phase it fell in. The console logs carry no timestamps, so a warning is placed
by log order: FXServer prints it when the stalled frame ends, which puts it in
the phase whose end marker (`start driver=`, `seed`, `idle tick`, ...) comes
after it. `bench/hitch_phases.py` does the split; each boot's phases add up to
the whole-boot count in its `summary.json`. Cells are totals over the 5 runs.
"Play" is idle through saturation.

| Driver | Budget | Start | Seed | Idle | Single call | Live 64 | Live 128 | Live 256 | Join | Save | Payday | Saturation | Checks | Play, per run | Longest in play, ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
| cis_database | 20 ms | 9 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 0 0 0 0 | - |
| cis_database | 25 ms | 10 | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 0 0 0 0 | - |
| cis_database | 35 ms | 9 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 0 0 0 0 | - |
| oxmysql | 20 ms | 5 | 1 | 0 | 9 | 2 | 2 | 3 | 1 | 0 | 4 | 9 | 0 | 7 0 13 0 10 | 493 |
| oxmysql | 25 ms | 5 | 1 | 0 | 12 | 2 | 4 | 3 | 1 | 1 | 3 | 10 | 0 | 8 1 13 14 0 | 494 |
| oxmysql | 35 ms | 5 | 0 | 0 | 4 | 2 | 3 | 0 | 0 | 1 | 2 | 7 | 0 | 0 9 2 8 0 | 391 |

The frame budget is a cis_database setting; the oxmysql rows are its passes
from the same rounds, so they show how much the rounds varied, not a budget
effect.

- **Play:** cis_database had 0 hitch warnings in every play phase, in all 15
  boots, at all three budgets. oxmysql had them in 10 of its 15 boots, up to
  14 in one boot and up to 494 ms long, most of them in the single-call and
  saturation phases.
- **Start:** every boot of both drivers has one warning of 1250 to 1519 ms
  right after `Started resource cis_bench`, while FXServer starts the
  server's resources. cis_database has a second one of 157 to 275 ms (14 of
  15 boots) at the point it reports ready, after it opened its SQLite file.
- **Seed:** the bulk import (20,000 players and 40,000 vehicles) is the only
  measured phase where cis_database warns, 151 to 237 ms each: 1 warning
  over the 5 boots at 20 ms, 8 at 25 ms, 5 at 35 ms. Seeding is setup, not
  play.
- **Which budget:** in play the three budgets tie at 0. Counting the seed,
  20 ms has the fewest (10 in total over 5 boots, against 18 at 25 ms and 14
  at 35 ms), at the cost of the lowest saturation throughput of the three
  (2690 calls/s, against 3580 and 4770).

## Every round

### 20 ms frame budget

cis_database better on 66 of 78 metrics. Data check: 1 distinct checksum; cis_database MariaDB copy matched in 5 of 5 runs. Errors: {"oxmysql":[0,0,0,0,0],"cis_database":[0,0,0,0,0]}

| metric | driver | round 1 | round 2 | round 3 | round 4 | round 5 | median |
|---|---|---:|---:|---:|---:|---:|---:|
| Hitch warnings | oxmysql | 8 | 2 | 14 | 1 | 11 | 8 |
| Hitch warnings | cis_database | 1 | 2 | 2 | 3 | 2 | 2 |
| Saturation, calls/s | oxmysql | 1895 | 2048 | 1990 | 1871 | 2006 | 1990 |
| Saturation, calls/s | cis_database | 2507 | 2690 | 2718 | 2781 | 2647 | 2690 |
| 256 players p99, µs | oxmysql | 75651 | 80113 | 95593 | 93849 | 106050 | 93849 |
| 256 players p99, µs | cis_database | 20792 | 18516 | 21170 | 20359 | 20845 | 20792 |
| 256 players long frames | oxmysql | 13 | 14 | 10 | 13 | 7 | 13 |
| 256 players long frames | cis_database | 0 | 0 | 0 | 0 | 0 | 0 |
| Join storm, ms | oxmysql | 565 | 574 | 459 | 545 | 611 | 565 |
| Join storm, ms | cis_database | 333 | 338 | 386 | 380 | 330 | 338 |
| Save storm, ms | oxmysql | 558 | 680 | 740 | 523 | 625 | 625 |
| Save storm, ms | cis_database | 608 | 554 | 514 | 561 | 552 | 554 |
| Payday, ms | oxmysql | 10574 | 10287 | 10386 | 10308 | 10097 | 10308 |
| Payday, ms | cis_database | 11890 | 11164 | 10998 | 10300 | 10761 | 10998 |
| Bulk import, ms | oxmysql | 6523 | 6112 | 6145 | 6274 | 6056 | 6145 |
| Bulk import, ms | cis_database | 10353 | 10535 | 10148 | 10089 | 10176 | 10176 |
| FXServer CPU, s | oxmysql | 59.96 | 59.54 | 57.88 | 59.58 | 58.40 | 59.54 |
| FXServer CPU, s | cis_database | 38.48 | 38.97 | 39.51 | 38.37 | 37.19 | 38.48 |
| MariaDB CPU, s | oxmysql | 34.08 | 33.67 | 32.07 | 33.31 | 32.74 | 33.31 |
| MariaDB CPU, s | cis_database | 7.71 | 8.36 | 8.55 | 7.93 | 7.74 | 7.93 |

### 25 ms frame budget

cis_database better on 66 of 78 metrics. Data check: 1 distinct checksum; cis_database MariaDB copy matched in 5 of 5 runs. Errors: {"oxmysql":[0,0,0,0,0],"cis_database":[0,0,0,0,0]}

| metric | driver | round 1 | round 2 | round 3 | round 4 | round 5 | median |
|---|---|---:|---:|---:|---:|---:|---:|
| Hitch warnings | oxmysql | 10 | 2 | 14 | 15 | 1 | 10 |
| Hitch warnings | cis_database | 3 | 4 | 4 | 3 | 4 | 4 |
| Saturation, calls/s | oxmysql | 2081 | 2082 | 2044 | 2073 | 1982 | 2073 |
| Saturation, calls/s | cis_database | 3772 | 3580 | 3653 | 3550 | 3466 | 3580 |
| 256 players p99, µs | oxmysql | 94348 | 80807 | 82081 | 121810 | 71544 | 82081 |
| 256 players p99, µs | cis_database | 17855 | 17273 | 17459 | 19289 | 20837 | 17855 |
| 256 players long frames | oxmysql | 11 | 13 | 10 | 7 | 11 | 11 |
| 256 players long frames | cis_database | 0 | 0 | 0 | 0 | 0 | 0 |
| Join storm, ms | oxmysql | 617 | 515 | 636 | 510 | 500 | 515 |
| Join storm, ms | cis_database | 286 | 287 | 286 | 286 | 290 | 286 |
| Save storm, ms | oxmysql | 559 | 681 | 506 | 673 | 635 | 635 |
| Save storm, ms | cis_database | 412 | 455 | 468 | 449 | 410 | 449 |
| Payday, ms | oxmysql | 10164 | 9701 | 9854 | 9510 | 9972 | 9854 |
| Payday, ms | cis_database | 10435 | 9953 | 10266 | 10469 | 10555 | 10435 |
| Bulk import, ms | oxmysql | 6054 | 5928 | 6040 | 6018 | 6163 | 6040 |
| Bulk import, ms | cis_database | 10186 | 9827 | 10130 | 9659 | 9945 | 9945 |
| FXServer CPU, s | oxmysql | 55.65 | 55.34 | 56.95 | 55.91 | 56.64 | 55.91 |
| FXServer CPU, s | cis_database | 36.60 | 35.88 | 37.72 | 37.14 | 38.89 | 37.14 |
| MariaDB CPU, s | oxmysql | 29.99 | 30.00 | 30.36 | 29.72 | 30.87 | 30.00 |
| MariaDB CPU, s | cis_database | 7.68 | 6.77 | 7.58 | 7.64 | 7.70 | 7.64 |

### 35 ms frame budget

cis_database better on 66 of 78 metrics. Data check: 1 distinct checksum; cis_database MariaDB copy matched in 5 of 5 runs. Errors: {"oxmysql":[0,0,0,0,0],"cis_database":[0,0,0,0,0]}

| metric | driver | round 1 | round 2 | round 3 | round 4 | round 5 | median |
|---|---|---:|---:|---:|---:|---:|---:|
| Hitch warnings | oxmysql | 1 | 10 | 3 | 9 | 1 | 3 |
| Hitch warnings | cis_database | 1 | 5 | 2 | 3 | 3 | 3 |
| Saturation, calls/s | oxmysql | 1987 | 1962 | 1984 | 1993 | 2096 | 1987 |
| Saturation, calls/s | cis_database | 4770 | 4735 | 4713 | 4900 | 4951 | 4770 |
| 256 players p99, µs | oxmysql | 76690 | 98988 | 71124 | 108603 | 68531 | 76690 |
| 256 players p99, µs | cis_database | 17981 | 19008 | 18204 | 20673 | 22657 | 19008 |
| 256 players long frames | oxmysql | 12 | 10 | 11 | 14 | 10 | 11 |
| 256 players long frames | cis_database | 0 | 1 | 0 | 0 | 1 | 0 |
| Join storm, ms | oxmysql | 523 | 554 | 585 | 561 | 561 | 561 |
| Join storm, ms | cis_database | 242 | 252 | 247 | 288 | 240 | 247 |
| Save storm, ms | oxmysql | 654 | 627 | 643 | 723 | 693 | 654 |
| Save storm, ms | cis_database | 407 | 360 | 368 | 361 | 310 | 361 |
| Payday, ms | oxmysql | 10504 | 10127 | 10279 | 10255 | 9942 | 10255 |
| Payday, ms | cis_database | 10786 | 11004 | 10254 | 10205 | 10504 | 10504 |
| Bulk import, ms | oxmysql | 6211 | 6265 | 6288 | 6524 | 6299 | 6288 |
| Bulk import, ms | cis_database | 8506 | 8518 | 8561 | 8743 | 8799 | 8561 |
| FXServer CPU, s | oxmysql | 58.11 | 60.07 | 59.51 | 57.17 | 54.99 | 58.11 |
| FXServer CPU, s | cis_database | 41.79 | 41.56 | 39.61 | 40.35 | 39.88 | 40.35 |
| MariaDB CPU, s | oxmysql | 32.02 | 33.73 | 33.79 | 33.29 | 30.05 | 33.29 |
| MariaDB CPU, s | cis_database | 8.65 | 8.54 | 7.93 | 8.32 | 7.88 | 8.32 |

## Notes

- **Earlier figures.** The 2026-10-22 `run_gens.sh` runs (in commit
  messages: 0 hitch warnings against oxmysql's 5 at 20 ms, 0 against 9 at
  35 ms) used clean boots with the page cache dropped and one round. They are
  not comparable with these runs, which count hitches over the whole boot.
- **Discarded run.** The first 20 ms run (2026-10-24 23:46) reused the
  outbox epoch of an earlier install on the same MariaDB. cis_database
  served the right data, but MariaDB counted its new writes as already
  copied, so the copy check failed. The run was discarded and run again.
  That case is a bug in the engine, fixed after `2c51f67`: a file older than
  MariaDB's mark is now found at boot, its new writes are sent, and the
  tables are copied again from MariaDB. These runs measure `2c51f67`, which
  predates the fix; removing the epoch before each run keeps the bug out of
  them.
- **What "confirmed" means.** oxmysql confirms a write once MariaDB has it.
  cis_database `2c51f67` confirms once its SQLite file has it (at commit; later builds wait for an fdatasync of the WAL by default) and copies it to MariaDB
  behind; each report gives how long that copy took to finish after the last
  workload.
