// Routes for /api/v1 and its OpenAPI 3.1 document. Every response is JSON; errors are { error, status }.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GuardData, HttpError } from './api.ts';

export interface V1Deps {
  data: GuardData;
  /** Rate limit for read routes (per client). */
  allowRead: (req: IncomingMessage) => boolean;
  /** POST /score and POST /watch, sharing the existing handlers and their limits. */
  score: (body: any, req: IncomingMessage, res: ServerResponse) => Promise<void>;
  watch: (body: any, req: IncomingMessage, res: ServerResponse) => Promise<void>;
  readJson: (req: IncomingMessage) => Promise<any>;
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' };

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...CORS });
  res.end(JSON.stringify(body));
}

/** Handle /api/v1/*; returns false when the path is not a v1 route. */
export async function handleV1(req: IncomingMessage, res: ServerResponse, url: URL, d: V1Deps): Promise<boolean> {
  if (!url.pathname.startsWith('/api/v1')) return false;
  const p = url.pathname.replace(/\/+$/, '').split('/').slice(3).map(decodeURIComponent); // after /api/v1
  const ok = (body: unknown) => sendJson(res, 200, body);
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return true; }
    if (req.method === 'POST') {
      const body = await d.readJson(req);
      if (p[0] === 'score' && p.length === 1) { await d.score(body, req, res); return true; }
      if (p[0] === 'watch' && p.length === 1) { await d.watch({ chain: body.chain, vault: body.address ?? body.vault }, req, res); return true; }
      throw new HttpError(404, 'not found');
    }
    if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
    if (p.length === 1 && p[0] === 'openapi.json') { ok(OPENAPI); return true; }
    if (!d.allowRead(req)) throw new HttpError(429, 'at most 120 requests a minute from one client');
    const limit = Number(url.searchParams.get('limit') ?? 50) || 50;
    if (p.length === 0) ok({ name: 'Antibody Guard API', version: 'v1', openapi: '/api/v1/openapi.json', routes: Object.keys(OPENAPI.paths) });
    else if (p[0] === 'status' && p.length === 1) ok(d.data.status());
    else if (p[0] === 'check' && p.length === 2) ok(await d.data.check(p[1]!));
    else if (p[0] === 'attackers' && p.length === 1) ok(d.data.attackers());
    else if (p[0] === 'attackers' && p.length === 2) ok(await d.data.attacker(p[1]!));
    else if (p[0] === 'vaults' && p.length === 1) ok(d.data.vaults());
    else if (p[0] === 'vaults' && p.length === 3) ok(await d.data.vault(p[1]!, p[2]!));
    else if (p[0] === 'memories' && p.length === 1) ok(d.data.memories());
    else if (p[0] === 'memories' && p.length === 5 && p[3] === 'entries') ok(await d.data.recall(p[1]!, p[2]!, p[4]!));
    else if (p[0] === 'memories' && p.length === 5 && p[3] === 'sources') ok(await d.data.source(p[1]!, p[2]!, p[4]!));
    else if (p[0] === 'loops' && p.length === 1) ok(d.data.loops(limit));
    else if (p[0] === 'events' && p.length === 1) ok(d.data.events(limit));
    else throw new HttpError(404, 'not found: see /api/v1/openapi.json');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : (e as any).status ?? 500;
    if (status === 500) console.error('v1', (e as Error).message.split('\n')[0]);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'internal error' : (e as Error).message, status });
  }
  return true;
}

// ---- OpenAPI ------------------------------------------------------------------------------------

const address = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', examples: ['0x00000000000000000000000000000000bad3e301'] };
const chain = { type: 'string', enum: ['baseSepolia', 'sepolia'] };
const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const json = (schema: object, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const pathParam = (name: string, schema: object, description: string) => ({ name, in: 'path', required: true, schema, description });

export const OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'Antibody Guard API',
    version: '1.0.0',
    description: 'What GuardReactive (Reactive Network) knows about attackers, and the vaults and memories it protects. Reads are public and rate-limited (120 a minute per client). Testnets: Base Sepolia, Ethereum Sepolia, Reactive Lasna.',
    license: { name: 'MIT' },
  },
  servers: [{ url: 'https://antibody-guard-reactive.netlify.app' }, { url: 'https://antibody-guard-production.up.railway.app' }],
  paths: {
    '/api/v1/status': { get: { summary: 'GuardReactive, its reserves, and how many lessons, vaults and memories', responses: { 200: json({ type: 'object' }), 429: err } } },
    '/api/v1/check/{address}': { get: { summary: 'Is this address a known attacker? Ask before paying or trusting it.', parameters: [pathParam('address', address, 'Any EVM address')], responses: { 200: json({ $ref: '#/components/schemas/Check' }), 400: err, 429: err } } },
    '/api/v1/attackers': { get: { summary: 'Every lesson in GuardReactive, with how it was caught', responses: { 200: json({ type: 'array', items: { $ref: '#/components/schemas/AttackerSummary' } }) } } },
    '/api/v1/attackers/{address}': { get: { summary: 'Where an attacker is blocked (read from every watched contract now) and every decision about it', parameters: [pathParam('address', address, 'The attacker')], responses: { 200: json({ type: 'object' }), 400: err } } },
    '/api/v1/vaults': { get: { summary: 'Every GuardVault GuardReactive watches', responses: { 200: json({ type: 'array', items: { type: 'object' } }) } } },
    '/api/v1/vaults/{chain}/{address}': { get: { summary: 'One vault, with its recent events', parameters: [pathParam('chain', chain, 'Origin chain'), pathParam('address', address, 'The vault')], responses: { 200: json({ type: 'object' }), 404: err } } },
    '/api/v1/memories': { get: { summary: 'Every GuardMemory GuardReactive watches', responses: { 200: json({ type: 'array', items: { type: 'object' } }) } } },
    '/api/v1/memories/{chain}/{address}/entries/{id}': { get: { summary: 'Recall a memory entry: its source, and whether the agent may act on it', parameters: [pathParam('chain', chain, 'Origin chain'), pathParam('address', address, 'The GuardMemory'), pathParam('id', { type: 'integer', minimum: 1 }, 'Entry id')], responses: { 200: json({ $ref: '#/components/schemas/Recall' }), 404: err } } },
    '/api/v1/memories/{chain}/{address}/sources/{source}': { get: { summary: 'Everything a source wrote into a memory, and whether it is quarantined there', parameters: [pathParam('chain', chain, 'Origin chain'), pathParam('address', address, 'The GuardMemory'), pathParam('source', address, 'The source')], responses: { 200: json({ type: 'object' }) } } },
    '/api/v1/loops': { get: { summary: 'Recent decisions: origin → reaction → callback, with timings', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } }], responses: { 200: json({ type: 'array', items: { type: 'object' } }) } } },
    '/api/v1/events': { get: { summary: 'Recent events from the vaults, memories, the RiskOracle and GuardReactive', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } }], responses: { 200: json({ type: 'array', items: { type: 'object' } }) } } },
    '/api/v1/score': { post: { summary: 'The AI risk scorer: score a message; an address it flags at 80+ is reported on-chain and quarantined everywhere', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['body'], properties: { from: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string', maxLength: 2000 } } } } } }, responses: { 200: json({ type: 'object' }), 400: err, 429: err, 503: err } } },
    '/api/v1/watch': { post: { summary: 'Ask GuardReactive to watch your GuardVault or GuardMemory (its guardian must already be GuardReactive)', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['chain', 'address'], properties: { chain, address } } } } }, responses: { 200: json({ type: 'object' }), 400: err, 409: err, 429: err } } },
  },
  components: {
    schemas: {
      Error: { type: 'object', properties: { error: { type: 'string' }, status: { type: 'integer' } } },
      Check: { type: 'object', properties: { address, knownAttacker: { type: 'boolean' }, verdict: { type: 'string', enum: ['block', 'unknown'] }, advice: { type: 'string' } } },
      AttackerSummary: { type: 'object', properties: { index: { type: 'integer' }, address, caughtBy: { type: ['object', 'null'] }, decisions: { type: 'integer' } } },
      Recall: { type: 'object', properties: { chain, memory: address, id: { type: 'integer' }, contentHash: { type: 'string' }, source: address, kind: { type: 'string' }, writtenAt: { type: 'string', format: 'date-time' }, status: { type: 'string', enum: ['usable', 'quarantined-source', 'forgotten'] }, usable: { type: 'boolean' } } },
    },
  },
} as const;
