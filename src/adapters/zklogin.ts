/**
 * Wallets like Slush often hold zkLogin accounts (sign in with Google and the
 * like). Their signatures can only be checked against the chain (current JWKs
 * and epoch), so signature verification needs a Sui client for them. This one
 * is created lazily and only contacted for zkLogin signatures; plain Ed25519 /
 * secp256k1 / secp256r1 signatures still verify offline.
 */
import { SuiGrpcClient } from '@mysten/sui/grpc';

const DEFAULT_URL = 'https://fullnode.mainnet.sui.io:443';

export type SigClient = SuiGrpcClient;

export function zkLoginClient(url = process.env.ANTIBODY_ZKLOGIN_RPC_URL ?? DEFAULT_URL): () => SigClient {
  let c: SigClient | null = null;
  return () => (c ??= new SuiGrpcClient({ network: 'mainnet', baseUrl: url }));
}
