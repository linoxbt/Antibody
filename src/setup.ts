/**
 * `antibody setup` (FR-01): generate the four lane keys and the Steward
 * wallet key, register each lane key on the MemWalAccount with its
 * antibody:* label (owner signs), verify through the chain reader, and write
 * the ledger genesis.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { persistedPath, ROLES, ROLE_LANE, USDC_MAINNET, type Config, type Role } from './config.ts';
import { generateSeedHex, laneKeyFromSeedHex } from './core/keys.ts';
import { normalizeSuiAddress, sha256Hex, SUI_COIN_TYPE } from './core/encoding.ts';
import { LANE_LABEL } from './core/types.ts';
import type { AccountAdmin } from './adapters/chain.ts';
import { FixtureChain } from './adapters/chain-fixture.ts';
import { liveAccountAdmin } from './adapters/account-live.ts';
import { SdkChainReader } from './adapters/chain-sdk.ts';
import { hasKey, writeKeyFile } from './keystore.ts';
import { createRuntime } from './runtime.ts';
import { buildControl } from './services.ts';
import { STATE_VERSION } from './ops/state.ts';

export interface SetupResult {
  accountId: string;
  owner: string;
  wallet: string;
  lanes: { lane: string; label: string; pub: string; digest: string }[];
  genesis: { blobId: string; envelopeId: string };
  simulated: boolean;
}

function persist(cfg: Config, v: { accountId: string; stewardWallet: string; network: string }) {
  mkdirSync(cfg.home, { recursive: true, mode: 0o700 });
  writeFileSync(persistedPath(cfg.home), JSON.stringify({ ...v, stateVersion: STATE_VERSION }, null, 2) + '\n', { mode: 0o600 });
}

/** Generate any missing role keys (one file per role, mode 0600). */
export function generateKeys(cfg: Config): void {
  for (const role of ROLES) {
    if (!hasKey(cfg.home, role)) {
      if (role === 'signer') writeKeyFile(cfg.home, role, Ed25519Keypair.generate().getSecretKey());
      else writeKeyFile(cfg.home, role, generateSeedHex());
    }
  }
}

async function registerLanes(admin: AccountAdmin, readPub: (r: Exclude<Role, 'signer'>) => string) {
  const out: SetupResult['lanes'] = [];
  for (const role of ROLES) {
    const lane = ROLE_LANE[role];
    if (!lane) continue;
    const pub = readPub(role as Exclude<Role, 'signer'>);
    const { digest } = await admin.addDelegateKey(pub, LANE_LABEL[lane]);
    out.push({ lane, label: LANE_LABEL[lane], pub, digest });
  }
  return out;
}

/** Offline (SIMULATED) setup: a fixture account, funded wallet, keys, genesis. */
export async function setupOffline(cfg: Config, opts: { readKeyFile: (role: Role) => string; ownerSecret?: string; ownerAddress?: string }): Promise<SetupResult> {
  if (cfg.backend !== 'offline') throw new Error('setupOffline needs ANTIBODY_BACKEND=offline');
  generateKeys(cfg);
  // A known owner (OWNER_SUI_PRIVATE_KEY) lets a browser wallet sign in to the console; else a throwaway.
  // The hosted sandbox passes the visitor's wallet address: they own it, we never see their key.
  const owner = opts.ownerAddress ?? (opts.ownerSecret ? Ed25519Keypair.fromSecretKey(opts.ownerSecret) : Ed25519Keypair.generate()).toSuiAddress();
  const accountId = normalizeSuiAddress('0x' + sha256Hex(`memwal-account:${owner}`));
  const fixture = new FixtureChain(`${cfg.home}/offline`);
  fixture.createAccount(accountId, owner);
  const wallet = normalizeSuiAddress(Ed25519Keypair.fromSecretKey(opts.readKeyFile('signer')).toSuiAddress());
  persist(cfg, { accountId, stewardWallet: wallet, network: cfg.network });
  const lanes = await registerLanes(fixture.admin(owner), (r) => laneKeyFromSeedHex(opts.readKeyFile(r)).publicKeyHex);
  fixture.fund(wallet, SUI_COIN_TYPE, 10_000_000_000n, { id: null, decimals: 9, name: 'Sui', symbol: 'SUI', description: '', iconUrl: null });
  fixture.fund(wallet, USDC_MAINNET, 2_000_000_000n, { id: null, decimals: 6, name: 'USDC', symbol: 'USDC', description: 'USDC is a US dollar-backed stablecoin issued by Circle.', iconUrl: null });
  const genesis = await writeGenesisAs(cfg, accountId, wallet);
  return { accountId, owner: normalizeSuiAddress(owner), wallet, lanes, genesis, simulated: true };
}

/**
 * Live setup on mainnet. The owner creates the MemWalAccount on
 * memory.walrus.xyz first; this registers the four lanes and writes genesis.
 * The owner signs either with OWNER_SUI_PRIVATE_KEY (a throwaway demo owner)
 * or, with `admin`, in their own browser wallet (setup --wallet): then all
 * four keys go in one transaction and the owner key never touches this machine.
 */
export async function setupLive(cfg: Config, opts: { ownerSecret?: string; admin?: (owner: string, chain: SdkChainReader) => AccountAdmin & { addDelegateKeys?(keys: { pub: string; label: string }[]): Promise<{ digest: string }> }; readKeyFile: (role: Role) => string }): Promise<SetupResult> {
  if (!cfg.accountId) throw new Error('set MEMWAL_ACCOUNT_ID to the account created on memory.walrus.xyz');
  generateKeys(cfg);
  const chain = new SdkChainReader({ transport: cfg.chainTransport, network: cfg.network, url: cfg.chainTransport === 'grpc' ? cfg.tatumGrpcUrl : cfg.tatumRpcUrl, apiKey: cfg.tatumApiKey, packageId: cfg.packageId });
  const account = await chain.getAccount(cfg.accountId);
  const owner = normalizeSuiAddress(account.owner);
  let admin: ReturnType<NonNullable<typeof opts.admin>>;
  if (opts.admin) admin = opts.admin(owner, chain);
  else {
    if (!opts.ownerSecret) throw new Error('the owner must sign: run antibody setup --wallet (your browser wallet), or set OWNER_SUI_PRIVATE_KEY for a throwaway demo owner');
    const ownerAddr = normalizeSuiAddress(Ed25519Keypair.fromSecretKey(opts.ownerSecret).toSuiAddress());
    if (owner !== ownerAddr) throw new Error(`OWNER_SUI_PRIVATE_KEY controls ${ownerAddr}, but the account owner is ${account.owner}`);
    admin = liveAccountAdmin({ ownerSecret: opts.ownerSecret, accountId: cfg.accountId, packageId: cfg.packageId, registryId: cfg.registryId, network: cfg.network, suiClient: chain.client });
  }
  const wallet = normalizeSuiAddress(Ed25519Keypair.fromSecretKey(opts.readKeyFile('signer')).toSuiAddress());
  persist(cfg, { accountId: cfg.accountId, stewardWallet: wallet, network: cfg.network });
  const existing = new Set(account.delegateKeys.map((k) => k.publicKeyHex));
  const wanted: { lane: string; label: string; pub: string }[] = [];
  for (const role of ROLES) {
    const lane = ROLE_LANE[role];
    if (lane) wanted.push({ lane, label: LANE_LABEL[lane], pub: laneKeyFromSeedHex(opts.readKeyFile(role)).publicKeyHex });
  }
  const todo = wanted.filter((w) => !existing.has(w.pub));
  const digests = new Map<string, string>();
  if (todo.length && admin.addDelegateKeys) {
    const { digest } = await admin.addDelegateKeys(todo.map((t) => ({ pub: t.pub, label: t.label })));
    for (const t of todo) digests.set(t.pub, digest);
  } else for (const t of todo) digests.set(t.pub, (await admin.addDelegateKey(t.pub, t.label)).digest);
  const lanes: SetupResult['lanes'] = wanted.map((w) => ({ ...w, digest: digests.get(w.pub) ?? 'already-registered' }));
  // Verify through the chain reader (Tatum) that every label is bound.
  const after = await chain.getAccount(cfg.accountId);
  for (const l of lanes) {
    if (!after.delegateKeys.some((k) => k.publicKeyHex === l.pub && k.label === l.label)) throw new Error(`lane ${l.lane} key not visible on-chain yet`);
  }
  const genesis = await writeGenesisAs(cfg, cfg.accountId, wallet);
  return { accountId: cfg.accountId, owner, wallet, lanes, genesis, simulated: false };
}

async function writeGenesisAs(cfg: Config, accountId: string, wallet: string) {
  // Setup is the one-time bootstrap that generated every role's key, so it
  // writes genesis before the keys are handed to separate OS users.
  const c: Config = { ...cfg, accountId, stewardWallet: wallet, keyIsolation: 'simulated', role: null };
  const rt = createRuntime(c, 'control');
  const control = buildControl(rt, { signer: null });
  const g = await control.writeGenesis(cfg.backend === 'offline' ? 'fixture' : cfg.network);
  return { blobId: g.blobId, envelopeId: g.envelopeId };
}
