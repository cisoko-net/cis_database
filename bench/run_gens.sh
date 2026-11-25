#!/usr/bin/env bash
# Generation shootout: several cis_database builds (and oxmysql) on the same
# server, one contender per boot, each boot clean.
#
#   bench/run_gens.sh [-r rounds] [-s scale] label=/path/to/cis_database ... [oxmysql]
#
#   bench/run_gens.sh g0=$HOME/bench/pkg_a/cis_database \
#                     g1=$HOME/bench/pkg_b/cis_database oxmysql
#
# Run as root on the server box. BENCH_DATA (your server-data folder) is
# required; by default the server is driven through its txAdmin systemd unit.
# The server that was running before is stopped first and started again at
# the end. See bench/README.md and the BENCH_* variables in bench/server.sh.
#
# A clean boot means, for every pass:
#   - FXServer stopped (the unit stopped, or run.sh's FXServer killed if it
#     hangs), the OS page cache dropped,
#     so no pass inherits the previous one's warm files;
#   - for a cis_database contender, its tree copied fresh into resources/ with
#     no cache/: SQLite starts empty and hydrates every table from MariaDB, so
#     every generation starts from the same data, laid out the same way;
#   - the whole server.cfg (frameworks and every resource), with only the
#     database driver changed.
# The order rotates every round so drift on the box hits every contender.
#
# cache/ is only ever removed after checking that every outbox row in it is
# in MariaDB (__cis_replica_state). If one is not, the run stops and leaves
# the folder alone. At the end the installed cis_database comes back with its
# own code and a fresh cache/ hydrated from MariaDB, server.cfg is put back,
# and the server that ran before starts again.
#
# Env: the BENCH_* variables in bench/server.sh, BENCH_CIS_TRACE as in
# run_bench.sh, and:
#   BENCH_ONLY=seed                          stop each pass after the bulk import
#   BENCH_CIS_SET='cis_database_x=1 ...'     convars for the cis_database passes
set -euo pipefail

ROUNDS=1
SCALE=1
while getopts "r:s:" o; do
    case $o in
        r) ROUNDS=$OPTARG ;;
        s) SCALE=$OPTARG ;;
        *) exit 2 ;;
    esac
done
shift $((OPTIND - 1))
[[ $# -ge 1 ]] || { echo "usage: run_gens.sh [-r rounds] [-s scale] label=/path/cis_database ... [oxmysql]" >&2; exit 2; }

HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${BENCH_OUT:-${BENCH_DIR:-$HOME/bench}/gens_$(date +%Y%m%d-%H%M%S)}

say() { echo "[gens] $*"; }
die() { echo "[gens] FAIL: $*" >&2; exit 1; }

. "$HERE/server.sh"

CISDIR=$(find "$DATA/resources" -maxdepth 3 -type d -name cis_database -print -quit)
STASH=$OUT/installed_cis_database

[[ $(id -u) == 0 ]] || die "run as root on the server box"
[[ -f "$CFG" ]] || die "no server.cfg at $CFG"
[[ -n "$CISDIR" ]] || die "cis_database is not installed under $DATA/resources"

LABELS=()
declare -A SRC
for spec in "$@"; do
    if [[ $spec == oxmysql ]]; then
        LABELS+=(oxmysql)
        continue
    fi
    label=${spec%%=*}
    path=${spec#*=}
    [[ $label != "$spec" && $label =~ ^[A-Za-z0-9-]+$ ]] || die "contender '$spec' is not label=/path (label: letters, digits, dashes)"
    [[ -f "$path/fxmanifest.lua" && -f "$path/server.js" ]] || die "$path is not a cis_database tree"
    LABELS+=("$label")
    SRC[$label]=$(cd "$path" && pwd)
done

mkdir -p "$OUT"
chmod 700 "$OUT"
# The copy holds the server's secrets: it stays in $OUT (root only) and is
# never part of the published report.
cp -a "$CFG" "$OUT/server.cfg.orig"

# Outbox rows in <dir>/cache that MariaDB has not applied. FXServer must be
# stopped. Prints a number; prints "?" when it cannot tell.
outbox_left() {
    local f=$1/cache/durable.sqlite epoch maxid applied
    [[ -f $f ]] || { echo 0; return; }
    if ! sqlite3 "$f" "SELECT 1 FROM sqlite_master WHERE name='__cis_outbox'" 2>/dev/null | grep -q 1; then
        echo 0; return
    fi
    epoch=$(sqlite3 "$f" "SELECT v FROM __cis_meta WHERE k='epoch'" 2>/dev/null) || { echo "?"; return; }
    maxid=$(sqlite3 "$f" "SELECT IFNULL(MAX(id),0) FROM __cis_outbox" 2>/dev/null) || { echo "?"; return; }
    [[ $maxid == 0 ]] && { echo 0; return; }
    [[ $epoch =~ ^[0-9a-f]+$ ]] || { echo "?"; return; }
    applied=$(maria "SELECT applied FROM __cis_replica_state WHERE epoch='$epoch'" 2>/dev/null) || { echo "?"; return; }
    applied=${applied:-0}
    sqlite3 "$f" "SELECT COUNT(*) FROM __cis_outbox WHERE id > $applied" 2>/dev/null || echo "?"
}

# Removes <dir>/cache only when every write in it reached MariaDB.
drop_cache() {
    local dir=$1 left
    [[ -d $dir/cache ]] || return 0
    left=$(outbox_left "$dir")
    if [[ $left != 0 ]]; then
        echo "[gens] $dir/cache has $left outbox rows MariaDB has not confirmed; leaving it untouched" >&2
        return 1
    fi
    rm -rf "$dir/cache"
}

install_tree() {
    local src=$1
    drop_cache "$CISDIR" || die "not replacing $CISDIR"
    rm -rf "$CISDIR"
    cp -a "$src" "$CISDIR"
    rm -rf "$CISDIR/cache"
    chown -R "$FXUSER:$FXUSER" "$CISDIR"
}

restore() {
    local code=$?
    trap - EXIT
    set +e
    fx_stop
    cp -a "$OUT/server.cfg.orig" "$CFG"
    rm -rf "$RES"
    oxmysql_out
    if [[ -d $STASH ]]; then
        if drop_cache "$CISDIR"; then
            rm -rf "$CISDIR"
            mv "$STASH" "$CISDIR"
            # Its outbox was checked empty before the run, so MariaDB has
            # everything this cache held; a fresh copy picks up the bench tables.
            rm -rf "$CISDIR/cache"
            say "installed cis_database put back ($(cat "$CISDIR/BUILD" 2>/dev/null || echo '?')); it hydrates from MariaDB on boot"
        else
            say "the last contender's cache still has unconfirmed writes; it stays installed and $STASH is kept"
        fi
    fi
    give_back_box
    log_unfollow
    exit $code
}

set_include() {
    local driver=$1
    sed -i "/BENCH_INCLUDE/{n;s#'@[a-z_]*/lib/MySQL.lua'#'@${driver}/lib/MySQL.lua'#}" "$RES/fxmanifest.lua"
}

set_cfg() {
    local driver=$1 label=$2 run=$3
    python3 - "$OUT/server.cfg.orig" "$CFG" "$driver" "$label" "$run" "$SCALE" "${BENCH_CIS_TRACE:-0}" "${BENCH_ONLY:-}" "${BENCH_CIS_SET:-}" <<'PY'
import re, sys
src, dst, driver, label, run, scale, trace, only, cis_set = sys.argv[1:10]
text = open(src, encoding="utf-8").read()
text = re.sub(r"(?m)^[ \t]*#?[ \t]*ensure[ \t]+(cis_database|oxmysql|cis_bench)[ \t]*(#.*)?$", "", text)
needle = re.search(r"(?m)^[ \t]*ensure[ \t]+ox_lib\b.*$", text)
if not needle:
    raise SystemExit("server.cfg has no 'ensure ox_lib' line to put the driver before")
head = 'set cis_bench_driver "%s"\nset cis_bench_label "%s"\nset cis_bench_run "%s"\nset cis_bench_scale "%s"\n' % (driver, label, run, scale)
if only:
    head += 'set cis_bench_only "%s"\n' % only
if driver == "cis_database" and trace == "1":
    head += 'set cis_database_frame_trace "1"\n'
if driver == "cis_database":
    for kv in cis_set.split():
        k, _, v = kv.partition("=")
        if not re.fullmatch(r"cis_database_[a-z_]+", k) or not re.fullmatch(r"[A-Za-z0-9_.-]+", v):
            raise SystemExit("bad BENCH_CIS_SET entry: " + kv)
        head += 'set %s "%s"\n' % (k, v)
head += 'ensure %s\n' % driver
text = text[:needle.start()] + head + text[needle.start():]
text = text.rstrip("\n") + "\nensure cis_bench\n"
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

command -v sqlite3 >/dev/null || die "sqlite3 CLI is needed to check the outbox before removing a cache"
trap restore EXIT
take_box
fx_stop
log_follow
need_ox=0
[[ " ${LABELS[*]} " == *" oxmysql "* ]] && need_ox=1
oxmysql_in "$need_ox"
bench_resource_in

left=$(outbox_left "$CISDIR")
[[ $left == 0 ]] || die "the installed cis_database has $left outbox rows MariaDB has not confirmed; not touching it"
cp -a "$CISDIR" "$STASH"

{
    env_common
    for l in "${LABELS[@]}"; do
        if [[ $l == oxmysql ]]; then
            echo "oxmysql: $(grep -oP "^version\s+'\K[^']+" "$DATA/resources/oxmysql/fxmanifest.lua" 2>/dev/null)"
        else
            echo "$l: cis_database build $(cat "${SRC[$l]}/BUILD" 2>/dev/null || echo '?') from ${SRC[$l]}"
        fi
    done
    echo "rounds: $ROUNDS"
    echo "scale: $SCALE"
    [[ -z ${BENCH_ONLY:-} ]] || echo "only: $BENCH_ONLY"
    [[ -z ${BENCH_CIS_SET:-} ]] || echo "cis convars: $BENCH_CIS_SET"
    echo "order: rotates every round; every pass is a fresh boot with the page cache dropped and, for cis_database, an empty cache/ hydrated from MariaDB"
} > "$OUT/env.txt"
printf '%s\n' "${LABELS[@]}" > "$OUT/labels.txt"
sed 's/^/    /' "$OUT/env.txt"

# ---------------------------------------------------------------- passes

pass() {
    local label=$1 run=$2 driver m t0 cpu_a_fx=0 cpu_a_db=0 cpu_b_fx=0 cpu_b_db=0 started=0 i
    driver=cis_database
    [[ $label == oxmysql ]] && driver=oxmysql
    say "round $run: $label"
    fx_stop
    [[ $driver == cis_database ]] && install_tree "${SRC[$label]}"
    rm -f "$RES"/results_*.json
    set_include "$driver"
    set_cfg "$driver" "$label" "$run"
    sync
    echo 3 > /proc/sys/vm/drop_caches || true
    m=$(log_mark)
    t0=$(date +%s)
    fx_start +exec server.cfg
    for i in $(seq 1 1500); do
        sleep 1
        if [[ $started == 0 ]] && since "$m" | grep -aqF "cis_bench] idle tick"; then
            started=1
            cpu_a_fx=$(fx_cpu); cpu_a_db=$(maria_cpu)
        fi
        if since "$m" | grep -aqF "cis_bench] BENCH_DONE"; then
            cpu_b_fx=$(fx_cpu); cpu_b_db=$(maria_cpu)
            break
        fi
        if since "$m" | grep -aqF "cis_bench] FATAL"; then
            since "$m" | grep -aF "cis_bench]" | tail -n 5
            die "cis_bench FATAL on $label round $run"
        fi
    done
    [[ $cpu_b_fx != 0 ]] || { since "$m" | tail -n 40; die "no BENCH_DONE after 25 minutes ($label round $run)"; }
    if [[ $driver == cis_database ]]; then
        for i in $(seq 1 320); do
            since "$m" | grep -aqF "cis_bench] OUTBOX_EMPTY" && break
            sleep 1
        done
    fi
    sleep 2
    since "$m" > "$OUT/log_${label}_${run}.txt"
    if [[ $driver == cis_database ]]; then
        for f in "$CISDIR"/cache/frame_trace-*.json; do [[ -e "$f" ]] && mv "$f" "$OUT/trace_${label}_${run}_$(basename "$f")"; done
    fi
    cp "$RES/results_${label}_${run}.json" "$OUT/" || die "no results file for $label round $run"
    maria_checksums > "$OUT/maria_${label}_${run}.json" || echo '{}' > "$OUT/maria_${label}_${run}.json"
    python3 - "$OUT/cpu_${label}_${run}.json" "$cpu_a_fx" "$cpu_b_fx" "$cpu_a_db" "$cpu_b_db" "$TICK" "$(( $(date +%s) - t0 ))" <<'PY'
import json, sys
out, afx, bfx, adb, bdb, tick, wall = sys.argv[1], *map(int, sys.argv[2:])
json.dump({"fxserver_s": (bfx - afx) / tick, "mariadb_s": (bdb - adb) / tick, "boot_to_done_s": wall}, open(out, "w"))
PY
    grep -aE "cis_bench\] (latency|live|join|save|payday|saturation|idle|seed|errors|OUTBOX)" "$OUT/log_${label}_${run}.txt" | sed 's/^.*\[cis_bench\]/    /' || true
}

n=${#LABELS[@]}
for run in $(seq 1 "$ROUNDS"); do
    off=$(( (run - 1) % n ))
    for k in $(seq 0 $(( n - 1 ))); do
        pass "${LABELS[$(( (k + off) % n ))]}" "$run"
    done
done
fx_stop

python3 "$HERE/report_gens.py" "$OUT" || say "report failed"
say "results in $OUT (GENS.md, gens.json)"
