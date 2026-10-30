/**
 * Browser end-to-end helpers: one in-process hosted sandbox (it serves the
 * whole site plus the API), a real Chromium, a Wallet Standard test wallet
 * whose keys stay in Node, and an axe-core accessibility scan.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { startCloud } from '../src/web/cloud.ts';

const require = createRequire(import.meta.url);
export const AXE = require.resolve('axe-core/axe.min.js');

export async function startStack() {
  const dataDir = mkdtempSync(join(tmpdir(), 'ab-e2e-'));
  const cloud = await startCloud({ dataDir, port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(cloud.server.address() as { port: number }).port}`;
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  return {
    base,
    browser,
    cloud,
    async close() {
      await browser.close();
      cloud.server.closeAllConnections();
      cloud.server.close();
      cloud.tenants.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A context whose pages record console errors and uncaught exceptions. */
export async function newContext(browser: Browser, o: { mobile?: boolean; theme?: 'dark' | 'light' } = {}) {
  const ctx = await browser.newContext({
    bypassCSP: true, // only so axe can be injected; the app itself runs under its CSP elsewhere
    viewport: o.mobile ? { width: 390, height: 844 } : { width: 1280, height: 860 },
    ...(o.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    colorScheme: o.theme ?? 'dark',
  });
  if (o.theme) await ctx.addInitScript((t) => localStorage.setItem('antibody.theme', t), o.theme);
  return ctx;
}

export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // Expected: 401 from /api/auth/status-style probes on public pages is a JSON answer, not an error, but
    // Chromium logs failed fetches of /api/* (e.g. 401 /api/state before sign-in). Those are app-handled.
    if (/Failed to load resource: the server responded with a status of 40[134]/.test(t)) return;
    errors.push(`console: ${t}`);
  });
  return errors;
}

/** Wallet Standard test wallet: the page sees a normal Sui wallet; signing happens in Node. */
export async function installTestWallet(ctx: BrowserContext, kp = Ed25519Keypair.generate(), name = 'Test Wallet') {
  await ctx.exposeBinding('__abSignPersonal', async (_src, b64: string) => (await kp.signPersonalMessage(Buffer.from(b64, 'base64'))).signature);
  // A string, not a function: the TypeScript loader would rewrite a function body with helpers the page lacks.
  const init = `(() => {
    const cfg = ${JSON.stringify({ address: kp.toSuiAddress(), publicKey: kp.getPublicKey().toBase64(), name })};
    const b64 = (u8) => btoa(String.fromCharCode(...u8));
    const account = { address: cfg.address, publicKey: Uint8Array.from(atob(cfg.publicKey), (c) => c.charCodeAt(0)), chains: ['sui:mainnet', 'sui:testnet'], features: ['sui:signPersonalMessage'] };
    const wallet = {
      version: '1.0.0',
      name: cfg.name,
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iOCIgZmlsbD0iIzJiN2ZmZiIvPjwvc3ZnPg==',
      chains: ['sui:mainnet', 'sui:testnet'],
      accounts: [account],
      features: {
        'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
        'standard:events': { version: '1.0.0', on: () => () => {} },
        'sui:signPersonalMessage': { version: '1.1.0', signPersonalMessage: async ({ message }) => ({ bytes: b64(message), signature: await window.__abSignPersonal(b64(message)) }) },
      },
    };
    const register = (api) => api.register(wallet);
    addEventListener('wallet-standard:app-ready', (e) => register(e.detail));
    dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
  })();`;
  await ctx.addInitScript({ content: init });
  return kp;
}

export interface AxeViolation {
  id: string;
  impact: string;
  help: string;
  nodes: string[];
}

/** Serious and critical WCAG 2.1 A/AA violations on the current page. */
export async function axe(page: Page): Promise<AxeViolation[]> {
  // Measure settled colours, not a frame in the middle of a colour transition (timing differs between machines).
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation-play-state: paused !important; }' });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.addScriptTag({ path: AXE });
  const v = await page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run(c: unknown, o: unknown): Promise<{ violations: { id: string; impact: string; help: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] });
    return r.violations.map((x) => ({ id: x.id, impact: x.impact, help: x.help, nodes: x.nodes.slice(0, 5).map((n) => n.target.join(' ')) }));
  });
  return v.filter((x) => x.impact === 'serious' || x.impact === 'critical');
}

export const fmt = (vs: AxeViolation[]) => vs.map((v) => `${v.impact} ${v.id}: ${v.help}\n    ${v.nodes.join('\n    ')}`).join('\n');

/** No sideways scrolling: the page fits its viewport. */
export async function overflowX(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
}
