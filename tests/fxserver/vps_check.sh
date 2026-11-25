#!/usr/bin/env bash
# Test only. Installs a cis_database package on a txAdmin-managed Linux test
# server and checks it on the real FXServer. Needs root, systemd and MariaDB.
#
#   vps_check.sh install     stop the server, back up the current cis_database, swap in this package
#   vps_check.sh warmup      one boot with the server's own server.cfg so the first hydrate is done, then stop
#   vps_check.sh shootout    1v1 against oxmysql: one round of bench/run_bench.sh
#   vps_check.sh durability  probe writes across a MariaDB outage, a clean stop and a crash
#   vps_check.sh trace       idle floor + one bench round with the frame trace and cis_framewatch on
#   vps_check.sh restore     start the server again with its own server.cfg
#   vps_check.sh rollback    put the backed-up cis_database back
#
# Run as root on the box, from the folder the package was extracted into
# (cis_database/, cis_probe/, cis_framewatch/, BUILD; bench/ for shootout and
# trace). Env: VPS_CHECK_DATA (required) is the server-data folder with
# server.cfg and resources/; VPS_CHECK_SERVER (default "server") names the
# txAdmin instance and the MariaDB database; VPS_CHECK_UNIT (default
# txadmin@$VPS_CHECK_SERVER) is its systemd unit, whose console is read
# from journald. VPS_CHECK_WORK (default ${BENCH_DIR:-$HOME/bench}/vps_check)
# holds its logs and backups. Boot-time convars and extra ensures go into
# server.cfg as lines marked "# vps_check", removed again when the command ends.
# warmup, durability and the trace idle floor run cis_database in place of
# oxmysql, so the server's own oxmysql must be moved out of resources/
# first; shootout and trace's bench round handle that themselves.
set -euo pipefail

PKGDIR=$(cd "$(dirname "$0")" && pwd)
SERVER=${VPS_CHECK_SERVER:-server}
UNIT=${VPS_CHECK_UNIT:-txadmin@$SERVER}
[[ -n ${VPS_CHECK_DATA:-} ]] || { echo "[vps_check] FAIL: set VPS_CHECK_DATA to the server-data folder (server.cfg and resources/)" >&2; exit 1; }
DATA=${VPS_CHECK_DATA%/}
CFG=$DATA/server.cfg
RES=$(find "$DATA/resources" -maxdepth 3 -type d -name cis_database -print -quit 2>/dev/null || true)
RES=${RES:-$DATA/resources/[cis]/cis_database}
PROBE=$DATA/resources/cis_probe
FRAMEWATCH=$DATA/resources/cis_framewatch
WORK=${VPS_CHECK_WORK:-${BENCH_DIR:-$HOME/bench}/vps_check}
LOG=$WORK/console.log
BACKUPS=$WORK/backups
LAST_BACKUP=$BACKUPS/last
BENCH=${VPS_CHECK_BENCH:-$PKGDIR/bench/run_bench.sh}
MARK='# vps_check'
BUILD=$(cat "$PKGDIR/BUILD" 2>/dev/null || echo unknown)
TAIL_PID=""

say() { echo "[vps_check] $*"; }
die() { echo "[vps_check] FAIL: $*" >&2; exit 1; }

[[ $(id -u) == 0 ]] || die "run as root on the server box"
mkdir -p "$WORK" "$BACKUPS"
chmod 700 "$WORK"

# MariaDB as root over the local socket; the database is named like the server.
maria() {
    mysql -N -B "$SERVER" -e "$1"
}

# Name of the first running txadmin@<name> unit (instance name), if any.
active_server() {
    systemctl list-units 'txadmin@*' --state=active --no-legend --plain 2>/dev/null \
        | sed -n 's/^txadmin@\([^.]*\)\.service.*/\1/p' | head -n1
    return 0
}

# The FXServer txAdmin started for this server (not txAdmin's own).
game_pid() {
    local cg pid
    cg=/sys/fs/cgroup$(systemctl show -P ControlGroup "$UNIT" 2>/dev/null)
    [[ -r $cg/cgroup.procs ]] || return 0
    for pid in $(cat "$cg/cgroup.procs"); do
        if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF 'txAdmin-serverName'; then
            echo "$pid"
            return 0
        fi
    done
}

# Marked lines in server.cfg: convars at the top, ensures at the end.
cfg_off() { sed -i "/ $MARK\$/d" "$CFG"; }

on_exit() {
    cfg_off || true
    [[ -n $TAIL_PID ]] && kill "$TAIL_PID" 2>/dev/null || true
}
trap on_exit EXIT

touch "$LOG"
chmod 600 "$LOG"
journalctl -u "$UNIT" -f -n 0 -o cat >> "$LOG" 2>/dev/null &
TAIL_PID=$!
sleep 1

# Returns 0 when the stop was clean.
fx_stop() {
    systemctl stop "$UNIT" 2>/dev/null || return 1
    [[ $(systemctl show -P Result "$UNIT") == success ]]
}

# kill -9 of the game FXServer; txAdmin starts it again by itself.
fx_crash() {
    local pid
    pid=$(game_pid)
    [[ -n $pid ]] || die "no game FXServer to kill"
    kill -KILL "$pid"
    sleep 1
}

# fx_start [+set <convar> <value>]... [+ensure <resource>]... [+exec server.cfg]
# txAdmin starts FXServer with server.cfg, so the arguments become marked
# lines in it for this boot.
fx_start() {
    local was n
    cfg_off
    while (( $# )); do
        case $1 in
            +set) sed -i "1i set $2 \"$3\" $MARK" "$CFG"; shift 3 ;;
            +ensure) echo "ensure $2 $MARK" >> "$CFG"; shift 2 ;;
            +exec) shift 2 ;;
            *) die "fx_start: unsupported argument $1" ;;
        esac
    done
    if grep -qE "^ensure cis_(database|probe) $MARK\$" "$CFG" \
        && [[ -n $(find "$DATA/resources" -maxdepth 3 -type d -name oxmysql -print -quit) ]]; then
        cfg_off
        die "oxmysql is still under $DATA/resources: cis_database replaces it on this server (move it out first)"
    fi
    was=$(active_server)
    if [[ -n $was && $was != "$SERVER" ]]; then
        n=$(curl -s -m 3 http://127.0.0.1:30120/players.json | python3 -c 'import json, sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)
        [[ $n == 0 ]] || die "$n player(s) connected to $was; not stopping it"
        say "stopping $was so $SERVER can have the ports"
        systemctl stop "txadmin@$was"
    fi
    echo >> "$LOG"
    echo "===== $(date -Is) vps_check boot $SERVER =====" >> "$LOG"
    systemctl reset-failed "$UNIT" 2>/dev/null || true
    systemctl start "$UNIT"
}

log_mark() { wc -c < "$LOG" | tr -d ' '; }

# wait_log <mark> <fixed string> <seconds>: prints the matching line.
wait_log() {
    local mark="$1" pat="$2" secs="$3" i line
    for i in $(seq 1 "$secs"); do
        line=$(tail -c +"$((mark + 1))" "$LOG" | sed 's/\x1b\[[0-9;]*m//g' | grep -aF -- "$pat" | tail -n1 || true)
        if [[ -n "$line" ]]; then echo "$line"; return 0; fi
        sleep 1
    done
    return 1
}

console() {
    fivem-console "$1" >/dev/null
}

# probe_cmd <command line> <CISPROBE line to wait for> <seconds>
probe_cmd() {
    local m
    m=$(log_mark)
    console "$1"
    wait_log "$m" "$2" "$3" || die "no '$2' in the log after: $1"
}

boot_and_wait() {
    local m
    m=$(log_mark)
    fx_start +set cis_database_cdc 0 +exec server.cfg +ensure cis_database +ensure cis_probe
    wait_log "$m" "cis_database] Ready." 600 || { tail -n 40 "$LOG"; die "cis_database never logged Ready."; }
    tail -c +"$((m + 1))" "$LOG" | grep -aE "cis_database\]" | grep -aE "hydrated|kept|Replayed|Starting from|spill|saved|Ready\." | sed 's/^/    /' || true
    wait_log "$m" "CISPROBE loaded" 60 >/dev/null || die "cis_probe did not load"
}

# What MariaDB holds for a tag: count, distinct n, max n, rows applied out of
# order, and the cis_probe_last value.
maria_tag() {
    local t="$1"
    maria "SELECT CONCAT('count=', COUNT(*), ' distinct=', COUNT(DISTINCT n), ' max=', IFNULL(MAX(n), 'NULL'),
        ' out_of_order=', (SELECT COUNT(*) FROM (SELECT n, LAG(n) OVER (ORDER BY id) AS p FROM cis_probe WHERE tag = '$t') x WHERE x.n <= x.p),
        ' last=', IFNULL((SELECT n FROM cis_probe_last WHERE tag = '$t'), 'NULL'))
        FROM cis_probe WHERE tag = '$t'"
}

spill_files() { ls -1 "$RES/cache" 2>/dev/null | grep -E '^replica\.spill\.' || true; }

cmd_install() {
    [[ -d "$PKGDIR/cis_database" && -d "$PKGDIR/cis_probe" ]] || die "run this from the extracted package"
    [[ -f "$PKGDIR/cis_database/node_modules/mysql2/package.json" ]] || die "package has no node_modules/mysql2"
    [[ -d "$RES" ]] || die "missing $RES (deploy cis_database to $SERVER first: fivem-deploy)"
    say "package build $BUILD"
    say "stopping $UNIT"
    fx_stop || say "stop was not clean"
    local b="$BACKUPS/cis_database-$SERVER-pre-$BUILD-$(date +%Y%m%d-%H%M%S)"
    cp -a "$RES" "$b"
    echo "$b" > "$LAST_BACKUP"
    say "backup: $b (cache included)"
    local trash
    trash=$(mktemp -d)
    mv "$RES" "$trash/"
    cp -a "$PKGDIR/cis_database" "$RES"
    # The SQLite file is the source of truth and may hold outbox rows (or old
    # spill files) MariaDB has not received, so an upgrade keeps cache/ as is.
    if [[ -d "$trash/cis_database/cache" ]]; then
        cp -a "$trash/cis_database/cache" "$RES/cache"
        say "kept cache/ from the previous build: $(ls "$RES/cache" | tr '\n' ' ')"
    else
        say "no cache/ before: the first boot copies every table from MariaDB $SERVER"
    fi
    rm -rf "$PROBE" "$FRAMEWATCH"
    cp -a "$PKGDIR/cis_probe" "$PROBE"
    cp -a "$PKGDIR/cis_framewatch" "$FRAMEWATCH"
    chown -R fivem:fivem "$RES" "$PROBE" "$FRAMEWATCH"
    rm -rf "$trash"
    say "installed $BUILD at $RES"
    say "installed test resources $PROBE (durability) and $FRAMEWATCH (trace)"
    grep -nE "provide|cis_version" "$RES/fxmanifest.lua" | sed 's/^/    /'
}

# One boot with the server's own server.cfg plus cis_database, so the first
# hydrate after install is done before a timed run. Ends with a clean stop.
cmd_warmup() {
    local m t0
    fx_stop || true
    m=$(log_mark)
    t0=$(date +%s)
    fx_start +exec server.cfg +ensure cis_database
    wait_log "$m" "cis_database] Ready." 900 >/dev/null || { tail -n 40 "$LOG"; die "cis_database never logged Ready."; }
    say "ready after $(( $(date +%s) - t0 )) s"
    sleep 20
    tail -c +"$((m + 1))" "$LOG" | sed 's/\x1b\[[0-9;]*m//g' | grep -aE "cis_database\]|SCRIPT ERROR" | sed 's/^/    /' || true
    if fx_stop; then say "stop clean"; else say "stop NOT clean"; fi
    ls -la "$RES/cache" | sed 's/^/    /'
}

# One round of the bench (oxmysql pass, cis_database pass, then the server
# that ran before starts again).
cmd_shootout() {
    [[ -f $BENCH ]] || die "no $BENCH (extract bench/ beside the package or set VPS_CHECK_BENCH)"
    fx_stop || true
    BENCH_DATA=$DATA BENCH_UNIT=$UNIT BENCH_SERVER=$SERVER BENCH_OUT="$WORK/shootout_${BUILD}_$(date +%Y%m%d-%H%M%S)" bash "$BENCH" 1
}

# Idle floor, then one bench round, with the cis_database frame trace and
# cis_framewatch on. Everything lands in $WORK/trace_<build>_<time>/.
cmd_trace() {
    [[ -d "$FRAMEWATCH" ]] || die "run install first"
    [[ -f $BENCH ]] || die "no $BENCH (extract bench/ beside the package or set VPS_CHECK_BENCH)"
    local out="$WORK/trace_${BUILD}_$(date +%Y%m%d-%H%M%S)" m
    mkdir -p "$out"
    fx_stop || true
    rm -f "$RES"/cache/frame_trace-*.json

    say "1/2 idle floor: boot, 20 s settle, 90 s measured, no load"
    m=$(log_mark)
    fx_start +set cis_database_frame_trace 1 +exec server.cfg +ensure cis_database +ensure cis_framewatch
    wait_log "$m" "cis_database] Ready." 600 >/dev/null || { tail -n 40 "$LOG"; die "cis_database never logged Ready."; }
    sleep 110
    tail -c +"$((m + 1))" "$LOG" | sed 's/\x1b\[[0-9;]*m//g' > "$out/idle.log"
    fx_stop || true
    cfg_off
    for f in "$RES"/cache/frame_trace-*.json; do [[ -e "$f" ]] && mv "$f" "$out/idle_$(basename "$f")"; done
    say "    $(grep -c CISFRAMES "$out/idle.log") framewatch windows, $(grep -c 'frame_trace t=' "$out/idle.log") trace windows"

    say "2/2 one bench round with the frame trace on (bench/run_bench.sh, BENCH_CIS_TRACE=1)"
    BENCH_DATA=$DATA BENCH_UNIT=$UNIT BENCH_SERVER=$SERVER BENCH_CIS_TRACE=1 BENCH_OUT="$out/bench" bash "$BENCH" 1 || say "run_bench.sh exited non-zero"
    ls -la "$out" | sed 's/^/    /'
    say "done: $out"
}

MARIA_STOPPED=0
start_maria_on_exit() {
    if [[ "$MARIA_STOPPED" == 1 ]]; then
        systemctl start mariadb && say "MariaDB started again (exit trap)"
    fi
    on_exit
}

cmd_durability() {
    [[ -d "$PROBE" ]] || die "run install first"
    trap start_maria_on_exit EXIT
    local run="r$(date +%s)" r
    say "build $BUILD, run id $run, database $SERVER"
    fx_stop || true

    say "1/4 boot with MariaDB up"
    boot_and_wait
    probe_cmd "cisprobe_setup" "CISPROBE setup ok" 60 >/dev/null

    say "2/4 baseline: 2000 writes with MariaDB up"
    probe_cmd "cisprobe_write ${run}_a 2000" "CISPROBE wrote ${run}_a" 300 | sed 's/^/    /'
    sleep 3
    echo "    MariaDB ${run}_a: $(maria_tag "${run}_a")   (want count=2000 distinct=2000 max=2000 out_of_order=0 last=2000)"

    say "3/4 spill order: 6000 writes with MariaDB stopped, clean stop, MariaDB back, boot"
    systemctl stop mariadb; MARIA_STOPPED=1
    probe_cmd "cisprobe_write ${run}_b 6000" "CISPROBE wrote ${run}_b" 600 | sed 's/^/    /'
    probe_cmd "cisprobe_count ${run}_b" "CISPROBE sqlite ${run}_b" 30 | sed 's/^/    /'
    sleep 1
    if fx_stop; then say "    stop was clean"; else say "    stop was NOT clean"; fi
    echo "    spill files after the stop: $(spill_files | tr '\n' ' ')"
    systemctl start mariadb; MARIA_STOPPED=0
    boot_and_wait
    sleep 3
    echo "    MariaDB ${run}_b: $(maria_tag "${run}_b")   (want count=6000 distinct=6000 max=6000 out_of_order=0 last=6000)"
    probe_cmd "cisprobe_count ${run}_b" "CISPROBE sqlite ${run}_b" 30 | sed 's/^/    /'

    say "4/4 crash: 1000 writes with MariaDB stopped, kill -9, txAdmin boots it again with MariaDB still stopped"
    systemctl stop mariadb; MARIA_STOPPED=1
    probe_cmd "cisprobe_write ${run}_c 1000" "CISPROBE wrote ${run}_c" 300 | sed 's/^/    /'
    local m
    m=$(log_mark)
    fx_crash
    say "    killed"
    wait_log "$m" "cis_database] Ready." 600 >/dev/null || { tail -n 40 "$LOG"; die "cis_database never logged Ready after the crash."; }
    wait_log "$m" "CISPROBE loaded" 60 >/dev/null || die "cis_probe did not load after the crash"
    probe_cmd "cisprobe_count ${run}_c" "CISPROBE sqlite ${run}_c" 30 | sed 's/^/    /'
    echo "    (want count=1000 distinct=1000 max=1000 last=1000: SQLite kept every acknowledged write)"
    systemctl start mariadb; MARIA_STOPPED=0
    sleep 8
    echo "    MariaDB ${run}_c: $(maria_tag "${run}_c")   (want count=1000 distinct=1000 max=1000 out_of_order=0 last=1000: the outbox survived the kill)"

    fx_stop || true
    say "done. $UNIT is stopped. Run 'restore' to start it again."
}

# The server with its own server.cfg, the way it ran before.
cmd_restore() {
    local m
    fx_stop || true
    m=$(log_mark)
    fx_start +exec server.cfg
    sleep 60
    curl -s http://127.0.0.1:30120/info.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['resources']), 'resources;', d['vars'].get('sv_projectName', ''))"
}

cmd_rollback() {
    local b
    b=$(cat "$LAST_BACKUP" 2>/dev/null || true)
    [[ -n "$b" && -d "$b" ]] || die "no backup recorded in $LAST_BACKUP"
    fx_stop || true
    local trash
    trash="$BACKUPS/cis_database-$SERVER-rolled-back-$(date +%Y%m%d-%H%M%S)"
    mv "$RES" "$trash"
    cp -a "$b" "$RES"
    chown -R fivem:fivem "$RES"
    rm -rf "$PROBE" "$FRAMEWATCH"
    say "restored $b to $RES. The rolled-back tree (with its cache) is in $trash"
}

case "${1:-}" in
    install) cmd_install ;;
    warmup) cmd_warmup ;;
    shootout) cmd_shootout ;;
    durability) cmd_durability ;;
    trace) cmd_trace ;;
    restore) cmd_restore ;;
    rollback) cmd_rollback ;;
    *) sed -n '2,22p' "$0"; exit 2 ;;
esac
