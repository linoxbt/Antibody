// Bridge test ETH from Base Sepolia to Ethereum Sepolia with Across (testnet.across.to), deployer to deployer:
//   npx tsx scripts/bridge.ts <ethAmount>
// Base's own bridge holds withdrawals to Ethereum for days, so this uses Across's relayers (about 10 s).
// The transaction comes from Across's API; it is checked before signing: Base Sepolia, the expected value,
// and the deployer named in the calldata as the recipient.
import { formatEther, parseEther, type Hex } from 'viem';
import { clients, loadRecord, saveRecord, sleep, testnetKey, txUrl } from './lib.ts';

const amount = parseEther(process.argv[2] ?? '0.0042');
const key = testnetKey('deployer');
const base = clients('baseSepolia', key);
const sep = clients('sepolia', key);
const me = base.account.address;
const url = `https://testnet.across.to/api/swap/approval?tradeType=exactInput&amount=${amount}&inputToken=0x0000000000000000000000000000000000000000&originChainId=84532&outputToken=0x0000000000000000000000000000000000000000&destinationChainId=11155111&depositor=${me}&recipient=${me}`;
const q: any = await (await fetch(url)).json();
if (!q.swapTx) throw new Error(`Across: ${JSON.stringify(q).slice(0, 300)}`);
const tx = q.swapTx;
if (tx.chainId !== 84532 || BigInt(tx.value) !== amount) throw new Error('unexpected chain or value in the Across transaction');
if ((tx.data.toLowerCase().split(me.slice(2).toLowerCase()).length - 1) < 2) throw new Error('the calldata does not name the deployer as depositor and recipient');
if ((q.approvalTxns ?? []).length) throw new Error('unexpected approval transactions for a native-ETH bridge');
console.log(`bridging ${formatEther(amount)} ETH, expecting ${formatEther(BigInt(q.expectedOutputAmount))} on Sepolia in about ${q.expectedFillTime}s`);

const before = await sep.pub.getBalance({ address: me });
const hash = await base.wallet.sendTransaction({ to: tx.to as Hex, data: tx.data as Hex, value: amount, chain: base.chain, account: base.account });
const r = await base.pub.waitForTransactionReceipt({ hash });
if (r.status !== 'success') throw new Error(`bridge deposit reverted: ${hash}`);
console.log(`deposit ${txUrl('baseSepolia', hash)}`);
const rec = loadRecord('baseSepolia', 'baseSepolia-v2');
rec.txs.push({ step: `bridge ${formatEther(amount)} ETH to Ethereum Sepolia (Across)`, hash, block: Number(r.blockNumber), events: [] });
saveRecord('baseSepolia', rec, 'baseSepolia-v2');
for (let i = 0; i < 60; i++) {
  const now = await sep.pub.getBalance({ address: me });
  if (now > before) { console.log(`Ethereum Sepolia balance: ${formatEther(now)} ETH`); process.exit(0); }
  await sleep(5_000);
}
console.log('not arrived after 5 minutes; check https://testnet.across.to/transactions');
