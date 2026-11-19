// Testnet deployer: `npx tsx scripts/deployer.ts [new|show]`.
// The key lives outside the repository (GUARD_DEPLOYER_KEY_FILE, default ~/.antibody-guard/deployer.key, mode 0600)
// and is used on testnets only: Lasna, Base Sepolia, Sepolia, Unichain Sepolia.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPublicClient, formatEther, http, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { NETWORKS } from '../networks.ts';

export const KEY_FILE = process.env.GUARD_DEPLOYER_KEY_FILE ?? join(homedir(), '.antibody-guard', 'deployer.key');

export function loadDeployerKey(): Hex {
  if (!existsSync(KEY_FILE)) throw new Error(`no deployer key at ${KEY_FILE}; run: npx tsx scripts/deployer.ts new`);
  const key = readFileSync(KEY_FILE, 'utf8').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${KEY_FILE} does not hold a private key`);
  return key as Hex;
}

async function show(): Promise<void> {
  const account = privateKeyToAccount(loadDeployerKey());
  console.log(`deployer ${account.address}`);
  for (const [name, n] of Object.entries(NETWORKS)) {
    try {
      const client = createPublicClient({ transport: http(n.rpc, { timeout: 15_000 }) });
      const wei = await client.getBalance({ address: account.address });
      console.log(`  ${name.padEnd(16)} ${formatEther(wei)} ${n.currency}`);
    } catch (e) {
      console.log(`  ${name.padEnd(16)} unreachable (${(e as Error).message.split('\n')[0]})`);
    }
  }
}

const cmd = process.argv[2] ?? 'show';
if (cmd === 'new') {
  if (existsSync(KEY_FILE)) throw new Error(`${KEY_FILE} already exists; refusing to overwrite it`);
  mkdirSync(dirname(KEY_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(KEY_FILE, generatePrivateKey() + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`new testnet deployer ${privateKeyToAccount(loadDeployerKey()).address} (key in ${KEY_FILE})`);
} else if (cmd === 'show') {
  await show();
} else {
  console.error('usage: npx tsx scripts/deployer.ts [new|show]');
  process.exit(2);
}
