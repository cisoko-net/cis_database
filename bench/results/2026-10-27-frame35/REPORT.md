# cis_database vs oxmysql: real-server benchmark

Same server, same resources, same Lua (`bench/cis_bench`), one driver per boot, 5 rounds each, driver order alternating every round. Medians across rounds, range in brackets.

| | |
|---|---|
| date | 2026-10-27T21:26:19+03:00 |
| cpu | AMD EPYC 7302 16-Core Processor |
| cores | 6 |
| ram | 16 GiB |
| os | Ubuntu 24.04.5 LTS |
| fxserver | build 35245 |
| server | Qbox, its whole server.cfg |
| mariadb | server 10.11.14-MariaDB-0ubuntu0.24.04.1-log, client mysql  Ver 15.1 Distrib 10.11.14-MariaDB, for debian-linux-gnu (x86_64) using  EditLine wrapper |
| oxmysql | 2.14.3 (package ?) |
| cis_database | 1.0.0 build 5f34b49 |
| cis_database frame budget | 35 ms (BENCH_FRAME_MS, convar cis_database_frame_ms) |
| cis_database write ack | power (default: answered after an fdatasync of the WAL) |
| bench scripts | ? (modified) |
| rounds | 5 |
| scale | 1 |
| reproduce | BENCH_DATA=<server data folder> BENCH_SERVER=qbox BENCH_DB=qbox BENCH_FXROOT=<FXServer folder> BENCH_FRAME_MS=35 bash bench/run_bench.sh 5 1 |

**cis_database is better on 66 of 78 metrics.**

oxmysql is better on: Single call (one thread, .await) / save_player mean, Single call (one thread, .await) / save_player p50, Single call (one thread, .await) / save_player p99, Single call (one thread, .await) / save_inventory mean, Single call (one thread, .await) / save_inventory p50, Single call (one thread, .await) / save_inventory p99, Single call (one thread, .await) / send_message p50, Payday loop (5000 sequential updates) / wall time, Bulk import / 20k players + 40k vehicles, FXServer hitch warnings (whole boot, startup included) / longest.

Data check: 1 distinct final checksum across all 10 runs of both drivers (1 means every run ended with identical data). cis_database's MariaDB copy matched what it served in 5 of 5 runs; oxmysql's MariaDB matched in 5 of 5. Errors per run: oxmysql [0, 0, 0, 0, 0], cis_database [0, 0, 0, 0, 0].

cis_database confirms a write once an fdatasync of its SQLite WAL covers it (the default `cis_database_ack power`; see env.txt) and copies it to MariaDB behind; oxmysql confirms once MariaDB has committed it. After the last workload, cis_database's MariaDB copy was complete within 1059 ms (median).

## Single call (one thread, .await)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| read_player mean | µs | 1885.9 [1858.8-1928.1] | 197.3 [187.9-223.7] | 9.56x **cis** |
| read_player p50 | µs | 1628.3 [1617.2-1637.4] | 106.8 [90.4-110.6] | 15.25x **cis** |
| read_player p99 | µs | 6296.6 [5634.4-8010.7] | 2014.1 [1773.5-2176.5] | 3.13x **cis** |
| read_by_license mean | µs | 1735.1 [1638.8-1761.5] | 139.1 [121.4-151.4] | 12.47x **cis** |
| read_by_license p50 | µs | 1558.5 [1532.5-1583.2] | 82.9 [73.9-85.7] | 18.81x **cis** |
| read_by_license p99 | µs | 4353.6 [3458.1-4689.7] | 1623.9 [1500.9-1736.6] | 2.68x **cis** |
| read_vehicles mean | µs | 1732.1 [1707.1-1812.0] | 156.7 [140.0-169.6] | 11.06x **cis** |
| read_vehicles p50 | µs | 1577.3 [1562.8-1605.2] | 95.0 [84.0-102.6] | 16.60x **cis** |
| read_vehicles p99 | µs | 4330.2 [3634.3-5237.1] | 1702.6 [1567.0-1762.9] | 2.54x **cis** |
| read_messages mean | µs | 1670.0 [1648.1-1847.8] | 106.4 [99.3-120.9] | 15.70x **cis** |
| read_messages p50 | µs | 1536.8 [1530.6-1584.1] | 57.0 [56.5-67.0] | 26.98x **cis** |
| read_messages p99 | µs | 4047.6 [3231.7-4560.5] | 1594.9 [1586.7-1641.9] | 2.54x **cis** |
| json_hunger mean | µs | 1690.5 [1642.5-1727.8] | 125.4 [114.3-128.6] | 13.48x **cis** |
| json_hunger p50 | µs | 1526.2 [1503.4-1557.2] | 68.8 [59.9-71.8] | 22.20x **cis** |
| json_hunger p99 | µs | 4298.5 [3755.5-4724.9] | 1608.9 [1547.2-1616.5] | 2.67x **cis** |
| in_list mean | µs | 1799.6 [1756.7-1820.5] | 241.3 [231.5-264.9] | 7.46x **cis** |
| in_list p50 | µs | 1581.5 [1562.1-1599.1] | 139.4 [135.9-149.7] | 11.34x **cis** |
| in_list p99 | µs | 4743.6 [4219.0-5751.5] | 2080.2 [1909.4-2385.5] | 2.28x **cis** |
| count_police mean | µs | 1799.7 [1642.8-1948.7] | 347.2 [327.1-362.3] | 5.18x **cis** |
| count_police p50 | µs | 1537.2 [1518.3-1548.4] | 230.9 [213.6-244.1] | 6.66x **cis** |
| count_police p99 | µs | 4275.4 [3801.1-5747.8] | 2093.0 [2055.8-2282.9] | 2.04x **cis** |
| richest mean | µs | 14992.9 [14504.8-15099.4] | 319.2 [286.4-353.4] | 46.97x **cis** |
| richest p50 | µs | 14651.0 [14272.5-14883.3] | 120.4 [101.9-126.3] | 121.71x **cis** |
| richest p99 | µs | 19540.1 [18320.1-20085.1] | 2033.1 [1599.6-4011.9] | 9.61x **cis** |
| save_player mean | µs | 2180.6 [2022.4-2221.2] | 2262.7 [2232.6-2320.8] | 0.96x ox |
| save_player p50 | µs | 1600.5 [1589.4-1628.3] | 1890.0 [1881.4-1911.3] | 0.85x ox |
| save_player p99 | µs | 5642.0 [5266.6-5978.4] | 7707.5 [6538.3-8212.3] | 0.73x ox |
| save_inventory mean | µs | 2039.5 [1960.2-2083.0] | 2119.3 [2049.0-2200.8] | 0.96x ox |
| save_inventory p50 | µs | 1588.5 [1582.4-1589.4] | 1797.3 [1794.2-1864.6] | 0.88x ox |
| save_inventory p99 | µs | 5562.7 [5016.9-6173.1] | 6245.7 [6011.4-7900.7] | 0.89x ox |
| send_message mean | µs | 1883.7 [1858.0-2025.0] | 1880.5 [1875.9-1983.1] | 1.00x **cis** |
| send_message p50 | µs | 1525.2 [1505.4-1529.5] | 1713.4 [1672.5-1770.2] | 0.89x ox |
| send_message p99 | µs | 5429.3 [5030.6-5567.6] | 4919.1 [4149.1-5436.5] | 1.10x **cis** |
| bank_transfer mean | µs | 7479.3 [7367.5-7664.9] | 2286.6 [2242.2-2296.7] | 3.27x **cis** |
| bank_transfer p50 | µs | 6849.9 [6796.3-6952.2] | 1947.0 [1937.0-1989.2] | 3.52x **cis** |
| bank_transfer p99 | µs | 13173.1 [12625.8-14363.1] | 6505.8 [6254.9-8356.9] | 2.02x **cis** |

## Live server, 64 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 227 [224-231] | 233 [233-234] | 1.02x **cis** |
| mean latency | µs | 7382.6 [6754.9-7961.2] | 974.8 [939.1-980.7] | 7.57x **cis** |
| p50 latency | µs | 6123.9 [5754.7-6315.7] | 140.9 [138.4-144.9] | 43.48x **cis** |
| p99 latency | µs | 24325.5 [19550.3-31351.6] | 7585.9 [6947.5-10460.8] | 3.21x **cis** |
| max latency | µs | 157534.3 [50304.0-233465.7] | 16650.8 [16104.8-17853.6] | 9.46x **cis** |
| long frames | frames | 1 [1-2] | 0 [0-0] | inf **cis** |
| worst frame | ms | 162.5 [81.3-223.1] | 57.5 [54.4-62.8] | 2.82x **cis** |
| time past the tick | ms | 95.6 [14.5-156.3] | 0.0 [0.0-0.0] | inf **cis** |

## Live server, 128 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 456 [448-457] | 465 [464-466] | 1.02x **cis** |
| mean latency | µs | 11052.9 [10846.3-11722.9] | 1260.2 [1186.9-1359.6] | 8.77x **cis** |
| p50 latency | µs | 9484.7 [8885.7-10088.7] | 126.8 [126.2-130.5] | 74.78x **cis** |
| p99 latency | µs | 34293.3 [28085.6-51229.3] | 11670.4 [9725.3-14211.8] | 2.94x **cis** |
| max latency | µs | 278981.6 [96775.1-305873.8] | 28355.6 [20796.2-31639.3] | 9.84x **cis** |
| long frames | frames | 3 [2-4] | 0 [0-0] | inf **cis** |
| worst frame | ms | 258.1 [100.6-319.4] | 59.4 [56.1-61.3] | 4.34x **cis** |
| time past the tick | ms | 281.3 [83.7-448.7] | 0.0 [0.0-0.0] | inf **cis** |

## Live server, 256 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 860 [851-873] | 915 [910-918] | 1.06x **cis** |
| mean latency | µs | 19371.5 [18157.3-20841.2] | 2313.6 [2100.7-2502.4] | 8.37x **cis** |
| p50 latency | µs | 15684.0 [14809.7-16209.0] | 125.0 [122.9-128.2] | 125.51x **cis** |
| p99 latency | µs | 94687.1 [76622.7-105805.2] | 16515.5 [15075.9-21234.1] | 5.73x **cis** |
| max latency | µs | 446245.3 [135157.0-599673.8] | 32839.8 [26397.1-40437.3] | 13.59x **cis** |
| long frames | frames | 8 [5-11] | 0 [0-0] | inf **cis** |
| worst frame | ms | 414.9 [130.2-571.7] | 58.5 [56.4-62.9] | 7.09x **cis** |
| time past the tick | ms | 523.1 [264.4-772.3] | 0.0 [0.0-0.0] | inf **cis** |

## Join storm (128 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all joined | ms | 495.4 [451.7-576.3] | 239.2 [190.5-243.5] | 2.07x **cis** |
| p99 join | µs | 428407.6 [392281.6-505275.9] | 153599.4 [122775.0-166051.5] | 2.79x **cis** |
| long frames | frames | 0 [0-1] | 0 [0-0] | inf |
| worst frame | ms | 65.7 [56.1-175.5] | 62.3 [61.6-64.6] | 1.05x **cis** |

## Save storm (256 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all saved | ms | 563.7 [514.0-571.9] | 356.4 [309.9-405.0] | 1.58x **cis** |
| p99 save | µs | 396086.4 [361443.1-471992.9] | 241739.5 [216128.5-276936.3] | 1.64x **cis** |
| long frames | frames | 0 [0-1] | 0 [0-0] | inf |
| worst frame | ms | 64.9 [55.4-112.4] | 62.3 [58.2-62.6] | 1.04x **cis** |

## Payday loop (5000 sequential updates)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| wall time | ms | 9613.2 [9299.6-9804.5] | 9966.0 [9714.4-10070.0] | 0.96x ox |
| worst frame | ms | 100.8 [86.7-193.1] | 57.2 [56.4-59.3] | 1.76x **cis** |

## Saturation (32 threads, 10 s)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 2088 [2012-2158] | 5236 [5172-5479] | 2.51x **cis** |
| worst frame | ms | 156.7 [123.6-352.4] | 66.4 [59.3-91.7] | 2.36x **cis** |

## Bulk import

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| 20k players + 40k vehicles | ms | 5814 [5652-5910] | 8051 [7912-8854] | 0.72x ox |

## Idle server

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| tick | ms | 50.1 [50.1-50.1] | 50.1 [50.1-50.1] | 1.00x **cis** |

## FXServer hitch warnings (whole boot, startup included)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| warnings | count | 6 [1-13] | 1 [1-3] | 6.00x **cis** |
| longest | ms | 399 [156-556] | 446 [427-532] | 0.89x ox |

## CPU for the measured workload

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| FXServer | s | 53.94 [53.55-54.76] | 37.86 [37.04-38.04] | 1.42x **cis** |
| MariaDB | s | 30.31 [29.19-31.11] | 7.39 [6.96-7.54] | 4.10x **cis** |

## How it was measured

- Latency is the time around each `MySQL.*.await` call in the calling Lua thread (os.nanotime), so it includes the driver's Lua library, the export call and the wait for the answer.
- A long frame is a server tick more than 16.7 ms (one 60 Hz frame) past this boot's idle tick, measured by a `Wait(0)` thread. "Time past the tick" adds up how far those frames ran over.
- Live server: N threads each act as a player making 60 calls picked from an 80/20 read/write mix (player load, vehicles, inventory, messages, bank log, police count; saves, inventory saves, bank transfers in a transaction, messages, vehicle updates) with random think time.
- Writes are deterministic, so every driver and every run must end with the same data; the checksums above check that, and check MariaDB itself through the mysql CLI.
- Hitch warnings are FXServer's own `server thread hitch warning` console lines, counted over each boot's whole log (resource start and seed included).
- CPU is FXServer plus mariadbd process time from the idle measurement to the end of the workloads.
- Rerun on the server box, as root, from a checkout of this repository: `bash bench/run_bench.sh 5`.
