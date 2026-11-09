/**
 * Configuration (spec §13). One TypeScript package, one process per role;
 * each process starts with ANTIBODY_ROLE set and loads only its own key.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Lane } from './core/types.ts';

export const ROLES = ['control', 'user', 'agent', 'ingest', 'signer'] as const;
export type Role = (typeof ROLES)[number];

/**
 * S3: secrets and the daemon roles allowed to see them. A daemon started by
 * `antibody up` or the service gets only its own (and its own key passphrase);
 * the owner's private key reaches no daemon at all. Anything not listed here
 * (TATUM_API_KEY, MEMWAL_ACCOUNT_ID, settings) every role may read.
 */
export const ROLE_SECRET_VARS: Readonly<Record<string, readonly Role[]>> = {
  OWNER_SUI_PRIVATE_KEY: [],
  LLM_API_KEY: ['agent'],
  FORTYTWO_API_KEY: ['agent'],
  ANTIBODY_WEB_TOKEN: ['control'],
  ANTIBODY_METRICS_TOKEN: ['control'],
  ANTIBODY_ALERT_WEBHOOK: ['control'],
  ANTIBODY_TELEGRAM_BOT_TOKEN: ['control'],
  ANTIBODY_TELEGRAM_CHAT_ID: ['control'],
};

/** Remove from `env` every secret this daemon role may not hold, and every other role's key passphrase. */
export function scrubDaemonEnv(env: NodeJS.ProcessEnv, role: Role): NodeJS.ProcessEnv {
  for (const [name, roles] of Object.entries(ROLE_SECRET_VARS)) if (!roles.includes(role)) delete env[name];
  for (const other of ROLES) {
    if (other === role) continue;
    const R = other.toUpperCase();
    delete env[`ANTIBODY_KEY_PASSPHRASE_${R}`];
    delete env[`ANTIBODY_KEY_PASSPHRASE_${R}_FILE`];
  }
  return env;
}

/** The lane each role signs with; the signer holds the Steward wallet key instead. */
export const ROLE_LANE: Readonly<Record<Role, Lane | null>> = {
  control: 'antibody',
  user: 'user',
  agent: 'agent',
  ingest: 'wallet-objects',
  signer: null,
};

export type Backend = 'live' | 'offline';
export type ChainTransport = 'grpc' | 'jsonrpc';
export type KeyIsolation = 'enforce' | 'simulated';

/** Mainnet IDs (spec §11), cross-checked against the relayer's GET /config by the probe. */
export const MAINNET = {
  relayer: 'https://relayer.memory.walrus.xyz',
  packageId: '0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5',
  registryId: '0x8bf82c9e09e36b8d1c38298f68b7cb68e7b8762887e7592add9986d5e9cf199f',
  tatumGrpc: 'https://sui-mainnet-grpc.gateway.tatum.io',
  tatumRpc: 'https://sui-mainnet.gateway.tatum.io',
  tatumApi: 'https://api.tatum.io',
} as const;

/** Native Circle USDC on Sui mainnet. */
export const USDC_MAINNET = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

export interface Config {
  backend: Backend;
  role: Role | null;
  home: string;
  network: 'mainnet' | 'testnet';
  memwalServerUrl: string;
  accountId: string | null;
  packageId: string;
  registryId: string;
  tatumApiKey: string | null;
  tatumGrpcUrl: string;
  tatumRpcUrl: string;
  tatumApiUrl: string;
  chainTransport: ChainTransport;
  /** gRPC over HTTP/2 (native, default) or gRPC-Web. */
  grpcWire: 'native' | 'web';
  stewardWallet: string | null;
  llm: LlmConfig;
  keyIsolation: KeyIsolation;
  /** Sentinel score at or above which an incident is raised. */
  sentinelThreshold: number;
  /** Lesson score at or above which a repeat attack is quarantined automatically. */
  autoQuarantineScore: number;
  webPort: number;
  /** Max gas the policy accepts per payment, in MIST. */
  maxGasMist: string;
  /** host[:port] values Steward's pay_x402 tool may fetch (M3). Empty: the tool is not offered at all. */
  x402Allow: string[];
  /** FR-19: a second Sui RPC that must agree on the delegate set (unset = no cross-check). */
  crossCheck: { url: string; transport: ChainTransport; apiKey: string | null } | null;
}

/** Values `antibody setup` persists so later processes need no extra env. */
interface Persisted {
  accountId?: string;
  stewardWallet?: string;
  network?: 'mainnet' | 'testnet';
}

/** B8: an empty or whitespace-only value counts as unset (so a blank line in antibody.env never overrides saved setup). */
function val(env: NodeJS.ProcessEnv, k: string): string | undefined {
  const v = env[k];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(2)) : p;
}

function oneOf<T extends string>(env: NodeJS.ProcessEnv, k: string, allowed: readonly T[], fallback: T): T {
  const v = val(env, k);
  if (v === undefined) return fallback;
  const lower = v.toLowerCase() as T;
  if (!allowed.includes(lower)) throw new Error(`${k} must be one of ${allowed.join(', ')} (got "${v}")`);
  return lower;
}

function num(env: NodeJS.ProcessEnv, k: string, fallback: number, min: number, max: number): number {
  const v = val(env, k);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${k} must be a number between ${min} and ${max} (got "${v}")`);
  return n;
}

function url(env: NodeJS.ProcessEnv, k: string, fallback: string): string {
  const v = val(env, k) ?? fallback;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
  } catch {
    throw new Error(`${k} must be an http(s) URL (got "${v}")`);
  }
  return v;
}

/** Steward's model endpoint. `fortytwo` fills in Fortytwo's URL and Qwen model. */
export interface LlmConfig {
  provider: LlmProvider;
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
  /** Sent as reasoning_effort when set (reasoning models such as Qwen on Fortytwo). */
  reasoningEffort: ReasoningEffort | null;
  /** Deadline for one model call. */
  timeoutMs: number;
}
export type LlmProvider = 'openai-compatible' | 'fortytwo';
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Fortytwo's decentralised inference network: OpenAI-compatible Chat Completions. */
export const FORTYTWO = { baseUrl: 'https://api.fortytwo.network/v1', model: 'qwen/qwen3.8-27b' } as const;

export function loadLlm(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const provider = oneOf(env, 'LLM_PROVIDER', ['openai-compatible', 'fortytwo'] as const, 'openai-compatible');
  const preset = provider === 'fortytwo' ? FORTYTWO : null;
  const effort = val(env, 'LLM_REASONING_EFFORT');
  return {
    provider,
    baseUrl: val(env, 'LLM_BASE_URL') ? url(env, 'LLM_BASE_URL', '') : (preset?.baseUrl ?? null),
    apiKey: val(env, 'LLM_API_KEY') ?? (provider === 'fortytwo' ? val(env, 'FORTYTWO_API_KEY') : undefined) ?? null,
    model: val(env, 'LLM_MODEL') ?? preset?.model ?? null,
    // Fortytwo's default is medium; low keeps a Steward turn quick. Other providers get nothing unless asked.
    reasoningEffort: effort ? oneOf(env, 'LLM_REASONING_EFFORT', REASONING_EFFORTS, 'medium') : provider === 'fortytwo' ? 'low' : null,
    timeoutMs: num(env, 'LLM_TIMEOUT_MS', 120_000, 1_000, 600_000),
  };
}

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(expandHome(val(env, 'ANTIBODY_HOME') ?? join(homedir(), '.antibody')));
}

export function persistedPath(home: string): string {
  return join(home, 'antibody.json');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = defaultHome(env);
  const persisted: Persisted = existsSync(persistedPath(home)) ? (JSON.parse(readFileSync(persistedPath(home), 'utf8')) as Persisted) : {};
  const backend = oneOf(env, 'ANTIBODY_BACKEND', ['live', 'offline'] as const, 'offline');
  const roleRaw = val(env, 'ANTIBODY_ROLE');
  const role = roleRaw ? (roleRaw as Role) : null;
  if (role && !ROLES.includes(role)) throw new Error(`ANTIBODY_ROLE must be one of ${ROLES.join(', ')}`);
  const isolation = oneOf(env, 'ANTIBODY_KEY_ISOLATION', ['enforce', 'simulated'] as const, backend === 'live' ? 'enforce' : 'simulated');
  const network = oneOf(env, 'SUI_NETWORK', ['mainnet', 'testnet'] as const, persisted.network ?? 'mainnet');
  // B8: testnet must name its own deployment; the mainnet defaults would silently point at mainnet.
  if (network === 'testnet' && backend === 'live') {
    const missing = ['MEMWAL_SERVER_URL', 'MEMWAL_PACKAGE_ID', 'MEMWAL_REGISTRY_ID', 'TATUM_SUI_GRPC_URL'].filter((k) => !val(env, k));
    if (missing.length) throw new Error(`SUI_NETWORK=testnet needs ${missing.join(', ')} (the defaults are mainnet)`);
  }
  const hex = (k: string, v: string) => {
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(v)) throw new Error(`${k} must be a 0x… Sui id (got "${v}")`);
    return v;
  };
  const acct = val(env, 'MEMWAL_ACCOUNT_ID');
  const wallet = val(env, 'STEWARD_WALLET_ADDRESS');
  const maxGas = val(env, 'ANTIBODY_MAX_GAS_MIST') ?? '50000000';
  if (!/^[1-9][0-9]{0,15}$/.test(maxGas)) throw new Error(`ANTIBODY_MAX_GAS_MIST must be a positive integer (got "${maxGas}")`);
  const cross = val(env, 'ANTIBODY_CROSSCHECK_RPC_URL');
  return {
    backend,
    role,
    home,
    network,
    memwalServerUrl: url(env, 'MEMWAL_SERVER_URL', MAINNET.relayer),
    accountId: acct ? hex('MEMWAL_ACCOUNT_ID', acct) : (persisted.accountId ?? null),
    packageId: hex('MEMWAL_PACKAGE_ID', val(env, 'MEMWAL_PACKAGE_ID') ?? MAINNET.packageId),
    registryId: hex('MEMWAL_REGISTRY_ID', val(env, 'MEMWAL_REGISTRY_ID') ?? MAINNET.registryId),
    tatumApiKey: val(env, 'TATUM_API_KEY') ?? null,
    tatumGrpcUrl: url(env, 'TATUM_SUI_GRPC_URL', MAINNET.tatumGrpc),
    tatumRpcUrl: url(env, 'TATUM_SUI_RPC_URL', MAINNET.tatumRpc),
    tatumApiUrl: url(env, 'TATUM_API_URL', MAINNET.tatumApi),
    chainTransport: oneOf(env, 'ANTIBODY_CHAIN_TRANSPORT', ['grpc', 'jsonrpc'] as const, 'grpc'),
    grpcWire: oneOf(env, 'ANTIBODY_GRPC_WIRE', ['native', 'web'] as const, 'native'),
    stewardWallet: wallet ? hex('STEWARD_WALLET_ADDRESS', wallet) : (persisted.stewardWallet ?? null),
    llm: loadLlm(env),
    keyIsolation: isolation,
    sentinelThreshold: num(env, 'ANTIBODY_SENTINEL_THRESHOLD', 0.6, 0, 1),
    autoQuarantineScore: num(env, 'ANTIBODY_AUTO_QUARANTINE_SCORE', 0.6, 0, 1),
    webPort: num(env, 'ANTIBODY_WEB_PORT', 7402, 1, 65535),
    maxGasMist: maxGas,
    // Origins (https://bills.example.com) or bare hosts (bills.example.com:8443); compared as host[:port].
    x402Allow: (val(env, 'ANTIBODY_X402_ALLOW') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
      .map((h) => {
        if (!h.includes('://')) return h;
        try {
          return new URL(h).host;
        } catch {
          throw new Error(`ANTIBODY_X402_ALLOW: "${h}" is not an origin or host`);
        }
      }),
    crossCheck: cross ? { url: url(env, 'ANTIBODY_CROSSCHECK_RPC_URL', cross), transport: oneOf(env, 'ANTIBODY_CROSSCHECK_TRANSPORT', ['grpc', 'jsonrpc'] as const, 'grpc'), apiKey: val(env, 'ANTIBODY_CROSSCHECK_API_KEY') ?? null } : null,
  };
}

export function requireAccount(cfg: Config): string {
  if (!cfg.accountId) throw new Error('No MemWalAccount configured: set MEMWAL_ACCOUNT_ID or run `antibody setup`');
  return cfg.accountId;
}

export function requireWallet(cfg: Config): string {
  if (!cfg.stewardWallet) throw new Error('No Steward wallet configured: set STEWARD_WALLET_ADDRESS or run `antibody setup`');
  return cfg.stewardWallet;
}

export const runDir = (cfg: Config) => join(cfg.home, 'run');
/**
 * Where a daemon listens for signed IPC: a Unix socket in the run directory on
 * macOS and Linux, a named pipe on Windows (one per ANTIBODY_HOME, so two
 * installs on one machine never collide).
 */
export function ipcPath(cfg: Config, name: 'control' | 'signer' | 'agent'): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\antibody-${createHash('sha256').update(resolve(cfg.home)).digest('hex').slice(0, 12)}-${name}`;
  const p = join(runDir(cfg), `${name}.sock`);
  // Unix socket paths are limited to about 104 to 108 bytes (macOS, Linux); a longer one is
  // silently truncated and the daemon dies with a confusing ENOENT. Say so plainly instead.
  if (Buffer.byteLength(p) > MAX_SOCKET_PATH) throw new Error(`ANTIBODY_HOME is too deep for a Unix socket: ${p} is ${Buffer.byteLength(p)} bytes (limit ${MAX_SOCKET_PATH}). Use a shorter ANTIBODY_HOME, e.g. ~/.antibody`);
  return p;
}
/** The portable Unix socket path limit (macOS allows 104 bytes including the terminator). */
export const MAX_SOCKET_PATH = 103;
export const isPipe = (p: string) => p.startsWith('\\\\.\\pipe\\');
export const socketPath = (cfg: Config, role: 'control' | 'signer') => ipcPath(cfg, role);
export const cacheDir = (cfg: Config) => join(cfg.home, 'cache');
/** The sentinel's own state (seen objects, outbox, scan lock); separate from control's cache so roles can own each (B1). */
export const ingestDir = (cfg: Config) => join(cfg.home, 'ingest');
export const offlineDir = (cfg: Config) => join(cfg.home, 'offline');
export const logDir = (cfg: Config) => join(cfg.home, 'logs');
