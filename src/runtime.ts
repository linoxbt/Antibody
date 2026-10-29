/**
 * Runtime factory: wires a role to the live (Walrus Memory + Tatum) or
 * offline (fixture, SIMULATED) backends. Live and offline differ only here.
 */
import { join } from 'node:path';
import { cacheDir, logDir, offlineDir, type Config, type Role } from './config.ts';
import type { LaneKey } from './core/keys.ts';
import type { ChainReader } from './adapters/chain.ts';
import { SdkChainReader } from './adapters/chain-sdk.ts';
import { FixtureChain } from './adapters/chain-fixture.ts';
import { CrossCheckedChain } from './adapters/chain-crosscheck.ts';
import type { MemoryClient } from './adapters/memory.ts';
import { LiveMemoryClient } from './adapters/memwal-live.ts';
import { OfflineRelayer } from './adapters/memwal-offline.ts';
import { LocalReportStore, TatumStorage, type ReportStore } from './adapters/storage-tatum.ts';
import { createLogger, type Logger } from './log.ts';
import { checkIsolation } from './keystore.ts';

export const SIMULATED_BANNER = '━━ SIMULATED ━━ offline backend: fixture chain + local relayer, nothing touches Sui or Walrus ━━';

export interface Runtime {
  cfg: Config;
  role: Role | 'cli';
  simulated: boolean;
  log: Logger;
  chain: ChainReader;
  memory(key: LaneKey & { seedHex: string }): MemoryClient;
  reports: ReportStore;
  /** Offline only. */
  fixture?: FixtureChain;
  relayer?: OfflineRelayer;
  /** Human-facing banner lines to print on every screen. */
  banners: string[];
}

export function createRuntime(cfg: Config, role: Role | 'cli'): Runtime {
  const offline = cfg.backend === 'offline';
  const banners: string[] = [];
  if (offline) banners.push(SIMULATED_BANNER);
  if (role !== 'cli' && cfg.keyIsolation === 'simulated' && !checkIsolation(cfg, role).ok) {
    banners.push('━━ SIMULATED key isolation: every role runs as one OS user (ANTIBODY_KEY_ISOLATION=simulated) ━━');
  }
  const simulated = offline || cfg.keyIsolation === 'simulated';
  const log = createLogger({ dir: logDir(cfg), role, simulated, stderr: process.env.ANTIBODY_LOG === 'stderr' });

  if (offline) {
    const fixture = new FixtureChain(offlineDir(cfg));
    const relayer = new OfflineRelayer(offlineDir(cfg), (pub) => fixture.isDelegate(pub));
    return {
      cfg,
      role,
      simulated,
      log,
      chain: fixture,
      memory: (key) => relayer.client(key.publicKeyHex),
      reports: new LocalReportStore(join(cacheDir(cfg), 'reports')),
      fixture,
      relayer,
      banners,
    };
  }

  const tatum = new SdkChainReader({
    transport: cfg.chainTransport,
    network: cfg.network,
    url: cfg.chainTransport === 'grpc' ? cfg.tatumGrpcUrl : cfg.tatumRpcUrl,
    apiKey: cfg.tatumApiKey,
    packageId: cfg.packageId,
  });
  const chain = cfg.crossCheck
    ? new CrossCheckedChain(tatum, new SdkChainReader({ transport: cfg.crossCheck.transport, network: cfg.network, url: cfg.crossCheck.url, apiKey: cfg.crossCheck.apiKey, packageId: cfg.packageId }), { label: new URL(cfg.crossCheck.url).host })
    : tatum;
  const accountId = cfg.accountId;
  return {
    cfg,
    role,
    simulated,
    log,
    chain,
    memory: (key) => {
      if (!accountId) throw new Error('MEMWAL_ACCOUNT_ID is not set');
      return new LiveMemoryClient({ seedHex: key.seedHex, publicKeyHex: key.publicKeyHex, accountId, serverUrl: cfg.memwalServerUrl });
    },
    reports: cfg.tatumApiKey ? new TatumStorage(cfg.tatumApiUrl, cfg.tatumApiKey) : new LocalReportStore(join(cacheDir(cfg), 'reports')),
    banners,
  };
}
