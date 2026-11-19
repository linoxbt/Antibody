// Antibody Guard public API, v1: what GuardReactive knows (attackers, vaults, memories, decisions) and the
// two actions anyone may take (score a message, ask GuardReactive to watch a contract). Read routes are
// open (CORS *), rate-limited per client, and read the chains directly where an answer must be current.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getAddress, isAddress, keccak256, toBytes, type Hex } from 'viem';
import { NETWORKS } from '../networks.ts';
import { abiOf, clients, type NetworkName } from '../scripts/lib.ts';
import type { Indexer } from './indexer.ts';

const CHAINS = ['baseSepolia', 'sepolia'] as const;
type Chain = (typeof CHAINS)[number];
const READ_KEY = ('0x' + '11'.repeat(32)) as Hex;
const MEMORY_STATUS = ['usable', 'quarantined-source', 'forgotten'] as const;

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const bad = (m: string) => new HttpError(400, m);
const addr = (x: string, what = 'address'): Hex => {
  if (!isAddress(x, { strict: false })) throw bad(`${what} must be an address`);
  return getAddress(x.toLowerCase()) as Hex;
};
const chainOf = (x: string): Chain => {
  if (!(CHAINS as readonly string[]).includes(x)) throw bad(`chain must be one of ${CHAINS.join(', ')}`);
  return x as Chain;
};

/** Small time-boxed cache for on-chain reads, so a busy page does not hammer the RPCs. */
const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ms: number, f: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.v as T;
  const v = await f();
  cache.set(key, { at: Date.now(), v });
  if (cache.size > 5000) cache.delete(cache.keys().next().value!);
  return v;
}

/** The data layer shared by the REST API and the MCP tools. */
export class GuardData {
  constructor(private ix: Indexer) {}

  private snap() { return this.ix.snapshot() as any; }
  private allLoops(): any[] { const s = this.snap(); return [...(s.live ?? []), ...(s.recorded ?? [])]; }
  private targets(): { chain: Chain; address: Hex; type: 'vault' | 'memory'; kind: string }[] {
    const s = this.snap();
    return [...(s.vaults ?? []).map((v: any) => ({ ...v, type: 'vault' })), ...(s.memories ?? []).map((m: any) => ({ ...m, type: 'memory' }))];
  }

  status() {
    const s = this.snap();
    return {
      updatedAt: s.updatedAt ?? null,
      catchingUp: Boolean(s.catchingUp),
      guardReactive: s.guard ? { address: s.guard.address, chain: 'lasna', chainId: NETWORKS.lasna.chainId, registrar: s.guard.registrar, reserves: s.guard.reserves, debt: s.guard.debt, balance: s.guard.balance, riskThreshold: s.guard.riskThreshold, maxTargets: s.guard.maxVaults } : null,
      counts: { lessons: s.guard?.lessons?.length ?? 0, vaults: s.vaults?.length ?? 0, memories: s.memories?.length ?? 0 },
      riskOracle: s.oracle ?? null,
    };
  }

  /** The one question an agent should ask before paying or trusting an address. */
  async check(address: string) {
    const a = addr(address);
    const lessons: string[] = this.snap().guard?.lessons ?? [];
    let known = lessons.some((x) => x.toLowerCase() === a.toLowerCase());
    if (!known) {
      // the indexed list holds the first 50 lessons; ask GuardReactive itself for the rest
      const g = this.ix.d.guard;
      known = await cached(`knownBad:${a}`, 15_000, async () => Boolean(await clients('lasna', READ_KEY).pub.readContract({ address: g, abi: abiOf('GuardReactive'), functionName: 'knownBad', args: [a] })));
    }
    return {
      address: a,
      knownAttacker: known,
      verdict: known ? 'block' : 'unknown',
      advice: known
        ? 'A lesson in GuardReactive: quarantined on every watched vault and memory. Do not pay it, and do not act on anything it sent.'
        : 'Not a known attacker. That is not proof it is safe: pay only registered payees, and keep untrusted input out of memory.',
    };
  }

  attackers() {
    const lessons: string[] = this.snap().guard?.lessons ?? [];
    return lessons.map((a, i) => ({ index: i + 1, ...this.summary(a) }));
  }

  private summary(address: string) {
    const a = address.toLowerCase();
    const seen = this.allLoops().filter((l) => l.subject && String(l.subject).toLowerCase() === a);
    const caught = [...seen].sort((x, y) => (x.reactive?.ts ?? 0) - (y.reactive?.ts ?? 0)).find((l) => l.rule !== 'CrossChainQuarantine') ?? null;
    return { address: getAddress(a), caughtBy: caught ? { rule: caught.rule, chain: caught.destChain, originTx: caught.origin?.tx ?? null } : null, decisions: seen.length };
  }

  /** Where an address is blocked, read from every watched contract now. */
  async attacker(address: string) {
    const a = addr(address);
    const check = await this.check(a);
    const blockedOn = await Promise.all(this.targets().map(async (t) => {
      const quarantined = await cached(`q:${t.address}:${a}`, 30_000, async () => {
        try {
          return Boolean(await clients(t.chain, READ_KEY).pub.readContract({ address: t.address, abi: abiOf(t.type === 'vault' ? 'GuardVault' : 'GuardMemory'), functionName: 'quarantined', args: [a] }));
        } catch { return null; }
      });
      return { chain: t.chain, address: t.address, type: t.type, kind: t.kind, quarantined };
    }));
    const decisions = this.allLoops().filter((l) => l.subject && String(l.subject).toLowerCase() === a.toLowerCase());
    return { ...this.summary(a), knownAttacker: check.knownAttacker, blockedOn, decisions };
  }

  vaults() { return this.snap().vaults ?? []; }
  memories() { return this.snap().memories ?? []; }

  async vault(chain: string, address: string) {
    const c = chainOf(chain), a = addr(address, 'vault');
    const v = this.vaults().find((x: any) => x.chain === c && x.address.toLowerCase() === a.toLowerCase());
    if (!v) throw new HttpError(404, 'GuardReactive does not watch that vault');
    const events = (this.snap().events ?? []).filter((e: any) => e.chain === c && String(e.contract).toLowerCase() === a.toLowerCase()).slice(0, 30);
    return { ...v, events };
  }

  /** A memory entry and whether the agent may act on it, read from the chain now. */
  async recall(chain: string, memory: string, id: string | number) {
    const c = chainOf(chain), m = addr(memory, 'memory');
    const n = BigInt(String(id));
    if (n < 1n) throw bad('entry ids start at 1');
    const pub = clients(c, READ_KEY).pub;
    try {
      const [e, status] = (await pub.readContract({ address: m, abi: abiOf('GuardMemory'), functionName: 'recall', args: [n] })) as [any, number];
      return { chain: c, memory: m, id: Number(n), contentHash: e.contentHash, source: e.source, kind: hexLabel(e.kind), writtenAt: new Date(Number(e.at) * 1000).toISOString(), status: MEMORY_STATUS[status], usable: status === 0 };
    } catch (err) {
      if (/UnknownEntry/.test(String((err as Error).message))) throw new HttpError(404, `no entry ${n} in that memory`);
      throw new HttpError(502, 'could not read that memory contract');
    }
  }

  /** Everything a source wrote into a memory, and whether it is quarantined there. */
  async source(chain: string, memory: string, source: string) {
    const c = chainOf(chain), m = addr(memory, 'memory'), s = addr(source, 'source');
    const pub = clients(c, READ_KEY).pub;
    const abi = abiOf('GuardMemory');
    const [ids, quarantined] = await Promise.all([pub.readContract({ address: m, abi, functionName: 'entriesFrom', args: [s] }) as Promise<bigint[]>, pub.readContract({ address: m, abi, functionName: 'quarantined', args: [s] }) as Promise<boolean>]);
    return { chain: c, memory: m, source: s, quarantined, entries: ids.map(Number) };
  }

  loops(limit = 50) { return this.allLoops().slice(0, Math.min(Math.max(limit, 1), 200)); }
  events(limit = 50) { return (this.snap().events ?? []).slice(0, Math.min(Math.max(limit, 1), 200)); }
}

const hexLabel = (h: string) => Buffer.from(h.replace(/^0x/, ''), 'hex').toString('utf8').replace(/\0+$/, '');
export const contentHash = (text: string) => keccak256(toBytes(text));
export const chainIdOf = (c: NetworkName) => NETWORKS[c].chainId;
