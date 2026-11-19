// Shared helpers for the Guard deploy and demo scripts (viem, compiled Hardhat artifacts, deployment records).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, type Abi, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { NETWORKS } from '../networks.ts';

export type NetworkName = keyof typeof NETWORKS;
export const KEY_DIR = process.env.GUARD_KEY_DIR ?? join(homedir(), '.antibody-guard');
const ROOT = new URL('..', import.meta.url).pathname;

/**
 * A testnet key kept outside the repository (created on first use, mode 0600). A service sets
 * GUARD_<NAME>_KEY instead (for example GUARD_SCORER_KEY on Railway).
 */
export function testnetKey(name: string, create = false): Hex {
  const fromEnv = process.env[`GUARD_${name.toUpperCase()}_KEY`];
  if (fromEnv) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(fromEnv.trim())) throw new Error(`GUARD_${name.toUpperCase()}_KEY is not a private key`);
    return fromEnv.trim() as Hex;
  }
  const file = join(KEY_DIR, `${name}.key`);
  if (!existsSync(file)) {
    if (!create) throw new Error(`no ${name} key at ${file}`);
    mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(file, generatePrivateKey() + '\n', { mode: 0o600, flag: 'wx' });
  }
  const key = readFileSync(file, 'utf8').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${file} does not hold a private key`);
  return key as Hex;
}

export function chainOf(name: NetworkName) {
  const n = NETWORKS[name];
  return defineChain({
    id: n.chainId, name, nativeCurrency: { name: n.currency, symbol: n.currency, decimals: 18 },
    rpcUrls: { default: { http: [n.rpc] } }, blockExplorers: { default: { name: 'explorer', url: n.explorer } },
    // Lasna refuses a zero priority tip, and its RPC estimates zero
  });
}

export function clients(name: NetworkName, key: Hex) {
  const chain = chainOf(name);
  const transport = http(NETWORKS[name].rpc, { timeout: 30_000, retryCount: 4 });
  const account = privateKeyToAccount(key);
  return {
    chain, account,
    pub: createPublicClient({ chain, transport }),
    wallet: createWalletClient({ chain, transport, account }),
  };
}

/** A contract's ABI from abi/ (committed, so a service needs no compiler); `npm run abi` refreshes it. */
export function abiOf(contract: string): Abi {
  return JSON.parse(readFileSync(join(ROOT, `abi/${contract}.json`), 'utf8'));
}

export function artifact(contract: string): { abi: Abi; bytecode: Hex } {
  const a = JSON.parse(readFileSync(join(ROOT, `artifacts/contracts/${contract}.sol/${contract}.json`), 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode };
}

/** Deployment records are committed (deployments/<network>.json): addresses and transaction hashes only. */
/** `file` names a separate record on the same network (for example `baseSepolia-v2`); defaults to the network. */
export function loadRecord(name: NetworkName, file: string = name): Record<string, any> {
  const f = join(ROOT, `deployments/${file}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { network: name, chainId: NETWORKS[name].chainId, txs: [] };
}

export function saveRecord(name: NetworkName, rec: Record<string, any>, file: string = name): void {
  writeFileSync(join(ROOT, `deployments/${file}.json`), JSON.stringify(rec, null, 2) + '\n');
}

export const txUrl = (name: NetworkName, hash: string) => `${NETWORKS[name].explorer}/tx/${hash}`;
export const addrUrl = (name: NetworkName, a: string) => `${NETWORKS[name].explorer}/address/${a}`;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Lasna refuses a zero priority tip, and viem's wallet path estimates zero there: pass these on Lasna writes. */
export async function lasnaFees(pub: { getBlock: () => Promise<{ baseFeePerGas: bigint | null }> }) {
  const tip = 1_000_000_000n;
  const base = (await pub.getBlock()).baseFeePerGas ?? 100_000_000_000n;
  // the RPC refuses a transaction whose worst-case fee exceeds 1 lREACT, so keep the ceiling close to the base fee
  return { maxFeePerGas: base + base / 4n + tip, maxPriorityFeePerGas: tip };
}
