// Screenshots of the live app for the demo video (hosted sandbox: simulated by design).
import { chromium } from 'playwright';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
const BASE = 'https://antibody-memory.netlify.app';
const OUT = process.argv[2];
const kp = Ed25519Keypair.generate();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
await ctx.exposeBinding('__abSignPersonal', async (_s, b64) => (await kp.signPersonalMessage(Buffer.from(b64, 'base64'))).signature);
await ctx.addInitScript(`(() => {
  const cfg = ${JSON.stringify({ address: kp.toSuiAddress(), publicKey: kp.getPublicKey().toBase64(), name: 'Slush' })};
  const b64 = (u8) => btoa(String.fromCharCode(...u8));
  const account = { address: cfg.address, publicKey: Uint8Array.from(atob(cfg.publicKey), (c) => c.charCodeAt(0)), chains: ['sui:mainnet'], features: ['sui:signPersonalMessage'] };
  const wallet = { version: '1.0.0', name: cfg.name, icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iOCIgZmlsbD0iIzJiN2ZmZiIvPjwvc3ZnPg==', chains: ['sui:mainnet'], accounts: [account],
    features: { 'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) }, 'standard:events': { version: '1.0.0', on: () => () => {} },
      'sui:signPersonalMessage': { version: '1.1.0', signPersonalMessage: async ({ message }) => ({ bytes: b64(message), signature: await window.__abSignPersonal(b64(message)) }) } } };
  const reg = (api) => api.register(wallet);
  window.addEventListener('wallet-standard:app-ready', (e) => reg(e.detail));
  try { window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: reg })); } catch {}
})();`);
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept());
const shot = async (name, o = {}) => { await page.waitForTimeout(o.wait ?? 1800); await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: !!o.full }); console.log('shot', name); };
const go = async (path, name, o) => { await page.goto(BASE + path, { waitUntil: 'networkidle' }); await shot(name, o); };

await go('/', 'home-top', { wait: 3500 });
await go('/', 'home-full', { full: true, wait: 3500 });
await go('/walkthrough', 'walkthrough', { wait: 3000 });
await go('/security', 'security', { wait: 2500 });
await go('/security', 'security-full', { full: true });
await go('/install', 'install', { wait: 2500 });
await go('/blog', 'blog', { wait: 2500 });
await page.goto(BASE + '/blog#it-ran-on-sui-mainnet', { waitUntil: 'networkidle' }); await shot('blog-mainnet');
await go('/login', 'login', { wait: 2500 });
await page.getByRole('button', { name: /Slush/ }).first().click();
await page.waitForURL(/\/app/, { timeout: 30000 });
await shot('app-overview', { wait: 4000 });
await page.getByRole('button', { name: 'Send a poisoned coin' }).click();
await shot('app-overview-attack', { wait: 4000 });
await go('/app/incidents', 'app-incidents', { wait: 3000 });
await go('/app/memory', 'app-memory', { wait: 3500 });
await page.goto(BASE + '/app/steward', { waitUntil: 'networkidle' }); await page.waitForTimeout(2000);
const box = page.getByLabel('Instruction to Steward');
await box.fill("Pay this month's rent.");
await page.locator('button.send').click();
await page.waitForTimeout(12000);
await shot('app-steward-block', { wait: 1000 });
await shot('app-steward-block-full', { full: true, wait: 200 });
await page.goto(BASE + '/app/incidents', { waitUntil: 'networkidle' }); await page.waitForTimeout(2000);
await page.getByRole('button', { name: 'Quarantine source' }).first().click();
await shot('app-quarantined', { wait: 6000 });
await go('/app/memory', 'app-memory-after', { wait: 3500 });
await go('/app/ledger', 'app-ledger', { wait: 3000 });
await go('/app/payees', 'app-payees');
await go('/app/keys', 'app-keys');
await page.goto(BASE + '/app', { waitUntil: 'networkidle' }); await page.waitForTimeout(2500);
await page.getByRole('button', { name: 'Send a poisoned coin' }).click();
await shot('app-overview-lesson', { wait: 4500 });
await go('/app/incidents', 'app-incidents-lesson', { wait: 3000 });
await go('/app/settings', 'app-settings');
// Phone views
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, colorScheme: 'dark' });
const mp = await m.newPage();
for (const [p, n] of [['/', 'phone-home'], ['/blog', 'phone-blog']]) { await mp.goto(BASE + p, { waitUntil: 'networkidle' }); await mp.waitForTimeout(3500); await mp.screenshot({ path: `${OUT}/${n}.png` }); console.log('shot', n); }
await browser.close();
