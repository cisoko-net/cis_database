#!/usr/bin/env python3
"""Split the FXServer hitch warnings of bench runs by bench phase.

The console logs carry no timestamps, so a hitch is placed by log order:
FXServer prints the warning once the stalled frame ends, which puts it in the
phase whose end marker comes after it.

    python3 bench/hitch_phases.py 20=$BENCH_DIR/bench_frame20 25=$BENCH_DIR/bench_<date>

Prints JSON: budget -> driver -> run -> {phases: {name: [ms, ...]}, missing_markers}.
"""
import glob
import json
import os
import re
import sys

# (phase, line that ends it), in the order cis_bench/server.lua prints them.
PHASES = [
    ("start", r"\[cis_bench\] start driver="),
    ("seed", r"\[cis_bench\] seed \d+ players"),
    ("idle", r"\[cis_bench\] idle tick"),
    ("single", r"\[cis_bench\] latency bank_transfer"),
    ("live64", r"\[cis_bench\] live 64 players"),
    ("live128", r"\[cis_bench\] live 128 players"),
    ("live256", r"\[cis_bench\] live 256 players"),
    ("join", r"\[cis_bench\] join storm"),
    ("save", r"\[cis_bench\] save storm"),
    ("payday", r"\[cis_bench\] payday \d+"),
    ("saturation", r"\[cis_bench\] saturation \d+ threads"),
    ("end", r"\[cis_bench\] BENCH_DONE"),
]
HITCH = re.compile(r"server thread hitch warning: timer interval of (\d+) milliseconds")

out = {}
for arg in sys.argv[1:]:
    budget, folder = arg.split("=", 1)
    for path in sorted(glob.glob(os.path.join(folder, "log_*_*.txt"))):
        driver, _, run = os.path.basename(path)[4:-4].rpartition("_")
        counts = {name: [] for name, _ in PHASES}
        counts["after"] = []
        i = 0
        for line in open(path, errors="replace"):
            m = HITCH.search(line)
            if m:
                counts[PHASES[i][0] if i < len(PHASES) else "after"].append(int(m.group(1)))
            elif i < len(PHASES) and re.search(PHASES[i][1], line):
                i += 1
        missing = [name for name, _ in PHASES[i:]]
        out.setdefault(budget, {}).setdefault(driver, {})[run] = {"phases": counts, "missing_markers": missing}
json.dump(out, sys.stdout, indent=1)
print()
