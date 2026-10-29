/**
 * Memory backend interface: one client per lane key, mirroring the Walrus
 * Memory calls Antibody uses (spec §11). Antibody never calls analyze(),
 * forget, delete or any destructive endpoint (I-7, enforced by test T-15).
 */
import type { StoredMemory } from '../core/types.ts';

export interface InventoryEntry {
  blobId: string;
  createdAt: string;
  /** Whatever the relayer reports as the writer (P-3 records what it is). */
  agentId: string | null;
}

export interface RestoreSummary {
  restored: number;
  skipped: number;
  failed: number;
  total: number;
  truncated: boolean;
}

export interface MemoryClient {
  readonly simulated: boolean;
  readonly publicKeyHex: string;
  /** rememberAndWait with idempotencyKey = envelope id; never dedupe. */
  remember(text: string, namespace: string, idempotencyKey: string): Promise<{ blobId: string }>;
  recall(query: string, namespace: string, limit: number): Promise<StoredMemory[]>;
  /** Full inventory for one namespace (metadata only). */
  inventory(namespace: string): Promise<InventoryEntry[]>;
  restore(namespace: string, limit: number): Promise<RestoreSummary>;
}

export const RECALL_MAX = 100;

export interface CoverageResult {
  memories: StoredMemory[];
  inventory: InventoryEntry[];
  missing: string[];
  queries: number;
}

/**
 * Retrieve text for every inventory blob with a recall query plan (spec §7
 * and §10): base queries first, then follow-up queries generated from what
 * was found, until coverage is complete or the plan is exhausted.
 */
export async function retrieveAll(
  client: MemoryClient,
  namespace: string,
  baseQueries: string[],
  followUps: (found: StoredMemory[], missing: string[]) => string[] = () => [],
  maxQueries = 200,
  /** Texts already known by blob id (a disposable cache; blobs are immutable). */
  known: ReadonlyMap<string, StoredMemory> = new Map(),
): Promise<CoverageResult> {
  const inventory = await client.inventory(namespace);
  const want = new Set(inventory.map((e) => e.blobId));
  const got = new Map<string, StoredMemory>();
  for (const b of want) {
    const k = known.get(b);
    if (k && k.namespace === namespace) got.set(b, k);
  }
  if (got.size === want.size) return { memories: [...got.values()], inventory, missing: [], queries: 0 };
  const tried = new Set<string>();
  let queue = [...baseQueries];
  let queries = 0;
  const missing = () => [...want].filter((b) => !got.has(b));
  while (queries < maxQueries) {
    if (queue.length === 0) {
      if (missing().length === 0) break;
      queue = followUps([...got.values()], missing()).filter((q) => !tried.has(q));
      if (queue.length === 0) break;
    }
    const q = queue.shift()!;
    if (tried.has(q)) continue;
    tried.add(q);
    queries++;
    for (const m of await client.recall(q, namespace, RECALL_MAX)) {
      if (m.namespace === namespace && !got.has(m.blobId)) got.set(m.blobId, m);
    }
    if (missing().length === 0 && queue.length === 0) break;
  }
  return { memories: [...got.values()], inventory, missing: missing(), queries };
}
