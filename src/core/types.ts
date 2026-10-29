/**
 * Shared types for the pure core. Nothing in src/core performs I/O, reads the
 * clock or calls a model: every input arrives as an argument (spec §13 layout).
 */

export const LANES = ['user', 'agent', 'wallet-objects', 'antibody'] as const;
export type Lane = (typeof LANES)[number];

/** On-chain delegate labels. The owner wallet attests label → public key (spec §4). */
export const LANE_LABEL: Readonly<Record<Lane, string>> = {
  user: 'antibody:user',
  agent: 'antibody:agent',
  'wallet-objects': 'antibody:wallet-objects',
  antibody: 'antibody:control',
};

export const LABEL_LANE: Readonly<Record<string, Lane>> = Object.fromEntries(
  Object.entries(LANE_LABEL).map(([lane, label]) => [label, lane as Lane]),
);

export const KINDS = ['statement', 'observation', 'note', 'summary', 'decision', 'ledger'] as const;
export type Kind = (typeof KINDS)[number];

/**
 * Which kinds each lane may sign. A kind outside this table makes the envelope
 * invalid, so the agent lane can never sign a `statement` and the
 * wallet-objects lane can never sign a ledger record.
 */
export const LANE_KINDS: Readonly<Record<Lane, readonly Kind[]>> = {
  user: ['statement', 'ledger'],
  agent: ['note', 'summary'],
  'wallet-objects': ['observation'],
  antibody: ['decision', 'ledger'],
};

export const NS_CONTENT = 'steward.mem';
export const NS_LEDGER = 'antibody.ledger';
export const NAMESPACES = [NS_CONTENT, NS_LEDGER] as const;
export type Namespace = (typeof NAMESPACES)[number];

/** Origin reference recorded in an envelope header (spec §5 `src`). */
export interface SrcRef {
  /** sui-object | sender | coin-type | package | user-msg | tx | url */
  t: string;
  id?: string;
  ver?: string;
  digest?: string;
  addr?: string;
  type?: string;
}

export interface EnvelopeHeader {
  v: 1;
  id: string;
  acct: string;
  ns: string;
  lane: Lane;
  kind: Kind;
  pub: string;
  parents: string[];
  src: SrcRef[];
  turn: string | null;
  ckpt: number;
  ts: string;
  bodyHash: string;
  bodyLen: number;
}

export interface Envelope {
  header: EnvelopeHeader;
  body: string;
  /** Full stored text: `AB1|header|sig\nbody`. */
  text: string;
}

/** Trust classes ordered highest → lowest (spec §4). Quarantine is a separate flag. */
export const TRUST_ORDER = ['trusted', 'derived', 'untrusted', 'unverified'] as const;
export type TrustClass = (typeof TRUST_ORDER)[number];

export function lowerOf(a: TrustClass, b: TrustClass): TrustClass {
  return TRUST_ORDER.indexOf(a) >= TRUST_ORDER.indexOf(b) ? a : b;
}

/** A memory as returned by the relayer: blob id plus the text it stored. */
export interface StoredMemory {
  blobId: string;
  namespace: string;
  text: string;
  /** Relayer-reported creation time, when known (informational). */
  createdAt?: string;
}

export type SeedType = 'memory' | 'source' | 'signer-window' | 'turn';

export interface QuarantineSeed {
  type: SeedType;
  /** memory: envelope id · source: origin identifier · signer-window: pub hex · turn: turn id */
  value: string;
  /** signer-window only: inclusive checkpoint range. */
  from?: number;
  to?: number;
}

export interface Payee {
  payeeId: string;
  label: string;
  address: string;
  coinType: string;
  capPerTx: string;
}
