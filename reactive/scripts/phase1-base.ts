// Phase 1 on Base Sepolia: deploy GuardVault, register two payees through the timelock, set a daily
// limit, then let the agent propose payments that the rules pay or refuse. Every step is recorded in
// deployments/baseSepolia.json and is skipped when already done, so the script can be re-run.
import { decodeEventLog, formatEther, parseEther, stringToHex, type Hex } from 'viem';
import { NETWORKS } from '../networks.ts';
import { artifact, clients, loadRecord, saveRecord, sleep, testnetKey, txUrl } from './lib.ts';

const NET = 'baseSepolia' as const;
const PAYEE_DELAY = 120n; // seconds; short so the testnet demo does not wait an hour
const label = (s: string) => stringToHex(s, { size: 32 });

const owner = clients(NET, testnetKey('deployer'));
const agent = clients(NET, testnetKey('agent', true));
const vaultArt = artifact('GuardVault');
const rec = loadRecord(NET);
rec.owner = owner.account.address;
rec.agent = agent.account.address;
// Two demo payees. Nobody holds their keys; the amounts are a few thousandths of test ETH.
rec.payees ??= { alice: '0x' + 'a11ce'.padStart(40, '0'), bob: '0x' + '0b0b'.padStart(40, '0') };

async function send(step: string, fn: () => Promise<Hex>) {
  if (rec.txs.some((t: any) => t.step === step)) return console.log(`skip  ${step}`);
  const hash = await fn();
  const r = await owner.pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${step} reverted: ${hash}`);
  const events = r.logs.flatMap((l) => {
    try { const e = decodeEventLog({ abi: vaultArt.abi, data: l.data, topics: l.topics }); return [e.eventName]; } catch { return []; }
  });
  rec.txs.push({ step, hash, block: Number(r.blockNumber), events });
  saveRecord(NET, rec);
  console.log(`done  ${step}  ${events.join(', ')}  ${txUrl(NET, hash)}`);
}

const vaultCall = (who: typeof owner, functionName: string, args: unknown[]) => () =>
  who.wallet.writeContract({ address: rec.vault, abi: vaultArt.abi, functionName, args, chain: who.chain, account: who.account });

// 1. deploy, funded with a little test ETH for payments and callback fees
if (!rec.vault) {
  const hash = await owner.wallet.deployContract({
    abi: vaultArt.abi, bytecode: vaultArt.bytecode, args: [NETWORKS[NET].callbackProxy, agent.account.address, PAYEE_DELAY],
    value: parseEther('0.03'), chain: owner.chain, account: owner.account,
  });
  const r = await owner.pub.waitForTransactionReceipt({ hash });
  rec.vault = r.contractAddress;
  rec.txs.push({ step: 'deploy GuardVault', hash, block: Number(r.blockNumber), events: ['AgentSet', 'PayeeDelaySet'] });
  saveRecord(NET, rec);
  console.log(`done  deploy GuardVault at ${rec.vault}  ${txUrl(NET, hash)}`);
}

// 2. gas for the agent (it only ever calls proposePayment)
await send('fund agent', () => owner.wallet.sendTransaction({ to: agent.account.address, value: parseEther('0.003'), chain: owner.chain, account: owner.account }));

// 3. limits and payees (timelocked)
await send('daily limit 0.01 ETH', vaultCall(owner, 'setDailyLimit', ['0x0000000000000000000000000000000000000000', parseEther('0.01')]));
await send('request payee alice (cap 0.003)', vaultCall(owner, 'requestPayee', [label('alice'), rec.payees.alice, parseEther('0.003')]));
await send('request payee bob (cap 0.005)', vaultCall(owner, 'requestPayee', [label('bob'), rec.payees.bob, parseEther('0.005')]));

const pending = async (l: string) => ((await owner.pub.readContract({ address: rec.vault, abi: vaultArt.abi, functionName: 'payees', args: [label(l)] })) as any[])[4] as bigint;
for (const who of ['alice', 'bob']) {
  const at = await pending(who);
  if (at === 0n) continue;
  const now = (await owner.pub.getBlock()).timestamp;
  if (now < at) { console.log(`wait  ${at - now}s for the payee timelock`); await sleep(Number(at - now + 4n) * 1000); }
  await send(`activate payee ${who}`, vaultCall(owner, 'activatePayee', [label(who)]));
}

// 4. the agent proposes; the vault pays or refuses
const ETH = '0x0000000000000000000000000000000000000000';
const propose = (to: string, amount: string, l: string) => vaultCall(agent, 'proposePayment', [to, ETH, parseEther(amount), label(l)]);
await send('agent pays alice 0.001 (allowed)', propose(rec.payees.alice, '0.001', 'alice'));
await send('agent pays bob 0.002 labelled alice (LabelMismatch)', propose(rec.payees.bob, '0.002', 'alice'));
await send('agent pays an unknown address (UnknownPayee)', propose('0x000000000000000000000000000000000000dEaD', '0.001', 'alice'));
await send('agent pays alice 0.004 (OverCap)', propose(rec.payees.alice, '0.004', 'alice'));
await send('agent pays alice 0.001 again (Duplicate)', propose(rec.payees.alice, '0.001', 'alice'));
await send('agent pays bob 0.004 (allowed)', propose(rec.payees.bob, '0.004', 'bob'));

const bal = await owner.pub.getBalance({ address: rec.vault });
console.log(`vault ${rec.vault} holds ${formatEther(bal)} ETH; ${rec.txs.length} transactions recorded`);
