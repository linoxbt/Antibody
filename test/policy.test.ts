import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUI_COIN_TYPE } from '../src/core/encoding.ts';
import { verifyLedger, type LedgerState } from '../src/core/ledger.ts';
import { evaluatePayment, type ChainState, type SimulationResult } from '../src/core/policy.ts';
import { NS_LEDGER } from '../src/core/types.ts';
import { toBaseUnits, formatUnits } from '../src/core/units.ts';
import { STEWARD_TOOLS } from '../src/steward/turn.ts';
import { account, ACCT, ATTACKER, genesisStep, LANDLORD, ledgerChain, makeKeys, payeeStep, stored, USDC } from './helpers.ts';

const k = makeKeys();
const envs = ledgerChain(k, [genesisStep(k), payeeStep()]);
const all = envs.map((e) => stored(e, NS_LEDGER));
const ledger = verifyLedger({ acct: ACCT, account: account(k), inventory: all.map((m) => m.blobId), recalled: all, hwm: null }) as LedgerState;
assert.ok(ledger.ok);

const WALLET = '0x' + 'fa'.repeat(32);
const sim = (amount: string, to = LANDLORD, extra: SimulationResult['balanceChanges'] = []): SimulationResult => ({
  ok: true,
  sender: WALLET,
  gasUsed: '1000000',
  balanceChanges: [
    { address: to, coinType: USDC, amount },
    { address: WALLET, coinType: USDC, amount: `-${amount}` },
    { address: WALLET, coinType: SUI_COIN_TYPE, amount: '-1000000' },
    ...extra,
  ],
});
const chain = (s?: SimulationResult): ChainState => ({ ok: true, ckpt: 10, sender: WALLET, ...(s ? { simulation: s } : {}) });
const rent = { recipient: LANDLORD, amount: '450000000', coinType: USDC, payeeLabel: 'landlord', reason: 'rent' };

test('ALLOW: registered payee, within cap, exact dry-run', () => {
  const v = evaluatePayment(rent, ledger, chain(sim('450000000')));
  assert.equal(v.decision, 'ALLOW');
  assert.deepEqual(v.rules.map((r) => r.pass), [true, true, true, true, true, true]);
});

test('T-08: a proposal to an unregistered recipient citing many trusted memories is BLOCKED (I-5)', () => {
  const cites = Array.from({ length: 10 }, (_, i) => `01a00000-0000-7000-8000-00000000000${i}`);
  const withCites = evaluatePayment({ ...rent, recipient: ATTACKER, payeeLabel: undefined, cites }, ledger, chain(sim('450000000', ATTACKER)));
  const without = evaluatePayment({ ...rent, recipient: ATTACKER, payeeLabel: undefined }, ledger, chain(sim('450000000', ATTACKER)));
  assert.equal(withCites.code, 'UNKNOWN_RECIPIENT');
  // Citations are not decision inputs: identical verdicts.
  assert.deepEqual(withCites, without);
});

test("T-09: a known payeeLabel with the attacker's address gives LABEL_MISMATCH (I-5)", () => {
  const v = evaluatePayment({ ...rent, recipient: ATTACKER }, ledger, chain());
  assert.equal(v.decision, 'BLOCK');
  assert.equal(v.code, 'LABEL_MISMATCH');
});

test('R1: names and non-canonical addresses are never resolved', () => {
  for (const r of ['landlord.sui', '0x7A' + '7a'.repeat(31), '0x7a7a', LANDLORD.toUpperCase()]) {
    assert.equal(evaluatePayment({ ...rent, recipient: r }, ledger, chain()).code, 'BAD_RECIPIENT');
  }
});

test('R4: cap, asset and amount', () => {
  assert.equal(evaluatePayment({ ...rent, amount: '500000001' }, ledger, chain()).code, 'OVER_CAP');
  assert.equal(evaluatePayment({ ...rent, coinType: SUI_COIN_TYPE }, ledger, chain()).code, 'ASSET_MISMATCH');
  assert.equal(evaluatePayment({ ...rent, amount: '0' }, ledger, chain()).code, 'BAD_AMOUNT');
  assert.equal(evaluatePayment({ ...rent, amount: '-5' }, ledger, chain()).code, 'BAD_AMOUNT');
});

test('R5: the dry-run must move exactly the amount to the recipient and nothing else', () => {
  assert.equal(evaluatePayment(rent, ledger, chain()).code, 'SIMULATION_MISMATCH');
  assert.equal(evaluatePayment(rent, ledger, chain(sim('450000001'))).code, 'SIMULATION_MISMATCH');
  assert.equal(evaluatePayment(rent, ledger, chain(sim('450000000', LANDLORD, [{ address: ATTACKER, coinType: SUI_COIN_TYPE, amount: '5' }]))).code, 'SIMULATION_MISMATCH');
  assert.equal(evaluatePayment(rent, ledger, chain({ ...sim('450000000'), ok: false, error: 'abort' })).code, 'SIMULATION_MISMATCH');
  assert.equal(evaluatePayment(rent, ledger, chain({ ...sim('450000000'), sender: ATTACKER })).code, 'SIMULATION_MISMATCH');
  assert.equal(evaluatePayment(rent, ledger, { ...chain(sim('450000000')), maxGas: '10' }).code, 'SIMULATION_MISMATCH');
});

test('R0 / I-6: chain read failures fail closed', () => {
  assert.equal(evaluatePayment(rent, ledger, { ok: false, error: 'timeout', ckpt: 0, sender: WALLET }).code, 'CHAIN_UNAVAILABLE');
});

test('determinism: the same inputs always give the same verdict', () => {
  const a = evaluatePayment(rent, ledger, chain(sim('450000000')));
  const b = evaluatePayment(structuredClone(rent), ledger, chain(sim('450000000')));
  assert.deepEqual(a, b);
});

test('T-07: the model has no tool to add a payee, change a cap, sign or broadcast (I-4)', () => {
  const names = STEWARD_TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, ['pay_x402', 'propose_payment', 'recall_memories', 'write_note']);
  for (const t of STEWARD_TOOLS) assert.doesNotMatch(`${t.name} ${JSON.stringify(t.parameters)}`, /payee_add|add_payee|capPerTx|cap_per|sign|broadcast|execute/i);
});

test('units: decimal display amounts ⇄ base units without floating point', () => {
  assert.equal(toBaseUnits('450', 6), 450_000_000n);
  assert.equal(toBaseUnits('0.000001', 6), 1n);
  assert.equal(toBaseUnits('4,800'.replace(',', ''), 6), 4_800_000_000n);
  assert.throws(() => toBaseUnits('1.0000001', 6));
  assert.throws(() => toBaseUnits('-1', 6));
  assert.equal(formatUnits(42_500_000n, 6), '42.5');
});
