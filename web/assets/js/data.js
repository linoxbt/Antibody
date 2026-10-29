// Where the page's data comes from.
//  live:     the control process's /api (antibody up → http://127.0.0.1:7402)
//  recorded: demo.json, a walkthrough recorded by running the real code on the
//            offline backend (the public site has no control process behind it)

const STEP_KEY = 'antibody.step';

async function getJson(path, body) {
  const res = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json', 'x-antibody-ui': '1' }, body: JSON.stringify(body) });
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('json')) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

export class ReadOnlyError extends Error {}

export async function loadSource() {
  try {
    const state = await getJson('/api/state');
    return {
      mode: 'live',
      state,
      steps: null,
      index: 0,
      async refresh() {
        this.state = await getJson('/api/state');
        return this.state;
      },
      api: (path, body) => getJson(path, body),
      setIndex() {},
    };
  } catch {
    const demo = await getJson('/demo.json');
    let index = Number(new URLSearchParams(location.search).get('step'));
    if (!Number.isInteger(index) || index < 1) {
      try {
        index = Number(localStorage.getItem(STEP_KEY)) || demo.steps.length;
      } catch {
        index = demo.steps.length;
      }
    }
    index = Math.min(Math.max(index, 1), demo.steps.length) - 1;
    return {
      mode: 'recorded',
      demo,
      steps: demo.steps,
      index,
      get state() {
        return demo.steps[this.index].state;
      },
      async refresh() {
        return this.state;
      },
      api() {
        throw new ReadOnlyError('Read-only recording. Run it live with antibody up.');
      },
      setIndex(i) {
        this.index = Math.min(Math.max(i, 0), demo.steps.length - 1);
        try {
          localStorage.setItem(STEP_KEY, String(this.index + 1));
        } catch {
          /* storage unavailable */
        }
      },
    };
  }
}

export async function loadDemo() {
  return getJson('/demo.json');
}
