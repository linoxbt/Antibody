// FR-18: the always-on sentinel. Streams checkpoints when it can, polls when it
// can't, never overlaps scans, and catches a poisoned coin with nobody watching.
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { createWorld, POISON_COIN, seedBaseline, type World } from '../src/dev/world.ts';
import { watchWallet } from '../src/ingest/watch.ts';
import type { ScanResult } from '../src/ingest/scan.ts';

const worlds: World[] = [];
after(() => worlds.forEach((w) => w.dispose()));
const until = async (cond: () => boolean, ms = 5000) => {
  const t = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > t) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const result = (checkpoint: number): ScanResult => ({ checkpoint, items: [], skipped: 0 }) as unknown as ScanResult;

test('stream: a burst of checkpoints collapses into few scans; scans never overlap', async () => {
  let push: (n: number) => void = () => {};
  let ckpt = 100;
  let inFlight = 0;
  let maxInFlight = 0;
  let scans = 0;
  const ac = new AbortController();
  const run = watchWallet({
    wallet: '0x1',
    signal: ac.signal,
    minScanGapMs: 20,
    chain: {
      latestCheckpoint: async () => ckpt,
      watchCheckpoints: (_a, on, signal) => new Promise<void>((res) => ((push = on), signal.addEventListener('abort', () => res()))),
    },
    scan: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      scans++;
      return result(ckpt);
    },
  });
  await until(() => scans === 1); // startup catch-up
  for (let i = 0; i < 50; i++) push((ckpt = 101 + i));
  await until(() => scans >= 2);
  await new Promise((r) => setTimeout(r, 120));
  ac.abort();
  const r = await run;
  assert.equal(maxInFlight, 1);
  assert.ok(r.scans >= 2 && r.scans <= 4, `50 checkpoints → ${r.scans} scans`);
  assert.equal(r.mode, 'stream');
});

test('a failing stream falls back to polling; a failing scan does not stop the sentinel', async () => {
  let ckpt = 5;
  let calls = 0;
  const events: string[] = [];
  const ac = new AbortController();
  const run = watchWallet({
    wallet: '0x1',
    signal: ac.signal,
    pollMs: 10,
    minScanGapMs: 0,
    retryStreamMs: 60_000,
    log: (e) => events.push(e),
    chain: { latestCheckpoint: async () => ckpt, watchCheckpoints: async () => Promise.reject(new Error('UNIMPLEMENTED')) },
    scan: async () => {
      calls++;
      if (calls === 2) throw new Error('relayer hiccup');
      return result(ckpt);
    },
  });
  await until(() => calls === 1);
  ckpt = 6; // poll sees it; this scan fails
  await until(() => calls === 2);
  ckpt = 7; // and the next one recovers
  await until(() => calls === 3);
  ac.abort();
  const r = await run;
  assert.equal(r.mode, 'poll');
  assert.ok(events.includes('stream.error') && events.includes('scan.error'), events.join(','));
});

test('offline end-to-end: an airdropped poisoned coin is observed and raises an incident with no manual scan', async () => {
  const w = await createWorld();
  worlds.push(w);
  await seedBaseline(w);
  const ac = new AbortController();
  const seen: ScanResult[] = [];
  const run = watchWallet({ chain: w.rt.chain, wallet: w.setup.wallet, scan: () => w.scan(), signal: ac.signal, pollMs: 20, minScanGapMs: 0, onScan: (r) => seen.push(r) });
  await until(() => seen.length >= 1);
  assert.equal(w.rt.chain.watchCheckpoints, undefined, 'the fixture chain cannot stream: polling');
  const coin = w.airdrop(POISON_COIN);
  await until(() => seen.some((r) => r.items.some((i) => i.objectId === coin.objectId)), 10_000);
  ac.abort();
  await run;
  const hit = seen.flatMap((r) => r.items).find((i) => i.objectId === coin.objectId)!;
  assert.ok(hit.incident, 'the sentinel raised an incident on its own');
  assert.ok(w.control.incidents.list().some((i) => i.objectId === coin.objectId));
});
