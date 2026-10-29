/**
 * Offline fixture chain (prints SIMULATED). A small, deterministic model of
 * the Sui state Antibody reads: one MemWalAccount, balances, owned objects,
 * coin metadata, transactions and a checkpoint counter. Transactions are JSON
 * bytes signed with the same Ed25519 transaction-signing scheme as Sui, and
 * are verified with the SDK's verifyTransactionSignature, so signer and x402
 * facilitator code paths are the same as live.
 */
import { join } from 'node:path';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import { normalizeCoinType, normalizeSuiAddress, sha256Hex, SUI_COIN_TYPE, utf8, fromUtf8 } from '../core/encoding.ts';
import type { AccountState } from '../core/lanes.ts';
import type { SimulationResult } from '../core/policy.ts';
import type { AccountAdmin, ChainReader, CoinMeta, OwnedObject, TransferRequest, TxInfo } from './chain.ts';
import { JsonFileStore } from './filestore.ts';

export const FIXTURE_GAS_MIST = 1_000_000n;

interface FixtureState {
  checkpoint: number;
  account: (Omit<AccountState, 'delegateKeys'> & { delegateKeys: AccountState['delegateKeys'] }) | null;
  balances: Record<string, Record<string, string>>;
  objects: Record<string, OwnedObject & { owner: string }>;
  coinMetadata: Record<string, CoinMeta>;
  txs: Record<string, TxInfo>;
  seq: number;
}

interface FixtureTransfer {
  kind: 'fixture-transfer';
  sender: string;
  recipient: string;
  coinType: string;
  amount: string;
  nonce: number;
}

const empty = (): FixtureState => ({ checkpoint: 1000, account: null, balances: {}, objects: {}, coinMetadata: {}, txs: {}, seq: 0 });

export class FixtureChain implements ChainReader {
  readonly kind = 'fixture' as const;
  readonly simulated = true;
  private readonly store: JsonFileStore<FixtureState>;

  constructor(dir: string) {
    this.store = new JsonFileStore(join(dir, 'chain.json'), empty);
  }

  // ---- reads -------------------------------------------------------------

  async latestCheckpoint(): Promise<number> {
    return this.store.read().checkpoint;
  }

  async getAccount(accountId: string): Promise<AccountState> {
    const a = this.store.read().account;
    if (!a || a.accountId !== accountId) throw new Error(`fixture: no MemWalAccount ${accountId}`);
    return structuredClone(a);
  }

  isDelegate(pubHex: string): boolean {
    return this.store.read().account?.delegateKeys.some((k) => k.publicKeyHex === pubHex) ?? false;
  }

  async listBalances(owner: string) {
    const b = this.store.read().balances[normalizeSuiAddress(owner)] ?? {};
    return Object.entries(b)
      .filter(([, v]) => BigInt(v) > 0n)
      .map(([coinType, balance]) => ({ coinType, balance }));
  }

  async listOwnedObjects(owner: string): Promise<OwnedObject[]> {
    const o = normalizeSuiAddress(owner);
    return Object.values(this.store.read().objects)
      .filter((x) => x.owner === o)
      .map(({ owner: _o, ...rest }) => rest);
  }

  async getCoinMetadata(coinType: string): Promise<CoinMeta | null> {
    return this.store.read().coinMetadata[normalizeCoinType(coinType)] ?? null;
  }

  async getTransaction(digest: string): Promise<TxInfo | null> {
    return this.store.read().txs[digest] ?? null;
  }

  // ---- transactions ------------------------------------------------------

  async buildTransfer(req: TransferRequest): Promise<Uint8Array> {
    const nonce = this.store.update((s) => ++s.seq);
    const t: FixtureTransfer = {
      kind: 'fixture-transfer',
      sender: normalizeSuiAddress(req.sender),
      recipient: normalizeSuiAddress(req.recipient),
      coinType: normalizeCoinType(req.coinType),
      amount: req.amount.toString(),
      nonce,
    };
    return utf8(JSON.stringify(t));
  }

  private decode(bytes: Uint8Array): FixtureTransfer {
    const t = JSON.parse(fromUtf8(bytes)) as FixtureTransfer;
    if (t.kind !== 'fixture-transfer') throw new Error('not a fixture transfer');
    return t;
  }

  private effects(s: FixtureState, t: FixtureTransfer): SimulationResult {
    const amount = BigInt(t.amount);
    const bal = (a: string, c: string) => BigInt(s.balances[a]?.[c] ?? '0');
    const need = t.coinType === SUI_COIN_TYPE ? amount + FIXTURE_GAS_MIST : amount;
    if (bal(t.sender, t.coinType) < need || bal(t.sender, SUI_COIN_TYPE) < FIXTURE_GAS_MIST) {
      return { ok: false, error: 'InsufficientCoinBalance', sender: t.sender, balanceChanges: [], gasUsed: '0' };
    }
    const changes = new Map<string, bigint>();
    const add = (a: string, c: string, v: bigint) => changes.set(`${a}|${c}`, (changes.get(`${a}|${c}`) ?? 0n) + v);
    add(t.recipient, t.coinType, amount);
    add(t.sender, t.coinType, -amount);
    add(t.sender, SUI_COIN_TYPE, -FIXTURE_GAS_MIST);
    return {
      ok: true,
      sender: t.sender,
      balanceChanges: [...changes]
        .filter(([, v]) => v !== 0n)
        .map(([k, v]) => {
          const [address, coinType] = k.split('|') as [string, string];
          return { address, coinType, amount: v.toString() };
        }),
      gasUsed: FIXTURE_GAS_MIST.toString(),
    };
  }

  async simulate(txBytes: Uint8Array): Promise<SimulationResult> {
    let t: FixtureTransfer;
    try {
      t = this.decode(txBytes);
    } catch (e) {
      return { ok: false, error: (e as Error).message, sender: '', balanceChanges: [], gasUsed: '0' };
    }
    const s = this.store.read();
    const digest = txDigest(txBytes);
    if (s.txs[digest]) return { ok: false, error: 'transaction already executed', sender: t.sender, balanceChanges: [], gasUsed: '0' };
    return this.effects(s, t);
  }

  async execute(txBytes: Uint8Array, signature: string): Promise<TxInfo> {
    const t = this.decode(txBytes);
    await verifyTransactionSignature(txBytes, signature, { address: t.sender });
    const digest = txDigest(txBytes);
    return this.store.update((s) => {
      if (s.txs[digest]) throw new Error('transaction already executed');
      const fx = this.effects(s, t);
      s.checkpoint++;
      const info: TxInfo = {
        digest,
        ok: fx.ok,
        ...(fx.error ? { error: fx.error } : {}),
        sender: t.sender,
        checkpoint: s.checkpoint,
        timestampMs: null,
        balanceChanges: fx.balanceChanges,
      };
      if (fx.ok) for (const c of fx.balanceChanges) credit(s, c.address, c.coinType, BigInt(c.amount));
      s.txs[digest] = info;
      return info;
    });
  }

  // ---- fixture setup (dev commands and tests; never used by live code) ----

  createAccount(accountId: string, owner: string): void {
    this.store.update((s) => {
      s.account = { accountId, owner: normalizeSuiAddress(owner), active: true, adminQuarantined: false, delegateKeys: [] };
    });
  }

  admin(owner: string): AccountAdmin {
    const self = this;
    return {
      ownerAddress: () => normalizeSuiAddress(owner),
      async addDelegateKey(publicKeyHex, label) {
        return self.store.update((s) => {
          if (!s.account) throw new Error('fixture: no account');
          if (s.account.owner !== normalizeSuiAddress(owner)) throw new Error('ENotOwner (4)');
          if (s.account.delegateKeys.length >= 20) throw new Error('ETooManyDelegateKeys (2)');
          s.checkpoint++;
          s.account.delegateKeys.push({ publicKeyHex, label, suiAddress: '0x' + sha256Hex(publicKeyHex), createdAtMs: s.checkpoint });
          return { digest: recordTx(s, normalizeSuiAddress(owner), `add_delegate_key ${publicKeyHex}`) };
        });
      },
      async removeDelegateKey(publicKeyHex) {
        return self.store.update((s) => {
          if (!s.account) throw new Error('fixture: no account');
          if (s.account.owner !== normalizeSuiAddress(owner)) throw new Error('ENotOwner (4)');
          const before = s.account.delegateKeys.length;
          s.account.delegateKeys = s.account.delegateKeys.filter((k) => k.publicKeyHex !== publicKeyHex);
          if (s.account.delegateKeys.length === before) throw new Error('EDelegateKeyNotFound (1)');
          s.checkpoint++;
          return { digest: recordTx(s, normalizeSuiAddress(owner), `remove_delegate_key ${publicKeyHex}`) };
        });
      },
    };
  }

  fund(address: string, coinType: string, amount: bigint, meta?: CoinMeta): void {
    this.store.update((s) => {
      const ct = normalizeCoinType(coinType);
      if (meta) s.coinMetadata[ct] = meta;
      credit(s, normalizeSuiAddress(address), ct, amount);
      s.checkpoint++;
    });
  }

  /**
   * Simulate another wallet sending a coin of a new type (with its own
   * metadata) to `to`. Returns the coin object id and the transfer digest.
   */
  airdropCoin(from: string, to: string, coinType: string, amount: bigint, meta: CoinMeta): { objectId: string; digest: string } {
    return this.store.update((s) => {
      const ct = normalizeCoinType(coinType);
      s.coinMetadata[ct] = meta;
      const sender = normalizeSuiAddress(from);
      const owner = normalizeSuiAddress(to);
      const digest = recordTx(s, sender, `airdrop ${ct} ${amount}`, [{ address: owner, coinType: ct, amount: amount.toString() }]);
      credit(s, owner, ct, amount);
      const objectId = '0x' + sha256Hex(`object:${digest}`);
      s.objects[objectId] = { objectId, version: String(s.checkpoint), type: `0x2::coin::Coin<${ct}>`, previousTransaction: digest, json: { balance: amount.toString() }, owner };
      return { objectId, digest };
    });
  }

  /** Simulate another wallet sending a non-coin object (an NFT, a message object) to `to`. */
  airdropObject(from: string, to: string, type: string, json: Record<string, unknown>): { objectId: string; digest: string } {
    return this.store.update((s) => {
      const sender = normalizeSuiAddress(from);
      const owner = normalizeSuiAddress(to);
      const digest = recordTx(s, sender, `object ${type} ${JSON.stringify(json).slice(0, 64)}`);
      const objectId = '0x' + sha256Hex(`object:${digest}`);
      s.objects[objectId] = { objectId, version: String(s.checkpoint), type, previousTransaction: digest, json, owner };
      return { objectId, digest };
    });
  }

  tick(n = 1): void {
    this.store.update((s) => {
      s.checkpoint += n;
    });
  }
}

function credit(s: FixtureState, address: string, coinType: string, v: bigint): void {
  const b = (s.balances[address] ??= {});
  b[coinType] = (BigInt(b[coinType] ?? '0') + v).toString();
}

function recordTx(s: FixtureState, sender: string, what: string, balanceChanges: TxInfo['balanceChanges'] = []): string {
  s.seq++;
  s.checkpoint++;
  const digest = base58ish(sha256Hex(`${s.seq}:${what}`));
  s.txs[digest] = { digest, ok: true, sender, checkpoint: s.checkpoint, timestampMs: null, balanceChanges };
  return digest;
}

function txDigest(bytes: Uint8Array): string {
  return base58ish(sha256Hex(bytes));
}

/** Sui-looking 44-char digests (base58 alphabet) for the fixture. */
function base58ish(hex: string): string {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + hex);
  let out = '';
  while (n > 0n) {
    out = A[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out.padStart(44, '1');
}
