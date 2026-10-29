/**
 * The sentinel, always on (FR-18). Instead of waiting for someone to run
 * `antibody ingest scan`, the ingest daemon follows the chain:
 *
 *   stream  Sui gRPC SubscriptionService.SubscribeCheckpoints, filtered to
 *           checkpoints that touch Steward's wallet; each one triggers a scan.
 *   poll    when streaming is unavailable (JSON-RPC transport, the fixture
 *           chain, or a gateway that refuses the stream), the latest
 *           checkpoint is polled; streaming is retried every few minutes.
 *
 * Scans never overlap and run at most once per minScanGapMs. A burst of
 * checkpoints collapses into one scan. A failed scan is logged and retried
 * on the next tick: the sentinel must not die because one read failed.
 */
import type { ChainReader } from '../adapters/chain.ts';
import type { ScanResult } from './scan.ts';

export interface WatchOptions {
  chain: Pick<ChainReader, 'latestCheckpoint' | 'watchCheckpoints'>;
  wallet: string;
  scan: () => Promise<ScanResult>;
  signal: AbortSignal;
  pollMs?: number;
  minScanGapMs?: number;
  /** How long to poll after a stream failure before trying to stream again. */
  retryStreamMs?: number;
  log?: (event: string, data?: Record<string, unknown>) => void;
  onScan?: (r: ScanResult, why: string) => void;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res) => {
    if (signal.aborted) return res();
    const t = setTimeout(res, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), res()), { once: true });
  });

export async function watchWallet(o: WatchOptions): Promise<{ scans: number; mode: 'stream' | 'poll' }> {
  const log = o.log ?? (() => {});
  const pollMs = o.pollMs ?? 4000;
  const gap = o.minScanGapMs ?? 1500;
  const retryStreamMs = o.retryStreamMs ?? 180_000;
  let lastScanned = -1;
  let lastScanAt = 0;
  let want = -1; // highest checkpoint seen that has not been scanned
  let running: Promise<void> | null = null;
  let scans = 0;
  let mode: 'stream' | 'poll' = o.chain.watchCheckpoints ? 'stream' : 'poll';

  const runScans = async (why: string) => {
    while (!o.signal.aborted && (want > lastScanned || lastScanned < 0)) {
      const wait = lastScanAt + gap - Date.now();
      if (wait > 0) await sleep(wait, o.signal);
      if (o.signal.aborted) return;
      const target = want;
      lastScanAt = Date.now();
      try {
        const r = await o.scan();
        scans++;
        lastScanned = Math.max(r.checkpoint, target, lastScanned, 0);
        log('scan', { why, checkpoint: r.checkpoint, new: r.items.length, incidents: r.items.filter((i) => i.incident).length });
        o.onScan?.(r, why);
      } catch (e) {
        log('scan.error', { why, error: (e as Error).message });
        return; // the next tick tries again
      }
    }
  };
  const trigger = (seq: number, why: string) => {
    if (seq > want) want = seq;
    if (!running) running = runScans(why).finally(() => (running = null));
  };

  trigger(0, 'startup'); // catch up on anything that landed while we were down
  while (!o.signal.aborted) {
    if (o.chain.watchCheckpoints && mode === 'stream') {
      log('stream.open', { wallet: o.wallet });
      try {
        await o.chain.watchCheckpoints(o.wallet, (seq) => trigger(seq, 'stream'), o.signal);
        if (o.signal.aborted) break;
        log('stream.end');
      } catch (e) {
        if (o.signal.aborted) break;
        log('stream.error', { error: (e as Error).message, fallback: 'poll' });
        mode = 'poll';
      }
      continue;
    }
    // Poll, and give streaming another chance after a while.
    const until = Date.now() + (o.chain.watchCheckpoints ? retryStreamMs : Infinity);
    while (!o.signal.aborted && Date.now() < until) {
      try {
        const seq = await o.chain.latestCheckpoint();
        if (seq > want) trigger(seq, 'poll');
      } catch (e) {
        log('poll.error', { error: (e as Error).message });
      }
      await sleep(pollMs, o.signal);
    }
    if (o.chain.watchCheckpoints && !o.signal.aborted) mode = 'stream';
  }
  await running;
  return { scans, mode };
}
