# cis_database vs oxmysql: real-server benchmark

Same server, same resources, same Lua (`bench/cis_bench`), one driver per boot, 5 rounds each, driver order alternating every round. Medians across rounds, range in brackets.

| | |
|---|---|
| date | 2026-10-28T08:51:21+03:00 |
| cpu | AMD EPYC 7302 16-Core Processor |
| cores | 6 |
| ram | 16 GiB |
| os | Ubuntu 24.04.5 LTS |
| fxserver | build 35245 |
| server | Qbox, its whole server.cfg |
| mariadb | server 10.11.14-MariaDB-0ubuntu0.24.04.1-log, client mysql  Ver 15.1 Distrib 10.11.14-MariaDB, for debian-linux-gnu (x86_64) using  EditLine wrapper |
| oxmysql | 2.14.3 (package ?) |
| cis_database | 1.0.0-beta.2 build 9e226f1 |
| cis_database frame budget | 20 ms (BENCH_FRAME_MS, convar cis_database_frame_ms) |
| cis_database write ack | power (default: answered after an fdatasync of the WAL) |
| bench scripts | ? (modified) |
| rounds | 5 |
| scale | 1 |
| reproduce | BENCH_DATA=<server data folder> BENCH_SERVER=qbox BENCH_DB=qbox BENCH_FXROOT=<FXServer folder> BENCH_FRAME_MS=20 bash bench/run_bench.sh 5 1 |

**cis_database is better on 55 of 78 metrics.**

oxmysql is better on: Single call (one thread, .await) / read_player p99, Single call (one thread, .await) / read_vehicles mean, Single call (one thread, .await) / read_vehicles p99, Single call (one thread, .await) / json_hunger mean, Single call (one thread, .await) / json_hunger p99, Single call (one thread, .await) / in_list p99, Single call (one thread, .await) / count_police p99, Single call (one thread, .await) / save_player p50, Single call (one thread, .await) / save_player p99, Single call (one thread, .await) / save_inventory mean, Single call (one thread, .await) / save_inventory p50, Single call (one thread, .await) / save_inventory p99, Single call (one thread, .await) / send_message mean, Single call (one thread, .await) / send_message p50, Single call (one thread, .await) / send_message p99, Save storm (256 players at once) / all saved, Save storm (256 players at once) / p99 save, Payday loop (5000 sequential updates) / wall time, Bulk import / 20k players + 40k vehicles, Idle server / tick, FXServer hitch warnings (whole boot, startup included) / warnings, FXServer hitch warnings (whole boot, startup included) / longest.

Data check: 1 distinct final checksum across all 10 runs of both drivers (1 means every run ended with identical data). cis_database's MariaDB copy matched what it served in 5 of 5 runs; oxmysql's MariaDB matched in 5 of 5. Errors per run: oxmysql [0, 0, 0, 0, 0], cis_database [0, 0, 0, 0, 0].

cis_database confirms a write once an fdatasync of its SQLite WAL covers it (the default `cis_database_ack power`; see env.txt) and copies it to MariaDB behind; oxmysql confirms once MariaDB has committed it. After the last workload, cis_database's MariaDB copy was complete within 132 ms (median).

## Single call (one thread, .await)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| read_player mean | µs | 1870.0 [1829.3-1915.0] | 363.5 [316.8-387.8] | 5.14x **cis** |
| read_player p50 | µs | 1620.3 [1614.7-1649.8] | 119.3 [107.1-130.1] | 13.59x **cis** |
| read_player p99 | µs | 6815.3 [6257.3-7291.2] | 7499.2 [5516.6-8629.1] | 0.91x ox |
| read_by_license mean | µs | 1691.5 [1643.5-1695.7] | 287.9 [267.5-320.7] | 5.88x **cis** |
| read_by_license p50 | µs | 1543.1 [1532.9-1564.1] | 89.2 [78.0-96.3] | 17.30x **cis** |
| read_by_license p99 | µs | 3830.0 [3510.3-4527.4] | 2309.6 [1635.7-3951.2] | 1.66x **cis** |
| read_vehicles mean | µs | 1715.6 [1688.8-1765.8] | 2029.0 [1975.4-2045.4] | 0.85x ox |
| read_vehicles p50 | µs | 1575.9 [1564.2-1579.4] | 1553.7 [1536.4-1562.4] | 1.01x **cis** |
| read_vehicles p99 | µs | 4266.3 [3623.4-4580.9] | 7902.9 [7571.1-8135.7] | 0.54x ox |
| read_messages mean | µs | 1711.1 [1651.8-1788.9] | 226.5 [205.2-238.0] | 7.56x **cis** |
| read_messages p50 | µs | 1542.8 [1509.5-1553.4] | 76.5 [70.7-82.2] | 20.18x **cis** |
| read_messages p99 | µs | 4113.2 [3930.5-4559.1] | 1909.2 [1628.5-2114.1] | 2.15x **cis** |
| json_hunger mean | µs | 1705.4 [1695.6-1737.4] | 1852.4 [1791.2-1945.1] | 0.92x ox |
| json_hunger p50 | µs | 1522.0 [1510.8-1536.4] | 1478.7 [1471.5-1509.0] | 1.03x **cis** |
| json_hunger p99 | µs | 4523.6 [4238.3-4743.8] | 7309.7 [7235.3-8099.2] | 0.62x ox |
| in_list mean | µs | 1788.0 [1746.9-1819.2] | 461.8 [411.9-480.9] | 3.87x **cis** |
| in_list p50 | µs | 1565.8 [1548.9-1572.4] | 157.5 [149.5-163.5] | 9.94x **cis** |
| in_list p99 | µs | 5056.7 [4924.5-5398.0] | 7608.6 [6897.6-8739.6] | 0.66x ox |
| count_police mean | µs | 1705.9 [1597.4-1756.6] | 619.4 [615.5-632.7] | 2.75x **cis** |
| count_police p50 | µs | 1521.7 [1502.9-1560.3] | 234.9 [232.2-246.8] | 6.48x **cis** |
| count_police p99 | µs | 3328.0 [2708.3-4315.8] | 23258.9 [22372.9-24154.6] | 0.14x ox |
| richest mean | µs | 14161.3 [14030.2-15360.3] | 585.5 [505.8-682.8] | 24.19x **cis** |
| richest p50 | µs | 14009.3 [13975.2-15330.0] | 114.3 [108.4-143.6] | 122.55x **cis** |
| richest p99 | µs | 19479.0 [18367.3-20868.8] | 11686.6 [7391.8-13919.8] | 1.67x **cis** |
| save_player mean | µs | 2245.6 [2108.8-2324.7] | 2231.6 [2175.1-2295.6] | 1.01x **cis** |
| save_player p50 | µs | 1621.6 [1600.8-1653.5] | 1870.7 [1831.5-1918.5] | 0.87x ox |
| save_player p99 | µs | 6213.6 [5918.6-6550.9] | 6554.6 [6282.0-7285.6] | 0.95x ox |
| save_inventory mean | µs | 2094.3 [2031.7-2117.5] | 2169.8 [2081.9-2265.7] | 0.97x ox |
| save_inventory p50 | µs | 1602.4 [1582.4-1608.8] | 1841.1 [1798.6-1863.7] | 0.87x ox |
| save_inventory p99 | µs | 5551.2 [4974.2-6813.5] | 6071.1 [5433.7-7088.2] | 0.91x ox |
| send_message mean | µs | 1874.1 [1775.1-2007.3] | 2041.8 [2011.4-2077.8] | 0.92x ox |
| send_message p50 | µs | 1520.0 [1512.6-1538.5] | 1730.4 [1722.0-1733.9] | 0.88x ox |
| send_message p99 | µs | 5481.5 [4875.4-5753.7] | 6228.4 [5525.5-7272.2] | 0.88x ox |
| bank_transfer mean | µs | 7465.4 [7380.2-7557.7] | 2475.2 [2395.0-2574.2] | 3.02x **cis** |
| bank_transfer p50 | µs | 6805.1 [6764.0-6881.6] | 2060.1 [2012.6-2150.3] | 3.30x **cis** |
| bank_transfer p99 | µs | 13284.8 [12886.8-13854.9] | 7602.1 [6508.5-9789.6] | 1.75x **cis** |

## Live server, 64 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 226 [225-230] | 232 [230-232] | 1.02x **cis** |
| mean latency | µs | 7637.0 [7224.6-7992.6] | 2158.8 [2108.6-2277.7] | 3.54x **cis** |
| p50 latency | µs | 6279.4 [6164.9-6664.8] | 205.4 [196.0-225.2] | 30.56x **cis** |
| p99 latency | µs | 24375.7 [22903.0-49329.5] | 15614.6 [13797.3-15879.1] | 1.56x **cis** |
| max latency | µs | 94137.8 [63414.2-275903.9] | 55575.0 [52235.1-65709.5] | 1.69x **cis** |
| long frames | frames | 2 [1-3] | 0 [0-0] | inf **cis** |
| worst frame | ms | 109.1 [67.1-259.7] | 55.5 [54.8-57.5] | 1.97x **cis** |
| time past the tick | ms | 62.7 [0.3-219.2] | 0.0 [0.0-0.0] | inf **cis** |

## Live server, 128 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 454 [453-461] | 463 [463-464] | 1.02x **cis** |
| mean latency | µs | 11489.0 [10719.9-12062.1] | 2989.4 [2956.5-3134.7] | 3.84x **cis** |
| p50 latency | µs | 9923.9 [9131.3-10341.1] | 169.3 [167.4-170.4] | 58.63x **cis** |
| p99 latency | µs | 44802.1 [32142.5-51656.7] | 20964.2 [19890.8-23043.2] | 2.14x **cis** |
| max latency | µs | 115248.3 [86843.1-158165.2] | 61305.8 [57942.2-62034.4] | 1.88x **cis** |
| long frames | frames | 5 [2-6] | 0 [0-0] | inf **cis** |
| worst frame | ms | 107.2 [88.4-161.4] | 56.3 [54.9-59.0] | 1.90x **cis** |
| time past the tick | ms | 124.9 [35.9-280.2] | 0.0 [0.0-0.0] | inf **cis** |

## Live server, 256 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 870 [857-882] | 907 [899-913] | 1.04x **cis** |
| mean latency | µs | 18361.4 [16653.1-19160.1] | 5527.2 [5068.7-5731.4] | 3.32x **cis** |
| p50 latency | µs | 15361.7 [14440.4-15881.0] | 268.8 [218.1-287.8] | 57.15x **cis** |
| p99 latency | µs | 76302.8 [66646.2-88288.1] | 28674.3 [27712.7-32076.0] | 2.66x **cis** |
| max latency | µs | 151832.3 [106308.4-320893.3] | 70454.8 [65923.4-89055.6] | 2.16x **cis** |
| long frames | frames | 9 [4-10] | 0 [0-0] | inf **cis** |
| worst frame | ms | 131.5 [127.6-321.2] | 58.8 [56.7-62.5] | 2.24x **cis** |
| time past the tick | ms | 292.4 [183.7-720.7] | 0.0 [0.0-0.0] | inf **cis** |

## Join storm (128 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all joined | ms | 505.3 [451.7-572.1] | 336.8 [335.6-361.1] | 1.50x **cis** |
| p99 join | µs | 434484.5 [372815.2-496851.0] | 250660.9 [238531.0-276053.9] | 1.73x **cis** |
| long frames | frames | 0 [0-2] | 0 [0-0] | inf |
| worst frame | ms | 65.9 [64.8-120.8] | 58.3 [55.4-64.8] | 1.13x **cis** |

## Save storm (256 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all saved | ms | 548.2 [520.2-863.3] | 560.7 [504.8-602.1] | 0.98x ox |
| p99 save | µs | 420838.4 [397245.9-737101.9] | 442269.7 [438916.0-501248.9] | 0.95x ox |
| long frames | frames | 1 [0-2] | 0 [0-1] | inf **cis** |
| worst frame | ms | 88.7 [64.7-357.4] | 55.3 [54.0-69.0] | 1.60x **cis** |

## Payday loop (5000 sequential updates)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| wall time | ms | 9527.0 [9299.9-9860.5] | 10112.7 [9739.2-10638.2] | 0.94x ox |
| worst frame | ms | 87.5 [58.0-126.8] | 57.8 [57.4-62.4] | 1.51x **cis** |

## Saturation (32 threads, 10 s)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 2017 [1947-2105] | 2608 [2373-2664] | 1.29x **cis** |
| worst frame | ms | 146.0 [133.4-542.0] | 62.4 [55.8-87.8] | 2.34x **cis** |

## Bulk import

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| 20k players + 40k vehicles | ms | 6176 [6011-6523] | 10373 [10067-10571] | 0.60x ox |

## Idle server

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| tick | ms | 50.1 [50.1-50.2] | 50.1 [50.1-50.2] | 1.00x ox |

## FXServer hitch warnings (whole boot, startup included)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| warnings | count | 4 [0-13] | 14 [11-15] | 0.29x ox |
| longest | ms | 256 [0-542] | 364 [299-369] | 0.70x ox |

## CPU for the measured workload

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| FXServer | s | 53.85 [53.02-54.63] | 44.99 [44.10-45.45] | 1.20x **cis** |
| MariaDB | s | 30.34 [29.50-31.53] | 12.69 [11.95-12.83] | 2.39x **cis** |

## How it was measured

- Latency is the time around each `MySQL.*.await` call in the calling Lua thread (os.nanotime), so it includes the driver's Lua library, the export call and the wait for the answer.
- A long frame is a server tick more than 16.7 ms (one 60 Hz frame) past this boot's idle tick, measured by a `Wait(0)` thread. "Time past the tick" adds up how far those frames ran over.
- Live server: N threads each act as a player making 60 calls picked from an 80/20 read/write mix (player load, vehicles, inventory, messages, bank log, police count; saves, inventory saves, bank transfers in a transaction, messages, vehicle updates) with random think time.
- Writes are deterministic, so every driver and every run must end with the same data; the checksums above check that, and check MariaDB itself through the mysql CLI.
- Hitch warnings are FXServer's own `server thread hitch warning` console lines, counted over each boot's whole log (resource start and seed included).
- CPU is FXServer plus mariadbd process time from the idle measurement to the end of the workloads.
- Rerun on the server box, as root, from a checkout of this repository: `bash bench/run_bench.sh 5`.
