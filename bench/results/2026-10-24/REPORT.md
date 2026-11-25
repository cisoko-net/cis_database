# cis_database vs oxmysql: real-server benchmark

Same server, same resources, same Lua (`bench/cis_bench`), one driver per boot, 5 rounds each, driver order alternating every round. Medians across rounds, range in brackets.

| | |
|---|---|
| date | 2026-10-24T20:07:57+03:00 |
| cpu | AMD EPYC 7302 16-Core Processor |
| cores | 6 |
| ram | 16 GiB |
| os | Ubuntu 24.04.5 LTS |
| fxserver | build 35245 |
| server | Qbox, its whole server.cfg |
| mariadb | mysql  Ver 15.1 Distrib 10.11.14-MariaDB, for debian-linux-gnu (x86_64) using  EditLine wrapper |
| oxmysql | 2.14.3 (package ?) |
| cis_database | pre-release build 2c51f67 |
| cis_database frame budget | 25 ms (config.json frameBudgetMs) |
| rounds | 5 (rounds 1-4 from 2026-10-24T20:07:57+03:00; round 5 from 2026-10-24T23:40:56+03:00 with the same build, server and config) |
| scale | 1 |

**cis_database is better on 66 of 78 metrics.**

oxmysql is better on: Single call (one thread, .await) / save_player p50, Single call (one thread, .await) / save_player p99, Single call (one thread, .await) / save_inventory mean, Single call (one thread, .await) / save_inventory p50, Single call (one thread, .await) / save_inventory p99, Single call (one thread, .await) / send_message mean, Single call (one thread, .await) / send_message p50, Single call (one thread, .await) / send_message p99, Payday loop (5000 sequential updates) / wall time, Bulk import / 20k players + 40k vehicles, Idle server / tick.

Data check: 1 distinct final checksum across all 10 runs of both drivers (1 means every run ended with identical data). cis_database's MariaDB copy matched what it served in 5 of 5 runs; oxmysql's MariaDB matched in 5 of 5. Errors per run: oxmysql [0, 0, 0, 0, 0], cis_database [0, 0, 0, 0, 0].

cis_database confirms a write once it is in its SQLite file (WAL, crash-safe) and copies it to MariaDB behind; oxmysql confirms once MariaDB has it. After the last workload, cis_database's MariaDB copy was complete within 638 ms (median).

## Single call (one thread, .await)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| read_player mean | µs | 1904.6 [1881.8-2010.1] | 239.6 [237.7-264.3] | 7.95x **cis** |
| read_player p50 | µs | 1640.5 [1625.5-1654.7] | 100.5 [100.0-109.4] | 16.32x **cis** |
| read_player p99 | µs | 6939.3 [6618.6-7361.8] | 2994.8 [2186.7-3517.4] | 2.32x **cis** |
| read_by_license mean | µs | 1716.2 [1688.6-1720.9] | 185.1 [156.5-204.8] | 9.27x **cis** |
| read_by_license p50 | µs | 1551.0 [1540.1-1576.5] | 81.9 [67.5-84.6] | 18.94x **cis** |
| read_by_license p99 | µs | 4399.8 [3926.0-4544.3] | 1696.6 [1558.0-2006.7] | 2.59x **cis** |
| read_vehicles mean | µs | 1758.9 [1718.9-1760.6] | 200.0 [183.7-208.7] | 8.79x **cis** |
| read_vehicles p50 | µs | 1585.7 [1578.4-1598.4] | 87.8 [84.6-89.2] | 18.05x **cis** |
| read_vehicles p99 | µs | 4546.0 [4009.4-4713.2] | 1716.6 [1563.9-1795.7] | 2.65x **cis** |
| read_messages mean | µs | 1724.8 [1693.9-1785.9] | 125.6 [119.3-130.8] | 13.73x **cis** |
| read_messages p50 | µs | 1549.7 [1531.2-1579.9] | 53.4 [51.8-54.0] | 29.04x **cis** |
| read_messages p99 | µs | 4306.4 [4091.8-4788.1] | 1557.3 [1484.4-1585.1] | 2.77x **cis** |
| json_hunger mean | µs | 1707.4 [1655.5-1841.4] | 176.8 [157.4-198.1] | 9.66x **cis** |
| json_hunger p50 | µs | 1522.4 [1496.3-1536.2] | 70.6 [63.0-75.2] | 21.58x **cis** |
| json_hunger p99 | µs | 4537.1 [4038.3-5583.6] | 1718.4 [1580.0-1809.6] | 2.64x **cis** |
| in_list mean | µs | 1793.3 [1769.7-1857.8] | 304.7 [291.4-328.1] | 5.88x **cis** |
| in_list p50 | µs | 1576.0 [1573.2-1590.6] | 132.0 [128.9-137.8] | 11.94x **cis** |
| in_list p99 | µs | 5409.7 [4799.1-7025.4] | 3283.6 [2065.3-6314.2] | 1.65x **cis** |
| count_police mean | µs | 1759.9 [1655.9-1853.8] | 457.5 [435.4-512.1] | 3.85x **cis** |
| count_police p50 | µs | 1520.1 [1508.0-1558.2] | 227.8 [220.9-239.1] | 6.67x **cis** |
| count_police p99 | µs | 4446.3 [3730.5-4634.9] | 2202.9 [2111.4-3040.0] | 2.02x **cis** |
| richest mean | µs | 13994.2 [13258.3-14139.9] | 430.0 [426.0-446.7] | 32.54x **cis** |
| richest p50 | µs | 13431.6 [13184.1-14065.3] | 113.4 [110.3-119.8] | 118.41x **cis** |
| richest p99 | µs | 18408.7 [16753.7-19022.8] | 3907.2 [1759.8-11918.0] | 4.71x **cis** |
| save_player mean | µs | 2334.2 [2200.5-2729.2] | 2239.7 [2196.2-2256.0] | 1.04x **cis** |
| save_player p50 | µs | 1650.4 [1638.8-2638.3] | 1906.3 [1902.0-1942.3] | 0.87x ox |
| save_player p99 | µs | 6648.9 [5955.0-6787.0] | 6763.1 [6537.1-6943.3] | 0.98x ox |
| save_inventory mean | µs | 2138.5 [2096.1-2593.0] | 2238.0 [2220.2-2269.4] | 0.96x ox |
| save_inventory p50 | µs | 1630.3 [1612.8-2537.1] | 1873.8 [1846.4-1881.1] | 0.87x ox |
| save_inventory p99 | µs | 6126.1 [5712.9-7303.0] | 7561.3 [7183.2-8051.2] | 0.81x ox |
| send_message mean | µs | 1956.3 [1900.0-1983.2] | 2088.1 [1930.6-2170.1] | 0.94x ox |
| send_message p50 | µs | 1529.7 [1512.7-1555.0] | 1767.8 [1718.7-1829.4] | 0.87x ox |
| send_message p99 | µs | 5938.7 [5567.4-6816.4] | 6186.2 [5227.4-7767.7] | 0.96x ox |
| bank_transfer mean | µs | 7612.2 [7448.9-7642.4] | 2269.3 [2173.0-2397.2] | 3.35x **cis** |
| bank_transfer p50 | µs | 6911.8 [6883.5-7035.7] | 1956.3 [1910.4-2034.6] | 3.53x **cis** |
| bank_transfer p99 | µs | 13910.2 [12854.0-15572.8] | 7206.3 [6559.7-7531.9] | 1.93x **cis** |

## Live server, 64 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 226 [224-229] | 233 [232-234] | 1.03x **cis** |
| mean latency | µs | 7754.8 [7241.0-8697.7] | 1001.9 [966.4-1085.7] | 7.74x **cis** |
| p50 latency | µs | 6334.1 [6025.3-7160.3] | 145.1 [140.9-152.0] | 43.66x **cis** |
| p99 latency | µs | 26404.2 [18591.3-30731.9] | 8572.4 [7967.9-11357.6] | 3.08x **cis** |
| max latency | µs | 168460.6 [79679.6-269965.9] | 20294.6 [15990.5-24502.0] | 8.30x **cis** |
| long frames | frames | 1 [1-2] | 0 [0-0] | inf **cis** |
| worst frame | ms | 186.1 [95.0-250.1] | 57.7 [55.6-59.5] | 3.23x **cis** |
| time past the tick | ms | 120.2 [28.1-183.3] | 0.0 [0.0-0.0] | inf **cis** |

## Live server, 128 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 451 [446-456] | 466 [465-466] | 1.03x **cis** |
| mean latency | µs | 12452.5 [11224.0-13231.6] | 1302.6 [1287.2-1492.6] | 9.56x **cis** |
| p50 latency | µs | 10093.5 [9465.1-10645.5] | 128.3 [124.0-137.0] | 78.65x **cis** |
| p99 latency | µs | 44031.2 [36936.7-68719.7] | 12812.6 [11265.9-15988.2] | 3.44x **cis** |
| max latency | µs | 317340.2 [118162.5-452241.8] | 29530.4 [24544.5-40409.4] | 10.75x **cis** |
| long frames | frames | 3 [2-9] | 0 [0-1] | inf **cis** |
| worst frame | ms | 305.8 [105.2-458.4] | 57.7 [55.9-70.7] | 5.30x **cis** |
| time past the tick | ms | 316.6 [84.1-588.3] | 0.0 [0.0-3.8] | inf **cis** |

## Live server, 256 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 857 [850-867] | 918 [912-921] | 1.07x **cis** |
| mean latency | µs | 20752.6 [18359.0-21577.2] | 2396.0 [2263.9-2745.0] | 8.66x **cis** |
| p50 latency | µs | 16263.4 [15406.0-17383.3] | 127.9 [124.0-134.8] | 127.15x **cis** |
| p99 latency | µs | 82081.1 [71543.9-121810.2] | 17855.3 [17273.1-20836.6] | 4.60x **cis** |
| max latency | µs | 167003.2 [135170.1-526589.4] | 30941.2 [28412.8-36246.3] | 5.40x **cis** |
| long frames | frames | 11 [7-13] | 0 [0-0] | inf **cis** |
| worst frame | ms | 157.1 [126.6-504.4] | 57.5 [56.7-57.9] | 2.73x **cis** |
| time past the tick | ms | 329.6 [287.6-772.4] | 0.0 [0.0-0.0] | inf **cis** |

## Join storm (128 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all joined | ms | 515.3 [500.3-636.1] | 286.1 [285.8-289.6] | 1.80x **cis** |
| p99 join | µs | 461460.2 [415698.7-578341.3] | 203366.6 [192139.7-208537.4] | 2.27x **cis** |
| long frames | frames | 0 [0-1] | 0 [0-0] | inf |
| worst frame | ms | 64.0 [58.3-183.4] | 54.0 [53.7-58.3] | 1.18x **cis** |

## Save storm (256 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all saved | ms | 635.2 [506.2-680.5] | 449.1 [410.2-468.1] | 1.41x **cis** |
| p99 save | µs | 524807.6 [393231.9-555355.3] | 325742.8 [322051.4-370380.2] | 1.61x **cis** |
| long frames | frames | 1 [0-1] | 0 [0-1] | inf **cis** |
| worst frame | ms | 70.5 [53.8-204.8] | 62.0 [57.4-74.4] | 1.14x **cis** |

## Payday loop (5000 sequential updates)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| wall time | ms | 9853.5 [9510.2-10163.9] | 10435.1 [9953.1-10555.4] | 0.94x ox |
| worst frame | ms | 128.4 [93.3-244.8] | 55.7 [54.7-62.6] | 2.30x **cis** |

## Saturation (32 threads, 10 s)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 2073 [1982-2082] | 3580 [3466-3772] | 1.73x **cis** |
| worst frame | ms | 183.9 [134.6-430.2] | 57.0 [56.5-63.1] | 3.23x **cis** |

## Bulk import

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| 20k players + 40k vehicles | ms | 6040 [5928-6163] | 9945 [9659-10186] | 0.61x ox |

## Idle server

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| tick | ms | 50.1 [50.1-50.2] | 50.2 [50.1-50.2] | 1.00x ox |

## FXServer hitch warnings (whole boot, startup included)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| warnings | count | 10 [1-15] | 4 [3-4] | 2.50x **cis** |
| longest | ms | 1374 [1304-1426] | 1298 [1269-1389] | 1.06x **cis** |

## CPU for the measured workload

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| FXServer | s | 55.91 [55.34-56.95] | 37.14 [35.88-38.89] | 1.51x **cis** |
| MariaDB | s | 30.00 [29.72-30.87] | 7.64 [6.77-7.70] | 3.93x **cis** |

## How it was measured

- Latency is the time around each `MySQL.*.await` call in the calling Lua thread (os.nanotime), so it includes the driver's Lua library, the export call and the wait for the answer.
- A long frame is a server tick more than 16.7 ms (one 60 Hz frame) past this boot's idle tick, measured by a `Wait(0)` thread. "Time past the tick" adds up how far those frames ran over.
- Live server: N threads each act as a player making 60 calls picked from an 80/20 read/write mix (player load, vehicles, inventory, messages, bank log, police count; saves, inventory saves, bank transfers in a transaction, messages, vehicle updates) with random think time.
- Writes are deterministic, so every driver and every run must end with the same data; the checksums above check that, and check MariaDB itself through the mysql CLI.
- Hitch warnings are FXServer's own `server thread hitch warning` console lines, counted over each boot's whole log (resource start and seed included).
- CPU is FXServer plus mariadbd process time from the idle measurement to the end of the workloads.
- Rerun on the server box, as root, from a checkout of this repository: `bash bench/run_bench.sh 5`.
