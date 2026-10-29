/**
 * Offline backend: a file-backed stand-in for the Walrus Memory relayer, so
 * the whole system runs deterministically in tests and CI. Everything that
 * uses it prints SIMULATED. Like the real relayer it authenticates writers
 * against the account's on-chain delegate set (here: the fixture chain), so a
 * removed delegate key is rejected (mirrors probe P-5). Recall is
 * token-overlap ranked instead of embedding-ranked.
 */
import { join } from 'node:path';
import { sha256Hex } from '../core/encoding.ts';
import type { StoredMemory } from '../core/types.ts';
import { JsonFileStore } from './filestore.ts';
import type { InventoryEntry, MemoryClient, RestoreSummary } from './memory.ts';

interface Row {
  blobId: string;
  namespace: string;
  text: string;
  createdAt: string;
  agentId: string;
  idempotencyKey: string;
}

interface RelayerState {
  rows: Row[];
  writes: number;
}

export class RelayerAuthError extends Error {
  readonly status = 401;
}

export class OfflineRelayer {
  private readonly store: JsonFileStore<RelayerState>;

  constructor(
    dir: string,
    /** Is this public key a current delegate of the account? */
    private readonly isDelegate: (pubHex: string) => boolean,
    private readonly now: () => number = Date.now,
  ) {
    this.store = new JsonFileStore(join(dir, 'relayer.json'), () => ({ rows: [], writes: 0 }));
  }

  client(publicKeyHex: string): MemoryClient {
    return new OfflineMemoryClient(this, publicKeyHex);
  }

  authorize(pub: string): void {
    if (!this.isDelegate(pub)) throw new RelayerAuthError(`401: ${pub.slice(0, 12)}… is not a delegate key of this account`);
  }

  write(pub: string, text: string, namespace: string, idempotencyKey: string): { blobId: string } {
    this.authorize(pub);
    return this.store.update((s) => {
      const prior = s.rows.find((r) => r.namespace === namespace && r.idempotencyKey === idempotencyKey);
      if (prior) {
        if (prior.text !== text) throw new Error('409 Conflict: idempotency key reused with different text');
        return { blobId: prior.blobId };
      }
      s.writes++;
      const blobId = toBlobId(sha256Hex(`${namespace}\n${idempotencyKey}\n${text}`));
      s.rows.push({ blobId, namespace, text, createdAt: new Date(this.now()).toISOString(), agentId: pub, idempotencyKey });
      return { blobId };
    });
  }

  search(pub: string, query: string, namespace: string, limit: number): StoredMemory[] {
    this.authorize(pub);
    const q = tokens(query);
    if (q.size === 0) return [];
    return this.store
      .read()
      .rows.filter((r) => r.namespace === namespace)
      .map((r) => {
        const t = tokens(r.text);
        let hit = 0;
        for (const w of q) if (t.has(w)) hit++;
        return { r, distance: 1 - hit / q.size };
      })
      .filter((x) => x.distance < 1)
      .sort((a, b) => a.distance - b.distance || a.r.createdAt.localeCompare(b.r.createdAt) || a.r.blobId.localeCompare(b.r.blobId))
      .slice(0, Math.min(limit, 100))
      .map(({ r }) => ({ blobId: r.blobId, namespace: r.namespace, text: r.text, createdAt: r.createdAt }));
  }

  list(pub: string, namespace: string): InventoryEntry[] {
    this.authorize(pub);
    return this.store
      .read()
      .rows.filter((r) => r.namespace === namespace)
      .map((r) => ({ blobId: r.blobId, createdAt: r.createdAt, agentId: r.agentId }));
  }

  writeCount(): number {
    return this.store.read().writes;
  }

  /** Test hook: tamper with stored text the way a lying relayer could. */
  tamper(blobId: string, fn: (text: string) => string): void {
    this.store.update((s) => {
      const r = s.rows.find((x) => x.blobId === blobId);
      if (!r) throw new Error(`no blob ${blobId}`);
      r.text = fn(r.text);
    });
  }
}

class OfflineMemoryClient implements MemoryClient {
  readonly simulated = true;

  constructor(
    private readonly relayer: OfflineRelayer,
    readonly publicKeyHex: string,
  ) {}

  async remember(text: string, namespace: string, idempotencyKey: string) {
    return this.relayer.write(this.publicKeyHex, text, namespace, idempotencyKey);
  }

  async recall(query: string, namespace: string, limit: number) {
    return this.relayer.search(this.publicKeyHex, query, namespace, limit);
  }

  async inventory(namespace: string) {
    return this.relayer.list(this.publicKeyHex, namespace);
  }

  async restore(namespace: string): Promise<RestoreSummary> {
    const total = this.relayer.list(this.publicKeyHex, namespace).length;
    return { restored: 0, skipped: total, failed: 0, total, truncated: false };
  }
}

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z0-9_.:-]{2,}/g) ?? []);
}

/** Walrus-style 43-char base64url blob ids. */
function toBlobId(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64url');
}
