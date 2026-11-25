# cis_database vs oxmysql: real-server benchmark

Same server, same resources, same Lua (`bench/cis_bench`), one driver per boot, 5 rounds each, driver order alternating every round. Medians across rounds, range in brackets.

| | |
|---|---|
| date | 2026-10-27T20:36:38+03:00 |
| cpu | AMD EPYC 7302 16-Core Processor |
| cores | 6 |
| ram | 16 GiB |
| os | Ubuntu 24.04.5 LTS |
| fxserver | build 35245 |
| server | Qbox, its whole server.cfg |
| mariadb | server 10.11.14-MariaDB-0ubuntu0.24.04.1-log, client mysql  Ver 15.1 Distrib 10.11.14-MariaDB, for debian-linux-gnu (x86_64) using  EditLine wrapper |
| oxmysql | 2.14.3 (package ?) |
| cis_database | 1.0.0 build 5f34b49 |
| cis_database frame budget | 25 ms (BENCH_FRAME_MS, convar cis_database_frame_ms) |
| cis_database write ack | power (default: answered after an fdatasync of the WAL) |
| bench scripts | ? (modified) |
| rounds | 5 |
| scale | 1 |
| reproduce | BENCH_DATA=<server data folder> BENCH_SERVER=qbox BENCH_DB=qbox BENCH_FXROOT=<FXServer folder> BENCH_FRAME_MS=25 bash bench/run_bench.sh 5 1 |

**cis_database is better on 66 of 78 metrics.**

oxmysql is better on: Single call (one thread, .await) / save_player mean, Single call (one thread, .await) / save_player p50, Single call (one thread, .await) / save_player p99, Single call (one thread, .await) / save_inventory mean, Single call (one thread, .await) / save_inventory p50, Single call (one thread, .await) / save_inventory p99, Single call (one thread, .await) / send_message mean, Single call (one thread, .await) / send_message p50, Payday loop (5000 sequential updates) / wall time, Bulk import / 20k players + 40k vehicles, FXServer hitch warnings (whole boot, startup included) / warnings, FXServer hitch warnings (whole boot, startup included) / longest.

Data check: 1 distinct final checksum across all 10 runs of both drivers (1 means every run ended with identical data). cis_database's MariaDB copy matched what it served in 5 of 5 runs; oxmysql's MariaDB matched in 5 of 5. Errors per run: oxmysql [0, 0, 0, 0, 0], cis_database [0, 0, 0, 0, 0].

cis_database confirms a write once an fdatasync of its SQLite WAL covers it (the default `cis_database_ack power`; see env.txt) and copies it to MariaDB behind; oxmysql confirms once MariaDB has committed it. After the last workload, cis_database's MariaDB copy was complete within 680 ms (median).

## Single call (one thread, .await)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| read_player mean | µs | 1889.5 [1822.9-2066.8] | 234.5 [231.4-261.3] | 8.06x **cis** |
| read_player p50 | µs | 1634.9 [1615.4-1654.4] | 101.5 [99.3-109.3] | 16.11x **cis** |
| read_player p99 | µs | 6962.3 [5597.1-7772.2] | 2293.9 [1864.1-2922.2] | 3.04x **cis** |
| read_by_license mean | µs | 1700.8 [1670.3-1952.6] | 182.6 [166.8-202.3] | 9.32x **cis** |
| read_by_license p50 | µs | 1563.4 [1549.3-1587.9] | 78.7 [73.5-87.6] | 19.87x **cis** |
| read_by_license p99 | µs | 4033.6 [3058.5-5874.4] | 1716.6 [1626.0-1805.5] | 2.35x **cis** |
| read_vehicles mean | µs | 1774.6 [1704.0-2065.9] | 203.8 [200.6-228.1] | 8.71x **cis** |
| read_vehicles p50 | µs | 1612.2 [1546.9-1623.6] | 93.0 [89.9-98.3] | 17.33x **cis** |
| read_vehicles p99 | µs | 4465.7 [3651.7-7093.9] | 1718.5 [1658.1-1898.6] | 2.60x **cis** |
| read_messages mean | µs | 1718.0 [1668.4-1785.9] | 129.5 [124.9-156.9] | 13.27x **cis** |
| read_messages p50 | µs | 1531.3 [1521.4-1571.9] | 56.5 [53.2-66.5] | 27.10x **cis** |
| read_messages p99 | µs | 4096.8 [3872.8-5269.2] | 1535.8 [1509.9-1614.7] | 2.67x **cis** |
| json_hunger mean | µs | 1701.4 [1642.5-1743.5] | 175.8 [166.3-184.9] | 9.68x **cis** |
| json_hunger p50 | µs | 1521.5 [1513.6-1554.2] | 72.5 [70.4-76.0] | 20.99x **cis** |
| json_hunger p99 | µs | 4602.9 [2987.4-5216.1] | 1681.8 [1594.3-1832.6] | 2.74x **cis** |
| in_list mean | µs | 1792.7 [1750.5-1870.4] | 332.9 [311.4-334.6] | 5.39x **cis** |
| in_list p50 | µs | 1586.8 [1570.1-1591.6] | 139.9 [136.5-147.2] | 11.35x **cis** |
| in_list p99 | µs | 5550.1 [4689.1-5993.0] | 2531.1 [2474.6-2703.8] | 2.19x **cis** |
| count_police mean | µs | 1827.7 [1691.6-2191.3] | 465.6 [450.5-517.6] | 3.93x **cis** |
| count_police p50 | µs | 1544.6 [1503.5-1560.4] | 230.8 [218.4-250.9] | 6.69x **cis** |
| count_police p99 | µs | 4673.1 [2963.0-6413.7] | 2512.8 [2022.7-4221.0] | 1.86x **cis** |
| richest mean | µs | 14663.0 [13613.9-15091.6] | 462.7 [420.8-532.6] | 31.69x **cis** |
| richest p50 | µs | 14385.3 [13410.7-14793.9] | 125.2 [100.6-142.4] | 114.87x **cis** |
| richest p99 | µs | 19232.4 [17401.8-21697.3] | 11964.4 [3246.7-12711.8] | 1.61x **cis** |
| save_player mean | µs | 2212.6 [2100.1-2249.2] | 2240.8 [2168.7-2376.3] | 0.99x ox |
| save_player p50 | µs | 1600.1 [1563.9-1607.6] | 1898.2 [1865.6-1963.7] | 0.84x ox |
| save_player p99 | µs | 6012.7 [5386.4-7423.7] | 6635.4 [6403.1-7961.2] | 0.91x ox |
| save_inventory mean | µs | 2096.9 [1995.4-2156.1] | 2150.3 [2066.2-2177.9] | 0.98x ox |
| save_inventory p50 | µs | 1592.5 [1571.7-1598.0] | 1837.8 [1823.7-1868.9] | 0.87x ox |
| save_inventory p99 | µs | 6115.2 [5954.1-6312.1] | 6371.0 [5619.8-7192.9] | 0.96x ox |
| send_message mean | µs | 1875.3 [1839.9-1957.3] | 1976.6 [1923.7-2166.7] | 0.95x ox |
| send_message p50 | µs | 1520.0 [1507.7-1532.3] | 1744.7 [1734.3-1780.7] | 0.87x ox |
| send_message p99 | µs | 5558.2 [5071.3-6226.3] | 5092.2 [4868.1-6638.7] | 1.09x **cis** |
| bank_transfer mean | µs | 7596.8 [7372.6-7736.8] | 2292.5 [2253.1-2526.3] | 3.31x **cis** |
| bank_transfer p50 | µs | 6876.6 [6791.2-6929.6] | 1969.4 [1942.6-2023.6] | 3.49x **cis** |
| bank_transfer p99 | µs | 14243.7 [12603.3-14510.7] | 7220.2 [6550.4-8943.9] | 1.97x **cis** |

## Live server, 64 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 228 [227-228] | 233 [233-234] | 1.02x **cis** |
| mean latency | µs | 6874.3 [6518.4-7095.3] | 963.8 [958.5-997.7] | 7.13x **cis** |
| p50 latency | µs | 5737.7 [5571.7-6170.7] | 142.6 [140.5-144.5] | 40.24x **cis** |
| p99 latency | µs | 24889.1 [19887.9-32660.3] | 7651.7 [7036.1-9861.6] | 3.25x **cis** |
| max latency | µs | 77904.7 [47197.1-88532.0] | 17150.5 [16692.7-25589.4] | 4.54x **cis** |
| long frames | frames | 1 [0-3] | 0 [0-0] | inf **cis** |
| worst frame | ms | 81.1 [59.0-86.2] | 55.1 [53.7-57.9] | 1.47x **cis** |
| time past the tick | ms | 14.3 [0.0-33.5] | 0.0 [0.0-0.0] | inf **cis** |

## Live server, 128 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 457 [457-458] | 466 [464-467] | 1.02x **cis** |
| mean latency | µs | 10869.2 [10384.3-11500.1] | 1248.4 [1194.2-1347.6] | 8.71x **cis** |
| p50 latency | µs | 9469.3 [8676.0-10103.6] | 125.3 [124.4-130.3] | 75.57x **cis** |
| p99 latency | µs | 37401.8 [36405.3-49749.5] | 11848.4 [9190.4-14107.3] | 3.16x **cis** |
| max latency | µs | 98625.4 [92406.5-112821.2] | 21034.8 [16725.2-29808.8] | 4.69x **cis** |
| long frames | frames | 2 [1-6] | 0 [0-0] | inf **cis** |
| worst frame | ms | 103.7 [92.8-124.3] | 55.7 [55.2-56.6] | 1.86x **cis** |
| time past the tick | ms | 59.7 [26.4-122.4] | 0.0 [0.0-0.0] | inf **cis** |

## Live server, 256 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 868 [864-874] | 918 [910-919] | 1.06x **cis** |
| mean latency | µs | 18003.5 [16759.3-20740.5] | 2294.6 [2180.4-2460.5] | 7.85x **cis** |
| p50 latency | µs | 15621.2 [14593.2-17910.8] | 124.6 [121.9-128.4] | 125.34x **cis** |
| p99 latency | µs | 72571.9 [62861.1-80322.1] | 17901.0 [15564.0-18426.7] | 4.05x **cis** |
| max latency | µs | 113463.1 [104704.8-134379.7] | 32242.6 [28549.7-34166.9] | 3.52x **cis** |
| long frames | frames | 9 [8-13] | 0 [0-0] | inf **cis** |
| worst frame | ms | 123.5 [121.6-132.2] | 57.9 [56.2-65.5] | 2.13x **cis** |
| time past the tick | ms | 218.2 [197.6-253.0] | 0.0 [0.0-0.0] | inf **cis** |

## Join storm (128 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all joined | ms | 501.8 [446.2-558.7] | 238.2 [236.6-302.7] | 2.11x **cis** |
| p99 join | µs | 404132.6 [374142.6-472813.0] | 172869.1 [158323.2-220674.8] | 2.34x **cis** |
| long frames | frames | 1 [0-2] | 0 [0-0] | inf **cis** |
| worst frame | ms | 77.7 [58.3-101.9] | 58.3 [54.4-64.6] | 1.33x **cis** |

## Save storm (256 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all saved | ms | 591.0 [562.0-722.2] | 405.2 [402.1-414.4] | 1.46x **cis** |
| p99 save | µs | 461260.9 [414190.1-608596.6] | 306778.6 [289922.2-332072.1] | 1.50x **cis** |
| long frames | frames | 1 [0-3] | 0 [0-1] | inf **cis** |
| worst frame | ms | 107.9 [63.2-147.2] | 60.7 [57.6-71.2] | 1.78x **cis** |

## Payday loop (5000 sequential updates)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| wall time | ms | 9535.9 [9456.8-10014.3] | 9903.3 [9632.6-10085.8] | 0.96x ox |
| worst frame | ms | 82.0 [65.7-94.7] | 61.6 [58.2-68.9] | 1.33x **cis** |

## Saturation (32 threads, 10 s)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 2077 [2038-2121] | 3722 [3675-3835] | 1.79x **cis** |
| worst frame | ms | 119.0 [111.0-131.0] | 59.2 [57.4-60.0] | 2.01x **cis** |

## Bulk import

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| 20k players + 40k vehicles | ms | 5874 [5769-6098] | 9455 [9276-9650] | 0.62x ox |

## Idle server

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| tick | ms | 50.1 [50.1-50.2] | 50.1 [50.1-50.2] | 1.00x **cis** |

## FXServer hitch warnings (whole boot, startup included)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| warnings | count | 0 [0-1] | 2 [1-2] | 0.00x ox |
| longest | ms | 0 [0-196] | 509 [302-542] | 0.00x ox |

## CPU for the measured workload

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| FXServer | s | 54.27 [52.71-55.17] | 36.28 [35.46-36.76] | 1.50x **cis** |
| MariaDB | s | 31.05 [29.41-31.72] | 7.37 [7.05-7.92] | 4.21x **cis** |

## How it was measured

- Latency is the time around each `MySQL.*.await` call in the calling Lua thread (os.nanotime), so it includes the driver's Lua library, the export call and the wait for the answer.
- A long frame is a server tick more than 16.7 ms (one 60 Hz frame) past this boot's idle tick, measured by a `Wait(0)` thread. "Time past the tick" adds up how far those frames ran over.
- Live server: N threads each act as a player making 60 calls picked from an 80/20 read/write mix (player load, vehicles, inventory, messages, bank log, police count; saves, inventory saves, bank transfers in a transaction, messages, vehicle updates) with random think time.
- Writes are deterministic, so every driver and every run must end with the same data; the checksums above check that, and check MariaDB itself through the mysql CLI.
- Hitch warnings are FXServer's own `server thread hitch warning` console lines, counted over each boot's whole log (resource start and seed included).
- CPU is FXServer plus mariadbd process time from the idle measurement to the end of the workloads.
- Rerun on the server box, as root, from a checkout of this repository: `bash bench/run_bench.sh 5`.
