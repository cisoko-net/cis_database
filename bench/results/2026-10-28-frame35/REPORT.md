# cis_database vs oxmysql: real-server benchmark

Same server, same resources, same Lua (`bench/cis_bench`), one driver per boot, 5 rounds each, driver order alternating every round. Medians across rounds, range in brackets.

| | |
|---|---|
| date | 2026-10-28T09:18:11+03:00 |
| cpu | AMD EPYC 7302 16-Core Processor |
| cores | 6 |
| ram | 16 GiB |
| os | Ubuntu 24.04.5 LTS |
| fxserver | build 35245 |
| server | Qbox, its whole server.cfg |
| mariadb | server 10.11.14-MariaDB-0ubuntu0.24.04.1-log, client mysql  Ver 15.1 Distrib 10.11.14-MariaDB, for debian-linux-gnu (x86_64) using  EditLine wrapper |
| oxmysql | 2.14.3 (package ?) |
| cis_database | 1.0.0-beta.2 build 9e226f1 |
| cis_database frame budget | 35 ms (BENCH_FRAME_MS, convar cis_database_frame_ms) |
| cis_database write ack | power (default: answered after an fdatasync of the WAL) |
| bench scripts | ? (modified) |
| rounds | 5 |
| scale | 1 |
| reproduce | BENCH_DATA=<server data folder> BENCH_SERVER=qbox BENCH_DB=qbox BENCH_FXROOT=<FXServer folder> BENCH_FRAME_MS=35 bash bench/run_bench.sh 5 1 |

**cis_database is better on 61 of 78 metrics.**

oxmysql is better on: Single call (one thread, .await) / read_vehicles mean, Single call (one thread, .await) / read_vehicles p99, Single call (one thread, .await) / json_hunger mean, Single call (one thread, .await) / json_hunger p99, Single call (one thread, .await) / save_player mean, Single call (one thread, .await) / save_player p50, Single call (one thread, .await) / save_player p99, Single call (one thread, .await) / save_inventory mean, Single call (one thread, .await) / save_inventory p50, Single call (one thread, .await) / send_message mean, Single call (one thread, .await) / send_message p50, Single call (one thread, .await) / send_message p99, Payday loop (5000 sequential updates) / wall time, Bulk import / 20k players + 40k vehicles, Idle server / tick, FXServer hitch warnings (whole boot, startup included) / warnings, FXServer hitch warnings (whole boot, startup included) / longest.

Data check: 1 distinct final checksum across all 10 runs of both drivers (1 means every run ended with identical data). cis_database's MariaDB copy matched what it served in 5 of 5 runs; oxmysql's MariaDB matched in 5 of 5. Errors per run: oxmysql [0, 0, 0, 0, 0], cis_database [0, 0, 0, 0, 0].

cis_database confirms a write once an fdatasync of its SQLite WAL covers it (the default `cis_database_ack power`; see env.txt) and copies it to MariaDB behind; oxmysql confirms once MariaDB has committed it. After the last workload, cis_database's MariaDB copy was complete within 0 ms (median).

## Single call (one thread, .await)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| read_player mean | µs | 1893.3 [1825.9-2000.3] | 263.2 [239.8-285.9] | 7.19x **cis** |
| read_player p50 | µs | 1638.0 [1608.4-1659.8] | 119.8 [113.8-123.2] | 13.68x **cis** |
| read_player p99 | µs | 6850.4 [6464.4-8279.1] | 3882.4 [3197.2-5451.3] | 1.76x **cis** |
| read_by_license mean | µs | 1715.6 [1682.5-1735.8] | 157.4 [145.0-174.4] | 10.90x **cis** |
| read_by_license p50 | µs | 1577.2 [1549.3-1587.8] | 81.1 [77.4-87.5] | 19.45x **cis** |
| read_by_license p99 | µs | 4189.3 [3306.2-4598.8] | 1700.7 [1601.9-1936.5] | 2.46x **cis** |
| read_vehicles mean | µs | 1796.0 [1723.2-1816.8] | 2025.4 [1889.2-2037.8] | 0.89x ox |
| read_vehicles p50 | µs | 1591.0 [1562.8-1626.7] | 1590.9 [1583.4-1610.0] | 1.00x **cis** |
| read_vehicles p99 | µs | 4554.4 [3587.2-5037.9] | 7360.3 [6309.7-8682.9] | 0.62x ox |
| read_messages mean | µs | 1754.1 [1662.4-1779.0] | 137.4 [122.9-159.8] | 12.77x **cis** |
| read_messages p50 | µs | 1544.0 [1532.3-1610.2] | 73.6 [69.8-80.0] | 20.99x **cis** |
| read_messages p99 | µs | 4115.3 [3572.3-4828.0] | 1568.2 [1525.9-1913.4] | 2.62x **cis** |
| json_hunger mean | µs | 1720.6 [1618.6-1721.8] | 1820.0 [1779.3-1966.7] | 0.95x ox |
| json_hunger p50 | µs | 1527.1 [1521.1-1531.0] | 1511.1 [1488.8-1519.2] | 1.01x **cis** |
| json_hunger p99 | µs | 4339.9 [2665.0-4468.6] | 6168.6 [5941.1-7863.2] | 0.70x ox |
| in_list mean | µs | 1753.7 [1732.8-1819.8] | 290.2 [262.6-312.9] | 6.04x **cis** |
| in_list p50 | µs | 1565.3 [1555.3-1579.4] | 154.8 [151.6-171.6] | 10.11x **cis** |
| in_list p99 | µs | 4774.1 [3785.0-5516.1] | 2465.3 [2117.4-3737.7] | 1.94x **cis** |
| count_police mean | µs | 1724.8 [1696.7-1972.3] | 355.2 [314.3-386.3] | 4.86x **cis** |
| count_police p50 | µs | 1548.3 [1494.0-1552.3] | 231.1 [215.4-257.9] | 6.70x **cis** |
| count_police p99 | µs | 4362.0 [3332.3-5679.3] | 1931.0 [1742.6-2130.2] | 2.26x **cis** |
| richest mean | µs | 14794.3 [14716.6-15535.0] | 402.4 [340.3-480.1] | 36.76x **cis** |
| richest p50 | µs | 14585.0 [14543.7-15646.8] | 123.5 [115.0-131.8] | 118.11x **cis** |
| richest p99 | µs | 20091.9 [19033.4-20703.5] | 6244.3 [3078.1-8124.6] | 3.22x **cis** |
| save_player mean | µs | 2204.2 [2191.3-2297.2] | 2236.6 [2200.7-2356.6] | 0.99x ox |
| save_player p50 | µs | 1618.0 [1601.1-1638.5] | 1894.9 [1847.4-1942.7] | 0.85x ox |
| save_player p99 | µs | 6194.1 [5339.2-6330.3] | 6673.3 [6285.5-7525.6] | 0.93x ox |
| save_inventory mean | µs | 2130.9 [2078.3-2154.3] | 2178.8 [2117.5-2372.9] | 0.98x ox |
| save_inventory p50 | µs | 1602.6 [1597.3-1613.3] | 1867.4 [1814.0-1953.5] | 0.86x ox |
| save_inventory p99 | µs | 6211.0 [5429.9-6373.1] | 6136.1 [5852.2-7785.5] | 1.01x **cis** |
| send_message mean | µs | 1905.6 [1778.0-2021.7] | 2044.8 [1995.5-2096.5] | 0.93x ox |
| send_message p50 | µs | 1524.8 [1511.9-1561.2] | 1759.0 [1733.4-1786.5] | 0.87x ox |
| send_message p99 | µs | 5642.8 [4805.6-6244.6] | 6015.1 [5700.5-6291.0] | 0.94x ox |
| bank_transfer mean | µs | 7496.5 [7464.5-7840.9] | 2375.0 [2334.2-2536.5] | 3.16x **cis** |
| bank_transfer p50 | µs | 6853.3 [6813.1-7028.7] | 2030.2 [1989.0-2097.5] | 3.38x **cis** |
| bank_transfer p99 | µs | 13944.2 [12611.4-15117.6] | 6997.6 [6526.3-8711.2] | 1.99x **cis** |

## Live server, 64 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 227 [225-229] | 232 [231-233] | 1.02x **cis** |
| mean latency | µs | 7879.8 [7311.9-8150.1] | 2576.1 [2463.8-2687.4] | 3.06x **cis** |
| p50 latency | µs | 6601.0 [6245.2-6748.9] | 214.3 [212.2-232.3] | 30.81x **cis** |
| p99 latency | µs | 22072.6 [17133.7-25587.7] | 22016.0 [21905.1-27506.7] | 1.00x **cis** |
| max latency | µs | 189085.7 [67719.8-315930.0] | 58589.6 [51130.2-98140.2] | 3.23x **cis** |
| long frames | frames | 1 [1-3] | 0 [0-1] | inf **cis** |
| worst frame | ms | 193.6 [109.7-321.8] | 57.9 [56.4-72.8] | 3.34x **cis** |
| time past the tick | ms | 126.7 [81.4-254.9] | 0.0 [0.0-5.8] | inf **cis** |

## Live server, 128 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 450 [449-456] | 463 [459-465] | 1.03x **cis** |
| mean latency | µs | 12188.7 [11099.9-13367.0] | 3013.2 [2946.1-3430.7] | 4.05x **cis** |
| p50 latency | µs | 10222.2 [9472.1-11217.4] | 168.7 [163.8-178.7] | 60.60x **cis** |
| p99 latency | µs | 44048.7 [33442.7-75222.4] | 22376.6 [19204.9-33446.2] | 1.97x **cis** |
| max latency | µs | 188004.7 [110955.9-361443.8] | 63501.3 [56746.8-75757.4] | 2.96x **cis** |
| long frames | frames | 3 [2-7] | 0 [0-1] | inf **cis** |
| worst frame | ms | 162.0 [94.3-366.5] | 64.1 [55.9-68.0] | 2.53x **cis** |
| time past the tick | ms | 262.8 [40.2-529.3] | 0.0 [0.0-1.0] | inf **cis** |

## Live server, 256 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 864 [862-878] | 912 [909-917] | 1.06x **cis** |
| mean latency | µs | 19053.4 [18307.9-20650.1] | 5745.0 [5583.1-6230.6] | 3.32x **cis** |
| p50 latency | µs | 16123.1 [15534.5-16908.4] | 323.9 [292.5-373.1] | 49.78x **cis** |
| p99 latency | µs | 83590.7 [65269.8-95986.3] | 30403.1 [29859.5-35875.6] | 2.75x **cis** |
| max latency | µs | 172436.7 [125876.9-444154.7] | 64978.0 [59093.9-90610.9] | 2.65x **cis** |
| long frames | frames | 10 [7-11] | 0 [0-0] | inf **cis** |
| worst frame | ms | 144.1 [124.8-468.1] | 58.3 [57.6-60.9] | 2.47x **cis** |
| time past the tick | ms | 214.3 [185.8-626.2] | 0.0 [0.0-0.0] | inf **cis** |

## Join storm (128 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all joined | ms | 560.8 [497.3-576.9] | 347.2 [345.7-418.0] | 1.62x **cis** |
| p99 join | µs | 500833.7 [435045.3-511350.1] | 245193.7 [244379.6-294940.8] | 2.04x **cis** |
| long frames | frames | 1 [0-1] | 0 [0-0] | inf **cis** |
| worst frame | ms | 80.4 [59.0-113.8] | 59.3 [58.3-66.3] | 1.35x **cis** |

## Save storm (256 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all saved | ms | 626.9 [532.2-646.7] | 376.1 [373.9-410.7] | 1.67x **cis** |
| p99 save | µs | 495960.4 [436495.3-534667.6] | 294044.2 [270057.6-342649.5] | 1.69x **cis** |
| long frames | frames | 1 [0-2] | 0 [0-1] | inf **cis** |
| worst frame | ms | 78.7 [57.7-117.4] | 60.7 [59.0-69.5] | 1.30x **cis** |

## Payday loop (5000 sequential updates)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| wall time | ms | 9578.4 [9128.1-9845.8] | 10311.7 [10098.4-10322.8] | 0.93x ox |
| worst frame | ms | 80.1 [65.5-90.5] | 57.2 [55.9-62.6] | 1.40x **cis** |

## Saturation (32 threads, 10 s)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 2017 [1870-2096] | 2924 [2854-3086] | 1.45x **cis** |
| worst frame | ms | 147.0 [123.2-158.8] | 75.3 [70.9-114.1] | 1.95x **cis** |

## Bulk import

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| 20k players + 40k vehicles | ms | 6115 [5862-6388] | 8759 [8445-9040] | 0.70x ox |

## Idle server

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| tick | ms | 50.1 [50.1-50.2] | 50.2 [50.1-50.3] | 1.00x ox |

## FXServer hitch warnings (whole boot, startup included)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| warnings | count | 5 [0-9] | 14 [10-16] | 0.36x ox |
| longest | ms | 318 [0-448] | 341 [326-403] | 0.93x ox |

## CPU for the measured workload

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| FXServer | s | 55.59 [54.11-55.75] | 46.82 [46.31-47.05] | 1.19x **cis** |
| MariaDB | s | 32.02 [30.80-32.32] | 13.30 [12.72-13.84] | 2.41x **cis** |

## How it was measured

- Latency is the time around each `MySQL.*.await` call in the calling Lua thread (os.nanotime), so it includes the driver's Lua library, the export call and the wait for the answer.
- A long frame is a server tick more than 16.7 ms (one 60 Hz frame) past this boot's idle tick, measured by a `Wait(0)` thread. "Time past the tick" adds up how far those frames ran over.
- Live server: N threads each act as a player making 60 calls picked from an 80/20 read/write mix (player load, vehicles, inventory, messages, bank log, police count; saves, inventory saves, bank transfers in a transaction, messages, vehicle updates) with random think time.
- Writes are deterministic, so every driver and every run must end with the same data; the checksums above check that, and check MariaDB itself through the mysql CLI.
- Hitch warnings are FXServer's own `server thread hitch warning` console lines, counted over each boot's whole log (resource start and seed included).
- CPU is FXServer plus mariadbd process time from the idle measurement to the end of the workloads.
- Rerun on the server box, as root, from a checkout of this repository: `bash bench/run_bench.sh 5`.
