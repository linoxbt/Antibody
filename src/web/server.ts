/**
 * Web view (FR-16, M3): lanes panel, blast-radius graph, split screen against
 * the unprotected agent, quarantine and revoke, both digests. Served by the
 * control process on 127.0.0.1 only. Every /api route except sign-in needs a
 * console session (see auth.ts); state-changing calls also require the
 * x-antibody-ui header so a cross-site form post cannot trigger them.
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { bodyContent } from '../core/envelope.ts';
import { contextEligible } from '../core/projection.ts';
import { LANE_LABEL, type QuarantineSeed } from '../core/types.ts';
import type { Control } from '../control/control.ts';
import { IpcClient, unixTransport } from '../ipc.ts';
import type { Runtime } from '../runtime.ts';
import { Auth, AuthError } from './auth.ts';
import { ipcPath } from '../config.ts';
import { RevokeFlow } from './revoke.ts';
import { zkLoginClient } from '../adapters/zklogin.ts';
import { CrossCheckedChain } from '../adapters/chain-crosscheck.ts';
import { symbolOf } from '../adapters/rates.ts';
import { processHealth } from '../ops/resilience.ts';
import { laneServer } from '../services.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const WEB = join(ROOT, 'web');
export const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};
export const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
/** S15: hardening headers on every response (pages and JSON). */
export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

/**
 * Turn an error into a client answer. Known request mistakes keep their message
 * (4xx); anything internal (file-system errors with paths, type errors) becomes
 * a generic 500, logged instead of echoed (S15).
 */
export function errorAnswer(e: unknown, log?: (msg: string) => void): { status: number; body: { error: string } } {
  if (e instanceof AuthError) return { status: e.status, body: { error: e.message } };
  if (e instanceof SyntaxError) return { status: 400, body: { error: e.message.includes('too large') ? 'request body too large' : 'malformed JSON body' } };
  const err = e as NodeJS.ErrnoException & { issues?: unknown };
  if (err?.name === 'ZodError' || err?.issues) return { status: 400, body: { error: 'invalid request' } };
  if (err?.code || e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError) {
    log?.(`${err?.name ?? 'Error'}: ${err?.message}`);
    return { status: 500, body: { error: 'internal error (see the server log)' } };
  }
  return { status: 400, body: { error: (e as Error)?.message ?? 'request failed' } };
}

/** A JSON body must be a plain object. */
export function asObject(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AuthError(400, 'request body must be a JSON object');
  return v as Record<string, unknown>;
}

/** Pages that moved into the signed-in app. */
export const MOVED: Record<string, string> = { '/console': '/app/steward', '/graph': '/app/memory', '/ledger': '/app/ledger', '/incidents': '/app/incidents' };

/**
 * Whether `p` is inside `root`, with the platform's own separators (Windows
 * paths use backslashes, so a '/' prefix check would reject every file there).
 */
export function isInside(root: string, p: string, paths: Pick<typeof import('node:path'), 'relative' | 'isAbsolute'> = { relative, isAbsolute }): boolean {
  const r = paths.relative(root, p);
  return r !== '' && !r.startsWith('..') && !paths.isAbsolute(r);
}

/** Resolve a URL path to a file under web/ (clean URLs: /login → login.html). Never escapes web/. */
export function staticFile(pathname: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel.includes('\\') || rel.includes('\0')) return null;
  const candidates = rel.endsWith('/') ? [`${rel}index.html`] : [rel, `${rel}.html`];
  for (const c of candidates) {
    const p = resolve(WEB, `.${c}`);
    if (!isInside(WEB, p)) return null;
    if (existsSync(p) && statSync(p).isFile() && TYPES[extname(p)]) return p;
  }
  // The app is a single page; its client-side routes all load app.html.
  if (rel === '/app' || rel.startsWith('/app/')) return join(WEB, 'app.html');
  // The recorded walkthrough lives in site/ once `scripts/build-site.ts` has run.
  if (rel === '/demo.json' && existsSync(join(ROOT, 'site', 'demo.json'))) return join(ROOT, 'site', 'demo.json');
  if (/^\/reports\/[\w.-]+\.json$/.test(rel) && existsSync(join(ROOT, 'site', rel))) return join(ROOT, 'site', rel);
  return null;
}

const pexec = promisify(execFile);

/** JSON request body, refused past `limit` bytes. */
export async function readBody(req: IncomingMessage, limit = 1 << 20): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new SyntaxError('request body too large');
    chunks.push(c as Buffer);
  }
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

export async function stateJson(rt: Runtime, control: Control) {
  const snap = await control.snapshot();
  const p = snap.projection;
  const ledger = snap.ledger;
  const nodes = p.lineage.order.map((id) => {
    const n = p.lineage.nodes.get(id)!;
    const h = n.env.header;
    return {
      id,
      lane: h.lane,
      kind: h.kind,
      cls: n.cls,
      quarantined: n.quarantined,
      unresolved: n.unresolved,
      eligible: contextEligible(n),
      seedHits: n.seedHits,
      parents: h.parents,
      src: h.src,
      turn: h.turn,
      ckpt: h.ckpt,
      blobIds: n.blobIds,
      text: bodyContent(n.env.body),
      notes: n.notes,
    };
  });
  // Display only: USD for the coins payees are paid in (and SUI for gas).
  const symbols = [...new Set([...(ledger.ok ? ledger.payees.map((p) => symbolOf(p.coinType)) : []), 'SUI'].filter((x): x is string => !!x))];
  const rates = await rt.rates.usd(symbols).catch(() => ({}));
  return {
    simulated: rt.simulated,
    banners: rt.banners,
    health: processHealth.snapshot(),
    backend: rt.cfg.backend,
    network: rt.cfg.network,
    chain: rt.chain.kind,
    account: { id: snap.account.accountId, owner: snap.account.owner, active: snap.account.active },
    wallet: rt.cfg.stewardWallet,
    checkpoint: snap.ckpt,
    lanes: (p.bindings?.all() ?? []).map((b) => ({ ...b, label: LANE_LABEL[b.lane] })),
    ledger: ledger.ok
      ? {
          ok: true,
          head: ledger.head,
          firstSync: ledger.firstSync,
          payees: ledger.payees,
          quarantines: ledger.quarantines,
          lessons: ledger.lessons,
          revocations: ledger.revocations,
          rotations: ledger.rotations,
          records: ledger.records.map((r) => ({ seq: r.record.seq, type: r.record.type, lane: r.env.header.lane, blobId: r.blobIds[0], envelopeId: r.env.header.id, payload: r.record.payload })),
        }
      : { ok: false, code: ledger.code, detail: ledger.detail },
    nodes,
    failed: p.lineage.forensic,
    digest: p.digest,
    coverage: p.coverage,
    incidents: control.incidents.list().slice(-20).reverse(),
    crossCheck: rt.chain instanceof CrossCheckedChain ? rt.chain.status() : null,
    rates,
    reports: control.reportLog.list(),
  };
}

/** Where the operator link token is written (0600) for `antibody up` and `antibody login` to print. */
export function tokenPath(rt: Runtime): string {
  return join(rt.cfg.home, 'run', 'web-token');
}

export async function startWeb(rt: Runtime, control: Control, port: number, auth?: Auth): Promise<{ server: Server; auth: Auth }> {
  const a = auth ?? new Auth(async () => (await control.snapshot()).account.owner, { operatorToken: process.env.ANTIBODY_WEB_TOKEN || undefined, client: zkLoginClient(), requireSessionHeader: true });
  // S6: only these Host values are this console. Anything else is DNS rebinding (an attacker's name pointed at 127.0.0.1).
  const hosts = () => {
    const p = (server.address() as { port: number } | null)?.port ?? port;
    return new Set([`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]);
  };
  const revoke = new RevokeFlow(rt, control);
  mkdirSync(join(rt.cfg.home, 'run'), { recursive: true, mode: 0o700 });
  // Replace rather than rewrite: a token file left by another OS user (a single-user install moved to
  // one user per role) cannot be chmod-ed by this one, and must not stay readable as it was.
  rmSync(tokenPath(rt), { force: true });
  writeFileSync(tokenPath(rt), a.operatorToken, { mode: 0o600, flag: 'wx' });
  chmodSync(tokenPath(rt), 0o600);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers });
      res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    };
    try {
      const allowed = hosts();
      if (!allowed.has(String(req.headers.host ?? '').toLowerCase())) return send(421, { error: 'this console only answers on 127.0.0.1 / localhost' });
      if (req.method === 'POST') {
        // S6: a page on another site can never post here, even if it reached the port.
        const origin = req.headers.origin;
        if (origin && !allowed.has(origin.replace(/^https?:\/\//, '').toLowerCase())) return send(403, { error: 'cross-origin request refused' });
        if (req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'cross-site request refused' });
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && MOVED[url.pathname]) {
        res.writeHead(301, { location: MOVED[url.pathname] + url.search, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      // B15: HEAD gets the same status and headers as GET, without the body.
      if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
        const file = staticFile(url.pathname);
        const status = file ? 200 : 404;
        const path = file ?? join(WEB, '404.html');
        const bytes = readFileSync(path); // before writeHead, so a read error still gets a clean 500
        res.writeHead(status, { 'content-type': TYPES[extname(path)]!, 'cache-control': 'no-store', 'content-security-policy': CSP, ...SECURITY_HEADERS });
        res.end(req.method === 'HEAD' ? undefined : bytes);
        return;
      }
      const session = a.fromCookie(req.headers.cookie, req.headers['x-antibody-session']);
      if (req.method === 'GET' && url.pathname === '/api/auth/status') {
        return send(200, { node: true, authenticated: !!session, method: session?.method ?? null, address: session?.address ?? null, expiresAt: session?.expiresAt ?? null });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/auth/')) {
        if (req.headers['x-antibody-ui'] !== '1') return send(403, { error: 'missing x-antibody-ui header' });
        const body = asObject(await readBody(req));
        // The Host was checked above, so the challenge can only name this console.
        if (url.pathname === '/api/auth/challenge') return send(200, a.challenge(String(body.address ?? ''), `http://${String(req.headers.host).toLowerCase()}`));
        if (url.pathname === '/api/auth/logout') {
          if (session) a.end(session.id);
          else a.endByCookie(req.headers.cookie);
          return send(200, { ok: true }, { 'set-cookie': a.clearCookieHeader() });
        }
        const s =
          url.pathname === '/api/auth/wallet'
            ? await a.signInWithWallet(String(body.address ?? ''), String(body.message ?? ''), String(body.signature ?? ''))
            : url.pathname === '/api/auth/operator'
              ? a.signInWithOperatorToken(String(body.token ?? ''))
              : null;
        if (!s) return send(404, { error: 'not found' });
        // csrf: the page keeps it in localStorage and sends it as x-antibody-session (S11).
        return send(200, { authenticated: true, method: s.method, address: s.address, expiresAt: s.expiresAt, csrf: s.csrf }, { 'set-cookie': a.cookie(s) });
      }
      if (url.pathname.startsWith('/api/') && !session) return send(401, { error: 'sign in required' });
      if (req.method === 'GET' && url.pathname === '/api/state') return send(200, await stateJson(rt, control));
      if (req.method !== 'POST') return send(404, { error: 'not found' });
      if (req.headers['x-antibody-ui'] !== '1') return send(403, { error: 'missing x-antibody-ui header' });
      const body = asObject(await readBody(req));

      if (url.pathname === '/api/quarantine') {
        const seed: QuarantineSeed = { type: body.type as QuarantineSeed['type'], value: String(body.value) };
        // B15: a quarantine record is permanent; one that matches nothing needs an explicit yes.
        if (body.force !== true) {
          const pv = await control.preview(seed);
          if (pv.memories === 0) return send(409, { error: 'this seed matches nothing right now; send force: true to write the quarantine anyway', memories: 0 });
        }
        const q = await control.quarantine(seed, String(body.reason ?? 'quarantined from the web view'), [seed.value], false);
        return send(200, { seq: q.seq, lessonSeq: q.lessonSeq, memories: q.radius.memories.length, decisions: q.radius.decisions.length });
      }
      if (url.pathname === '/api/preview') {
        const pv = await control.preview({ type: body.type as QuarantineSeed['type'], value: String(body.value) });
        return send(200, { memories: pv.memories, decisions: pv.decisions, txDigests: pv.txDigests, ids: pv.radius.memories.map((m) => m.id) });
      }
      if (url.pathname === '/api/run') {
        const instruction = String(body.instruction ?? '');
        const execute = body.execute === true;
        // Protected: the agent daemon runs the real Steward turn (agent key + LLM key live there).
        const agent = new IpcClient(control.d.key, unixTransport(ipcPath(rt.cfg, 'agent'), 300_000), Date.now, laneServer(rt, 'agent'));
        const [prot, unprot] = await Promise.allSettled([
          agent.call('/turn', { instruction, execute }),
          agent.call('/compare', { instruction }),
        ]);
        return send(200, {
          protected: prot.status === 'fulfilled' ? prot.value : { error: (prot.reason as Error).message },
          unprotected: unprot.status === 'fulfilled' ? unprot.value : { error: (unprot.reason as Error).message },
        });
      }
      if (url.pathname === '/api/rebuild') {
        // A fresh process with an empty cache, reading only Walrus and Sui.
        const { stdout } = await pexec(process.execPath, [join(ROOT, 'bin', 'antibody.mjs'), 'rebuild', '--fresh', '--json'], { env: { ...process.env, ANTIBODY_ROLE: 'control', NO_COLOR: '1' }, timeout: 300_000 });
        const line = stdout.trim().split('\n').filter((l) => l.startsWith('{')).at(-1);
        return send(200, line ? JSON.parse(line) : { error: stdout });
      }
      if (url.pathname === '/api/revoke/prepare') return send(200, await revoke.prepare(String(body.lane ?? '')));
      if (url.pathname === '/api/revoke/submit') return send(200, await revoke.submit(String(body.id ?? ''), { signature: String(body.signature ?? ''), ...(typeof body.bytes === 'string' ? { bytes: body.bytes } : {}) }));
      if (url.pathname === '/api/report') {
        const r = await control.report(Number(body.seq));
        return send(200, r.upload);
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      const r = errorAnswer(e, (m) => rt.log.warn('web.error', { path: url.pathname, error: m }));
      return send(r.status, r.body);
    }
  });
  return new Promise((resolveP) => server.listen(port, '127.0.0.1', () => resolveP({ server, auth: a })));
}
