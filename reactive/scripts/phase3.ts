// Phase 3: GuardReactive v2 on Lasna and GuardVault v2 on Base Sepolia (and Ethereum Sepolia when funded),
// then live scenarios, each recorded origin -> reactive -> callback:
//   D. unknown recipient on Base Sepolia -> quarantined there, and the address becomes a lesson
//   E. a payee change towards that attacker -> vetoed before its timelock ends
//   F. a recurring payment -> CRON subscribed, paid twice when due, schedule cancelled -> CRON unsubscribed
//   G. (with Sepolia funds) a vault on Ethereum Sepolia is watched and immunized with the lesson at once,
//      then an attacker seen on Sepolia is quarantined on Base Sepolia too
// Re-runnable: finished steps are skipped. Records: deployments/{lasna,baseSepolia,sepolia}-v2.json.
import { decodeEventLog, formatEther, parseAbi, parseEther, stringToHex, type Hex } from 'viem';
import { NETWORKS } from '../networks.ts';
import { artifact, clients, lasnaFees, loadRecord, saveRecord, sleep, testnetKey, txUrl, type NetworkName } from './lib.ts';

const label = (s: string) => stringToHex(s, { size: 32 });
const ETH = '0x0000000000000000000000000000000000000000';
const ATTACKER = '0x00000000000000000000000000000000bada11ce'; // looks like alice's 0x…a11ce
const ATTACKER2 = '0x0000000000000000000000000000000000b0bbad'; // looks like bob's 0x…0b0b
const PAYEES = { alice: '0x' + 'a11ce'.padStart(40, '0'), bob: '0x' + '0b0b'.padStart(40, '0') };
const only = process.argv[2]; // optional: run one scenario (D, E, F or G)

const key = testnetKey('deployer');
const agentKey = testnetKey('agent');
const lasna = clients('lasna', key);
const rxArt = artifact('GuardReactive');
const vaultArt = artifact('GuardVault');
const L = loadRecord('lasna', 'lasna-v2');
L.loops ??= [];
const vaultNets = ['baseSepolia', 'sepolia'] as const;
type VaultNet = (typeof vaultNets)[number];
const R: Record<VaultNet, any> = { baseSepolia: loadRecord('baseSepolia', 'baseSepolia-v2'), sepolia: loadRecord('sepolia', 'sepolia-v2') };
const save = (net: NetworkName) => (net === 'lasna' ? saveRecord('lasna', L, 'lasna-v2') : saveRecord(net, R[net as VaultNet], `${net}-v2`));
const RULES = ['None', 'Burst', 'RepeatedRefusals', 'UnknownRecipient', 'CrossChainQuarantine', 'PayeeVeto', 'ScheduledPayment', 'Retry'];

function names(logs: readonly any[]): string[] {
  return logs.flatMap((l) => {
    for (const abi of [vaultArt.abi, rxArt.abi]) {
      try { return [String(decodeEventLog({ abi, data: l.data, topics: l.topics }).eventName)]; } catch { /* next */ }
    }
    return [];
  });
}

async function step(net: NetworkName, name: string, fn: () => Promise<Hex>, who = clients(net, key)): Promise<Hex> {
  const rec = net === 'lasna' ? L : R[net as VaultNet];
  const done = rec.txs.find((t: any) => t.step === name);
  if (done) { console.log(`skip  ${name}`); return done.hash; }
  const hash = await fn();
  const r = await who.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== 'success') throw new Error(`${name} reverted: ${hash}`);
  rec.txs.push({ step: name, hash, block: Number(r.blockNumber), events: names(r.logs) });
  save(net);
  console.log(`done  ${name}  ${txUrl(net, hash)}`);
  return hash;
}

const rxWrite = (fn: string, args: unknown[]) => async () =>
  lasna.wallet.writeContract({ address: L.guard, abi: rxArt.abi, functionName: fn, args, chain: lasna.chain, account: lasna.account, ...(await lasnaFees(lasna.pub)) });
const vWrite = (net: VaultNet, fn: string, args: unknown[], asAgent = false) => () => {
  const c = clients(net, asAgent ? agentKey : key);
  return c.wallet.writeContract({ address: R[net].vault, abi: vaultArt.abi, functionName: fn, args, chain: c.chain, account: c.account });
};
const vRead = (net: VaultNet, fn: string, args: unknown[] = []) => clients(net, key).pub.readContract({ address: R[net].vault, abi: vaultArt.abi, functionName: fn, args });

// ---- deploy GuardReactive v2 ----------------------------------------------------------------
if (!L.guard) {
  const hash = await lasna.wallet.deployContract({ abi: rxArt.abi, bytecode: rxArt.bytecode, value: parseEther('1'), chain: lasna.chain, account: lasna.account, ...(await lasnaFees(lasna.pub)) });
  const r = await lasna.pub.waitForTransactionReceipt({ hash });
  Object.assign(L, { guard: r.contractAddress, owner: lasna.account.address, version: 2 });
  L.txs.push({ step: 'deploy GuardReactive v2 (funded 1 lREACT)', hash, block: Number(r.blockNumber), events: [] });
  save('lasna');
  console.log(`done  deploy GuardReactive v2 at ${L.guard}  ${txUrl('lasna', hash)}`);
  const dep = await lasna.wallet.writeContract({ address: '0x8888888888888888888888888888888888888888', abi: parseAbi(['function depositTo(address) payable']), functionName: 'depositTo', args: [L.guard], value: parseEther('0.3'), chain: lasna.chain, account: lasna.account, ...(await lasnaFees(lasna.pub)) });
  await lasna.pub.waitForTransactionReceipt({ hash: dep });
  L.txs.push({ step: 'reserves +0.3 lREACT (depositTo)', hash: dep, events: [] });
  save('lasna');
}

/** Deploy, configure and watch a v2 vault on `net` (agent gas, payees through the timelock, limit). */
async function setUpVault(net: VaultNet) {
  const c = clients(net, key);
  const agent = clients(net, agentKey);
  const rec = R[net];
  if (!rec.vault) {
    const hash = await c.wallet.deployContract({ abi: vaultArt.abi, bytecode: vaultArt.bytecode, args: [NETWORKS[net].callbackProxy, agent.account.address, 60n], value: parseEther('0.02'), chain: c.chain, account: c.account });
    const r = await c.pub.waitForTransactionReceipt({ hash });
    Object.assign(rec, { vault: r.contractAddress, owner: c.account.address, agent: agent.account.address, payees: PAYEES, version: 2 });
    rec.txs.push({ step: 'deploy GuardVault v2 (payee delay 60 s)', hash, block: Number(r.blockNumber), events: names(r.logs) });
    save(net);
    console.log(`done  deploy GuardVault v2 on ${net} at ${rec.vault}  ${txUrl(net, hash)}`);
  }
  if ((await c.pub.getBalance({ address: agent.account.address })) < parseEther('0.001')) {
    await step(net, 'fund agent', () => c.wallet.sendTransaction({ to: agent.account.address, value: parseEther('0.003'), chain: c.chain, account: c.account }));
  }
  await step(net, 'set GuardReactive v2 as guardian', vWrite(net, 'setGuardian', [L.guard]));
  await step(net, 'daily limit 0.03 ETH', vWrite(net, 'setDailyLimit', [ETH, parseEther('0.03')]));
  await step(net, 'request payee alice (cap 0.003)', vWrite(net, 'requestPayee', [label('alice'), PAYEES.alice, parseEther('0.003')]));
  await step(net, 'request payee bob (cap 0.005)', vWrite(net, 'requestPayee', [label('bob'), PAYEES.bob, parseEther('0.005')]));
  for (const who of ['alice', 'bob'] as const) {
    const p = (await vRead(net, 'payees', [label(who)])) as any[];
    if (p[4] === 0n) continue;
    const now = (await c.pub.getBlock()).timestamp;
    if (now < p[4]) await sleep(Number(p[4] - now + 4n) * 1000);
    await step(net, `activate payee ${who}`, vWrite(net, 'activatePayee', [label(who)]));
  }
}

/**
 * Wait for the vault on `net` to change, then find GuardReactive's Decision (one of `rules`) on Lasna and
 * the callback on `net`: the vault event `callbackEvent` in a transaction sent to that chain's callback proxy.
 */
async function trace(name: string, net: VaultNet, originNet: NetworkName, origin: Hex, until: () => Promise<boolean>, rules: string[], callbackEvent: string, subject?: string) {
  const dest = clients(net, key);
  const startDest = (await dest.pub.getBlockNumber()) - 5n;
  const t0 = Date.now();
  while (!(await until())) {
    if (Date.now() - t0 > 900_000) throw new Error(`${name}: no reaction within 15 minutes`);
    await sleep(4_000);
  }
  const used = new Set(L.loops.flatMap((l: any) => [l.reactive?.tx, l.callback?.tx]));
  const decisions = parseAbi(['event Decision(uint256 indexed chainId, address indexed vault, uint8 indexed rule, address subject, bytes32 reason, uint256 originTx)']);
  const head = await lasna.pub.getBlockNumber();
  const logs = await lasna.pub.getLogs({ address: L.guard, event: decisions[0], fromBlock: head - 3_000n, toBlock: head });
  const d = logs.find((l) => !used.has(l.transactionHash) && rules.includes(RULES[Number(l.args.rule)]) && Number(l.args.chainId) === NETWORKS[net].chainId && (!subject || String(l.args.subject).toLowerCase() === subject.toLowerCase()));
  if (!d) throw new Error(`${name}: no Decision on Lasna`);
  let callback: any = null;
  const tip = await dest.pub.getBlockNumber();
  for (let from = startDest; from <= tip && !callback; from += 150n) {
    const batch = await dest.pub.getLogs({ address: R[net].vault, fromBlock: from, toBlock: from + 149n > tip ? tip : from + 149n });
    for (const l of batch) {
      if (used.has(l.transactionHash) || names([l])[0] !== callbackEvent) continue;
      const tx = await dest.pub.getTransaction({ hash: l.transactionHash! });
      if (tx.to?.toLowerCase() !== NETWORKS[net].callbackProxy.toLowerCase()) continue;
      callback = { chain: net, tx: l.transactionHash, block: Number(l.blockNumber) };
      break;
    }
  }
  const ts = async (n: NetworkName, h: Hex) => (await clients(n, key).pub.getBlock({ blockNumber: (await clients(n, key).pub.getTransactionReceipt({ hash: h })).blockNumber })).timestamp;
  const [tOrigin, tReactive, tCallback] = await Promise.all([ts(originNet, origin), ts('lasna', d.transactionHash), callback ? ts(net, callback.tx) : Promise.resolve(null)]);
  const scheduled = rules.includes('ScheduledPayment'); // the CRON tick, not the owner's transaction, starts these
  const loop = {
    name, rule: RULES[Number(d.args.rule)], subject: d.args.subject,
    origin: { chain: originNet, tx: origin }, reactive: { chain: 'lasna', tx: d.transactionHash, block: Number(d.blockNumber) },
    callback: callback ?? { chain: net, tx: null },
    originToCallbackSeconds: tCallback !== null && !scheduled ? Number(tCallback - tOrigin) : null,
    reactiveToCallbackSeconds: tCallback !== null ? Number(tCallback - tReactive) : null,
  };
  L.loops.push(loop);
  save('lasna');
  console.log(`loop  ${name}: ${loop.rule}\n      origin   ${txUrl(originNet, origin)}\n      reactive ${txUrl('lasna', d.transactionHash)}\n      callback ${callback ? `${txUrl(net, callback.tx)} (${loop.originToCallbackSeconds ?? loop.reactiveToCallbackSeconds}s)` : 'not found'}`);
}
const has = (n: string) => L.loops.some((l: any) => l.name.startsWith(n));
const tag = Date.now().toString(36);

await setUpVault('baseSepolia');
await step('lasna', 'watch the Base Sepolia vault v2', rxWrite('watch', [BigInt(NETWORKS.baseSepolia.chainId), R.baseSepolia.vault]));
await sleep(5_000);

if ((!only || only === 'D') && !has('D:')) {
  const tx = await step('baseSepolia', `[D ${tag}] agent pays look-alike ${ATTACKER} (UnknownPayee)`, vWrite('baseSepolia', 'proposePayment', [ATTACKER, ETH, parseEther('0.001'), label('alice')], true), clients('baseSepolia', agentKey));
  await trace('D: unknown recipient quarantined, and learned', 'baseSepolia', 'baseSepolia', tx, async () => (await vRead('baseSepolia', 'quarantined', [ATTACKER])) as boolean, ['UnknownRecipient'], 'Quarantined', ATTACKER);
}

if ((!only || only === 'E') && !has('E:')) {
  // the owner's session is hijacked and asks to point "alice" at the attacker; the timelock gives Reactive time to veto
  const tx = await step('baseSepolia', `[E ${tag}] payee change: alice -> ${ATTACKER}`, vWrite('baseSepolia', 'requestPayee', [label('alice'), ATTACKER, parseEther('0.003')]));
  await trace('E: payee change to a known attacker vetoed', 'baseSepolia', 'baseSepolia', tx, async () => ((await vRead('baseSepolia', 'payees', [label('alice')])) as any[])[4] === 0n, ['PayeeVeto'], 'PayeeChangeVetoed', ATTACKER);
}

if ((!only || only === 'F') && !has('F:')) {
  // a 10-minute recurring payment to bob: GuardReactive subscribes to CRON, pays twice, then the owner cancels it
  const set = await step('baseSepolia', `[F ${tag}] owner schedules 0.0007 ETH to bob every 10 min`, vWrite('baseSepolia', 'setSchedule', [label('bob'), ETH, parseEther('0.0007'), 600n, 0n]));
  const id = (await vRead('baseSepolia', 'scheduleCount')) as bigint;
  for (const n of [1n, 2n]) {
    await trace(`F: recurring payment ${n} paid on CRON`, 'baseSepolia', 'baseSepolia', set, async () => {
      const s = (await vRead('baseSepolia', 'schedules', [id])) as any[];
      const start = R.baseSepolia.txs.find((t: any) => t.hash === set);
      const b = await clients('baseSepolia', key).pub.getBlock({ blockNumber: BigInt(start.block) });
      return BigInt(s[4]) >= b.timestamp + 600n * n; // advanced n times
    }, ['ScheduledPayment'], 'ScheduleAdvanced');
  }
  await step('baseSepolia', `[F ${tag}] owner cancels the schedule (CRON unsubscribed)`, vWrite('baseSepolia', 'cancelSchedule', [id]));
}

if (!only || only === 'G') {
  const sep = clients('sepolia', key);
  if ((await sep.pub.getBalance({ address: sep.account.address })) < parseEther('0.03')) {
    console.log('G skipped: the deployer needs about 0.03 ETH on Ethereum Sepolia');
  } else if (!has('G')) {
    await setUpVault('sepolia');
    const w = await step('lasna', 'watch the Sepolia vault v2 (immunized with the lessons)', rxWrite('watch', [BigInt(NETWORKS.sepolia.chainId), R.sepolia.vault]));
    await trace('G1: new vault on Sepolia immunized with the lesson from Base Sepolia', 'sepolia', 'lasna', w, async () => (await vRead('sepolia', 'quarantined', [ATTACKER])) as boolean, ['CrossChainQuarantine'], 'Quarantined', ATTACKER);
    const tx = await step('sepolia', `[G2 ${tag}] agent on Sepolia pays look-alike ${ATTACKER2} (UnknownPayee)`, vWrite('sepolia', 'proposePayment', [ATTACKER2, ETH, parseEther('0.001'), label('bob')], true), clients('sepolia', agentKey));
    await trace('G2: attacker seen on Sepolia quarantined on Base Sepolia too', 'baseSepolia', 'sepolia', tx, async () => (await vRead('baseSepolia', 'quarantined', [ATTACKER2])) as boolean, ['CrossChainQuarantine'], 'Quarantined', ATTACKER2);
  }
}

console.log(`GuardReactive v2 ${L.guard}: ${formatEther(await lasna.pub.getBalance({ address: L.guard }))} lREACT; cron ${await lasna.pub.readContract({ address: L.guard, abi: rxArt.abi, functionName: 'cronOn' })}`);
