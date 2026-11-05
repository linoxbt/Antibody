/**
 * Live chain reader on the Sui TypeScript SDK core API, pointed at Tatum.
 * gRPC (default) and JSON-RPC share every call except the checkpoint read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import { ChannelCredentials } from '@grpc/grpc-js';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { GrpcTransport } from '@protobuf-ts/grpc-transport';
import { RateLimitRetry } from './rate-limit.ts';
import { JsonRpcHTTPTransport, SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { coinWithBalance, Transaction } from '@mysten/sui/transactions';
import { normalizeCoinType, normalizeSuiAddress, SUI_COIN_TYPE } from '../core/encoding.ts';
import type { AccountState } from '../core/lanes.ts';
import type { SimulationResult } from '../core/policy.ts';
import { parseAccountJson, type ChainReader, type CoinMeta, type OwnedObject, type TransferRequest, type TxInfo } from './chain.ts';

type AnyClient = SuiGrpcClient | SuiJsonRpcClient;

export interface SdkChainOptions {
  transport: 'grpc' | 'jsonrpc';
  /**
   * gRPC wire format. native (default): gRPC over HTTP/2, what Tatum's gateway
   * and Sui fullnodes serve. web: gRPC-Web over fetch, for endpoints that only
   * speak that (Tatum answers gRPC-Web requests with native gRPC and fails).
   */
  grpcWire?: 'native' | 'web';
  network: 'mainnet' | 'testnet';
  url: string;
  apiKey: string | null;
  packageId: string;
}

/** Deadline for one chain call; without it a hung RPC held locks for minutes (undici's default is ~300 s). */
export const CHAIN_CALL_TIMEOUT_MS = 30_000;

/**
 * Native gRPC transport. Trusts the system roots plus NODE_EXTRA_CA_CERTS (a
 * corporate or sandbox proxy's CA); grpc-js goes through https_proxy itself.
 */
function nativeTransport(url: string, meta: Record<string, string>, timeoutMs: number | null): RateLimitRetry {
  const u = new URL(url);
  if (u.pathname !== '/' && u.pathname !== '') throw new Error(`gRPC URL ${url} has a path; native gRPC needs host[:port] only`);
  const host = `${u.hostname}:${u.port || (u.protocol === 'http:' ? '80' : '443')}`;
  const extraFile = process.env.NODE_EXTRA_CA_CERTS;
  const extra = extraFile && existsSync(extraFile) ? readFileSync(extraFile, 'utf8') : '';
  const channelCredentials = u.protocol === 'http:' ? ChannelCredentials.createInsecure() : ChannelCredentials.createSsl(Buffer.from([...rootCertificates, extra].join('\n')));
  return new RateLimitRetry(new GrpcTransport({ host, channelCredentials, meta, ...(timeoutMs ? { timeout: timeoutMs } : {}) }));
}

export function createSuiClient(o: Pick<SdkChainOptions, 'transport' | 'network' | 'url' | 'apiKey' | 'grpcWire'>, timeoutMs: number | null = CHAIN_CALL_TIMEOUT_MS): AnyClient {
  // Tatum takes the key as x-api-key (gRPC metadata or an HTTP header).
  const headers: Record<string, string> = o.apiKey ? { 'x-api-key': o.apiKey } : {};
  if (o.transport === 'grpc') {
    if ((o.grpcWire ?? 'native') === 'native') return new SuiGrpcClient({ network: o.network, transport: nativeTransport(o.url, headers, timeoutMs) });
    return new SuiGrpcClient({ network: o.network, baseUrl: o.url, meta: headers, ...(timeoutMs ? { timeout: timeoutMs } : {}) });
  }
  const timed: typeof fetch = (input, init) => fetch(input, { ...init, ...(timeoutMs ? { signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) } : {}) });
  return new SuiJsonRpcClient({ network: o.network, transport: new JsonRpcHTTPTransport({ url: o.url, rpc: { headers }, fetch: timed }) });
}

export class SdkChainReader implements ChainReader {
  readonly kind: 'tatum-grpc' | 'tatum-jsonrpc';
  readonly simulated = false;
  readonly client: AnyClient;
  private streamClient: AnyClient | null = null;

  constructor(private readonly o: SdkChainOptions) {
    this.kind = o.transport === 'grpc' ? 'tatum-grpc' : 'tatum-jsonrpc';
    this.client = createSuiClient(o);
  }

  async latestCheckpoint(): Promise<number> {
    if (this.client instanceof SuiGrpcClient) {
      const { response } = await this.client.ledgerService.getServiceInfo({});
      if (response.checkpointHeight === undefined) throw new Error('service info has no checkpoint height');
      return Number(response.checkpointHeight);
    }
    return Number(await this.client.getLatestCheckpointSequenceNumber());
  }

  async getAccount(accountId: string): Promise<AccountState> {
    const { object } = await this.client.core.getObject({ objectId: accountId, include: { json: true } });
    const want = `${normalizeSuiAddress(this.o.packageId)}::account::MemWalAccount`;
    if (normalizeTypeAddress(object.type) !== want) throw new Error(`${accountId} is a ${object.type}, not ${want}`);
    if (!object.json) throw new Error('account object has no JSON content');
    return parseAccountJson(accountId, object.json as Record<string, unknown>);
  }

  async listBalances(owner: string) {
    const out: { coinType: string; balance: string }[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<AnyClient['core']['listBalances']>> = await this.client.core.listBalances({ owner, cursor });
      for (const b of page.balances) out.push({ coinType: normalizeCoinType(b.coinType), balance: b.balance });
      cursor = page.hasNextPage ? page.cursor : null;
    } while (cursor);
    return out;
  }

  async listOwnedObjects(owner: string): Promise<OwnedObject[]> {
    const out: OwnedObject[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<AnyClient['core']['listOwnedObjects']>> = await this.client.core.listOwnedObjects({
        owner,
        cursor,
        include: { json: true, previousTransaction: true },
      });
      for (const o of page.objects) {
        out.push({
          objectId: o.objectId,
          version: o.version,
          type: o.type,
          previousTransaction: (o.previousTransaction as string | null | undefined) ?? null,
          json: ((o as { json?: Record<string, unknown> | null }).json ?? null) as Record<string, unknown> | null,
        });
      }
      cursor = page.hasNextPage ? page.cursor : null;
    } while (cursor && out.length < 2000);
    return out;
  }

  async getCoinMetadata(coinType: string): Promise<CoinMeta | null> {
    const { coinMetadata } = await this.client.core.getCoinMetadata({ coinType });
    return coinMetadata;
  }

  async getTransaction(digest: string): Promise<TxInfo | null> {
    try {
      const r = await this.client.core.getTransaction({ digest, include: { balanceChanges: true, transaction: true, effects: true } });
      return toTxInfo(r);
    } catch (e) {
      if (/not ?found/i.test(String((e as Error).message))) return null;
      throw e;
    }
  }

  async buildTransfer(req: TransferRequest): Promise<Uint8Array> {
    const tx = new Transaction();
    tx.setSender(req.sender);
    if (normalizeCoinType(req.coinType) === SUI_COIN_TYPE) {
      const [c] = tx.splitCoins(tx.gas, [req.amount]);
      tx.transferObjects([c!], req.recipient);
    } else {
      tx.transferObjects([coinWithBalance({ type: req.coinType, balance: req.amount })], req.recipient);
    }
    return tx.build({ client: this.client });
  }

  /** FR-18: checkpoints affecting the wallet, streamed over gRPC. Undefined on JSON-RPC. */
  get watchCheckpoints(): ChainReader['watchCheckpoints'] {
    if (this.o.transport !== 'grpc') return undefined;
    return async (address, onCheckpoint, signal) => {
      // A long-lived stream: its own client, with no per-call deadline.
      const client = (this.streamClient ??= createSuiClient(this.o, null)) as SuiGrpcClient;
      const call = client.subscriptionService.subscribeCheckpoints(
        {
          readMask: { paths: ['sequence_number'] },
          filter: { terms: [{ literals: [{ negated: false, predicate: { oneofKind: 'affectedAddress', affectedAddress: { address: normalizeSuiAddress(address) } } }] }] },
        },
        { abort: signal },
      );
      // With a filter the server sends a cursor-only heartbeat every few
      // checkpoints and a checkpoint body only when one touches the address.
      for await (const r of call.responses) {
        const seq = r.checkpoint?.sequenceNumber;
        if (seq !== undefined) onCheckpoint(Number(seq));
      }
    };
  }

  /**
   * Unsigned owner transaction: {package}::account::remove_delegate_key. The
   * console hands these bytes to the owner's browser wallet to sign (FR-16).
   */
  async buildRemoveDelegateKey(req: { sender: string; accountId: string; packageId: string; registryId: string; publicKeyHex: string }): Promise<Uint8Array> {
    const tx = new Transaction();
    tx.setSender(req.sender);
    tx.moveCall({
      target: `${req.packageId}::account::remove_delegate_key`,
      arguments: [tx.object(req.accountId), tx.object(req.registryId), tx.pure.vector('u8', Array.from(Buffer.from(req.publicKeyHex, 'hex')))],
    });
    return tx.build({ client: this.client });
  }

  /** Unsigned owner transaction: {package}::account::create_account(registry, clock). One account per owner address. */
  async buildCreateAccount(req: { sender: string; packageId: string; registryId: string }): Promise<Uint8Array> {
    const tx = new Transaction();
    tx.setSender(req.sender);
    tx.moveCall({ target: `${req.packageId}::account::create_account`, arguments: [tx.object(req.registryId), tx.object('0x6')] });
    return tx.build({ client: this.client });
  }

  /** The MemWalAccount a create_account transaction created, if any. */
  async createdAccountOf(digest: string): Promise<string | null> {
    const r = await this.client.core.getTransaction({ digest, include: { effects: true, objectTypes: true } });
    const t = (r.Transaction ?? r.FailedTransaction) as { effects?: { changedObjects?: { objectId: string; idOperation?: string }[] }; objectTypes?: Record<string, string> } | undefined;
    for (const c of t?.effects?.changedObjects ?? []) {
      if (c.idOperation === 'Created' && t?.objectTypes?.[c.objectId]?.includes('::account::MemWalAccount')) return normalizeSuiAddress(c.objectId);
    }
    return null;
  }

  async simulate(txBytes: Uint8Array): Promise<SimulationResult> {
    const sender = Transaction.from(txBytes).getData().sender ?? '';
    try {
      const r = await this.client.core.simulateTransaction({ transaction: txBytes, include: { balanceChanges: true, effects: true } });
      const t = (r.$kind === 'Transaction' ? r.Transaction : (r as unknown as { FailedTransaction: typeof r.Transaction }).FailedTransaction)!;
      const g = t.effects!.gasUsed;
      const gas = BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate);
      return {
        ok: t.status.success,
        ...(t.status.success ? {} : { error: JSON.stringify(t.status.error) }),
        sender: normalizeSuiAddress(sender),
        balanceChanges: (t.balanceChanges ?? []).map((b) => ({ address: normalizeSuiAddress(b.address), coinType: b.coinType, amount: b.amount })),
        gasUsed: gas.toString(),
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message, sender, balanceChanges: [], gasUsed: '0' };
    }
  }

  async execute(txBytes: Uint8Array, signature: string): Promise<TxInfo> {
    const r = await this.client.core.executeTransaction({ transaction: txBytes, signatures: [signature], include: { balanceChanges: true, transaction: true, effects: true } });
    const info = toTxInfo(r);
    try {
      const done = await this.client.core.waitForTransaction({ digest: info.digest, include: { balanceChanges: true, transaction: true } });
      return toTxInfo(done);
    } catch {
      return info;
    }
  }
}

function normalizeTypeAddress(t: string): string {
  const [addr, ...rest] = t.split('::');
  return [normalizeSuiAddress(addr!), ...rest].join('::');
}

function toTxInfo(r: { $kind: string; Transaction?: unknown; FailedTransaction?: unknown }): TxInfo {
  const t = (r.Transaction ?? r.FailedTransaction) as {
    digest: string;
    checkpoint: string | null;
    timestampMs: number | null;
    status: { success: boolean; error: unknown };
    balanceChanges?: { address: string; coinType: string; amount: string }[];
    transaction?: { sender?: string };
  };
  return {
    digest: t.digest,
    ok: t.status.success,
    ...(t.status.success ? {} : { error: JSON.stringify(t.status.error) }),
    sender: t.transaction?.sender ? normalizeSuiAddress(t.transaction.sender) : '',
    checkpoint: t.checkpoint === null ? null : Number(t.checkpoint),
    timestampMs: t.timestampMs,
    balanceChanges: (t.balanceChanges ?? []).map((b) => ({ address: normalizeSuiAddress(b.address), coinType: normalizeCoinType(b.coinType), amount: b.amount })),
  };
}
