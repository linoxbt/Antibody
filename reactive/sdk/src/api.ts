import type { Address, Hex } from 'viem';
import { DEFAULT_API, type MemoryStatus, type OriginChain } from './constants.ts';

export interface Check { address: Address; knownAttacker: boolean; verdict: 'block' | 'unknown'; advice: string }
export interface AttackerSummary { index: number; address: Address; caughtBy: { rule: string; chain: OriginChain; originTx: Hex | null } | null; decisions: number }
export interface AttackerDetail extends Omit<AttackerSummary, 'index' | 'decisions'> {
  knownAttacker: boolean;
  blockedOn: { chain: OriginChain; address: Address; type: 'vault' | 'memory'; kind: string; quarantined: boolean | null }[];
  decisions: Loop[];
}
export interface Loop {
  rule: string; subject: Address | null; destChain: OriginChain; vault?: Address | null;
  origin: { chain: string | null; tx: Hex | null; ts?: number | null };
  reactive: { tx: Hex; ts?: number }; callback: { tx: Hex | null; ts?: number | null };
  seconds: number | null; source: 'live' | 'recorded';
}
export interface Recall { chain: OriginChain; memory: Address; id: number; contentHash: Hex; source: Address; kind: string; writtenAt: string; status: MemoryStatus; usable: boolean }
export interface SourceAudit { chain: OriginChain; memory: Address; source: Address; quarantined: boolean; entries: number[] }
export interface Status {
  updatedAt: string | null; catchingUp: boolean;
  guardReactive: { address: Address; chain: 'lasna'; chainId: number; registrar: Address; reserves: string; debt: string; balance: string; riskThreshold: number; maxTargets: number } | null;
  counts: { lessons: number; vaults: number; memories: number };
}
export interface ScoreResult { verdict: { suspicious: boolean; score: number; reason: string; addresses: Address[] }; reported: { address: Address; score: number; tx: Hex }[]; skipped: unknown[]; reportingPaused: boolean }

/** An error from the Antibody Guard API, with its HTTP status. */
export class GuardApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'GuardApiError';
  }
}

export interface GuardApiOptions {
  /** Base URL of the site or the Guard service. Default: the public deployment. */
  baseUrl?: string;
  /** A fetch implementation (default: globalThis.fetch). */
  fetch?: typeof fetch;
  /** Per-request timeout in ms (default 20 s; scoring can take longer). */
  timeoutMs?: number;
  /** How your calls are labelled in the public activity feed (default "SDK"). Never your IP or message text. */
  client?: string;
  /** @internal how the call arrives: 'sdk' (default) or 'mcp-local' (the npm MCP server). */
  via?: 'sdk' | 'mcp-local';
}

/** A typed client for the public API (`/api/v1`). Reads need no key. */
export class GuardApi {
  readonly baseUrl: string;
  private f: typeof fetch;
  private timeoutMs: number;
  private tags: Record<string, string>;

  constructor(o: GuardApiOptions = {}) {
    this.baseUrl = (o.baseUrl ?? DEFAULT_API).replace(/\/+$/, '');
    this.f = o.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = o.timeoutMs ?? 20_000;
    this.tags = { 'x-guard-client': (o.client ?? 'SDK').slice(0, 40), 'x-guard-via': o.via ?? 'sdk' };
  }

  private async req<T>(path: string, init?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<T> {
    const res = await this.f(`${this.baseUrl}/api/v1${path}`, {
      method: init?.method ?? 'GET',
      headers: { ...this.tags, ...(init?.body ? { 'content-type': 'application/json' } : {}) },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init?.timeoutMs ?? this.timeoutMs),
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { throw new GuardApiError(res.status, `not JSON: ${text.slice(0, 120)}`); }
    if (!res.ok) throw new GuardApiError(res.status, json?.error ?? res.statusText);
    return json as T;
  }

  /** GuardReactive, its reserves, and how many lessons, vaults and memories. */
  status() { return this.req<Status>('/status'); }
  /** Is this address a known attacker? Ask before paying it or acting on what it sent. */
  check(address: Address | string) { return this.req<Check>(`/check/${address}`); }
  /** Every lesson in GuardReactive. */
  attackers() { return this.req<AttackerSummary[]>('/attackers'); }
  /** Where an attacker is blocked (read from every watched contract) and every decision about it. */
  attacker(address: Address | string) { return this.req<AttackerDetail>(`/attackers/${address}`); }
  vaults() { return this.req<any[]>('/vaults'); }
  vault(chain: OriginChain, address: Address | string) { return this.req<any>(`/vaults/${chain}/${address}`); }
  memories() { return this.req<any[]>('/memories'); }
  /** A memory entry and whether the agent may act on it. */
  recall(chain: OriginChain, memory: Address | string, id: number | bigint) { return this.req<Recall>(`/memories/${chain}/${memory}/entries/${id}`); }
  /** Everything a source wrote into a memory, and whether it is quarantined there. */
  source(chain: OriginChain, memory: Address | string, source: Address | string) { return this.req<SourceAudit>(`/memories/${chain}/${memory}/sources/${source}`); }
  loops(limit = 50) { return this.req<Loop[]>(`/loops?limit=${limit}`); }
  events(limit = 50) { return this.req<any[]>(`/events?limit=${limit}`); }
  /** The AI risk scorer. An address it flags at 80 or more is reported on-chain and quarantined everywhere. */
  score(message: { body: string; from?: string; subject?: string }) { return this.req<ScoreResult>('/score', { method: 'POST', body: message, timeoutMs: 120_000 }); }
  /** Ask GuardReactive to watch your GuardVault or GuardMemory (set its guardian to GUARD_REACTIVE first). */
  watch(chain: OriginChain, address: Address | string) { return this.req<{ ok: boolean; tx: Hex }>('/watch', { method: 'POST', body: { chain, address }, timeoutMs: 120_000 }); }
}
