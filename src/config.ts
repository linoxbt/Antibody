/**
 * Configuration (spec §13). One TypeScript package, one process per role;
 * each process starts with ANTIBODY_ROLE set and loads only its own key.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Lane } from './core/types.ts';

export const ROLES = ['control', 'user', 'agent', 'ingest', 'signer'] as const;
export type Role = (typeof ROLES)[number];

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
  stewardWallet: string | null;
  llm: { baseUrl: string | null; apiKey: string | null; model: string | null };
  keyIsolation: KeyIsolation;
  /** Sentinel score at or above which an incident is raised. */
  sentinelThreshold: number;
  /** Lesson score at or above which a repeat attack is quarantined automatically. */
  autoQuarantineScore: number;
  webPort: number;
  /** Max gas the policy accepts per payment, in MIST. */
  maxGasMist: string;
}

/** Values `antibody setup` persists so later processes need no extra env. */
interface Persisted {
  accountId?: string;
  stewardWallet?: string;
  network?: 'mainnet' | 'testnet';
}

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.ANTIBODY_HOME ?? join(homedir(), '.antibody'));
}

export function persistedPath(home: string): string {
  return join(home, 'antibody.json');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = defaultHome(env);
  const persisted: Persisted = existsSync(persistedPath(home)) ? (JSON.parse(readFileSync(persistedPath(home), 'utf8')) as Persisted) : {};
  const backend = (env.ANTIBODY_BACKEND ?? 'offline') as Backend;
  if (backend !== 'live' && backend !== 'offline') throw new Error(`ANTIBODY_BACKEND must be live or offline, got ${backend}`);
  const role = env.ANTIBODY_ROLE ? (env.ANTIBODY_ROLE as Role) : null;
  if (role && !ROLES.includes(role)) throw new Error(`ANTIBODY_ROLE must be one of ${ROLES.join(', ')}`);
  const isolation = (env.ANTIBODY_KEY_ISOLATION ?? (backend === 'live' ? 'enforce' : 'simulated')) as KeyIsolation;
  if (isolation !== 'enforce' && isolation !== 'simulated') throw new Error('ANTIBODY_KEY_ISOLATION must be enforce or simulated');
  return {
    backend,
    role,
    home,
    network: (env.SUI_NETWORK as Config['network']) ?? persisted.network ?? 'mainnet',
    memwalServerUrl: env.MEMWAL_SERVER_URL ?? MAINNET.relayer,
    accountId: env.MEMWAL_ACCOUNT_ID ?? persisted.accountId ?? null,
    packageId: env.MEMWAL_PACKAGE_ID ?? MAINNET.packageId,
    registryId: env.MEMWAL_REGISTRY_ID ?? MAINNET.registryId,
    tatumApiKey: env.TATUM_API_KEY ?? null,
    tatumGrpcUrl: env.TATUM_SUI_GRPC_URL ?? MAINNET.tatumGrpc,
    tatumRpcUrl: env.TATUM_SUI_RPC_URL ?? MAINNET.tatumRpc,
    tatumApiUrl: env.TATUM_API_URL ?? MAINNET.tatumApi,
    chainTransport: (env.ANTIBODY_CHAIN_TRANSPORT as ChainTransport) ?? 'grpc',
    stewardWallet: env.STEWARD_WALLET_ADDRESS ?? persisted.stewardWallet ?? null,
    llm: { baseUrl: env.LLM_BASE_URL ?? null, apiKey: env.LLM_API_KEY ?? null, model: env.LLM_MODEL ?? null },
    keyIsolation: isolation,
    sentinelThreshold: Number(env.ANTIBODY_SENTINEL_THRESHOLD ?? 0.6),
    autoQuarantineScore: Number(env.ANTIBODY_AUTO_QUARANTINE_SCORE ?? 0.6),
    webPort: Number(env.ANTIBODY_WEB_PORT ?? 7402),
    maxGasMist: env.ANTIBODY_MAX_GAS_MIST ?? '50000000',
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
export const socketPath = (cfg: Config, role: 'control' | 'signer') => join(runDir(cfg), `${role}.sock`);
export const cacheDir = (cfg: Config) => join(cfg.home, 'cache');
export const offlineDir = (cfg: Config) => join(cfg.home, 'offline');
export const logDir = (cfg: Config) => join(cfg.home, 'logs');
