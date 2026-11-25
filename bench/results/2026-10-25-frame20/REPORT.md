# cis_database vs oxmysql: real-server benchmark

Same server, same resources, same Lua (`bench/cis_bench`), one driver per boot, 5 rounds each, driver order alternating every round. Medians across rounds, range in brackets.

| | |
|---|---|
| date | 2026-10-25T00:15:14+03:00 |
| cpu | AMD EPYC 7302 16-Core Processor |
| cores | 6 |
| ram | 16 GiB |
| os | Ubuntu 24.04.5 LTS |
| fxserver | build 35245 |
| server | Qbox, its whole server.cfg |
| mariadb | mysql  Ver 15.1 Distrib 10.11.14-MariaDB, for debian-linux-gnu (x86_64) using  EditLine wrapper |
| oxmysql | 2.14.3 (package ?) |
| cis_database | pre-release build 2c51f67 |
| cis_database frame budget | 20 ms (BENCH_FRAME_MS, convar cis_database_frame_ms) |
| rounds | 5 |
| scale | 1 |

**cis_database is better on 66 of 78 metrics.**

oxmysql is better on: Single call (one thread, .await) / in_list p99, Single call (one thread, .await) / count_police p99, Single call (one thread, .await) / save_player p50, Single call (one thread, .await) / save_player p99, Single call (one thread, .await) / save_inventory mean, Single call (one thread, .await) / save_inventory p50, Single call (one thread, .await) / save_inventory p99, Single call (one thread, .await) / send_message mean, Single call (one thread, .await) / send_message p50, Payday loop (5000 sequential updates) / wall time, Bulk import / 20k players + 40k vehicles, Idle server / tick.

Data check: 1 distinct final checksum across all 10 runs of both drivers (1 means every run ended with identical data). cis_database's MariaDB copy matched what it served in 5 of 5 runs; oxmysql's MariaDB matched in 5 of 5. Errors per run: oxmysql [0, 0, 0, 0, 0], cis_database [0, 0, 0, 0, 0].

cis_database confirms a write once it is in its SQLite file (WAL, crash-safe) and copies it to MariaDB behind; oxmysql confirms once MariaDB has it. After the last workload, cis_database's MariaDB copy was complete within 422 ms (median).

## Single call (one thread, .await)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| read_player mean | µs | 1971.4 [1901.5-2000.4] | 301.4 [297.8-335.7] | 6.54x **cis** |
| read_player p50 | µs | 1639.4 [1633.7-1678.6] | 105.2 [98.0-106.8] | 15.58x **cis** |
| read_player p99 | µs | 7804.8 [6554.8-8189.2] | 4520.3 [3393.5-7312.8] | 1.73x **cis** |
| read_by_license mean | µs | 1787.5 [1750.4-1838.5] | 229.4 [211.5-261.1] | 7.79x **cis** |
| read_by_license p50 | µs | 1593.9 [1568.1-1607.7] | 80.2 [72.3-90.8] | 19.87x **cis** |
| read_by_license p99 | µs | 4701.3 [4293.2-5076.6] | 1757.3 [1663.6-2089.9] | 2.68x **cis** |
| read_vehicles mean | µs | 1825.0 [1807.9-1919.4] | 257.4 [235.9-290.1] | 7.09x **cis** |
| read_vehicles p50 | µs | 1618.7 [1600.6-1619.7] | 90.1 [87.2-99.9] | 17.97x **cis** |
| read_vehicles p99 | µs | 4776.3 [4411.5-5499.8] | 1727.1 [1652.9-1915.9] | 2.77x **cis** |
| read_messages mean | µs | 1818.9 [1761.5-1840.4] | 163.6 [160.8-179.3] | 11.12x **cis** |
| read_messages p50 | µs | 1561.2 [1553.7-1577.9] | 57.9 [55.6-61.5] | 26.98x **cis** |
| read_messages p99 | µs | 4966.4 [4802.0-5122.1] | 1628.6 [1550.4-1645.8] | 3.05x **cis** |
| json_hunger mean | µs | 1768.3 [1697.7-1803.5] | 230.2 [207.6-237.6] | 7.68x **cis** |
| json_hunger p50 | µs | 1541.4 [1528.3-1582.5] | 77.1 [66.7-82.4] | 19.98x **cis** |
| json_hunger p99 | µs | 4818.3 [3994.5-5794.0] | 1855.9 [1682.8-2047.1] | 2.60x **cis** |
| in_list mean | µs | 1834.6 [1777.5-1944.0] | 406.9 [403.3-434.0] | 4.51x **cis** |
| in_list p50 | µs | 1596.2 [1583.9-1608.9] | 142.0 [134.0-148.6] | 11.24x **cis** |
| in_list p99 | µs | 5708.2 [5000.2-5763.0] | 6542.9 [4210.7-8990.9] | 0.87x ox |
| count_police mean | µs | 1789.6 [1705.8-2009.5] | 616.4 [553.4-650.8] | 2.90x **cis** |
| count_police p50 | µs | 1546.6 [1528.4-1566.1] | 229.9 [225.0-249.0] | 6.73x **cis** |
| count_police p99 | µs | 4338.9 [4054.9-4926.6] | 19728.0 [2360.7-24062.4] | 0.22x ox |
| richest mean | µs | 14519.0 [14224.0-14972.2] | 530.8 [444.9-553.9] | 27.35x **cis** |
| richest p50 | µs | 14339.5 [13973.9-14779.1] | 123.3 [100.1-130.0] | 116.31x **cis** |
| richest p99 | µs | 19256.0 [18439.2-23888.2] | 12072.3 [1985.3-12961.9] | 1.60x **cis** |
| save_player mean | µs | 2400.5 [2311.4-2548.5] | 2308.6 [2171.6-2464.0] | 1.04x **cis** |
| save_player p50 | µs | 1708.3 [1655.2-1740.8] | 1957.7 [1894.1-2041.4] | 0.87x ox |
| save_player p99 | µs | 7281.9 [6628.7-7486.3] | 7283.7 [6066.6-7483.1] | 1.00x ox |
| save_inventory mean | µs | 2252.4 [2232.7-2302.7] | 2383.9 [2270.0-2492.0] | 0.94x ox |
| save_inventory p50 | µs | 1645.1 [1637.0-1667.5] | 1924.2 [1892.9-2023.8] | 0.85x ox |
| save_inventory p99 | µs | 6465.3 [6213.6-7806.7] | 8546.2 [8024.3-9914.8] | 0.76x ox |
| send_message mean | µs | 2074.2 [2016.1-2193.0] | 2144.7 [2115.3-2261.6] | 0.97x ox |
| send_message p50 | µs | 1575.0 [1558.3-1583.3] | 1805.9 [1786.5-1850.2] | 0.87x ox |
| send_message p99 | µs | 6612.2 [6037.3-7133.8] | 6462.6 [6280.6-7882.8] | 1.02x **cis** |
| bank_transfer mean | µs | 7859.2 [7737.7-7974.0] | 2452.9 [2413.6-2488.9] | 3.20x **cis** |
| bank_transfer p50 | µs | 7058.0 [7014.9-7066.8] | 2028.9 [2011.0-2054.3] | 3.48x **cis** |
| bank_transfer p99 | µs | 14940.2 [14460.6-15800.5] | 7790.8 [6838.5-8507.3] | 1.92x **cis** |

## Live server, 64 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 226 [224-227] | 233 [233-234] | 1.03x **cis** |
| mean latency | µs | 8040.9 [7892.7-8486.6] | 1028.9 [1002.6-1125.5] | 7.82x **cis** |
| p50 latency | µs | 6731.1 [6576.1-6942.6] | 149.9 [145.2-153.8] | 44.91x **cis** |
| p99 latency | µs | 24437.4 [23733.5-25896.2] | 8624.2 [8169.3-13004.4] | 2.83x **cis** |
| max latency | µs | 129963.9 [48570.0-284391.7] | 19163.8 [17743.9-24866.9] | 6.78x **cis** |
| long frames | frames | 1 [0-2] | 0 [0-0] | inf **cis** |
| worst frame | ms | 136.1 [53.9-304.9] | 58.0 [55.2-65.1] | 2.35x **cis** |
| time past the tick | ms | 78.5 [0.0-238.1] | 0.0 [0.0-0.0] | inf **cis** |

## Live server, 128 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 450 [447-457] | 465 [463-466] | 1.03x **cis** |
| mean latency | µs | 13427.5 [11286.8-14700.7] | 1317.6 [1258.6-1419.2] | 10.19x **cis** |
| p50 latency | µs | 11395.9 [9048.2-11523.6] | 131.6 [130.0-135.3] | 86.61x **cis** |
| p99 latency | µs | 55413.6 [42150.0-98099.5] | 11585.8 [10699.0-13807.5] | 4.78x **cis** |
| max latency | µs | 121448.1 [97749.9-380694.5] | 31799.6 [18659.2-40898.6] | 3.82x **cis** |
| long frames | frames | 4 [2-5] | 0 [0-0] | inf **cis** |
| worst frame | ms | 168.6 [102.6-305.4] | 58.8 [56.0-62.7] | 2.87x **cis** |
| time past the tick | ms | 182.6 [88.2-302.7] | 0.0 [0.0-0.0] | inf **cis** |

## Live server, 256 players (80/20 mix)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 862 [839-869] | 915 [913-920] | 1.06x **cis** |
| mean latency | µs | 22068.5 [21094.4-22731.1] | 2767.6 [2596.7-3059.6] | 7.97x **cis** |
| p50 latency | µs | 18171.3 [17191.7-19025.2] | 135.5 [132.6-137.7] | 134.13x **cis** |
| p99 latency | µs | 93848.7 [75651.2-106049.8] | 20791.9 [18515.8-21170.1] | 4.51x **cis** |
| max latency | µs | 161584.2 [133591.2-521393.3] | 33838.0 [31908.9-38869.3] | 4.78x **cis** |
| long frames | frames | 13 [7-14] | 0 [0-0] | inf **cis** |
| worst frame | ms | 423.6 [130.7-514.2] | 59.7 [56.9-64.4] | 7.10x **cis** |
| time past the tick | ms | 673.3 [279.3-760.7] | 0.0 [0.0-0.0] | inf **cis** |

## Join storm (128 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all joined | ms | 565.4 [459.2-611.4] | 338.1 [330.3-385.9] | 1.67x **cis** |
| p99 join | µs | 507778.7 [402877.3-548451.2] | 274780.8 [251559.0-314263.5] | 1.85x **cis** |
| long frames | frames | 1 [0-2] | 0 [0-0] | inf **cis** |
| worst frame | ms | 93.5 [63.8-168.4] | 56.0 [54.4-57.5] | 1.67x **cis** |

## Save storm (256 players at once)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| all saved | ms | 624.7 [522.8-739.6] | 554.1 [514.1-607.8] | 1.13x **cis** |
| p99 save | µs | 531332.6 [418074.0-643135.1] | 454678.6 [420095.9-509760.4] | 1.17x **cis** |
| long frames | frames | 1 [0-1] | 0 [0-1] | inf **cis** |
| worst frame | ms | 68.7 [55.1-119.7] | 58.6 [56.1-71.5] | 1.17x **cis** |

## Payday loop (5000 sequential updates)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| wall time | ms | 10307.8 [10097.0-10574.1] | 10998.2 [10299.9-11890.4] | 0.94x ox |
| worst frame | ms | 162.2 [83.1-193.2] | 61.1 [58.2-64.9] | 2.65x **cis** |

## Saturation (32 threads, 10 s)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| calls per second | calls/s | 1990 [1871-2048] | 2690 [2507-2781] | 1.35x **cis** |
| worst frame | ms | 143.4 [117.9-384.8] | 60.3 [53.2-108.3] | 2.38x **cis** |

## Bulk import

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| 20k players + 40k vehicles | ms | 6145 [6056-6523] | 10176 [10089-10535] | 0.60x ox |

## Idle server

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| tick | ms | 50.1 [50.1-50.1] | 50.2 [50.2-50.3] | 1.00x ox |

## FXServer hitch warnings (whole boot, startup included)

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| warnings | count | 8 [1-14] | 2 [1-3] | 4.00x **cis** |
| longest | ms | 1445 [1403-1519] | 1361 [1250-1407] | 1.06x **cis** |

## CPU for the measured workload

| metric | unit | oxmysql | cis_database | advantage |
|---|---|---:|---:|---:|
| FXServer | s | 59.54 [57.88-59.96] | 38.48 [37.19-39.51] | 1.55x **cis** |
| MariaDB | s | 33.31 [32.07-34.08] | 7.93 [7.71-8.55] | 4.20x **cis** |

## How it was measured

- Latency is the time around each `MySQL.*.await` call in the calling Lua thread (os.nanotime), so it includes the driver's Lua library, the export call and the wait for the answer.
- A long frame is a server tick more than 16.7 ms (one 60 Hz frame) past this boot's idle tick, measured by a `Wait(0)` thread. "Time past the tick" adds up how far those frames ran over.
- Live server: N threads each act as a player making 60 calls picked from an 80/20 read/write mix (player load, vehicles, inventory, messages, bank log, police count; saves, inventory saves, bank transfers in a transaction, messages, vehicle updates) with random think time.
- Writes are deterministic, so every driver and every run must end with the same data; the checksums above check that, and check MariaDB itself through the mysql CLI.
- Hitch warnings are FXServer's own `server thread hitch warning` console lines, counted over each boot's whole log (resource start and seed included).
- CPU is FXServer plus mariadbd process time from the idle measurement to the end of the workloads.
- Rerun on the server box, as root, from a checkout of this repository: `bash bench/run_bench.sh 5`.
