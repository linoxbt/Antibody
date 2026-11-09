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
  /** Least time between two scans in polling mode (default 15 s). */
  pollScanMs?: number;
  minScanGapMs?: number;
  /** How long to poll after a stream failure before trying to stream again. */
  retryStreamMs?: number;
  /** A stream silent this long (not even a heartbeat) is dropped and reopened. */
  staleMs?: number;
  /** Scan this often whatever the stream says, so a quiet failure cannot hide an object for long. */
  safetyScanMs?: number;
  log?: (event: string, data?: Record<string, unknown>) => void;
  onScan?: (r: ScanResult, why: string) => void;
}

/** Abortable sleep that removes its abort listener when the timer fires (B24: no listener per tick). */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res) => {
    if (signal.aborted) return res();
    const onAbort = () => (clearTimeout(t), res());
    const t = setTimeout(() => (signal.removeEventListener('abort', onAbort), res()), ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

export async function watchWallet(o: WatchOptions): Promise<{ scans: number; mode: 'stream' | 'poll' }> {
  const log = o.log ?? (() => {});
  const pollMs = o.pollMs ?? 4000;
  // An explicit pollMs (tests, a quiet test chain) keeps one scan per poll unless pollScanMs says otherwise.
  const pollScanMs = o.pollScanMs ?? (o.pollMs !== undefined ? o.pollMs : 15_000);
  const gap = o.minScanGapMs ?? 1500;
  const retryStreamMs = o.retryStreamMs ?? 180_000;
  const staleMs = o.staleMs ?? 120_000;
  const safetyScanMs = o.safetyScanMs ?? 300_000;
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
  const safety = setInterval(() => trigger(Math.max(want, lastScanned) + 1, 'safety'), safetyScanMs);
  safety.unref?.();
  let quickEnds = 0;
  while (!o.signal.aborted) {
    if (o.chain.watchCheckpoints && mode === 'stream') {
      log('stream.open', { wallet: o.wallet });
      const opened = Date.now();
      // Watchdog: an open stream that has gone quiet never ends on its own, and
      // the sentinel would be deaf. Any message, heartbeats included, is life.
      const ctl = new AbortController();
      const onOuterAbort = () => ctl.abort();
      o.signal.addEventListener('abort', onOuterAbort, { once: true });
      let lastMsg = Date.now();
      let stale = false;
      const dog = setInterval(() => {
        if (Date.now() - lastMsg > staleMs) {
          stale = true;
          ctl.abort();
        }
      }, Math.max(50, Math.min(15_000, staleMs / 4)));
      const alive = () => (lastMsg = Date.now());
      try {
        await o.chain.watchCheckpoints(o.wallet, (seq) => (alive(), trigger(seq, 'stream')), ctl.signal, alive);
        if (o.signal.aborted) break;
        if (stale) {
          log('stream.stale', { silentMs: Date.now() - lastMsg });
          continue;
        }
        log('stream.end');
        // B24: a stream that keeps ending at once must not spin: back off, then fall back to polling.
        quickEnds = Date.now() - opened < 5_000 ? quickEnds + 1 : 0;
        if (quickEnds >= 3) {
          log('stream.flapping', { fallback: 'poll' });
          mode = 'poll';
          quickEnds = 0;
        } else await sleep(Math.min(30_000, 500 * 2 ** (quickEnds - 1)), o.signal);
      } catch (e) {
        if (o.signal.aborted) break;
        if (stale) {
          log('stream.stale', { silentMs: Date.now() - lastMsg });
          continue;
        }
        log('stream.error', { error: (e as Error).message, fallback: 'poll' });
        mode = 'poll';
      } finally {
        clearInterval(dog);
        o.signal.removeEventListener('abort', onOuterAbort);
      }
      continue;
    }
    // Poll, and give streaming another chance after a while.
    const until = Date.now() + (o.chain.watchCheckpoints ? retryStreamMs : Infinity);
    let lastPollScan = 0;
    while (!o.signal.aborted && Date.now() < until) {
      try {
        const seq = await o.chain.latestCheckpoint();
        // Performance: Sui makes several checkpoints a second, so without the stream (which only
        // reports checkpoints touching the wallet) a scan runs at most every pollScanMs.
        if (seq > want && Date.now() - lastPollScan >= pollScanMs) {
          lastPollScan = Date.now();
          trigger(seq, 'poll');
        }
      } catch (e) {
        log('poll.error', { error: (e as Error).message });
      }
      await sleep(pollMs, o.signal);
    }
    if (o.chain.watchCheckpoints && !o.signal.aborted) mode = 'stream';
  }
  clearInterval(safety);
  await running;
  return { scans, mode };
}
