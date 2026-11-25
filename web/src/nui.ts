export type SlowRow = { t: number; ms: number; from: string; sql: string };
export type CdcRow = { t: number; table: string; rows: number };

export type Snap = {
  backend: string;
  profile: string;
  ready: boolean;
  p50us: number;
  p99us: number;
  qps: number;
  queue: number;
  queueMax: number;
  flushPerSec: number;
  batchSize: number;
  flushMs: number;
  drops: number;
  idClash: number;
  cdcOn: boolean;
  cdcPollMs: number;
  cdcDirtyMs: number;
  slowMs: number;
  slow: SlowRow[];
  cdc: CdcRow[];
};

export const emptySnap = (): Snap => ({
  backend: 'node:sqlite',
  profile: 'durable',
  ready: true,
  p50us: 0,
  p99us: 0,
  qps: 0,
  queue: 0,
  queueMax: 4096,
  flushPerSec: 0,
  batchSize: 64,
  flushMs: 50,
  drops: 0,
  idClash: 0,
  cdcOn: true,
  cdcPollMs: 1000,
  cdcDirtyMs: 2000,
  slowMs: 100,
  slow: [],
  cdc: [],
});

export function inBrowser(): boolean {
  return !(window as unknown as { invokeNative?: unknown }).invokeNative;
}

export async function fetchNui(event: string): Promise<void> {
  if (inBrowser()) return;
  const name = (window as unknown as { GetParentResourceName?: () => string }).GetParentResourceName?.() ?? 'cis_database';
  await fetch(`https://${name}/${event}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: '{}',
  });
}
