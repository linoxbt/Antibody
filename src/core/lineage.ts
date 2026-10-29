/**
 * Lineage engine (spec §6): trust classes, quarantine closure and blast radius.
 *
 * Taint follows information flow. A memory's class is the lowest of its lane's
 * ceiling and its parents' classes (I-3), and it is quarantined when a seed
 * matches it or any ancestor (I-8). Both are recomputed from scratch at every
 * projection, so descendants written after a quarantine are excluded too.
 */
import { seedMatches } from './seeds.ts';
import { lowerOf, type Envelope, type EnvelopeHeader, type Lane, type QuarantineSeed, type TrustClass } from './types.ts';

/** Highest class a lane can produce on its own. */
const LANE_CEILING: Readonly<Record<Lane, TrustClass>> = {
  user: 'trusted',
  agent: 'derived',
  'wallet-objects': 'untrusted',
  // Decisions report on a proposal; they are never trusted (spec §6 table).
  antibody: 'derived',
};

export interface VerifiedInput {
  env: Envelope;
  blobId: string;
}

export interface UnverifiedInput {
  blobId: string;
  code: string;
  reason: string;
  header?: EnvelopeHeader;
}

export interface ActiveSeed {
  seed: QuarantineSeed;
  /** Ledger seq of the quarantine record that issued it. */
  seq: number;
}

export interface LineageNode {
  id: string;
  blobIds: string[];
  env: Envelope;
  cls: TrustClass;
  /** Ledger seqs of every seed reaching this node (directly or through ancestors). */
  seedHits: number[];
  quarantined: boolean;
  /** A parent (or ancestor) was not retrieved: excluded from context until resolved. */
  unresolved: boolean;
  /** Why the class is what it is, for the forensic view. */
  notes: string[];
}

export interface LineageResult {
  nodes: Map<string, LineageNode>;
  /** Parents before children. */
  order: string[];
  /** Records that failed verification (plus verified records demoted to forensic-only). */
  forensic: { blobId: string; code: string; reason: string; header?: EnvelopeHeader; seedHits: number[] }[];
}

interface ParentInfo {
  cls: TrustClass;
  seedHits: Set<number>;
  unresolved: boolean;
  ckpt?: number;
}

export function computeLineage(verified: VerifiedInput[], unverified: UnverifiedInput[], seeds: ActiveSeed[]): LineageResult {
  const forensic: LineageResult['forensic'] = [];
  const directHits = (h: EnvelopeHeader) => new Set(seeds.filter((s) => seedMatches(s.seed, h)).map((s) => s.seq));

  // Group by envelope id. Byte-identical copies are one memory stored twice;
  // differing texts claiming one id are a conflict and none of them is trusted.
  const groups = new Map<string, VerifiedInput[]>();
  for (const v of verified) groups.set(v.env.header.id, [...(groups.get(v.env.header.id) ?? []), v]);

  const nodeEnv = new Map<string, { env: Envelope; blobIds: string[] }>();
  const unverifiedIds = new Map<string, ParentInfo>();
  for (const [id, copies] of groups) {
    const texts = new Set(copies.map((c) => c.env.text));
    if (texts.size === 1) {
      nodeEnv.set(id, { env: copies[0]!.env, blobIds: copies.map((c) => c.blobId).sort() });
    } else {
      for (const c of copies) {
        const hits = directHits(c.env.header);
        forensic.push({ blobId: c.blobId, code: 'DUPLICATE_ID', reason: `${texts.size} different envelopes claim id ${id}`, header: c.env.header, seedHits: [...hits] });
      }
      unverifiedIds.set(id, { cls: 'unverified', seedHits: new Set(copies.flatMap((c) => [...directHits(c.env.header)])), unresolved: false });
    }
  }
  for (const u of unverified) {
    const hits = u.header ? directHits(u.header) : new Set<number>();
    forensic.push({ blobId: u.blobId, code: u.code, reason: u.reason, ...(u.header ? { header: u.header } : {}), seedHits: [...hits] });
    if (u.header && !nodeEnv.has(u.header.id)) {
      const prev = unverifiedIds.get(u.header.id);
      unverifiedIds.set(u.header.id, { cls: 'unverified', seedHits: new Set([...(prev?.seedHits ?? []), ...hits]), unresolved: false });
    }
  }

  // Kahn's algorithm over verified nodes; edges run parent → child.
  const children = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const [id, { env }] of nodeEnv) {
    let d = 0;
    for (const p of env.header.parents) {
      if (nodeEnv.has(p)) {
        d++;
        children.set(p, [...(children.get(p) ?? []), id]);
      }
    }
    indegree.set(id, d);
  }

  const nodes = new Map<string, LineageNode>();
  const order: string[] = [];
  const ready = [...indegree].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const forcedUnverified = new Map<string, string>();

  const finish = (id: string, skipParents: ReadonlySet<string> = new Set()) => {
    const { env, blobIds } = nodeEnv.get(id)!;
    const h = env.header;
    const notes: string[] = [];
    const hits = directHits(h);
    if (hits.size > 0) notes.push(`matches quarantine seed(s) #${[...hits].join(', #')}`);
    let unresolved = false;
    let parentsLowest: TrustClass = 'trusted';
    let cls: TrustClass;
    for (const pid of h.parents) {
      if (skipParents.has(pid)) continue;
      const p = parentInfo(pid);
      if (!p) {
        unresolved = true;
        parentsLowest = lowerOf(parentsLowest, 'untrusted');
        notes.push(`parent ${pid} not found (dangling)`);
        continue;
      }
      for (const s of p.seedHits) hits.add(s);
      if (p.unresolved) unresolved = true;
      if (p.ckpt !== undefined && p.ckpt > h.ckpt) forcedUnverified.set(id, `parent ${pid} has a later checkpoint`);
      // A validly signed child of an unverified parent is untrusted, not unverified.
      parentsLowest = lowerOf(parentsLowest, p.cls === 'unverified' ? 'untrusted' : p.cls);
    }
    const forced = forcedUnverified.get(id);
    if (forced) {
      cls = 'unverified';
      notes.push(forced);
    } else {
      cls = lowerOf(LANE_CEILING[h.lane], parentsLowest);
      if (h.lane === 'wallet-objects') notes.push('external data (wallet-objects lane)');
      else if (cls !== LANE_CEILING[h.lane]) notes.push(`tainted by a ${parentsLowest} parent`);
    }
    nodes.set(id, { id, blobIds, env, cls, seedHits: [...hits].sort((a, b) => a - b), quarantined: hits.size > 0, unresolved, notes });
    order.push(id);
  };

  const parentInfo = (pid: string): ParentInfo | undefined => {
    const n = nodes.get(pid);
    if (n) return { cls: n.cls, seedHits: new Set(n.seedHits), unresolved: n.unresolved, ckpt: n.env.header.ckpt };
    return unverifiedIds.get(pid);
  };

  const drain = () => {
    while (ready.length > 0) {
      const id = ready.shift()!;
      finish(id);
      for (const c of (children.get(id) ?? []).sort()) {
        const d = indegree.get(c)! - 1;
        indegree.set(c, d);
        if (d === 0) ready.push(c);
      }
    }
  };
  drain();

  // Anything left sits on or behind a cycle. Cycle members are unverified;
  // their descendants are then processed normally (and inherit the taint).
  while (nodes.size < nodeEnv.size) {
    const remaining = [...nodeEnv.keys()].filter((id) => !nodes.has(id));
    const inCycle = cycleMembers(remaining, (id) => nodeEnv.get(id)!.env.header.parents.filter((p) => nodeEnv.has(p) && !nodes.has(p)));
    const cycleSet = new Set(inCycle);
    // Cycle members are unverified; they are finished against their final
    // parents only, then their children continue through Kahn's algorithm.
    for (const id of inCycle) {
      forcedUnverified.set(id, 'part of a parent cycle');
      finish(id, cycleSet);
    }
    for (const id of inCycle) {
      for (const c of children.get(id) ?? []) {
        if (nodes.has(c) || cycleSet.has(c)) continue;
        const d = indegree.get(c)! - 1;
        indegree.set(c, d);
        if (d === 0) ready.push(c);
      }
    }
    if (inCycle.length === 0) break; // defensive: should be unreachable
    drain();
  }

  return { nodes, order, forensic };
}

/** Members of non-trivial strongly connected components (Tarjan), plus self-loops. */
function cycleMembers(ids: string[], edgesOf: (id: string) => string[]): string[] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const out: string[] = [];
  const idSet = new Set(ids);
  const strong = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    on.add(v);
    for (const w of edgesOf(v)) {
      if (!idSet.has(w)) continue;
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1 || edgesOf(v).includes(v)) out.push(...comp);
    }
  };
  for (const v of [...ids].sort()) if (!idx.has(v)) strong(v);
  return out.sort();
}

export interface BlastRadius {
  seedSeq: number;
  /** Source identifiers (e.g. the coin object) the seed names, when it is a source seed. */
  sources: string[];
  memories: LineageNode[];
  decisions: LineageNode[];
  txDigests: string[];
  edges: { from: string; to: string }[];
}

/**
 * Blast radius of one seed: every memory it quarantines, the decisions among
 * them, and the transaction digests those decisions reference (spec §6).
 */
export function blastRadius(lineage: LineageResult, seedSeq: number, seed: QuarantineSeed): BlastRadius {
  const hit = lineage.order.map((id) => lineage.nodes.get(id)!).filter((n) => n.seedHits.includes(seedSeq));
  const ids = new Set(hit.map((n) => n.id));
  const edges: BlastRadius['edges'] = [];
  const sources = new Set<string>();
  for (const n of hit) {
    if (seed.type === 'source' && seedMatches(seed, n.env.header)) {
      sources.add(seed.value);
      edges.push({ from: `src:${seed.value}`, to: n.id });
    }
    for (const p of n.env.header.parents) if (ids.has(p)) edges.push({ from: p, to: n.id });
  }
  const decisions = hit.filter((n) => n.env.header.kind === 'decision');
  const txDigests = decisions.flatMap((d) => d.env.header.src.filter((r) => r.t === 'tx' && r.digest).map((r) => r.digest!));
  return { seedSeq, sources: [...sources], memories: hit, decisions, txDigests: [...new Set(txDigests)], edges };
}
