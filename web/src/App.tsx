import { useEffect, useMemo, useState } from 'react';
import { emptySnap, fetchNui, inBrowser, type Snap } from './nui';

const tabs = ['Overview', 'Queue & Replication', 'CDC & Ingress', 'Slow Queries'] as const;
type Tab = (typeof tabs)[number];

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function clock(t: number): string {
  if (!t) return '—';
  const d = new Date(t);
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

function Spark({ samples }: { samples: number[] }) {
  const w = 880;
  const h = 150;
  const max = Math.max(1, ...samples);
  const step = samples.length > 1 ? w / (samples.length - 1) : w;
  const pts = samples.map((v, i) => `${i * step},${h - (v / max) * (h - 8) - 4}`).join(' ');
  const fill = samples.length ? `0,${h} ${pts} ${(samples.length - 1) * step},${h}` : '';
  return (
    <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Queries per second">
      <polygon className="spark-fill" points={fill} />
      <polyline className="spark-line" points={pts} />
    </svg>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>('Overview');
  const [snap, setSnap] = useState<Snap>(emptySnap);
  const [qps, setQps] = useState<number[]>(() => Array(32).fill(0));
  const [on, setOn] = useState(false);

  function shut() {
    setOn(false);
    fetchNui('close');
  }

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const action = e.data?.action;
      if (action === 'open') {
        setOn(true);
        if (e.data.data) setSnap(e.data.data as Snap);
      } else if (action === 'tick' && e.data.data) {
        const next = e.data.data as Snap;
        setSnap(next);
        setQps((prev) => prev.slice(1).concat(next.qps || 0));
      } else if (action === 'close') {
        setOn(false);
      }
    };
    window.addEventListener('message', onMsg);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') shut();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('message', onMsg);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    if (!inBrowser()) return;
    setOn(true);
    const id = window.setInterval(() => {
      setQps((prev) => {
        const n = 800 + Math.round(Math.random() * 400);
        setSnap((s) => ({ ...s, qps: n, p50us: 175, p99us: 310, queue: 2 }));
        return prev.slice(1).concat(n);
      });
    }, 750);
    return () => window.clearInterval(id);
  }, []);

  const queuePct = useMemo(() => {
    if (!snap.queueMax) return 0;
    return Math.min(100, Math.round((snap.queue / snap.queueMax) * 100));
  }, [snap.queue, snap.queueMax]);

  if (!on) return null;

  const bad = snap.drops > 0;

  return (
    <div className="stage">
      <section className="window" role="dialog" aria-label="cis_database telemetry">
        <header className="head">
          <img className="logo" src="./cisoko-logo.png" alt="" />
          <div className="title">cis_database <span>Telemetry</span></div>
          <div className="caps">
            <div className="cap"><i className={snap.ready ? 'dot' : 'dot bad'} />{snap.ready ? 'Connected' : 'Not ready'}</div>
            <div className="cap">{snap.backend} WAL</div>
            <div className="cap">{snap.profile}</div>
          </div>
          <button className="close" type="button" aria-label="Close" onClick={shut}>×</button>
        </header>
        <div className="switch" role="tablist">
          {tabs.map((name) => (
            <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>
              {name}
            </button>
          ))}
        </div>
        <div className="body" role="tabpanel">
          {tab === 'Overview' && (
            <>
              <div className="cards">
                <article className="card">
                  <div className="label">Read latency</div>
                  <div className="figure">{fmt(snap.p50us)}<span className="unit">µs</span></div>
                  <div className="sub">p99 {fmt(snap.p99us)} µs</div>
                </article>
                <article className="card">
                  <div className="label">Write-behind queue</div>
                  <div className="figure">{fmt(snap.queue)}<span className="unit">/ {fmt(snap.queueMax)}</span></div>
                  <div className="sub">Kept in the SQLite outbox until MariaDB has it</div>
                </article>
                <article className="card">
                  <div className="label">Change data capture</div>
                  <div className="figure">{snap.cdcOn ? 'On' : 'Off'}</div>
                  <div className="sub">{fmt(snap.cdcPollMs)} ms poll</div>
                </article>
                <article className="card">
                  <div className="label">Rejected writes</div>
                  <div className="figure">{fmt(snap.drops)}</div>
                  <div className="sub">{snap.idClash > 0 ? fmt(snap.idClash) + ' duplicate keys: check the server log' : bad ? 'Check the server log' : 'None this session'}</div>
                </article>
              </div>
              <div className="chart">
                <h2>Queries per second · {fmt(snap.qps)}</h2>
                <Spark samples={qps} />
              </div>
            </>
          )}
          {tab === 'Queue & Replication' && (
            <div className="stack">
              <article className="card">
                <div className="label">Queue depth</div>
                <div className="figure">{queuePct}<span className="unit">%</span></div>
                <div className="gauge" aria-hidden="true"><span style={{ width: queuePct + '%' }} /></div>
                <div className="sub">{fmt(snap.queue)} of {fmt(snap.queueMax)} · batch {snap.batchSize} · flush every {snap.flushMs} ms</div>
              </article>
              <article className="card">
                <div className="label">Flushes</div>
                <div className="figure">{fmt(snap.flushPerSec)}<span className="unit">/s</span></div>
                <div className="sub">Batches sent to MariaDB per second</div>
              </article>
            </div>
          )}
          {tab === 'CDC & Ingress' && (
            <div className="stack">
              <article className="card">
                <div className="label">Catch-up</div>
                <div className="figure">{snap.cdcOn ? 'Watching' : 'Off'}</div>
                <div className="sub">Poll {fmt(snap.cdcPollMs)} ms · a table this server just wrote is skipped for {fmt(snap.cdcDirtyMs)} ms</div>
              </article>
              <table>
                <thead><tr><th>Time</th><th>Table</th><th>Rows</th></tr></thead>
                <tbody>
                  {snap.cdc.length === 0 && <tr><td className="empty" colSpan={3}>No external changes since you opened this.</td></tr>}
                  {snap.cdc.map((row, i) => (
                    <tr key={row.t + '-' + i}><td>{clock(row.t)}</td><td>{row.table}</td><td>{fmt(row.rows)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {tab === 'Slow Queries' && (
            <table>
              <thead><tr><th>Time</th><th>Duration</th><th>Resource</th><th>Statement</th></tr></thead>
              <tbody>
                {snap.slow.length === 0 && <tr><td className="empty" colSpan={4}>Nothing over {snap.slowMs} ms since you opened this.</td></tr>}
                {snap.slow.map((row, i) => (
                  <tr key={row.t + '-' + i}>
                    <td>{clock(row.t)}</td>
                    <td>{row.ms} ms</td>
                    <td>{row.from || '—'}</td>
                    <td className="sql">{row.sql}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
