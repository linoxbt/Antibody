// Owner acts signed in the owner's browser wallet (setup/revoke/rotate --wallet):
// the CLI's one-off page hands out the request, only a signature comes back, and
// a signature from anyone but the owner changes nothing.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { ownerSession, walletAccountAdmin, type OwnerSession } from '../src/web/owner-sign.ts';
import { createWorld } from '../src/dev/world.ts';
import { LANE_LABEL } from '../src/core/types.ts';

/** Plays the browser page: poll for the request, sign it with `kp` (or cancel), post it back. */
async function page(url: string, kp: Ed25519Keypair | 'cancel') {
  for (let i = 0; i < 100; i++) {
    const r = await (await fetch(`${url}/request`)).json();
    if (r.id) {
      const body = kp === 'cancel' ? { id: r.id, cancelled: true } : { id: r.id, signature: (await kp.signPersonalMessage(new TextEncoder().encode(r.message))).signature, address: kp.toSuiAddress() };
      const res = await fetch(`${url}/result`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-antibody-ui': '1' }, body: JSON.stringify(body) });
      assert.equal(res.status, 200);
      return r;
    }
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('no request appeared');
}

async function setup(owner: Ed25519Keypair) {
  const w = await createWorld({ ownerSecret: owner.getSecretKey() });
  let session!: OwnerSession;
  session = await ownerSession({ onUrl: () => {} });
  const admin = walletAccountAdmin({ session, owner: owner.toSuiAddress(), accountId: w.setup.accountId, chain: w.rt.chain, fixture: w.fixture, packageId: '0x1', registryId: '0x2', network: 'mainnet' });
  return { w, session, admin };
}

test('the owner wallet removes a lane key: the page only ever returns a signature', async () => {
  const owner = Ed25519Keypair.generate();
  const { w, session, admin } = await setup(owner);
  try {
    const pub = w.setup.lanes.find((l) => l.label === LANE_LABEL['wallet-objects'])!.pub;
    assert.equal((await (await fetch(session.url.replace(/\/owner\/.*/, '/owner/wrong-token/request'))).status), 404, 'unguessable path');
    const [rm, req] = await Promise.all([admin.removeDelegateKey(pub), page(session.url, owner)]);
    assert.equal(req.kind, 'message');
    assert.match(req.message, /SIMULATED/);
    assert.match(req.message, new RegExp(pub));
    assert.ok(rm.digest);
    assert.ok(!(await w.rt.chain.getAccount(w.setup.accountId)).delegateKeys.some((k) => k.publicKeyHex === pub));
    const rev = await w.control.recordRevoke(pub, 'wallet-objects', rm.digest);
    assert.ok(rev.seq > 0);
    await session.finish({ ok: true, text: 'done' });
  } finally {
    w.dispose();
  }
});

test('a signature from another wallet, or a cancel, changes nothing', async () => {
  const owner = Ed25519Keypair.generate();
  const { w, session, admin } = await setup(owner);
  try {
    const pub = w.setup.lanes[0]!.pub;
    await assert.rejects(Promise.all([admin.removeDelegateKey(pub), page(session.url, Ed25519Keypair.generate())]), /not from the account owner/);
    await assert.rejects(Promise.all([admin.removeDelegateKey(pub), page(session.url, 'cancel')]), /cancelled/);
    assert.ok((await w.rt.chain.getAccount(w.setup.accountId)).delegateKeys.some((k) => k.publicKeyHex === pub), 'key still registered');
    const done = session.finish({ ok: false, text: 'stopped' });
    assert.deepEqual((await (await fetch(`${session.url}/request`)).json()).done, { ok: false, text: 'stopped' });
    await done;
  } finally {
    w.dispose();
  }
});
