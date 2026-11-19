// GuardReactive v5: many vaults per chain and a registrar role, so visitors' own vaults can be watched.
// v4 stops watching both vaults and its lREACT is withdrawn; v5 imports v4's lessons, trusts the
// RiskOracle, becomes the guardian of both demo vaults, and gets a registrar key (held by the Guard
// service, which may only add and remove vaults).
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
const L = loadRecord('lasna', 'lasna-v5');
L.loops ??= [];
const vaultNets = ['baseSepolia', 'sepolia'] as const;
type VaultNet = (typeof vaultNets)[number];
const R: Record<VaultNet, any> = { baseSepolia: loadRecord('baseSepolia', 'baseSepolia-v2'), sepolia: loadRecord('sepolia', 'sepolia-v2') };
const save = (net: NetworkName) => (net === 'lasna' ? saveRecord('lasna', L, 'lasna-v5') : saveRecord(net, R[net as VaultNet], `${net}-v2`));
const RULES = ['None', 'Burst', 'RepeatedRefusals', 'UnknownRecipient', 'CrossChainQuarantine', 'PayeeVeto', 'ScheduledPayment', 'Retry', 'AiRisk'];

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

/** Deploy, configure and watch a v2 vault on `net` (agent gas, payees through the timelock, limit). */
async function setUpVault(net: VaultNet) {
  const c = clients(net, key);
  const agent = clients(net, agentKey);
  const rec = R[net];
  if (!rec.vault) {
    const hash = await c.wallet.deployContract({ abi: vaultArt.abi, bytecode: vaultArt.bytecode, args: [NETWORKS[net].callbackProxy, agent.account.address, 60n], value: parseEther(net === 'sepolia' ? '0.0015' : '0.02'), chain: c.chain, account: c.account });
    const r = await c.pub.waitForTransactionReceipt({ hash });
    Object.assign(rec, { vault: r.contractAddress, owner: c.account.address, agent: agent.account.address, payees: PAYEES, version: 2 });
    rec.txs.push({ step: 'deploy GuardVault v2 (payee delay 60 s)', hash, block: Number(r.blockNumber), events: names(r.logs) });
    save(net);
    console.log(`done  deploy GuardVault v2 on ${net} at ${rec.vault}  ${txUrl(net, hash)}`);
  }
  // Ethereum Sepolia gas is a few wei right now, so the Sepolia vault and agent need far less
  const agentGas = parseEther(net === 'sepolia' ? '0.0005' : '0.003');
  if ((await c.pub.getBalance({ address: agent.account.address })) < agentGas / 3n) {
    await step(net, 'fund agent', () => c.wallet.sendTransaction({ to: agent.account.address, value: agentGas, chain: c.chain, account: c.account }));
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
  // one reaction can carry a Decision per chain, so match on the chain, not on the reaction's hash
  const d = [...logs].reverse().find((l) => rules.includes(RULES[Number(l.args.rule)]) && Number(l.args.chainId) === NETWORKS[net].chainId && (!subject || String(l.args.subject).toLowerCase() === subject.toLowerCase()));
  if (!d) throw new Error(`${name}: no Decision on Lasna`);
  let callback: any = null;
  const tip = await dest.pub.getBlockNumber();
  for (let from = startDest; from <= tip && !callback; from += 150n) {
    const batch = await dest.pub.getLogs({ address: R[net].vault, fromBlock: from, toBlock: from + 149n > tip ? tip : from + 149n });
    for (const l of batch) {
      if (used.has(l.transactionHash) || names([l])[0] !== callbackEvent) continue;
      if (subject && callbackEvent === 'Quarantined') {
        const e: any = decodeEventLog({ abi: vaultArt.abi, data: l.data, topics: l.topics });
        if (String(e.args.account).toLowerCase() !== subject.toLowerCase()) continue;
      }
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


const V4 = loadRecord('lasna', 'lasna-v4');
const v4Abi = parseAbi(['function unwatch(uint256)', 'function watched(uint256) view returns (address,bool,bool,uint64,(uint64,uint64),(uint64,uint64))', 'function withdraw(address,uint256)']);
const v4Write = (fn: string, args: unknown[]) => async () => lasna.wallet.writeContract({ address: V4.guard, abi: v4Abi as any, functionName: fn as any, args: args as any, chain: lasna.chain, account: lasna.account, ...(await lasnaFees(lasna.pub)) });
const B = R.baseSepolia;

// 1. retire v4
for (const net of vaultNets) {
  const w = (await lasna.pub.readContract({ address: V4.guard, abi: v4Abi, functionName: 'watched', args: [BigInt(NETWORKS[net].chainId)] })) as unknown as any[];
  if (w[0] !== ETH) {
    const h = await v4Write('unwatch', [BigInt(NETWORKS[net].chainId)])();
    await lasna.pub.waitForTransactionReceipt({ hash: h });
    V4.txs.push({ step: `unwatch ${net} (replaced by v5)`, hash: h, events: ['Unwatched'] });
    saveRecord('lasna', V4, 'lasna-v4');
    console.log(`done  v4 unwatch ${net}  ${txUrl('lasna', h)}`);
  }
}
const v4bal = await lasna.pub.getBalance({ address: V4.guard });
if (v4bal > parseEther('0.05')) {
  const amount = v4bal - parseEther('0.05');
  const h = await v4Write('withdraw', [lasna.account.address, amount])();
  await lasna.pub.waitForTransactionReceipt({ hash: h });
  V4.txs.push({ step: `withdraw ${formatEther(amount)} lREACT to the owner (retired)`, hash: h, events: ['Withdrawn'] });
  V4.retired = 'replaced by GuardReactive v5 (many vaults, registrar); unwatched both vaults';
  saveRecord('lasna', V4, 'lasna-v4');
  console.log(`done  v4 withdraw ${formatEther(amount)} lREACT`);
}

// 2. lREACT: top up from the Base Sepolia faucet if short
if (!L.guard && (await lasna.pub.getBalance({ address: lasna.account.address })) < parseEther('2.5')) {
  const b = clients('baseSepolia', key);
  const before = await lasna.pub.getBalance({ address: lasna.account.address });
  const h = await b.wallet.writeContract({ address: '0x2afaFD298b23b62760711756088F75B7409f5967', abi: parseAbi(['function request(address) payable']), functionName: 'request', args: [b.account.address], value: parseEther('0.03'), chain: b.chain, account: b.account });
  await b.pub.waitForTransactionReceipt({ hash: h });
  B.txs.push({ step: 'faucet: 0.03 ETH for lREACT', hash: h, events: [] });
  save('baseSepolia');
  for (let i = 0; i < 60 && (await lasna.pub.getBalance({ address: lasna.account.address })) <= before; i++) await sleep(5_000);
  console.log(`lREACT now ${formatEther(await lasna.pub.getBalance({ address: lasna.account.address }))}`);
}

// 3. v5
if (!L.guard) {
  const hash = await lasna.wallet.deployContract({ abi: rxArt.abi, bytecode: rxArt.bytecode, value: parseEther('1.2'), chain: lasna.chain, account: lasna.account, ...(await lasnaFees(lasna.pub)) });
  const r = await lasna.pub.waitForTransactionReceipt({ hash });
  Object.assign(L, { guard: r.contractAddress, owner: lasna.account.address, version: 5, replaces: V4.guard });
  L.loops ??= [];
  L.txs.push({ step: 'deploy GuardReactive v5 (funded 1.2 lREACT)', hash, block: Number(r.blockNumber), events: [] });
  save('lasna');
  console.log(`done  deploy GuardReactive v5 at ${L.guard}  ${txUrl('lasna', hash)}`);
}
const registrar = clients('lasna', testnetKey('registrar', true));
L.registrar = registrar.account.address;
save('lasna');
await step('lasna', 'reserves +0.3 lREACT (depositTo)', async () => lasna.wallet.writeContract({ address: '0x8888888888888888888888888888888888888888', abi: parseAbi(['function depositTo(address) payable']), functionName: 'depositTo', args: [L.guard], value: parseEther('0.3'), chain: lasna.chain, account: lasna.account, ...(await lasnaFees(lasna.pub)) }));
await step('lasna', 'callback gas limit for Ethereum Sepolia: 500k', rxWrite('setGasLimit', [BigInt(NETWORKS.sepolia.chainId), 500_000n]));
await step('lasna', 'import the lessons learned by v4', rxWrite('importLessons', [V4.guard, 0n, 25n]));
await step('lasna', 'trust the RiskOracle on Base Sepolia', rxWrite('trustOracle', [BigInt(NETWORKS.baseSepolia.chainId), B.oracle]));
await step('lasna', 'set the registrar (the Guard service: add and remove vaults only)', rxWrite('setRegistrar', [registrar.account.address]));
await step('lasna', 'fund the registrar with 0.4 lREACT for watch transactions', async () => lasna.wallet.sendTransaction({ to: registrar.account.address, value: parseEther('0.4'), chain: lasna.chain, account: lasna.account, ...(await lasnaFees(lasna.pub)) }));

// 4. v5 guards both demo vaults
for (const net of vaultNets) await step(net, 'set GuardReactive v5 as guardian', vWrite(net, 'setGuardian', [L.guard]));
await step('lasna', 'watch the Base Sepolia vault', rxWrite('watch', [BigInt(NETWORKS.baseSepolia.chainId), B.vault]));
await step('lasna', 'watch the Ethereum Sepolia vault', rxWrite('watch', [BigInt(NETWORKS.sepolia.chainId), R.sepolia.vault]));
console.log(`GuardReactive v5 ${L.guard}: ${formatEther(await lasna.pub.getBalance({ address: L.guard }))} lREACT; ${await lasna.pub.readContract({ address: L.guard, abi: rxArt.abi, functionName: 'lessonCount' })} lessons; ${await lasna.pub.readContract({ address: L.guard, abi: rxArt.abi, functionName: 'vaultCount' })} vaults; registrar ${registrar.account.address}`);
