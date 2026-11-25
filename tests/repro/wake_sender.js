'use strict';

// The two slice wake sockets listen on 127.0.0.1 ports any local process can
// send to. A datagram from anywhere but the other wake socket must not end a
// slice early. This captures the sockets the engine makes and sends a wake
// byte for every generation from a stranger socket, then from the peer.
// Usage: node tests/repro/wake_sender.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const { DatabaseSync } = require('node:sqlite');

const made = [];
const create = dgram.createSocket;
dgram.createSocket = function (...a) { const s = create.apply(this, a); made.push(s); return s; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-wake-'));
const mariaFile = path.join(dir, 'maria.sqlite');
new DatabaseSync(mariaFile).close();
process.env.FX_RES_DIR = dir;
process.env.FX_MARIA_FILE = mariaFile;

const fx = require('../harness/fx.js');

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

// Each wake socket's message listener, called with a datagram and its sender.
function deliver(sock, byte, from) {
    for (const fn of sock.listeners('message')) fn(Buffer.from([byte]), { address: '127.0.0.1', port: from, family: 'IPv4', size: 1 });
}

(async () => {
    check('engine ready', await fx.ready(20000));
    const socks = made.filter((s) => { try { return s.address().address === '127.0.0.1'; } catch (e) { return false; } });
    check('two wake sockets bound', socks.length === 2, String(socks.length));
    const ports = socks.map((s) => s.address().port);
    // Count endSlice runs through the listener: a slice end clears the timer
    // the engine armed, so watch clearTimeout only while the stranger's
    // datagrams are delivered (synchronously, so no real wake lands inside).
    let cleared = 0;
    let sending = false;
    const realClear = global.clearTimeout;
    global.clearTimeout = function (t) { if (sending) cleared++; return realClear(t); };
    const stranger = 1;
    const load = (async () => { for (let i = 0; i < 40; i++) await fx.call('query', 'SELECT ' + i); })();
    for (let round = 0; round < 40; round++) {
        sending = true;
        for (let g = 0; g < 256; g++) { deliver(socks[0], g, stranger); deliver(socks[1], g, stranger); }
        sending = false;
        await new Promise((r) => setImmediate(r));
    }
    await load;
    const byStranger = cleared;
    global.clearTimeout = realClear;
    check('a datagram from a stranger port ends no slice', byStranger === 0, byStranger + ' slice ends');
    check('the peer port is the other socket', ports[0] !== ports[1] && ports.every((p) => p > 0), ports.join(','));
    const failed = results.filter((x) => !x).length;
    console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('FAIL ' + (e && e.stack || e));
    process.exit(1);
});
