// The Guard service: the indexer's view of the three chains, and a public endpoint where anyone can hand
// the AI risk scorer a message. If the model flags an address that money is being redirected to, the
// scorer reports it to the RiskOracle and GuardReactive quarantines it on every vault, live.
//
//   GET  /api/health   liveness
//   GET  /api/state    vaults, GuardReactive, live and recorded loops, recent events
//   POST /api/score    { from?, subject?, body } -> the model's verdict, and any on-chain report
//   POST /api/watch    { chain, vault } -> GuardReactive starts watching a visitor's own GuardVault
//
// Limits: 2,000 characters per message; per client 3 scorings per 10 minutes; overall 30 model calls and
// 12 on-chain reports per hour. A report can only restrict (quarantine); registered payees are never
// reported. Watch requests: only a genuine GuardVault whose guardian is already GuardReactive (which only
// its owner can set), not yet watched, under the cap; 2 per client per hour, 6 overall. Env: PORT,
// GUARD_SCORER_KEY (testnet key allowed on the RiskOracle), GUARD_REGISTRAR_KEY (GuardReactive's
// registrar: may only add and remove vaults), LLM_API_KEY, optionally LLM_BASE_URL / LLM_MODEL.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { isAddress, getAddress, type Hex } from 'viem';
import { NETWORKS } from '../networks.ts';
import { abiOf, clients, lasnaFees, testnetKey, type NetworkName } from '../scripts/lib.ts';
import { Indexer } from './indexer.ts';
import { scoreAndReport } from '../agent/scorer.ts';

const PORT = Number(process.env.PORT ?? 8787);
const indexer = new Indexer();
const started = Date.now();

class Window {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private ms: number) {}
  take(key: string): boolean {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.ms);
    if (list.length >= this.max) { this.hits.set(key, list); return false; }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.hits.delete(this.hits.keys().next().value!);
    return true;
  }
}
const perClient = new Window(3, 10 * 60_000);
const modelCalls = new Window(30, 60 * 60_000);
const reports = new Window(12, 60 * 60_000);
const watchPerClient = new Window(2, 60 * 60_000);
const watches = new Window(6, 60 * 60_000);

const codeOf = (c: string) => JSON.parse(readFileSync(new URL(`../abi/${c}.code.json`, import.meta.url), 'utf8'));
const CODES = { vault: codeOf('GuardVault'), memory: codeOf('GuardMemory') };
/** Zero the bytes the constructor fills in (owner, callback proxy), so any deployment of a contract compares equal. */
function masked(code: string, refsOf: any): string {
  const hex = code.toLowerCase().replace(/^0x/, '').split('');
  for (const refs of Object.values(refsOf ?? {}) as { start: number; length: number }[][]) {
    for (const { start, length } of refs) for (let i = start * 2; i < (start + length) * 2; i++) hex[i] = '0';
  }
  return hex.join('');
}
const GENUINE = { vault: masked(CODES.vault.deployedBytecode, CODES.vault.immutableReferences), memory: masked(CODES.memory.deployedBytecode, CODES.memory.immutableReferences) };
/** 'vault' or 'memory' when the runtime code is one of this repository's contracts, otherwise null. */
function genuineKind(code: string | undefined): 'vault' | 'memory' | null {
  if (!code) return null;
  if (masked(code, CODES.vault.immutableReferences) === GENUINE.vault) return 'vault';
  if (masked(code, CODES.memory.immutableReferences) === GENUINE.memory) return 'memory';
  return null;
}

async function watchVault(req: IncomingMessage, res: ServerResponse) {
  const body = await readJson(req);
  const chain = String(body.chain ?? '') as NetworkName;
  if (chain !== 'baseSepolia' && chain !== 'sepolia') return send(res, 400, { error: 'chain must be baseSepolia or sepolia' });
  if (!isAddress(String(body.vault ?? ''))) return send(res, 400, { error: 'vault must be an address' });
  const vault = getAddress(String(body.vault)) as Hex;
  if (!process.env.GUARD_REGISTRAR_KEY && !process.env.HTTPS_PROXY) return send(res, 503, { error: 'watch requests are not configured on this server' });
  const d = indexer.d;
  const pub = clients(chain, ('0x' + '11'.repeat(32)) as Hex).pub;
  const code = await pub.getCode({ address: vault });
  const kind = genuineKind(code);
  if (!kind) return send(res, 400, { error: 'that address is not a GuardVault or GuardMemory built from this repository' });
  const guardian = (await pub.readContract({ address: vault, abi: abiOf(kind === 'vault' ? 'GuardVault' : 'GuardMemory'), functionName: 'guardian' })) as string;
  if (guardian.toLowerCase() !== d.guard.toLowerCase()) return send(res, 400, { error: `set the vault's guardian to GuardReactive (${d.guard}) first; only its owner can` });
  const reg = clients('lasna', testnetKey('registrar'));
  const rxAbi = abiOf('GuardReactive');
  const w = (await reg.pub.readContract({ address: d.guard, abi: rxAbi, functionName: 'watched', args: [BigInt(NETWORKS[chain].chainId), vault] })) as unknown as [boolean];
  if (w[0]) return send(res, 409, { error: 'GuardReactive already watches this vault' });
  if (Number(await reg.pub.readContract({ address: d.guard, abi: rxAbi, functionName: 'vaultCount' })) >= 12) return send(res, 409, { error: 'GuardReactive watches the most vaults it can (12) right now' });
  if (!watchPerClient.take(client(req))) return send(res, 429, { error: 'at most 2 watch requests per hour from one client' });
  if (!watches.take('all')) return send(res, 429, { error: 'the hourly budget for watch requests is spent; try again later' });
  const hash = await reg.wallet.writeContract({ address: d.guard, abi: rxAbi, functionName: 'watch', args: [BigInt(NETWORKS[chain].chainId), vault], chain: reg.chain, account: reg.account, ...(await lasnaFees(reg.pub)) });
  const r = await reg.pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') return send(res, 502, { error: 'the watch transaction failed on Lasna', tx: hash });
  void indexer.refreshState().catch(() => {});
  send(res, 200, { ok: true, chain, vault, tx: hash, explorer: NETWORKS.lasna.explorer });
}

function client(req: IncomingMessage): string {
  const h = (n: string) => String(req.headers[n] ?? '').split(',')[0]!.trim();
  return h('x-nf-client-connection-ip') || h('x-forwarded-for') || req.socket.remoteAddress || 'unknown';
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit = 8_000): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('not JSON'), { status: 400 }); }
}

let busy = 0;
async function score(req: IncomingMessage, res: ServerResponse) {
  const body = await readJson(req);
  const text = { from: String(body.from ?? 'unknown sender').slice(0, 200), subject: String(body.subject ?? '').slice(0, 200), body: String(body.body ?? '') };
  if (!text.body.trim() || text.body.length > 2000) return send(res, 400, { error: 'the message body must be 1 to 2,000 characters' });
  if (!process.env.LLM_API_KEY && !process.env.HTTPS_PROXY) return send(res, 503, { error: 'the AI scorer is not configured on this server' });
  if (!perClient.take(client(req))) return send(res, 429, { error: 'at most 3 messages per 10 minutes from one client' });
  if (!modelCalls.take('all')) return send(res, 429, { error: 'the hourly budget for model calls is spent; try again later' });
  if (busy >= 2) return send(res, 429, { error: 'the scorer is busy; try again in a minute' });
  busy++;
  try {
    const d = indexer.d;
    const canReport = reports.take('all');
    const run = await scoreAndReport({ id: `web-${Date.now().toString(36)}`, ...text }, { network: 'baseSepolia', oracle: d.oracle, vault: d.vaults.baseSepolia, minScore: canReport ? 80 : 101 });
    send(res, 200, { ...run, reportingPaused: !canReport, explorer: 'https://sepolia.basescan.org' });
  } finally {
    busy--;
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, uptimeSeconds: Math.round((Date.now() - started) / 1000), stateAt: indexer.state.updatedAt ?? null });
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, indexer.snapshot());
    if (req.method === 'POST' && url.pathname === '/api/score') return await score(req, res);
    if (req.method === 'POST' && url.pathname === '/api/watch') return await watchVault(req, res);
    send(res, 404, { error: 'not found' });
  } catch (e) {
    const status = (e as any).status ?? 500;
    if (status === 500) console.error('request', (e as Error).message.split('\n')[0]);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal error' : (e as Error).message });
  }
});

server.listen(PORT, () => console.log(`guard service on :${PORT}`));
indexer.start().catch((e) => { console.error('indexer failed to start', e); process.exit(1); });
