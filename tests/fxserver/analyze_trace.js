'use strict';

// Test only. Reads a vps_check.sh trace folder (idle.log, shootout.log and the
// frame_trace JSON files) and prints where frame time goes, per pass and per
// shootout vector. A 2 s window is charged to the vector whose result line
// comes after it, so windows that straddle two vectors land in the later one.
// Usage: node tests/fxserver/analyze_trace.js <trace folder>

const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) { console.error('usage: analyze_trace.js <trace folder>'); process.exit(2); }

const CATS = ['sqlite', 'js', 'cb', 'poll', 'replica', 'ckpt', 'uv', 'gc', 'other'];

function parseFrames(line) {
    const m = line.match(/CISFRAMES t=([\d.]+) frames=(\d+) hitches=(\d+) hitch_ms=([\d.]+) max=([\d.]+) mean=([\d.]+) b=([\d,]+)/);
    if (!m) return null;
    return { frames: +m[2], hitches: +m[3], hitchMs: +m[4], max: +m[5], mean: +m[6], b: m[7].split(',').map(Number) };
}

function traceFiles(prefix) {
    return fs.readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith('.json')).sort()
        .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
}

// Splits a log into boots at the "===== ... boot" markers vps_check and
// run_shootout write, and labels windows by the vector line that follows.
function segments(text) {
    const boots = [];
    let cur = null;
    let traceIdx = 0;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (/^=====.*(shootout boot|vps_check boot|restore txAdmin|warm-up boot)/.test(line)) {
            cur = { title: line, segs: [], open: { label: 'boot+seed', frames: [], trace: [] }, traceLines: 0 };
            boots.push(cur);
            traceIdx = 0;
            continue;
        }
        if (!cur) {
            cur = { title: '(start)', segs: [], open: { label: 'boot+seed', frames: [], trace: [] }, traceLines: 0 };
            boots.push(cur);
        }
        const f = parseFrames(line);
        if (f) { cur.open.frames.push(f); continue; }
        if (line.includes('frame_trace t=')) { cur.open.trace.push(traceIdx++); cur.traceLines++; continue; }
        const v = line.match(/\[cis_shootout\] (v\d+) (\w+)/);
        if (v) {
            cur.open.label = v[1] + ' ' + (v[2] === 'burst' ? 'burst_100x50' : v[2]);
            cur.segs.push(cur.open);
            cur.open = { label: 'after', frames: [], trace: [] };
        }
    }
    for (const b of boots) b.segs.push(b.open);
    return boots;
}

function sumFrames(list) {
    const o = { windows: list.length, frames: 0, hitches: 0, hitchMs: 0, max: 0, b: [0, 0, 0, 0, 0, 0, 0] };
    for (const f of list) {
        o.frames += f.frames; o.hitches += f.hitches; o.hitchMs += f.hitchMs; o.max = Math.max(o.max, f.max);
        f.b.forEach((x, i) => { o.b[i] += x; });
    }
    return o;
}

// Weighted mean of per-frame category times over the windows of a segment.
function sumTrace(windows, idxs, key) {
    const o = { frames: 0 };
    CATS.concat(['gap', 'calls']).forEach((c) => { o[c] = 0; });
    for (const i of idxs) {
        const w = windows[i];
        if (!w) continue;
        const p = w[key];
        if (!p || !p.frames) continue;
        o.frames += p.frames;
        CATS.concat(['gap', 'calls']).forEach((c) => { o[c] += (p[c] || 0) * p.frames; });
    }
    if (o.frames) CATS.concat(['gap', 'calls']).forEach((c) => { o[c] /= o.frames; });
    return o;
}

const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2);

function report(name, text, traces) {
    console.log('\n## ' + name);
    const boots = segments(text);
    boots.forEach((boot, bi) => {
        const all = sumFrames([].concat(...boot.segs.map((s) => s.frames)));
        if (!all.windows && !boot.traceLines) return;
        const tr = boot.traceLines ? traces.shift() : null;
        console.log('\n### boot ' + (bi + 1) + ': ' + boot.title);
        console.log('framewatch: ' + all.frames + ' frames, ' + all.hitches + ' hitches (' + f1(all.hitchMs) + ' ms in hitch frames), max ' + f1(all.max)
            + ' ms, buckets <4/<8/<16.6/<33/<50/<100/>=100: ' + all.b.join('/'));
        console.log('| segment | frames | hitches | hitch ms | max ms | per hitch frame (ms): gap / sqlite / js / cb / poll / replica / ckpt / uv / gc / other / calls | per frame (ms): gap / sqlite / js / cb / uv / other / calls |');
        console.log('|---|---:|---:|---:|---:|---|---|');
        for (const s of boot.segs) {
            const fr = sumFrames(s.frames);
            if (!fr.windows && !s.trace.length) continue;
            let h = '', a = '';
            if (tr) {
                const th = sumTrace(tr.windows, s.trace, 'perHitchFrame');
                const ta = sumTrace(tr.windows, s.trace, 'perFrame');
                if (th.frames) h = [th.gap, th.sqlite, th.js, th.cb, th.poll, th.replica, th.ckpt, th.uv, th.gc, th.other].map(f2).join(' / ') + ' / ' + f1(th.calls);
                if (ta.frames) a = [ta.gap, ta.sqlite, ta.js, ta.cb, ta.uv, ta.other].map(f2).join(' / ') + ' / ' + f1(ta.calls);
            }
            console.log('| ' + s.label + ' | ' + fr.frames + ' | ' + fr.hitches + ' | ' + f1(fr.hitchMs) + ' | ' + f1(fr.max) + ' | ' + h + ' | ' + a + ' |');
        }
        if (tr && tr.total) {
            const worst = [].concat(...tr.windows.map((w) => w.worst || [])).sort((x, y) => y.gap - x.gap).slice(0, 8);
            console.log('worst frames: ' + worst.map((w) => 'gap=' + w.gap + ' sqlite=' + w.sqlite + ' js=' + w.js + ' cb=' + w.cb + ' replica=' + w.replica + ' ckpt=' + w.ckpt + ' uv=' + w.uv + ' gc=' + w.gc + ' calls=' + w.calls).join(' | '));
        }
    });
}

report('Idle floor', fs.readFileSync(path.join(dir, 'idle.log'), 'utf8'), traceFiles('idle_'));
report('Shootout', fs.readFileSync(path.join(dir, 'shootout.log'), 'utf8'), traceFiles('shootout_'));
