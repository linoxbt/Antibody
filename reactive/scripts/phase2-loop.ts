// Phase 2: deploy GuardReactive on Lasna, make it the guardian of the Base Sepolia vault, then run a
// compromised agent against the vault and record the whole loop for each decision:
//   origin transaction (Base Sepolia) -> reactive transaction (Lasna) -> callback transaction (Base Sepolia).
// Re-runnable: finished steps are skipped (deployments/lasna.json and deployments/baseSepolia.json).
import { decodeEventLog, formatEther, parseAbi, parseEther, stringToHex, type Hex } from 'viem';
import { NETWORKS, REACTIVE_SYSTEM } from '../networks.ts';
import { artifact, clients, lasnaFees, loadRecord, saveRecord, sleep, testnetKey, txUrl } from './lib.ts';

const label = (s: string) => stringToHex(s, { size: 32 });
const ETH = '0x0000000000000000000000000000000000000000';
const ATTACKER = '0x00000000000000000000000000000000bada11ce'; // looks like alice's 0x…a11ce

const key = testnetKey('deployer');
const lasna = clients('lasna', key);
const base = clients('baseSepolia', key);
const agent = clients('baseSepolia', testnetKey('agent'));
const rxArt = artifact('GuardReactive');
const vaultArt = artifact('GuardVault');
const L = loadRecord('lasna');
const B = loadRecord('baseSepolia');
L.loops ??= [];
const vault = B.vault as Hex;

async function step(rec: any, net: 'lasna' | 'baseSepolia', name: string, fn: () => Promise<Hex>, who = net === 'lasna' ? lasna : base): Promise<Hex> {
  const done = rec.txs.find((t: any) => t.step === name);
  if (done) { console.log(`skip  ${name}`); return done.hash; }
  const hash = await fn();
  const r = await who.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== 'success') throw new Error(`${name} reverted: ${hash}`);
  rec.txs.push({ step: name, hash, block: Number(r.blockNumber), events: eventNames(r.logs) });
  saveRecord(net, rec);
  console.log(`done  ${name}  ${txUrl(net, hash)}`);
  return hash;
}

function eventNames(logs: readonly any[]): string[] {
  return logs.flatMap((l) => {
    for (const abi of [vaultArt.abi, rxArt.abi]) {
      try { return [String(decodeEventLog({ abi, data: l.data, topics: l.topics }).eventName)]; } catch { /* next */ }
    }
    return [];
  });
}

// ---- 1. deploy and wire -----------------------------------------------------------------
if (!L.guard) {
  const hash = await lasna.wallet.deployContract({ abi: rxArt.abi, bytecode: rxArt.bytecode, value: parseEther('1.5'), chain: lasna.chain, account: lasna.account, ...(await lasnaFees(lasna.pub)) });
  const r = await lasna.pub.waitForTransactionReceipt({ hash });
  L.guard = r.contractAddress;
  L.owner = lasna.account.address;
  L.txs.push({ step: 'deploy GuardReactive (funded 1.5 lREACT)', hash, block: Number(r.blockNumber), events: [] });
  saveRecord('lasna', L);
  console.log(`done  deploy GuardReactive at ${L.guard}  ${txUrl('lasna', hash)}`);
}
const guard = L.guard as Hex;
const rxWrite = (fn: string, args: unknown[]) => async () => lasna.wallet.writeContract({ address: guard, abi: rxArt.abi, functionName: fn, args, chain: lasna.chain, account: lasna.account, ...(await lasnaFees(lasna.pub)) });
const vWrite = (who: typeof base, fn: string, args: unknown[]) => () => who.wallet.writeContract({ address: vault, abi: vaultArt.abi, functionName: fn, args, chain: who.chain, account: who.account });

await step(L, 'lasna', 'watch the Base Sepolia vault', rxWrite('watch', [BigInt(NETWORKS.baseSepolia.chainId), vault]));
await step(B, 'baseSepolia', 'set GuardReactive as guardian', vWrite(base, 'setGuardian', [guard]));
await step(B, 'baseSepolia', 'top up vault 0.02 ETH (payments + callback fees)', () => base.wallet.sendTransaction({ to: vault, value: parseEther('0.02'), chain: base.chain, account: base.account }));
await step(B, 'baseSepolia', 'daily limit 0.03 ETH', vWrite(base, 'setDailyLimit', [ETH, parseEther('0.03')]));
if ((await base.pub.readContract({ address: vault, abi: vaultArt.abi, functionName: 'frozen' })) as boolean) {
  await step(B, 'baseSepolia', `owner unfreezes (${new Date().toISOString()})`, vWrite(base, 'unfreeze', []));
}
await sleep(5_000); // let the subscriptions settle

// ---- 2. the loop, recorded ---------------------------------------------------------------
const vaultRead = (fn: string, args: unknown[] = []) => base.pub.readContract({ address: vault, abi: vaultArt.abi, functionName: fn, args });
const decisionAbi = parseAbi(['event Decision(uint256 indexed chainId, address indexed vault, uint8 indexed rule, address subject, bytes32 reason, uint256 originTx)']);
const systemAbi = parseAbi(['function getCallbacks(uint256) view returns ((uint256 blockNumber, address reactive, uint256 index, uint256 chainId, uint256 txHash, bytes err)[])']);
const RULES = ['None', 'Burst', 'RepeatedRefusals', 'UnknownRecipient'];

/** Find GuardReactive's Decision for an origin transaction on Lasna, then the callback it produced on Base Sepolia. */
async function trace(name: string, candidates: Hex[], until: () => Promise<boolean>) {
  const t0 = Date.now();
  while (!(await until())) {
    if (Date.now() - t0 > 300_000) throw new Error(`${name}: no reaction within 5 minutes`);
    await sleep(3_000);
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  const head = await lasna.pub.getBlockNumber();
  const logs = await lasna.pub.getLogs({ address: guard, event: decisionAbi[0], fromBlock: head - 5_000n, toBlock: head });
  const d = logs.find((l) => candidates.some((c) => BigInt(c) === (l.args.originTx as bigint)));
  if (!d) throw new Error(`${name}: no Decision for ${candidates.join(', ')} on Lasna`);
  const originTx = candidates.find((c) => BigInt(c) === (d.args.originTx as bigint))!;
  let callbackTx: Hex | undefined;
  for (let i = 0; i < 40 && !callbackTx; i++) {
    const cbs = await lasna.pub.readContract({ address: REACTIVE_SYSTEM, abi: systemAbi, functionName: 'getCallbacks', args: [BigInt(d.transactionHash)] });
    const c = cbs.find((x) => x.chainId === BigInt(NETWORKS.baseSepolia.chainId));
    if (c && c.txHash !== 0n) callbackTx = `0x${c.txHash.toString(16).padStart(64, '0')}`;
    else await sleep(3_000);
  }
  const loop = {
    name, rule: RULES[Number(d.args.rule)], subject: d.args.subject,
    origin: { chain: 'baseSepolia', tx: originTx },
    reactive: { chain: 'lasna', tx: d.transactionHash, block: Number(d.blockNumber) },
    callback: { chain: 'baseSepolia', tx: callbackTx ?? null },
    observedSeconds: seconds,
  };
  L.loops.push(loop);
  saveRecord('lasna', L);
  console.log(`loop  ${name}: ${loop.rule}\n      origin   ${txUrl('baseSepolia', originTx)}\n      reactive ${txUrl('lasna', d.transactionHash)}\n      callback ${callbackTx ? txUrl('baseSepolia', callbackTx) : '(not recorded yet)'}\n      vault changed ${seconds}s after the origin transaction was mined`);
}

const propose = (to: string, amount: string, l: string) => vWrite(agent, 'proposePayment', [to, ETH, parseEther(amount), label(l)]);
const tag = Date.now().toString(36);

if (!L.loops.some((l: any) => l.rule === 'UnknownRecipient')) {
  // A: the agent was tricked into paying a look-alike address
  const tx = await step(B, 'baseSepolia', `[loop A ${tag}] agent pays look-alike ${ATTACKER} (UnknownPayee)`, propose(ATTACKER, '0.001', 'alice'), agent);
  await trace('A: unknown recipient is quarantined', [tx], async () => (await vaultRead('quarantined', [ATTACKER])) as boolean);
}

if (!L.loops.some((l: any) => l.rule === 'RepeatedRefusals')) {
  // B: the agent keeps trying things the rules refuse; the third refusal in 10 minutes freezes the vault
  // (loop A's refusal may already count as the first of the three)
  const b1 = await step(B, 'baseSepolia', `[loop B ${tag}] agent pays alice 0.004 (OverCap)`, propose(B.payees.alice, '0.004', 'alice'), agent);
  const b2 = await step(B, 'baseSepolia', `[loop B ${tag}] agent pays bob labelled alice (LabelMismatch)`, propose(B.payees.bob, '0.0021', 'alice'), agent);
  const b3 = await step(B, 'baseSepolia', `[loop B ${tag}] agent pays alice 0.0035 (OverCap, or Frozen if the freeze landed)`, propose(B.payees.alice, '0.0035', 'alice'), agent);
  await trace('B: repeated refusals freeze the vault', [b1, b2, b3], async () => (await vaultRead('frozen')) as boolean);
  await step(B, 'baseSepolia', `[loop B ${tag}] agent pays alice 0.001 while frozen (Frozen)`, propose(B.payees.alice, '0.0012', 'alice'), agent);
  await step(B, 'baseSepolia', `[loop B ${tag}] owner unfreezes`, vWrite(base, 'unfreeze', []));
  await sleep(20_000); // let Unfrozen reach GuardReactive so it resets its counters
}

if (!L.loops.some((l: any) => l.rule === 'Burst')) {
  // C: six valid payments in a row, faster than any human would approve: a burst freezes the vault
  const burst: Hex[] = [];
  for (let i = 0; i < 6; i++) {
    burst.push(await step(B, 'baseSepolia', `[loop C ${tag}] burst payment ${i + 1} to alice`, propose(B.payees.alice, (0.0011 + i * 0.0001).toFixed(4), 'alice'), agent));
  }
  await trace('C: a burst of payments freezes the vault', burst, async () => (await vaultRead('frozen')) as boolean);
  await step(B, 'baseSepolia', `[loop C ${tag}] owner unfreezes`, vWrite(base, 'unfreeze', []));
}

console.log(`GuardReactive ${guard} holds ${formatEther(await lasna.pub.getBalance({ address: guard }))} lREACT; vault ${formatEther(await base.pub.getBalance({ address: vault }))} ETH`);
