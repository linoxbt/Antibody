/**
 * Process-to-process calls between roles (spec §3). Every request is signed
 * with the caller's lane key; the receiver resolves the key's lane from the
 * on-chain bindings and accepts only the lanes each route allows. So the
 * signer only takes requests from control, and only the agent lane can ask
 * control for model context.
 *
 * Transports: HTTP over a Unix socket in $ANTIBODY_HOME/run, or a direct
 * in-process call (tests and the single-process demo harness).
 */
import { createServer, request as httpRequest, type Server } from 'node:http';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { isPipe } from './config.ts';
import { dirname } from 'node:path';
import { randomBytes } from '@noble/hashes/utils.js';
import { bytesToHex, fromBase64Url, sha256Bytes, sha256Hex, toBase64Url, utf8 } from './core/encoding.ts';
import { verifyEd25519, type LaneKey } from './core/keys.ts';
import type { Lane } from './core/types.ts';

const IPC_DOMAIN = 'antibody/ipc/v1\n';
const IPC_RESPONSE_DOMAIN = 'antibody/ipc-response/v1\n';
const MAX_SKEW_MS = 120_000;
/** Largest request body a daemon reads (S13). */
export const MAX_IPC_BODY = 1 << 20;

export interface IpcRequest {
  path: string;
  body: string;
  headers: Record<string, string>;
}

export interface IpcResponse {
  status: number;
  body: string;
  /** x-ab-spub / x-ab-ssig: the serving daemon's signature over this response (S13). */
  headers?: Record<string, string>;
}

/** A daemon's own key for signing responses: control's lane key, or the signer's wallet key. */
export interface ServerKey {
  publicKeyHex: string;
  sign(msg: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

function responseMessage(path: string, nonce: string, status: number, body: string): Uint8Array {
  const digest = sha256Bytes(`${path}\n${nonce}\n${status}\n${sha256Hex(body)}`);
  const d = utf8(IPC_RESPONSE_DOMAIN);
  const out = new Uint8Array(d.length + digest.length);
  out.set(d);
  out.set(digest, d.length);
  return out;
}

export type Transport = (req: IpcRequest) => Promise<IpcResponse>;

function message(path: string, ts: string, nonce: string, body: string): Uint8Array {
  const digest = sha256Bytes(`${path}\n${ts}\n${nonce}\n${sha256Hex(body)}`);
  const d = utf8(IPC_DOMAIN);
  const out = new Uint8Array(d.length + digest.length);
  out.set(d);
  out.set(digest, d.length);
  return out;
}

export class IpcError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class IpcClient {
  constructor(
    private readonly key: LaneKey,
    private readonly transport: Transport,
    private readonly now: () => number = Date.now,
    /**
     * S13: when set, every response must be signed by a key this accepts (e.g. the
     * on-chain antibody:control key, or the key behind Steward's wallet address),
     * so a process that grabbed the socket or pipe first cannot answer for the daemon.
     */
    private readonly verifyServer?: (pub: string) => boolean | Promise<boolean>,
  ) {}

  async call<T>(path: string, payload: unknown = {}): Promise<T> {
    const body = JSON.stringify(payload);
    const ts = String(this.now());
    const nonce = bytesToHex(randomBytes(16));
    const sig = this.key.sign(message(path, ts, nonce, body));
    const res = await this.transport({
      path,
      body,
      headers: { 'x-ab-pub': this.key.publicKeyHex, 'x-ab-ts': ts, 'x-ab-nonce': nonce, 'x-ab-sig': toBase64Url(sig) },
    });
    if (this.verifyServer) {
      const spub = res.headers?.['x-ab-spub'] ?? '';
      let ok = false;
      try {
        ok = /^[0-9a-f]{64}$/.test(spub) && verifyEd25519(fromBase64Url(res.headers?.['x-ab-ssig'] ?? ''), responseMessage(path, nonce, res.status, res.body), spub) && (await this.verifyServer(spub));
      } catch {
        ok = false;
      }
      if (!ok) throw new IpcError(502, `response on ${path} is not signed by the expected daemon; refusing it`);
    }
    const parsed = res.body ? (JSON.parse(res.body) as unknown) : null;
    if (res.status !== 200) {
      const err = (parsed as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
      throw new IpcError(res.status, err);
    }
    return parsed as T;
  }
}

export interface Caller {
  pub: string;
  lane: Lane;
}

export type RouteHandler = (payload: unknown, caller: Caller) => Promise<unknown>;

export interface Route {
  lanes: readonly Lane[];
  handler: RouteHandler;
}

/**
 * Build a request handler. `laneOf` maps a public key to its lane using the
 * current on-chain bindings (refreshed by the caller as needed).
 */
export function createIpcHandler(routes: Record<string, Route>, laneOf: (pub: string) => Promise<Lane | undefined>, now: () => number = Date.now, serverKey?: ServerKey): Transport {
  const seen = new Map<string, number>();
  // A request signed before this daemon started may be a capture replayed across a restart (the nonce cache is in memory).
  const startedAt = now() - 2_000;
  const respond = async (req: IpcRequest, status: number, body: string): Promise<IpcResponse> => {
    if (!serverKey) return { status, body };
    const nonce = req.headers['x-ab-nonce'] ?? '';
    const sig = await serverKey.sign(responseMessage(req.path, nonce, status, body));
    return { status, body, headers: { 'x-ab-spub': serverKey.publicKeyHex, 'x-ab-ssig': toBase64Url(sig) } };
  };
  return async (req) => {
    try {
      if (req.body.length > MAX_IPC_BODY) throw new IpcError(413, 'request body too large');
      const route = routes[req.path];
      if (!route) throw new IpcError(404, `no route ${req.path}`);
      const pub = req.headers['x-ab-pub'] ?? '';
      const ts = req.headers['x-ab-ts'] ?? '';
      const nonce = req.headers['x-ab-nonce'] ?? '';
      const sigB64 = req.headers['x-ab-sig'] ?? '';
      if (!/^[0-9a-f]{32}$/.test(nonce) || !/^\d+$/.test(ts)) throw new IpcError(401, 'missing auth headers');
      const t = Number(ts);
      if (Math.abs(now() - t) > MAX_SKEW_MS) throw new IpcError(401, 'request timestamp outside the allowed window');
      if (t < startedAt) throw new IpcError(401, 'request predates this daemon; sign it again');
      for (const [n, exp] of seen) if (exp < now()) seen.delete(n);
      if (seen.has(nonce)) throw new IpcError(401, 'replayed nonce');
      // S13: reserve the nonce before any await, so concurrent copies of one request cannot all pass.
      seen.set(nonce, t + MAX_SKEW_MS * 2);
      let sig: Uint8Array;
      try {
        sig = fromBase64Url(sigB64);
      } catch {
        throw new IpcError(401, 'bad signature encoding');
      }
      if (!verifyEd25519(sig, message(req.path, ts, nonce, req.body), pub)) throw new IpcError(401, 'bad request signature');
      const lane = await laneOf(pub);
      if (!lane || !route.lanes.includes(lane)) throw new IpcError(403, `lane ${lane ?? 'unknown'} may not call ${req.path}`);
      const out = await route.handler(req.body ? JSON.parse(req.body) : {}, { pub, lane });
      return respond(req, 200, JSON.stringify(out ?? null, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    } catch (e) {
      const status = e instanceof IpcError ? e.status : 500;
      return respond(req, status, JSON.stringify({ error: (e as Error).message }));
    }
  };
}

/** Serve a handler on a Unix socket (mode 0660 inside a 0700 run dir). */
export function serveUnix(socketPath: string, handler: Transport): Promise<Server> {
  // Windows named pipes are not files: nothing to create, clean up or chmod.
  const pipe = isPipe(socketPath);
  if (!pipe) {
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
    if (existsSync(socketPath)) unlinkSync(socketPath);
  }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_IPC_BODY) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'request body too large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (size > MAX_IPC_BODY) return;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      const out = await handler({ path: req.url ?? '/', body: Buffer.concat(chunks).toString('utf8'), headers });
      res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) });
      res.end(out.body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      if (!pipe) chmodSync(socketPath, 0o660);
      resolve(server);
    });
  });
}

export function unixTransport(socketPath: string, timeoutMs = 120_000): Transport {
  return (req) =>
    new Promise((resolve, reject) => {
      const r = httpRequest(
        { socketPath, path: req.path, method: 'POST', headers: { ...req.headers, 'content-type': 'application/json' }, timeout: timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const headers: Record<string, string> = {};
            for (const k of ['x-ab-spub', 'x-ab-ssig']) if (typeof res.headers[k] === 'string') headers[k] = res.headers[k] as string;
            resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString('utf8'), headers });
          });
        },
      );
      // B7: a timeout means the daemon got the request and may still apply it; only a refused
      // or missing socket is "cannot reach" (which callers may fall back on safely).
      let timedOut = false;
      r.on('timeout', () => {
        timedOut = true;
        r.destroy(new Error(`IPC timeout on ${req.path} after ${Math.round(timeoutMs / 1000)} s; the daemon may still complete it`));
      });
      r.on('error', (e) => {
        const code = (e as NodeJS.ErrnoException).code;
        if (timedOut) reject(e);
        else if (code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'EACCES') reject(new Error(`cannot reach ${socketPath} (${(e as Error).message}); is the daemon running?`));
        else reject(new Error(`IPC ${req.path} failed (${(e as Error).message}); the daemon may still complete it`));
      });
      r.end(req.body);
    });
}
