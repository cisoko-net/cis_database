'use strict';

// Kills the MariaDB the MariaDB tests started, found by the port in their
// URL, and no other. `taskkill /IM mariadbd.exe` also killed a MariaDB the
// developer runs for something else.

const { execFileSync } = require('child_process');

function portOf(url) {
    const m = /^[a-z]+:\/\/(?:[^@/]*@)?[^:/]+:(\d+)/i.exec(String(url || ''));
    return m ? Number(m[1]) : 3306;
}

// PIDs in `netstat -ano -p TCP` output listening on exactly that port.
function listeningPids(text, port) {
    const out = [];
    for (const line of String(text).split(/\r?\n/)) {
        const f = line.trim().split(/\s+/);
        if (f.length < 5 || f[0] !== 'TCP' || f[3] !== 'LISTENING') continue;
        if (!f[1].endsWith(':' + port)) continue;
        const pid = Number(f[4]);
        if (pid > 0 && !out.includes(pid)) out.push(pid);
    }
    return out;
}

function killListening(url) {
    let text = '';
    try { text = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }); } catch (e) { return; }
    for (const pid of listeningPids(text, portOf(url))) {
        try { execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' }); } catch (e) { /* already gone */ }
    }
}

module.exports = { portOf, listeningPids, killListening };
