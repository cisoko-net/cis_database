#!/usr/bin/env python3
"""Turn a bench/run_bench.sh results folder into REPORT.md and summary.json.

Every number is the median of the rounds, with the min-max range beside it.
"Better" is decided per metric: lower latency, wall time, long frames and CPU;
higher calls per second. Checksums are compared across every run and driver,
and for cis_database also against MariaDB after its outbox drained.
"""
import glob
import json
import os
import re
import statistics
import sys

out = sys.argv[1]
DRIVERS = ["oxmysql", "cis_database"]


def load(pattern):
    data = {}
    for path in sorted(glob.glob(os.path.join(out, pattern))):
        base = os.path.basename(path)[:-5]
        parts = base.split("_")
        run = int(parts[-1])
        driver = "_".join(parts[1:-1])
        try:
            data.setdefault(driver, {})[run] = json.load(open(path, encoding="utf-8"))
        except ValueError:
            data.setdefault(driver, {})[run] = {}
    return data


res = load("results_*.json")
cpu = load("cpu_*.json")
maria = load("maria_*.json")


# FXServer prints "server thread hitch warning: timer interval of N milliseconds"
# when its thread was held past its timers; counted over each boot's whole log.
def load_hitches():
    data = {}
    for path in sorted(glob.glob(os.path.join(out, "log_*.txt"))):
        driver, _, run = os.path.basename(path)[len("log_"):-len(".txt")].rpartition("_")
        if not run.isdigit():
            continue
        ms = []
        for line in open(path, encoding="utf-8", errors="replace"):
            if "hitch warning" in line:
                m = re.search(r"timer interval of (\d+) milliseconds", line)
                ms.append(int(m.group(1)) if m else 0)
        data.setdefault(driver, {})[int(run)] = {"total": len(ms), "max_ms": max(ms) if ms else 0}
    return data


hitch = load_hitches()
env = open(os.path.join(out, "env.txt"), encoding="utf-8").read().strip().splitlines()
runs = sorted(set(r for d in res.values() for r in d))


def dig(d, path):
    for k in path:
        if isinstance(k, int):
            if not isinstance(d, list) or k >= len(d):
                return None
            d = d[k]
        else:
            if not isinstance(d, dict) or k not in d:
                return None
            d = d[k]
    return d


def series(driver, path, source=None):
    src = source if source is not None else res
    vals = []
    for r in runs:
        v = dig(src.get(driver, {}).get(r, {}), path)
        if isinstance(v, (int, float)):
            vals.append(float(v))
    return vals


rows = []
summary = {"env": env, "runs": runs, "metrics": []}


def metric(group, label, path, unit, better, source=None, digits=1):
    ox = series("oxmysql", path, source)
    cis = series("cis_database", path, source)
    if not ox or not cis:
        return
    mo, mc = statistics.median(ox), statistics.median(cis)
    if better == "lower":
        ratio = (mo / mc) if mc else float("inf")
        win = "cis_database" if mc < mo else ("tie" if mc == mo else "oxmysql")
    else:
        ratio = (mc / mo) if mo else float("inf")
        win = "cis_database" if mc > mo else ("tie" if mc == mo else "oxmysql")
    fmt = "%%.%df" % digits
    rows.append((group, label, unit, fmt % mo, "%s-%s" % (fmt % min(ox), fmt % max(ox)),
                 fmt % mc, "%s-%s" % (fmt % min(cis), fmt % max(cis)), ratio, win))
    summary["metrics"].append({"group": group, "metric": label, "unit": unit, "better": better,
                               "oxmysql": {"median": mo, "min": min(ox), "max": max(ox), "runs": ox},
                               "cis_database": {"median": mc, "min": min(cis), "max": max(cis), "runs": cis},
                               # A zero median makes the ratio infinite; JSON has no Infinity, so it is null.
                               "advantage": ratio if ratio != float("inf") else None, "winner": win})


LAT = ["read_player", "read_by_license", "read_vehicles", "read_messages", "json_hunger", "in_list",
       "count_police", "richest", "save_player", "save_inventory", "send_message", "bank_transfer"]
for op in LAT:
    metric("Single call (one thread, .await)", op + " mean", ["latency", op, "mean_us"], "µs", "lower")
    metric("Single call (one thread, .await)", op + " p50", ["latency", op, "p50_us"], "µs", "lower")
    metric("Single call (one thread, .await)", op + " p99", ["latency", op, "p99_us"], "µs", "lower")

for i, n in enumerate([64, 128, 256]):
    g = "Live server, %d players (80/20 mix)" % n
    metric(g, "calls per second", ["live", i, "qps"], "calls/s", "higher", digits=0)
    metric(g, "mean latency", ["live", i, "all", "mean_us"], "µs", "lower")
    metric(g, "p50 latency", ["live", i, "all", "p50_us"], "µs", "lower")
    metric(g, "p99 latency", ["live", i, "all", "p99_us"], "µs", "lower")
    metric(g, "max latency", ["live", i, "all", "max_us"], "µs", "lower")
    metric(g, "long frames", ["live", i, "frames", "long"], "frames", "lower", digits=0)
    metric(g, "worst frame", ["live", i, "frames", "max_ms"], "ms", "lower")
    metric(g, "time past the tick", ["live", i, "frames", "over_ms"], "ms", "lower")

metric("Join storm (128 players at once)", "all joined", ["join", "wall_ms"], "ms", "lower")
metric("Join storm (128 players at once)", "p99 join", ["join", "per_join", "p99_us"], "µs", "lower")
metric("Join storm (128 players at once)", "long frames", ["join", "frames", "long"], "frames", "lower", digits=0)
metric("Join storm (128 players at once)", "worst frame", ["join", "frames", "max_ms"], "ms", "lower")
metric("Save storm (256 players at once)", "all saved", ["save_storm", "wall_ms"], "ms", "lower")
metric("Save storm (256 players at once)", "p99 save", ["save_storm", "per_save", "p99_us"], "µs", "lower")
metric("Save storm (256 players at once)", "long frames", ["save_storm", "frames", "long"], "frames", "lower", digits=0)
metric("Save storm (256 players at once)", "worst frame", ["save_storm", "frames", "max_ms"], "ms", "lower")
metric("Payday loop (5000 sequential updates)", "wall time", ["payday", "wall_ms"], "ms", "lower")
metric("Payday loop (5000 sequential updates)", "worst frame", ["payday", "frames", "max_ms"], "ms", "lower")
metric("Saturation (32 threads, 10 s)", "calls per second", ["saturation", "qps"], "calls/s", "higher", digits=0)
metric("Saturation (32 threads, 10 s)", "worst frame", ["saturation", "frames", "max_ms"], "ms", "lower")
metric("Bulk import", "20k players + 40k vehicles", ["seed", "ms"], "ms", "lower", digits=0)
metric("Idle server", "tick", ["idle", "mean_ms"], "ms", "lower")
metric("FXServer hitch warnings (whole boot, startup included)", "warnings", ["total"], "count", "lower", source=hitch, digits=0)
metric("FXServer hitch warnings (whole boot, startup included)", "longest", ["max_ms"], "ms", "lower", source=hitch, digits=0)
metric("CPU for the measured workload", "FXServer", ["fxserver_s"], "s", "lower", source=cpu, digits=2)
metric("CPU for the measured workload", "MariaDB", ["mariadb_s"], "s", "lower", source=cpu, digits=2)
metric("Memory (resident)", "FXServer at idle", ["fxserver_idle_mb"], "MB", "lower", source=cpu, digits=0)
metric("Memory (resident)", "FXServer peak", ["fxserver_peak_mb"], "MB", "lower", source=cpu, digits=0)
metric("Memory (resident)", "FXServer after the workloads", ["fxserver_done_mb"], "MB", "lower", source=cpu, digits=0)
metric("Memory (resident)", "MariaDB after the workloads", ["mariadb_done_mb"], "MB", "lower", source=cpu, digits=0)

# Checksums: every run of every driver must agree, and cis_database's MariaDB
# copy must agree with what cis_database answered.
sums = {}
for d in DRIVERS:
    for r in runs:
        sums[(d, r)] = json.dumps(dig(res.get(d, {}).get(r, {}), ["checksums"]), sort_keys=True)
distinct = sorted(set(sums.values()))


def norm(doc):
    def walk(x):
        if isinstance(x, dict):
            return {k: walk(v) for k, v in x.items()}
        if isinstance(x, (int, float)):
            return float(x)
        return x
    return json.dumps(walk(doc), sort_keys=True)


maria_ok = []
for r in runs:
    a = dig(res.get("cis_database", {}).get(r, {}), ["checksums"])
    b = maria.get("cis_database", {}).get(r)
    maria_ok.append(bool(a) and bool(b) and norm(a) == norm(b))
# The bench writes are deterministic, so the rows an earlier oxmysql boot left in
# MariaDB match too. A cis_database run whose MariaDB process did next to no work
# copied nothing, and its match proves nothing: count it as a failed copy.
COPY_MIN_S = 1.0
no_copy = []
for i, r in enumerate(runs):
    s = dig(cpu.get("cis_database", {}).get(r, {}), ["mariadb_s"])
    if isinstance(s, (int, float)) and s < COPY_MIN_S:
        no_copy.append(r)
        maria_ok[i] = False
ox_maria_ok = []
for r in runs:
    a = dig(res.get("oxmysql", {}).get(r, {}), ["checksums"])
    b = maria.get("oxmysql", {}).get(r)
    ox_maria_ok.append(bool(a) and bool(b) and norm(a) == norm(b))
errors = {d: [dig(res.get(d, {}).get(r, {}), ["errors"]) for r in runs] for d in DRIVERS}
drain = series("cis_database", ["outbox_drain_ms"])
summary["checksums"] = {"distinct": len(distinct), "cis_maria_match": maria_ok, "ox_maria_match": ox_maria_ok, "cis_no_copy_runs": no_copy}
summary["errors"] = errors

wins = sum(1 for x in rows if x[8] == "cis_database")
losses = [x for x in rows if x[8] == "oxmysql"]

L = []
L.append("# cis_database vs oxmysql: real-server benchmark")
L.append("")
L.append("Same server, same resources, same Lua (`bench/cis_bench`), one driver per boot, %d rounds each, driver order alternating every round. Medians across rounds, range in brackets." % len(runs))
L.append("")
L.append("| | |")
L.append("|---|---|")
for line in env:
    k, _, v = line.partition(": ")
    L.append("| %s | %s |" % (k, v))
L.append("")
L.append("**cis_database is better on %d of %d metrics.**" % (wins, len(rows)))
if losses:
    L.append("")
    L.append("oxmysql is better on: " + ", ".join("%s / %s" % (x[0], x[1]) for x in losses) + ".")
L.append("")
L.append("Data check: %d distinct final checksum%s across all %d runs of both drivers (1 means every run ended with identical data). cis_database's MariaDB copy matched what it served in %d of %d runs; oxmysql's MariaDB matched in %d of %d. Errors per run: oxmysql %s, cis_database %s." % (
    len(distinct), "" if len(distinct) == 1 else "s", 2 * len(runs), sum(maria_ok), len(runs), sum(ox_maria_ok), len(runs),
    errors["oxmysql"], errors["cis_database"]))
if no_copy:
    L.append("")
    L.append("**cis_database copied nothing to MariaDB in run%s %s** (MariaDB used under %.0f s of CPU); those runs count as failed copies above." % (
        "" if len(no_copy) == 1 else "s", ", ".join(str(r) for r in no_copy), COPY_MIN_S))
if drain:
    L.append("")
    L.append("cis_database confirms a write once an fdatasync of its SQLite WAL covers it (the default `cis_database_ack power`; see env.txt) and copies it to MariaDB behind; oxmysql confirms once MariaDB has committed it. After the last workload, cis_database's MariaDB copy was complete within %.0f ms (median)." % statistics.median(drain))
group = None
for (g, label, unit, mo, ro, mc, rc, ratio, win) in rows:
    if g != group:
        group = g
        L.append("")
        L.append("## " + g)
        L.append("")
        L.append("| metric | unit | oxmysql | cis_database | advantage |")
        L.append("|---|---|---:|---:|---:|")
    adv = ("%.2fx" % ratio) if ratio != float("inf") else "inf"
    mark = " **cis**" if win == "cis_database" else (" ox" if win == "oxmysql" else "")
    L.append("| %s | %s | %s [%s] | %s [%s] | %s%s |" % (label, unit, mo, ro, mc, rc, adv, mark))
L.append("")
L.append("## How it was measured")
L.append("")
L.append("- Latency is the time around each `MySQL.*.await` call in the calling Lua thread (os.nanotime), so it includes the driver's Lua library, the export call and the wait for the answer.")
L.append("- A long frame is a server tick more than 16.7 ms (one 60 Hz frame) past this boot's idle tick, measured by a `Wait(0)` thread. \"Time past the tick\" adds up how far those frames ran over.")
L.append("- Live server: N threads each act as a player making 60 calls picked from an 80/20 read/write mix (player load, vehicles, inventory, messages, bank log, police count; saves, inventory saves, bank transfers in a transaction, messages, vehicle updates) with random think time.")
L.append("- Writes are deterministic, so every driver and every run must end with the same data; the checksums above check that, and check MariaDB itself through the mysql CLI.")
L.append("- Hitch warnings are FXServer's own `server thread hitch warning` console lines, counted over each boot's whole log (resource start and seed included).")
L.append("- CPU is FXServer plus mariadbd process time from the idle measurement to the end of the workloads.")
L.append("- Memory is resident memory from `/proc/<pid>/status`: FXServer `VmRSS` at the idle measurement and at the end, and its `VmHWM` peak (each pass starts a new FXServer); mariadbd keeps running across passes, so only its `VmRSS` at the end is read. cis_database's SQLite copy lives inside FXServer's memory.")
L.append("- Rerun on the server box, as root, from a checkout of this repository: `bash bench/run_bench.sh 5`.")
open(os.path.join(out, "REPORT.md"), "w", encoding="utf-8").write("\n".join(L) + "\n")
json.dump(summary, open(os.path.join(out, "summary.json"), "w", encoding="utf-8"), indent=1)
print("\n".join(L))
