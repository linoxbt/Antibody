/**
 * The chain layer is an interface (spec §11) so a JSON-RPC deprecation or
 * outage doesn't block the build. Implementations:
 *   - SdkChainReader over Tatum gRPC (default: Sui deprecated public JSON-RPC
 *     on 2026-04-22 and Tatum is moving Sui to gRPC)
 *   - SdkChainReader over Tatum JSON-RPC (while Tatum still serves it)
 *   - FixtureChain (offline, prints SIMULATED)
 */
import type { AccountState } from '../core/lanes.ts';
import type { SimulationResult } from '../core/policy.ts';
import { bytesToHex, fromBase64, isHex } from '../core/encoding.ts';

export interface OwnedObject {
  objectId: string;
  version: string;
  type: string;
  previousTransaction: string | null;
  json: Record<string, unknown> | null;
}

export interface CoinMeta {
  id: string | null;
  decimals: number;
  name: string;
  symbol: string;
  description: string;
  iconUrl: string | null;
}

export interface TxInfo {
  digest: string;
  ok: boolean;
  error?: string;
  sender: string;
  checkpoint: number | null;
  timestampMs: number | null;
  balanceChanges: { address: string; coinType: string; amount: string }[];
}

export interface TransferRequest {
  sender: string;
  recipient: string;
  coinType: string;
  amount: bigint;
}

export interface ChainReader {
  readonly kind: 'tatum-grpc' | 'tatum-jsonrpc' | 'fixture';
  readonly simulated: boolean;
  latestCheckpoint(): Promise<number>;
  getAccount(accountId: string): Promise<AccountState>;
  listBalances(owner: string): Promise<{ coinType: string; balance: string }[]>;
  listOwnedObjects(owner: string): Promise<OwnedObject[]>;
  getCoinMetadata(coinType: string): Promise<CoinMeta | null>;
  getTransaction(digest: string): Promise<TxInfo | null>;
  /** Unsigned transaction bytes for a plain transfer. */
  buildTransfer(req: TransferRequest): Promise<Uint8Array>;
  /** Dry-run (sui_dryRunTransactionBlock / SimulateTransaction). */
  simulate(txBytes: Uint8Array): Promise<SimulationResult>;
  execute(txBytes: Uint8Array, signature: string): Promise<TxInfo>;
}

/** Owner-signed account operations (setup, revoke, rotate). */
export interface AccountAdmin {
  addDelegateKey(publicKeyHex: string, label: string): Promise<{ digest: string }>;
  removeDelegateKey(publicKeyHex: string): Promise<{ digest: string }>;
  ownerAddress(): string;
}

/** Delegate public keys arrive as base64 (gRPC JSON), hex, or byte arrays (JSON-RPC). */
export function decodePublicKey(v: unknown): string {
  if (Array.isArray(v)) return bytesToHex(Uint8Array.from(v as number[]));
  if (typeof v === 'string') {
    const s = v.replace(/^0x/, '').toLowerCase();
    if (isHex(s, 32)) return s;
    const b = fromBase64(v);
    if (b.length === 32) return bytesToHex(b);
  }
  throw new Error(`unrecognised delegate public key encoding: ${JSON.stringify(v).slice(0, 80)}`);
}

/** Parse a MemWalAccount's JSON content (field names as on-chain). */
export function parseAccountJson(accountId: string, json: Record<string, unknown>): AccountState {
  const keys = (json.delegate_keys as Record<string, unknown>[] | undefined) ?? [];
  return {
    accountId,
    owner: String(json.owner),
    active: json.active === true,
    adminQuarantined: json.admin_quarantined === true,
    delegateKeys: keys.map((k) => {
      // JSON-RPC nests struct fields under `fields`.
      const f = (k.fields as Record<string, unknown> | undefined) ?? k;
      return {
        publicKeyHex: decodePublicKey(f.public_key),
        label: String(f.label),
        suiAddress: String(f.sui_address),
        createdAtMs: Number(f.created_at ?? 0),
      };
    }),
  };
}
