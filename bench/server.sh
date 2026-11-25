# Sourced by run_bench.sh and run_gens.sh: where the server lives on the box
# and how to stop, start, watch and measure it. Run as root on the server box.
#
# The default mode drives a txAdmin server through a systemd unit
# (txadmin@<name>, a template unit as in common txAdmin-on-Linux setups) and
# reads its console from journald. Every other txAdmin server on the box is
# stopped first, so the bench measures one server alone, and the one that was
# running is started again at the end.
#
# Env:
#   BENCH_DATA     (required) server-data folder with server.cfg and resources/
#   BENCH_SERVER   short name of the server, used for the default unit and
#                  database names (default "server"; letters, digits, _)
#   BENCH_UNIT     systemd unit that runs it (default txadmin@$BENCH_SERVER)
#   BENCH_FXROOT   folder with the FXServer build (its BUILD file); only used
#                  to record the build number in env.txt
#   BENCH_OXMYSQL  an oxmysql folder, linked as resources/oxmysql. Unset: the
#                  oxmysql found in a resources/[category] is moved aside for the
#                  run (so a category ensure cannot start it beside cis_database),
#                  linked as resources/oxmysql, and moved back at the end.
#   BENCH_RUN      an FXServer run.sh: start that directly (as BENCH_USER, from
#                  BENCH_DATA, console to BENCH_LOG) instead of txadmin@$BENCH_SERVER
#   BENCH_USER     user FXServer runs as (default: the owner of BENCH_DATA)
#   BENCH_LOG      file the console is written to (default $OUT/console.log)
#   BENCH_PORT     the server's game port, for its player count (default: the
#                  port of endpoint_add_tcp in server.cfg, else 30120)
#   BENCH_DB       MariaDB database the server uses (default $BENCH_SERVER)
#   BENCH_DBENV    file with DB_USER / DB_PASSWORD (and DB_HOST, DB_PORT) for
#                  the mysql CLI; unset: root over the local socket
#   BENCH_DIR      parent folder for results (default $HOME/bench)
#   BENCH_OUT      results folder (default $BENCH_DIR/<kind>_<date>)
#   BENCH_FORCE=1  run even though players are connected to the running server
#   BENCH_NO_RESTORE=1  leave every server stopped afterwards

SERVER=${BENCH_SERVER:-server}
[[ $SERVER =~ ^[A-Za-z0-9_]+$ ]] || die "BENCH_SERVER '$SERVER' is not a server name"
[[ -n ${BENCH_DATA:-} ]] || die "set BENCH_DATA to your server-data folder (the one with server.cfg and resources/); see bench/README.md"
[[ -d $BENCH_DATA/resources ]] || die "BENCH_DATA '$BENCH_DATA' has no resources/ folder"
UNIT=${BENCH_UNIT:-txadmin@$SERVER}
DATA=${BENCH_DATA%/}
CFG=$DATA/server.cfg
OX_SRC=${BENCH_OXMYSQL:-}
RUN=${BENCH_RUN:-}
FXUSER=${BENCH_USER:-$(stat -c %U "$DATA")}
FXROOT=${BENCH_FXROOT:-$([[ -n $RUN ]] && dirname "$RUN" || true)}
LOG=${BENCH_LOG:-$OUT/console.log}
DB=${BENCH_DB:-$SERVER}
PORT=${BENCH_PORT:-$(sed -n 's/^[[:space:]]*endpoint_add_tcp[[:space:]]*"[^"]*:\([0-9][0-9]*\)".*/\1/p' "$CFG" 2>/dev/null | head -n1)}
PORT=${PORT:-30120}
[[ $PORT =~ ^[0-9]+$ ]] || die "BENCH_PORT '$PORT' is not a port"
DBENV=${BENCH_DBENV:-}
ASIDE=$(dirname "$DATA")/bench-aside
RES=$DATA/resources/cis_bench
FX_RE='[/]opt/cfx-server/FXServer'
TICK=$(getconf CLK_TCK)

WAS=""          # systemd unit that was running before the bench
OX_MOVED=""     # where the server's own oxmysql was before it was moved aside
OX_LINKED=0     # 1 when resources/oxmysql is a link this run made
TAIL_PID=""     # journald follower writing $LOG

maria() {
    if [[ -n $DBENV ]]; then
        ( set -a; . "$DBENV"; set +a
          MYSQL_PWD="$DB_PASSWORD" mysql -u "$DB_USER" -h "${DB_HOST:-127.0.0.1}" -P "${DB_PORT:-3306}" -N -B "$DB" -e "$1" )
    else
        mysql -N -B "$DB" -e "$1"
    fi
}

# Name of a running txAdmin unit (the bench server's own, else the first
# txadmin@<name>), or nothing when no server is up.
active_server() {
    if [[ -z $RUN ]] && systemctl is-active -q "$UNIT" 2>/dev/null; then echo "$UNIT"; return 0; fi
    systemctl list-units 'txadmin@*' --state=active --no-legend --plain 2>/dev/null \
        | sed -n 's/^\(txadmin@[^ ]*\)\.service.*/\1/p' | head -n1
    return 0
}

players_online() {
    curl -s -m 3 "http://127.0.0.1:$PORT/players.json" 2>/dev/null \
        | python3 -c 'import json, sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0
}

# The game server's processes: under txAdmin, the FXServer txAdmin started
# (its command line carries txAdmin-serverName) and its children, not
# txAdmin's own FXServer.
game_pids() {
    if [[ -n $RUN ]]; then
        pgrep -f "$FX_RE" || true
        return 0
    fi
    local cg pid
    cg=/sys/fs/cgroup$(systemctl show -P ControlGroup "$UNIT" 2>/dev/null)
    [[ -r $cg/cgroup.procs ]] || return 0
    for pid in $(cat "$cg/cgroup.procs"); do
        if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF 'txAdmin-serverName'; then
            echo "$pid"
            pgrep -P "$pid" || true
        fi
    done
}

fx_running() {
    if [[ -n $RUN ]]; then
        pgrep -f "$FX_RE" >/dev/null 2>&1
    else
        systemctl is-active -q "$UNIT"
    fi
}

fx_stop() {
    local i
    if [[ -z $RUN ]]; then
        systemctl stop "$UNIT" 2>/dev/null || true
        return 0
    fi
    pkill -TERM -f "$FX_RE" || true
    for i in $(seq 1 30); do
        fx_running || return 0
        sleep 1
    done
    pkill -KILL -f "$FX_RE" || true
    sleep 1
}

# txAdmin starts FXServer with its own server.cfg; with BENCH_RUN the
# arguments go to run.sh.
fx_start() {
    echo >> "$LOG"
    echo "===== $(date -Is) bench boot $SERVER =====" >> "$LOG"
    if [[ -z $RUN ]]; then
        # Every pass is a start: clear the unit's start counter so the
        # 5-starts-in-10-minutes crash guard does not refuse a short pass.
        systemctl reset-failed "$UNIT" 2>/dev/null || true
        systemctl start "$UNIT"
    else
        ( cd "$DATA" && setsid runuser -u "$FXUSER" -- bash "$RUN" "$@" >> "$LOG" 2>&1 < /dev/null & )
    fi
}

log_follow() {
    touch "$LOG"
    chmod 600 "$LOG"
    if [[ -z $RUN ]]; then
        journalctl -u "$UNIT" -f -n 0 -o cat >> "$LOG" 2>/dev/null &
        TAIL_PID=$!
        sleep 1
    fi
}

log_unfollow() {
    if [[ -n $TAIL_PID ]]; then
        kill "$TAIL_PID" 2>/dev/null || true
        TAIL_PID=""
    fi
}

log_mark() { wc -c < "$LOG" | tr -d ' '; }
since() { tail -c +"$(( $1 + 1 ))" "$LOG" | sed 's/\x1b\[[0-9;]*m//g'; }

# CPU ticks used so far by the given processes.
cpu_of() {
    local total=0 pid
    for pid in "$@"; do
        [[ -r /proc/$pid/stat ]] || continue
        total=$(( total + $(awk '{print $14 + $15}' "/proc/$pid/stat") ))
    done
    echo "$total"
}
fx_cpu() { cpu_of $(game_pids); }
maria_cpu() { cpu_of $(pgrep -x mariadbd || pgrep -x mysqld || true); }

# Resident memory in kB of the given processes, summed: field VmRSS (now)
# or VmHWM (peak since the process started).
mem_of() {
    local field=$1 total=0 pid kb
    shift
    for pid in "$@"; do
        [[ -r /proc/$pid/status ]] || continue
        kb=$(awk -v f="$field:" '$1 == f {print $2}' "/proc/$pid/status")
        total=$(( total + ${kb:-0} ))
    done
    echo "$total"
}
fx_mem() { mem_of "$1" $(game_pids); }
maria_mem() { mem_of "$1" $(pgrep -x mariadbd || pgrep -x mysqld || true); }

# Stops whatever server holds the ports, after checking nobody is playing on it.
take_box() {
    local n
    WAS=$(active_server)
    if [[ -n $WAS ]]; then
        n=$(players_online)
        if [[ $n != 0 && "${BENCH_FORCE:-0}" != 1 ]]; then
            die "$n player(s) connected to $WAS; not stopping it (BENCH_FORCE=1 overrides)"
        fi
        say "stopping $WAS (running before the bench; started again at the end)"
        systemctl stop "$WAS"
    fi
    if [[ -n $RUN ]] && pgrep -f "$FX_RE" >/dev/null 2>&1; then
        die "an FXServer outside txAdmin is running; stop it first"
    fi
}

# Puts back the server that ran before (or nothing, with BENCH_NO_RESTORE=1).
give_back_box() {
    if [[ "${BENCH_NO_RESTORE:-0}" == 1 ]]; then
        say "BENCH_NO_RESTORE=1: leaving every server stopped"
    elif [[ -n $WAS ]]; then
        say "starting $WAS again"
        systemctl reset-failed "$WAS" 2>/dev/null || true
        systemctl start "$WAS" || say "could not start $WAS"
    else
        say "no server was running before the bench; leaving it stopped"
    fi
}

# oxmysql where the bench can switch it on and off by name: never started by
# a category ensure, and present as resources/oxmysql when $1 is 1 (default).
oxmysql_in() {
    local found need=${1:-1} src
    # A copy inside a category is moved out of resources/, so `ensure [ox]`
    # and the like cannot start it beside cis_database.
    found=$(find "$DATA/resources" -mindepth 2 -maxdepth 3 -type d -name oxmysql -print -quit)
    if [[ -n $found ]]; then
        [[ ! -e $ASIDE/oxmysql ]] || die "$ASIDE/oxmysql already exists (an earlier run left it?); put it back first"
        install -d -o "$FXUSER" -g "$FXUSER" "$ASIDE"
        mv "$found" "$ASIDE/oxmysql"
        OX_MOVED=$found
        say "moved ${found#$DATA/} aside for the run (back at the end)"
    fi
    [[ -e $DATA/resources/oxmysql ]] && return 0
    src=${OX_SRC:-}
    [[ -z $src && -n $OX_MOVED ]] && src=$ASIDE/oxmysql
    if [[ -z $src ]]; then
        [[ $need == 1 ]] && die "no oxmysql under $DATA/resources; set BENCH_OXMYSQL"
        return 0
    fi
    [[ -d $src ]] || die "no oxmysql at $src"
    ln -s "$src" "$DATA/resources/oxmysql"
    OX_LINKED=1
    say "linked $src as resources/oxmysql"
}

oxmysql_out() {
    if [[ $OX_LINKED == 1 && -L $DATA/resources/oxmysql ]]; then
        rm -f "$DATA/resources/oxmysql"
    fi
    if [[ -n $OX_MOVED && -d $ASIDE/oxmysql && ! -e $OX_MOVED ]]; then
        mv "$ASIDE/oxmysql" "$OX_MOVED"
        rmdir "$ASIDE" 2>/dev/null || true
        say "oxmysql back at ${OX_MOVED#$DATA/}"
    fi
}

bench_resource_in() {
    rm -rf "$RES"
    cp -a "$HERE/cis_bench" "$RES"
    chown -R "$FXUSER:$FXUSER" "$RES"
}

env_common() {
    local b
    echo "date: $(date -Is)"
    echo "cpu: $(lscpu | awk -F: '/Model name/{gsub(/^ +/,"",$2); print $2; exit}')"
    echo "cores: $(nproc)"
    echo "ram: $(awk '/MemTotal/{printf "%.0f GiB", $2/1024/1024}' /proc/meminfo)"
    echo "os: $(. /etc/os-release; echo "$PRETTY_NAME")"
    echo "kernel: $(uname -r)"
    b=$(cat "$FXROOT/BUILD" 2>/dev/null || echo '?')
    echo "fxserver: build ${b%%-*}"
    if [[ -z $RUN ]]; then
        echo "txadmin: $(grep -oP "^version\s+'\K[^']+" "$FXROOT/alpine/opt/cfx-server/citizen/system_resources/monitor/fxmanifest.lua" 2>/dev/null || echo '?')"
    fi
    echo "server: $SERVER ($(if [[ -z $RUN ]]; then echo "txAdmin, $UNIT"; else echo "run.sh, no txAdmin"; fi)), whole server.cfg, $(find "$DATA/resources" -name fxmanifest.lua -not -path '*/node_modules/*' | wc -l) resources on disk"
    echo "mariadb: server $(maria 'SELECT VERSION()' 2>/dev/null || echo '?'), client $(mysql --version 2>/dev/null | head -n1)"
}
