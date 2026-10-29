/**
 * Payment policy engine (spec §8, invariants I-5 and I-6).
 *
 * A pure function: no I/O, no clock, no model. The model can only propose;
 * this decides from the verified ledger and chain state. Citations, reasons
 * and labels written by the model are never decision inputs (a label only
 * ever narrows: it can cause a block, never an allow).
 */
import { isCanonicalSuiAddress, normalizeCoinType, SUI_COIN_TYPE } from './encoding.ts';
import type { ActivePayee, LedgerFailure, LedgerState } from './ledger.ts';

export interface PaymentProposal {
  recipient: string;
  /** Base units (integer string). */
  amount: string;
  coinType: string;
  payeeLabel?: string;
  reason: string;
  cites?: string[];
}

export interface SimulationResult {
  ok: boolean;
  error?: string;
  sender: string;
  /** Net balance changes reported by the dry-run. */
  balanceChanges: { address: string; coinType: string; amount: string }[];
  /** Net gas charged in MIST (computation + storage − rebate). */
  gasUsed: string;
}

export interface ChainState {
  ok: boolean;
  error?: string;
  ckpt: number;
  sender: string;
  /** Dry-run of the exact transaction the signer would sign. */
  simulation?: SimulationResult;
  /** Upper bound on gas the policy accepts, in MIST. */
  maxGas?: string;
}

export type BlockCode =
  | 'LEDGER_UNVERIFIED'
  | 'CHAIN_UNAVAILABLE'
  | 'BAD_RECIPIENT'
  | 'UNKNOWN_RECIPIENT'
  | 'LABEL_MISMATCH'
  | 'ASSET_MISMATCH'
  | 'OVER_CAP'
  | 'BAD_AMOUNT'
  | 'SIMULATION_MISMATCH';

export type RuleId = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
export type RuleOutcome = { rule: RuleId; pass: boolean; detail: string };

export interface Verdict {
  decision: 'ALLOW' | 'BLOCK';
  code: 'OK' | BlockCode;
  reasons: string[];
  rules: RuleOutcome[];
  payeeId?: string;
}

export const DEFAULT_MAX_GAS = 50_000_000n; // 0.05 SUI

const block = (code: BlockCode, rules: RuleOutcome[], reasons: string[], payeeId?: string): Verdict => ({
  decision: 'BLOCK',
  code,
  reasons,
  rules,
  ...(payeeId ? { payeeId } : {}),
});

function parseUnits(s: string): bigint | null {
  return /^[0-9]{1,40}$/.test(s) ? BigInt(s) : null;
}

export function evaluatePayment(proposal: PaymentProposal, ledger: LedgerState | LedgerFailure, chain: ChainState): Verdict {
  const rules: RuleOutcome[] = [];

  // R0: verified ledger and successful chain reads, or nothing moves (I-6).
  if (!ledger.ok) {
    rules.push({ rule: 'R0', pass: false, detail: `${ledger.code}: ${ledger.detail}` });
    return block('LEDGER_UNVERIFIED', rules, [`ledger not verified (${ledger.code})`]);
  }
  if (!chain.ok) {
    rules.push({ rule: 'R0', pass: false, detail: chain.error ?? 'chain read failed' });
    return block('CHAIN_UNAVAILABLE', rules, [`chain state unavailable: ${chain.error ?? 'unknown error'}`]);
  }
  rules.push({ rule: 'R0', pass: true, detail: `ledger head #${ledger.head.seq}, checkpoint ${chain.ckpt}` });

  // R1: canonical address only. Names are never resolved at payment time.
  if (!isCanonicalSuiAddress(proposal.recipient)) {
    rules.push({ rule: 'R1', pass: false, detail: `"${proposal.recipient}" is not 0x + 64 lowercase hex` });
    return block('BAD_RECIPIENT', rules, ['recipient is not a canonical Sui address']);
  }
  rules.push({ rule: 'R1', pass: true, detail: 'canonical address' });

  // R2 + R3. When the recipient is unknown but the label names a registered
  // payee, report the more specific LABEL_MISMATCH: same block, clearer story.
  const labelled = proposal.payeeLabel !== undefined ? findByLabel(ledger.payees, proposal.payeeLabel) : undefined;
  const payee = ledger.payees.find((p) => p.address === proposal.recipient);
  if (!payee) {
    rules.push({ rule: 'R2', pass: false, detail: 'recipient is not an active payee in the ledger' });
    if (labelled) {
      rules.push({ rule: 'R3', pass: false, detail: `"${proposal.payeeLabel}" is registered to ${labelled.address}` });
      return block('LABEL_MISMATCH', rules, [`payee "${labelled.label}" is registered to ${labelled.address}, not ${proposal.recipient}`], labelled.payeeId);
    }
    return block('UNKNOWN_RECIPIENT', rules, [`${proposal.recipient} is not a registered payee`]);
  }
  rules.push({ rule: 'R2', pass: true, detail: `payee ${payee.payeeId} (ledger #${payee.seq})` });
  if (proposal.payeeLabel !== undefined && labelled?.payeeId !== payee.payeeId) {
    rules.push({ rule: 'R3', pass: false, detail: `label "${proposal.payeeLabel}" does not map to ${proposal.recipient}` });
    return block('LABEL_MISMATCH', rules, [`label "${proposal.payeeLabel}" does not belong to payee ${payee.payeeId}`], payee.payeeId);
  }
  rules.push({ rule: 'R3', pass: true, detail: proposal.payeeLabel !== undefined ? 'label matches' : 'no label given' });

  // R4: asset and cap.
  let coin: string;
  try {
    coin = normalizeCoinType(proposal.coinType);
  } catch {
    rules.push({ rule: 'R4', pass: false, detail: `bad coin type ${proposal.coinType}` });
    return block('ASSET_MISMATCH', rules, ['coin type is not valid'], payee.payeeId);
  }
  if (coin !== payee.coinType) {
    rules.push({ rule: 'R4', pass: false, detail: `${coin} ≠ registered ${payee.coinType}` });
    return block('ASSET_MISMATCH', rules, [`payee ${payee.payeeId} is paid in ${payee.coinType}`], payee.payeeId);
  }
  const amount = parseUnits(proposal.amount);
  if (amount === null || amount <= 0n) {
    rules.push({ rule: 'R4', pass: false, detail: `amount "${proposal.amount}" is not a positive integer` });
    return block('BAD_AMOUNT', rules, ['amount must be a positive integer in base units'], payee.payeeId);
  }
  if (amount > BigInt(payee.capPerTx)) {
    rules.push({ rule: 'R4', pass: false, detail: `${amount} > cap ${payee.capPerTx}` });
    return block('OVER_CAP', rules, [`amount exceeds the per-transaction cap of ${payee.capPerTx}`], payee.payeeId);
  }
  rules.push({ rule: 'R4', pass: true, detail: `${amount} ≤ cap ${payee.capPerTx}` });

  // R5: the dry-run moves exactly amount to the recipient and nothing else.
  const r5 = checkSimulation(chain, proposal.recipient, coin, amount);
  rules.push({ rule: 'R5', pass: r5 === null, detail: r5 ?? 'dry-run balance changes match exactly' });
  if (r5 !== null) return block('SIMULATION_MISMATCH', rules, [r5], payee.payeeId);

  return { decision: 'ALLOW', code: 'OK', reasons: [`pay ${payee.label} (${payee.payeeId})`], rules, payeeId: payee.payeeId };
}

function findByLabel(payees: ActivePayee[], label: string): ActivePayee | undefined {
  const l = label.trim().toLowerCase();
  return payees.find((p) => p.label.toLowerCase() === l || p.payeeId === l);
}

/** Returns null when the simulation matches, or the reason it does not. */
export function checkSimulation(chain: ChainState, recipient: string, coinType: string, amount: bigint): string | null {
  const sim = chain.simulation;
  if (!sim) return 'no dry-run result';
  if (!sim.ok) return `dry-run failed: ${sim.error ?? 'unknown'}`;
  if (sim.sender !== chain.sender) return 'dry-run sender is not the Steward wallet';
  // Net gas can be slightly negative when the storage rebate exceeds the cost.
  const gas = /^-?[0-9]{1,40}$/.test(sim.gasUsed) ? BigInt(sim.gasUsed) : null;
  const maxGas = parseUnits(chain.maxGas ?? '') ?? DEFAULT_MAX_GAS;
  if (gas === null || gas > maxGas || gas < -maxGas) return `gas ${sim.gasUsed} is outside the ±${maxGas} MIST limit`;

  const expected = new Map<string, bigint>();
  const add = (addr: string, ct: string, v: bigint) => {
    const k = `${addr}|${ct}`;
    expected.set(k, (expected.get(k) ?? 0n) + v);
  };
  add(recipient, coinType, amount);
  add(sim.sender, coinType, -amount);
  add(sim.sender, SUI_COIN_TYPE, -gas);

  const actual = new Map<string, bigint>();
  for (const c of sim.balanceChanges) {
    let ct: string;
    try {
      ct = normalizeCoinType(c.coinType);
    } catch {
      return `unparseable coin type in balance changes: ${c.coinType}`;
    }
    if (!/^-?[0-9]+$/.test(c.amount)) return `unparseable amount in balance changes: ${c.amount}`;
    const k = `${c.address.toLowerCase()}|${ct}`;
    actual.set(k, (actual.get(k) ?? 0n) + BigInt(c.amount));
  }
  for (const [k, v] of [...expected]) if (v === 0n) expected.delete(k);
  for (const [k, v] of [...actual]) if (v === 0n) actual.delete(k);
  if (expected.size !== actual.size) return `dry-run touches ${actual.size} balance(s), expected ${expected.size}`;
  for (const [k, v] of expected) {
    if (actual.get(k) !== v) return `dry-run balance change for ${k.replace('|', ' ')} is ${actual.get(k) ?? 0n}, expected ${v}`;
  }
  return null;
}
