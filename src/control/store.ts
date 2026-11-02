/**
 * Control's local files. The text cache and incidents are disposable (never a
 * source of truth: rebuild --fresh ignores them). The high-water mark is the
 * rollback guard and survives a cache wipe (spec §7).
 */
import { join } from 'node:path';
import { JsonFileStore } from '../adapters/filestore.ts';
import type { StoredMemory } from '../core/types.ts';

export class TextCache {
  private readonly store: JsonFileStore<Record<string, StoredMemory>>;

  constructor(dir: string) {
    this.store = new JsonFileStore(join(dir, 'index.json'), () => ({}));
  }

  all(): Map<string, StoredMemory> {
    return new Map(Object.entries(this.store.read()));
  }

  put(memories: StoredMemory[]): void {
    if (memories.length === 0) return;
    this.store.update((s) => {
      for (const m of memories) s[m.blobId] = { blobId: m.blobId, namespace: m.namespace, text: m.text };
    });
  }
}

export interface Hwm {
  seq: number;
  hash: string;
  /**
   * S10: false when the head was first learned from the relayer on this machine
   * (trust on first use). Payments stay blocked until a human confirms it
   * (`antibody verify-ledger --accept`). Absent on homes written before this
   * field existed, which counts as confirmed.
   */
  acknowledged?: boolean;
}

export class HighWaterMark {
  private readonly store: JsonFileStore<Hwm | null>;

  constructor(path: string) {
    this.store = new JsonFileStore<Hwm | null>(path, () => null);
  }

  read(): Hwm | null {
    return this.store.read();
  }

  /** Only ever moves forward. Locked and written atomically (two processes may advance it). */
  advance(head: { seq: number; hash: string }, opts: { firstSyncAcknowledged?: boolean } = {}): void {
    const cur = this.read();
    if (cur && cur.seq >= head.seq) return;
    this.store.update((s) => {
      if (s && s.seq >= head.seq) return;
      const acknowledged = s ? s.acknowledged !== false : !!opts.firstSyncAcknowledged;
      return { ...head, acknowledged };
    }, true);
  }

  acknowledged(): boolean {
    const h = this.read();
    return !!h && h.acknowledged !== false;
  }

  /** The human confirmed this head (verify-ledger --accept, or the setup that wrote genesis itself). */
  acknowledge(head: { seq: number; hash: string }): void {
    this.store.update((s) => {
      if (s && s.seq > head.seq) throw new Error(`refusing to acknowledge #${head.seq}: this machine already verified #${s.seq}`);
      return { ...head, acknowledged: true };
    }, true);
  }

  clear(): void {
    this.store.clear();
  }
}

/** S10/B6: every signing attempt, so a payment is never sent twice and an unknown outcome is never retried blindly. */
export interface PaymentEntry {
  key: string;
  turn: string;
  recipient: string;
  coinType: string;
  amount: string;
  status: 'pending' | 'executed' | 'failed' | 'unknown';
  digest?: string;
  error?: string;
  at: number;
}

export class PaymentLog {
  private readonly store: JsonFileStore<PaymentEntry[]>;

  constructor(dir: string) {
    this.store = new JsonFileStore(join(dir, 'payments.json'), () => []);
  }

  list(): PaymentEntry[] {
    return this.store.read();
  }

  /** A payment of the same amount and coin to the same recipient that is pending, unknown, or went out within `windowMs`. */
  duplicate(e: Pick<PaymentEntry, 'key' | 'recipient' | 'coinType' | 'amount'>, now: number, windowMs: number): PaymentEntry | undefined {
    return this.list().find(
      (x) => x.key === e.key && x.status !== 'failed' || (x.recipient === e.recipient && x.coinType === e.coinType && x.amount === e.amount && (x.status === 'pending' || x.status === 'unknown' || (x.status === 'executed' && now - x.at < windowMs))),
    );
  }

  put(e: PaymentEntry): void {
    this.store.update((s) => {
      const i = s.findIndex((x) => x.key === e.key);
      if (i >= 0) s[i] = e;
      else s.push(e);
      // Bounded: keep the most recent 1000 entries.
      if (s.length > 1000) s.splice(0, s.length - 1000);
    });
  }
}

export interface Incident {
  id: string;
  at: string;
  objectId: string;
  observationId: string | null;
  coinType?: string;
  sender?: string;
  score: number;
  rules: string[];
  lessonMatches: { lessonSeq: number; indicator: string; value: string }[];
  blocklisted: boolean;
  proposedSeed: { type: 'source'; value: string };
  status: 'open' | 'quarantined' | 'auto-quarantined' | 'dismissed';
  quarantineSeq?: number;
  report?: { url: string; blobId: string; simulated: boolean };
}

export class IncidentStore {
  private readonly store: JsonFileStore<Incident[]>;

  constructor(dir: string) {
    this.store = new JsonFileStore(join(dir, 'incidents.json'), () => []);
  }

  list(): Incident[] {
    return this.store.read();
  }

  upsert(i: Incident): void {
    this.store.update((s) => {
      const k = s.findIndex((x) => x.id === i.id);
      if (k >= 0) s[k] = i;
      else s.push(i);
    });
  }

  get(id: string): Incident | undefined {
    return this.list().find((i) => i.id === id);
  }
}

/** Published incident reports, one entry per upload (FR-14). */
export interface ReportEntry {
  seq: number;
  url: string;
  blobId: string;
  jobId: string;
  status: string;
  filename: string;
  sizeBytes: number;
  simulated: boolean;
  at: number;
}

export class ReportLog {
  private readonly store: JsonFileStore<ReportEntry[]>;

  constructor(dir: string) {
    this.store = new JsonFileStore(join(dir, 'reports.json'), () => []);
  }

  list(): ReportEntry[] {
    return this.store.read();
  }

  add(e: ReportEntry): void {
    this.store.update((s) => {
      s.push(e);
    });
  }
}
