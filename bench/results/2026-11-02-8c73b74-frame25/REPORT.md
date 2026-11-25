# cis_database vs oxmysql: real-server benchmark

Same server, same resources, same Lua (`bench/cis_bench`), one driver per boot, 5 rounds each, driver order alternating every round. Medians across rounds, range in brackets.

| | |
|---|---|
| date | 2026-11-02T02:38:36+03:00 |
| cpu | AMD EPYC 7302 16-Core Processor |
| cores | 6 |
| ram | 16 GiB |
| os | Ubuntu 24.04.5 LTS |
| kernel | 6.8.0-147-generic |
| fxserver | build 35245 |
| txadmin | 8.1.1 |
| server | qbox (txAdmin, txadmin@<SERVER>), whole server.cfg, 165 resources on disk |
| mariadb | server 10.11.14-MariaDB-0ubuntu0.24.04.1-log, client mysql  Ver 15.1 Distrib 10.11.14-MariaDB, for debian-linux-gnu (x86_64) using  EditLine wrapper |
| oxmysql | 2.14.3 (package version not recorded) |
| cis_database | 1.0.0-beta.3 build 8c73b74 |
| cis_database frame budget | 25 ms (BENCH_FRAME_MS, convar cis_database_frame_ms) |
| cis_database write ack | power (default: answered after an fdatasync of the WAL) |
| bench scripts | commit not recorded (modified) |
| rounds | 5 |
| scale | 1 |
| reproduce | BENCH_DATA=<server data folder> BENCH_SERVER=qbox BENCH_DB=qbox BENCH_FXROOT=<FXServer folder> BENCH_FRAME_MS=25 bash bench/run_bench.sh 5 1 |

**cis_database is better on 63 of 82 metrics.**

oxmysql is better on: Single call (one thread, .await) / read_vehicles mean, Single call (one thread, .await) / read_vehicles p50, Single call (one thread, .await) / read_vehicles p99, Single call (one thread, .await) / json_hunger mean, Single call (one thread, .await) / json_hunger p50, Single call (one thread, .await) / json_hunger p99, Single call (one thread, .await) / count_police p99, Single call (one thread, .await) / save_player p50, Single call (one thread, .await) / save_inventory mean, Single call (one thread, .await) / save_inventory p50, Single call (one thread, .await) / save_inventory p99, Single call (one thread, .await) / send_message mean, Single call (one thread, .await) / send_message p50, Payday loop (5000 sequential updates) / wall time, Bulk import / 20k players + 40k vehicles, Idle server / tick, Memory (resident) / FXServer at idle, Memory (resident) / MariaDB after the workloads.

Data check: 1 distinct final checksum across all 10 runs of both drivers (1 means every run ended with identical data). cis_database's MariaDB copy matched what it served in 5 of 5 runs; oxmysql's MariaDB matched in 5 of 5. Errors per run: oxmysql [0, 0, 0, 0, 0], cis_database [0, 0, 0, 0, 0].

cis_database confirms a write once an fdatasync of its SQLite WAL covers it (the default `cis_database_ack power`; see env.txt) and copies it to MariaDB behind; oxmysql confirms once MariaDB has committed it. After the last workload, cis_database's MariaDB copy was complete within 133 ms (median).

## Single call (one thread, .await)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| read_player mean | µs | 1918.8 [1886.8-1949.8] | 349.6 [324.5-356.6] | 5.49x **cis** |
| read_player p50 | µs | 1640.0 [1617.1-1661.5] | 145.3 [141.9-147.6] | 11.29x **cis** |
| read_player p99 | µs | 6664.2 [6240.9-7582.3] | 6218.0 [5344.9-6397.6] | 1.07x **cis** |
| read_by_license mean | µs | 1722.8 [1687.5-1745.1] | 265.3 [249.6-304.7] | 6.49x **cis** |
| read_by_license p50 | µs | 1559.5 [1533.8-1598.2] | 111.3 [98.7-116.0] | 14.01x **cis** |
| read_by_license p99 | µs | 3894.6 [3735.0-4574.8] | 2090.2 [1830.2-2719.9] | 1.86x **cis** |
| read_vehicles mean | µs | 1817.0 [1711.2-1853.3] | 1859.5 [1815.4-1882.6] | 0.98x ox |
| read_vehicles p50 | µs | 1570.7 [1558.8-1640.8] | 1602.4 [1600.3-1643.8] | 0.98x ox |
| read_vehicles p99 | µs | 4635.6 [4214.8-5114.0] | 5558.8 [5447.7-6030.1] | 0.83x ox |
| read_messages mean | µs | 1711.2 [1653.5-1764.3] | 230.3 [207.5-238.4] | 7.43x **cis** |
| read_messages p50 | µs | 1534.4 [1525.4-1589.4] | 97.9 [90.2-104.2] | 15.68x **cis** |
| read_messages p99 | µs | 3849.8 [3274.8-4824.7] | 1763.9 [1714.7-1849.0] | 2.18x **cis** |
| json_hunger mean | µs | 1729.5 [1643.9-1773.4] | 1826.7 [1749.2-1925.3] | 0.95x ox |
| json_hunger p50 | µs | 1532.8 [1515.3-1569.9] | 1541.4 [1524.9-1596.5] | 0.99x ox |
| json_hunger p99 | µs | 4684.9 [3689.8-4725.9] | 6513.9 [5530.1-6711.9] | 0.72x ox |
| in_list mean | µs | 1824.4 [1761.6-1914.8] | 387.0 [375.1-432.6] | 4.71x **cis** |
| in_list p50 | µs | 1584.4 [1561.6-1631.6] | 169.7 [168.4-185.8] | 9.34x **cis** |
| in_list p99 | µs | 5592.9 [5041.4-6094.7] | 5413.3 [4088.6-5482.8] | 1.03x **cis** |
| count_police mean | µs | 1773.5 [1687.7-1885.9] | 534.8 [516.2-545.2] | 3.32x **cis** |
| count_police p50 | µs | 1522.1 [1512.3-1580.3] | 248.6 [243.8-262.8] | 6.12x **cis** |
| count_police p99 | µs | 4275.6 [3546.1-4935.8] | 5793.4 [2997.9-10977.2] | 0.74x ox |
| richest mean | µs | 15167.3 [15005.2-15522.1] | 527.4 [523.8-540.4] | 28.76x **cis** |
| richest p50 | µs | 15005.7 [14835.5-15527.3] | 151.8 [144.0-156.9] | 98.88x **cis** |
| richest p99 | µs | 19755.1 [19249.4-20758.0] | 11601.3 [11108.6-15209.0] | 1.70x **cis** |
| save_player mean | µs | 2298.6 [2159.7-2304.8] | 2199.4 [2191.0-2273.5] | 1.05x **cis** |
| save_player p50 | µs | 1632.5 [1607.9-1673.0] | 1922.5 [1908.1-1964.1] | 0.85x ox |
| save_player p99 | µs | 6245.9 [5571.0-6806.9] | 6068.1 [5553.7-6959.3] | 1.03x **cis** |
| save_inventory mean | µs | 2099.7 [2032.3-2225.3] | 2203.9 [2090.9-2299.9] | 0.95x ox |
| save_inventory p50 | µs | 1591.6 [1570.5-1654.8] | 1919.0 [1840.7-1970.9] | 0.83x ox |
| save_inventory p99 | µs | 5749.5 [5579.7-6175.4] | 6375.6 [5509.8-7018.8] | 0.90x ox |
| send_message mean | µs | 1900.3 [1853.3-1991.8] | 2023.8 [1912.3-2064.4] | 0.94x ox |
| send_message p50 | µs | 1527.6 [1501.2-1585.6] | 1785.4 [1747.4-1842.3] | 0.86x ox |
| send_message p99 | µs | 5545.7 [5018.5-7364.6] | 5322.4 [4842.5-5587.0] | 1.04x **cis** |
| bank_transfer mean | µs | 7615.5 [7464.1-7867.2] | 2472.3 [2401.5-2484.9] | 3.08x **cis** |
| bank_transfer p50 | µs | 6922.2 [6874.9-7090.2] | 2126.3 [2087.3-2173.0] | 3.26x **cis** |
| bank_transfer p99 | µs | 13842.9 [12965.0-14792.1] | 6928.6 [6549.1-7767.0] | 2.00x **cis** |

## Live server, 64 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 226 [225-229] | 233 [231-233] | 1.03x **cis** |
| mean latency | µs | 7438.3 [6923.0-8139.5] | 2264.6 [2204.9-2382.1] | 3.28x **cis** |
| p50 latency | µs | 6182.3 [5937.6-6831.1] | 246.0 [243.8-261.7] | 25.13x **cis** |
| p99 latency | µs | 23229.6 [17066.2-27516.7] | 15871.8 [14710.8-16778.5] | 1.46x **cis** |
| max latency | µs | 98996.5 [86420.4-293411.4] | 57217.9 [52115.9-58450.5] | 1.73x **cis** |
| long frames | frames | 3 [1-3] | 0 [0-0] | inf **cis** |
| worst frame | ms | 105.0 [95.0-328.3] | 55.7 [55.3-61.4] | 1.88x **cis** |
| time past the tick | ms | 61.9 [42.9-261.5] | 0.0 [0.0-0.0] | inf **cis** |

## Live server, 128 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 448 [448-455] | 463 [462-464] | 1.03x **cis** |
| mean latency | µs | 12028.3 [10491.3-14076.3] | 3219.3 [3068.7-3595.2] | 3.74x **cis** |
| p50 latency | µs | 9962.4 [8754.0-11171.5] | 201.4 [198.8-219.4] | 49.48x **cis** |
| p99 latency | µs | 56995.0 [28862.1-113950.3] | 21221.9 [18907.2-23286.0] | 2.69x **cis** |
| max latency | µs | 189721.3 [123291.4-359006.8] | 57519.4 [33365.2-65356.6] | 3.30x **cis** |
| long frames | frames | 4 [2-5] | 0 [0-0] | inf **cis** |
| worst frame | ms | 179.6 [123.5-379.1] | 57.3 [56.2-62.2] | 3.14x **cis** |
| time past the tick | ms | 342.1 [132.8-389.6] | 0.0 [0.0-0.0] | inf **cis** |

## Live server, 256 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 852 [841-875] | 904 [894-907] | 1.06x **cis** |
| mean latency | µs | 19383.8 [18483.1-23233.5] | 7435.3 [7147.6-7713.6] | 2.61x **cis** |
| p50 latency | µs | 15619.2 [14739.2-17594.0] | 6140.8 [5716.1-6503.3] | 2.54x **cis** |
| p99 latency | µs | 89383.7 [85570.3-120656.1] | 32255.5 [31450.0-34291.1] | 2.77x **cis** |
| max latency | µs | 335104.4 [138069.2-554671.5] | 80556.5 [77346.3-110309.9] | 4.16x **cis** |
| long frames | frames | 9 [4-16] | 0 [0-0] | inf **cis** |
| worst frame | ms | 325.6 [134.0-511.5] | 58.7 [57.3-59.3] | 5.55x **cis** |
| time past the tick | ms | 855.9 [303.3-882.1] | 0.0 [0.0-0.0] | inf **cis** |

## Join storm (128 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all joined | ms | 505.9 [451.4-542.8] | 340.8 [339.3-405.5] | 1.48x **cis** |
| p99 join | µs | 434709.9 [371730.4-455460.8] | 266750.1 [243603.4-320739.4] | 1.63x **cis** |
| long frames | frames | 0 [0-1] | 0 [0-1] | inf |
| worst frame | ms | 65.1 [55.7-92.9] | 61.4 [59.0-70.8] | 1.06x **cis** |

## Save storm (256 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all saved | ms | 615.3 [507.9-875.4] | 504.1 [456.3-557.6] | 1.22x **cis** |
| p99 save | µs | 471855.7 [379636.2-757741.6] | 408045.0 [375592.5-482064.4] | 1.16x **cis** |
| long frames | frames | 1 [0-1] | 0 [0-0] | inf **cis** |
| worst frame | ms | 107.4 [57.2-409.8] | 59.1 [58.1-61.5] | 1.82x **cis** |

## Payday loop (5000 sequential updates)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| wall time | ms | 9603.6 [9472.6-9831.8] | 10646.8 [10510.6-10759.1] | 0.90x ox |
| worst frame | ms | 133.2 [68.8-372.2] | 59.1 [54.5-72.9] | 2.25x **cis** |

## Saturation (32 threads, 10 s)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 1954 [1833-2022] | 2692 [2626-2780] | 1.38x **cis** |
| worst frame | ms | 423.3 [139.3-646.9] | 66.5 [56.7-95.3] | 6.37x **cis** |

## Bulk import

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| 20k players + 40k vehicles | ms | 6433 [6332-6445] | 9256 [8852-9521] | 0.69x ox |

## Idle server

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| tick | ms | 50.1 [50.1-50.2] | 50.2 [50.2-50.4] | 1.00x ox |

## FXServer hitch warnings (whole boot, startup included)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| warnings | count | 14 [1-17] | 1 [0-2] | 14.00x **cis** |
| longest | ms | 500 [172-647] | 183 [0-199] | 2.73x **cis** |

## CPU for the measured workload

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| FXServer | s | 55.81 [53.06-57.36] | 47.45 [46.76-47.99] | 1.18x **cis** |
| MariaDB | s | 31.09 [30.53-32.45] | 13.99 [13.93-14.14] | 2.22x **cis** |

## Memory (resident)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| FXServer at idle | MB | 386 [382-398] | 517 [513-538] | 0.75x ox |
| FXServer peak | MB | 605 [420-731] | 552 [545-557] | 1.10x **cis** |
| FXServer after the workloads | MB | 588 [408-688] | 466 [454-509] | 1.26x **cis** |
| MariaDB after the workloads | MB | 1010 [998-1010] | 1010 [1005-1016] | 1.00x ox |

## How it was measured

- Latency is the time around each `MySQL.*.await` call in the calling Lua thread (os.nanotime), so it includes the driver's Lua library, the export call and the wait for the answer.
- A long frame is a server tick more than 16.7 ms (one 60 Hz frame) past this boot's idle tick, measured by a `Wait(0)` thread. "Time past the tick" adds up how far those frames ran over.
- Live server: N threads each act as a player making 60 calls picked from an 80/20 read/write mix (player load, vehicles, inventory, messages, bank log, police count; saves, inventory saves, bank transfers in a transaction, messages, vehicle updates) with random think time.
- Writes are deterministic, so every driver and every run must end with the same data; the checksums above check that, and check MariaDB itself through the mysql CLI.
- Hitch warnings are FXServer's own `server thread hitch warning` console lines, counted over each boot's whole log (resource start and seed included).
- CPU is FXServer plus mariadbd process time from the idle measurement to the end of the workloads.
- Memory is resident memory from `/proc/<pid>/status`: FXServer `VmRSS` at the idle measurement and at the end, and its `VmHWM` peak (each pass starts a new FXServer); mariadbd keeps running across passes, so only its `VmRSS` at the end is read. cis_database's SQLite copy lives inside FXServer's memory.
- Rerun on the server box, as root, from a checkout of this repository: `bash bench/run_bench.sh 5`.
