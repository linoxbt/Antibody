/**
 * Demo cast on mainnet: landlord and sister wallets (throwaway keys kept in
 * <home>/cast.json, 0600, so any SUI paid to them can be recovered), and
 * Steward's wallet funded with a little SUI by the demo owner.
 *
 *   npx tsx scripts/mainnet/cast.ts [fund-mist]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { loadConfig } from '../../src/config.ts';
import { SdkChainReader } from '../../src/adapters/chain-sdk.ts';

const cfg = loadConfig();
if (cfg.backend !== 'live' || !cfg.stewardWallet) throw new Error('run antibody setup on the live home first');
const chain = new SdkChainReader({ transport: 'grpc', network: cfg.network, url: cfg.tatumGrpcUrl, apiKey: cfg.tatumApiKey, packageId: cfg.packageId, grpcWire: cfg.grpcWire });
const p = join(cfg.home, 'cast.json');
const gen = () => Ed25519Keypair.generate().getSecretKey();
const cast: Record<string, string> = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { landlord: gen(), sister: gen() };
writeFileSync(p, JSON.stringify(cast, null, 2), { mode: 0o600 });
for (const [who, secret] of Object.entries(cast)) console.log(`${who.padEnd(9)} ${Ed25519Keypair.fromSecretKey(secret).toSuiAddress()}`);
const want = BigInt(process.argv[2] ?? '120000000');
const sui = (a: string) => chain.listBalances(a).then((bs) => BigInt(bs.find((b) => b.coinType.endsWith('::sui::SUI'))?.balance ?? '0'));
const have = await sui(cfg.stewardWallet);
if (have < want) {
  const owner = Ed25519Keypair.fromSecretKey(process.env.OWNER_SUI_PRIVATE_KEY ?? '');
  const tx = new Transaction();
  tx.setSender(owner.toSuiAddress());
  tx.transferObjects([tx.splitCoins(tx.gas, [want - have])], cfg.stewardWallet);
  const bytes = await tx.build({ client: chain.client });
  const r = await chain.execute(bytes, (await owner.signTransaction(bytes)).signature);
  if (!r.ok) throw new Error(`funding failed: ${r.error}`);
  console.log(`funded Steward ${cfg.stewardWallet} with ${Number(want - have) / 1e9} SUI: ${r.digest}`);
}
console.log(`Steward holds ${Number(await sui(cfg.stewardWallet)) / 1e9} SUI`);
process.exit(0);
