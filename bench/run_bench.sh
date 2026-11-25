#!/usr/bin/env bash
# Runs bench/cis_bench against oxmysql and cis_database on a real FXServer,
# one driver per boot, ROUNDS rounds, alternating which driver goes first so
# drift on the box hits both equally. The whole server.cfg runs every time
# (frameworks and all their resources); only the database driver changes.
#
#   bench/run_bench.sh [rounds=5] [scale=1]
#
# Run as root on the server box. BENCH_DATA (your server-data folder) is
# required; by default the server is driven through its txAdmin systemd unit.
# The server that was running before is stopped first and started again at
# the end. See bench/README.md.
#
# Env: the BENCH_* variables in bench/server.sh (data folder, server, unit,
# oxmysql, log, database, players, restore), and:
#   BENCH_CIS_TRACE=1   turn on cis_database_frame_trace for the cis_database
#                       passes and keep its frame_trace JSON (costs a little)
#   BENCH_ONLY=driver   run only that driver's passes (oxmysql or cis_database)
#   BENCH_FRAME_MS=ms   cis_database frame budget for its passes, written to
#                       server.cfg as the convar cis_database_frame_ms (unset:
#                       the server.cfg convar if there is one, else config.json)
#   BENCH_FIRST_ROUND=n start at round n; with BENCH_OUT set to an earlier
#                       run's folder this finishes that run (its env.txt is
#                       kept as env_rounds_before_<n>.txt)
#
# server.cfg is copied first and put back on exit, whatever happens.
set -euo pipefail

ROUNDS=${1:-5}
SCALE=${2:-1}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${BENCH_OUT:-${BENCH_DIR:-$HOME/bench}/bench_$(date +%Y%m%d-%H%M%S)}

say() { echo "[bench] $*"; }
die() { echo "[bench] FAIL: $*" >&2; exit 1; }

. "$HERE/server.sh"

[[ $(id -u) == 0 ]] || die "run as root on the server box"
[[ -f "$CFG" ]] || die "no server.cfg at $CFG"
CISDIR=$(find "$DATA/resources" -maxdepth 3 -type d -name cis_database -print -quit)
[[ -n "$CISDIR" ]] || die "cis_database is not installed under $DATA/resources"

FIRST=${BENCH_FIRST_ROUND:-1}
[[ $FIRST =~ ^[1-9][0-9]*$ ]] && (( FIRST <= ROUNDS )) || die "BENCH_FIRST_ROUND must be 1 to $ROUNDS"
[[ -z ${BENCH_FRAME_MS:-} || $BENCH_FRAME_MS =~ ^[0-9]+$ ]] || die "BENCH_FRAME_MS must be whole milliseconds"

mkdir -p "$OUT"
chmod 700 "$OUT"
if (( FIRST > 1 )) && [[ -f "$OUT/env.txt" ]]; then
    mv "$OUT/env.txt" "$OUT/env_rounds_before_$FIRST.txt"
fi
# The copy holds the server's secrets: it stays in $OUT (root only) and is
# never part of the published report.
cp -a "$CFG" "$OUT/server.cfg.orig"

restore() {
    local code=$?
    trap - EXIT
    set +e
    fx_stop
    cp -a "$OUT/server.cfg.orig" "$CFG"
    rm -rf "$RES"
    oxmysql_out
    give_back_box
    log_unfollow
    exit $code
}
trap restore EXIT

set_include() {
    local driver=$1
    sed -i "/BENCH_INCLUDE/{n;s#'@[a-z_]*/lib/MySQL.lua'#'@${driver}/lib/MySQL.lua'#}" "$RES/fxmanifest.lua"
}

# The original cfg with: no ensure of either driver where it was, then the
# bench convars and the chosen driver before ox_lib, and cis_bench last.
set_cfg() {
    local driver=$1 run=$2
    python3 - "$OUT/server.cfg.orig" "$CFG" "$driver" "$run" "$SCALE" "${BENCH_CIS_TRACE:-0}" "${BENCH_FRAME_MS:-}" <<'PY'
import re, sys
src, dst, driver, run, scale, trace, frame_ms = sys.argv[1:8]
text = open(src, encoding="utf-8").read()
text = re.sub(r"(?m)^[ \t]*#?[ \t]*ensure[ \t]+(cis_database|oxmysql|cis_bench)[ \t]*(#.*)?$", "", text)
needle = re.search(r"(?m)^[ \t]*ensure[ \t]+ox_lib\b.*$", text)
if not needle:
    raise SystemExit("server.cfg has no 'ensure ox_lib' line to put the driver before")
head = 'set cis_bench_driver "%s"\nset cis_bench_run "%s"\nset cis_bench_scale "%s"\n' % (driver, run, scale)
if driver == "cis_database" and trace == "1":
    head += 'set cis_database_frame_trace "1"\n'
if driver == "cis_database" and frame_ms:
    text = re.sub(r"(?m)^[ \t]*setr?[ \t]+cis_database_frame_ms\b.*$", "", text)
    head += 'set cis_database_frame_ms "%s"\n' % frame_ms
head += 'ensure %s\n' % driver
text = text[:needle.start()] + head + text[needle.start():]
# cis_bench resets cis_database's probe counters per phase; the ACE allows it.
text = text.rstrip("\n") + "\nadd_ace resource.cis_bench cis_database.probe allow\nensure cis_bench\n"
open(dst, "w", encoding="utf-8").write(text)
PY
}

maria_checksums() {
    maria "SELECT CONCAT('{\"players\":{\"n\":', COUNT(*), ',\"money\":', IFNULL(SUM(money),0), ',\"bank\":', IFNULL(SUM(bank),0),
        ',\"inv\":', IFNULL(SUM(LENGTH(inventory)),0), ',\"meta\":', IFNULL(SUM(LENGTH(metadata)),0), ',\"pos\":', IFNULL(SUM(LENGTH(position)),0), '},',
        (SELECT CONCAT('\"vehicles\":{\"n\":', COUNT(*), ',\"fuel\":', IFNULL(SUM(fuel),0), ',\"engine\":', IFNULL(SUM(engine),0), ',\"body\":', IFNULL(SUM(body),0), '},') FROM cbench_vehicles),
        (SELECT CONCAT('\"bank_tx\":{\"n\":', COUNT(*), ',\"amount\":', IFNULL(SUM(amount),0), '},') FROM cbench_bank_tx),
        (SELECT CONCAT('\"messages\":{\"n\":', COUNT(*), ',\"len\":', IFNULL(SUM(LENGTH(message)),0), '}}') FROM cbench_messages))
        FROM cbench_players"
}

# ---------------------------------------------------------------- setup

take_box
log_follow
oxmysql_in
bench_resource_in

{
    env_common
    echo "oxmysql: $(grep -oP "^version\s+'\K[^']+" "$DATA/resources/oxmysql/fxmanifest.lua" 2>/dev/null) (package $(grep -oP '"version":\s*"\K[^"]+' "$DATA/resources/oxmysql/package.json" 2>/dev/null || echo '?'))"
    echo "cis_database: $(grep -oP "^cis_version\s+'\K[^']+" "$CISDIR/fxmanifest.lua" 2>/dev/null) build $(cat "$CISDIR/BUILD" 2>/dev/null || cat "$CISDIR/.deployed-sha" 2>/dev/null || echo '?')"
    if [[ -n ${BENCH_FRAME_MS:-} ]]; then
        echo "cis_database frame budget: $BENCH_FRAME_MS ms (BENCH_FRAME_MS, convar cis_database_frame_ms)"
    elif grep -qE '^[[:space:]]*setr?[[:space:]]+cis_database_frame_ms' "$CFG"; then
        echo "cis_database frame budget: set by cis_database_frame_ms in server.cfg"
    else
        echo "cis_database frame budget: $(grep -oP '"frameBudgetMs":\s*\K[0-9.]+' "$CISDIR/config.json" 2>/dev/null || echo 25) ms (config.json frameBudgetMs)"
    fi
    ack=$(grep -oP '^[[:space:]]*setr?[[:space:]]+cis_database_ack[[:space:]]+"?\K[a-z]+' "$CFG" 2>/dev/null | tail -n1 || true)
    echo "cis_database write ack: ${ack:-power} ($(if [[ -n $ack ]]; then echo 'cis_database_ack in server.cfg'; else echo 'default: answered after an fdatasync of the WAL'; fi))"
    echo "bench scripts: $(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo '?')$(git -C "$HERE" diff --quiet HEAD -- . 2>/dev/null || echo ' (modified)')"
    echo "rounds: $ROUNDS"
    echo "scale: $SCALE"
    echo "reproduce: BENCH_DATA=$DATA BENCH_SERVER=$SERVER BENCH_DB=$DB${BENCH_FXROOT:+ BENCH_FXROOT=$BENCH_FXROOT}${BENCH_FRAME_MS:+ BENCH_FRAME_MS=$BENCH_FRAME_MS} bash bench/run_bench.sh $ROUNDS $SCALE"
} > "$OUT/env.txt"
sed 's/^/    /' "$OUT/env.txt"

# ---------------------------------------------------------------- passes

pass() {
    local driver=$1 run=$2 m t0 line cpu_a_fx=0 cpu_a_db=0 cpu_b_fx=0 cpu_b_db=0 started=0 i
    local mem_a_fx=0 mem_a_db=0 mem_b_fx=0 mem_peak_fx=0 mem_b_db=0
    say "round $run: $driver"
    fx_stop
    rm -f "$RES"/results_*.json
    set_include "$driver"
    set_cfg "$driver" "$run"
    m=$(log_mark)
    t0=$(date +%s)
    fx_start +exec server.cfg
    for i in $(seq 1 1500); do
        sleep 1
        if [[ $started == 0 ]] && since "$m" | grep -aqF "cis_bench] idle tick"; then
            started=1
            cpu_a_fx=$(fx_cpu); cpu_a_db=$(maria_cpu)
            mem_a_fx=$(fx_mem VmRSS); mem_a_db=$(maria_mem VmRSS)
        fi
        if since "$m" | grep -aqF "cis_bench] BENCH_DONE"; then
            cpu_b_fx=$(fx_cpu); cpu_b_db=$(maria_cpu)
            mem_b_fx=$(fx_mem VmRSS); mem_peak_fx=$(fx_mem VmHWM); mem_b_db=$(maria_mem VmRSS)
            break
        fi
        if since "$m" | grep -aqF "cis_bench] FATAL"; then
            since "$m" | grep -aF "cis_bench]" | tail -n 5
            die "cis_bench FATAL on $driver round $run"
        fi
    done
    [[ $cpu_b_fx != 0 ]] || { since "$m" | tail -n 40; die "no BENCH_DONE after 25 minutes ($driver round $run)"; }
    if [[ $driver == cis_database ]]; then
        for i in $(seq 1 320); do
            since "$m" | grep -aqF "cis_bench] OUTBOX_EMPTY" && break
            sleep 1
        done
    fi
    sleep 2
    since "$m" > "$OUT/log_${driver}_${run}.txt"
    if [[ "${BENCH_CIS_TRACE:-0}" == 1 && $driver == cis_database ]]; then
        for f in "$CISDIR"/cache/frame_trace-*.json; do [[ -e "$f" ]] && mv "$f" "$OUT/trace_${run}_$(basename "$f")"; done
    fi
    cp "$RES/results_${driver}_${run}.json" "$OUT/" || die "no results file for $driver round $run"
    maria_checksums > "$OUT/maria_${driver}_${run}.json" || echo '{}' > "$OUT/maria_${driver}_${run}.json"
    python3 - "$OUT/cpu_${driver}_${run}.json" "$cpu_a_fx" "$cpu_b_fx" "$cpu_a_db" "$cpu_b_db" "$TICK" "$(( $(date +%s) - t0 ))" \
        "$mem_a_fx" "$mem_b_fx" "$mem_peak_fx" "$mem_a_db" "$mem_b_db" <<'PY'
import json, sys
out, afx, bfx, adb, bdb, tick, wall, mafx, mbfx, mpfx, madb, mbdb = sys.argv[1], *map(int, sys.argv[2:])
# Memory is in kB from /proc. Each pass starts a new FXServer, so its peak
# (VmHWM) belongs to this pass; mariadbd keeps running, so only its RSS is read.
json.dump({"fxserver_s": (bfx - afx) / tick, "mariadb_s": (bdb - adb) / tick, "boot_to_done_s": wall,
           "fxserver_idle_mb": mafx / 1024, "fxserver_done_mb": mbfx / 1024, "fxserver_peak_mb": mpfx / 1024,
           "mariadb_idle_mb": madb / 1024, "mariadb_done_mb": mbdb / 1024}, open(out, "w"))
PY
    grep -aE "cis_bench\] (latency|live|join|save|payday|saturation|idle|seed|errors|OUTBOX)" "$OUT/log_${driver}_${run}.txt" | sed 's/^.*\[cis_bench\]/    /' || true
}

for run in $(seq "$FIRST" "$ROUNDS"); do
    if (( run % 2 == 1 )); then order="oxmysql cis_database"; else order="cis_database oxmysql"; fi
    for driver in $order; do
        [[ -n "${BENCH_ONLY:-}" && "$driver" != "$BENCH_ONLY" ]] && continue
        pass "$driver" "$run"
    done
done
fx_stop

python3 "$HERE/report.py" "$OUT" || say "report needs both drivers; skipped"
say "results in $OUT (REPORT.md, summary.json)"
