/** Walrus Memory on mainnet through @mysten-incubation/memwal (spec §11). */
import { MemWal } from '@mysten-incubation/memwal';
import type { StoredMemory } from '../core/types.ts';
import type { InventoryEntry, MemoryClient, RestoreSummary } from './memory.ts';

export interface LiveMemoryOptions {
  seedHex: string;
  publicKeyHex: string;
  accountId: string;
  serverUrl: string;
}

export class LiveMemoryClient implements MemoryClient {
  readonly simulated = false;
  readonly publicKeyHex: string;
  private readonly mw: MemWal;

  constructor(opts: LiveMemoryOptions) {
    this.publicKeyHex = opts.publicKeyHex;
    this.mw = MemWal.create({ key: opts.seedHex, accountId: opts.accountId, serverUrl: opts.serverUrl });
  }

  async remember(text: string, namespace: string, idempotencyKey: string): Promise<{ blobId: string }> {
    // Never analyze() (it rewrites text into facts) and never dedupe: identical
    // bodies from different lanes must stay distinct records (spec §5).
    const r = await this.mw.rememberAndWait(text, namespace, { idempotencyKey });
    return { blobId: r.blob_id };
  }

  async recall(query: string, namespace: string, limit: number): Promise<StoredMemory[]> {
    const r = await this.mw.recall({ query, namespace, limit: Math.min(limit, 100) });
    return r.results.map((m) => ({ blobId: m.blob_id, namespace, text: m.text, ...(m.created_at ? { createdAt: m.created_at } : {}) }));
  }

  async inventory(namespace: string): Promise<InventoryEntry[]> {
    const out: InventoryEntry[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.mw.listMemories({ namespace, limit: 500, ...(cursor ? { cursor } : {}) });
      for (const m of page.memories) out.push({ blobId: m.blob_id, createdAt: m.created_at, agentId: m.agent_id });
      if (!page.has_more) break;
      cursor = page.next_cursor ?? undefined;
      if (!cursor) break;
    }
    return out;
  }

  async restore(namespace: string, limit: number): Promise<RestoreSummary> {
    const r = await this.mw.restore(namespace, limit);
    return { restored: r.restored, skipped: r.skipped, failed: r.failed, total: r.total, truncated: r.truncated };
  }

  async health() {
    return { health: await this.mw.health(), compatibility: await this.mw.compatibility() };
  }

  destroy(): void {
    this.mw.destroy();
  }
}
