/**
 * Lane binding (spec §4 "Key binding at startup", invariant I-1).
 *
 * A public key's lane is the on-chain label the owner wallet attached to it
 * with addDelegateKey. Keys that have since been removed still bind to their
 * lane through ledger history (genesis, lane.rotate, lane.revoke), so old
 * memories keep verifying; a revoked key only verifies up to its revocation
 * checkpoint.
 */
import { isHex } from './encoding.ts';
import { LABEL_LANE, LANE_LABEL, LANES, type Lane } from './types.ts';

export interface DelegateKeyInfo {
  publicKeyHex: string;
  label: string;
  suiAddress: string;
  createdAtMs: number;
}

export interface AccountState {
  accountId: string;
  owner: string;
  active: boolean;
  adminQuarantined: boolean;
  delegateKeys: DelegateKeyInfo[];
}

/** Key history the ledger contributes (see ledger.ts). */
export interface LaneHistory {
  /** Every lane key the ledger has ever named (genesis + lane.rotate). */
  known: { pub: string; lane: Lane }[];
  /** lane.revoke records: the key may sign nothing after `ckpt`. */
  revoked: { pub: string; lane: Lane; ckpt: number }[];
}

export type BindingStatus = 'active' | 'revoked' | 'removed-unrecorded';

export interface Binding {
  pub: string;
  lane: Lane;
  status: BindingStatus;
  /** Inclusive upper bound on header.ckpt for revoked keys. */
  maxCkpt: number | null;
}

export class LaneBindings {
  private readonly byPub: ReadonlyMap<string, Binding>;

  constructor(bindings: Iterable<Binding>) {
    this.byPub = new Map([...bindings].map((b) => [b.pub, b]));
  }

  get(pub: string): Binding | undefined {
    return this.byPub.get(pub);
  }

  activeKey(lane: Lane): string | undefined {
    for (const b of this.byPub.values()) if (b.lane === lane && b.status === 'active') return b.pub;
    return undefined;
  }

  all(): Binding[] {
    return [...this.byPub.values()].sort((a, b) => a.lane.localeCompare(b.lane) || a.pub.localeCompare(b.pub));
  }
}

export type BindResult = { ok: true; bindings: LaneBindings; issues: string[] } | { ok: false; error: string };

/**
 * Combine the live delegate set with ledger history. Fails when the account
 * is inactive. A lane without exactly one active key is reported in `issues`
 * rather than failing, so control can still verify the ledger while a lane is
 * between revoke and rotate; each process checks its own lane at startup with
 * `assertOwnLane` and refuses to run otherwise.
 */
export function bindLanes(account: AccountState, history: LaneHistory = { known: [], revoked: [] }): BindResult {
  if (!account.active) return { ok: false, error: 'MemWalAccount is not active' };
  if (account.adminQuarantined) return { ok: false, error: 'MemWalAccount is admin-quarantined' };

  const revokedCkpt = new Map<string, number>();
  for (const r of history.revoked) {
    const prev = revokedCkpt.get(r.pub);
    revokedCkpt.set(r.pub, prev === undefined ? r.ckpt : Math.min(prev, r.ckpt));
  }

  const bindings = new Map<string, Binding>();
  const perLane = new Map<Lane, string[]>();
  for (const k of account.delegateKeys) {
    const lane = LABEL_LANE[k.label];
    if (!lane) continue; // dashboard or other keys are not Antibody lanes
    const pub = k.publicKeyHex.toLowerCase();
    if (!isHex(pub, 32)) return { ok: false, error: `delegate key ${k.publicKeyHex} is not 32-byte hex` };
    const max = revokedCkpt.get(pub);
    bindings.set(pub, { pub, lane, status: max === undefined ? 'active' : 'revoked', maxCkpt: max ?? null });
    if (max === undefined) perLane.set(lane, [...(perLane.get(lane) ?? []), pub]);
  }
  const issues: string[] = [];
  for (const lane of LANES) {
    const keys = perLane.get(lane) ?? [];
    if (keys.length !== 1) issues.push(`lane ${lane} has ${keys.length} active keys on-chain (expected exactly 1)`);
  }

  for (const r of history.revoked) {
    if (!bindings.has(r.pub)) bindings.set(r.pub, { pub: r.pub, lane: r.lane, status: 'revoked', maxCkpt: revokedCkpt.get(r.pub)! });
  }
  for (const k of history.known) {
    if (!bindings.has(k.pub)) {
      // Removed on-chain but never recorded as revoked: we cannot bound when it
      // stopped being authorised, so nothing it signed verifies.
      bindings.set(k.pub, { pub: k.pub, lane: k.lane, status: 'removed-unrecorded', maxCkpt: null });
    }
  }
  return { ok: true, bindings: new LaneBindings(bindings.values()), issues };
}

/**
 * Startup check (spec §4): this process's lane must have exactly one active
 * key on-chain, and it must be the key this process holds.
 */
export function assertOwnLane(bindings: LaneBindings, lane: Lane, ownPub: string): void {
  const active = bindings.all().filter((b) => b.lane === lane && b.status === 'active');
  if (active.length !== 1) throw new Error(`lane ${lane} has ${active.length} active keys on-chain; refusing to start`);
  if (active[0]!.pub !== ownPub) throw new Error(`this process's ${lane} key is not the active ${LANE_LABEL[lane]} key on-chain; refusing to start`);
}
