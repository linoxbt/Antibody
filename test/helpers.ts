/** Pure-test fixtures: lane keys, an account, bindings and envelope builders. */
import { buildEnvelope } from '../src/core/envelope.ts';
import { uuidv7 } from '../src/core/encoding.ts';
import { generateSeedHex, laneKeyFromSeedHex, type LaneKey } from '../src/core/keys.ts';
import { bindLanes, type AccountState, type LaneBindings } from '../src/core/lanes.ts';
import { ledgerBodyText, type LedgerRecord, GENESIS_PREV, type LedgerPayload, type LedgerType } from '../src/core/ledger.ts';
import { sha256Hex } from '../src/core/encoding.ts';
import { LANES, LANE_LABEL, NS_CONTENT, NS_LEDGER, type Envelope, type Kind, type Lane, type SrcRef, type StoredMemory } from '../src/core/types.ts';

export const ACCT = '0x' + 'ac'.repeat(32);
export const OWNER = '0x' + '0e'.repeat(32);

export interface Keys {
  lane: Record<Lane, LaneKey>;
  stranger: LaneKey;
}

export function makeKeys(): Keys {
  const lane = Object.fromEntries(LANES.map((l) => [l, laneKeyFromSeedHex(generateSeedHex())])) as unknown as Record<Lane, LaneKey>;
  return { lane, stranger: laneKeyFromSeedHex(generateSeedHex()) };
}

export function account(k: Keys, extra: { pub: string; label: string }[] = []): AccountState {
  return {
    accountId: ACCT,
    owner: OWNER,
    active: true,
    adminQuarantined: false,
    delegateKeys: [...LANES.map((l) => ({ publicKeyHex: k.lane[l].publicKeyHex, label: LANE_LABEL[l], suiAddress: '0x1', createdAtMs: 0 })), ...extra.map((e) => ({ publicKeyHex: e.pub, label: e.label, suiAddress: '0x2', createdAtMs: 0 }))],
  };
}

export function bindings(k: Keys): LaneBindings {
  const b = bindLanes(account(k));
  if (!b.ok) throw new Error(b.error);
  return b.bindings;
}

let clock = 1_790_000_000_000;
export const tick = () => ++clock;

export function mem(
  key: LaneKey,
  lane: Lane,
  kind: Kind,
  text: string,
  o: { parents?: string[]; src?: SrcRef[]; ckpt?: number; turn?: string | null; ns?: string; id?: string } = {},
): Envelope {
  return buildEnvelope(
    { id: o.id ?? uuidv7(tick()), acct: ACCT, ns: o.ns ?? NS_CONTENT, lane, kind, parents: o.parents ?? [], src: o.src ?? [], turn: o.turn ?? null, ckpt: o.ckpt ?? 100, ts: '2026-10-29T00:00:00Z', text },
    key,
  );
}

export function stored(env: Envelope, ns = env.header.ns): StoredMemory {
  return { blobId: 'b' + sha256Hex(env.text).slice(0, 20), namespace: ns, text: env.text };
}

/** Build a well-formed ledger chain from (type, payload, signer) steps. */
export function ledgerChain(k: Keys, steps: { type: LedgerType; payload: LedgerPayload<LedgerType>; lane: Lane; ckpt?: number }[]): Envelope[] {
  const out: Envelope[] = [];
  let prev = GENESIS_PREV;
  steps.forEach((s, seq) => {
    const rec = { seq, prev, type: s.type, payload: s.payload } as LedgerRecord;
    const env = buildEnvelope({ id: uuidv7(tick()), acct: ACCT, ns: NS_LEDGER, lane: s.lane, kind: 'ledger', ckpt: s.ckpt ?? 100 + seq, ts: '2026-10-29T00:00:00Z', text: ledgerBodyText(rec) }, k.lane[s.lane]);
    out.push(env);
    prev = sha256Hex(env.text);
  });
  return out;
}

export function genesisStep(k: Keys) {
  return {
    type: 'genesis' as const,
    lane: 'antibody' as const,
    payload: { account: ACCT, owner: OWNER, network: 'fixture', ckpt: 99, lanes: LANES.map((l) => ({ lane: l, label: LANE_LABEL[l], pub: k.lane[l].publicKeyHex })) },
  };
}

export const LANDLORD = '0x' + '7a'.repeat(32);
export const ATTACKER = '0x' + 'ba'.repeat(32);
export const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

export function payeeStep(id = 'landlord', address = LANDLORD, cap = '500000000') {
  return { type: 'payee.add' as const, lane: 'user' as const, payload: { payeeId: id, label: id, address, coinType: USDC, capPerTx: cap } };
}
