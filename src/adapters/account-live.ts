/**
 * Owner-signed MemWalAccount operations on mainnet (setup, revoke, rotate).
 * The owner key is the root of trust and never lives on the demo server: it is
 * read only by these commands, from OWNER_SUI_PRIVATE_KEY, for a throwaway
 * owner used for the hackathon demo (spec §13).
 */
import { addDelegateKey, removeDelegateKey } from '@mysten-incubation/memwal/account';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { AccountAdmin } from './chain.ts';

export interface LiveAdminOptions {
  ownerSecret: string;
  accountId: string;
  packageId: string;
  registryId: string;
  network: 'mainnet' | 'testnet';
  suiClient: unknown;
}

export function liveAccountAdmin(o: LiveAdminOptions): AccountAdmin {
  const owner = Ed25519Keypair.fromSecretKey(o.ownerSecret).toSuiAddress();
  const base = { packageId: o.packageId, registryId: o.registryId, accountId: o.accountId, suiPrivateKey: o.ownerSecret, suiNetwork: o.network, suiClient: o.suiClient };
  return {
    ownerAddress: () => owner,
    async addDelegateKey(publicKeyHex, label) {
      const r = await addDelegateKey({ ...base, publicKey: publicKeyHex, label });
      return { digest: r.digest };
    },
    async removeDelegateKey(publicKeyHex) {
      return removeDelegateKey({ ...base, publicKey: publicKeyHex });
    },
  };
}
