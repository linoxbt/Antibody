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

    // Execute is for one run only: the checkbox is clear again once the run is back.
    await page.goto(stack.base + '/app/steward', { waitUntil: 'networkidle' });
    await page.locator('#execute').check();
    await page.getByRole('textbox', { name: 'Instruction to Steward' }).fill("Pay this month's rent.");
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const context = page.locator('.pane.protected details');
    await context.waitFor();
    assert.equal(await page.locator('#execute').isChecked(), false, 'execute resets after a run');

    // Auto refresh re-renders only when the state changed, and keeps an open <details> open.
    await context.locator('summary').click();
    assert.equal(await page.evaluate(() => (window as unknown as { __abRefreshNow(): Promise<boolean> }).__abRefreshNow()), false, 'unchanged state: no re-render');
    await page.evaluate(() => fetch('/api/sandbox/payee', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-antibody-ui': '1' }, body: JSON.stringify({ label: 'gym', address: '0x' + 'ab'.repeat(32), cap: '25' }) }).then((r) => r.json()));
    assert.equal(await page.evaluate(() => (window as unknown as { __abRefreshNow(): Promise<boolean> }).__abRefreshNow()), true, 'changed state: re-rendered');
    assert.equal(await page.locator('.pane.protected details').evaluate((d) => (d as HTMLDetailsElement).open), true, 'the open <details> stays open');
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'SUMMARY', 'focus stays on the summary');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('console navigation: focus moves to the view heading; the closed phone drawer is inert', async () => {
  for (const mobile of [false, true]) {
    const ctx = await newContext(stack.browser, { mobile });
    try {
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await page.goto(stack.base + '/login', { waitUntil: 'networkidle' });
      await page.locator('#demo').click();
      await page.waitForURL(/\/app/);
      await page.locator('#view h1').waitFor();
      const side = page.locator('#side');
      const burger = page.locator('.burger-app');
      const inert = () => side.evaluate((e) => (e as HTMLElement).inert);
      assert.ok(await page.locator('.tb-right .pill').first().isVisible(), 'the mode badge is visible');
      if (mobile) {
        assert.equal(await inert(), true, 'closed drawer is inert');
        await burger.click();
        assert.equal(await inert(), false, 'open drawer is not inert');
        assert.equal(await burger.getAttribute('aria-label'), 'Close navigation');
        assert.ok(await side.evaluate((e) => e.contains(document.activeElement)), 'focus moves into the drawer');
        await page.keyboard.press('Escape');
        assert.equal(await inert(), true, 'closed again: inert');
        assert.ok(await burger.evaluate((e) => e === document.activeElement), 'focus returns to the burger');
        await burger.click();
      } else {
        assert.equal(await inert(), false, 'desktop sidebar is never inert');
      }
      await side.locator('a[href="/app/ledger"]').click();
      await page.waitForURL(/\/app\/ledger$/);
      await page.waitForFunction(() => document.activeElement?.matches('#view h1'));
      await page.waitForFunction(() => Array.from(document.querySelectorAll('[role="status"]')).some((e) => e.textContent === 'Ledger loaded'));
      if (mobile) assert.equal(await inert(), true, 'navigating closes the drawer');
      await page.goBack();
      await page.waitForFunction(() => location.pathname === '/app' && document.activeElement?.matches('#view h1'));
      assert.deepEqual(errors, []);
    } finally {
      await ctx.close();
    }
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
