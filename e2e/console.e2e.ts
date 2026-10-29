// The console in a real browser: the recorded demo, a wallet signing in to
// the hosted sandbox (through the same Wallet Standard path a real wallet
// uses), the attack and the quarantine, and the CLI's owner approval page.
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { axe, fmt, installTestWallet, newContext, overflowX, startStack, watchErrors } from './helpers.ts';
import { createWorld } from '../src/dev/world.ts';
import { ownerSession, walletAccountAdmin } from '../src/web/owner-sign.ts';

let stack: Awaited<ReturnType<typeof startStack>>;
before(async () => (stack = await startStack()));
after(() => stack.close());

const VIEWS = ['/app', '/app/steward', '/app/memory', '/app/incidents', '/app/payees', '/app/ledger', '/app/keys', '/app/settings'];

for (const mobile of [false, true]) {
  test(`recorded demo: every console view renders, ${mobile ? 'phone' : 'desktop'}, accessible in both themes`, async () => {
    for (const theme of ['dark', 'light'] as const) {
      const ctx = await newContext(stack.browser, { mobile, theme });
      try {
        const page = await ctx.newPage();
        const errors = watchErrors(page);
        await page.goto(stack.base + '/login', { waitUntil: 'networkidle' });
        await page.locator('#demo').click();
        await page.waitForURL(/\/app/);
        for (const v of VIEWS) {
          await page.goto(stack.base + v, { waitUntil: 'networkidle' });
          await page.locator('#view > *').first().waitFor();
          assert.equal(await page.locator('#view').getByText('This view failed to load').count(), 0, `${v} failed to load`);
          assert.ok((await overflowX(page)) <= 1, `${v} scrolls sideways`);
          await page.waitForTimeout(250);
          const found = await axe(page);
          assert.equal(found.length, 0, `${v} (${mobile ? 'phone' : 'desktop'}, ${theme}):\n${fmt(found)}`);
        }
        assert.deepEqual(errors, []);
      } finally {
        await ctx.close();
      }
    }
  });
}

test('sandbox: a wallet signs in, sends a poisoned coin, and quarantines it from the console', async () => {
  const ctx = await newContext(stack.browser);
  try {
    const kp = await installTestWallet(ctx);
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    page.on('dialog', (d) => d.accept());
    await page.goto(stack.base + '/login', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /Test Wallet/ }).click();
    await page.waitForURL(/\/app$/);
    assert.match(await page.locator('.pill.live').first().innerText(), /Sandbox/);
    await page.getByRole('button', { name: 'Send a poisoned coin' }).click();
    await page.locator('.toast.show').waitFor();
    assert.match(await page.locator('.toast').innerText(), /flagged it|quarantined it/);
    await page.goto(stack.base + '/app/incidents', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Quarantine source' }).first().click();
    await page.locator('.toast.show', { hasText: 'Quarantine written as ledger' }).waitFor();
    const st = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
    assert.equal(st.account.owner, kp.toSuiAddress());
    assert.ok(st.ledger.quarantines.some((q: { released: boolean }) => !q.released));
    await page.goto(stack.base + '/app/settings', { waitUntil: 'networkidle' });
    const found = await axe(page);
    assert.equal(found.length, 0, fmt(found));
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('owner approval page: the CLI waits, the wallet signs in the browser, the key is removed', async () => {
  const owner = Ed25519Keypair.generate();
  const w = await createWorld({ ownerSecret: owner.getSecretKey() });
  const ctx = await newContext(stack.browser);
  try {
    await installTestWallet(ctx, owner, 'Owner Wallet');
    const session = await ownerSession({ onUrl: () => {} });
    const admin = walletAccountAdmin({ session, owner: owner.toSuiAddress(), accountId: w.setup.accountId, chain: w.rt.chain, fixture: w.fixture, packageId: '0x1', registryId: '0x2', network: 'mainnet' });
    const pub = w.setup.lanes[2]!.pub;
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    const removal = admin.removeDelegateKey(pub);
    await page.goto(session.url, { waitUntil: 'networkidle' });
    await page.getByText(pub.slice(0, 16), { exact: false }).waitFor();
    const found = await axe(page);
    assert.equal(found.length, 0, fmt(found));
    await page.getByRole('button', { name: /Owner Wallet/ }).click();
    await removal;
    await session.finish({ ok: true, text: 'Key removed.' });
    await page.getByRole('heading', { name: /Done/ }).waitFor();
    assert.ok(!(await w.rt.chain.getAccount(w.setup.accountId)).delegateKeys.some((k) => k.publicKeyHex === pub));
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
    w.dispose();
  }
});
