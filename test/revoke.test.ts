// FR-16: the console's revoke button. The owner's wallet signs; control records
// lane.revoke only once the chain shows the key gone; nothing else gets through.
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { createWorld, seedBaseline, type World } from '../src/dev/world.ts';
import { LANE_LABEL } from '../src/core/types.ts';
import { AuthError } from '../src/web/auth.ts';
import { callOf, RevokeFlow } from '../src/web/revoke.ts';

const owner = Ed25519Keypair.generate();
const worlds: World[] = [];
after(() => worlds.forEach((w) => w.dispose()));
const sign = async (kp: Ed25519Keypair, message: string) => (await kp.signPersonalMessage(new TextEncoder().encode(message))).signature;
const status = (n: number) => (e: unknown) => e instanceof AuthError && e.status === n;

test('offline: the owner signs, the key leaves the account, lane.revoke is recorded; strangers and replays are refused', async () => {
  const w = await createWorld({ ownerSecret: owner.getSecretKey() });
  worlds.push(w);
  await seedBaseline(w);
  const flow = new RevokeFlow(w.rt, w.control);

  await assert.rejects(flow.prepare('antibody'), status(400), 'the control lane is not revocable here');
  await assert.rejects(flow.prepare('nonsense'), status(400));

  const p = await flow.prepare('wallet-objects');
  assert.equal(p.mode, 'message');
  if (p.mode !== 'message') return;
  assert.match(p.message, /SIMULATED/);
  assert.equal(p.owner, owner.toSuiAddress());

  // A stranger's signature is refused, and the request is spent.
  await assert.rejects(flow.submit(p.id, { signature: await sign(Ed25519Keypair.generate(), p.message) }), status(403));
  await assert.rejects(flow.submit(p.id, { signature: await sign(owner, p.message) }), status(410), 'single use');

  const p2 = await flow.prepare('wallet-objects');
  if (p2.mode !== 'message') return;
  const r = await flow.submit(p2.id, { signature: await sign(owner, p2.message) });
  assert.equal(r.lane, 'wallet-objects');
  const account = await w.rt.chain.getAccount(w.setup.accountId);
  assert.ok(!account.delegateKeys.some((k) => k.label === LANE_LABEL['wallet-objects']), 'key removed on-chain');
  const snap = await w.control.snapshot();
  assert.ok(snap.ledger.ok);
  if (!snap.ledger.ok) return;
  assert.deepEqual(snap.ledger.revocations.map((x) => [x.seq, x.lane, x.pub]), [[r.seq, 'wallet-objects', p2.pub]]);
  await assert.rejects(flow.prepare('wallet-objects'), status(409), 'nothing left to revoke');
});

test('live: a wallet may re-resolve gas but not change the call it signs', async () => {
  const sender = owner.toSuiAddress();
  const obj = (id: string) => ({ objectId: '0x' + id.repeat(64).slice(0, 64), version: '1', digest: '11111111111111111111111111111111' });
  const build = async (pubByte: number, budget: number) => {
    const tx = new Transaction();
    tx.setSender(sender);
    tx.moveCall({ target: '0x2::account::remove_delegate_key', arguments: [tx.objectRef(obj('a')), tx.objectRef(obj('b')), tx.pure.vector('u8', new Array(32).fill(pubByte))] });
    tx.setGasPrice(1000);
    tx.setGasBudget(budget);
    tx.setGasPayment([obj('c')]);
    return tx.build();
  };
  const prepared = await build(7, 10_000_000);
  assert.equal(callOf(await build(7, 20_000_000)), callOf(prepared), 'a different gas budget is the same call');
  assert.notEqual(callOf(await build(8, 10_000_000)), callOf(prepared), 'a different key is not');
});
