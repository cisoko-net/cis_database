#!/usr/bin/env python3
"""Turn a bench/run_gens.sh results folder into GENS.md and gens.json.

One column per contender, in the order given on the command line. Each cell
is the median across rounds (the range is in gens.json). The best value of a
row is bold; the last column is the last contender against the first, so
`g0=... g1=...` reads as "what g1 changed". Checksums must be identical for
every pass, and each cis_database pass's MariaDB copy must match what it served.
"""
import glob
import json
import os
import re
import statistics
import sys

out = sys.argv[1]
labels = [l.strip() for l in open(os.path.join(out, "labels.txt"), encoding="utf-8") if l.strip()]
env = open(os.path.join(out, "env.txt"), encoding="utf-8").read().strip().splitlines()


def load(prefix):
    data = {}
    for l in labels:
        for path in glob.glob(os.path.join(out, "%s_%s_*.json" % (prefix, l))):
            tail = os.path.basename(path)[len(prefix) + len(l) + 2:-5]
            if not tail.isdigit():
                continue
            try:
                data.setdefault(l, {})[int(tail)] = json.load(open(path, encoding="utf-8"))
            except ValueError:
                data.setdefault(l, {})[int(tail)] = {}
    return data


res = load("results")
cpu = load("cpu")
maria = load("maria")


# FXServer prints "server thread hitch warning: timer interval of N milliseconds"
# when its thread was held past its timers; counted over the whole pass log.
def load_hitches():
    data = {}
    for l in labels:
        for path in glob.glob(os.path.join(out, "log_%s_*.txt" % l)):
            tail = os.path.basename(path)[len("log_") + len(l) + 1:-4]
            if not tail.isdigit():
                continue
            ms = []
            for line in open(path, encoding="utf-8", errors="replace"):
                if "hitch warning" in line:
                    m = re.search(r"timer interval of (\d+) milliseconds", line)
                    ms.append(int(m.group(1)) if m else 0)
            data.setdefault(l, {})[int(tail)] = {"total": len(ms), "max_ms": max(ms) if ms else 0}
    return data


hitch = load_hitches()
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


def series(label, path, source):
    vals = []
    for r in runs:
        v = dig(source.get(label, {}).get(r, {}), path)
        if isinstance(v, (int, float)):
            vals.append(float(v))
    return vals


groups = []
summary = {"env": env, "labels": labels, "runs": runs, "metrics": []}


def metric(group, name, path, unit, better, source=None, digits=1):
    src = source if source is not None else res
    cells = {}
    for l in labels:
        s = series(l, path, src)
        if s:
            cells[l] = {"median": statistics.median(s), "min": min(s), "max": max(s), "runs": s}
    if len(cells) < 1:
        return
    vals = {l: c["median"] for l, c in cells.items()}
    best = (min if better == "lower" else max)(vals.values())
    first, last = labels[0], labels[-1]
    change = None
    if first in vals and last in vals and first != last:
        a, b = vals[first], vals[last]
        if better == "lower":
            change = (a / b) if b else None
        else:
            change = (b / a) if a else None
    if not groups or groups[-1][0] != group:
        groups.append((group, []))
    groups[-1][1].append((name, unit, vals, best, change, digits))
    summary["metrics"].append({"group": group, "metric": name, "unit": unit, "better": better,
                               "values": cells, "best": best, "last_vs_first": change})


LAT = ["read_player", "read_by_license", "read_vehicles", "read_messages", "json_hunger", "in_list",
       "count_police", "richest", "save_player", "save_inventory", "send_message", "bank_transfer"]
for op in LAT:
    metric("Single call (one thread, .await)", op + " mean", ["latency", op, "mean_us"], "µs", "lower")
    metric("Single call (one thread, .await)", op + " p99", ["latency", op, "p99_us"], "µs", "lower")
    metric("Single call (one thread, .await)", op + " long frames", ["latency", op, "frames", "long"], "frames", "lower", digits=0)
for i, n in enumerate([64, 128, 256]):
    g = "Live server, %d players (80/20 mix)" % n
    metric(g, "calls per second", ["live", i, "qps"], "calls/s", "higher", digits=0)
    metric(g, "mean latency", ["live", i, "all", "mean_us"], "µs", "lower")
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
metric("Payday loop (5000 sequential updates)", "long frames", ["payday", "frames", "long"], "frames", "lower", digits=0)
metric("Payday loop (5000 sequential updates)", "worst frame", ["payday", "frames", "max_ms"], "ms", "lower")
metric("Saturation (32 threads, 10 s)", "calls per second", ["saturation", "qps"], "calls/s", "higher", digits=0)
metric("Saturation (32 threads, 10 s)", "long frames", ["saturation", "frames", "long"], "frames", "lower", digits=0)
metric("Saturation (32 threads, 10 s)", "worst frame", ["saturation", "frames", "max_ms"], "ms", "lower")
metric("Bulk import", "20k players + 40k vehicles", ["seed", "ms"], "ms", "lower", digits=0)
metric("Bulk import", "long frames", ["seed", "frames", "long"], "frames", "lower", digits=0)
metric("Bulk import", "worst frame", ["seed", "frames", "max_ms"], "ms", "lower")
metric("FXServer hitch warnings (whole pass, boot included)", "warnings", ["total"], "count", "lower", source=hitch, digits=0)
metric("FXServer hitch warnings (whole pass, boot included)", "longest", ["max_ms"], "ms", "lower", source=hitch, digits=0)
metric("Idle server", "tick", ["idle", "mean_ms"], "ms", "lower")
metric("Idle server", "worst frame", ["idle", "max_ms"], "ms", "lower")
metric("CPU for the measured workload", "FXServer", ["fxserver_s"], "s", "lower", source=cpu, digits=2)
metric("CPU for the measured workload", "MariaDB", ["mariadb_s"], "s", "lower", source=cpu, digits=2)
metric("CPU for the measured workload", "boot to done", ["boot_to_done_s"], "s", "lower", source=cpu, digits=0)


def norm(doc):
    def walk(x):
        if isinstance(x, dict):
            return {k: walk(v) for k, v in x.items()}
        if isinstance(x, (int, float)):
            return float(x)
        return x
    return json.dumps(walk(doc), sort_keys=True)


sums = set()
maria_ok, passes = 0, 0
errors = {}
for l in labels:
    for r in runs:
        doc = res.get(l, {}).get(r)
        if doc is None:
            continue
        passes += 1
        sums.add(norm(dig(doc, ["checksums"])))
        if norm(dig(doc, ["checksums"])) == norm(maria.get(l, {}).get(r) or {}):
            maria_ok += 1
        errors.setdefault(l, []).append(dig(doc, ["errors"]))
summary["checksums"] = {"distinct": len(sums), "maria_match": maria_ok, "passes": passes}
summary["errors"] = errors

L = ["# cis_database generations: real-server shootout", ""]
L.append("Contenders: %s. %d round%s; one contender per boot, order rotating, every boot clean (page cache dropped; cis_database starts from an empty cache/ hydrated from MariaDB). Median across rounds; best in bold; the last column is %s against %s (above 1 means %s is better)." % (
    ", ".join("`%s`" % l for l in labels), len(runs), "" if len(runs) == 1 else "s", labels[-1], labels[0], labels[-1]))
L.append("")
L.append("| | |")
L.append("|---|---|")
for line in env:
    k, _, v = line.partition(": ")
    L.append("| %s | %s |" % (k, v))
L.append("")
L.append("Data check: %d distinct final checksum%s over %d passes (1 means every pass ended with identical data); MariaDB matched what the driver served in %d of %d passes. Errors: %s." % (
    len(sums), "" if len(sums) == 1 else "s", passes, maria_ok, passes, json.dumps(errors)))
for g, rows in groups:
    L.append("")
    L.append("## " + g)
    L.append("")
    L.append("| metric | unit | " + " | ".join(labels) + " | %s / %s |" % (labels[-1], labels[0]))
    L.append("|---|---|" + "---:|" * (len(labels) + 1))
    for name, unit, vals, best, change, digits in rows:
        fmt = "%%.%df" % digits
        cells = []
        for l in labels:
            if l not in vals:
                cells.append("")
            elif vals[l] == best:
                cells.append("**" + fmt % vals[l] + "**")
            else:
                cells.append(fmt % vals[l])
        ch = "" if change is None else "%.2fx" % change
        L.append("| %s | %s | %s | %s |" % (name, unit, " | ".join(cells), ch))
L.append("")
open(os.path.join(out, "GENS.md"), "w", encoding="utf-8").write("\n".join(L) + "\n")
json.dump(summary, open(os.path.join(out, "gens.json"), "w", encoding="utf-8"), indent=1)
print("\n".join(L))
