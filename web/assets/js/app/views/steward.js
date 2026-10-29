import { el, protectedPane, unprotectedPane, plural } from '../../ui.js';
import { head } from '../kit.js';

const PRESETS = ["Pay this month's rent.", "Pay Maya's allowance.", 'Pay the electricity bill at http://127.0.0.1:7403/bill/2026-11'];
// Live results survive re-renders (auto refresh, navigation back to this view).
let live = { instruction: PRESETS[0], execute: false, out: null, running: false };

function lastRecordedRun(src) {
  return src.steps.slice(0, src.index + 1).reverse().find((s) => s.run)?.run ?? null;
}

export default {
  id: 'steward',
  path: '/app/steward',
  title: 'Steward',
  icon: 'steward',
  render(ctx) {
    const src = ctx.src;
    const recorded = src.mode === 'recorded';
    const run = recorded ? lastRecordedRun(src) : live.out;

    const input = el('input', { 'aria-label': 'Instruction to Steward', value: recorded ? (run?.instruction ?? PRESETS[0]) : live.instruction, autocomplete: 'off' });
    input.addEventListener('input', () => (live.instruction = input.value));
    const execute = el('input', { type: 'checkbox', id: 'execute', ...(live.execute ? { checked: true } : {}), ...(recorded ? { disabled: true } : {}) });
    execute.addEventListener('change', () => (live.execute = execute.checked));
    const send = el('button', { class: 'send', type: 'submit', 'aria-label': 'Run', ...(live.running ? { disabled: true } : {}) });
    send.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
    const form = el('form', { class: 'prompt', style: 'height:64px' }, input, send);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (recorded) {
        const next = src.steps.findIndex((s, i) => i > src.index && s.run);
        const first = src.steps.findIndex((s) => s.run);
        const to = next >= 0 ? next : first;
        src.setIndex(to);
        ctx.rerender();
        return ctx.toast(`Replaying the recorded run from chapter ${to + 1}: “${src.steps[to].title}”.`);
      }
      ctx.act(async () => {
        live.running = true;
        live.instruction = input.value;
        ctx.rerender();
        try {
          live.out = await src.api('/api/run', { instruction: live.instruction, execute: live.execute });
          await src.refresh();
        } finally {
          live.running = false;
          ctx.rerender();
        }
      });
    });

    const presetList = ctx.state.sandbox ? PRESETS.filter((p) => !p.includes('http')) : PRESETS;
    const presets = recorded
      ? src.steps.flatMap((s, i) => (s.run ? [el('button', { class: 'chip', type: 'button', onclick: () => (src.setIndex(i), ctx.rerender()) }, `${s.time} · ${s.run.instruction.length > 34 ? s.run.instruction.slice(0, 34) + '…' : s.run.instruction}`)] : []))
      : presetList.map((p) => el('button', { class: 'chip', type: 'button', onclick: () => ((live.instruction = p), ctx.rerender()) }, p.length > 40 ? p.slice(0, 40) + '…' : p));

    const model = run?.protected?.model ? `${run.protected.model}${run.protected.simulatedModel ? ' · simulated' : ''}` : '';
    const ctxItems = run?.protected?.steps?.find((s) => s.tool === 'recall_memories')?.result?.items?.length ?? 0;

    return el(
      'div',
      { style: 'display:grid;gap:16px' },
      head('Steward,', 'watched.', 'The same instruction, with and without Antibody. Nothing is signed unless you tick execute.'),
      el(
        'section',
        { class: 'card glow' },
        form,
        el('div', { style: 'display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-top:14px' }, el('div', { class: 'chips' }, ...presets), el('label', { class: 'small muted', for: 'execute', style: 'display:flex;gap:8px;align-items:center' }, execute, 'execute on chain')),
      ),
      live.running && !recorded
        ? el('div', { class: 'card', style: 'display:flex;gap:14px;align-items:center' }, el('div', { class: 'loading', style: 'min-height:0' }, el('i')), 'Steward is thinking; the unprotected agent runs beside it…')
        : el(
            'div',
            { class: 'split' },
            el('div', { class: 'pane protected' }, el('div', { class: 'pane-head' }, el('span', { class: 'kicker' }, 'Steward + Antibody'), model ? el('span', { class: 'pill live plain' }, model) : null), protectedPane(run?.protected)),
            el('div', { class: 'pane unprotected' }, el('div', { class: 'pane-head' }, el('span', { class: 'kicker' }, 'Unprotected agent'), el('span', { class: 'pill bad plain' }, 'no policy')), unprotectedPane(run?.unprotected)),
          ),
      run ? el('p', { class: 'hint' }, `Steward read ${plural(ctxItems, 'memory')} through Antibody; quarantined and unresolved memories never reached it.`) : null,
    );
  },
};
