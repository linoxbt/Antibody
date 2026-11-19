// The Antibody Guard story, told from what happened on-chain: each chapter is one build phase's live
// run, with its origin → reaction → callback loops linked to the explorers (from /evidence.json).
import { mountShell } from '../shell.js';
import { loadEvidence, secs, txLink, CHAIN, RULE } from '../guard.js';
import { $, el, short } from '../ui.js';

mountShell('walkthrough');

const CHAPTERS = [
  { time: 'Phase 1', title: 'The agent can only propose.', text: 'GuardVault holds the agent’s funds on Base Sepolia. The agent’s key can do one thing: propose a payment. The vault checks it against the rules and pays or refuses, and a refusal is an event, not a revert. Two payments paid, four refused.', phase1: true },
  { time: 'Phase 2', title: 'A look-alike address.', text: 'The agent is tricked into paying an address that looks like Alice’s. The vault refuses it as an unknown payee; GuardReactive on Reactive Lasna sees the refusal and calls back to quarantine the address, seconds later.', match: (n) => /^A:/.test(n) },
  { time: 'Phase 2', title: 'Three refusals, then frozen.', text: 'A compromised agent keeps trying things the rules refuse. On the third refusal in ten minutes, GuardReactive freezes the whole vault. Only the owner can unfreeze it.', match: (n) => /^B:/.test(n) },
  { time: 'Phase 2', title: 'Faster than a human would approve.', text: 'Six valid payments in a row, each one allowed on its own. More than five proposals in two minutes is a burst: GuardReactive freezes the vault.', match: (n) => /^C:/.test(n) },
  { time: 'Phase 3', title: 'A payee change, vetoed.', text: 'Someone with the owner’s session asks to point “alice” at the known attacker. The change waits for its timelock, and GuardReactive cancels it before it can take effect.', match: (n) => /^[DE]:/.test(n) },
  { time: 'Phase 3', title: 'Paid on CRON.', text: 'A recurring payment to Bob. GuardReactive subscribes to Reactive’s CRON only while a schedule is active, triggers each payment when it is due, and unsubscribes when the owner cancels it. The vault’s usual rules still apply.', match: (n) => /^F:/.test(n) },
  { time: 'Phase 3', title: 'Learned once, blocked everywhere.', text: 'An attacker seen on Base Sepolia is learned. A vault on Ethereum Sepolia, watched afterwards, is immunized with that lesson at once; an attacker seen on Ethereum Sepolia is quarantined on Base Sepolia too.', match: (n) => /^(H|G1|G2):/.test(n) },
  { time: 'Phase 4', title: 'The AI scores. Reactive enforces.', text: 'Qwen reads a phishing email and scores it 95. The address is reported to the RiskOracle, and GuardReactive quarantines it on both vaults before any payment is tried. Steward, asked to pay Alice’s invoice from the same inbox, pays her registered address and ignores the phishing email.', match: (n) => /^I\d:/.test(n), ai: true },
];
const DWELL = 11000;
let ev = null;
let i = 0;
let timer = null;

function setChapter(n, push = true) {
  i = Math.max(0, Math.min(CHAPTERS.length - 1, n));
  if (push) history.replaceState(null, '', `#chapter-${i + 1}`);
  render();
}

const link = (chain, hash, text) => {
  const href = txLink(ev.explorers, chain, hash);
  return href ? el('a', { href, target: '_blank', rel: 'noopener' }, text) : el('span', { class: 'muted' }, text);
};

function evidence(ch) {
  const out = [];
  if (ch.phase1) {
    out.push(
      el(
        'section',
        { class: 'card' },
        el('div', { class: 'card-title' }, el('div', {}, el('h3', {}, 'The agent’s proposals on Base Sepolia'))),
        el('div', { class: 'feed' }, ...ev.phase1.map((p) => el('div', { class: 'item' }, el('div', { class: 'item-head' }, el('span', { class: `pill plain ${p.result === 'paid' ? 'ok' : 'bad'}` }, p.result), link('baseSepolia', p.tx, short(p.tx, 12))), el('p', {}, p.step)))),
      ),
    );
  }
  const loops = ch.match ? ev.recorded.filter((l) => ch.match(l.name ?? '')) : [];
  if (loops.length) {
    out.push(
      el(
        'section',
        { class: 'card glow' },
        el('div', { class: 'card-title' }, el('div', {}, el('h3', {}, 'Origin → reaction → callback'))),
        el(
          'div',
          { class: 'feed' },
          ...loops.map((l) =>
            el(
              'div',
              { class: 'item' },
              el('div', { class: 'item-head' }, el('span', { class: 'tag q' }, (RULE[l.rule] ?? [l.rule])[0]), el('span', { class: 'mono small' }, l.subject && !/^0x0+$/.test(l.subject) ? short(l.subject, 12) : 'vault'), el('span', { class: 'pill plain ok' }, secs(l.seconds))),
              el('p', {}, l.name.replace(/^\w+\d?: /, ''), ' · ', l.origin?.tx ? link(l.origin.chain, l.origin.tx, `origin on ${CHAIN[l.origin.chain] ?? l.origin.chain}`) : 'owner call', ' → ', link('lasna', l.reactive?.tx, 'reaction on Lasna'), ' → ', link(l.destChain, l.callback?.tx, `callback on ${CHAIN[l.destChain] ?? l.destChain}`)),
            ),
          ),
        ),
      ),
    );
  }
  if (ch.ai && ev.ai?.steward) {
    const st = ev.ai.steward;
    out.push(
      el(
        'section',
        { class: 'card' },
        el('div', { class: 'card-title' }, el('div', {}, el('h3', {}, 'Steward, the agent'))),
        el('p', { class: 'lede', style: 'margin:0 0 12px' }, `“${st.answer}”`),
        el('div', { class: 'feed' }, ...st.proposals.map((p) => el('div', { class: 'item' }, el('div', { class: 'item-head' }, el('span', { class: `pill plain ${p.result === 'paid' ? 'ok' : 'bad'}` }, p.result), link('baseSepolia', p.tx, short(p.tx, 12))), el('p', {}, `${p.amount} ETH → ${p.label} (${short(p.to, 12)})`)))),
      ),
    );
  }
  return out;
}

function render() {
  const ch = CHAPTERS[i];
  $('chapters').replaceChildren(...CHAPTERS.map((s, k) => el('li', {}, el('button', { class: `chapter${k === i ? ' on' : ''}${k < i ? ' done' : ''}`, 'aria-current': k === i ? 'step' : null, onclick: () => (stop(), setChapter(k)) }, el('span', { class: 'time' }, s.time), el('span', { class: 'ttl' }, s.title)))));
  $('wt-time').textContent = `${i + 1} / ${CHAPTERS.length}`;
  for (const [id, text] of [['wt-title', ch.title], ['wt-text', ch.text]]) {
    const node = $(id);
    node.textContent = text;
    node.style.animation = 'none';
    void node.offsetWidth;
    node.style.animation = '';
  }
  $('bar').style.width = `${((i + 1) / CHAPTERS.length) * 100}%`;
  $('prev').disabled = i === 0;
  $('next').disabled = i === CHAPTERS.length - 1;
  $('evidence').replaceChildren(...evidence(ch));
}

function stop() {
  clearInterval(timer);
  timer = null;
  $('play').textContent = 'Autoplay';
}

$('play').addEventListener('click', () => {
  if (timer) return stop();
  $('play').textContent = 'Pause';
  if (i === CHAPTERS.length - 1) setChapter(0);
  timer = setInterval(() => (i >= CHAPTERS.length - 1 ? stop() : setChapter(i + 1)), DWELL);
});
$('prev').addEventListener('click', () => (stop(), setChapter(i - 1)));
$('next').addEventListener('click', () => (stop(), setChapter(i + 1)));
document.addEventListener('keydown', (e) => {
  if (!ev || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if (e.key === 'ArrowRight') (stop(), setChapter(i + 1));
  if (e.key === 'ArrowLeft') (stop(), setChapter(i - 1));
});

(async () => {
  try {
    ev = await loadEvidence();
  } catch {
    $('evidence').replaceChildren(el('div', { class: 'card' }, el('h3', {}, 'The evidence did not load'), el('p', { class: 'muted' }, 'Try the live console instead.'), el('a', { class: 'btn btn-primary', href: '/app', style: 'margin-top:12px' }, 'Open the console')));
    return;
  }
  const m = /chapter-(\d+)/.exec(location.hash);
  setChapter(m ? Number(m[1]) - 1 : 0, false);
})();
