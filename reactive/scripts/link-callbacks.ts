// Links each recorded loop to its callback transaction on the destination chain. The system contract's
// getCallbacks() record can be empty on Lasna, so this finds the vault event the callback produced
// (Frozen or Quarantined) in a transaction sent to that chain's callback proxy after the origin block.
import { parseAbiItem, type Hex } from 'viem';
import { NETWORKS } from '../networks.ts';
import { clients, loadRecord, saveRecord, testnetKey } from './lib.ts';

const L = loadRecord('lasna');
const key = testnetKey('deployer');
const events = {
  UnknownRecipient: parseAbiItem('event Quarantined(address indexed account, bytes32 reason)'),
  RepeatedRefusals: parseAbiItem('event Frozen(address indexed by, bytes32 reason)'),
  Burst: parseAbiItem('event Frozen(address indexed by, bytes32 reason)'),
} as const;

for (const loop of L.loops ?? []) {
  if (loop.callback?.tx) continue;
  const net = loop.callback.chain as 'baseSepolia';
  const { pub } = clients(net, key);
  const vault = loadRecord(net).vault as Hex;
  const origin = await pub.getTransactionReceipt({ hash: loop.origin.tx });
  const logs = await pub.getLogs({ address: vault, event: events[loop.rule as keyof typeof events], fromBlock: origin.blockNumber, toBlock: origin.blockNumber + 150n });
  for (const log of logs) {
    const tx = await pub.getTransaction({ hash: log.transactionHash! });
    if (tx.to?.toLowerCase() !== NETWORKS[net].callbackProxy.toLowerCase()) continue;
    if (loop.rule === 'UnknownRecipient' && String((log.args as any).account).toLowerCase() !== String(loop.subject).toLowerCase()) continue;
    const block = await pub.getBlock({ blockNumber: log.blockNumber! });
    const originBlock = await pub.getBlock({ blockNumber: origin.blockNumber });
    loop.callback = { chain: net, tx: log.transactionHash, block: Number(log.blockNumber), via: 'vault event in a callback-proxy transaction' };
    loop.originToCallbackSeconds = Number(block.timestamp - originBlock.timestamp);
    console.log(`${loop.name}: callback ${log.transactionHash} (${loop.originToCallbackSeconds}s after the origin block)`);
    break;
  }
}
saveRecord('lasna', L);
