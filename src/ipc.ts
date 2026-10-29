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
import { dirname } from 'node:path';
import { randomBytes } from '@noble/hashes/utils.js';
import { bytesToHex, fromBase64Url, sha256Bytes, sha256Hex, toBase64Url, utf8 } from './core/encoding.ts';
import { verifyEd25519, type LaneKey } from './core/keys.ts';
import type { Lane } from './core/types.ts';

const IPC_DOMAIN = 'antibody/ipc/v1\n';
const MAX_SKEW_MS = 120_000;

export interface IpcRequest {
  path: string;
  body: string;
  headers: Record<string, string>;
}

export interface IpcResponse {
  status: number;
  body: string;
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
export function createIpcHandler(routes: Record<string, Route>, laneOf: (pub: string) => Promise<Lane | undefined>, now: () => number = Date.now): Transport {
  const seen = new Map<string, number>();
  return async (req) => {
    try {
      const route = routes[req.path];
      if (!route) throw new IpcError(404, `no route ${req.path}`);
      const pub = req.headers['x-ab-pub'] ?? '';
      const ts = req.headers['x-ab-ts'] ?? '';
      const nonce = req.headers['x-ab-nonce'] ?? '';
      const sigB64 = req.headers['x-ab-sig'] ?? '';
      if (!/^[0-9a-f]{32}$/.test(nonce) || !/^\d+$/.test(ts)) throw new IpcError(401, 'missing auth headers');
      const t = Number(ts);
      if (Math.abs(now() - t) > MAX_SKEW_MS) throw new IpcError(401, 'request timestamp outside the allowed window');
      for (const [n, exp] of seen) if (exp < now()) seen.delete(n);
      if (seen.has(nonce)) throw new IpcError(401, 'replayed nonce');
      let sig: Uint8Array;
      try {
        sig = fromBase64Url(sigB64);
      } catch {
        throw new IpcError(401, 'bad signature encoding');
      }
      if (!verifyEd25519(sig, message(req.path, ts, nonce, req.body), pub)) throw new IpcError(401, 'bad request signature');
      const lane = await laneOf(pub);
      if (!lane || !route.lanes.includes(lane)) throw new IpcError(403, `lane ${lane ?? 'unknown'} may not call ${req.path}`);
      seen.set(nonce, t + MAX_SKEW_MS * 2);
      const out = await route.handler(req.body ? JSON.parse(req.body) : {}, { pub, lane });
      return { status: 200, body: JSON.stringify(out ?? null, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) };
    } catch (e) {
      const status = e instanceof IpcError ? e.status : 500;
      return { status, body: JSON.stringify({ error: (e as Error).message }) };
    }
  };
}

/** Serve a handler on a Unix socket (mode 0660 inside a 0700 run dir). */
export function serveUnix(socketPath: string, handler: Transport): Promise<Server> {
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      const out = await handler({ path: req.url ?? '/', body: Buffer.concat(chunks).toString('utf8'), headers });
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(out.body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o660);
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
          res.on('end', () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      r.on('timeout', () => r.destroy(new Error(`IPC timeout on ${req.path}`)));
      r.on('error', (e) => reject(new Error(`cannot reach ${socketPath} (${(e as Error).message}); is the daemon running?`)));
      r.end(req.body);
    });
}
