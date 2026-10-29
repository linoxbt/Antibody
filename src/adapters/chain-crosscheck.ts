/**
 * FR-19: the delegate set, read twice. Lane bindings — which key may write
 * trusted memories, which may sign the ledger — come from the MemWalAccount's
 * delegate_keys. If the chain gateway lied about that set, a forged key could
 * pass as a lane. With ANTIBODY_CROSSCHECK_RPC_URL set, every account read
 * goes to both providers (e.g. Tatum and a Mysten fullnode) and must agree on
 * owner, active flag and every (public key, label) pair. A disagreement that
 * survives one retry throws, and the caller fails closed: snapshots fail, so
 * payments get a recorded BLOCK and IPC lane lookups refuse.
 *
 * Everything else (balances, objects, simulation, execution) uses the primary.
 */
import type { AccountState } from '../core/lanes.ts';
import type { ChainReader } from './chain.ts';

export class ChainDisagreement extends Error {}

export interface CrossCheckStatus {
  secondary: string;
  agreed: boolean | null;
  at: number | null;
  detail: string | null;
}

/** Owner, active flag and the sorted (key, label) pairs: what lane binding depends on. */
export function delegateFingerprint(a: AccountState): string {
  const keys = a.delegateKeys.map((k) => `${k.publicKeyHex.toLowerCase()}:${k.label}`).sort();
  return JSON.stringify({ owner: a.owner.toLowerCase(), active: a.active, keys });
}

function describe(a: AccountState, b: AccountState): string {
  if (a.owner.toLowerCase() !== b.owner.toLowerCase()) return `owner ${a.owner} vs ${b.owner}`;
  if (a.active !== b.active) return `active ${a.active} vs ${b.active}`;
  const ka = new Set(a.delegateKeys.map((k) => `${k.label}=${k.publicKeyHex.slice(0, 12)}`));
  const kb = new Set(b.delegateKeys.map((k) => `${k.label}=${k.publicKeyHex.slice(0, 12)}`));
  const only = (x: Set<string>, y: Set<string>) => [...x].filter((v) => !y.has(v));
  return `only on primary: [${only(ka, kb).join(', ')}]; only on secondary: [${only(kb, ka).join(', ')}]`;
}

export class CrossCheckedChain implements ChainReader {
  readonly kind: ChainReader['kind'];
  readonly simulated: boolean;
  readonly primary: ChainReader;
  readonly secondary: ChainReader;
  private readonly label: string;
  private readonly retryMs: number;
  private last: CrossCheckStatus;

  constructor(primary: ChainReader, secondary: ChainReader, opts: { label: string; retryMs?: number }) {
    this.primary = primary;
    this.secondary = secondary;
    this.kind = primary.kind;
    this.simulated = primary.simulated;
    this.label = opts.label;
    this.retryMs = opts.retryMs ?? 1500;
    this.last = { secondary: opts.label, agreed: null, at: null, detail: null };
  }

  status(): CrossCheckStatus {
    return { ...this.last };
  }

  async getAccount(accountId: string): Promise<AccountState> {
    for (let attempt = 0; ; attempt++) {
      const [a, b] = await Promise.all([this.primary.getAccount(accountId), this.secondary.getAccount(accountId)]);
      if (delegateFingerprint(a) === delegateFingerprint(b)) {
        this.last = { secondary: this.label, agreed: true, at: Date.now(), detail: null };
        return a;
      }
      // The two providers can straddle a checkpoint that just changed the set: look once more.
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, this.retryMs));
        continue;
      }
      const detail = describe(a, b);
      this.last = { secondary: this.label, agreed: false, at: Date.now(), detail };
      throw new ChainDisagreement(`chain readers disagree on the delegate set of ${accountId} (${detail}); failing closed`);
    }
  }

  latestCheckpoint() {
    return this.primary.latestCheckpoint();
  }
  listBalances(owner: string) {
    return this.primary.listBalances(owner);
  }
  listOwnedObjects(owner: string) {
    return this.primary.listOwnedObjects(owner);
  }
  getCoinMetadata(coinType: string) {
    return this.primary.getCoinMetadata(coinType);
  }
  getTransaction(digest: string) {
    return this.primary.getTransaction(digest);
  }
  buildTransfer(req: Parameters<ChainReader['buildTransfer']>[0]) {
    return this.primary.buildTransfer(req);
  }
  simulate(txBytes: Uint8Array) {
    return this.primary.simulate(txBytes);
  }
  execute(txBytes: Uint8Array, signature: string) {
    return this.primary.execute(txBytes, signature);
  }
  get watchCheckpoints() {
    return this.primary.watchCheckpoints?.bind(this.primary);
  }
}

/** The reader that actually talks to the chain, under any cross-check wrapper. */
export function primaryOf(chain: ChainReader): ChainReader {
  return chain instanceof CrossCheckedChain ? chain.primary : chain;
}
