# cis_database vs oxmysql: real-server benchmark

Same server, same resources, same Lua (`bench/cis_bench`), one driver per boot, 5 rounds each, driver order alternating every round. Medians across rounds, range in brackets.

| | |
|---|---|
| date | 2026-10-28T17:30:51+03:00 |
| cpu | AMD EPYC 7302 16-Core Processor |
| cores | 6 |
| ram | 16 GiB |
| os | Ubuntu 24.04.5 LTS |
| fxserver | build 35245 |
| server | Qbox, its whole server.cfg |
| mariadb | server 10.11.14-MariaDB-0ubuntu0.24.04.1-log, client mysql  Ver 15.1 Distrib 10.11.14-MariaDB, for debian-linux-gnu (x86_64) using  EditLine wrapper |
| oxmysql | 2.14.3 (package ?) |
| cis_database | 1.0.0-beta.2 build ae3a7a5 |
| cis_database frame budget | 25 ms (BENCH_FRAME_MS, convar cis_database_frame_ms) |
| cis_database write ack | power (default: answered after an fdatasync of the WAL) |
| bench scripts | ? (modified) |
| rounds | 5 |
| scale | 1 |
| reproduce | BENCH_DATA=<server data folder> BENCH_SERVER=qbox BENCH_DB=qbox BENCH_FXROOT=<FXServer folder> BENCH_FRAME_MS=25 bash bench/run_bench.sh 5 1 |

**cis_database is better on 61 of 78 metrics.**

oxmysql is better on: Single call (one thread, .await) / read_vehicles mean, Single call (one thread, .await) / read_vehicles p50, Single call (one thread, .await) / read_vehicles p99, Single call (one thread, .await) / json_hunger mean, Single call (one thread, .await) / json_hunger p50, Single call (one thread, .await) / json_hunger p99, Single call (one thread, .await) / count_police p99, Single call (one thread, .await) / save_player p50, Single call (one thread, .await) / save_player p99, Single call (one thread, .await) / save_inventory mean, Single call (one thread, .await) / save_inventory p50, Single call (one thread, .await) / save_inventory p99, Single call (one thread, .await) / send_message mean, Single call (one thread, .await) / send_message p50, Payday loop (5000 sequential updates) / wall time, Bulk import / 20k players + 40k vehicles, Idle server / tick.

Data check: 1 distinct final checksum across all 10 runs of both drivers (1 means every run ended with identical data). cis_database's MariaDB copy matched what it served in 5 of 5 runs; oxmysql's MariaDB matched in 5 of 5. Errors per run: oxmysql [0, 0, 0, 0, 0], cis_database [0, 0, 0, 0, 0].

cis_database confirms a write once an fdatasync of its SQLite WAL covers it (the default `cis_database_ack power`; see env.txt) and copies it to MariaDB behind; oxmysql confirms once MariaDB has committed it. After the last workload, cis_database's MariaDB copy was complete within 0 ms (median).

## Single call (one thread, .await)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| read_player mean | µs | 1845.7 [1800.9-1906.8] | 270.8 [260.9-315.1] | 6.82x **cis** |
| read_player p50 | µs | 1619.8 [1614.4-1653.1] | 117.5 [113.0-130.5] | 13.78x **cis** |
| read_player p99 | µs | 6360.9 [6069.9-7251.7] | 4523.2 [3260.8-6109.0] | 1.41x **cis** |
| read_by_license mean | µs | 1672.3 [1630.5-1695.2] | 225.2 [213.7-238.3] | 7.43x **cis** |
| read_by_license p50 | µs | 1538.7 [1529.3-1567.7] | 87.5 [85.7-94.8] | 17.59x **cis** |
| read_by_license p99 | µs | 4080.0 [3171.8-4307.5] | 1726.9 [1634.0-1989.5] | 2.36x **cis** |
| read_vehicles mean | µs | 1744.4 [1683.8-1807.5] | 1825.2 [1759.5-1834.9] | 0.96x ox |
| read_vehicles p50 | µs | 1571.0 [1549.2-1598.9] | 1607.5 [1558.7-1627.1] | 0.98x ox |
| read_vehicles p99 | µs | 4569.5 [3322.5-4925.0] | 5155.0 [5048.8-5770.2] | 0.89x ox |
| read_messages mean | µs | 1675.6 [1623.2-1699.7] | 176.3 [164.1-184.3] | 9.50x **cis** |
| read_messages p50 | µs | 1526.1 [1514.1-1545.6] | 76.8 [75.0-79.0] | 19.88x **cis** |
| read_messages p99 | µs | 4352.7 [3072.8-4615.2] | 1639.5 [1538.9-1762.4] | 2.65x **cis** |
| json_hunger mean | µs | 1659.0 [1637.6-1703.9] | 1737.8 [1681.8-1745.8] | 0.95x ox |
| json_hunger p50 | µs | 1511.3 [1501.5-1531.1] | 1537.5 [1500.7-1554.9] | 0.98x ox |
| json_hunger p99 | µs | 3916.4 [3236.5-4460.4] | 5288.5 [4944.8-6032.2] | 0.74x ox |
| in_list mean | µs | 1758.5 [1721.9-1777.3] | 352.8 [336.6-380.5] | 4.98x **cis** |
| in_list p50 | µs | 1559.5 [1544.4-1570.9] | 156.5 [149.4-162.9] | 9.96x **cis** |
| in_list p99 | µs | 4470.8 [4223.3-5245.9] | 3017.5 [2516.9-3985.0] | 1.48x **cis** |
| count_police mean | µs | 1672.8 [1624.4-1743.3] | 513.3 [464.8-528.6] | 3.26x **cis** |
| count_police p50 | µs | 1525.8 [1496.2-1533.3] | 236.9 [227.2-251.6] | 6.44x **cis** |
| count_police p99 | µs | 4518.6 [3643.2-4937.1] | 5340.0 [2906.9-7237.0] | 0.85x ox |
| richest mean | µs | 14381.6 [14141.0-14817.6] | 461.6 [456.0-529.6] | 31.16x **cis** |
| richest p50 | µs | 14176.0 [13880.8-14565.9] | 128.1 [122.9-153.6] | 110.63x **cis** |
| richest p99 | µs | 20345.5 [19000.2-20647.3] | 6533.5 [1748.9-8487.5] | 3.11x **cis** |
| save_player mean | µs | 2173.2 [2067.3-2178.8] | 2154.2 [2085.0-2239.5] | 1.01x **cis** |
| save_player p50 | µs | 1599.1 [1582.8-1611.3] | 1898.5 [1822.1-1938.2] | 0.84x ox |
| save_player p99 | µs | 5562.7 [5014.2-5821.0] | 6112.1 [5890.7-6719.1] | 0.91x ox |
| save_inventory mean | µs | 2053.7 [2045.2-2100.9] | 2160.0 [2066.9-2222.9] | 0.95x ox |
| save_inventory p50 | µs | 1577.7 [1565.6-1588.5] | 1848.4 [1835.1-1877.2] | 0.85x ox |
| save_inventory p99 | µs | 5728.6 [4925.1-5860.0] | 6266.4 [5460.2-8058.5] | 0.91x ox |
| send_message mean | µs | 1879.0 [1778.2-1934.7] | 1974.2 [1889.5-1999.7] | 0.95x ox |
| send_message p50 | µs | 1510.0 [1509.0-1532.0] | 1751.6 [1722.9-1789.4] | 0.86x ox |
| send_message p99 | µs | 5362.3 [4495.6-6848.7] | 5127.9 [4661.1-5457.2] | 1.05x **cis** |
| bank_transfer mean | µs | 7366.3 [7338.4-7470.9] | 2302.1 [2232.3-2414.9] | 3.20x **cis** |
| bank_transfer p50 | µs | 6796.0 [6777.5-6924.3] | 2011.4 [1959.3-2085.0] | 3.38x **cis** |
| bank_transfer p99 | µs | 13269.3 [12016.0-13592.6] | 6602.5 [6068.9-7097.9] | 2.01x **cis** |

## Live server, 64 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 227 [225-229] | 232 [231-233] | 1.02x **cis** |
| mean latency | µs | 7363.5 [6722.0-7755.7] | 2098.6 [2048.4-2200.2] | 3.51x **cis** |
| p50 latency | µs | 6157.6 [5573.9-6490.6] | 206.2 [197.9-213.1] | 29.87x **cis** |
| p99 latency | µs | 24903.1 [20618.7-25883.1] | 15343.2 [13720.7-16142.8] | 1.62x **cis** |
| max latency | µs | 175742.8 [59786.6-222081.7] | 62298.9 [53215.6-62651.7] | 2.82x **cis** |
| long frames | frames | 1 [1-2] | 0 [0-0] | inf **cis** |
| worst frame | ms | 207.2 [80.9-227.4] | 55.9 [54.1-56.1] | 3.71x **cis** |
| time past the tick | ms | 140.4 [15.4-160.6] | 0.0 [0.0-0.0] | inf **cis** |

## Live server, 128 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 451 [442-462] | 465 [461-466] | 1.03x **cis** |
| mean latency | µs | 10710.9 [9718.9-12169.7] | 2799.3 [2690.1-2913.1] | 3.83x **cis** |
| p50 latency | µs | 9060.0 [8478.0-10548.3] | 165.1 [161.9-167.1] | 54.89x **cis** |
| p99 latency | µs | 31450.9 [27056.8-47257.7] | 19046.8 [17978.4-19759.7] | 1.65x **cis** |
| max latency | µs | 151195.6 [89051.1-378186.1] | 56143.9 [50609.3-63965.9] | 2.69x **cis** |
| long frames | frames | 4 [3-5] | 0 [0-0] | inf **cis** |
| worst frame | ms | 148.3 [101.5-371.4] | 57.6 [56.8-58.9] | 2.58x **cis** |
| time past the tick | ms | 252.5 [51.1-642.7] | 0.0 [0.0-0.0] | inf **cis** |

## Live server, 256 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 855 [849-869] | 904 [899-912] | 1.06x **cis** |
| mean latency | µs | 17941.8 [17283.5-19206.7] | 5534.9 [5390.1-5981.9] | 3.24x **cis** |
| p50 latency | µs | 15316.1 [14208.9-15641.5] | 266.9 [242.1-316.7] | 57.39x **cis** |
| p99 latency | µs | 73290.6 [62209.8-103835.5] | 29531.3 [29104.0-31284.2] | 2.48x **cis** |
| max latency | µs | 270118.9 [125098.1-528870.3] | 73490.8 [71381.7-83927.5] | 3.68x **cis** |
| long frames | frames | 6 [4-11] | 0 [0-0] | inf **cis** |
| worst frame | ms | 290.1 [116.0-503.2] | 57.8 [57.4-58.2] | 5.02x **cis** |
| time past the tick | ms | 515.9 [211.7-655.9] | 0.0 [0.0-0.0] | inf **cis** |

## Join storm (128 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all joined | ms | 510.9 [482.8-655.1] | 301.3 [292.2-353.6] | 1.70x **cis** |
| p99 join | µs | 426070.5 [385027.9-577470.0] | 226074.7 [210689.2-251891.7] | 1.88x **cis** |
| long frames | frames | 1 [0-1] | 0 [0-1] | inf **cis** |
| worst frame | ms | 93.2 [55.7-205.4] | 62.5 [59.0-68.6] | 1.49x **cis** |

## Save storm (256 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all saved | ms | 500.5 [463.3-644.1] | 451.5 [448.2-458.0] | 1.11x **cis** |
| p99 save | µs | 410024.5 [335203.8-550455.1] | 358173.5 [343410.3-362304.9] | 1.14x **cis** |
| long frames | frames | 1 [0-2] | 0 [0-0] | inf **cis** |
| worst frame | ms | 74.4 [59.7-114.9] | 58.6 [58.1-62.3] | 1.27x **cis** |

## Payday loop (5000 sequential updates)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| wall time | ms | 9112.1 [8945.1-9357.2] | 9972.9 [9630.8-10624.4] | 0.91x ox |
| worst frame | ms | 84.4 [77.4-160.6] | 57.8 [55.7-66.6] | 1.46x **cis** |

## Saturation (32 threads, 10 s)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 2102 [2061-2174] | 3101 [3083-3231] | 1.48x **cis** |
| worst frame | ms | 138.9 [130.5-152.9] | 67.9 [58.3-77.8] | 2.05x **cis** |

## Bulk import

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| 20k players + 40k vehicles | ms | 6142 [5840-6356] | 9486 [9225-9745] | 0.65x ox |

## Idle server

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| tick | ms | 50.1 [50.1-50.2] | 50.2 [50.2-50.3] | 1.00x ox |

## FXServer hitch warnings (whole boot, startup included)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| warnings | count | 4 [1-9] | 1 [1-2] | 4.00x **cis** |
| longest | ms | 277 [187-488] | 173 [168-218] | 1.60x **cis** |

## CPU for the measured workload

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| FXServer | s | 52.70 [51.78-54.57] | 43.43 [42.74-44.45] | 1.21x **cis** |
| MariaDB | s | 29.20 [28.04-30.86] | 12.37 [12.29-13.62] | 2.36x **cis** |

## How it was measured

- Latency is the time around each `MySQL.*.await` call in the calling Lua thread (os.nanotime), so it includes the driver's Lua library, the export call and the wait for the answer.
- A long frame is a server tick more than 16.7 ms (one 60 Hz frame) past this boot's idle tick, measured by a `Wait(0)` thread. "Time past the tick" adds up how far those frames ran over.
- Live server: N threads each act as a player making 60 calls picked from an 80/20 read/write mix (player load, vehicles, inventory, messages, bank log, police count; saves, inventory saves, bank transfers in a transaction, messages, vehicle updates) with random think time.
- Writes are deterministic, so every driver and every run must end with the same data; the checksums above check that, and check MariaDB itself through the mysql CLI.
- Hitch warnings are FXServer's own `server thread hitch warning` console lines, counted over each boot's whole log (resource start and seed included).
- CPU is FXServer plus mariadbd process time from the idle measurement to the end of the workloads.
- Rerun on the server box, as root, from a checkout of this repository: `bash bench/run_bench.sh 5`.
