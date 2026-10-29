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
import { socketPath, cacheDir, requireAccount, requireWallet, type Config } from './config.ts';
import { assertOwnLane, bindLanes } from './core/lanes.ts';
import { LABEL_LANE, type Lane } from './core/types.ts';
import { Control } from './control/control.ts';
import { createIpcHandler, IpcClient, serveUnix, unixTransport, type Route, type Transport } from './ipc.ts';
import { loadLaneKey, loadWalletSecret } from './keystore.ts';
import { createRuntime, type Runtime } from './runtime.ts';
import { Signer, type SignRequest } from './signer/signer.ts';
import { ingestExternalText, scanWallet, type IngestDeps, type SentinelSink } from './ingest/scan.ts';
import { loadGuardians } from './ingest/guardians.ts';
import { OpenAIModel, ScriptedModel, type ChatModel } from './steward/model.ts';
import { runTurn, type StewardControl, type TurnResult } from './steward/turn.ts';
import { suiNetworkId } from './payments/x402.ts';

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
export async function startupCheck(rt: Runtime, lane: Lane, pub: string): Promise<void> {
  const a = await rt.chain.getAccount(requireAccount(rt.cfg));
  const b = bindLanes(a);
  if (!b.ok) throw new Error(b.error);
  assertOwnLane(b.bindings, lane, pub);
}

// ---- control -----------------------------------------------------------------

export function buildControl(rt: Runtime, opts: { signer?: Transport | null; noCache?: boolean; cacheDirOverride?: string; fetchImpl?: typeof fetch } = {}): Control {
  const cfg = rt.cfg;
  const key = loadLaneKey(cfg, 'control');
  const signerTransport = opts.signer === undefined ? unixTransport(socketPath(cfg, 'signer')) : opts.signer;
  return new Control({
    acct: requireAccount(cfg),
    wallet: requireWallet(cfg),
    chain: rt.chain,
    mem: rt.memory(key),
    key,
    signer: signerTransport ? new IpcClient(key, signerTransport) : null,
    home: cfg.home,
    log: rt.log,
    reports: rt.reports,
    simulated: rt.simulated,
    maxGasMist: cfg.maxGasMist,
    x402Network: suiNetworkId(cfg.network, cfg.backend === 'offline'),
    cacheDir: opts.cacheDirOverride ?? cacheDir(cfg),
    autoQuarantineScore: cfg.autoQuarantineScore,
    ...(opts.noCache ? { noCache: true } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}

export function controlRoutes(control: Control): Record<string, Route> {
  return {
    '/context/recall': { lanes: ['agent'], handler: async (p) => control.recallForAgent(String((p as { query?: string }).query ?? ''), 12) },
    '/propose': { lanes: ['agent'], handler: async (p) => control.propose(p as Parameters<Control['propose']>[0]) },
    '/x402/pay': { lanes: ['agent'], handler: async (p) => control.payX402(p as Parameters<Control['payX402']>[0]) },
    '/ledger/head': { lanes: ['user', 'antibody'], handler: async () => control.head() },
    '/ledger/append': { lanes: ['user'], handler: async (p) => control.appendLedger(String((p as { text?: string }).text ?? '')) },
    '/lessons': { lanes: ['wallet-objects'], handler: async () => control.lessons() },
    '/incident': { lanes: ['wallet-objects'], handler: async (p) => control.incident(p as Parameters<Control['incident']>[0]) },
    '/checkpoint': { lanes: ['agent', 'user', 'wallet-objects'], handler: async () => control.d.chain.latestCheckpoint() },
  };
}

export function controlHandler(control: Control): Transport {
  return createIpcHandler(controlRoutes(control), (pub) => control.laneOf(pub));
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
  return createIpcHandler({ '/sign': { lanes: ['antibody'], handler: async (p) => signer.sign(p as SignRequest) } }, laneOf);
}

export async function serveSigner(rt: Runtime, signer: Signer) {
  return serveUnix(socketPath(rt.cfg, 'signer'), signerHandler(signer, chainLaneOf(rt)));
}

// ---- agent (Steward) -------------------------------------------------------------

export function createModel(cfg: Config): ChatModel {
  if (cfg.llm.baseUrl && cfg.llm.apiKey && cfg.llm.model) return new OpenAIModel(cfg.llm.baseUrl, cfg.llm.apiKey, cfg.llm.model);
  return new ScriptedModel();
}

/** Steward's view of control over IPC. */
export function remoteStewardControl(client: IpcClient): StewardControl {
  return {
    recall: (query) => client.call('/context/recall', { query }),
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
  };
}

export async function runStewardRemote(rt: Runtime, instruction: string, execute: boolean): Promise<TurnResult> {
  const deps = stewardBase(rt, execute);
  await startupCheck(rt, 'agent', deps.key.publicKeyHex);
  const client = new IpcClient(deps.key, unixTransport(socketPath(rt.cfg, 'control')));
  return runTurn({ ...deps, control: remoteStewardControl(client) }, instruction);
}

export async function serveAgent(rt: Runtime) {
  const deps = stewardBase(rt, false);
  await startupCheck(rt, 'agent', deps.key.publicKeyHex);
  const client = new IpcClient(deps.key, unixTransport(socketPath(rt.cfg, 'control')));
  const full = { ...deps, control: remoteStewardControl(client) };
  const handler = createIpcHandler(
    {
      '/turn': {
        lanes: ['antibody'],
        handler: async (p) => {
          const { instruction, execute } = p as { instruction: string; execute?: boolean };
          return runTurn({ ...full, execute: !!execute }, instruction);
        },
      },
    },
    chainLaneOf(rt),
  );
  return serveUnix(`${rt.cfg.home}/run/agent.sock`, handler);
}

// ---- ingest ------------------------------------------------------------------

export function remoteSentinelSink(client: IpcClient): SentinelSink {
  return {
    lessons: () => client.call('/lessons'),
    incident: (i) => client.call('/incident', i),
  };
}

async function ingestDeps(rt: Runtime, sinkOverride?: SentinelSink | null): Promise<IngestDeps> {
  const key = loadLaneKey(rt.cfg, 'ingest');
  await startupCheck(rt, 'wallet-objects', key.publicKeyHex);
  const sink = sinkOverride === undefined ? remoteSentinelSink(new IpcClient(key, unixTransport(socketPath(rt.cfg, 'control')))) : sinkOverride;
  const guardians = await loadGuardians(cacheDir(rt.cfg), { offline: rt.cfg.backend === 'offline' });
  return {
    acct: requireAccount(rt.cfg),
    wallet: requireWallet(rt.cfg),
    chain: rt.chain,
    mem: rt.memory(key),
    key,
    sink,
    guardians,
    log: rt.log,
    cacheDir: cacheDir(rt.cfg),
    threshold: rt.cfg.sentinelThreshold,
  };
}

export async function runIngestScan(rt: Runtime, sinkOverride?: SentinelSink | null) {
  return scanWallet(await ingestDeps(rt, sinkOverride));
}

export async function runIngestPaste(rt: Runtime, text: string, origin: string, sinkOverride?: SentinelSink | null) {
  return ingestExternalText(await ingestDeps(rt, sinkOverride), text, origin);
}

export { createRuntime };
