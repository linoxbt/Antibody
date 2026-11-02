// S5: the signer reads the transaction's commands itself and signs only a plain coin transfer.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Transaction } from '@mysten/sui/transactions';
import { checkCommands, checkTransferShape } from '../src/signer/shape.ts';

const R = '0x' + '7a'.repeat(32);
const EVIL = '0x' + 'ba'.repeat(32);
const kind = async (fn: (tx: Transaction) => void) => {
  const tx = new Transaction();
  fn(tx);
  return Transaction.fromKind(await tx.build({ onlyTransactionKind: true })).getData();
};

test('a split-and-transfer to the expected recipient passes', async () => {
  const d = await kind((tx) => {
    const [c] = tx.splitCoins(tx.gas, [1000]);
    tx.transferObjects([c!], R);
  });
  assert.equal(checkCommands(d, R), null);
});

test('refused: other recipient, extra transfer, raw object or gas coin, foreign Move call', async () => {
  assert.match(
    checkCommands(await kind((tx) => {
      const [c] = tx.splitCoins(tx.gas, [1000]);
      tx.transferObjects([c!], EVIL);
    }), R)!,
    /different recipient/,
  );
  assert.match(
    checkCommands(await kind((tx) => {
      const [a, b] = tx.splitCoins(tx.gas, [1000, 5]);
      tx.transferObjects([a!], R);
      tx.transferObjects([b!], EVIL);
    }), R)!,
    /2 transfers|different recipient/,
  );
  assert.match(checkCommands(await kind((tx) => tx.transferObjects([tx.gas], R)), R)!, /not a freshly split coin/);
  assert.match(checkCommands(await kind((tx) => tx.transferObjects([tx.objectRef({ objectId: '0x' + '11'.repeat(32), version: '1', digest: '11111111111111111111111111111111' })], R)), R)!, /not a freshly split coin/);
  assert.match(
    checkCommands(await kind((tx) => {
      const [c] = tx.splitCoins(tx.gas, [1000]);
      tx.moveCall({ target: '0x' + 'ab'.repeat(32) + '::drain::all', arguments: [] });
      tx.transferObjects([c!], R);
    }), R)!,
    /not a plain coin operation/,
  );
});

test('offline fixture transfers are checked by recipient; garbage is refused', () => {
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  assert.equal(checkTransferShape(enc({ kind: 'fixture-transfer', recipient: R }), R), null);
  assert.match(checkTransferShape(enc({ kind: 'fixture-transfer', recipient: EVIL }), R)!, /different recipient/);
  assert.match(checkTransferShape(new Uint8Array([1, 2, 3]), R)!, /unreadable/);
});
