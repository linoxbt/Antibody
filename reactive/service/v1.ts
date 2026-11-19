// Routes for /api/v1 and its OpenAPI 3.1 document. Every response is JSON; errors are { error, status }.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GuardData, HttpError } from './api.ts';
import { activity, clientOf, isConsole, viaOf, type ActivityEntry } from './activity.ts';

export interface V1Deps {
  data: GuardData;
  /** Rate limit for read routes (per client). */
  allowRead: (req: IncomingMessage) => boolean;
  /** POST /score and POST /watch, sharing the existing handlers and their limits. */
  score: (body: any, req: IncomingMessage, res: ServerResponse) => Promise<void>;
  watch: (body: any, req: IncomingMessage, res: ServerResponse) => Promise<void>;
  readJson: (req: IncomingMessage) => Promise<any>;
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-guard-client, x-guard-via', 'access-control-max-age': '86400' };

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
    if (p.length === 1 && p[0] === 'activity') { ok({ entries: activity.recent(Number(url.searchParams.get('limit') ?? 100) || 100), counts: activity.counts() }); return true; }
    if (!d.allowRead(req)) throw new HttpError(429, 'at most 120 requests a minute from one client');
    const limit = Number(url.searchParams.get('limit') ?? 50) || 50;
    let route = '';
    let body: unknown;
    try {
      if (p.length === 0) { route = 'index'; body = { name: 'Antibody Guard API', version: 'v1', openapi: '/api/v1/openapi.json', routes: Object.keys(OPENAPI.paths) }; }
      else if (p[0] === 'status' && p.length === 1) { route = 'status'; body = d.data.status(); }
      else if (p[0] === 'check' && p.length === 2) { route = 'check'; body = await d.data.check(p[1]!); }
      else if (p[0] === 'attackers' && p.length === 1) { route = 'attackers'; body = d.data.attackers(); }
      else if (p[0] === 'attackers' && p.length === 2) { route = 'attacker'; body = await d.data.attacker(p[1]!); }
      else if (p[0] === 'vaults' && p.length === 1) { route = 'vaults'; body = d.data.vaults(); }
      else if (p[0] === 'vaults' && p.length === 3) { route = 'vault'; body = await d.data.vault(p[1]!, p[2]!); }
      else if (p[0] === 'memories' && p.length === 1) { route = 'memories'; body = d.data.memories(); }
      else if (p[0] === 'memories' && p.length === 5 && p[3] === 'entries') { route = 'recall'; body = await d.data.recall(p[1]!, p[2]!, p[4]!); }
      else if (p[0] === 'memories' && p.length === 5 && p[3] === 'sources') { route = 'source'; body = await d.data.source(p[1]!, p[2]!, p[4]!); }
      else if (p[0] === 'loops' && p.length === 1) { route = 'loops'; body = d.data.loops(limit); }
      else if (p[0] === 'events' && p.length === 1) { route = 'events'; body = d.data.events(limit); }
      else throw new HttpError(404, 'not found: see /api/v1/openapi.json');
    } catch (e) {
      if (route) recordRead(req, route, p, undefined, e as Error);
      throw e;
    }
    recordRead(req, route, p, body);
    ok(body);
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
    '/api/v1/activity': { get: { summary: 'The public activity feed: recent calls through MCP, the SDK, the API and the site (tool, client kind, subject, answer; never message text or IPs)', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 300 } }], responses: { 200: json({ type: 'object' }) } } },
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

// ---- activity ----------------------------------------------------------------------------------

/** The MCP tool behind each route, so a call through MCP is shown by the tool the agent used. */
const TOOL: Record<string, string> = {
  status: 'guard_status', check: 'guard_check_address', attackers: 'guard_list_attackers', attacker: 'guard_attacker_details',
  vaults: 'guard_list_vaults', vault: 'vault', memories: 'guard_list_memories', recall: 'guard_recall_memory',
  source: 'guard_audit_source', loops: 'guard_recent_decisions', events: 'events', index: 'index', score: 'guard_score_message', watch: 'watch',
};

export function toolName(route: string, via: ActivityEntry['via']) {
  return via === 'mcp' || via === 'mcp-local' ? TOOL[route] ?? route : `/api/v1/${route}`;
}

function recordRead(req: IncomingMessage, route: string, p: string[], body: any, err?: Error) {
  if (isConsole(req) || route === 'index') return;
  const via = viaOf(req, 'api');
  const base = { via, client: clientOf(req), tool: toolName(route, via) };
  if (err) return activity.record({ ...base, result: 'error', tone: 'warn', error: err.message.slice(0, 120), subject: subjectOf(route, p) });
  let result = 'answered', tone: ActivityEntry['tone'] = 'plain';
  if (route === 'check') { result = body.knownAttacker ? 'block: known attacker' : 'not a known attacker'; tone = body.knownAttacker ? 'bad' : 'ok'; }
  else if (route === 'attacker') { const n = (body.blockedOn ?? []).filter((b: any) => b.quarantined).length; result = body.knownAttacker ? `blocked on ${n} of ${(body.blockedOn ?? []).length}` : 'not a known attacker'; tone = body.knownAttacker ? 'bad' : 'ok'; }
  else if (route === 'recall') { result = body.usable ? 'usable' : `not usable: ${body.status}`; tone = body.usable ? 'ok' : 'bad'; }
  else if (route === 'source') { result = `${body.quarantined ? 'quarantined' : 'not quarantined'} · ${body.entries?.length ?? 0} entries`; tone = body.quarantined ? 'bad' : 'ok'; }
  else if (route === 'status') { const n = (k: string, one: string, many: string) => { const c = body.counts?.[k] ?? 0; return `${c} ${c === 1 ? one : many}`; }; result = `${n('lessons', 'lesson', 'lessons')} · ${n('vaults', 'vault', 'vaults')} · ${n('memories', 'memory', 'memories')}`; }
  else if (Array.isArray(body)) result = `${body.length} listed`;
  activity.record({ ...base, result, tone, subject: subjectOf(route, p) });
}

function subjectOf(route: string, p: string[]): ActivityEntry['subject'] {
  if (route === 'check' || route === 'attacker') return p[1] ? { kind: 'address', address: p[1] } : undefined;
  if (route === 'vault') return { kind: 'contract', chain: p[1], address: p[2]! };
  if (route === 'recall') return { kind: 'memory', chain: p[1], address: p[2]!, id: Number(p[4]) };
  if (route === 'source') return { kind: 'memory', chain: p[1], address: p[2]!, source: p[4] };
  return undefined;
}
