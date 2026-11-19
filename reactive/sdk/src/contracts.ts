import { decodeEventLog, hexToString, keccak256, parseEther, stringToHex, toBytes, type Account, type Address, type Chain, type Hash, type Hex, type PublicClient, type Transport, type WalletClient } from 'viem';
import { GuardMemoryAbi, GuardMemoryBytecode, GuardVaultAbi, GuardVaultBytecode } from './generated.ts';
import { CHAINS, GUARD_REACTIVE, MEMORY_REFUSALS, MEMORY_STATUS, NATIVE, REFUSALS, type MemoryRefusal, type MemoryStatus, type OriginChain, type Refusal } from './constants.ts';

type Wallet = WalletClient<Transport, Chain | undefined, Account>;
type Reader = PublicClient;

/** A label as the contracts store it (bytes32, UTF-8, at most 32 bytes). */
export const label = (s: string): Hex => {
  if (new TextEncoder().encode(s).length > 32) throw new Error('labels are at most 32 bytes');
  return stringToHex(s, { size: 32 });
};
export const unlabel = (h: Hex): string => hexToString(h, { size: 32 }).replace(/\0+$/, '');
/** The hash GuardMemory stores for a memory's content (the text itself stays with you). */
export const contentHash = (content: string | Uint8Array): Hex => keccak256(typeof content === 'string' ? toBytes(content) : content);

interface Clients { publicClient: Reader; walletClient?: Wallet }

function needWallet(w?: Wallet): Wallet {
  if (!w) throw new Error('this call sends a transaction: pass a walletClient');
  return w;
}

// ---- GuardVault ----------------------------------------------------------------------------------

export interface ProposeResult { hash: Hash; paid: boolean; refusal: Refusal }

/** A GuardVault: the agent proposes, the vault pays or refuses; the owner configures. */
export class GuardVault {
  readonly address: Address;
  private pub: Reader;
  private wallet?: Wallet;
  constructor(address: Address, c: Clients) {
    this.address = address;
    this.pub = c.publicClient;
    this.wallet = c.walletClient;
  }

  private read<T>(functionName: string, args: unknown[] = []): Promise<T> {
    return this.pub.readContract({ address: this.address, abi: GuardVaultAbi, functionName: functionName as any, args: args as any }) as Promise<T>;
  }
  private async write(functionName: string, args: unknown[] = []): Promise<Hash> {
    const w = needWallet(this.wallet);
    // simulate first: a call the contract would refuse fails here, with its error name, and costs nothing
    const { request } = await this.pub.simulateContract({ address: this.address, abi: GuardVaultAbi, functionName: functionName as any, args: args as any, account: w.account });
    const hash = await w.writeContract(request as any);
    const r = await this.pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
    return hash;
  }

  // the agent
  /** Ask the vault to pay. Never reverts for a rule: `paid` is false and `refusal` says why. */
  async propose(to: Address, amount: bigint | string, payeeLabel: string, token: Address = NATIVE): Promise<ProposeResult> {
    const hash = await this.write('proposePayment', [to, token, typeof amount === 'string' ? parseEther(amount) : amount, label(payeeLabel)]);
    const r = await this.pub.getTransactionReceipt({ hash });
    for (const log of r.logs) {
      try {
        const e: any = decodeEventLog({ abi: GuardVaultAbi, data: log.data, topics: log.topics });
        if (e.eventName === 'PaymentExecuted') return { hash, paid: true, refusal: 'None' };
        if (e.eventName === 'PaymentRefused') return { hash, paid: false, refusal: REFUSALS[Number(e.args.code)] ?? 'None' };
      } catch { /* not a vault event */ }
    }
    return { hash, paid: false, refusal: 'None' };
  }
  /** A dry run of the rules: what `propose` would answer now. */
  async check(to: Address, amount: bigint | string, payeeLabel: string, token: Address = NATIVE): Promise<Refusal> {
    const code = await this.read<number>('check', [to, token, typeof amount === 'string' ? parseEther(amount) : amount, label(payeeLabel)]);
    return REFUSALS[Number(code)] ?? 'None';
  }

  // reading
  async status() {
    const [owner, agent, guardian, frozen, payeeDelay, proposals, balance] = await Promise.all([
      this.read<Address>('owner'), this.read<Address>('agent'), this.read<Address>('guardian'), this.read<boolean>('frozen'),
      this.read<bigint>('payeeDelay'), this.read<bigint>('proposalCount'), this.pub.getBalance({ address: this.address }),
    ]);
    return { address: this.address, owner, agent, guardian, guarded: guardian.toLowerCase() === GUARD_REACTIVE.toLowerCase(), frozen, payeeDelay, proposals, balance };
  }
  async payee(payeeLabel: string) {
    const [to, cap, pendingTo, pendingCap, effectiveAt] = await this.read<[Address, bigint, Address, bigint, bigint]>('payees', [label(payeeLabel)]);
    return { label: payeeLabel, to, cap, pending: effectiveAt > 0n ? { to: pendingTo, cap: pendingCap, effectiveAt: new Date(Number(effectiveAt) * 1000) } : null };
  }
  isQuarantined(account: Address) { return this.read<boolean>('quarantined', [account]); }
  dailyLimit(token: Address = NATIVE) { return this.read<bigint>('dailyLimit', [token]); }

  // the owner
  /** Register or change a payee: timelocked by the vault's payee delay, then `activatePayee`. */
  requestPayee(payeeLabel: string, to: Address, cap: bigint | string) { return this.write('requestPayee', [label(payeeLabel), to, typeof cap === 'string' ? parseEther(cap) : cap]); }
  /** Anyone may activate a payee whose delay has passed. */
  activatePayee(payeeLabel: string) { return this.write('activatePayee', [label(payeeLabel)]); }
  removePayee(payeeLabel: string) { return this.write('removePayee', [label(payeeLabel)]); }
  setDailyLimit(amount: bigint | string, token: Address = NATIVE) { return this.write('setDailyLimit', [token, typeof amount === 'string' ? parseEther(amount) : amount]); }
  /** Make GuardReactive the guardian (then ask the API to `watch` the vault). */
  setGuardian(guardian: Address = GUARD_REACTIVE) { return this.write('setGuardian', [guardian]); }
  freeze(reason = 'owner') { return this.write('freezeNow', [label(reason)]); }
  unfreeze() { return this.write('unfreeze'); }
  release(account: Address) { return this.write('release', [account]); }
  withdraw(to: Address, amount: bigint | string, token: Address = NATIVE) { return this.write('withdraw', [to, token, typeof amount === 'string' ? parseEther(amount) : amount]); }
}

// ---- GuardMemory ---------------------------------------------------------------------------------

export interface RememberResult { hash: Hash; id: number; refused: MemoryRefusal; contentHash: Hex }
export interface MemoryEntry { id: number; contentHash: Hex; source: Address; kind: string; writtenAt: Date; forgotten: boolean; status: MemoryStatus; usable: boolean }

/** A GuardMemory: the agent's memory with provenance. Ask `usable(id)` before acting on a memory. */
export class GuardMemory {
  readonly address: Address;
  private pub: Reader;
  private wallet?: Wallet;
  constructor(address: Address, c: Clients) {
    this.address = address;
    this.pub = c.publicClient;
    this.wallet = c.walletClient;
  }

  private read<T>(functionName: string, args: unknown[] = []): Promise<T> {
    return this.pub.readContract({ address: this.address, abi: GuardMemoryAbi, functionName: functionName as any, args: args as any }) as Promise<T>;
  }
  private async write(functionName: string, args: unknown[] = []): Promise<Hash> {
    const w = needWallet(this.wallet);
    const { request } = await this.pub.simulateContract({ address: this.address, abi: GuardMemoryAbi, functionName: functionName as any, args: args as any, account: w.account });
    const hash = await w.writeContract(request as any);
    const r = await this.pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
    return hash;
  }

  /**
   * Remember something, with where it came from. The content stays with you; only its hash goes on-chain.
   * Refused (id 0) when memory is frozen or the source is quarantined.
   */
  async remember(content: string | { hash: Hex }, source: Address, kind = 'note', uri = ''): Promise<RememberResult> {
    const h = typeof content === 'string' ? contentHash(content) : content.hash;
    const hash = await this.write('remember', [h, source, label(kind), uri]);
    const r = await this.pub.getTransactionReceipt({ hash });
    for (const log of r.logs) {
      try {
        const e: any = decodeEventLog({ abi: GuardMemoryAbi, data: log.data, topics: log.topics });
        if (e.eventName === 'Remembered') return { hash, id: Number(e.args.id), refused: 'None', contentHash: h };
        if (e.eventName === 'MemoryRefused') return { hash, id: 0, refused: MEMORY_REFUSALS[Number(e.args.reason)] ?? 'None', contentHash: h };
      } catch { /* not a memory event */ }
    }
    return { hash, id: 0, refused: 'None', contentHash: h };
  }

  /** An entry and whether the agent may act on it. */
  async recall(id: number | bigint): Promise<MemoryEntry> {
    const [e, status] = await this.read<[{ contentHash: Hex; source: Address; kind: Hex; at: bigint; forgotten: boolean }, number]>('recall', [BigInt(id)]);
    return { id: Number(id), contentHash: e.contentHash, source: e.source, kind: unlabel(e.kind), writtenAt: new Date(Number(e.at) * 1000), forgotten: e.forgotten, status: MEMORY_STATUS[status] ?? 'usable', usable: status === 0 };
  }
  usable(id: number | bigint) { return this.read<boolean>('usable', [BigInt(id)]); }
  usableMany(ids: (number | bigint)[]) { return this.read<boolean[]>('usableMany', [ids.map((i) => BigInt(i))]); }
  /** Does this content match entry `id` (the agent's copy has not been tampered with)? */
  async matches(id: number | bigint, content: string | Uint8Array) { return (await this.recall(id)).contentHash === contentHash(content); }
  async entryCount() { return Number(await this.read<bigint>('entryCount')); }
  async entriesFrom(source: Address) { return (await this.read<bigint[]>('entriesFrom', [source])).map(Number); }
  isQuarantined(source: Address) { return this.read<boolean>('quarantined', [source]); }
  async status() {
    const [owner, writer, guardian, frozen, entries, balance] = await Promise.all([
      this.read<Address>('owner'), this.read<Address>('writer'), this.read<Address>('guardian'), this.read<boolean>('frozen'), this.entryCount(), this.pub.getBalance({ address: this.address }),
    ]);
    return { address: this.address, owner, writer, guardian, guarded: guardian.toLowerCase() === GUARD_REACTIVE.toLowerCase(), frozen, entries, balance };
  }

  // the owner
  /** A poisoned source found in memory: quarantine it here, and GuardReactive blocks it on every vault. */
  quarantineSource(source: Address, reason = 'poisoned memory') { return this.write('quarantineSource', [source, label(reason)]); }
  release(source: Address) { return this.write('release', [source]); }
  forget(id: number | bigint, reason = 'owner') { return this.write('forget', [BigInt(id), label(reason)]); }
  setGuardian(guardian: Address = GUARD_REACTIVE) { return this.write('setGuardian', [guardian]); }
  setWriter(writer: Address) { return this.write('setWriter', [writer]); }
  freeze(reason = 'owner') { return this.write('freezeNow', [label(reason)]); }
  unfreeze() { return this.write('unfreeze'); }
  withdraw(to: Address, amount: bigint | string) { return this.write('withdraw', [to, typeof amount === 'string' ? parseEther(amount) : amount]); }
}

// ---- deploying -----------------------------------------------------------------------------------

interface DeployBase { chain: OriginChain; publicClient: Reader; walletClient: Wallet; /** ETH sent with the deployment: Reactive's callbacks are paid from it. */ fund?: bigint | string }

async function deploy(o: DeployBase, abi: any, bytecode: Hex, args: unknown[]): Promise<Address> {
  const value = o.fund === undefined ? 0n : typeof o.fund === 'string' ? parseEther(o.fund) : o.fund;
  const hash = await o.walletClient.deployContract({ abi, bytecode, args: args as any, value, account: o.walletClient.account, chain: o.walletClient.chain });
  const r = await o.publicClient.waitForTransactionReceipt({ hash });
  if (!r.contractAddress) throw new Error(`deployment failed: ${hash}`);
  return r.contractAddress;
}

/** Deploy your own GuardVault (you are the owner). Then `setGuardian()` and `GuardApi.watch`. */
export async function deployVault(o: DeployBase & { agent: Address; payeeDelaySeconds?: number }) {
  const address = await deploy(o, GuardVaultAbi, GuardVaultBytecode, [CHAINS[o.chain].callbackProxy, o.agent, BigInt(o.payeeDelaySeconds ?? 60)]);
  return new GuardVault(address, o);
}

/** Deploy your own GuardMemory (you are the owner; `writer` is your agent). Then `setGuardian()` and `GuardApi.watch`. */
export async function deployMemory(o: DeployBase & { writer: Address }) {
  const address = await deploy(o, GuardMemoryAbi, GuardMemoryBytecode, [CHAINS[o.chain].callbackProxy, o.writer]);
  return new GuardMemory(address, o);
}
