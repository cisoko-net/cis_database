# cis_database vs oxmysql: real-server benchmark

Same server, same resources, same Lua (`bench/cis_bench`), one driver per boot, 5 rounds each, driver order alternating every round. Medians across rounds, range in brackets.

| | |
|---|---|
| date | 2026-10-28T08:24:32+03:00 |
| cpu | AMD EPYC 7302 16-Core Processor |
| cores | 6 |
| ram | 16 GiB |
| os | Ubuntu 24.04.5 LTS |
| fxserver | build 35245 |
| server | Qbox, its whole server.cfg |
| mariadb | server 10.11.14-MariaDB-0ubuntu0.24.04.1-log, client mysql  Ver 15.1 Distrib 10.11.14-MariaDB, for debian-linux-gnu (x86_64) using  EditLine wrapper |
| oxmysql | 2.14.3 (package ?) |
| cis_database | 1.0.0-beta.2 build 9e226f1 |
| cis_database frame budget | 25 ms (BENCH_FRAME_MS, convar cis_database_frame_ms) |
| cis_database write ack | power (default: answered after an fdatasync of the WAL) |
| bench scripts | ? (modified) |
| rounds | 5 |
| scale | 1 |
| reproduce | BENCH_DATA=<server data folder> BENCH_SERVER=qbox BENCH_DB=qbox BENCH_FXROOT=<FXServer folder> BENCH_FRAME_MS=25 bash bench/run_bench.sh 5 1 |

**cis_database is better on 60 of 78 metrics.**

oxmysql is better on: Single call (one thread, .await) / read_vehicles mean, Single call (one thread, .await) / read_vehicles p99, Single call (one thread, .await) / json_hunger mean, Single call (one thread, .await) / json_hunger p99, Single call (one thread, .await) / count_police p99, Single call (one thread, .await) / save_player mean, Single call (one thread, .await) / save_player p50, Single call (one thread, .await) / save_player p99, Single call (one thread, .await) / save_inventory mean, Single call (one thread, .await) / save_inventory p50, Single call (one thread, .await) / send_message mean, Single call (one thread, .await) / send_message p50, Single call (one thread, .await) / send_message p99, Payday loop (5000 sequential updates) / wall time, Bulk import / 20k players + 40k vehicles, Idle server / tick, FXServer hitch warnings (whole boot, startup included) / warnings, FXServer hitch warnings (whole boot, startup included) / longest.

Data check: 1 distinct final checksum across all 10 runs of both drivers (1 means every run ended with identical data). cis_database's MariaDB copy matched what it served in 5 of 5 runs; oxmysql's MariaDB matched in 5 of 5. Errors per run: oxmysql [0, 0, 0, 0, 0], cis_database [0, 0, 0, 0, 0].

cis_database confirms a write once an fdatasync of its SQLite WAL covers it (the default `cis_database_ack power`; see env.txt) and copies it to MariaDB behind; oxmysql confirms once MariaDB has committed it. After the last workload, cis_database's MariaDB copy was complete within 0 ms (median).

## Single call (one thread, .await)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| read_player mean | µs | 1874.9 [1844.7-1954.9] | 287.4 [275.6-307.2] | 6.52x **cis** |
| read_player p50 | µs | 1647.2 [1626.7-1659.3] | 118.4 [117.7-122.8] | 13.91x **cis** |
| read_player p99 | µs | 6876.6 [6019.2-7193.4] | 4607.0 [4025.6-5565.1] | 1.49x **cis** |
| read_by_license mean | µs | 1710.5 [1641.0-1713.1] | 231.0 [203.7-254.3] | 7.40x **cis** |
| read_by_license p50 | µs | 1556.9 [1545.1-1595.0] | 89.8 [76.3-96.2] | 17.35x **cis** |
| read_by_license p99 | µs | 4030.7 [3052.9-4230.1] | 2402.2 [1849.4-3311.0] | 1.68x **cis** |
| read_vehicles mean | µs | 1781.5 [1709.2-1866.0] | 2071.0 [1966.4-2109.8] | 0.86x ox |
| read_vehicles p50 | µs | 1581.8 [1551.0-1610.0] | 1572.7 [1543.1-1608.4] | 1.01x **cis** |
| read_vehicles p99 | µs | 4404.1 [4347.8-4669.9] | 8353.4 [7904.2-9091.3] | 0.53x ox |
| read_messages mean | µs | 1706.2 [1629.6-1737.8] | 165.9 [154.3-184.7] | 10.29x **cis** |
| read_messages p50 | µs | 1545.1 [1524.1-1560.0] | 73.3 [68.8-80.7] | 21.07x **cis** |
| read_messages p99 | µs | 4012.4 [3686.7-4777.0] | 1513.8 [1497.6-1620.8] | 2.65x **cis** |
| json_hunger mean | µs | 1719.7 [1671.0-1759.7] | 1888.8 [1823.7-1970.3] | 0.91x ox |
| json_hunger p50 | µs | 1526.0 [1512.1-1533.0] | 1487.8 [1480.3-1519.7] | 1.03x **cis** |
| json_hunger p99 | µs | 4369.6 [3973.8-4935.3] | 7752.9 [7301.1-7938.3] | 0.56x ox |
| in_list mean | µs | 1817.8 [1763.5-1854.9] | 359.6 [305.6-392.8] | 5.05x **cis** |
| in_list p50 | µs | 1575.8 [1558.3-1584.9] | 151.4 [138.0-167.2] | 10.41x **cis** |
| in_list p99 | µs | 5264.0 [5070.4-6136.1] | 4327.3 [2127.8-6945.2] | 1.22x **cis** |
| count_police mean | µs | 1718.4 [1681.7-1791.4] | 521.0 [515.9-530.1] | 3.30x **cis** |
| count_police p50 | µs | 1516.4 [1498.7-1547.3] | 239.4 [228.1-247.0] | 6.34x **cis** |
| count_police p99 | µs | 4338.0 [3677.8-4817.3] | 7734.1 [6883.4-10047.2] | 0.56x ox |
| richest mean | µs | 15237.3 [14696.2-16090.9] | 450.9 [351.7-585.3] | 33.79x **cis** |
| richest p50 | µs | 15238.2 [14670.1-15978.0] | 120.8 [107.3-125.8] | 126.12x **cis** |
| richest p99 | µs | 19549.7 [18990.3-21049.2] | 5707.9 [5151.2-11963.4] | 3.43x **cis** |
| save_player mean | µs | 2185.6 [2070.2-2221.0] | 2311.0 [2252.9-2354.1] | 0.95x ox |
| save_player p50 | µs | 1613.7 [1612.4-1622.7] | 1893.4 [1816.2-1948.4] | 0.85x ox |
| save_player p99 | µs | 6003.2 [5337.1-6363.5] | 7358.2 [6274.1-8291.6] | 0.82x ox |
| save_inventory mean | µs | 2085.9 [2024.6-2158.6] | 2198.6 [2098.4-2321.3] | 0.95x ox |
| save_inventory p50 | µs | 1591.7 [1581.9-1604.5] | 1851.1 [1816.2-1895.6] | 0.86x ox |
| save_inventory p99 | µs | 6428.4 [5222.7-6596.9] | 6115.9 [5681.7-7417.6] | 1.05x **cis** |
| send_message mean | µs | 1922.7 [1901.8-2041.2] | 2018.0 [1971.1-2156.8] | 0.95x ox |
| send_message p50 | µs | 1519.8 [1508.4-1546.9] | 1743.1 [1671.9-1764.2] | 0.87x ox |
| send_message p99 | µs | 5146.0 [4862.6-6450.0] | 5997.2 [5113.0-7816.6] | 0.86x ox |
| bank_transfer mean | µs | 7514.0 [7250.5-7697.0] | 2433.8 [2248.5-2469.9] | 3.09x **cis** |
| bank_transfer p50 | µs | 6886.1 [6717.9-6948.8] | 2062.8 [1939.3-2106.7] | 3.34x **cis** |
| bank_transfer p99 | µs | 12945.5 [12658.7-14469.2] | 7103.3 [6242.5-7817.7] | 1.82x **cis** |

## Live server, 64 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 228 [227-231] | 232 [231-233] | 1.02x **cis** |
| mean latency | µs | 7262.3 [6937.7-7894.8] | 2126.0 [2084.4-2457.2] | 3.42x **cis** |
| p50 latency | µs | 6050.0 [5963.4-6736.8] | 216.4 [206.7-224.5] | 27.96x **cis** |
| p99 latency | µs | 25532.2 [17835.2-45769.0] | 16607.1 [13259.0-17511.1] | 1.54x **cis** |
| max latency | µs | 69844.3 [45156.5-173971.9] | 58371.7 [54601.5-99445.4] | 1.20x **cis** |
| long frames | frames | 2 [1-2] | 0 [0-0] | inf **cis** |
| worst frame | ms | 97.5 [68.1-179.0] | 55.9 [54.2-58.4] | 1.74x **cis** |
| time past the tick | ms | 38.6 [1.7-112.2] | 0.0 [0.0-0.0] | inf **cis** |

## Live server, 128 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 453 [448-455] | 464 [463-464] | 1.02x **cis** |
| mean latency | µs | 11962.2 [10778.0-12940.3] | 2767.0 [2617.6-3191.1] | 4.32x **cis** |
| p50 latency | µs | 9412.1 [9097.6-10391.1] | 161.8 [155.2-172.8] | 58.18x **cis** |
| p99 latency | µs | 46398.8 [31135.1-116898.9] | 18952.9 [17342.1-20571.2] | 2.45x **cis** |
| max latency | µs | 212612.6 [96205.0-378138.1] | 56425.9 [53381.3-61754.2] | 3.77x **cis** |
| long frames | frames | 5 [3-6] | 0 [0-0] | inf **cis** |
| worst frame | ms | 236.6 [108.0-374.3] | 56.7 [55.1-60.3] | 4.18x **cis** |
| time past the tick | ms | 361.1 [81.4-650.5] | 0.0 [0.0-0.0] | inf **cis** |

## Live server, 256 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 864 [841-869] | 906 [901-915] | 1.05x **cis** |
| mean latency | µs | 19375.2 [18313.0-20018.7] | 5604.6 [5286.5-6310.9] | 3.46x **cis** |
| p50 latency | µs | 16311.5 [14494.5-16478.9] | 255.9 [238.9-1565.6] | 63.74x **cis** |
| p99 latency | µs | 79972.8 [70402.8-100439.7] | 31356.1 [27902.8-35688.4] | 2.55x **cis** |
| max latency | µs | 169195.2 [147253.0-605303.5] | 73392.9 [62065.5-84549.8] | 2.31x **cis** |
| long frames | frames | 9 [4-14] | 0 [0-1] | inf **cis** |
| worst frame | ms | 143.5 [120.2-569.2] | 58.9 [56.6-70.8] | 2.44x **cis** |
| time past the tick | ms | 318.9 [170.8-761.0] | 0.0 [0.0-3.9] | inf **cis** |

## Join storm (128 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all joined | ms | 466.9 [447.6-506.9] | 339.4 [292.2-345.8] | 1.38x **cis** |
| p99 join | µs | 439669.2 [364591.9-456913.9] | 242284.5 [224625.7-254483.5] | 1.81x **cis** |
| long frames | frames | 1 [0-2] | 0 [0-1] | inf **cis** |
| worst frame | ms | 66.9 [55.7-172.3] | 61.2 [60.9-67.0] | 1.09x **cis** |

## Save storm (256 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all saved | ms | 523.8 [458.1-702.9] | 454.1 [450.7-499.2] | 1.15x **cis** |
| p99 save | µs | 400591.0 [348540.7-566458.0] | 354279.4 [335568.9-415361.2] | 1.13x **cis** |
| long frames | frames | 1 [0-2] | 0 [0-0] | inf **cis** |
| worst frame | ms | 70.1 [56.4-125.8] | 59.5 [58.2-61.4] | 1.18x **cis** |

## Payday loop (5000 sequential updates)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| wall time | ms | 9399.8 [9121.8-9671.3] | 10012.1 [9673.8-10405.2] | 0.94x ox |
| worst frame | ms | 114.2 [80.4-390.0] | 58.9 [55.2-66.3] | 1.94x **cis** |

## Saturation (32 threads, 10 s)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 1972 [1763-2079] | 2945 [2652-3030] | 1.49x **cis** |
| worst frame | ms | 154.7 [131.1-699.1] | 100.9 [81.9-121.5] | 1.53x **cis** |

## Bulk import

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| 20k players + 40k vehicles | ms | 6262 [6220-6505] | 9797 [9690-10043] | 0.64x ox |

## Idle server

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| tick | ms | 50.1 [50.1-50.1] | 50.2 [50.1-50.2] | 1.00x ox |

## FXServer hitch warnings (whole boot, startup included)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| warnings | count | 2 [1-13] | 14 [2-17] | 0.14x ox |
| longest | ms | 264 [155-699] | 298 [162-484] | 0.89x ox |

## CPU for the measured workload

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| FXServer | s | 54.87 [53.06-55.88] | 45.24 [44.47-47.73] | 1.21x **cis** |
| MariaDB | s | 31.14 [30.38-31.63] | 13.01 [12.64-13.77] | 2.39x **cis** |

## How it was measured

- Latency is the time around each `MySQL.*.await` call in the calling Lua thread (os.nanotime), so it includes the driver's Lua library, the export call and the wait for the answer.
- A long frame is a server tick more than 16.7 ms (one 60 Hz frame) past this boot's idle tick, measured by a `Wait(0)` thread. "Time past the tick" adds up how far those frames ran over.
- Live server: N threads each act as a player making 60 calls picked from an 80/20 read/write mix (player load, vehicles, inventory, messages, bank log, police count; saves, inventory saves, bank transfers in a transaction, messages, vehicle updates) with random think time.
- Writes are deterministic, so every driver and every run must end with the same data; the checksums above check that, and check MariaDB itself through the mysql CLI.
- Hitch warnings are FXServer's own `server thread hitch warning` console lines, counted over each boot's whole log (resource start and seed included).
- CPU is FXServer plus mariadbd process time from the idle measurement to the end of the workloads.
- Rerun on the server box, as root, from a checkout of this repository: `bash bench/run_bench.sh 5`.
