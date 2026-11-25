# cis_database vs oxmysql: real-server benchmark

Same server, same resources, same Lua (`bench/cis_bench`), one driver per boot, 5 rounds each, driver order alternating every round. Medians across rounds, range in brackets.

| | |
|---|---|
| date | 2026-10-27T21:01:27+03:00 |
| cpu | AMD EPYC 7302 16-Core Processor |
| cores | 6 |
| ram | 16 GiB |
| os | Ubuntu 24.04.5 LTS |
| fxserver | build 35245 |
| server | Qbox, its whole server.cfg |
| mariadb | server 10.11.14-MariaDB-0ubuntu0.24.04.1-log, client mysql  Ver 15.1 Distrib 10.11.14-MariaDB, for debian-linux-gnu (x86_64) using  EditLine wrapper |
| oxmysql | 2.14.3 (package ?) |
| cis_database | 1.0.0 build 5f34b49 |
| cis_database frame budget | 20 ms (BENCH_FRAME_MS, convar cis_database_frame_ms) |
| cis_database write ack | power (default: answered after an fdatasync of the WAL) |
| bench scripts | ? (modified) |
| rounds | 5 |
| scale | 1 |
| reproduce | BENCH_DATA=<server data folder> BENCH_SERVER=qbox BENCH_DB=qbox BENCH_FXROOT=<FXServer folder> BENCH_FRAME_MS=20 bash bench/run_bench.sh 5 1 |

**cis_database is better on 64 of 78 metrics.**

oxmysql is better on: Single call (one thread, .await) / in_list p99, Single call (one thread, .await) / count_police p99, Single call (one thread, .await) / save_player mean, Single call (one thread, .await) / save_player p50, Single call (one thread, .await) / save_player p99, Single call (one thread, .await) / save_inventory mean, Single call (one thread, .await) / save_inventory p50, Single call (one thread, .await) / save_inventory p99, Single call (one thread, .await) / send_message p50, Payday loop (5000 sequential updates) / wall time, Bulk import / 20k players + 40k vehicles, Idle server / tick, FXServer hitch warnings (whole boot, startup included) / longest.

Data check: 1 distinct final checksum across all 10 runs of both drivers (1 means every run ended with identical data). cis_database's MariaDB copy matched what it served in 5 of 5 runs; oxmysql's MariaDB matched in 5 of 5. Errors per run: oxmysql [0, 0, 0, 0, 0], cis_database [0, 0, 0, 0, 0].

cis_database confirms a write once an fdatasync of its SQLite WAL covers it (the default `cis_database_ack power`; see env.txt) and copies it to MariaDB behind; oxmysql confirms once MariaDB has committed it. After the last workload, cis_database's MariaDB copy was complete within 389 ms (median).

## Single call (one thread, .await)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| read_player mean | µs | 1848.7 [1821.6-1900.3] | 284.5 [280.4-323.7] | 6.50x **cis** |
| read_player p50 | µs | 1618.6 [1613.0-1637.4] | 105.3 [98.6-110.1] | 15.37x **cis** |
| read_player p99 | µs | 6756.4 [5939.2-7461.4] | 3781.9 [2166.9-4503.6] | 1.79x **cis** |
| read_by_license mean | µs | 1706.5 [1662.6-1711.8] | 207.0 [203.8-262.9] | 8.24x **cis** |
| read_by_license p50 | µs | 1543.5 [1530.1-1577.9] | 74.6 [68.6-97.5] | 20.68x **cis** |
| read_by_license p99 | µs | 4238.9 [4145.8-4312.6] | 1604.2 [1569.1-1861.2] | 2.64x **cis** |
| read_vehicles mean | µs | 1752.0 [1699.1-1769.5] | 257.0 [233.4-304.3] | 6.82x **cis** |
| read_vehicles p50 | µs | 1564.1 [1557.6-1610.2] | 95.1 [87.0-106.3] | 16.44x **cis** |
| read_vehicles p99 | µs | 4666.6 [3796.5-4744.1] | 1758.4 [1636.9-1895.1] | 2.65x **cis** |
| read_messages mean | µs | 1691.2 [1670.8-1758.4] | 160.4 [155.8-161.6] | 10.55x **cis** |
| read_messages p50 | µs | 1532.7 [1524.7-1595.1] | 56.4 [54.8-57.0] | 27.18x **cis** |
| read_messages p99 | µs | 4240.0 [3439.2-4531.4] | 1576.6 [1493.3-1602.3] | 2.69x **cis** |
| json_hunger mean | µs | 1644.3 [1620.7-1756.7] | 208.6 [205.1-209.5] | 7.88x **cis** |
| json_hunger p50 | µs | 1512.8 [1505.8-1568.0] | 69.7 [66.1-71.8] | 21.72x **cis** |
| json_hunger p99 | µs | 3956.8 [3630.0-4312.2] | 1680.0 [1644.1-1723.1] | 2.36x **cis** |
| in_list mean | µs | 1786.6 [1745.8-1836.9] | 386.8 [383.5-403.1] | 4.62x **cis** |
| in_list p50 | µs | 1566.6 [1559.6-1619.0] | 136.4 [134.6-139.0] | 11.48x **cis** |
| in_list p99 | µs | 5060.6 [4684.3-6000.2] | 5831.7 [5162.5-6927.5] | 0.87x ox |
| count_police mean | µs | 1706.6 [1644.1-1775.9] | 606.5 [548.8-643.5] | 2.81x **cis** |
| count_police p50 | µs | 1520.9 [1513.4-1537.1] | 231.8 [222.6-239.5] | 6.56x **cis** |
| count_police p99 | µs | 4338.3 [3161.9-4915.9] | 23487.2 [2923.3-24373.2] | 0.18x ox |
| richest mean | µs | 14473.2 [14246.8-14725.9] | 514.9 [449.3-532.1] | 28.11x **cis** |
| richest p50 | µs | 14279.4 [14065.1-14466.8] | 120.6 [105.4-127.0] | 118.42x **cis** |
| richest p99 | µs | 18778.8 [18093.7-19557.1] | 11822.6 [8075.1-13312.5] | 1.59x **cis** |
| save_player mean | µs | 2225.3 [2097.0-2326.5] | 2252.0 [2243.6-2316.1] | 0.99x ox |
| save_player p50 | µs | 1639.0 [1582.0-1658.4] | 1918.5 [1909.8-1945.0] | 0.85x ox |
| save_player p99 | µs | 5940.7 [5078.2-7293.3] | 7069.0 [6656.2-7410.7] | 0.84x ox |
| save_inventory mean | µs | 2066.7 [2022.8-2149.9] | 2135.1 [2072.4-2242.7] | 0.97x ox |
| save_inventory p50 | µs | 1590.5 [1545.1-1625.0] | 1816.7 [1791.6-1854.8] | 0.88x ox |
| save_inventory p99 | µs | 5478.8 [5176.0-6653.8] | 6563.9 [5780.2-8050.0] | 0.83x ox |
| send_message mean | µs | 1969.8 [1841.2-1994.8] | 1937.9 [1906.8-2031.6] | 1.02x **cis** |
| send_message p50 | µs | 1516.8 [1515.5-1577.2] | 1751.8 [1714.3-1769.1] | 0.87x ox |
| send_message p99 | µs | 5562.0 [5100.9-6982.8] | 4976.2 [4721.6-5781.8] | 1.12x **cis** |
| bank_transfer mean | µs | 7504.8 [7430.3-7669.4] | 2278.3 [2238.0-2396.1] | 3.29x **cis** |
| bank_transfer p50 | µs | 6879.6 [6838.7-6977.3] | 1956.2 [1915.7-1975.3] | 3.52x **cis** |
| bank_transfer p99 | µs | 13314.1 [13041.3-13738.6] | 7036.6 [6225.0-7477.3] | 1.89x **cis** |

## Live server, 64 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 228 [227-229] | 234 [232-234] | 1.02x **cis** |
| mean latency | µs | 7146.8 [6819.5-7544.5] | 956.2 [904.6-1044.5] | 7.47x **cis** |
| p50 latency | µs | 6106.5 [5925.5-6290.2] | 139.7 [135.5-148.0] | 43.73x **cis** |
| p99 latency | µs | 25014.8 [16260.7-37428.6] | 7543.9 [6777.7-10406.7] | 3.32x **cis** |
| max latency | µs | 71224.8 [64075.0-198687.9] | 25417.6 [12667.3-36072.5] | 2.80x **cis** |
| long frames | frames | 2 [0-3] | 0 [0-0] | inf **cis** |
| worst frame | ms | 99.3 [65.3-204.6] | 54.9 [54.4-58.0] | 1.81x **cis** |
| time past the tick | ms | 43.0 [0.0-137.8] | 0.0 [0.0-0.0] | inf **cis** |

## Live server, 128 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 454 [450-458] | 466 [464-468] | 1.02x **cis** |
| mean latency | µs | 10622.7 [10281.5-11434.7] | 1197.9 [1154.0-1235.0] | 8.87x **cis** |
| p50 latency | µs | 9189.9 [8845.5-9632.0] | 125.7 [125.0-131.3] | 73.11x **cis** |
| p99 latency | µs | 35407.9 [34811.9-77454.8] | 10347.1 [9440.6-11446.1] | 3.42x **cis** |
| max latency | µs | 111371.5 [78761.5-277205.5] | 23550.7 [17949.5-28841.7] | 4.73x **cis** |
| long frames | frames | 4 [3-4] | 0 [0-0] | inf **cis** |
| worst frame | ms | 116.4 [96.3-267.6] | 58.0 [55.3-59.7] | 2.01x **cis** |
| time past the tick | ms | 108.9 [54.8-480.5] | 0.0 [0.0-0.0] | inf **cis** |

## Live server, 256 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 870 [847-883] | 918 [917-921] | 1.05x **cis** |
| mean latency | µs | 17822.5 [17754.5-19629.9] | 2450.0 [2194.5-2532.4] | 7.27x **cis** |
| p50 latency | µs | 15293.9 [14719.9-16296.5] | 124.9 [120.3-126.1] | 122.50x **cis** |
| p99 latency | µs | 69211.0 [62489.4-91459.3] | 18277.9 [17435.5-20460.3] | 3.79x **cis** |
| max latency | µs | 138154.2 [129866.2-486721.3] | 34983.5 [28269.6-38020.3] | 3.95x **cis** |
| long frames | frames | 7 [4-9] | 0 [0-0] | inf **cis** |
| worst frame | ms | 162.1 [104.8-480.3] | 58.7 [56.3-59.7] | 2.76x **cis** |
| time past the tick | ms | 338.7 [125.5-592.2] | 0.0 [0.0-0.0] | inf **cis** |

## Join storm (128 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all joined | ms | 544.3 [449.5-643.7] | 334.9 [284.7-340.9] | 1.63x **cis** |
| p99 join | µs | 465967.8 [372911.5-556839.5] | 240510.9 [209014.9-270072.1] | 1.94x **cis** |
| long frames | frames | 1 [0-2] | 0 [0-0] | inf **cis** |
| worst frame | ms | 84.6 [53.8-110.7] | 56.0 [54.0-60.0] | 1.51x **cis** |

## Save storm (256 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all saved | ms | 520.0 [512.5-734.9] | 456.3 [451.4-552.1] | 1.14x **cis** |
| p99 save | µs | 420417.3 [383159.5-604323.6] | 368485.4 [355334.7-441689.5] | 1.14x **cis** |
| long frames | frames | 0 [0-2] | 0 [0-0] | inf |
| worst frame | ms | 64.3 [57.4-268.9] | 59.0 [55.5-65.6] | 1.09x **cis** |

## Payday loop (5000 sequential updates)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| wall time | ms | 9313.7 [9113.9-9367.1] | 9889.6 [9860.3-9990.3] | 0.94x ox |
| worst frame | ms | 87.5 [71.9-118.0] | 57.8 [56.6-64.0] | 1.51x **cis** |

## Saturation (32 threads, 10 s)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 2100 [2039-2130] | 2957 [2937-3118] | 1.41x **cis** |
| worst frame | ms | 163.9 [112.4-539.2] | 57.1 [54.1-59.5] | 2.87x **cis** |

## Bulk import

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| 20k players + 40k vehicles | ms | 5893 [5463-6058] | 10037 [9894-10097] | 0.59x ox |

## Idle server

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| tick | ms | 50.1 [50.1-50.1] | 50.1 [50.1-50.2] | 1.00x ox |

## FXServer hitch warnings (whole boot, startup included)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| warnings | count | 2 [0-12] | 1 [1-2] | 2.00x **cis** |
| longest | ms | 171 [0-539] | 456 [311-529] | 0.38x ox |

## CPU for the measured workload

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| FXServer | s | 53.41 [52.14-54.14] | 34.89 [34.30-35.62] | 1.53x **cis** |
| MariaDB | s | 30.35 [29.36-30.55] | 7.15 [6.89-7.67] | 4.24x **cis** |

## How it was measured

- Latency is the time around each `MySQL.*.await` call in the calling Lua thread (os.nanotime), so it includes the driver's Lua library, the export call and the wait for the answer.
- A long frame is a server tick more than 16.7 ms (one 60 Hz frame) past this boot's idle tick, measured by a `Wait(0)` thread. "Time past the tick" adds up how far those frames ran over.
- Live server: N threads each act as a player making 60 calls picked from an 80/20 read/write mix (player load, vehicles, inventory, messages, bank log, police count; saves, inventory saves, bank transfers in a transaction, messages, vehicle updates) with random think time.
- Writes are deterministic, so every driver and every run must end with the same data; the checksums above check that, and check MariaDB itself through the mysql CLI.
- Hitch warnings are FXServer's own `server thread hitch warning` console lines, counted over each boot's whole log (resource start and seed included).
- CPU is FXServer plus mariadbd process time from the idle measurement to the end of the workloads.
- Rerun on the server box, as root, from a checkout of this repository: `bash bench/run_bench.sh 5`.
