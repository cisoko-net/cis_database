'use strict';
// Test only. Answers the callback through a chosen path so wake.lua can time
// the Lua side's resume.
const fs = require('fs');
const path = require('path');

// A worker thread that answers pings and runs node:sqlite, to see whether
// FXServer's Node allows both and how fast a worker reply wakes the loop.
let worker = null;
let workerErr = '';
const waiting = new Map();
let seq = 0;
try {
    const { Worker } = require('worker_threads');
    const db = path.join(GetResourcePath(GetCurrentResourceName()), 'wake_worker.sqlite');
    worker = new Worker(`
        const { parentPort, workerData } = require('worker_threads');
        let db = null, err = '';
        try {
            const { DatabaseSync } = require('node:sqlite');
            db = new DatabaseSync(workerData.db);
            db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
        } catch (e) { err = String(e && e.message || e); }
        parentPort.on('message', (m) => {
            if (m.op === 'sql') {
                let r = null, e2 = err;
                try { if (db) { db.prepare('INSERT INTO t (v) VALUES (?)').run('x'); r = db.prepare('SELECT COUNT(*) AS n FROM t').get().n; } } catch (e) { e2 = String(e && e.message || e); }
                parentPort.postMessage({ id: m.id, r, err: e2 });
            } else parentPort.postMessage({ id: m.id, r: 1 });
        });
    `, { eval: true, workerData: { db } });
    worker.on('message', (m) => { const cb = waiting.get(m.id); waiting.delete(m.id); if (cb) cb(m); });
    worker.on('error', (e) => { workerErr = String(e && e.message || e); });
    worker.unref();
} catch (e) {
    workerErr = String(e && e.message || e);
}
function viaWorker(op, cb) {
    if (!worker) return cb({ err: 'no worker: ' + workerErr });
    const id = ++seq;
    waiting.set(id, cb);
    worker.postMessage({ id, op });
}
exports('workerInfo', (cb) => {
    viaWorker('sql', (m) => cb(JSON.stringify({ workerErr, reply: m })));
});
exports('later', (mode, cb) => {
    if (mode === 'sync') cb(1);
    else if (mode === 'tick') process.nextTick(() => cb(1));
    else if (mode === 'micro') Promise.resolve().then(() => cb(1));
    else if (mode === 'immediate') setImmediate(() => cb(1));
    else if (mode === 'timeout0') setTimeout(() => cb(1), 0);
    else if (mode === 'io') fs.stat(GetResourcePath(GetCurrentResourceName()), () => cb(1));
    else if (mode === 'worker') viaWorker('ping', () => cb(1));
    else cb(0);
});
// How late setImmediate / setTimeout / fs.stat fire on their own, in JS.
exports('jsLate', (mode, cb) => {
    const t0 = performance.now();
    const done = () => cb(performance.now() - t0);
    if (mode === 'immediate') setImmediate(done);
    else if (mode === 'timeout0') setTimeout(done, 0);
    else if (mode === 'worker') viaWorker('ping', done);
    else if (mode === 'workersql') viaWorker('sql', done);
    else fs.stat(GetResourcePath(GetCurrentResourceName()), done);
});

// Wake paths that do not go through libuv's thread pool, where fs.stat
// queues behind fsyncs and other resources' file work.
const wakers = {};
try {
    const { port1, port2 } = new MessageChannel();
    let mcCb = null;
    port2.on('message', () => { const c = mcCb; mcCb = null; if (c) c(); });
    port2.unref();
    wakers.mc = (cb) => { mcCb = cb; port1.postMessage(0); };
} catch (e) { wakers.mcErr = String(e && e.message || e); }
try {
    const dgram = require('dgram');
    const sock = dgram.createSocket('udp4');
    let udpCb = null;
    sock.on('message', () => { const c = udpCb; udpCb = null; if (c) c(); });
    sock.bind(0, '127.0.0.1', () => { wakers.udp = (cb) => { udpCb = cb; sock.send(Buffer.alloc(1), sock.address().port, '127.0.0.1'); }; });
    sock.unref();
} catch (e) { wakers.udpErr = String(e && e.message || e); }
try {
    const net = require('net');
    const srv = net.createServer((s) => { s.on('data', () => { const c = wakers.tcpCb; wakers.tcpCb = null; if (c) c(); }); });
    srv.listen(0, '127.0.0.1', () => {
        const cl = net.connect(srv.address().port, '127.0.0.1', () => {
            cl.setNoDelay(true);
            wakers.tcp = (cb) => { wakers.tcpCb = cb; cl.write('x'); };
        });
        cl.unref();
    });
    srv.unref();
} catch (e) { wakers.tcpErr = String(e && e.message || e); }
wakers.io = (cb) => fs.stat(GetResourcePath(GetCurrentResourceName()), () => cb());

// Keeps all four thread-pool threads busy for ms milliseconds.
function busyPool(ms) {
    const crypto = require('crypto');
    const end = Date.now() + ms;
    const one = () => { if (Date.now() < end) crypto.pbkdf2('x', 'y', 20000, 32, 'sha256', one); };
    for (let i = 0; i < 4; i++) one();
}
exports('wakeInfo', (cb) => cb(JSON.stringify(Object.keys(wakers))));
exports('wakeLate', (mode, busy, cb) => {
    const w = wakers[mode];
    if (!w) return cb(-1);
    if (busy) busyPool(300);
    const t0 = performance.now();
    w(() => cb(performance.now() - t0));
});

// fdatasync of a small append, the way a WAL sync after one commit looks.
{
    const syncFile = path.join(GetResourcePath(GetCurrentResourceName()), 'wake_sync.bin');
    const sfd = fs.openSync(syncFile, 'w+');
    const chunk = Buffer.alloc(4096, 1);
    wakers.fsync = (cb) => { fs.writeSync(sfd, chunk); fs.fdatasync(sfd, () => cb()); };
    exports('fsyncSyncMs', (cb) => { const a = performance.now(); fs.writeSync(sfd, chunk); fs.fdatasyncSync(sfd); cb(performance.now() - a); });
}

// The same fdatasync while two UDP sockets ping-pong datagrams, so the loop
// keeps turning until the sync's completion is picked up. If this is much
// faster than plain fsync, the delay is the loop's wake, not the disk.
{
    const dgram = require('dgram');
    const a = dgram.createSocket('udp4');
    const b = dgram.createSocket('udp4');
    let pending = 0;
    const one = Buffer.alloc(1);
    let ready = 0;
    a.bind(0, '127.0.0.1', () => { ready++; });
    b.bind(0, '127.0.0.1', () => { ready++; });
    a.on('message', () => { if (pending) a.send(one, b.address().port, '127.0.0.1'); });
    b.on('message', () => { if (pending) b.send(one, a.address().port, '127.0.0.1'); });
    a.unref(); b.unref();
    const syncFile2 = path.join(GetResourcePath(GetCurrentResourceName()), 'wake_sync2.bin');
    const fd2 = fs.openSync(syncFile2, 'w+');
    const chunk2 = Buffer.alloc(4096, 1);
    wakers.fsyncpp = (cb) => {
        fs.writeSync(fd2, chunk2);
        pending++;
        fs.fdatasync(fd2, () => { pending--; cb(); });
        if (ready === 2) a.send(one, b.address().port, '127.0.0.1');
    };
    // Only a datagram after the sync, to see the pool's own delivery.
    wakers.fsyncpool = (cb) => {
        fs.writeSync(fd2, chunk2);
        const t0 = performance.now();
        fs.fdatasync(fd2, () => cb());
    };
}

// A datagram echoed by another process (python on 127.0.0.1:40001), so the
// reply is a real wake from outside, like a MariaDB answer.
{
    const dgram = require('dgram');
    const s = dgram.createSocket('udp4');
    let cbx = null;
    s.on('message', () => { const c = cbx; cbx = null; if (c) c(); });
    s.bind(0, '127.0.0.1');
    s.unref();
    wakers.ext = (cb) => { cbx = cb; s.send(Buffer.alloc(1), 40001, '127.0.0.1'); };
}

// fdatasync after overwriting a block of a preallocated file: no size or
// extent change, so ext4 has no journal commit to wait for.
{
    const f3 = path.join(GetResourcePath(GetCurrentResourceName()), 'wake_sync3.bin');
    const fd3 = fs.openSync(f3, 'w+');
    const big = Buffer.alloc(8 << 20, 0);
    fs.writeSync(fd3, big, 0, big.length, 0);
    fs.fsyncSync(fd3);
    const blk = Buffer.alloc(4096, 1);
    let k = 0;
    wakers.fsyncow = (cb) => { fs.writeSync(fd3, blk, 0, 4096, (k++ % 2000) * 4096); fs.fdatasync(fd3, () => cb()); };
    exports('fsyncOwSyncMs', (cb) => { const a = performance.now(); fs.writeSync(fd3, blk, 0, 4096, (k++ % 2000) * 4096); fs.fdatasyncSync(fd3); cb(performance.now() - a); });
}

// V8 heap layout of FXServer's Node isolate (young generation size decides
// how often big temporary strings get promoted and collected the slow way).
RegisterCommand('cis_heap', () => {
    const v8 = require('v8');
    const sp = v8.getHeapSpaceStatistics().map((s) => s.space_name + '=' + Math.round(s.space_size / 1024) + 'KB/' + Math.round(s.space_used_size / 1024) + 'KB');
    const h = v8.getHeapStatistics();
    console.log('CISHEAP limit=' + Math.round(h.heap_size_limit / 1048576) + 'MB total=' + Math.round(h.total_heap_size / 1048576) + 'MB used=' + Math.round(h.used_heap_size / 1048576) + 'MB ' + sp.join(' '));
    console.log('CISHEAP execArgv=' + JSON.stringify(process.execArgv) + ' NODE_OPTIONS=' + (process.env.NODE_OPTIONS || ''));
}, true);
