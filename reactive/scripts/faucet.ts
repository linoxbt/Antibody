// Turn testnet ETH into lREACT on Lasna through Reactive's faucet contract (1 ETH = 100 lREACT, max 5 ETH):
//   npx tsx scripts/faucet.ts <sepolia|baseSepolia> <ethAmount>
import { formatEther, parseAbi, parseEther } from 'viem';
import { LREACT_FAUCET } from '../networks.ts';
import { clients, loadRecord, saveRecord, sleep, testnetKey, txUrl } from './lib.ts';

const net = (process.argv[2] ?? 'baseSepolia') as keyof typeof LREACT_FAUCET;
const amount = parseEther(process.argv[3] ?? '0.05');
if (amount > parseEther('5')) throw new Error('the faucet loses anything above 5 ETH per transaction');
const key = testnetKey('deployer');
const src = clients(net, key);
const lasna = clients('lasna', key);
const before = await lasna.pub.getBalance({ address: src.account.address });

const hash = await src.wallet.writeContract({
  address: LREACT_FAUCET[net], abi: parseAbi(['function request(address) payable']), functionName: 'request',
  args: [src.account.address], value: amount, chain: src.chain, account: src.account,
});
const r = await src.pub.waitForTransactionReceipt({ hash });
if (r.status !== 'success') throw new Error(`faucet request reverted: ${hash}`);
console.log(`sent ${formatEther(amount)} ETH to the ${net} faucet: ${txUrl(net, hash)}`);
const rec = loadRecord(net);
rec.txs.push({ step: `faucet: ${formatEther(amount)} ETH for lREACT`, hash, block: Number(r.blockNumber), events: [] });
saveRecord(net, rec);

for (let i = 0; i < 60; i++) {
  const now = await lasna.pub.getBalance({ address: src.account.address });
  if (now > before) { console.log(`lREACT on Lasna: ${formatEther(now)}`); process.exit(0); }
  await sleep(10_000);
}
console.log('lREACT has not arrived yet; check again with npm run deployer');
