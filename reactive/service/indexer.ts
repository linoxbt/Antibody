// The Guard indexer: follows the vaults, the RiskOracle and GuardReactive on three chains, links every
// GuardReactive decision to the origin transaction that caused it and to the callback that carried it
// out, and measures the time between them from block timestamps. Read-only; no keys.
import { decodeEventLog, formatEther, parseAbi, type Abi, type Hex, type Log } from 'viem';
import { NETWORKS, REACTIVE_SYSTEM } from '../networks.ts';
import { abiOf, clients, loadRecord, type NetworkName } from '../scripts/lib.ts';

const RULES = ['None', 'Burst', 'RepeatedRefusals', 'UnknownRecipient', 'CrossChainQuarantine', 'PayeeVeto', 'ScheduledPayment', 'Retry', 'AiRisk'];
const CODES = ['None', 'Frozen', 'Quarantined', 'UnknownPayee', 'LabelMismatch', 'OverCap', 'OverDailyLimit', 'Duplicate', 'TransferFailed'];
const ZERO = '0x0000000000000000000000000000000000000000';
/** The vault event each rule's callback produces, to find the callback transaction. */
const CALLBACK_EVENT: Record<string, string> = { Burst: 'Frozen', RepeatedRefusals: 'Frozen', Retry: '', UnknownRecipient: 'Quarantined', CrossChainQuarantine: 'Quarantined', AiRisk: 'Quarantined', PayeeVeto: 'PayeeChangeVetoed', ScheduledPayment: 'ScheduleAdvanced' };

export interface Event { chain: NetworkName; block: number; ts: number; tx: Hex; logIndex: number; contract: string; name: string; args: Record<string, string> }
export interface Loop {
  rule: string; subject: string | null; destChain: NetworkName; vault?: Hex | null;
  origin: { chain: NetworkName | null; tx: Hex | null; ts: number | null };
  reactive: { tx: Hex; ts: number };
  callback: { tx: Hex | null; ts: number | null };
  seconds: number | null; source: 'live' | 'recorded'; name?: string;
}

/** The current deployment: vault v2 on Base Sepolia and Ethereum Sepolia, GuardReactive v4, the RiskOracle. */
export function deployment() {
  const base = loadRecord('baseSepolia', 'baseSepolia-v2');
  const sep = loadRecord('sepolia', 'sepolia-v2');
  const lasna = loadRecord('lasna', 'lasna-v5');
  return {
    vaults: { baseSepolia: base.vault as Hex, sepolia: sep.vault as Hex } as Record<'baseSepolia' | 'sepolia', Hex>,
    oracle: base.oracle as Hex, guard: lasna.guard as Hex, scorer: base.scorer as Hex, agent: base.agent as Hex, registrar: lasna.registrar as Hex,
    memory: ((): Hex | null => { try { return loadRecord('baseSepolia', 'baseSepolia-memory').memory as Hex; } catch { return null; } })(),
    recordedLoops: ['lasna-v2', 'lasna-v3', 'lasna-v4', 'lasna-v5'].flatMap((f) => (loadRecord('lasna', f).loops ?? []).map((l: any) => ({ ...l, file: f }))),
  };
}

const ABIS: Abi[] = [abiOf('GuardVault'), abiOf('GuardMemory'), abiOf('GuardReactive'), abiOf('RiskOracle')];
function decode(log: Log): { name: string; args: Record<string, string> } | null {
  for (const abi of ABIS) {
    try {
      const e: any = decodeEventLog({ abi, data: log.data, topics: log.topics });
      const args: Record<string, string> = {};
      for (const [k, v] of Object.entries(e.args ?? {})) args[k] = typeof v === 'bigint' ? v.toString() : String(v);
      return { name: String(e.eventName), args };
    } catch { /* try the next ABI */ }
  }
  return null;
}

export class Indexer {
  readonly d = deployment();
  readonly events: Event[] = [];
  readonly loops: Loop[] = [];
  state: any = {};
  private last: Partial<Record<NetworkName, bigint>> = {};
  private blockTs = new Map<string, number>();
  private txTo = new Map<string, string>();
  private pending: Loop[] = [];
  private key = ('0x' + '11'.repeat(32)) as Hex; // read-only clients still need an account object
  private kinds = new Map<string, 'vault' | 'memory'>(); // what each watched target is (it never changes)

  /** A watched target is a GuardVault or a GuardMemory: only a memory answers entryCount(). */
  private async kindOf(net: NetworkName, address: Hex): Promise<'vault' | 'memory'> {
    const k = `${net}:${address.toLowerCase()}`;
    if (!this.kinds.has(k)) {
      const pub = clients(net, this.key).pub;
      const isMemory = await pub.readContract({ address, abi: abiOf('GuardMemory'), functionName: 'entryCount' }).then(() => true, () => false);
      this.kinds.set(k, isMemory ? 'memory' : 'vault');
    }
    return this.kinds.get(k)!;
  }

  /** Every vault GuardReactive watches (read from Lasna), the demo vaults first. */
  watchedVaults: { chain: NetworkName; address: Hex }[] = [];

  private targets(): [NetworkName, Hex[], bigint][] {
    const on = (net: NetworkName) => [...new Set([this.d.vaults[net as 'baseSepolia' | 'sepolia'], ...this.watchedVaults.filter((v) => v.chain === net).map((v) => v.address)].filter(Boolean).map((a) => a.toLowerCase()))] as Hex[];
    // chunk sizes: Base Sepolia allows 200 blocks per getLogs and makes several blocks a second
    return [['baseSepolia', [...on('baseSepolia'), this.d.oracle], 190n], ['sepolia', on('sepolia'), 500n], ['lasna', [this.d.guard], 1000n]];
  }

  /** Index the last `lookbackSeconds` on every chain (block times differ: Base Sepolia makes 5 a second). */
  async start(lookbackSeconds = Number(process.env.LOOKBACK_SECONDS ?? 7200)) {
    for (const [net] of this.targets()) {
      const { pub } = clients(net, this.key);
      const head = await pub.getBlockNumber();
      const [a, b] = await Promise.all([pub.getBlock({ blockNumber: head }), pub.getBlock({ blockNumber: head - 1000n })]);
      const perBlock = Math.max(0.05, Number(a.timestamp - b.timestamp) / 1000);
      this.last[net] = head - BigInt(Math.ceil(lookbackSeconds / perBlock));
      console.log(`index ${net} from block ${this.last[net]} (${lookbackSeconds}s at ${perBlock}s a block)`);
    }
    await this.refreshState();
    void this.loop();
    setInterval(() => void this.refreshState().catch((e) => console.error('state', e.message)), 15_000);
  }

  private async loop() {
    for (;;) {
      for (const [net, addrs, chunk] of this.targets()) {
        try { await this.poll(net, addrs, chunk); } catch (e) { console.error(`poll ${net}`, (e as Error).message.split('\n')[0]); }
      }
      try { await this.link(); } catch (e) { console.error('link', (e as Error).message.split('\n')[0]); }
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  private async ts(net: NetworkName, block: bigint): Promise<number> {
    const k = `${net}:${block}`;
    if (!this.blockTs.has(k)) {
      const b = await clients(net, this.key).pub.getBlock({ blockNumber: block });
      this.blockTs.set(k, Number(b.timestamp));
      if (this.blockTs.size > 5000) this.blockTs.delete(this.blockTs.keys().next().value!);
    }
    return this.blockTs.get(k)!;
  }

  private async poll(net: NetworkName, addresses: Hex[], chunk: bigint) {
    const { pub } = clients(net, this.key);
    // Ethereum Sepolia's public RPC is load-balanced: the node answering getLogs can be a block behind the
    // one that reported the head ("Invalid parameters"), so stay one block back there.
    const head = (await pub.getBlockNumber()) - (net === 'sepolia' ? 1n : 0n);
    for (let rounds = 0; rounds < 60 && this.last[net]! < head; rounds++) {
      const from = this.last[net]! + 1n;
      const to = from + chunk - 1n > head ? head : from + chunk - 1n;
      const logs = await pub.getLogs({ address: addresses, fromBlock: from, toBlock: to });
      for (const log of logs) {
        const d = decode(log);
        if (!d) continue;
        const e: Event = { chain: net, block: Number(log.blockNumber), ts: await this.ts(net, log.blockNumber!), tx: log.transactionHash!, logIndex: log.logIndex!, contract: log.address, ...d };
        this.events.push(e);
        if (net === 'lasna' && d.name === 'Decision') this.onDecision(e);
      }
      this.last[net] = to;
    }
    if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000);
  }

  private onDecision(e: Event) {
    const dest = (Object.entries(NETWORKS).find(([, n]) => String(n.chainId) === e.args.chainId)?.[0] ?? 'baseSepolia') as NetworkName;
    const rule = RULES[Number(e.args.rule)] ?? 'None';
    const originTx = BigInt(e.args.originTx) === 0n ? null : (`0x${BigInt(e.args.originTx).toString(16).padStart(64, '0')}` as Hex);
    const subject = e.args.subject && e.args.subject !== ZERO ? e.args.subject : null;
    const loop: Loop = { rule, subject, destChain: dest, vault: (e.args.vault as Hex) ?? null, origin: { chain: null, tx: originTx, ts: null }, reactive: { tx: e.tx, ts: e.ts }, callback: { tx: null, ts: null }, seconds: null, source: 'live' };
    this.loops.push(loop);
    this.pending.push(loop);
    if (this.loops.length > 200) this.loops.splice(0, this.loops.length - 200);
  }

  /** Fill in each new loop's origin (any chain) and callback (the vault event in a transaction to the proxy). */
  private async link() {
    for (const loop of [...this.pending]) {
      if (loop.origin.tx && loop.origin.ts === null) {
        for (const net of ['baseSepolia', 'sepolia', 'lasna'] as NetworkName[]) {
          try {
            const r = await clients(net, this.key).pub.getTransactionReceipt({ hash: loop.origin.tx! });
            loop.origin = { chain: net, tx: loop.origin.tx, ts: await this.ts(net, r.blockNumber) };
            break;
          } catch { /* not on this chain */ }
        }
      }
      if (!loop.callback.tx) {
        const want = CALLBACK_EVENT[loop.rule];
        for (const e of this.events) {
          if (e.chain !== loop.destChain || e.name !== want || e.ts < loop.reactive.ts - 2) continue;
          if (loop.subject && want === 'Quarantined' && e.args.account?.toLowerCase() !== loop.subject.toLowerCase()) continue;
          if (this.loops.some((l) => l !== loop && l.callback.tx === e.tx && l.destChain === loop.destChain && l.subject === loop.subject)) continue;
          if (!(await this.sentToProxy(e.chain, e.tx))) continue;
          loop.callback = { tx: e.tx, ts: e.ts };
          break;
        }
      }
      if (loop.callback.ts !== null) {
        loop.seconds = loop.origin.ts !== null && loop.rule !== 'ScheduledPayment' ? loop.callback.ts - loop.origin.ts : loop.callback.ts - loop.reactive.ts;
      }
      const stale = Date.now() / 1000 - loop.reactive.ts > 1800;
      if ((loop.callback.tx && (loop.origin.ts !== null || !loop.origin.tx)) || stale) this.pending.splice(this.pending.indexOf(loop), 1);
    }
  }

  private async sentToProxy(net: NetworkName, tx: Hex): Promise<boolean> {
    if (!this.txTo.has(tx)) this.txTo.set(tx, String((await clients(net, this.key).pub.getTransaction({ hash: tx })).to).toLowerCase());
    return this.txTo.get(tx) === NETWORKS[net].callbackProxy.toLowerCase();
  }

  async refreshState() {
    const vaultAbi = abiOf('GuardVault');
    const rxAbi = abiOf('GuardReactive');
    const sys = parseAbi(['function debt(address) view returns (uint256)', 'function reserves(address) view returns (uint256)']);
    const { pub } = clients('lasna', this.key);
    const g = this.d.guard;
    const rr = (fn: string, args: unknown[] = []) => pub.readContract({ address: g, abi: rxAbi, functionName: fn, args });
    const n = Number(await rr('vaultCount'));
    const byId = Object.fromEntries(Object.entries(NETWORKS).map(([k, x]) => [String(x.chainId), k as NetworkName]));
    const listed: { chain: NetworkName; address: Hex }[] = [];
    for (let i = 0; i < n; i++) {
      const t = (await rr('targets', [BigInt(i)])) as [bigint, Hex];
      if (byId[String(t[0])]) listed.push({ chain: byId[String(t[0])]!, address: t[1] });
    }
    this.watchedVaults = listed;
    const demo = new Set([...Object.values(this.d.vaults), this.d.memory].filter(Boolean).map((a) => a!.toLowerCase()));
    const memAbi = abiOf('GuardMemory');
    // one target that cannot be read (an RPC hiccup, an unknown contract) must not hold up the others
    const read = await Promise.all(listed.map(async ({ chain: net, address }) => {
      try {
        const c = clients(net, this.key).pub;
        const kind = demo.has(address.toLowerCase()) ? 'demo' : 'community';
        if ((await this.kindOf(net, address)) === 'memory') {
          const r = (fn: string, args: unknown[] = []) => c.readContract({ address, abi: memAbi, functionName: fn, args });
          const [frozen, guardian, balance, entries, owner, writer] = await Promise.all([r('frozen'), r('guardian'), c.getBalance({ address }), r('entryCount'), r('owner'), r('writer')]);
          return { type: 'memory' as const, chain: net, chainId: NETWORKS[net].chainId, address, kind, owner, writer, frozen, guardian, balance: formatEther(balance), entries: String(entries), explorer: NETWORKS[net].explorer };
        }
        const r = (fn: string, args: unknown[] = []) => c.readContract({ address, abi: vaultAbi, functionName: fn, args });
        const [frozen, guardian, balance, proposals, owner, agent] = await Promise.all([r('frozen'), r('guardian'), c.getBalance({ address }), r('proposalCount'), r('owner'), r('agent')]);
        return { type: 'vault' as const, chain: net, chainId: NETWORKS[net].chainId, address, kind, owner, agent, frozen, guardian, balance: formatEther(balance), proposals: String(proposals), explorer: NETWORKS[net].explorer };
      } catch (e) {
        console.error('state target', net, address, (e as Error).message.split('\n')[0]);
        return null;
      }
    }));
    const vaults = read.filter((x) => x?.type === 'vault').map(({ type, ...v }: any) => v);
    const memories = read.filter((x) => x?.type === 'memory').map(({ type, ...v }: any) => v);
    const [lessons, chains, cron, threshold, balance, debt, reserves] = await Promise.all([
      rr('lessonCount'), rr('vaultCount'), rr('cronOn'), rr('riskThreshold'), pub.getBalance({ address: g }),
      pub.readContract({ address: REACTIVE_SYSTEM, abi: sys, functionName: 'debt', args: [g] }),
      pub.readContract({ address: REACTIVE_SYSTEM, abi: sys, functionName: 'reserves', args: [g] }),
    ]);
    const known: string[] = [];
    for (let i = 0n; i < (lessons as bigint) && i < 50n; i++) known.push(String(await rr('lessons', [i])));
    this.state = {
      updatedAt: new Date().toISOString(),
      vaults,
      memories,
      guard: { address: g, registrar: this.d.registrar, maxVaults: 12, lessons: known, chains: String(chains), cronOn: cron, riskThreshold: Number(threshold), balance: formatEther(balance), reserves: formatEther(reserves as bigint), debt: formatEther(debt as bigint), explorer: NETWORKS.lasna.explorer },
      oracle: { address: this.d.oracle, scorer: this.d.scorer, explorer: NETWORKS.baseSepolia.explorer },
    };
  }

  snapshot() {
    const recorded = this.d.recordedLoops.map((l: any) => ({
      name: l.name, rule: l.rule, subject: l.subject ?? null, destChain: l.callback?.chain, source: 'recorded' as const,
      origin: { chain: l.origin?.chain, tx: l.origin?.tx }, reactive: { tx: l.reactive?.tx }, callback: { tx: l.callback?.tx },
      seconds: l.originToCallbackSeconds ?? l.reactiveToCallbackSeconds ?? null, deployment: l.file,
    }));
    const explain = (e: Event) => (e.name === 'PaymentRefused' ? { ...e, refusal: CODES[Number(e.args.code)] } : e.name === 'Decision' ? { ...e, rule: RULES[Number(e.args.rule)] } : e);
    const seen = new Set(this.loops.map((l) => `${l.reactive.tx}:${l.destChain}`));
    const older = recorded.filter((l: any) => !seen.has(`${l.reactive.tx}:${l.destChain}`));
    const catchingUp = Object.entries(this.last).some(([, b]) => b === undefined);
    return { ...this.state, catchingUp, live: this.loops.slice(-40).reverse(), recorded: older.reverse(), events: this.events.slice(-60).reverse().map(explain), explorers: Object.fromEntries(Object.entries(NETWORKS).map(([k, n]) => [k, n.explorer])) };
  }
}
