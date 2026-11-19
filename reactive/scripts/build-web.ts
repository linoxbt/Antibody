// Build the Antibody Guard site into web-dist/: Antibody's frontend (frontend/), plus two files generated
// from the deployment records: evidence.json (contracts, every recorded loop, the AI runs) and the
// Evidence page. Netlify serves it; /api/* goes to the Guard service on Railway.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { NETWORKS } from '../networks.ts';

const root = new URL('..', import.meta.url).pathname;
const out = `${root}web-dist`;
const rec = (f: string) => (existsSync(`${root}deployments/${f}.json`) ? JSON.parse(readFileSync(`${root}deployments/${f}.json`, 'utf8')) : null);
const explorers = Object.fromEntries(Object.entries(NETWORKS).map(([k, n]) => [k, n.explorer]));
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// ---- evidence.json ---------------------------------------------------------------------------
const base1 = rec('baseSepolia'), lasna1 = rec('lasna'), base2 = rec('baseSepolia-v2'), sep2 = rec('sepolia-v2');
const lasna2 = rec('lasna-v2'), lasna3 = rec('lasna-v3'), lasna4 = rec('lasna-v4');
const recorded = [['v1', lasna1], ['v2', lasna2], ['v3', lasna3], ['v4', lasna4]].flatMap(([v, r]: any) =>
  (r?.loops ?? []).map((l: any) => ({
    name: l.name, rule: l.rule, subject: l.subject ?? null, destChain: l.callback?.chain, source: 'recorded', deployment: v,
    origin: { chain: l.origin?.chain ?? null, tx: l.origin?.tx ?? null }, reactive: { tx: l.reactive?.tx ?? null }, callback: { tx: l.callback?.tx ?? null },
    seconds: l.originToCallbackSeconds ?? l.reactiveToCallbackSeconds ?? null,
  })),
).reverse();
const RESULT = (t: any) => (t.events?.includes('PaymentExecuted') ? 'paid' : t.events?.includes('PaymentRefused') ? `refused: ${/\((\w+)\)$/.exec(t.step)?.[1] ?? ''}` : '');
const phase1 = (base1?.txs ?? []).filter((t: any) => t.step.startsWith('agent pays')).map((t: any) => ({ step: t.step.replace(/ \((allowed|\w+)\)$/, ''), tx: t.hash, result: RESULT(t) }));
const lessons = [...new Set(recorded.filter((l: any) => ['UnknownRecipient', 'CrossChainQuarantine', 'AiRisk'].includes(l.rule) && l.subject).map((l: any) => String(l.subject).toLowerCase()))];
const v = (r: any, k: string) => r?.verified?.[k] ?? null;
const contracts = {
  vaults: [
    { chain: 'baseSepolia', chainId: NETWORKS.baseSepolia.chainId, address: base2.vault },
    { chain: 'sepolia', chainId: NETWORKS.sepolia.chainId, address: sep2.vault },
  ],
  guard: { address: lasna4.guard },
  oracle: { address: base2.oracle, scorer: base2.scorer },
  current: [
    { name: 'GuardReactive v4', chain: 'lasna', address: lasna4.guard, verified: v(lasna4, 'GuardReactive'), role: 'watches both vaults and the RiskOracle; freezes, quarantines, vetoes, pays on CRON' },
    { name: 'GuardVault v2', chain: 'baseSepolia', address: base2.vault, verified: v(base2, 'GuardVault'), role: 'the agent’s funds; proposals paid or refused by on-chain rules' },
    { name: 'GuardVault v2', chain: 'sepolia', address: sep2.vault, verified: v(sep2, 'GuardVault'), role: 'the same vault on a second chain' },
    { name: 'RiskOracle', chain: 'baseSepolia', address: base2.oracle, verified: v(base2, 'RiskOracle'), role: 'the AI scorer’s reports; changes nothing by itself' },
  ],
  history: [
    { name: 'GuardReactive v3', chain: 'lasna', address: lasna3?.guard, verified: v(lasna3, 'GuardReactive'), status: 'retired: replaced by v4 (AI risk oracle)' },
    { name: 'GuardReactive v2', chain: 'lasna', address: lasna2?.guard, verified: v(lasna2, 'GuardReactive'), status: 'retired: replaced by v3 (per-chain gas limits)' },
    { name: 'GuardReactive v1', chain: 'lasna', address: lasna1?.guard, verified: v(lasna1, 'GuardReactive'), status: 'Phase 2 record' },
    { name: 'GuardVault v1', chain: 'baseSepolia', address: base1?.vault, verified: v(base1, 'GuardVault'), status: 'Phase 1 and 2 record' },
  ].filter((x) => x.address),
};
const evidence = { generatedAt: new Date().toISOString(), explorers, contracts, lessons, recorded, phase1, ai: lasna4?.ai ? { report: lasna4.ai.report, steward: lasna4.ai.steward, benign: lasna4.ai.benign } : null };

// ---- the Evidence page ------------------------------------------------------------------------
const tx = (chain: string, hash: string | null, text: string) => (hash ? `<a href="${explorers[chain]}/tx/${esc(hash)}" target="_blank" rel="noopener">${esc(text)}</a>` : '<span class="muted">—</span>');
const ad = (chain: string, a: string) => `<a href="${explorers[chain]}/address/${esc(a)}" target="_blank" rel="noopener"><code>${esc(a)}</code></a>`;
const CHAIN: Record<string, string> = { baseSepolia: 'Base Sepolia', sepolia: 'Ethereum Sepolia', lasna: 'Reactive Lasna' };
const sec = (n: number | null) => (n === null ? '—' : n === 0 ? '&lt;1 s' : `${n} s`);
const contractRows = (rows: any[], last: string) => rows.map((c) => `<tr><td>${esc(c.name)}</td><td>${CHAIN[c.chain]}</td><td>${ad(c.chain, c.address)}</td><td>${c.verified ? `<a href="${esc(c.verified)}" target="_blank" rel="noopener">Sourcify ✓</a>` : '—'}</td><td class="muted">${esc(c[last])}</td></tr>`).join('');
const loopRows = recorded.map((l: any) => `<tr><td>${esc(l.name)}</td><td>${l.origin.tx ? tx(l.origin.chain, l.origin.tx, 'origin') : '<span class="muted">owner call</span>'}</td><td>${tx('lasna', l.reactive.tx, 'reaction')}</td><td>${tx(l.destChain, l.callback.tx, 'callback')}</td><td>${sec(l.seconds)}</td></tr>`).join('');
const page = readFileSync(`${root}frontend/evidence.template.html`, 'utf8')
  .replace('<!--CURRENT-->', contractRows(contracts.current, 'role'))
  .replace('<!--HISTORY-->', contractRows(contracts.history, 'status'))
  .replace('<!--LOOPS-->', loopRows)
  .replace('<!--PHASE1-->', phase1.map((p: any) => `<tr><td>${esc(p.step)}</td><td>${esc(p.result)}</td><td>${tx('baseSepolia', p.tx, p.tx.slice(0, 10) + '…')}</td></tr>`).join(''))
  .replace('<!--AI-->', evidence.ai ? `<p>The scorer (Qwen) scored the phishing email <b>${evidence.ai.report.score}/100</b> and reported <code>${esc(evidence.ai.report.address)}</code> (${tx('baseSepolia', evidence.ai.report.tx, 'report')}); GuardReactive quarantined it on both vaults (rows I1 and I2 above). ${(evidence.ai.benign ?? []).map((b: any) => `${esc(b.message)} scored ${b.score}`).join(', ')}: nothing reported.</p><p>Steward, asked to pay Alice’s invoice from the same inbox, said: <em>${esc(evidence.ai.steward.answer)}</em> ${evidence.ai.steward.proposals.map((p: any) => tx('baseSepolia', p.tx, p.result)).join(' ')}</p>` : '')
  .replace('<!--GENERATED-->', esc(evidence.generatedAt.slice(0, 10)));

// ---- assemble -------------------------------------------------------------------------------
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(`${root}frontend`, out, { recursive: true, filter: (src) => !src.endsWith('evidence.template.html') });
writeFileSync(`${out}/evidence.json`, JSON.stringify(evidence, null, 1));
writeFileSync(`${out}/evidence.html`, page);
console.log(`built web-dist: ${recorded.length} loops, ${contracts.current.length} current contracts, ${phase1.length} phase 1 proposals`);
