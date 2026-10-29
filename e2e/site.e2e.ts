// Every public page in a real browser, desktop and phone, dark and light:
// it loads with no script errors, never scrolls sideways, and has no serious
// or critical accessibility problems (axe-core, WCAG 2.1 A/AA).
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { axe, fmt, newContext, overflowX, startStack, watchErrors } from './helpers.ts';

let stack: Awaited<ReturnType<typeof startStack>>;
before(async () => (stack = await startStack()));
after(() => stack.close());

const PAGES = ['/', '/walkthrough', '/security', '/install', '/privacy', '/login', '/offline.html', '/no-such-page'];

for (const mobile of [false, true]) {
  for (const theme of ['dark', 'light'] as const) {
    test(`public pages, ${mobile ? 'phone' : 'desktop'}, ${theme}`, async () => {
      const ctx = await newContext(stack.browser, { mobile, theme });
      try {
        for (const path of PAGES) {
          const page = await ctx.newPage();
          const errors = watchErrors(page);
          const res = await page.goto(stack.base + path, { waitUntil: 'networkidle' });
          assert.equal(res?.status(), path === '/no-such-page' ? 404 : 200, path);
          await page.waitForTimeout(300); // entrance animations settle before contrast is measured
          assert.deepEqual(errors, [], `${path}: script errors`);
          assert.ok((await overflowX(page)) <= 1, `${path}: scrolls sideways by ${await overflowX(page)}px`);
          const v = await axe(page);
          assert.equal(v.length, 0, `${path} (${mobile ? 'phone' : 'desktop'}, ${theme}):\n${fmt(v)}`);
          await page.close();
        }
      } finally {
        await ctx.close();
      }
    });
  }
}

test('the mobile menu opens, holds the theme switch, and closes with Escape', async () => {
  const ctx = await newContext(stack.browser, { mobile: true });
  try {
    const page = await ctx.newPage();
    await page.goto(stack.base + '/', { waitUntil: 'networkidle' });
    const burger = page.locator('button[aria-controls]').first();
    await burger.click();
    assert.equal(await burger.getAttribute('aria-expanded'), 'true');
    await page.getByRole('button', { name: /light/i }).first().click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    await page.keyboard.press('Escape');
    assert.equal(await burger.getAttribute('aria-expanded'), 'false');
  } finally {
    await ctx.close();
  }
});

test('installable app: manifest with icons, a service worker, an offline page', async () => {
  const ctx = await newContext(stack.browser);
  try {
    const page = await ctx.newPage();
    await page.goto(stack.base + '/app', { waitUntil: 'networkidle' });
    const href = await page.locator('link[rel=manifest]').getAttribute('href');
    const m = await page.evaluate((h) => fetch(h!).then((r) => r.json()), href);
    assert.equal(m.display, 'standalone');
    assert.equal(m.start_url, '/app');
    for (const size of ['192x192', '512x512']) assert.ok(m.icons.some((i: { sizes: string }) => i.sizes === size), size);
    for (const i of m.icons) assert.equal((await page.request.get(stack.base + i.src)).status(), 200, i.src);
    const scope = await page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.scope));
    assert.equal(scope, stack.base + '/');
    // Offline: the shell still opens; the API is never served from cache.
    await page.reload({ waitUntil: 'networkidle' });
    await ctx.setOffline(true);
    await page.goto(stack.base + '/privacy', { waitUntil: 'domcontentloaded' });
    assert.match(await page.locator('h1').innerText(), /Can.t reach/, 'a page never visited shows the offline page');
    await page.goto(stack.base + '/app', { waitUntil: 'domcontentloaded' });
    assert.ok(await page.locator('#app').count(), 'the console shell opens from cache');
    assert.equal(await page.evaluate(() => fetch('/api/auth/status').then(() => 'answered', () => 'failed')), 'failed');
  } finally {
    await ctx.close();
  }
});
