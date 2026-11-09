/**
 * Process wiring: which role holds which key, which routes each daemon
 * serves, and which lanes may call them (spec §3 table).
 *
 *   control  (antibody key)   ← agent: /context/recall /propose /x402/pay
 *                             ← user:  /ledger/head /ledger/append
 *                             ← wallet-objects: /lessons /incident
 *   signer   (wallet key)     ← antibody: /sign
 *   agent    (agent + LLM key) ← antibody: /turn   (the web UI's "run" button)
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { ipcPath, socketPath, cacheDir, ingestDir, requireAccount, requireWallet, type Config } from './config.ts';
import { assertOwnLane, bindLanes } from './core/lanes.ts';
import { LABEL_LANE, LANE_LABEL, type Lane } from './core/types.ts';
import { Control } from './control/control.ts';
import { createIpcHandler, IpcClient, serveUnix, unixTransport, type Route, type Transport } from './ipc.ts';
import { loadLaneKey, loadWalletSecret } from './keystore.ts';
import { createRuntime, type Runtime } from './runtime.ts';
import { Signer, type SignRequest } from './signer/signer.ts';
import { ingestExternalText, scanWallet, type IngestDeps, type SentinelSink } from './ingest/scan.ts';
import { loadGuardians, type GuardianLists } from './ingest/guardians.ts';
import { watchWallet, type WatchOptions } from './ingest/watch.ts';
import { OpenAIModel, ScriptedModel, type ChatModel } from './steward/model.ts';
import { runTurn, type StewardControl, type TurnResult } from './steward/turn.ts';
import { runUnprotectedTurn } from './steward/unprotected.ts';
import { suiNetworkId } from './payments/x402.ts';
import { Alerter, alertConfigFrom, type Alert } from './ops/alerts.ts';

/** S13: accept a daemon's response only from the key that should be serving it. */
export function laneServer(rt: Runtime, lane: Lane): (pub: string) => Promise<boolean> {
  const label = LANE_LABEL[lane];
  const cache = new Map<string, number>();
  return async (pub) => {
    const t = cache.get(pub);
    if (t && Date.now() - t < 60_000) return true;
    const a = await rt.chain.getAccount(requireAccount(rt.cfg));
    const ok = a.delegateKeys.some((k) => k.publicKeyHex === pub && k.label === label);
    if (ok) cache.set(pub, Date.now());
    return ok;
  };
}

/** The signer answers with the key behind Steward's wallet address. */
export function walletServer(wallet: string): (pub: string) => boolean {
  return (pub) => {
    try {
      return new Ed25519PublicKey(Buffer.from(pub, 'hex')).toSuiAddress() === wallet;
    } catch {
      return false;
    }
  };
}

/** Map a public key to its lane from the live account (for daemons other than control). */
export function chainLaneOf(rt: Runtime): (pub: string) => Promise<Lane | undefined> {
  const acct = requireAccount(rt.cfg);
  return async (pub) => {
    const a = await rt.chain.getAccount(acct);
    const k = a.delegateKeys.find((x) => x.publicKeyHex === pub);
    return k ? LABEL_LANE[k.label] : undefined;
  };
}

/** Startup check: this role's lane key must be the single active key on-chain. */
/** B8: a problem a restart cannot fix (wrong key, unbound lane); the daemon exits with EX_CONFIG (78) and the supervisor stops. */
export class ConfigError extends Error {}

/**
 * The daemon's key must be the lane's bound key on-chain. B8: a chain that is
 * briefly unreachable is retried for up to two minutes instead of exiting.
 */
export async function startupCheck(rt: Runtime, lane: Lane, pub: string, o: { waitMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const deadline = Date.now() + (o.waitMs ?? 120_000);
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let a;
  for (let delay = 1000; ; delay = Math.min(delay * 2, 15_000)) {
    try {
      a = await rt.chain.getAccount(requireAccount(rt.cfg));
      break;
    } catch (e) {
      if (Date.now() >= deadline) throw e;
      rt.log.warn('startup.chain_unreachable', { lane, error: (e as Error).message, retryInMs: delay });
      await sleep(delay);
    }
  }
  const b = bindLanes(a);
  if (!b.ok) throw new ConfigError(b.error);
  try {
    assertOwnLane(b.bindings, lane, pub);
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
}

// ---- control -----------------------------------------------------------------

export function buildControl(rt: Runtime, opts: { signer?: Transport | null; noCache?: boolean; cacheDirOverride?: string; fetchImpl?: typeof fetch } = {}): Control {
  const cfg = rt.cfg;
  const key = loadLaneKey(cfg, 'control');
  const alerter = new Alerter(alertConfigFrom(), { log: rt.log, simulated: rt.simulated, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  let guardians: Promise<GuardianLists> | null = null;
  const signerTransport = opts.signer === undefined ? unixTransport(socketPath(cfg, 'signer')) : opts.signer;
  return new Control({
    acct: requireAccount(cfg),
    wallet: requireWallet(cfg),
    chain: rt.chain,
    mem: rt.memory(key),
    key,
    signer: signerTransport ? new IpcClient(key, signerTransport, Date.now, walletServer(requireWallet(cfg))) : null,
    home: cfg.home,
    log: rt.log,
    reports: rt.reports,
    simulated: rt.simulated,
    maxGasMist: cfg.maxGasMist,
    x402Network: suiNetworkId(cfg.network, cfg.backend === 'offline'),
    cacheDir: opts.cacheDirOverride ?? cacheDir(cfg),
    autoQuarantineScore: cfg.autoQuarantineScore,
    x402Allow: cfg.x402Allow,
    ...(alerter.enabled ? { alert: (a: Alert) => void alerter.send(a).catch(() => undefined) } : {}),
    guardians: () => (guardians ??= loadGuardians(cacheDir(cfg), { offline: cfg.backend === 'offline' })),
    ...(opts.noCache ? { noCache: true } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}

export function controlRoutes(control: Control): Record<string, Route> {
  return {
    '/context/recall': { lanes: ['agent'], handler: async (p) => control.recallForAgent(String((p as { query?: string }).query ?? ''), 12, typeof (p as { turn?: unknown }).turn === 'string' ? (p as { turn: string }).turn : undefined) },
    '/propose': { lanes: ['agent'], handler: async (p) => control.propose(p as Parameters<Control['propose']>[0]) },
    '/x402/pay': { lanes: ['agent'], handler: async (p) => control.payX402(p as Parameters<Control['payX402']>[0]) },
    '/ledger/head': { lanes: ['user', 'antibody'], handler: async () => control.head() },
    '/ledger/append': { lanes: ['user'], handler: async (p) => control.appendLedger(String((p as { text?: string }).text ?? '')) },
    '/lessons': { lanes: ['wallet-objects'], handler: async () => control.lessons() },
    '/incident': { lanes: ['wallet-objects'], handler: async (p) => control.incident(p as Parameters<Control['incident']>[0]) },
    '/checkpoint': { lanes: ['agent', 'user', 'wallet-objects'], handler: async () => control.d.chain.latestCheckpoint() },
    // M4: a lane's own process asks control to record its rotation, signing with the new key (bound on-chain).
    '/lane/rotated': { lanes: ['user', 'agent', 'wallet-objects'], handler: async (p, caller) => control.recordRotate(caller.pub, caller.lane, String((p as { digest?: string }).digest ?? '')) },
  };
}

export function controlHandler(control: Control): Transport {
  return createIpcHandler(controlRoutes(control), (pub) => control.laneOf(pub), Date.now, control.d.key);
}

export async function serveControl(rt: Runtime, control: Control) {
  await startupCheck(rt, 'antibody', control.d.key.publicKeyHex);
  return serveUnix(socketPath(rt.cfg, 'control'), controlHandler(control));
}

// ---- signer ------------------------------------------------------------------

export function buildSigner(rt: Runtime): Signer {
  const s = Signer.fromSecret(loadWalletSecret(rt.cfg), rt.chain, rt.log, rt.cfg.maxGasMist);
  const want = rt.cfg.stewardWallet;
  if (want && want !== s.address) throw new Error(`signer key controls ${s.address}, but STEWARD_WALLET_ADDRESS is ${want}`);
  return s;
}

export function signerHandler(signer: Signer, laneOf: (pub: string) => Promise<Lane | undefined>): Transport {
  return createIpcHandler({ '/sign': { lanes: ['antibody'], handler: async (p) => signer.sign(p as SignRequest) } }, laneOf, Date.now, signer.serverKey());
}

export async function serveSigner(rt: Runtime, signer: Signer) {
  return serveUnix(socketPath(rt.cfg, 'signer'), signerHandler(signer, chainLaneOf(rt)));
}

// ---- agent (Steward) -------------------------------------------------------------

export function createModel(cfg: Config): ChatModel {
  if (cfg.llm.baseUrl && cfg.llm.apiKey && cfg.llm.model) return new OpenAIModel(cfg.llm.baseUrl, cfg.llm.apiKey, cfg.llm.model, { reasoningEffort: cfg.llm.reasoningEffort, timeoutMs: cfg.llm.timeoutMs, provider: cfg.llm.provider });
  return new ScriptedModel();
}

/** Steward's view of control over IPC. */
export function remoteStewardControl(client: IpcClient): StewardControl {
  return {
    recall: (query, turn) => client.call('/context/recall', { query, turn }),
    propose: (args) => client.call('/propose', args),
    payX402: (args) => client.call('/x402/pay', args),
  };
}

/** Steward's own pieces (agent key, agent-lane memory client, model), minus control. */
export function stewardBase(rt: Runtime, execute: boolean, model?: ChatModel) {
  const key = loadLaneKey(rt.cfg, 'agent');
  return {
    acct: requireAccount(rt.cfg),
    mem: rt.memory(key),
    key,
    model: model ?? createModel(rt.cfg),
    log: rt.log,
    currentCheckpoint: () => rt.chain.latestCheckpoint(),
    execute,
    allowX402: rt.cfg.x402Allow.length > 0,
  };
}

export async function runStewardRemote(rt: Runtime, instruction: string, execute: boolean): Promise<TurnResult> {
  const deps = stewardBase(rt, execute);
  await startupCheck(rt, 'agent', deps.key.publicKeyHex);
  const client = new IpcClient(deps.key, unixTransport(socketPath(rt.cfg, 'control')), Date.now, laneServer(rt, 'antibody'));
  // M4: the agent reads the chain through control, not with its own Tatum key.
  return runTurn({ ...deps, currentCheckpoint: () => client.call<number>('/checkpoint', {}), control: remoteStewardControl(client) }, instruction);
}

export async function serveAgent(rt: Runtime) {
  const deps = stewardBase(rt, false);
  await startupCheck(rt, 'agent', deps.key.publicKeyHex);
  const client = new IpcClient(deps.key, unixTransport(socketPath(rt.cfg, 'control')), Date.now, laneServer(rt, 'antibody'));
  const full = { ...deps, currentCheckpoint: () => client.call<number>('/checkpoint', {}), control: remoteStewardControl(client) };
  const handler = createIpcHandler(
    {
      '/turn': {
        lanes: ['antibody'],
        handler: async (p) => {
          const { instruction, execute } = p as { instruction: string; execute?: boolean };
          return runTurn({ ...full, execute: !!execute }, instruction);
        },
      },
      // M4: the unprotected comparison also runs here, so the LLM key never has to live in control.
      '/compare': {
        lanes: ['antibody'],
        handler: async (p) => runUnprotectedTurn({ mem: deps.mem, chain: rt.chain, wallet: requireWallet(rt.cfg), model: deps.model }, String((p as { instruction?: string }).instruction ?? '').slice(0, 2000)),
      },
    },
    chainLaneOf(rt),
    Date.now,
    deps.key,
  );
  return serveUnix(ipcPath(rt.cfg, 'agent'), handler);
}

// ---- ingest ------------------------------------------------------------------

export function remoteSentinelSink(client: IpcClient): SentinelSink {
  return {
    lessons: () => client.call('/lessons'),
    incident: (i) => client.call('/incident', i),
  };
}

/**
 * B1: the sentinel keeps its state in its own directory (control's cache is
 * control-only under role isolation). Files from older builds, which kept them
 * in cache/, are carried over once so objects already observed are not observed again.
 */
function prepareIngestDir(cfg: Config): string {
  const dir = ingestDir(cfg);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of ['ingest-seen.json', 'ingest-outbox.json']) {
    const from = join(cacheDir(cfg), f);
    const to = join(dir, f);
    try {
      if (!existsSync(to) && existsSync(from)) copyFileSync(from, to);
    } catch {
      /* unreadable legacy file (another role owns cache/): start fresh */
    }
  }
  return dir;
}

async function ingestDeps(rt: Runtime, sinkOverride?: SentinelSink | null): Promise<IngestDeps> {
  const key = loadLaneKey(rt.cfg, 'ingest');
  const dir = prepareIngestDir(rt.cfg);
  await startupCheck(rt, 'wallet-objects', key.publicKeyHex);
  const sink = sinkOverride === undefined ? remoteSentinelSink(new IpcClient(key, unixTransport(socketPath(rt.cfg, 'control')), Date.now, laneServer(rt, 'antibody'))) : sinkOverride;
  const guardians = await loadGuardians(dir, { offline: rt.cfg.backend === 'offline' });
  return {
    acct: requireAccount(rt.cfg),
    wallet: requireWallet(rt.cfg),
    chain: rt.chain,
    mem: rt.memory(key),
    key,
    sink,
    guardians,
    log: rt.log,
    cacheDir: dir,
    threshold: rt.cfg.sentinelThreshold,
  };
}

export async function runIngestScan(rt: Runtime, sinkOverride?: SentinelSink | null) {
  return scanWallet(await ingestDeps(rt, sinkOverride));
}

/** The always-on sentinel (FR-18): scans whenever a checkpoint touches Steward's wallet. */
export async function runIngestWatch(rt: Runtime, o: Pick<WatchOptions, 'signal' | 'onScan' | 'log'> & { pollMs?: number }, sinkOverride?: SentinelSink | null) {
  const deps = await ingestDeps(rt, sinkOverride);
  const offline = rt.cfg.backend === 'offline';
  return watchWallet({
    chain: rt.chain,
    wallet: deps.wallet,
    scan: () => scanWallet(deps),
    signal: o.signal,
    // Mainnet checkpoints advance every ~250 ms, so a polling fallback scans on a slower clock.
    pollMs: o.pollMs ?? (offline ? 2000 : 15_000),
    minScanGapMs: offline ? 500 : 5000,
    log: o.log ?? ((event, data) => rt.log.info(`watch.${event}`, data ?? {})),
    ...(o.onScan ? { onScan: o.onScan } : {}),
  });
}

export async function runIngestPaste(rt: Runtime, text: string, origin: string, sinkOverride?: SentinelSink | null) {
  return ingestExternalText(await ingestDeps(rt, sinkOverride), text, origin);
}

export { createRuntime };
