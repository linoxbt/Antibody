/**
 * Antibody control (spec §3): holds the antibody key and the Tatum key.
 * Verifies, computes lineage and the projection, keeps the ledger, runs the
 * policy engine, asks the signer to execute ALLOWed payments, and writes
 * decision records. Never holds the owner or wallet key.
 */
import { join } from 'node:path';
import { bodyContent, buildEnvelope, parseEnvelope } from '../core/envelope.ts';
import { fromBase64, isCanonicalSuiAddress, normalizeCoinType, normalizeSuiAddress, SUI_COIN_TYPE, toBase64, uuidv7, UUID_RE } from '../core/encoding.ts';
import type { LaneKey } from '../core/keys.ts';
import type { AccountState } from '../core/lanes.ts';
import {
  activeSeeds,
  GENESIS_PREV,
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
import { blastRadius, computeLineage, type BlastRadius, type VerifiedInput } from '../core/lineage.ts';
import { evaluatePayment, type ChainState, type PaymentProposal, type Verdict } from '../core/policy.ts';
import { buildProjection, contextEligible, toContextItem, type ContextItem, type Projection } from '../core/projection.ts';
import { normalizeSeed, seedKey } from '../core/seeds.ts';
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
import { decodeHeader, encodeHeader, HDR_REQUIRED, HDR_RESPONSE, HDR_SIGNATURE, paymentRequiredSchema, selectRequirement, type PaymentPayload, type SettlementResponse } from '../payments/x402.ts';
import { retrieveContent, retrieveLedger } from './retrieve.ts';
import { HighWaterMark, IncidentStore, ReportLog, TextCache, type Incident } from './store.ts';

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
  private readonly now: () => number;
  private last: Snapshot | null = null;

  constructor(readonly d: ControlDeps) {
    this.cache = new TextCache(d.cacheDir);
    this.hwm = new HighWaterMark(join(d.home, 'hwm.json'));
    this.incidents = new IncidentStore(d.cacheDir);
    this.reportLog = new ReportLog(d.cacheDir);
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
  async snapshot(): Promise<Snapshot> {
    const [account, ckpt] = await Promise.all([this.d.chain.getAccount(this.d.acct), this.d.chain.latestCheckpoint()]);
    const known = this.d.noCache ? new Map<string, StoredMemory>() : this.cache.all();
    const led = await retrieveLedger(this.d.mem, known);
    const ledger = verifyLedger({ acct: this.d.acct, account, inventory: led.inventory.map((e) => e.blobId), recalled: led.memories, hwm: this.hwm.read() });
    const content = await retrieveContent(this.d.mem, known);
    if (!this.d.noCache) this.cache.put([...led.memories, ...content.memories]);
    const projection = buildProjection({ acct: this.d.acct, ledger, content: content.memories, contentInventory: content.inventory.map((e) => e.blobId) });
    if (ledger.ok) this.hwm.advance(ledger.head);
    else {
      this.d.log.warn('ledger.unverified', { code: ledger.code, detail: ledger.detail });
      this.d.alert?.({ kind: 'ledger-unverified', severity: 'critical', key: `ledger:${ledger.code}`, title: `ledger ${ledger.code}: every payment is blocked`, text: ledger.detail, data: { code: ledger.code } });
    }
    const snap: Snapshot = { account, ckpt, ledger, projection, coverage: { ledgerMissing: led.missing, contentMissing: content.missing, queries: led.queries + content.queries } };
    this.last = snap;
    return snap;
  }

  private async verifiedLedger(): Promise<{ snap: Snapshot; ledger: LedgerState }> {
    const snap = await this.snapshot();
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
  async head(): Promise<{ seq: number; prev: string; ckpt: number; acct: string }> {
    const { snap, ledger } = await this.verifiedLedger();
    return { ...nextAppend(ledger), ckpt: snap.ckpt, acct: this.d.acct };
  }

  /**
   * Append a signed ledger record (from the user CLI or from control itself):
   * verify it, store it with rememberAndWait, read it back by recall, verify
   * the whole ledger again, and only then advance the head.
   */
  async appendLedger(text: string): Promise<{ seq: number; blobId: string; envelopeId: string }> {
    return withFileLock(join(this.d.home, 'run', 'ledger.lock'), async () => {
      const { ledger } = await this.verifiedLedger();
      const v = verifyEnvelope(text, { acct: this.d.acct, ns: NS_LEDGER, bindings: ledger.bindings });
      if (!v.ok) throw new Error(`record rejected: ${v.code} ${v.reason}`);
      const rec = parseLedgerBody(bodyContent(v.envelope.body));
      if (v.envelope.header.lane !== LEDGER_SIGNER[rec.type]) throw new Error(`${rec.type} must be signed by the ${LEDGER_SIGNER[rec.type]} lane`);
      const expect = nextAppend(ledger);
      if (rec.seq !== expect.seq || rec.prev !== expect.prev) throw new Error(`stale head: record is seq ${rec.seq}, ledger expects ${expect.seq}; fetch the head and sign again`);
      const { blobId } = await this.d.mem.remember(text, NS_LEDGER, v.envelope.header.id);
      // Read back through recall and require byte-identical text before advancing.
      const back = await this.d.mem.recall(`antibody ledger record seq ${rec.seq}`, NS_LEDGER, 20);
      if (!back.some((m) => m.blobId === blobId && m.text === text)) throw new Error(`read-back of ledger seq ${rec.seq} (blob ${blobId}) did not return identical text`);
      this.cache.put([{ blobId, namespace: NS_LEDGER, text }]);
      const after = await this.snapshot();
      if (!after.ledger.ok || after.ledger.head.seq !== rec.seq) {
        throw new Error(`ledger did not verify after append: ${after.ledger.ok ? `head ${after.ledger.head.seq}` : after.ledger.code}`);
      }
      this.d.log.info('ledger.append', { seq: rec.seq, type: rec.type, blobId, envelopeId: v.envelope.header.id });
      return { seq: rec.seq, blobId, envelopeId: v.envelope.header.id };
    });
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
      this.d.log.info('ledger.genesis', { blobId, envelopeId: env.header.id });
      return { seq: 0, blobId, envelopeId: env.header.id };
    });
  }

  /** Build, sign (antibody lane) and append a control record. */
  async writeOwn<T extends LedgerType>(type: T, payload: LedgerPayload<T>): Promise<{ seq: number; blobId: string; envelopeId: string }> {
    if (LEDGER_SIGNER[type] !== 'antibody') throw new Error(`control may not sign ${type}`);
    const h = await this.head();
    const record = { seq: h.seq, prev: h.prev, type, payload } as LedgerRecord;
    const env = buildEnvelope({ id: uuidv7(this.now()), acct: this.d.acct, ns: NS_LEDGER, lane: 'antibody', kind: 'ledger', ckpt: h.ckpt, ts: new Date(this.now()).toISOString(), text: ledgerBodyText(record) }, this.d.key);
    return this.appendLedger(env.text);
  }

  // ---- model context -----------------------------------------------------

  /**
   * Recall for Steward: semantic recall, then only verified, unquarantined,
   * resolved memories, each labelled by trust class (spec §4 context labels).
   */
  async recallForAgent(query: string, limit = 12): Promise<ContextItem[]> {
    const snap = await this.snapshot();
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
    this.d.log.info('context.recall', { query, returned: out.map((c) => c.id), digest: snap.projection.digest });
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

  /** propose_payment: evaluate, execute through the signer when allowed, record the decision. */
  async propose(args: { turn: string; readSet: string[]; proposal: ModelProposal; execute: boolean }): Promise<DecisionResult> {
    const ev = await this.evaluate(args.proposal);
    let txDigest: string | null = null;
    let executed = false;
    if (ev.verdict.decision === 'ALLOW' && ev.txBytes && args.execute) {
      if (!this.d.signer) throw new Error('no signer configured');
      const r = await this.d.signer.call<{ digest: string; tx: TxInfo }>('/sign', {
        mode: 'execute',
        txB64: toBase64(ev.txBytes),
        expect: { recipient: args.proposal.recipient.trim(), coinType: ev.coinType, amount: ev.base!.toString() },
      });
      txDigest = r.digest;
      executed = r.tx.ok;
    }
    const dec = await this.writeDecision({ turn: args.turn, readSet: args.readSet, proposal: args.proposal, ev, txDigest, executed, channel: 'transfer' });
    return { ...dec, verdict: ev.verdict, amountBase: ev.base?.toString() ?? null, coinType: ev.coinType, decimals: ev.decimals, executed, txDigest, dryRunOnly: ev.verdict.decision === 'ALLOW' && !args.execute, simulated: this.d.simulated };
  }

  /**
   * pay_x402: fetch the resource, turn its 402 requirements into a proposal,
   * evaluate it like any payment, sign (not execute) when allowed, and retry
   * with PAYMENT-SIGNATURE. The facilitator settles on Sui. The resource body
   * is external content, so it is not returned to the model.
   */
  async payX402(args: { turn: string; readSet: string[]; url: string; payeeLabel?: string; reason: string }): Promise<DecisionResult & { httpStatus: number; settlement: SettlementResponse | null }> {
    const f = this.d.fetchImpl ?? fetch;
    const u = new URL(args.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('x402 URL must be http(s)');
    const first = await f(args.url);
    if (first.status !== 402) throw new Error(`expected 402 Payment Required, got ${first.status}`);
    const header = first.headers.get(HDR_REQUIRED);
    if (!header) throw new Error(`402 without a ${HDR_REQUIRED} header`);
    const pr = decodeHeader(header, paymentRequiredSchema);
    const req = selectRequirement(pr, this.d.x402Network);
    if (!req) throw new Error(`no exact-scheme requirement for ${this.d.x402Network}`);
    const coinType = normalizeCoinType(req.asset);
    const meta = await this.d.chain.getCoinMetadata(coinType);
    if (!meta) throw new Error(`no coin metadata for ${coinType}`);
    const proposal: ModelProposal = {
      recipient: req.payTo,
      amount: formatUnits(req.amount, meta.decimals),
      coinType,
      ...(args.payeeLabel ? { payeeLabel: args.payeeLabel } : {}),
      reason: `${args.reason} (x402: ${pr.resource.description ?? pr.resource.url})`,
    };
    const ev = await this.evaluate(proposal);
    let settlement: SettlementResponse | null = null;
    let httpStatus = 402;
    let txDigest: string | null = null;
    if (ev.verdict.decision === 'ALLOW' && ev.txBytes) {
      if (!this.d.signer) throw new Error('no signer configured');
      const s = await this.d.signer.call<{ signature: string }>('/sign', {
        mode: 'sign',
        txB64: toBase64(ev.txBytes),
        expect: { recipient: req.payTo, coinType, amount: req.amount },
      });
      const payload: PaymentPayload = { x402Version: 2, resource: pr.resource, accepted: req, payload: { signature: s.signature, transaction: toBase64(ev.txBytes) } };
      const second = await f(args.url, { headers: { [HDR_SIGNATURE]: encodeHeader(payload) } });
      httpStatus = second.status;
      const rh = second.headers.get(HDR_RESPONSE);
      if (rh) settlement = decodeHeader<SettlementResponse>(rh);
      await second.arrayBuffer(); // drain; the body is never shown to the model
      if (settlement?.success) txDigest = settlement.transaction;
    }
    const executed = !!settlement?.success;
    const dec = await this.writeDecision({ turn: args.turn, readSet: args.readSet, proposal, ev, txDigest, executed, channel: `x402 ${args.url}` });
    return { ...dec, verdict: ev.verdict, amountBase: ev.base?.toString() ?? null, coinType: ev.coinType, decimals: ev.decimals, executed, txDigest, dryRunOnly: false, simulated: this.d.simulated, httpStatus, settlement };
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
  }): Promise<{ decisionId: string; decisionBlobId: string }> {
    const v = a.ev.verdict;
    const parents = [...new Set(a.readSet.filter((id) => UUID_RE.test(id)))].sort().slice(0, 64);
    const amount = a.ev.base !== null && a.ev.decimals !== null ? `${formatUnits(a.ev.base, a.ev.decimals)} (${a.ev.base} base units)` : a.proposal.amount;
    const lines = [
      `Payment decision: ${v.decision}${v.code === 'OK' ? '' : ` ${v.code}`}`,
      `Proposal (${a.channel}): pay ${amount} of ${a.ev.coinType ?? a.proposal.coinType ?? '?'} to ${a.proposal.recipient}${a.proposal.payeeLabel ? ` labelled "${a.proposal.payeeLabel}"` : ''}`,
      `Model's reason: ${JSON.stringify(a.proposal.reason.slice(0, 300))}`,
      `Verdict: ${v.reasons.join('; ')}`,
      `Rules: ${v.rules.map((r) => `${r.rule} ${r.pass ? 'pass' : 'FAIL'} (${r.detail})`).join(' | ')}`,
      `Ledger head: ${!a.ev.snap ? 'unavailable' : a.ev.snap.ledger.ok ? `#${a.ev.snap.ledger.head.seq}` : a.ev.snap.ledger.code}; checkpoint ${a.ev.snap?.ckpt ?? 'unavailable'}; turn ${a.turn}`,
      a.proposal.cites?.length ? `Model citations (display only, never policy input): ${a.proposal.cites.join(', ')}` : 'Model citations: none',
      a.txDigest ? `Transaction: ${a.txDigest} (${a.executed ? 'executed' : 'not executed'})` : v.decision === 'ALLOW' ? 'Transaction: none (dry-run only)' : 'Transaction: none (blocked, nothing signed)',
    ];
    const id = uuidv7(this.now());
    const src = a.txDigest ? [{ t: 'tx', digest: a.txDigest }] : [];
    const ckpt = await this.d.chain.latestCheckpoint().catch(() => a.ev.snap?.ckpt ?? 0);
    const env = buildEnvelope({ id, acct: this.d.acct, ns: NS_CONTENT, lane: 'antibody', kind: 'decision', parents, src, turn: a.turn, ckpt, ts: new Date(this.now()).toISOString(), text: lines.join('\n') }, this.d.key);
    const { blobId } = await this.d.mem.remember(env.text, NS_CONTENT, id);
    this.cache.put([{ blobId, namespace: NS_CONTENT, text: env.text }]);
    this.d.log.info('decision', { envelopeId: id, blobId, verdict: v.decision, code: v.code, txDigest: a.txDigest, turn: a.turn });
    if (v.decision === 'BLOCK') this.d.alert?.({ kind: 'payment-blocked', severity: 'warning', key: `block:${id}`, title: `payment blocked (${v.code})`, text: `${a.proposal.amount} to ${a.proposal.recipient}: ${v.reasons.join('; ').slice(0, 400)}`, data: { decisionId: id, code: v.code, turn: a.turn } });
    return { decisionId: id, decisionBlobId: blobId };
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
  async incident(i: Omit<Incident, 'id' | 'at' | 'status'>): Promise<Incident> {
    const inc: Incident = { ...i, id: `inc-${this.now().toString(36)}-${i.objectId.slice(2, 10)}`, at: new Date(this.now()).toISOString(), status: 'open' };
    this.incidents.upsert(inc);
    const strongLesson = inc.lessonMatches.some((m) => m.indicator !== 'keywords');
    if (inc.blocklisted || (strongLesson && inc.score >= this.d.autoQuarantineScore)) {
      const why = inc.blocklisted
        ? `auto: ${inc.objectId} is on the Sui Guardians blocklist`
        : `auto: matches lesson(s) ${[...new Set(inc.lessonMatches.map((m) => `#${m.lessonSeq}`))].join(', ')} learned from an earlier quarantine (${inc.lessonMatches.map((m) => `${m.indicator} ${m.value.slice(0, 20)}`).join('; ')})`;
      try {
        const q = await this.quarantine(inc.proposedSeed, why, [inc.objectId, ...(inc.observationId ? [inc.observationId] : [])], true);
        inc.status = 'auto-quarantined';
        inc.quarantineSeq = q.seq;
        this.incidents.upsert(inc);
      } catch (e) {
        this.d.log.warn('incident.auto_quarantine_failed', { id: inc.id, error: (e as Error).message });
      }
    }
    this.d.log.info('incident', { id: inc.id, objectId: inc.objectId, score: inc.score, status: inc.status });
    if (inc.status === 'open') this.d.alert?.({ kind: 'incident', severity: 'warning', key: `inc:${inc.objectId}`, title: `suspicious object in Steward's wallet (score ${inc.score.toFixed(2)})`, text: `${inc.objectId}\n${inc.rules.join(' · ').slice(0, 300)}\nReview it in the console: Incidents.`, data: { id: inc.id, objectId: inc.objectId, score: inc.score } });
    return inc;
  }

  // ---- revocation ----------------------------------------------------------

  /**
   * After the owner removed a delegate key on-chain: verify it is gone and
   * write lane.revoke (spec §9). Quarantine is untouched (I-9).
   */
  async recordRevoke(pub: string, lane: Lane, digest: string): Promise<{ seq: number }> {
    const account = await this.d.chain.getAccount(this.d.acct);
    if (account.delegateKeys.some((k) => k.publicKeyHex === pub)) throw new Error('key is still in delegate_keys on-chain; revocation not confirmed');
    const tx = await this.d.chain.getTransaction(digest);
    if (!tx || !tx.ok) throw new Error(`remove_delegate_key transaction ${digest} not found or failed`);
    const ckpt = await this.d.chain.latestCheckpoint();
    return this.writeOwn('lane.revoke', { pub, label: LANE_LABEL[lane], digest, ckpt });
  }

  async recordRotate(pub: string, lane: Lane, digest: string): Promise<{ seq: number }> {
    const account = await this.d.chain.getAccount(this.d.acct);
    const k = account.delegateKeys.find((x) => x.publicKeyHex === pub);
    if (!k || k.label !== LANE_LABEL[lane]) throw new Error(`new key is not on-chain with label ${LANE_LABEL[lane]}`);
    const ckpt = await this.d.chain.latestCheckpoint();
    return this.writeOwn('lane.rotate', { pub, label: LANE_LABEL[lane], digest, ckpt });
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
        memories: radius.memories.map((m) => ({ id: m.id, blobIds: m.blobIds, lane: m.env.header.lane, kind: m.env.header.kind, cls: m.cls, text: bodyContent(m.env.body) })),
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

  /** Raw envelopes of the turn's readSet (forensics for a BLOCK). */
  lineageOf(ids: string[]) {
    const snap = this.last;
    if (!snap) return [];
    return ids
      .map((id) => snap.projection.lineage.nodes.get(id))
      .filter((n) => !!n)
      .map((n) => ({ id: n!.id, cls: n!.cls, lane: n!.env.header.lane, kind: n!.env.header.kind, quarantined: n!.quarantined, parents: n!.env.header.parents, text: bodyContent(n!.env.body).slice(0, 400) }));
  }
}

/** Envelope header without verification, for display of failures. */
export function peekHeader(text: string) {
  try {
    return parseEnvelope(text).header;
  } catch {
    return null;
  }
}

export { fromBase64 };
