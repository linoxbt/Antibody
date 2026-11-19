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
const link = (net: string, hash: string, text: string) => {
  const n = NETWORKS[net as keyof typeof NETWORKS];
  return hash ? `<a href="${n.explorer}/tx/${hash}">${text}</a>` : 'pending';
};
const loops: string[] = [];
const aiRows: string[] = [];
const dir = `${root}deployments`;
for (const file of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []) {
  const rec = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
  const n = NETWORKS[rec.network as keyof typeof NETWORKS];
  if (!n) continue;
  const addr = (a: string) => `<a href="${n.explorer}/address/${a}">${esc(a)}</a>`;
  const contracts = Object.entries(rec).filter(([k, v]) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) && !['owner', 'agent', 'scorer', 'replaces'].includes(k));
  const rows = rec.txs.map((t: any) => {
    const refused = t.events?.includes('PaymentRefused');
    const paid = t.events?.includes('PaymentExecuted');
    const mark = paid ? '<span class="ok">paid</span>' : refused ? '<span class="no">refused</span>' : '';
    return `<tr><td>${esc(t.step)}</td><td>${mark}</td><td><a href="${n.explorer}/tx/${t.hash}">${t.hash.slice(0, 10)}…</a></td></tr>`;
  }).join('\n');
  if (rec.ai?.steward) {
    const st = rec.ai.steward;
    aiRows.push(`<p><b>Steward</b> (an AI agent on Qwen) was asked to pay Alice's invoice, with a phishing email in its inbox. It said: <em>${esc(String(st.answer ?? ''))}</em> ${st.proposals.map((p: any) => `(${link('baseSepolia', p.tx, esc(p.result))})`).join(' ')}</p>`);
  }
  if (rec.ai?.report) aiRows.push(`<p><b>AI risk scorer</b> scored the phishing email ${rec.ai.report.score}/100 and reported its redirect address (${link('baseSepolia', rec.ai.report.tx, 'report')}); Reactive quarantined it on both vaults (rows I1 and I2 below). ${(rec.ai.benign ?? []).map((b: any) => `${esc(b.message)} scored ${b.score}`).join(', ')}: nothing reported.</p>`);
  for (const l of rec.loops ?? []) {
    loops.push(`<tr><td>${esc(l.name)}</td><td>${esc(l.rule)}</td><td>${link(l.origin.chain, l.origin.tx, 'origin')}</td><td>${link(l.reactive.chain, l.reactive.tx, 'reactive')}</td><td>${link(l.callback.chain, l.callback.tx ?? '', 'callback')}</td><td>${((n) => (n == null ? '?' : n === 0 ? '&lt;1s' : `${n}s`))(l.originToCallbackSeconds ?? l.reactiveToCallbackSeconds)}</td></tr>`);
  }
  sections.push(`<section class="deploy">
    <h2>On ${esc(rec.network)}${rec.version ? ` (v${rec.version})` : ''} <small class="note">(chain ${n.chainId})</small></h2>
    <dl>${contracts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${addr(v as string)}</dd>`).join('')}${rec.agent ? `<dt>agent</dt><dd>${addr(rec.agent)}</dd>` : ''}${rec.scorer ? `<dt>AI scorer key</dt><dd>${addr(rec.scorer)}</dd>` : ''}${rec.retired ? `<dt>status</dt><dd>retired: ${esc(String(rec.retired))}</dd>` : ''}${Object.entries(rec.verified ?? {}).map(([k, u]) => `<dt>source</dt><dd><a href="${esc(String(u))}">${esc(k)} verified on Sourcify</a></dd>`).join('')}</dl>
    <table class="phases txs"><thead><tr><th scope="col">Step</th><th scope="col">Result</th><th scope="col">Transaction</th></tr></thead><tbody>
${rows}
    </tbody></table>
  </section>`);
}
const loopSection = loops.length ? `<section class="deploy">
    <h2>The loop, on-chain</h2>
    <p class="note">Each row is one decision: the agent's transaction on Base Sepolia, GuardReactive's reaction on Lasna, and the callback that changed the vault, with the time between the agent's block and the callback's block (Base Sepolia block timestamps).</p>
    <table class="phases txs loops"><thead><tr><th scope="col">Scenario</th><th scope="col">Rule</th><th scope="col">Origin</th><th scope="col">Reactive</th><th scope="col">Callback</th><th scope="col">Time</th></tr></thead><tbody>
${loops.join('\n')}
    </tbody></table>
  </section>` : '';
const aiSection = aiRows.length ? `<section class="deploy"><h2>The AI, live</h2>${aiRows.join('')}</section>` : '';
const html = readFileSync(`${root}web/index.html`, 'utf8').replace('<!--DEPLOYMENTS-->', aiSection + loopSection + sections.join('\n'));
writeFileSync(`${out}/index.html`, html);
console.log(`built web-dist with ${sections.length} deployment section(s)`);
