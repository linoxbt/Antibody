/**
 * Antibody ledger (spec §7, invariants I-6, I-9, I-11).
 *
 * All control state lives in an append-only, hash-chained ledger of enveloped
 * memories in `antibody.ledger`. If the ledger cannot be shown complete and
 * intact, verification fails and every payment is blocked.
 *
 * Record body:
 *   [lane:<lane> kind:ledger]
 *   antibody ledger record seq <N> type <type>
 *   <JCS JSON {seq, prev, type, payload}>
 */
import { z } from 'zod';
import { bodyContent, parseEnvelope } from './envelope.ts';
import { canonicalJson, isCoinType, normalizeCoinType, SUI_ADDRESS_RE, sha256Hex } from './encoding.ts';
import { bindLanes, type AccountState, type LaneBindings, type LaneHistory } from './lanes.ts';
import { seedMatches, normalizeSeed } from './seeds.ts';
import { verifyEnvelope } from './verify.ts';
import { LANES, LABEL_LANE, NS_LEDGER, type Envelope, type Lane, type Payee, type QuarantineSeed, type StoredMemory } from './types.ts';

export const LEDGER_PHRASE = 'antibody ledger record';
/** recall returns at most 100 hits per call, so the MVP ledger stops at 90 records (spec §7). */
export const LEDGER_CAP = 90;
export const GENESIS_PREV = '0'.repeat(64);

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const address = z.string().regex(SUI_ADDRESS_RE, 'address must be 0x + 64 lowercase hex');
const coinType = z.string().refine((s) => isCoinType(s) && normalizeCoinType(s) === s, 'coinType must be normalised');
const baseUnits = z.string().regex(/^[1-9][0-9]{0,30}$/, 'amount must be a positive integer in base units');
const seedSchema = z
  .object({
    type: z.enum(['memory', 'source', 'signer-window', 'turn']),
    value: z.string().min(1).max(256),
    from: z.number().int().nonnegative().optional(),
    to: z.number().int().nonnegative().optional(),
  })
  .strict();

export const payloadSchemas = {
  genesis: z
    .object({
      account: z.string(),
      owner: address,
      network: z.string(),
      ckpt: z.number().int().nonnegative(),
      lanes: z.array(z.object({ lane: z.enum(LANES), label: z.string(), pub: hex64 }).strict()).length(4),
    })
    .strict(),
  'payee.add': z
    .object({
      payeeId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
      label: z.string().min(1).max(64),
      address,
      coinType,
      capPerTx: baseUnits,
    })
    .strict(),
  'payee.remove': z.object({ payeeId: z.string().min(1).max(48) }).strict(),
  quarantine: z
    .object({
      seed: seedSchema,
      reason: z.string().min(1).max(512),
      evidence: z.array(z.string().max(256)).max(32),
      ckpt: z.number().int().nonnegative(),
      auto: z.boolean(),
    })
    .strict(),
  'quarantine.release': z.object({ quarantineSeq: z.number().int().nonnegative(), reason: z.string().min(1).max(512) }).strict(),
  'lane.revoke': z.object({ pub: hex64, label: z.string(), digest: z.string().min(32).max(64), ckpt: z.number().int().nonnegative() }).strict(),
  'lane.rotate': z.object({ pub: hex64, label: z.string(), digest: z.string().min(32).max(64), ckpt: z.number().int().nonnegative() }).strict(),
  /**
   * Learning loop: what a confirmed quarantine taught the sentinel. Written by
   * control from the quarantined memories' origins; reverts if the quarantine
   * it came from is released.
   */
  lesson: z
    .object({
      fromSeq: z.number().int().nonnegative(),
      indicators: z
        .object({
          senders: z.array(address).max(16),
          coinTypes: z.array(z.string().max(512)).max(16),
          packages: z.array(address).max(16),
          keywords: z.array(z.string().max(48)).max(48),
        })
        .strict(),
      summary: z.string().max(512),
    })
    .strict(),
} as const;

export type LedgerType = keyof typeof payloadSchemas;
export const LEDGER_TYPES = Object.keys(payloadSchemas) as LedgerType[];
export type LedgerPayload<T extends LedgerType> = z.infer<(typeof payloadSchemas)[T]>;

/** Which lane may sign each record type (spec §7 table). */
export const LEDGER_SIGNER: Readonly<Record<LedgerType, Lane>> = {
  genesis: 'antibody',
  'payee.add': 'user',
  'payee.remove': 'user',
  quarantine: 'antibody',
  'quarantine.release': 'user',
  'lane.revoke': 'antibody',
  'lane.rotate': 'antibody',
  lesson: 'antibody',
};

export interface LedgerRecord<T extends LedgerType = LedgerType> {
  seq: number;
  prev: string;
  type: T;
  payload: LedgerPayload<T>;
}

export function ledgerBodyText(r: LedgerRecord): string {
  return `${LEDGER_PHRASE} seq ${r.seq} type ${r.type}\n${canonicalJson(r)}`;
}

/** Parse the content of a ledger envelope body (without the lane tag). */
export function parseLedgerBody(content: string): LedgerRecord {
  const lines = content.split('\n');
  if (lines.length !== 2) throw new Error('ledger body must be the phrase line plus one JSON line');
  const m = /^antibody ledger record seq (\d+) type ([a-z.]+)$/.exec(lines[0]!);
  if (!m) throw new Error('missing retrieval phrase');
  const raw = JSON.parse(lines[1]!) as Record<string, unknown>;
  if (canonicalJson(raw) !== lines[1]) throw new Error('ledger JSON is not canonical');
  const keys = Object.keys(raw).sort().join(',');
  if (keys !== 'payload,prev,seq,type') throw new Error('ledger JSON must have exactly seq, prev, type, payload');
  const type = raw.type as LedgerType;
  if (!LEDGER_TYPES.includes(type)) throw new Error(`unknown ledger type ${String(raw.type)}`);
  if (typeof raw.seq !== 'number' || !Number.isInteger(raw.seq) || raw.seq < 0) throw new Error('bad seq');
  if (typeof raw.prev !== 'string' || !/^[0-9a-f]{64}$/.test(raw.prev)) throw new Error('bad prev');
  if (String(raw.seq) !== m[1] || type !== m[2]) throw new Error('phrase line disagrees with JSON');
  const parsed = payloadSchemas[type].safeParse(raw.payload);
  if (!parsed.success) throw new Error(`${type} payload: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
  return { seq: raw.seq, prev: raw.prev, type, payload: parsed.data } as LedgerRecord;
}

export type LedgerFailureCode = 'LEDGER_INCOMPLETE' | 'LEDGER_CORRUPT' | 'LEDGER_ROLLBACK' | 'LEDGER_EMPTY';

export interface LedgerFailure {
  ok: false;
  code: LedgerFailureCode;
  detail: string;
  /** Chain-only bindings, for showing content in degraded (forensic) mode. */
  bindings?: LaneBindings;
}

export interface VerifiedLedgerRecord<T extends LedgerType = LedgerType> {
  record: LedgerRecord<T>;
  env: Envelope;
  hash: string;
  blobIds: string[];
}

export interface ActivePayee extends Payee {
  seq: number;
  signerPub: string;
}

export interface QuarantineEntry {
  seq: number;
  seed: QuarantineSeed;
  reason: string;
  evidence: string[];
  ckpt: number;
  auto: boolean;
  released: boolean;
  releasedBy?: number;
}

export interface LessonEntry extends LedgerPayload<'lesson'> {
  seq: number;
  active: boolean;
}

export interface LedgerState {
  ok: true;
  head: { seq: number; hash: string };
  records: VerifiedLedgerRecord[];
  genesis: LedgerPayload<'genesis'>;
  payees: ActivePayee[];
  /** payee/release records excluded because a quarantine seed matches them. */
  excluded: { seq: number; type: LedgerType; bySeq: number[] }[];
  quarantines: QuarantineEntry[];
  revocations: (LedgerPayload<'lane.revoke'> & { seq: number; lane: Lane })[];
  rotations: (LedgerPayload<'lane.rotate'> & { seq: number; lane: Lane })[];
  lessons: LessonEntry[];
  bindings: LaneBindings;
  /** "first sync" when no high-water mark existed yet. */
  firstSync: boolean;
}

export type LedgerResult = LedgerState | LedgerFailure;

export interface LedgerInput {
  acct: string;
  account: AccountState;
  /** blob ids from listMemories({namespace: antibody.ledger}). */
  inventory: string[];
  /** Texts recalled from antibody.ledger. */
  recalled: StoredMemory[];
  /** Highest verified head this machine has seen (rollback guard). */
  hwm?: { seq: number; hash: string } | null;
}

function historyFrom(records: { record: LedgerRecord; lane?: Lane }[]): LaneHistory {
  const known: LaneHistory['known'] = [];
  const revoked: LaneHistory['revoked'] = [];
  for (const { record } of records) {
    if (record.type === 'genesis') {
      for (const l of (record.payload as LedgerPayload<'genesis'>).lanes) known.push({ pub: l.pub, lane: l.lane });
    } else if (record.type === 'lane.rotate' || record.type === 'lane.revoke') {
      const p = record.payload as LedgerPayload<'lane.rotate'>;
      const lane = LABEL_LANE[p.label];
      if (!lane) continue;
      if (record.type === 'lane.rotate') known.push({ pub: p.pub, lane });
      else revoked.push({ pub: p.pub, lane, ckpt: p.ckpt });
    }
  }
  return { known, revoked };
}

/**
 * Completeness, integrity and rollback checks (spec §7), then the derived
 * control state. Pure: the caller supplies inventory and recalled texts.
 */
export function verifyLedger(input: LedgerInput): LedgerResult {
  const chainOnly = bindLanes(input.account);
  const degraded = chainOnly.ok ? { bindings: chainOnly.bindings } : {};
  const fail = (code: LedgerFailureCode, detail: string): LedgerFailure => ({ ok: false, code, detail, ...degraded });

  // Coverage: every inventory blob must have recalled text.
  const byBlob = new Map<string, string>();
  for (const m of input.recalled) if (m.namespace === NS_LEDGER) byBlob.set(m.blobId, m.text);
  const missing = input.inventory.filter((b) => !byBlob.has(b));
  if (missing.length > 0) return fail('LEDGER_INCOMPLETE', `${missing.length} ledger blob(s) in the inventory have no recalled text: ${missing.slice(0, 3).join(', ')}`);
  if (byBlob.size === 0) return fail('LEDGER_EMPTY', 'no ledger records: run `antibody setup` to write genesis');

  // Pass 1: parse without trusting anything, to learn historical key bindings.
  const parsed: { blobId: string; text: string; record: LedgerRecord }[] = [];
  for (const [blobId, text] of byBlob) {
    try {
      const env = parseEnvelope(text);
      parsed.push({ blobId, text, record: parseLedgerBody(bodyContent(env.body)) });
    } catch (e) {
      return fail('LEDGER_CORRUPT', `blob ${blobId}: ${(e as Error).message}`);
    }
  }
  const bound = bindLanes(input.account, historyFrom(parsed));
  if (!bound.ok) return fail('LEDGER_CORRUPT', bound.error);
  const bindings = bound.bindings;

  // Pass 2: every record must verify and be signed by the lane its type requires.
  const bySeq = new Map<number, VerifiedLedgerRecord>();
  for (const p of parsed) {
    const v = verifyEnvelope(p.text, { acct: input.acct, ns: NS_LEDGER, bindings });
    if (!v.ok) return fail('LEDGER_CORRUPT', `seq ${p.record.seq} (blob ${p.blobId}): ${v.code} ${v.reason}`);
    const want = LEDGER_SIGNER[p.record.type];
    if (v.envelope.header.lane !== want) {
      return fail('LEDGER_CORRUPT', `seq ${p.record.seq}: ${p.record.type} must be signed by the ${want} lane, not ${v.envelope.header.lane}`);
    }
    const existing = bySeq.get(p.record.seq);
    if (existing) {
      if (existing.env.text !== p.text) return fail('LEDGER_CORRUPT', `fork: two different records with seq ${p.record.seq}`);
      existing.blobIds.push(p.blobId);
      continue;
    }
    bySeq.set(p.record.seq, { record: p.record, env: v.envelope, hash: sha256Hex(p.text), blobIds: [p.blobId] });
  }

  // Integrity: contiguous from 0, hash-chained, genesis first and only once.
  const records: VerifiedLedgerRecord[] = [];
  for (let s = 0; s < bySeq.size; s++) {
    const r = bySeq.get(s);
    if (!r) return fail('LEDGER_CORRUPT', `gap: seq ${s} missing (have ${bySeq.size} records)`);
    const expectPrev = s === 0 ? GENESIS_PREV : records[s - 1]!.hash;
    if (r.record.prev !== expectPrev) return fail('LEDGER_CORRUPT', `seq ${s}: prev does not match the previous record's hash`);
    if ((s === 0) !== (r.record.type === 'genesis')) return fail('LEDGER_CORRUPT', `seq ${s}: genesis must be exactly record 0`);
    records.push(r);
  }
  const genesis = records[0]!.record.payload as LedgerPayload<'genesis'>;
  if (genesis.account !== input.acct) return fail('LEDGER_CORRUPT', 'genesis names a different account');
  const head = { seq: records.length - 1, hash: records[records.length - 1]!.hash };

  // Rollback guard.
  const hwm = input.hwm ?? null;
  if (hwm) {
    if (head.seq < hwm.seq) return fail('LEDGER_ROLLBACK', `ledger head ${head.seq} is below the verified high-water mark ${hwm.seq}`);
    if (records[hwm.seq]!.hash !== hwm.hash) return fail('LEDGER_ROLLBACK', `record ${hwm.seq} differs from the one verified before`);
  }

  // Derived state. Quarantine seeds first, then releases, then payees.
  const quarantines: QuarantineEntry[] = [];
  for (const r of records) {
    if (r.record.type !== 'quarantine') continue;
    const p = r.record.payload as LedgerPayload<'quarantine'>;
    quarantines.push({ seq: r.record.seq, seed: normalizeSeed(p.seed as QuarantineSeed), reason: p.reason, evidence: p.evidence, ckpt: p.ckpt, auto: p.auto, released: false });
  }
  const excluded: LedgerState['excluded'] = [];
  const matchingSeeds = (env: Envelope, among: QuarantineEntry[]) => among.filter((q) => seedMatches(q.seed, env.header)).map((q) => q.seq);
  for (const r of records) {
    if (r.record.type !== 'quarantine.release') continue;
    const p = r.record.payload as LedgerPayload<'quarantine.release'>;
    const target = quarantines.find((q) => q.seq === p.quarantineSeq);
    if (!target || p.quarantineSeq >= r.record.seq) return fail('LEDGER_CORRUPT', `seq ${r.record.seq}: release of ${p.quarantineSeq}, which is not an earlier quarantine record`);
    // A release signed inside a quarantined signer window is not honoured.
    const hits = matchingSeeds(r.env, quarantines);
    if (hits.length > 0) {
      excluded.push({ seq: r.record.seq, type: r.record.type, bySeq: hits });
      continue;
    }
    target.released = true;
    target.releasedBy = r.record.seq;
  }
  const active = quarantines.filter((q) => !q.released);

  const payees = new Map<string, ActivePayee>();
  for (const r of records) {
    if (r.record.type === 'payee.add') {
      const hits = matchingSeeds(r.env, active);
      if (hits.length > 0) {
        excluded.push({ seq: r.record.seq, type: r.record.type, bySeq: hits });
        continue;
      }
      const p = r.record.payload as LedgerPayload<'payee.add'>;
      payees.set(p.payeeId, { ...p, seq: r.record.seq, signerPub: r.env.header.pub });
    } else if (r.record.type === 'payee.remove') {
      // Removals only ever restrict, so a quarantine never undoes one.
      payees.delete((r.record.payload as LedgerPayload<'payee.remove'>).payeeId);
    }
  }

  const laneOfLabel = (label: string, seq: number): Lane | LedgerFailure => LABEL_LANE[label] ?? fail('LEDGER_CORRUPT', `seq ${seq}: unknown lane label ${label}`);
  const revocations: LedgerState['revocations'] = [];
  const rotations: LedgerState['rotations'] = [];
  for (const r of records) {
    if (r.record.type !== 'lane.revoke' && r.record.type !== 'lane.rotate') continue;
    const p = r.record.payload as LedgerPayload<'lane.revoke'>;
    const lane = laneOfLabel(p.label, r.record.seq);
    if (typeof lane !== 'string') return lane;
    (r.record.type === 'lane.revoke' ? revocations : rotations).push({ ...p, seq: r.record.seq, lane });
  }

  const lessons: LessonEntry[] = [];
  for (const r of records) {
    if (r.record.type !== 'lesson') continue;
    const p = r.record.payload as LedgerPayload<'lesson'>;
    const from = quarantines.find((q) => q.seq === p.fromSeq);
    if (!from) return fail('LEDGER_CORRUPT', `seq ${r.record.seq}: lesson cites ${p.fromSeq}, which is not a quarantine record`);
    lessons.push({ ...p, seq: r.record.seq, active: !from.released });
  }

  return {
    ok: true,
    head,
    records,
    genesis,
    payees: [...payees.values()].sort((a, b) => a.payeeId.localeCompare(b.payeeId)),
    excluded,
    quarantines,
    revocations,
    rotations,
    lessons,
    bindings,
    firstSync: !hwm,
  };
}

export function activeSeeds(state: Pick<LedgerState, 'quarantines'>): { seed: QuarantineSeed; seq: number }[] {
  return state.quarantines.filter((q) => !q.released).map((q) => ({ seed: q.seed, seq: q.seq }));
}

/** Next (seq, prev) for an append, enforcing the MVP cap. */
export function nextAppend(state: LedgerState): { seq: number; prev: string } {
  const seq = state.head.seq + 1;
  if (seq >= LEDGER_CAP) throw new Error(`ledger is at the MVP cap of ${LEDGER_CAP} records`);
  return { seq, prev: state.head.hash };
}
