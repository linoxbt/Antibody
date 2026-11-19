// Assemble the Guard status site into web-dist/, with every recorded deployment (deployments/*.json)
// rendered as addresses and transaction links. Brand assets are copied from the main site.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { NETWORKS } from '../networks.ts';

const root = new URL('..', import.meta.url).pathname;
const out = `${root}web-dist`;
const brand = `${root}../web/assets`;
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/assets/fonts`, { recursive: true });
cpSync(`${root}web/netlify.toml`, `${out}/netlify.toml`);
cpSync(`${root}web/guard.css`, `${out}/assets/guard.css`);
for (const f of ['mark.svg', 'favicon.svg']) cpSync(`${brand}/img/${f}`, `${out}/assets/${f}`);
cpSync(`${brand}/fonts/dm-sans-latin-wght-normal.woff2`, `${out}/assets/fonts/dm-sans.woff2`);
cpSync(`${brand}/fonts/jetbrains-mono-latin-wght-normal.woff2`, `${out}/assets/fonts/jetbrains-mono.woff2`);
cpSync(`${brand}/fonts/LICENSE.md`, `${out}/assets/fonts/LICENSE.md`);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const sections: string[] = [];
const dir = `${root}deployments`;
for (const file of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []) {
  const rec = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
  const n = NETWORKS[rec.network as keyof typeof NETWORKS];
  if (!n) continue;
  const addr = (a: string) => `<a href="${n.explorer}/address/${a}">${esc(a)}</a>`;
  const contracts = Object.entries(rec).filter(([k, v]) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) && !['owner', 'agent'].includes(k));
  const rows = rec.txs.map((t: any) => {
    const refused = t.events?.includes('PaymentRefused');
    const paid = t.events?.includes('PaymentExecuted');
    const mark = paid ? '<span class="ok">paid</span>' : refused ? '<span class="no">refused</span>' : '';
    return `<tr><td>${esc(t.step)}</td><td>${mark}</td><td><a href="${n.explorer}/tx/${t.hash}">${t.hash.slice(0, 10)}…</a></td></tr>`;
  }).join('\n');
  sections.push(`<section class="deploy">
    <h2>On ${esc(rec.network)} <small class="note">(chain ${n.chainId})</small></h2>
    <dl>${contracts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${addr(v as string)}</dd>`).join('')}<dt>agent</dt><dd>${addr(rec.agent)}</dd>${Object.entries(rec.verified ?? {}).map(([k, u]) => `<dt>source</dt><dd><a href="${esc(String(u))}">${esc(k)} verified on Sourcify</a></dd>`).join('')}</dl>
    <table class="phases txs"><thead><tr><th scope="col">Step</th><th scope="col">Result</th><th scope="col">Transaction</th></tr></thead><tbody>
${rows}
    </tbody></table>
  </section>`);
}
const html = readFileSync(`${root}web/index.html`, 'utf8').replace('<!--DEPLOYMENTS-->', sections.join('\n'));
writeFileSync(`${out}/index.html`, html);
console.log(`built web-dist with ${sections.length} deployment section(s)`);
