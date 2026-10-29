// Where the console's data comes from.
//  live:     the control process's /api (antibody up → http://127.0.0.1:7402),
//            behind a console session (sign in with the owner wallet or the
//            operator link)
//  recorded: demo.json, a walkthrough recorded by running the real code on the
//            offline backend (the public site has no control process behind it)

const STEP_KEY = 'antibody.step';
const DEMO_KEY = 'antibody.demo';

export class ReadOnlyError extends Error {}
export class AuthRequired extends Error {}

async function getJson(path, body) {
  const res = await fetch(path, body === undefined ? { cache: 'no-store', credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-antibody-ui': '1' }, body: JSON.stringify(body) });
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('json')) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (res.status === 401 && !path.startsWith('/api/auth/')) throw new AuthRequired(j.error ?? 'sign in required');
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

export const api = getJson;

/** { node, authenticated, method, address } from a control process, or null when no node answers (static hosting). */
export async function authStatus() {
  try {
    const s = await getJson('/api/auth/status');
    return s && s.node ? s : null;
  } catch {
    return null;
  }
}

export async function signOut() {
  try {
    await getJson('/api/auth/logout', {});
  } catch {
    /* no node behind this page */
  }
  setDemo(false);
}

export function demoChosen() {
  try {
    return sessionStorage.getItem(DEMO_KEY) === '1';
  } catch {
    return false;
  }
}

export function setDemo(on) {
  try {
    if (on) sessionStorage.setItem(DEMO_KEY, '1');
    else sessionStorage.removeItem(DEMO_KEY);
  } catch {
    /* storage unavailable */
  }
}

export async function liveSource() {
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
}

export async function recordedSource() {
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
      throw new ReadOnlyError('Read-only demo. Run it live with antibody up and sign in.');
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

export async function loadDemo() {
  return getJson('/demo.json');
}
