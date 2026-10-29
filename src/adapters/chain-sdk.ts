/**
 * Live chain reader on the Sui TypeScript SDK core API, pointed at Tatum.
 * gRPC (default) and JSON-RPC share every call except the checkpoint read.
 */
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { JsonRpcHTTPTransport, SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { coinWithBalance, Transaction } from '@mysten/sui/transactions';
import { normalizeCoinType, normalizeSuiAddress, SUI_COIN_TYPE } from '../core/encoding.ts';
import type { AccountState } from '../core/lanes.ts';
import type { SimulationResult } from '../core/policy.ts';
import { parseAccountJson, type ChainReader, type CoinMeta, type OwnedObject, type TransferRequest, type TxInfo } from './chain.ts';

type AnyClient = SuiGrpcClient | SuiJsonRpcClient;

export interface SdkChainOptions {
  transport: 'grpc' | 'jsonrpc';
  network: 'mainnet' | 'testnet';
  url: string;
  apiKey: string | null;
  packageId: string;
  gasBudget?: bigint;
}

export function createSuiClient(o: Pick<SdkChainOptions, 'transport' | 'network' | 'url' | 'apiKey'>): AnyClient {
  const headers: Record<string, string> = o.apiKey ? { 'x-api-key': o.apiKey } : {};
  if (o.transport === 'grpc') {
    // gRPC-web over fetch; Tatum takes the key as x-api-key metadata.
    return new SuiGrpcClient({ network: o.network, baseUrl: o.url, meta: headers });
  }
  return new SuiJsonRpcClient({ network: o.network, transport: new JsonRpcHTTPTransport({ url: o.url, rpc: { headers } }) });
}

export class SdkChainReader implements ChainReader {
  readonly kind: 'tatum-grpc' | 'tatum-jsonrpc';
  readonly simulated = false;
  readonly client: AnyClient;

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
    if (this.o.gasBudget) tx.setGasBudget(this.o.gasBudget);
    return tx.build({ client: this.client });
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
