// Add fee reserves for a reactive contract through the system contract's depositTo():
//   npx tsx scripts/deposit.ts <lREACT amount> [contract]   (defaults to GuardReactive from deployments/lasna.json)
import { formatEther, parseAbi, parseEther, type Hex } from 'viem';
import { REACTIVE_SYSTEM } from '../networks.ts';
import { clients, lasnaFees, loadRecord, saveRecord, testnetKey, txUrl } from './lib.ts';

const FILE = process.env.GUARD_RECORD ?? 'lasna';
const L = loadRecord('lasna', FILE);
const amount = parseEther(process.argv[2] ?? '0.2');
const target = (process.argv[3] ?? L.guard) as Hex;
const c = clients('lasna', testnetKey('deployer'));
const abi = parseAbi(['function depositTo(address) payable', 'function reserves(address) view returns (uint256)', 'function debt(address) view returns (uint256)']);
const hash = await c.wallet.writeContract({ address: REACTIVE_SYSTEM, abi, functionName: 'depositTo', args: [target], value: amount, chain: c.chain, account: c.account, ...(await lasnaFees(c.pub)) });
const r = await c.pub.waitForTransactionReceipt({ hash });
if (r.status !== 'success') throw new Error(`depositTo reverted: ${hash}`);
L.txs.push({ step: `reserves +${formatEther(amount)} lREACT (depositTo)`, hash, block: Number(r.blockNumber), events: [] });
saveRecord('lasna', L, FILE);
const [res, debt] = await Promise.all([
  c.pub.readContract({ address: REACTIVE_SYSTEM, abi, functionName: 'reserves', args: [target] }),
  c.pub.readContract({ address: REACTIVE_SYSTEM, abi, functionName: 'debt', args: [target] }),
]);
console.log(`${txUrl('lasna', hash)}\nreserves ${formatEther(res)} lREACT, debt ${formatEther(debt)}`);
