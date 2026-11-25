# cis_database vs oxmysql: real-server benchmark

Same server, same resources, same Lua (`bench/cis_bench`), one driver per boot, 5 rounds each, driver order alternating every round. Medians across rounds, range in brackets.

| | |
|---|---|
| date | 2026-10-25T00:41:18+03:00 |
| cpu | AMD EPYC 7302 16-Core Processor |
| cores | 6 |
| ram | 16 GiB |
| os | Ubuntu 24.04.5 LTS |
| fxserver | build 35245 |
| server | Qbox, its whole server.cfg |
| mariadb | mysql  Ver 15.1 Distrib 10.11.14-MariaDB, for debian-linux-gnu (x86_64) using  EditLine wrapper |
| oxmysql | 2.14.3 (package ?) |
| cis_database | pre-release build 2c51f67 |
| cis_database frame budget | 35 ms (BENCH_FRAME_MS, convar cis_database_frame_ms) |
| rounds | 5 |
| scale | 1 |

**cis_database is better on 66 of 78 metrics.**

oxmysql is better on: Single call (one thread, .await) / save_player mean, Single call (one thread, .await) / save_player p50, Single call (one thread, .await) / save_player p99, Single call (one thread, .await) / save_inventory mean, Single call (one thread, .await) / save_inventory p50, Single call (one thread, .await) / save_inventory p99, Single call (one thread, .await) / send_message mean, Single call (one thread, .await) / send_message p50, Single call (one thread, .await) / send_message p99, Payday loop (5000 sequential updates) / wall time, Bulk import / 20k players + 40k vehicles.

Data check: 1 distinct final checksum across all 10 runs of both drivers (1 means every run ended with identical data). cis_database's MariaDB copy matched what it served in 5 of 5 runs; oxmysql's MariaDB matched in 5 of 5. Errors per run: oxmysql [0, 0, 0, 0, 0], cis_database [0, 0, 0, 0, 0].

cis_database confirms a write once it is in its SQLite file (WAL, crash-safe) and copies it to MariaDB behind; oxmysql confirms once MariaDB has it. After the last workload, cis_database's MariaDB copy was complete within 944 ms (median).

## Single call (one thread, .await)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| read_player mean | µs | 1937.3 [1893.7-1988.4] | 208.3 [198.2-211.5] | 9.30x **cis** |
| read_player p50 | µs | 1646.5 [1630.7-1667.5] | 104.0 [97.0-107.9] | 15.83x **cis** |
| read_player p99 | µs | 7182.1 [6763.5-8036.5] | 2067.9 [1878.2-2513.5] | 3.47x **cis** |
| read_by_license mean | µs | 1700.5 [1696.9-1730.4] | 141.4 [135.3-142.5] | 12.03x **cis** |
| read_by_license p50 | µs | 1566.9 [1557.0-1581.4] | 80.1 [77.6-81.0] | 19.57x **cis** |
| read_by_license p99 | µs | 3986.6 [3570.3-4389.7] | 1732.2 [1635.9-1803.9] | 2.30x **cis** |
| read_vehicles mean | µs | 1843.1 [1756.2-1896.9] | 158.6 [139.7-175.6] | 11.62x **cis** |
| read_vehicles p50 | µs | 1604.1 [1585.3-1617.6] | 93.0 [84.2-101.8] | 17.25x **cis** |
| read_vehicles p99 | µs | 5342.5 [4164.6-5506.4] | 1770.3 [1650.4-2012.2] | 3.02x **cis** |
| read_messages mean | µs | 1816.8 [1765.9-1844.1] | 105.5 [92.0-113.8] | 17.22x **cis** |
| read_messages p50 | µs | 1570.9 [1533.7-1574.0] | 58.9 [52.9-59.2] | 26.66x **cis** |
| read_messages p99 | µs | 4750.9 [4668.6-5432.3] | 1609.8 [1497.0-1740.4] | 2.95x **cis** |
| json_hunger mean | µs | 1767.2 [1650.8-1807.3] | 130.7 [124.4-146.2] | 13.53x **cis** |
| json_hunger p50 | µs | 1535.0 [1510.6-1564.5] | 74.5 [67.5-81.8] | 20.60x **cis** |
| json_hunger p99 | µs | 4699.6 [3803.0-5229.5] | 1662.9 [1605.0-1754.7] | 2.83x **cis** |
| in_list mean | µs | 1805.8 [1711.4-1883.3] | 273.2 [246.9-304.1] | 6.61x **cis** |
| in_list p50 | µs | 1582.9 [1547.3-1597.8] | 143.9 [136.8-169.4] | 11.00x **cis** |
| in_list p99 | µs | 5261.3 [4114.1-6199.7] | 2146.7 [1976.8-2311.0] | 2.45x **cis** |
| count_police mean | µs | 1806.7 [1781.1-2113.6] | 360.5 [335.6-444.9] | 5.01x **cis** |
| count_police p50 | µs | 1547.2 [1515.5-1593.8] | 225.1 [219.5-251.2] | 6.87x **cis** |
| count_police p99 | µs | 5277.2 [3763.9-6293.8] | 2123.8 [1939.2-4057.6] | 2.48x **cis** |
| richest mean | µs | 14720.7 [14143.5-15344.2] | 312.3 [307.7-373.0] | 47.13x **cis** |
| richest p50 | µs | 14370.4 [13924.3-14844.1] | 108.3 [103.8-129.1] | 132.75x **cis** |
| richest p99 | µs | 20552.8 [18010.8-22785.2] | 2404.6 [1832.4-6594.1] | 8.55x **cis** |
| save_player mean | µs | 2360.9 [2264.3-2435.1] | 2412.5 [2279.1-2489.2] | 0.98x ox |
| save_player p50 | µs | 1657.5 [1620.9-1691.7] | 2001.4 [1941.8-2005.8] | 0.83x ox |
| save_player p99 | µs | 6928.0 [6022.9-7627.6] | 7918.9 [7038.9-9765.0] | 0.87x ox |
| save_inventory mean | µs | 2224.5 [2139.3-2339.9] | 2357.0 [2262.8-2428.4] | 0.94x ox |
| save_inventory p50 | µs | 1632.4 [1598.6-1663.9] | 1934.1 [1891.2-1949.8] | 0.84x ox |
| save_inventory p99 | µs | 6688.5 [6035.4-7205.1] | 8364.2 [7675.7-8681.0] | 0.80x ox |
| send_message mean | µs | 2053.4 [1935.6-2113.6] | 2220.4 [2067.7-2251.8] | 0.92x ox |
| send_message p50 | µs | 1557.4 [1527.6-1562.9] | 1830.3 [1766.8-1850.5] | 0.85x ox |
| send_message p99 | µs | 6201.0 [5896.2-9216.8] | 7343.0 [6095.2-7575.0] | 0.84x ox |
| bank_transfer mean | µs | 8052.1 [7543.8-8156.6] | 2435.4 [2403.7-2477.7] | 3.31x **cis** |
| bank_transfer p50 | µs | 7213.7 [6942.2-7332.3] | 2025.4 [1991.8-2057.9] | 3.56x **cis** |
| bank_transfer p99 | µs | 15398.4 [13183.3-15970.8] | 7998.6 [7424.9-8353.5] | 1.93x **cis** |

## Live server, 64 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 229 [226-229] | 234 [233-235] | 1.02x **cis** |
| mean latency | µs | 7769.6 [7464.2-9208.6] | 1054.8 [949.6-1129.8] | 7.37x **cis** |
| p50 latency | µs | 6592.9 [6015.8-7510.6] | 151.1 [142.5-155.3] | 43.64x **cis** |
| p99 latency | µs | 26725.7 [21590.6-29892.2] | 9077.7 [7105.9-9318.1] | 2.94x **cis** |
| max latency | µs | 75502.9 [38355.9-241234.1] | 22010.3 [15856.6-35212.1] | 3.43x **cis** |
| long frames | frames | 2 [1-3] | 0 [0-1] | inf **cis** |
| worst frame | ms | 75.6 [69.9-236.6] | 56.7 [54.4-73.8] | 1.33x **cis** |
| time past the tick | ms | 12.8 [3.0-169.8] | 0.0 [0.0-6.9] | inf **cis** |

## Live server, 128 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 452 [442-457] | 465 [463-467] | 1.03x **cis** |
| mean latency | µs | 12865.1 [11291.5-14600.6] | 1313.0 [1304.2-1442.7] | 9.80x **cis** |
| p50 latency | µs | 11096.7 [9269.0-11276.1] | 132.3 [130.2-134.5] | 83.90x **cis** |
| p99 latency | µs | 50075.1 [38470.6-56593.0] | 11791.1 [11434.5-15964.0] | 4.25x **cis** |
| max latency | µs | 124022.8 [104677.7-405556.4] | 27155.6 [21874.1-29364.2] | 4.57x **cis** |
| long frames | frames | 5 [3-6] | 0 [0-1] | inf **cis** |
| worst frame | ms | 132.0 [98.3-433.1] | 59.5 [56.3-67.0] | 2.22x **cis** |
| time past the tick | ms | 135.4 [44.1-697.6] | 0.0 [0.0-0.2] | inf **cis** |

## Live server, 256 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 867 [854-872] | 915 [912-920] | 1.05x **cis** |
| mean latency | µs | 20281.1 [17382.8-21838.6] | 2714.9 [2620.8-2818.1] | 7.47x **cis** |
| p50 latency | µs | 17095.8 [15093.9-17631.9] | 135.2 [129.4-138.7] | 126.49x **cis** |
| p99 latency | µs | 76690.5 [68531.4-108603.4] | 19007.8 [17981.3-22657.3] | 4.03x **cis** |
| max latency | µs | 127907.4 [123850.3-185102.0] | 37872.1 [32385.5-90284.4] | 3.38x **cis** |
| long frames | frames | 11 [10-14] | 0 [0-1] | inf **cis** |
| worst frame | ms | 125.1 [113.7-142.5] | 65.1 [59.1-72.0] | 1.92x **cis** |
| time past the tick | ms | 287.2 [178.3-311.6] | 0.0 [0.0-5.2] | inf **cis** |

## Join storm (128 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all joined | ms | 560.8 [523.3-584.8] | 247.4 [239.5-288.2] | 2.27x **cis** |
| p99 join | µs | 486082.5 [441362.5-499840.1] | 176184.1 [149102.0-191657.0] | 2.76x **cis** |
| long frames | frames | 1 [0-1] | 0 [0-1] | inf **cis** |
| worst frame | ms | 77.3 [57.8-107.8] | 65.4 [61.0-70.8] | 1.18x **cis** |

## Save storm (256 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all saved | ms | 654.1 [627.2-723.2] | 360.8 [310.0-407.0] | 1.81x **cis** |
| p99 save | µs | 519861.6 [505609.2-604812.8] | 267669.6 [217108.9-302327.3] | 1.94x **cis** |
| long frames | frames | 1 [1-2] | 0 [0-0] | inf **cis** |
| worst frame | ms | 118.1 [76.9-152.8] | 62.3 [59.4-66.3] | 1.90x **cis** |

## Payday loop (5000 sequential updates)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| wall time | ms | 10255.0 [9941.5-10504.1] | 10504.4 [10204.6-11004.4] | 0.98x ox |
| worst frame | ms | 95.3 [74.7-177.2] | 58.9 [58.2-60.2] | 1.62x **cis** |

## Saturation (32 threads, 10 s)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 1987 [1962-2096] | 4770 [4713-4951] | 2.40x **cis** |
| worst frame | ms | 149.3 [118.2-368.2] | 69.7 [60.0-73.3] | 2.14x **cis** |

## Bulk import

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| 20k players + 40k vehicles | ms | 6288 [6211-6524] | 8561 [8506-8799] | 0.73x ox |

## Idle server

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| tick | ms | 50.2 [50.1-50.2] | 50.1 [50.1-50.2] | 1.00x **cis** |

## FXServer hitch warnings (whole boot, startup included)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| warnings | count | 3 [1-10] | 3 [1-5] | 1.00x |
| longest | ms | 1405 [1378-1502] | 1372 [1368-1457] | 1.02x **cis** |

## CPU for the measured workload

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| FXServer | s | 58.11 [54.99-60.07] | 40.35 [39.61-41.79] | 1.44x **cis** |
| MariaDB | s | 33.29 [30.05-33.79] | 8.32 [7.88-8.65] | 4.00x **cis** |

## How it was measured

- Latency is the time around each `MySQL.*.await` call in the calling Lua thread (os.nanotime), so it includes the driver's Lua library, the export call and the wait for the answer.
- A long frame is a server tick more than 16.7 ms (one 60 Hz frame) past this boot's idle tick, measured by a `Wait(0)` thread. "Time past the tick" adds up how far those frames ran over.
- Live server: N threads each act as a player making 60 calls picked from an 80/20 read/write mix (player load, vehicles, inventory, messages, bank log, police count; saves, inventory saves, bank transfers in a transaction, messages, vehicle updates) with random think time.
- Writes are deterministic, so every driver and every run must end with the same data; the checksums above check that, and check MariaDB itself through the mysql CLI.
- Hitch warnings are FXServer's own `server thread hitch warning` console lines, counted over each boot's whole log (resource start and seed included).
- CPU is FXServer plus mariadbd process time from the idle measurement to the end of the workloads.
- Rerun on the server box, as root, from a checkout of this repository: `bash bench/run_bench.sh 5`.
