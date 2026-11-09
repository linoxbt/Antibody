/**
 * Antibody control (spec §3): holds the antibody key and the Tatum key.
 * Verifies, computes lineage and the projection, keeps the ledger, runs the
 * policy engine, asks the signer to execute ALLOWed payments, and writes
 * decision records. Never holds the owner or wallet key.
 */
import { join } from 'node:path';
import { bodyContent, buildEnvelope } from '../core/envelope.ts';
import { fromBase64, isCanonicalSuiAddress, normalizeCoinType, normalizeSuiAddress, sha256Hex, SUI_COIN_TYPE, toBase64, uuidv7, UUID_RE } from '../core/encoding.ts';
import type { LaneKey } from '../core/keys.ts';
import type { AccountState } from '../core/lanes.ts';
import {
  activeSeeds,
  GENESIS_PREV,
  LEDGER_CAP,
  LEDGER_FUTURE_SLACK,
  LEDGER_MAX_AGE,
  LEDGER_SIGNER,
  ledgerBodyText,
  nextAppend,
  parseLedgerBody,
  verifyLedger,
  type LedgerPayload,
  type LedgerRecord,
  type LedgerResult,
  type LedgerState,
  type LedgerType,
} from '../core/ledger.ts';
import { deriveLesson, matchLessons } from '../core/lessons.ts';
import { scoreText } from '../ingest/heuristics.ts';
import { blocklisted, type GuardianLists } from '../ingest/guardians.ts';
import { z } from 'zod';
import { blastRadius, computeLineage, type BlastRadius, type VerifiedInput } from '../core/lineage.ts';
import { evaluatePayment, type ChainState, type PaymentProposal, type Verdict } from '../core/policy.ts';
import { buildProjection, contextEligible, toContextItem, type ContextItem, type Projection } from '../core/projection.ts';
import { normalizeIdentifier, normalizeSeed, seedKey, srcIdentifiers } from '../core/seeds.ts';
import { formatUnits, toBaseUnits } from '../core/units.ts';
import { verifyEnvelope } from '../core/verify.ts';
import { LABEL_LANE, LANE_LABEL, NS_CONTENT, NS_LEDGER, type Lane, type QuarantineSeed, type StoredMemory } from '../core/types.ts';
import type { ChainReader, TxInfo } from '../adapters/chain.ts';
import { withFileLock } from '../adapters/filestore.ts';
import type { MemoryClient } from '../adapters/memory.ts';
import type { ReportStore } from '../adapters/storage-tatum.ts';
import type { IpcClient } from '../ipc.ts';
import type { Logger } from '../log.ts';
import type { Alert } from '../ops/alerts.ts';
import { decodeHeader, encodeHeader, HDR_REQUIRED, HDR_RESPONSE, HDR_SIGNATURE, paymentRequiredSchema, selectRequirement, settlementResponseSchema, type PaymentPayload, type SettlementResponse } from '../payments/x402.ts';
import { retrieveContent, retrieveLedger } from './retrieve.ts';
import { DecisionOutbox, HighWaterMark, IncidentStore, PaymentLog, ReportLog, TextCache, type Incident, type PaymentEntry } from './store.ts';

/** Auto-quarantines per hour, and ledger records kept free for the human (S4). */
const AUTO_QUARANTINE_PER_HOUR = 30;
/** A repeat of an executed payment within this window is refused (B6). */
const DUPLICATE_WINDOW_MS = 10 * 60_000;
/** Envelope header limit on parents. */
const MAX_DECISION_PARENTS = 64;
const LEDGER_USER_RESERVE = 250;

const incidentSchema = z
  .object({
    // S2: an incident names a Sui object, never a memory id or any other identifier.
    objectId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/, 'objectId must be a Sui object id').transform((v) => normalizeSuiAddress(v)),
    observationId: z.string().regex(UUID_RE).nullable(),
    coinType: z.string().max(512).optional(),
    sender: z.string().max(80).optional(),
    score: z.number().finite().min(0).max(1),
    rules: z.array(z.string().max(200)).max(32),
    lessonMatches: z.array(z.object({ lessonSeq: z.number().int().nonnegative(), indicator: z.string().max(16), value: z.string().max(512) }).strict()).max(32),
    blocklisted: z.boolean(),
    proposedSeed: z.object({ type: z.literal('source'), value: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).transform((v) => normalizeSuiAddress(v)) }).strict(),
  })
  .strict();

/** B4: what the agent lane may send to /propose and /x402/pay; bounded so nothing oversized reaches a decision record. */
const proposalSchema = z
  .object({
    recipient: z.string().max(80),
    amount: z.string().max(48),
    coinType: z.string().max(512).optional(),
    payeeLabel: z.string().max(64).optional(),
    reason: z.string().max(1000),
    cites: z.array(z.string().max(64)).max(32).optional(),
  })
  .strict();
const turnSchema = z.string().min(1).max(64);
const readSetSchema = z.array(z.string().max(64)).max(256);
export const proposeArgsSchema = z.object({ turn: turnSchema, readSet: readSetSchema, proposal: proposalSchema, execute: z.boolean() }).strict();
export const x402ArgsSchema = z
  .object({ turn: turnSchema, readSet: readSetSchema, url: z.string().min(1).max(2048), payeeLabel: z.string().max(64).optional(), reason: z.string().max(1000), execute: z.boolean().default(false) })
  .strict();

/** S4: verdict text can quote model input; control characters are escaped so it stays one line. */
const oneLine = (t: string) => t.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (c) => JSON.stringify(c).slice(1, -1));

/** How long to wait for a just-submitted transaction to become readable (B2). */
const TX_WAIT_MS = 30_000;

const normalizeIdentifierSafe = (v: string) => {
  try {
    return normalizeIdentifier(v);
  } catch {
    return v;
  }
};

export interface ControlDeps {
  acct: string;
  wallet: string;
  chain: ChainReader;
  mem: MemoryClient;
  key: LaneKey;
  /** Client to the signer process; null when no signer is configured. */
  signer: IpcClient | null;
  home: string;
  log: Logger;
  reports: ReportStore;
  simulated: boolean;
  maxGasMist: string;
  x402Network: string;
  /** Cache directory (cleared by rebuild --fresh). */
  cacheDir: string;
  autoQuarantineScore: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Use no cached texts at all (rebuild --fresh). */
  noCache?: boolean;
  /** Best-effort human alerts (webhook / Telegram); never awaited on the payment path. */
  alert?: (a: Alert) => void;
  /** Sui Guardians lists, so control recomputes blocklist hits itself (S2). */
  guardians?: () => Promise<GuardianLists>;
  /** host[:port] values pay_x402 may fetch; empty or absent disables it (M3). */
  x402Allow?: string[];
}

export interface Snapshot {
  account: AccountState;
  ckpt: number;
  ledger: LedgerResult;
  projection: Projection;
  coverage: { ledgerMissing: string[]; contentMissing: string[]; queries: number };
}

/** What the model may send with propose_payment. Amount is in display units. */
export interface ModelProposal {
  recipient: string;
  amount: string;
  coinType?: string;
  payeeLabel?: string;
  reason: string;
  cites?: string[];
}

export interface DecisionResult {
  verdict: Verdict;
  decisionId: string;
  decisionBlobId: string;
  amountBase: string | null;
  coinType: string | null;
  decimals: number | null;
  executed: boolean;
  txDigest: string | null;
  dryRunOnly: boolean;
  simulated: boolean;
}

export class Control {
  readonly cache: TextCache;
  readonly hwm: HighWaterMark;
  readonly incidents: IncidentStore;
  readonly reportLog: ReportLog;
  readonly payments: PaymentLog;
  readonly decisionOutbox: DecisionOutbox;
  /** Memory ids served to each turn by recallForAgent (M6), most recent 200 turns. */
  private readonly served = new Map<string, Set<string>>();
  private readonly now: () => number;
  private last: Snapshot | null = null;
  private memo: { ledgerKey?: string; ledger?: LedgerResult; projectionKey?: string; projection?: Projection } = {};

  constructor(readonly d: ControlDeps) {
    this.cache = new TextCache(d.cacheDir);
    this.hwm = new HighWaterMark(join(d.home, 'hwm.json'));
    this.incidents = new IncidentStore(d.cacheDir);
    this.reportLog = new ReportLog(d.cacheDir);
    this.payments = new PaymentLog(d.home);
    this.decisionOutbox = new DecisionOutbox(d.home);
    this.now = d.now ?? Date.now;
  }

  get lastSnapshot(): Snapshot | null {
    return this.last;
  }

  // ---- state -------------------------------------------------------------

  /**
   * Read the account through the chain reader, verify the ledger (coverage,
   * integrity, rollback) and build the projection. Runs before every payment.
   */
  async snapshot(o: { assumeRevoked?: { pub: string; lane: Lane; ckpt: number }[] } = {}): Promise<Snapshot> {
    const [account, ckpt] = await Promise.all([this.d.chain.getAccount(this.d.acct), this.d.chain.latestCheckpoint()]);
    const known = this.d.noCache ? new Map<string, StoredMemory>() : this.cache.all();
    const led = await retrieveLedger(this.d.mem, known);
    const hwm = this.hwm.read();
    // Performance: verification and the projection are pure functions of these inputs, so an
    // unchanged inventory (texts included), key set and high-water mark reuse the last result.
    const fp = (ms: StoredMemory[]) => ms.map((m) => `${m.blobId}:${sha256Hex(m.text)}`).sort().join(',');
    // The chain checkpoint only matters to verification through the future-dated bound, so
    // it is keyed at that granularity and an unchanged ledger still reuses the last result.
    const ledgerKey = sha256Hex(JSON.stringify([fp(led.memories), led.inventory.map((e) => `${e.blobId}:${e.agentId}`).sort(), account, hwm, o.assumeRevoked ?? null, Math.floor(ckpt / LEDGER_FUTURE_SLACK)]));
    const ledger =
      !this.d.noCache && this.memo.ledgerKey === ledgerKey && this.memo.ledger
        ? this.memo.ledger
        : verifyLedger({ acct: this.d.acct, account, inventory: led.inventory.map((e) => e.blobId), recalled: led.memories, hwm, chainCkpt: ckpt, writers: new Map(led.inventory.map((e) => [e.blobId, e.agentId])), ...(o.assumeRevoked ? { assumeRevoked: o.assumeRevoked } : {}) });
    const content = await retrieveContent(this.d.mem, known);
    if (!this.d.noCache) this.cache.put([...led.memories, ...content.memories].filter((m) => !known.has(m.blobId)));
    const projectionKey = sha256Hex(JSON.stringify([ledgerKey, fp(content.memories), content.inventory.map((e) => `${e.blobId}:${e.createdAt}`).sort()]));
    const projection =
      !this.d.noCache && this.memo.projectionKey === projectionKey && this.memo.projection
        ? this.memo.projection
        : buildProjection({ acct: this.d.acct, ledger, content: content.memories, contentInventory: content.inventory.map((e) => e.blobId), createdAt: new Map(content.inventory.map((e) => [e.blobId, e.createdAt])) });
    this.memo = { ledgerKey, ledger, projectionKey, projection };
    if (ledger.ok) this.hwm.advance(ledger.head);
    else {
      this.d.log.warn('ledger.unverified', { code: ledger.code, detail: ledger.detail });
      this.d.alert?.({ kind: 'ledger-unverified', severity: 'critical', key: `ledger:${ledger.code}`, title: `ledger ${ledger.code}: every payment is blocked`, text: ledger.detail, data: { code: ledger.code } });
    }
    const snap: Snapshot = { account, ckpt, ledger, projection, coverage: { ledgerMissing: led.missing, contentMissing: content.missing, queries: led.queries + content.queries } };
    this.last = snap;
    return snap;
  }

  private async verifiedLedger(o: Parameters<Control['snapshot']>[0] = {}): Promise<{ snap: Snapshot; ledger: LedgerState }> {
    const snap = await this.snapshot(o);
    if (!snap.ledger.ok) throw new Error(`ledger not verified: ${snap.ledger.code} ${snap.ledger.detail}`);
    return { snap, ledger: snap.ledger };
  }

  /** Lane of a public key under the current bindings (IPC auth). */
  async laneOf(pub: string): Promise<Lane | undefined> {
    const fromSnap = this.last?.projection.bindings?.get(pub);
    if (fromSnap?.status === 'active') return fromSnap.lane;
    const account = await this.d.chain.getAccount(this.d.acct);
    const k = account.delegateKeys.find((x) => x.publicKeyHex === pub);
    return k ? LABEL_LANE[k.label] : undefined;
  }

  // ---- ledger ------------------------------------------------------------

  /** (seq, prev, ckpt) for the next append. The human CLI signs against this. */
  async head(o: Parameters<Control['snapshot']>[0] = {}): Promise<{ seq: number; prev: string; ckpt: number; acct: string }> {
    const { snap, ledger } = await this.verifiedLedger(o);
    // Never below the head record's checkpoint: a lagging RPC node must not make an append look backdated (S1).
    return { ...nextAppend(ledger), ckpt: Math.max(snap.ckpt, ledger.records[ledger.head.seq]!.env.header.ckpt), acct: this.d.acct };
  }

  /**
   * Append a signed ledger record (from the user CLI or from control itself):
   * verify it, store it with rememberAndWait, read it back by recall, verify
   * the whole ledger again, and only then advance the head.
   */
  async appendLedger(text: string, o: Parameters<Control['snapshot']>[0] = {}): Promise<{ seq: number; blobId: string; envelopeId: string }> {
    return withFileLock(join(this.d.home, 'run', 'ledger.lock'), () => this.appendLocked(text, o));
  }

  /** appendLedger's body; the caller holds the ledger lock. */
  private async appendLocked(text: string, o: Parameters<Control['snapshot']>[0] = {}): Promise<{ seq: number; blobId: string; envelopeId: string }> {
    {
      const { snap, ledger } = await this.verifiedLedger(o);
      const v = verifyEnvelope(text, { acct: this.d.acct, ns: NS_LEDGER, bindings: ledger.bindings });
      if (!v.ok) throw new Error(`record rejected: ${v.code} ${v.reason}`);
      const rec = parseLedgerBody(bodyContent(v.envelope.body));
      if (v.envelope.header.lane !== LEDGER_SIGNER[rec.type]) throw new Error(`${rec.type} must be signed by the ${LEDGER_SIGNER[rec.type]} lane`);
      const expect = nextAppend(ledger);
      if (rec.seq !== expect.seq || rec.prev !== expect.prev) throw new Error(`stale head: record is seq ${rec.seq}, ledger expects ${expect.seq}; fetch the head and sign again`);
      // S1: refuse a backdated or future-dated record before it is stored; once stored it
      // would fail verification for good and block every payment.
      const ck = v.envelope.header.ckpt;
      const headCkpt = ledger.records[ledger.head.seq]!.env.header.ckpt;
      if (ck < headCkpt) throw new Error(`record rejected: checkpoint ${ck} is earlier than the ledger head's ${headCkpt}; fetch the head and sign again`);
      if (ck > snap.ckpt + LEDGER_FUTURE_SLACK) throw new Error(`record rejected: checkpoint ${ck} is ahead of the chain (${snap.ckpt})`);
      if (ck + LEDGER_MAX_AGE < snap.ckpt) throw new Error(`record rejected: signed at checkpoint ${ck}, more than ${LEDGER_MAX_AGE} behind the chain (${snap.ckpt}); fetch the head and sign again`);
      const { blobId } = await this.d.mem.remember(text, NS_LEDGER, v.envelope.header.id);
      // Read back through recall and require byte-identical text before advancing.
      const back = await this.d.mem.recall(`antibody ledger record seq ${rec.seq}`, NS_LEDGER, 20);
      if (!back.some((m) => m.blobId === blobId && m.text === text)) throw new Error(`read-back of ledger seq ${rec.seq} (blob ${blobId}) did not return identical text`);
      this.cache.put([{ blobId, namespace: NS_LEDGER, text }]);
      const after = await this.snapshot(o);
      if (!after.ledger.ok || after.ledger.head.seq !== rec.seq) {
        throw new Error(`ledger did not verify after append: ${after.ledger.ok ? `head ${after.ledger.head.seq}` : after.ledger.code}`);
      }
      this.d.log.info('ledger.append', { seq: rec.seq, type: rec.type, blobId, envelopeId: v.envelope.header.id });
      return { seq: rec.seq, blobId, envelopeId: v.envelope.header.id };
    }
  }

  /**
   * Write genesis (seq 0). Allowed only when the ledger namespace is empty.
   * Names the account, owner, network and the four lane keys on-chain now.
   */
  async writeGenesis(network: string): Promise<{ seq: number; blobId: string; envelopeId: string }> {
    return withFileLock(join(this.d.home, 'run', 'ledger.lock'), async () => {
      const snap = await this.snapshot();
      if (snap.ledger.ok) throw new Error('ledger already has a genesis record');
      if (snap.ledger.code !== 'LEDGER_EMPTY') throw new Error(`ledger is not empty: ${snap.ledger.code} ${snap.ledger.detail}`);
      // B11: an empty listing after this machine has already verified a ledger is a relayer problem, not a new account.
      const seen = this.hwm.read();
      if (seen) throw new Error(`this machine has verified ledger head #${seen.seq} before; refusing to write a second genesis on an empty listing (run antibody restore-index)`);
      const lanes = (['user', 'agent', 'wallet-objects', 'antibody'] as const).map((lane) => {
        const k = snap.account.delegateKeys.filter((x) => x.label === LANE_LABEL[lane]);
        if (k.length !== 1) throw new Error(`lane ${lane} needs exactly one key on-chain before genesis (found ${k.length})`);
        return { lane, label: LANE_LABEL[lane], pub: k[0]!.publicKeyHex };
      });
      if (lanes.find((l) => l.lane === 'antibody')!.pub !== this.d.key.publicKeyHex) throw new Error('control key is not the antibody:control key on-chain');
      const record: LedgerRecord<'genesis'> = { seq: 0, prev: GENESIS_PREV, type: 'genesis', payload: { account: this.d.acct, owner: normalizeSuiAddress(snap.account.owner), network, ckpt: snap.ckpt, lanes } };
      const env = buildEnvelope({ id: uuidv7(this.now()), acct: this.d.acct, ns: NS_LEDGER, lane: 'antibody', kind: 'ledger', ckpt: snap.ckpt, ts: new Date(this.now()).toISOString(), text: ledgerBodyText(record) }, this.d.key);
      const { blobId } = await this.d.mem.remember(env.text, NS_LEDGER, env.header.id);
      const back = await this.d.mem.recall('antibody ledger record seq 0', NS_LEDGER, 20);
      if (!back.some((m) => m.blobId === blobId && m.text === env.text)) throw new Error('read-back of genesis did not return identical text');
      this.cache.put([{ blobId, namespace: NS_LEDGER, text: env.text }]);
      const after = await this.snapshot();
      if (!after.ledger.ok) throw new Error(`ledger did not verify after genesis: ${after.ledger.code} ${after.ledger.detail}`);
      this.hwm.acknowledge(after.ledger.head); // this machine wrote genesis itself: nothing to take on trust
      this.d.log.info('ledger.genesis', { blobId, envelopeId: env.header.id });
      return { seq: 0, blobId, envelopeId: env.header.id };
    });
  }

  /** Build, sign (antibody lane) and append a control record. */
  async writeOwn<T extends LedgerType>(type: T, payload: LedgerPayload<T>, o: Parameters<Control['snapshot']>[0] = {}): Promise<{ seq: number; blobId: string; envelopeId: string }> {
    if (LEDGER_SIGNER[type] !== 'antibody') throw new Error(`control may not sign ${type}`);
    // B11: read the head and append under one lock, so a concurrent append cannot make this stale.
    return withFileLock(join(this.d.home, 'run', 'ledger.lock'), async () => {
      const h = await this.head(o);
      const record = { seq: h.seq, prev: h.prev, type, payload } as LedgerRecord;
      const env = buildEnvelope({ id: uuidv7(this.now()), acct: this.d.acct, ns: NS_LEDGER, lane: 'antibody', kind: 'ledger', ckpt: h.ckpt, ts: new Date(this.now()).toISOString(), text: ledgerBodyText(record) }, this.d.key);
      return this.appendLocked(env.text, o);
    });
  }

  // ---- model context -----------------------------------------------------

  /**
   * Recall for Steward: semantic recall, then only verified, unquarantined,
   * resolved memories, each labelled by trust class (spec §4 context labels).
   */
  async recallForAgent(query: string, limit = 12, turn?: string): Promise<ContextItem[]> {
    const snap = await this.snapshot();
    if (!snap.ledger.ok) {
      // I-7: quarantines are unknown without a verified ledger; give Steward nothing rather than poison.
      this.d.log.warn('context.refused', { query, ledger: snap.ledger.code });
      return [];
    }
    const hits = await this.d.mem.recall(query, NS_CONTENT, 50);
    const byBlob = new Map<string, string>();
    for (const n of snap.projection.lineage.nodes.values()) for (const b of n.blobIds) byBlob.set(b, n.id);
    const out: ContextItem[] = [];
    const seen = new Set<string>();
    for (const h of hits) {
      const id = byBlob.get(h.blobId);
      if (!id || seen.has(id)) continue;
      const n = snap.projection.lineage.nodes.get(id)!;
      if (!contextEligible(n)) continue;
      seen.add(id);
      out.push(toContextItem(n));
      if (out.length >= limit) break;
    }
    if (turn && UUID_RE.test(turn)) {
      const set = this.served.get(turn) ?? new Set<string>();
      for (const c of out) set.add(c.id);
      this.served.delete(turn);
      this.served.set(turn, set);
      while (this.served.size > 200) this.served.delete(this.served.keys().next().value!);
    }
    this.d.log.info('context.recall', { query, turn, returned: out.map((c) => c.id), digest: snap.projection.digest });
    return out;
  }

  // ---- payments ----------------------------------------------------------

  private async resolveAmount(p: ModelProposal, ledger: LedgerState | null): Promise<{ coinType: string; base: bigint; decimals: number }> {
    let coinType: string;
    if (p.coinType) coinType = normalizeCoinType(p.coinType);
    else {
      const payee = ledger?.payees.find((x) => isCanonicalSuiAddress(p.recipient) && x.address === p.recipient);
      coinType = payee?.coinType ?? SUI_COIN_TYPE;
    }
    const meta = await this.d.chain.getCoinMetadata(coinType);
    if (!meta) throw new Error(`no coin metadata for ${coinType}`);
    return { coinType, base: toBaseUnits(p.amount, meta.decimals), decimals: meta.decimals };
  }

  /**
   * Evaluate a proposal with the pure policy engine. Builds and dry-runs the
   * exact transfer only when R0–R4 pass. Never signs.
   */
  async evaluate(p: ModelProposal): Promise<{ verdict: Verdict; txBytes: Uint8Array | null; coinType: string | null; base: bigint | null; decimals: number | null; snap: Snapshot | null }> {
    let snap: Snapshot;
    try {
      snap = await this.snapshot();
    } catch (e) {
      // I-6: if chain reads or retrieval fail, the answer is a recorded BLOCK, not an exception.
      const detail = (e as Error).message;
      const verdict: Verdict = { decision: 'BLOCK', code: 'CHAIN_UNAVAILABLE', reasons: [`state could not be verified: ${detail}`], rules: [{ rule: 'R0', pass: false, detail }] };
      return { verdict, txBytes: null, coinType: null, base: null, decimals: null, snap: null };
    }
    const ledger = snap.ledger.ok ? snap.ledger : null;
    let coinType: string | null = null;
    let base: bigint | null = null;
    let decimals: number | null = null;
    let proposal: PaymentProposal;
    try {
      const r = await this.resolveAmount(p, ledger);
      ({ coinType, base, decimals } = r);
      proposal = { recipient: p.recipient.trim(), amount: r.base.toString(), coinType: r.coinType, ...(p.payeeLabel ? { payeeLabel: p.payeeLabel } : {}), reason: p.reason, ...(p.cites ? { cites: p.cites } : {}) };
    } catch (e) {
      // A malformed amount or coin type still gets a verdict (BAD_AMOUNT / ASSET_MISMATCH).
      proposal = { recipient: p.recipient.trim(), amount: '0', coinType: p.coinType ?? 'invalid', ...(p.payeeLabel ? { payeeLabel: p.payeeLabel } : {}), reason: `${p.reason} (${(e as Error).message})` };
    }
    let chain: ChainState = { ok: true, ckpt: snap.ckpt, sender: normalizeSuiAddress(this.d.wallet), maxGas: this.d.maxGasMist };
    if (snap.ledger.ok && !this.hwm.acknowledged()) {
      // S10: this machine learned the ledger head from the relayer alone (trust on first use).
      const detail = `first sync on this machine: confirm ledger head #${snap.ledger.head.seq} with \`antibody verify-ledger --accept\``;
      const verdict: Verdict = { decision: 'BLOCK', code: 'LEDGER_UNACKNOWLEDGED', reasons: [detail], rules: [{ rule: 'R0', pass: false, detail }] };
      return { verdict, txBytes: null, coinType, base, decimals, snap };
    }
    let verdict = evaluatePayment(proposal, snap.ledger, chain);
    let txBytes: Uint8Array | null = null;
    if (verdict.code === 'SIMULATION_MISMATCH' && verdict.rules.every((r) => r.rule === 'R5' || r.pass) && coinType && base !== null) {
      try {
        txBytes = await this.d.chain.buildTransfer({ sender: chain.sender, recipient: proposal.recipient, coinType, amount: base });
        chain = { ...chain, simulation: await this.d.chain.simulate(txBytes) };
      } catch (e) {
        chain = { ...chain, simulation: { ok: false, error: (e as Error).message, sender: chain.sender, balanceChanges: [], gasUsed: '0' } };
      }
      verdict = evaluatePayment(proposal, snap.ledger, chain);
      if (verdict.decision !== 'ALLOW') txBytes = null;
    }
    return { verdict, txBytes, coinType, base, decimals, snap };
  }

  /** One payment at a time in this process (B6): two proposals never race through policy and the signer. */
  private payChain: Promise<unknown> = Promise.resolve();
  private serialPayment<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.payChain.catch(() => undefined).then(fn);
    this.payChain = run.catch(() => undefined);
    return run;
  }

  /**
   * B6: refuse a payment that is a repeat of one pending, of unknown outcome, or
   * executed within the last 10 minutes (same recipient, coin and amount), or a
   * repeat inside the same turn. Returns the replacement verdict, or null.
   */
  private duplicateVerdict(turn: string, recipient: string, coinType: string, base: bigint, v: Verdict): { verdict: Verdict; key: string } {
    const key = sha256Hex(`${turn}|${recipient}|${coinType}|${base}`);
    const dup = this.payments.duplicate({ key, recipient, coinType, amount: base.toString() }, this.now(), DUPLICATE_WINDOW_MS);
    if (!dup) return { verdict: v, key };
    const why = dup.status === 'executed' ? `the same payment went out ${Math.round((this.now() - dup.at) / 1000)} s ago (tx ${dup.digest ?? '?'})` : `an identical payment is ${dup.status === 'pending' ? 'still in flight' : 'of unknown outcome; check the wallet before paying again'}`;
    return { key, verdict: { decision: 'BLOCK', code: 'DUPLICATE_PAYMENT', reasons: [why], rules: [...v.rules, { rule: 'R4', pass: false, detail: `duplicate: ${why}` }], ...(v.payeeId ? { payeeId: v.payeeId } : {}) } };
  }

  /** Poll for a transaction until it is readable or `ms` passes (a fresh digest is often not indexed yet). */
  private async waitForTx(digest: string, ms = TX_WAIT_MS): Promise<TxInfo | null> {
    const deadline = this.now() + ms;
    for (let delay = 250; ; delay = Math.min(delay * 2, 4000)) {
      const tx = await this.d.chain.getTransaction(digest).catch(() => null);
      if (tx || this.now() >= deadline) return tx;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  /** Did this transaction move exactly this payment out of Steward's wallet? */
  private credits(tx: TxInfo, e: Pick<PaymentEntry, 'recipient' | 'coinType' | 'amount'>): boolean {
    return tx.ok && tx.sender === normalizeSuiAddress(this.d.wallet) && tx.balanceChanges.some((b) => b.address === normalizeSuiAddress(e.recipient) && b.coinType === e.coinType && BigInt(b.amount) === BigInt(e.amount));
  }

  /**
   * B2: settle payments left pending or unknown (a crash mid-signing, a signer
   * timeout, a facilitator that answered before the chain did) by looking their
   * digest up on-chain. Found: executed or failed by what the chain shows.
   * Not found: left unknown for a human (`antibody payments resolve`), since a
   * signed transaction may still land.
   */
  async reconcilePayments(o: { waitMs?: number } = {}): Promise<{ key: string; digest?: string; status: PaymentEntry['status'] }[]> {
    const out: { key: string; digest?: string; status: PaymentEntry['status'] }[] = [];
    for (const e of this.payments.unresolved()) {
      if (!e.digest) {
        out.push({ key: e.key, status: e.status });
        continue;
      }
      const tx = o.waitMs ? await this.waitForTx(e.digest, o.waitMs) : await this.d.chain.getTransaction(e.digest).catch(() => null);
      if (!tx) {
        out.push({ key: e.key, digest: e.digest, status: e.status });
        continue;
      }
      const status = this.credits(tx, e) ? 'executed' : 'failed';
      this.payments.put({ ...e, status, resolvedBy: 'chain', ...(status === 'failed' ? { error: tx.error ?? 'on-chain effects do not show this transfer' } : {}) });
      this.d.log.info('payment.reconciled', { key: e.key, digest: e.digest, status });
      out.push({ key: e.key, digest: e.digest, status });
    }
    return out;
  }

  /** A human checked the wallet and settles an unknown payment (B2). */
  resolvePayment(keyOrDigest: string, status: 'executed' | 'failed'): PaymentEntry {
    const e = this.payments.find(keyOrDigest);
    if (e.status === 'executed' || e.status === 'failed') throw new Error(`payment ${e.key.slice(0, 12)} is already ${e.status}`);
    const next: PaymentEntry = { ...e, status, resolvedBy: 'human' };
    this.payments.put(next);
    this.d.log.info('payment.resolved', { key: e.key, digest: e.digest, status, by: 'human' });
    return next;
  }

  /** B4: store decisions a relayer failure left behind. Returns how many are still waiting. */
  async flushDecisions(): Promise<number> {
    for (const d of this.decisionOutbox.list()) {
      try {
        const { blobId } = await this.d.mem.remember(d.text, NS_CONTENT, d.id);
        this.cache.put([{ blobId, namespace: NS_CONTENT, text: d.text }]);
        this.decisionOutbox.remove(d.id);
        this.d.log.info('decision.flushed', { envelopeId: d.id, blobId });
      } catch (e) {
        this.d.log.warn('decision.outbox', { envelopeId: d.id, error: (e as Error).message });
      }
    }
    return this.decisionOutbox.list().length;
  }

  /** Before any payment: settle what can be settled, and refuse while a past decision is still unrecorded. */
  private async prePayment(): Promise<string | null> {
    if (this.payments.unresolved().length) await this.reconcilePayments().catch(() => undefined);
    const waiting = await this.flushDecisions();
    return waiting > 0 ? `${waiting} earlier decision record(s) are not stored on Walrus yet; no new payment until they are` : null;
  }

  /** propose_payment: evaluate, execute through the signer when allowed, record the decision (always, M8). */
  async propose(raw: { turn: string; readSet: string[]; proposal: ModelProposal; execute: boolean }): Promise<DecisionResult> {
    const args = proposeArgsSchema.parse(raw);
    return this.serialPayment(async () => {
      let ev = await this.evaluate(args.proposal);
      let txDigest: string | null = null;
      let executed = false;
      let error: string | null = null;
      const blocked = ev.verdict.decision === 'ALLOW' && ev.txBytes && args.execute ? await this.prePayment() : null;
      if (blocked) ev = { ...ev, verdict: { decision: 'BLOCK', code: 'LEDGER_UNVERIFIED', reasons: [blocked], rules: [...ev.verdict.rules, { rule: 'R0', pass: false, detail: blocked }], ...(ev.verdict.payeeId ? { payeeId: ev.verdict.payeeId } : {}) }, txBytes: null };
      if (ev.verdict.decision === 'ALLOW' && ev.txBytes && args.execute) {
        const recipient = args.proposal.recipient.trim();
        const d = this.duplicateVerdict(args.turn, recipient, ev.coinType!, ev.base!, ev.verdict);
        if (d.verdict.decision === 'BLOCK') ev = { ...ev, verdict: d.verdict, txBytes: null };
        else if (!this.d.signer) error = 'no signer configured';
        else {
          const expected = this.d.chain.txDigest?.(ev.txBytes);
          const entry = { key: d.key, turn: args.turn, recipient, coinType: ev.coinType!, amount: ev.base!.toString(), at: this.now(), ...(expected ? { digest: expected } : {}) };
          this.payments.put({ ...entry, status: 'pending' });
          try {
            const r = await this.d.signer.call<{ digest: string; tx: TxInfo }>('/sign', { mode: 'execute', txB64: toBase64(ev.txBytes), expect: { recipient, coinType: ev.coinType, amount: ev.base!.toString() } });
            txDigest = r.digest;
            executed = r.tx.ok;
            this.payments.put({ ...entry, status: executed ? 'executed' : 'failed', digest: r.digest, ...(r.tx.ok ? {} : { error: r.tx.error ?? 'failed on-chain' }) });
          } catch (e) {
            // The signer may have broadcast before failing: look the expected digest up before calling it unknown.
            error = `signer: ${(e as Error).message}`;
            this.payments.put({ ...entry, status: /signer refused/.test(error) ? 'failed' : 'unknown', error });
            if (!/signer refused/.test(error) && expected) {
              const [r] = (await this.reconcilePayments({ waitMs: 5_000 }).catch(() => [])).filter((x) => x.key === entry.key);
              if (r?.status === 'executed') {
                txDigest = expected;
                executed = true;
                error = null;
              }
            }
          }
        }
      }
      const dec = await this.writeDecision({ turn: args.turn, readSet: args.readSet, proposal: args.proposal, ev, txDigest, executed, channel: 'transfer', error });
      return { ...dec, verdict: dec.verdict ?? ev.verdict, amountBase: ev.base?.toString() ?? null, coinType: ev.coinType, decimals: ev.decimals, executed, txDigest, dryRunOnly: ev.verdict.decision === 'ALLOW' && !args.execute, simulated: this.d.simulated, ...(error ? { error } : {}) };
    });
  }

  /**
   * pay_x402: fetch the resource, turn its 402 requirements into a proposal,
   * evaluate it like any payment, sign (not execute) when allowed, and retry
   * with PAYMENT-SIGNATURE. The facilitator settles on Sui; the settlement is
   * confirmed on-chain before it counts. Only hosts on the operator's allowlist
   * (ANTIBODY_X402_ALLOW) are ever fetched (M3: no SSRF from the key holder).
   * The resource body and description are external content and never reach
   * the model or the decision text.
   */
  async payX402(raw: { turn: string; readSet: string[]; url: string; payeeLabel?: string; reason: string; execute?: boolean }): Promise<DecisionResult & { httpStatus: number; settlement: SettlementResponse | null }> {
    const args = x402ArgsSchema.parse(raw);
    return this.serialPayment(async () => {
      const u = new URL(args.url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('x402 URL must be http(s)');
      if (!(this.d.x402Allow ?? []).includes(u.host)) throw new Error(`x402 host ${u.host} is not on the allowlist (ANTIBODY_X402_ALLOW)`);
      const f = this.d.fetchImpl ?? fetch;
      const get = (headers?: Record<string, string>) => f(u.toString(), { redirect: 'error', signal: AbortSignal.timeout(15_000), ...(headers ? { headers } : {}) });
      const first = await get();
      await first.arrayBuffer().catch(() => undefined);
      if (first.status !== 402) throw new Error(`expected 402 Payment Required, got ${first.status}`);
      const header = first.headers.get(HDR_REQUIRED);
      if (!header) throw new Error(`402 without a ${HDR_REQUIRED} header`);
      const pr = decodeHeader(header, paymentRequiredSchema);
      const req = selectRequirement(pr, this.d.x402Network);
      if (!req) throw new Error(`no exact-scheme requirement for ${this.d.x402Network}`);
      if (!/^[1-9][0-9]{0,30}$/.test(req.amount)) throw new Error('x402 amount must be a positive integer without leading zeros');
      const coinType = normalizeCoinType(req.asset);
      const meta = await this.d.chain.getCoinMetadata(coinType);
      if (!meta) throw new Error('the bill names a coin type with no metadata on-chain');
      const proposal: ModelProposal = { recipient: req.payTo, amount: formatUnits(req.amount, meta.decimals), coinType, ...(args.payeeLabel ? { payeeLabel: args.payeeLabel } : {}), reason: `${args.reason} (x402 bill at ${u.host}${u.pathname})` };
      let ev = await this.evaluate(proposal);
      let settlement: SettlementResponse | null = null;
      let httpStatus = 402;
      let txDigest: string | null = null;
      let executed = false;
      let error: string | null = null;
      // B3: dry-run mode (execute off) evaluates the bill and stops before anything is signed.
      const blocked = ev.verdict.decision === 'ALLOW' && ev.txBytes && args.execute ? await this.prePayment() : null;
      if (blocked) ev = { ...ev, verdict: { decision: 'BLOCK', code: 'LEDGER_UNVERIFIED', reasons: [blocked], rules: [...ev.verdict.rules, { rule: 'R0', pass: false, detail: blocked }], ...(ev.verdict.payeeId ? { payeeId: ev.verdict.payeeId } : {}) }, txBytes: null };
      if (ev.verdict.decision === 'ALLOW' && ev.txBytes && args.execute) {
        const d = this.duplicateVerdict(args.turn, req.payTo, coinType, BigInt(req.amount), ev.verdict);
        if (d.verdict.decision === 'BLOCK') ev = { ...ev, verdict: d.verdict, txBytes: null };
        else if (!this.d.signer) error = 'no signer configured';
        else {
          const expected = this.d.chain.txDigest?.(ev.txBytes);
          const entry = { key: d.key, turn: args.turn, recipient: req.payTo, coinType, amount: req.amount, at: this.now(), ...(expected ? { digest: expected } : {}) };
          this.payments.put({ ...entry, status: 'pending' });
          try {
            const s = await this.d.signer.call<{ signature: string }>('/sign', { mode: 'sign', txB64: toBase64(ev.txBytes), expect: { recipient: req.payTo, coinType, amount: req.amount } });
            const payload: PaymentPayload = { x402Version: 2, resource: pr.resource, accepted: req, payload: { signature: s.signature, transaction: toBase64(ev.txBytes) } };
            const second = await get({ [HDR_SIGNATURE]: encodeHeader(payload) });
            httpStatus = second.status;
            await second.arrayBuffer().catch(() => undefined); // drain; the body is never shown to the model
            const rh = second.headers.get(HDR_RESPONSE);
            settlement = rh ? decodeHeader(rh, settlementResponseSchema) : null;
            if (settlement?.success) {
              // B7: the facilitator's word is not enough: the digest must show this exact transfer on-chain.
              // B2: the facilitator may answer before the transaction is readable, so wait for it.
              if (expected && settlement.transaction !== expected) error = `facilitator reported settlement ${settlement.transaction}, but the signed transaction is ${expected}`;
              else {
                const tx = await this.waitForTx(settlement.transaction);
                if (tx && this.credits(tx, entry)) {
                  txDigest = settlement.transaction;
                  executed = true;
                } else error = `facilitator reported settlement ${settlement.transaction}, but ${tx ? 'it does not show this transfer' : 'it is not on-chain yet'}`;
              }
            } else error = `settlement failed (HTTP ${httpStatus})`;
            // Not settled yet is unknown, not failed: the signed transaction may still land (reconciled before the next payment).
            this.payments.put({ ...entry, status: executed ? 'executed' : 'unknown', ...(txDigest ? { digest: txDigest } : {}), ...(error ? { error } : {}) });
          } catch (e) {
            error = `x402: ${(e as Error).message}`;
            this.payments.put({ ...entry, status: /signer refused/.test(error) ? 'failed' : 'unknown', error });
          }
        }
      }
      const dec = await this.writeDecision({ turn: args.turn, readSet: args.readSet, proposal, ev, txDigest, executed, channel: `x402 ${u.host}${u.pathname}`, error });
      return { ...dec, verdict: dec.verdict ?? ev.verdict, amountBase: ev.base?.toString() ?? null, coinType: ev.coinType, decimals: ev.decimals, executed, txDigest, dryRunOnly: ev.verdict.decision === 'ALLOW' && !args.execute, simulated: this.d.simulated, httpStatus, settlement, ...(error ? { error } : {}) };
    });
  }

  /**
   * Decision record (lane antibody, kind decision, namespace steward.mem):
   * parents are the turn's readSet, so decisions are nodes in the blast radius.
   */
  private async writeDecision(a: {
    turn: string;
    readSet: string[];
    proposal: ModelProposal;
    ev: { verdict: Verdict; coinType: string | null; base: bigint | null; decimals: number | null; snap: Snapshot | null };
    txDigest: string | null;
    executed: boolean;
    channel: string;
    error?: string | null;
  }): Promise<{ decisionId: string; decisionBlobId: string; verdict?: Verdict }> {
    let v = a.ev.verdict;
    // M6: the parents are what control itself served this turn, not what the agent says it read.
    const served = this.served.get(a.turn);
    const ids = [...new Set([...(served ?? []), ...a.readSet].filter((id) => UUID_RE.test(id)))];
    let parents = ids.sort();
    if (parents.length > MAX_DECISION_PARENTS) {
      // Never drop lineage silently: keep the least trusted parents (taint wins) and refuse to pay.
      const rank = (id: string) => ({ unverified: 0, untrusted: 1, derived: 2, trusted: 3 })[this.last?.projection.lineage.nodes.get(id)?.cls ?? 'unverified'];
      parents = [...parents].sort((x, y) => rank(x) - rank(y) || x.localeCompare(y)).slice(0, MAX_DECISION_PARENTS).sort();
      if (v.decision === 'ALLOW' && !a.txDigest) v = { decision: 'BLOCK', code: 'LEDGER_UNVERIFIED', reasons: [`this turn read ${ids.length} memories; a decision can cite at most ${MAX_DECISION_PARENTS}, so its lineage would be incomplete`], rules: [...v.rules, { rule: 'R0', pass: false, detail: 'lineage too large to record' }], ...(v.payeeId ? { payeeId: v.payeeId } : {}) };
    }
    const amount = a.ev.base !== null && a.ev.decimals !== null ? `${formatUnits(a.ev.base, a.ev.decimals)} (${a.ev.base} base units)` : a.proposal.amount;
    const lines = [
      `Payment decision: ${v.decision}${v.code === 'OK' ? '' : ` ${v.code}`}`,
      // S4: everything the model chose is quoted (JSON), so it reads as data and cannot forge lines.
      `Proposal (${a.channel}): pay ${a.ev.base !== null ? amount : JSON.stringify(amount)} of ${a.ev.coinType ?? JSON.stringify(a.proposal.coinType ?? '?')} to ${JSON.stringify(a.proposal.recipient)}${a.proposal.payeeLabel ? ` labelled ${JSON.stringify(a.proposal.payeeLabel)}` : ''}`,
      `Model's reason: ${JSON.stringify(a.proposal.reason.slice(0, 300))}`,
      `Verdict: ${oneLine(v.reasons.join('; '))}`,
      `Rules: ${v.rules.map((r) => `${r.rule} ${r.pass ? 'pass' : 'FAIL'} (${oneLine(r.detail)})`).join(' | ')}`,
      `Ledger head: ${!a.ev.snap ? 'unavailable' : a.ev.snap.ledger.ok ? `#${a.ev.snap.ledger.head.seq}` : a.ev.snap.ledger.code}; checkpoint ${a.ev.snap?.ckpt ?? 'unavailable'}; turn ${a.turn}`,
      a.proposal.cites?.length ? `Model citations (display only, never policy input): ${JSON.stringify(a.proposal.cites)}` : 'Model citations: none',
      a.txDigest ? `Transaction: ${a.txDigest} (${a.executed ? 'executed' : 'not executed'})` : a.error ? `Transaction: outcome ${/refused/.test(a.error) ? 'refused' : 'unknown'} (${oneLine(a.error.slice(0, 200))})` : v.decision === 'ALLOW' ? 'Transaction: none (dry-run only)' : 'Transaction: none (blocked, nothing signed)',
    ];
    const id = uuidv7(this.now());
    const src = a.txDigest ? [{ t: 'tx', digest: a.txDigest }] : [];
    const ckpt = await this.d.chain.latestCheckpoint().catch(() => a.ev.snap?.ckpt ?? 0);
    const env = buildEnvelope({ id, acct: this.d.acct, ns: NS_CONTENT, lane: 'antibody', kind: 'decision', parents, src, turn: a.turn, ckpt, ts: new Date(this.now()).toISOString(), text: lines.join('\n') }, this.d.key);
    // B4: kept locally first, so a relayer failure after a payment went out never loses its decision.
    this.decisionOutbox.add({ id, text: env.text, at: this.now() });
    let blobId = 'pending';
    try {
      blobId = (await this.d.mem.remember(env.text, NS_CONTENT, id)).blobId;
      this.decisionOutbox.remove(id);
      this.cache.put([{ blobId, namespace: NS_CONTENT, text: env.text }]);
    } catch (e) {
      if (!a.txDigest && !a.error) {
        this.decisionOutbox.remove(id); // nothing was signed: an unrecorded refusal needs no retry
        throw e;
      }
      this.d.log.warn('decision.outbox', { envelopeId: id, error: (e as Error).message });
      this.d.alert?.({ kind: 'ledger-unverified', severity: 'critical', key: `decision:${id}`, title: 'a payment decision could not be stored yet', text: `Decision ${id} (tx ${a.txDigest ?? 'unknown'}) is queued locally and retried before the next payment: ${(e as Error).message}`.slice(0, 500), data: { decisionId: id } });
    }
    this.d.log.info('decision', { envelopeId: id, blobId, verdict: v.decision, code: v.code, txDigest: a.txDigest, turn: a.turn });
    if (v.decision === 'BLOCK') this.d.alert?.({ kind: 'payment-blocked', severity: 'warning', key: `block:${id}`, title: `payment blocked (${v.code})`, text: `${a.proposal.amount} to ${a.proposal.recipient}: ${v.reasons.join('; ').slice(0, 400)}`, data: { decisionId: id, code: v.code, turn: a.turn } });
    return { decisionId: id, decisionBlobId: blobId, verdict: v };
  }

  // ---- quarantine, lessons, blast radius ---------------------------------

  /** Closure preview of a seed before it is written (spec §9 step 2). */
  async preview(seed: QuarantineSeed): Promise<{ memories: number; decisions: number; txDigests: string[]; radius: BlastRadius }> {
    const snap = await this.snapshot();
    const s = normalizeSeed(seed);
    const verified: VerifiedInput[] = [...snap.projection.lineage.nodes.values()].map((n) => ({ env: n.env, blobId: n.blobIds[0]! }));
    const lin = computeLineage(verified, [], [{ seed: s, seq: -1 }]);
    const radius = blastRadius(lin, -1, s);
    return { memories: radius.memories.length, decisions: radius.decisions.length, txDigests: radius.txDigests, radius };
  }

  /**
   * Write a quarantine record, then learn from it: derive a lesson from the
   * observations it excluded and append it to the ledger.
   */
  async quarantine(seed: QuarantineSeed, reason: string, evidence: string[], auto: boolean): Promise<{ seq: number; lessonSeq: number | null; radius: BlastRadius }> {
    const s = normalizeSeed(seed);
    const { ledger } = await this.verifiedLedger();
    if (activeSeeds(ledger).some((a) => seedKey(a.seed) === seedKey(s))) throw new Error(`seed ${seedKey(s)} is already quarantined`);
    const ckpt = await this.d.chain.latestCheckpoint();
    const { seq } = await this.writeOwn('quarantine', { seed: { type: s.type, value: s.value, ...(s.from !== undefined ? { from: s.from } : {}), ...(s.to !== undefined ? { to: s.to } : {}) }, reason: reason.slice(0, 512), evidence: evidence.slice(0, 32), ckpt, auto });
    const snap = await this.snapshot();
    const radius = blastRadius(snap.projection.lineage, seq, s);
    let lessonSeq: number | null = null;
    const lesson = deriveLesson(seq, radius.memories, reason);
    if (lesson && snap.ledger.ok) {
      // Skip lessons that teach nothing new.
      const known = snap.ledger.lessons.filter((l) => l.active);
      const novel =
        lesson.indicators.senders.some((x) => !known.some((k) => k.indicators.senders.includes(x))) ||
        lesson.indicators.coinTypes.some((x) => !known.some((k) => k.indicators.coinTypes.includes(x))) ||
        lesson.indicators.packages.some((x) => !known.some((k) => k.indicators.packages.includes(x)));
      if (novel) lessonSeq = (await this.writeOwn('lesson', lesson)).seq;
    }
    this.d.log.info('quarantine', { seq, seed: seedKey(s), memories: radius.memories.map((m) => m.id), decisions: radius.decisions.map((m) => m.id), lessonSeq, auto });
    this.d.alert?.({ kind: auto ? 'auto-quarantine' : 'quarantine', severity: auto ? 'critical' : 'warning', key: `q:${seq}`, title: `${auto ? 'auto-' : ''}quarantined ${s.type} ${s.value.slice(0, 24)} (ledger #${seq})`, text: `${reason.slice(0, 300)}\n${radius.memories.length} memories and ${radius.decisions.length} decisions left Steward's context.${lessonSeq !== null ? ` Learned lesson #${lessonSeq}.` : ''}`, data: { seq, seed: s, lessonSeq } });
    for (const i of this.incidents.list()) {
      if (i.status === 'open' && s.type === 'source' && i.objectId === s.value) this.incidents.upsert({ ...i, status: auto ? 'auto-quarantined' : 'quarantined', quarantineSeq: seq });
    }
    return { seq, lessonSeq, radius };
  }

  async blast(seq: number): Promise<BlastRadius> {
    const snap = await this.snapshot();
    if (!snap.ledger.ok) throw new Error(`ledger not verified: ${snap.ledger.code}`);
    const q = snap.ledger.quarantines.find((x) => x.seq === seq);
    if (!q) throw new Error(`ledger #${seq} is not a quarantine record`);
    return blastRadius(snap.projection.lineage, seq, q.seed);
  }

  /** Active lessons for the sentinel (wallet-objects lane may read these). */
  async lessons() {
    const { ledger } = await this.verifiedLedger();
    return ledger.lessons;
  }

  /**
   * An incident from the sentinel. Auto-quarantine (spec §9) only for a
   * Guardians blocklist hit or a strong match against a learned lesson;
   * releasing always needs a human user signature.
   */
  async incident(raw: unknown): Promise<Incident> {
    // S2: the wallet-objects lane is untrusted. Its payload is validated, tied to a verified
    // observation it actually wrote, and every auto-quarantine input is recomputed here.
    const parsed = incidentSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`incident rejected: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
    const i = parsed.data;
    if (i.proposedSeed.value !== i.objectId) throw new Error('incident rejected: the proposed seed must be the observed object itself');
    const snap = await this.snapshot();
    const obs = i.observationId ? snap.projection.lineage.nodes.get(i.observationId) : undefined;
    const h = obs?.env.header;
    if (!obs || !h || h.lane !== 'wallet-objects' || h.kind !== 'observation' || !h.src.some((r) => srcIdentifiers(r).includes(normalizeIdentifierSafe(i.objectId)))) {
      throw new Error('incident rejected: it does not cite a verified wallet-objects observation of that object');
    }
    // S2: the object must really be in Steward's wallet: the ingest key cannot invent one.
    const owned = await this.d.chain.listOwnedObjects(this.d.wallet);
    if (!owned.some((o) => normalizeIdentifierSafe(o.objectId) === i.objectId)) throw new Error(`incident rejected: ${i.objectId} is not an object in Steward's wallet`);
    const sender = h.src.find((r) => r.t === 'sender')?.addr;
    const coinType = h.src.find((r) => r.t === 'coin-type')?.type;
    const objectType = h.src.find((r) => r.t === 'sui-object')?.type;
    const text = bodyContent(obs.env.body);
    const lessons = snap.ledger.ok ? snap.ledger.lessons : [];
    const lm = matchLessons({ ...(sender ? { sender } : {}), ...(coinType ? { coinType } : {}), ...(objectType ? { objectType } : {}), text }, lessons);
    const guardians = this.d.guardians ? await this.d.guardians().catch(() => null) : null;
    const isBlocked = !!guardians && blocklisted(guardians, coinType ?? objectType ?? '');
    const score = isBlocked ? 1 : 1 - (1 - scoreText(text).score) * (1 - lm.score);
    const inc: Incident = {
      ...i,
      score: Math.round(score * 1000) / 1000,
      blocklisted: isBlocked,
      lessonMatches: lm.matches.map((m) => ({ lessonSeq: m.lessonSeq, indicator: m.indicator, value: m.value })),
      ...(sender ? { sender } : {}),
      id: `inc-${this.now().toString(36)}-${i.objectId.replace(/^0x/, '').slice(0, 8)}`,
      at: new Date(this.now()).toISOString(),
      status: 'open',
    };
    this.incidents.upsert(inc);
    const strong = lm.matches.filter((m) => m.indicator !== 'keywords');
    if (isBlocked || (strong.length > 0 && score >= this.d.autoQuarantineScore)) {
      if (obs.quarantined) {
        // S4: an existing seed (e.g. this sender) already covers it: no new ledger record.
        inc.status = 'auto-quarantined';
        inc.quarantineSeq = obs.seedHits[0];
        this.incidents.upsert(inc);
      } else if (this.autoQuarantineBudget(snap)) {
        // S4: one record per attacker, not per object: a matched sender is quarantined as a whole.
        const bySender = strong.find((m) => m.indicator === 'sender');
        const seed = { type: 'source' as const, value: bySender ? bySender.value : i.objectId };
        const why = isBlocked
          ? `auto: ${coinType ?? objectType ?? i.objectId} is on the Sui Guardians blocklist`
          : `auto: matches lesson(s) ${[...new Set(strong.map((m) => `#${m.lessonSeq}`))].join(', ')} learned from an earlier quarantine (${strong.map((m) => `${m.indicator} ${m.value.slice(0, 20)}`).join('; ')})${bySender ? '; quarantining that sender as a whole' : ''}`;
        try {
          const q = await this.quarantine(seed, why, [i.objectId, ...(i.observationId ? [i.observationId] : [])], true);
          inc.status = 'auto-quarantined';
          inc.quarantineSeq = q.seq;
          this.incidents.upsert(inc);
        } catch (e) {
          this.d.log.warn('incident.auto_quarantine_failed', { id: inc.id, error: (e as Error).message });
        }
      }
    }
    this.d.log.info('incident', { id: inc.id, objectId: inc.objectId, score: inc.score, status: inc.status });
    if (inc.status === 'open') this.d.alert?.({ kind: 'incident', severity: 'warning', key: `inc:${inc.objectId}`, title: `suspicious object in Steward's wallet (score ${inc.score.toFixed(2)})`, text: `${inc.objectId}\n${inc.rules.join(' · ').slice(0, 300)}\nReview it in the console: Incidents.`, data: { id: inc.id, objectId: inc.objectId, score: inc.score } });
    return inc;
  }

  private autoTimes: number[] = [];

  /**
   * S4: auto-quarantines are capped per hour and stop well before the ledger cap,
   * so an attacker flooding the wallet can never fill the ledger and lock out the
   * human's own records (payee removal, release, revoke).
   */
  private autoQuarantineBudget(snap: Snapshot): boolean {
    const now = this.now();
    this.autoTimes = this.autoTimes.filter((t) => now - t < 3_600_000);
    const head = snap.ledger.ok ? snap.ledger.head.seq : LEDGER_CAP;
    if (this.autoTimes.length >= AUTO_QUARANTINE_PER_HOUR || head >= LEDGER_CAP - LEDGER_USER_RESERVE) {
      this.d.log.warn('incident.auto_quarantine_budget', { head, lastHour: this.autoTimes.length });
      this.d.alert?.({ kind: 'incident', severity: 'critical', key: 'auto-budget', title: 'auto-quarantine paused: too many incidents', text: `${this.autoTimes.length} automatic quarantines in the last hour (ledger head #${head}). New incidents stay open for you to review.` });
      return false;
    }
    this.autoTimes.push(now);
    return true;
  }

  // ---- revocation ----------------------------------------------------------

  /**
   * After the owner removed a delegate key on-chain: verify it is gone and
   * write lane.revoke (spec §9). Quarantine is untouched (I-9).
   */
  async recordRevoke(pub: string, lane: Lane, digest: string): Promise<{ seq: number }> {
    const account = await this.d.chain.getAccount(this.d.acct);
    if (account.delegateKeys.some((k) => k.publicKeyHex === pub)) throw new Error('key is still in delegate_keys on-chain; revocation not confirmed');
    const tx = await this.ownerTx(digest, account.owner, 'remove_delegate_key', pub);
    // M7: bound the key at the removal's own checkpoint, not "now" (which would widen its window).
    const ckpt = tx.checkpoint ?? (await this.d.chain.latestCheckpoint());
    // The key's earlier records stay valid only once this revoke exists, so append it under that assumption.
    return this.writeOwn('lane.revoke', { pub, label: LANE_LABEL[lane], digest, ckpt }, { assumeRevoked: [{ pub, lane, ckpt }] });
  }

  async recordRotate(pub: string, lane: Lane, digest: string): Promise<{ seq: number }> {
    const account = await this.d.chain.getAccount(this.d.acct);
    const k = account.delegateKeys.find((x) => x.publicKeyHex === pub);
    if (!k || k.label !== LANE_LABEL[lane]) throw new Error(`new key is not on-chain with label ${LANE_LABEL[lane]}`);
    const tx = await this.ownerTx(digest, account.owner, 'add_delegate_key', pub);
    return this.writeOwn('lane.rotate', { pub, label: LANE_LABEL[lane], digest, ckpt: tx.checkpoint ?? (await this.d.chain.latestCheckpoint()) });
  }

  /** M7: the digest must be a successful transaction sent by the account owner. */
  /**
   * S5: and it must be the call being recorded: account::<what> on this
   * account, naming this key. A reader that cannot show the transaction's
   * contents, or a missing sender, fails closed.
   */
  private async ownerTx(digest: string, owner: string, what: 'add_delegate_key' | 'remove_delegate_key', pub: string): Promise<TxInfo> {
    const tx = await this.waitForTx(digest, 10_000);
    if (!tx || !tx.ok) throw new Error(`${what} transaction ${digest} not found or failed`);
    if (!tx.sender || normalizeSuiAddress(tx.sender) !== normalizeSuiAddress(owner)) throw new Error(`${what} transaction ${digest} was not sent by the account owner`);
    if (!tx.moveCalls || !tx.objectInputs || !tx.pureInputsHex) throw new Error(`cannot read what transaction ${digest} did; refusing to record it`);
    if (!tx.moveCalls.includes(`account::${what}`)) throw new Error(`transaction ${digest} does not call account::${what}`);
    if (!tx.objectInputs.includes(normalizeSuiAddress(this.d.acct))) throw new Error(`transaction ${digest} does not act on this account`);
    if (!tx.pureInputsHex.some((h) => h.toLowerCase().includes(pub.toLowerCase()))) throw new Error(`transaction ${digest} does not name key ${pub.slice(0, 12)}…`);
    return tx;
  }

  // ---- reporting -----------------------------------------------------------

  /** Incident report JSON, published through the Tatum Storage API (FR-14). */
  async report(seq: number) {
    const snap = await this.snapshot();
    if (!snap.ledger.ok) throw new Error(`ledger not verified: ${snap.ledger.code}`);
    const q = snap.ledger.quarantines.find((x) => x.seq === seq);
    if (!q) throw new Error(`ledger #${seq} is not a quarantine record`);
    const radius = blastRadius(snap.projection.lineage, seq, q.seed);
    const rec = snap.ledger.records[seq]!;
    const report = {
      kind: 'antibody.incident-report/v1',
      account: this.d.acct,
      generatedAt: new Date(this.now()).toISOString(),
      simulated: this.d.simulated,
      quarantine: { seq, seed: q.seed, reason: q.reason, evidence: q.evidence, auto: q.auto, released: q.released, ledgerBlobIds: rec.blobIds, envelopeId: rec.env.header.id },
      blastRadius: {
        sources: radius.sources,
        // S9: reports are public on Walrus. Only external (wallet-objects) text — the poison itself — is published verbatim;
        // the user's own statements, notes and decisions are redacted to their size.
        memories: radius.memories.map((m) => ({ id: m.id, blobIds: m.blobIds, lane: m.env.header.lane, kind: m.env.header.kind, cls: m.cls, text: m.env.header.lane === 'wallet-objects' ? bodyContent(m.env.body) : `[redacted: ${bodyContent(m.env.body).length} characters of ${m.env.header.lane} ${m.env.header.kind}]` })),
        decisions: radius.decisions.map((m) => m.id),
        txDigests: radius.txDigests,
        edges: radius.edges,
      },
      lessons: snap.ledger.lessons.filter((l) => l.fromSeq === seq),
      ledgerHead: snap.ledger.head,
      projectionDigest: snap.projection.digest,
    };
    const up = await this.d.reports.upload(`antibody-incident-${seq}.json`, report);
    for (const i of this.incidents.list()) if (i.quarantineSeq === seq) this.incidents.upsert({ ...i, report: { url: up.url, blobId: up.blobId, simulated: up.simulated } });
    this.reportLog.add({ seq, url: up.url, blobId: up.blobId, jobId: up.jobId, status: up.status, filename: up.filename, sizeBytes: up.sizeBytes, simulated: up.simulated, at: this.now() });
    this.d.log.info('report.upload', { seq, blobId: up.blobId, url: up.url, simulated: up.simulated });
    return { report, upload: up };
  }

}

export { fromBase64 };
