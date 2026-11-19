// Memory: every GuardMemory GuardReactive watches, and each entry with its source and whether the agent may
// act on it (read from the chain through /api/v1).
import { el } from '../../ui.js';
import { head, stat, card, shortAddr } from '../kit.js';
import { addrLink } from '../../guard.js';
import { chainName, ext } from './common.js';

const SHOW = 25; // newest entries per memory
const cache = new Map(); // url -> { at, value }

async function getJson(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const value = res.ok ? await res.json() : null;
  cache.set(url, { at: Date.now(), value });
  return value;
}

const STATUS = { usable: ['ok', 'usable'], 'quarantined-source': ['bad', 'source quarantined'], forgotten: ['plain', 'forgotten'] };

export default {
  id: 'memory',
  path: '/app/memory',
  title: 'Memory',
  icon: 'memory',
  async render(ctx) {
    const s = ctx.state;
    const memories = s.memories ?? [];
    const blocks = await Promise.all(memories.map(async (m) => {
      const n = Number(m.entries ?? 0);
      const ids = Array.from({ length: Math.min(n, SHOW) }, (_, i) => n - i);
      const entries = await Promise.all(ids.map((id) => getJson(`/api/v1/memories/${m.chain}/${m.address}/entries/${id}`).catch(() => null)));
      return { m, n, entries: entries.filter(Boolean) };
    }));
    const total = blocks.reduce((a, b) => a + b.n, 0);
    const unusable = blocks.reduce((a, b) => a + b.entries.filter((e) => !e.usable).length, 0);

    return el(
      'div',
      { style: 'display:grid;gap:16px' },
      head('Agent', 'memory.', 'Every memory carries its source. When GuardReactive learns an attacker, on any vault or from the AI scorer, every memory that attacker planted becomes unusable at once, and new ones are refused. A poisoned source found here is quarantined on every vault.'),
      el('section', { class: 'stat-row' }, stat('Memories', String(memories.length), 'guarded by GuardReactive'), stat('Entries', String(total), 'content stays off-chain; its hash and source on-chain'), stat('Unusable', String(unusable), 'from a quarantined source, or forgotten')),
      ...(blocks.length
        ? blocks.map(({ m, n, entries }) =>
            card(
              `${chainName(m.chain)} memory`,
              el('span', { class: `pill ${m.frozen ? 'bad' : 'ok'}` }, m.frozen ? 'frozen' : 'guarded'),
              el('div', { class: 'kv', style: 'display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin-bottom:14px' },
                el('span', { class: 'muted' }, 'contract'), ext(addrLink(s.explorers, m.chain, m.address), shortAddr(m.address)),
                el('span', { class: 'muted' }, 'writer (agent)'), el('span', { class: 'mono' }, shortAddr(m.writer)),
                el('span', { class: 'muted' }, 'owner'), el('span', { class: 'mono' }, shortAddr(m.owner)),
                el('span', { class: 'muted' }, 'entries'), el('span', {}, String(n)),
              ),
              entries.length
                ? el('div', { class: 'row-list' }, ...entries.map((e) => {
                    const [cls, text] = STATUS[e.status] ?? ['plain', e.status];
                    return el(
                      'div',
                      { class: 'row-i' },
                      el('span', { class: 'mono muted' }, `#${e.id}`),
                      el('span', { class: 'grow attacker-main' }, el('span', {}, e.kind || 'note', el('span', { class: 'muted' }, ` · from `), el('a', { href: `/app/attackers/${e.source}`, 'data-nav': '', class: 'mono' }, shortAddr(e.source))), el('span', { class: 'attacker-how mono' }, `hash ${e.contentHash.slice(0, 12)}… · ${new Date(e.writtenAt).toLocaleString()}`)),
                      el('span', { class: `pill plain ${cls}` }, text),
                    );
                  }))
                : el('p', { class: 'empty' }, 'No entries yet.'),
              n > SHOW ? el('p', { class: 'hint' }, `The newest ${SHOW} of ${n}.`) : null,
            ),
          )
        : [card('No memory watched yet', null, el('p', { class: 'muted', style: 'margin:0' }, 'Deploy a GuardMemory with the SDK, set GuardReactive as its guardian, and ask the API to watch it.'))]),
    );
  },
};
