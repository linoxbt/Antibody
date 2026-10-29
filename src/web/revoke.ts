/**
 * Revoke a lane from the console with the owner's browser wallet (FR-16).
 *
 * Revocation is an owner act on-chain, so the console never holds the owner
 * key: it prepares exactly one remove_delegate_key call, the owner's wallet
 * signs it, and control writes lane.revoke only after it re-reads the account
 * and sees the key gone (recordRevoke). A client can't fake a revocation.
 *
 *   live     the wallet signs the transaction bytes (sui:signTransaction);
 *            control checks they are the call it prepared, submits them
 *            through Tatum, then verifies on-chain.
 *   offline  the fixture chain runs no Move code, so the wallet signs a
 *            one-time authorization message instead (sui:signPersonalMessage)
 *            and the fixture applies it as the owner. Labelled SIMULATED.
 *
 * Rotation needs a fresh key file on the role's own machine, so it stays on
 * the command line (`antibody rotate --lane …`).
 */
import { randomBytes } from 'node:crypto';
import { Transaction } from '@mysten/sui/transactions';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { LANE_LABEL, LANES, type Lane } from '../core/types.ts';
import { SdkChainReader } from '../adapters/chain-sdk.ts';
import { primaryOf } from '../adapters/chain-crosscheck.ts';
import type { Control } from '../control/control.ts';
import type { Runtime } from '../runtime.ts';
import { AuthError, isZkLogin } from './auth.ts';
import { zkLoginClient } from '../adapters/zklogin.ts';

const zk = zkLoginClient();

const TTL = 5 * 60_000;

export type Prepared =
  | { id: string; mode: 'transaction'; lane: Lane; pub: string; owner: string; txBytes: string; chain: string; simulated: false; expiresAt: number }
  | { id: string; mode: 'message'; lane: Lane; pub: string; owner: string; message: string; simulated: true; expiresAt: number };

/** The parts of a transaction a wallet must not change: sender and what it calls. Gas may be re-resolved. */
export function callOf(bytes: Uint8Array) {
  const d = Transaction.from(bytes).getData();
  return JSON.stringify({ sender: d.sender && normalizeSuiAddress(d.sender), commands: d.commands, inputs: d.inputs.map((i) => i.Pure ?? i.UnresolvedPure ?? (i.Object ? { object: i.Object.ImmOrOwnedObject?.objectId ?? i.Object.SharedObject?.objectId ?? i.Object.Receiving?.objectId } : i)) });
}

export class RevokeFlow {
  private pending = new Map<string, Prepared>();
  private rt: Runtime;
  private control: Control;
  private now: () => number;

  constructor(rt: Runtime, control: Control, now: () => number = Date.now) {
    this.rt = rt;
    this.control = control;
    this.now = now;
  }

  async prepare(laneIn: string): Promise<Prepared> {
    const lane = laneIn as Lane;
    if (!LANES.includes(lane)) throw new AuthError(400, `lane must be one of ${LANES.join(', ')}`);
    if (lane === 'antibody') throw new AuthError(400, 'revoking the control lane needs rotate-first by the owner; not supported in this build');
    const account = await this.rt.chain.getAccount(this.control.d.acct);
    const key = account.delegateKeys.find((k) => k.label === LANE_LABEL[lane]);
    if (!key) throw new AuthError(409, `no active ${LANE_LABEL[lane]} key on-chain`);
    const owner = normalizeSuiAddress(account.owner);
    const id = randomBytes(16).toString('hex');
    const expiresAt = this.now() + TTL;
    let p: Prepared;
    if (this.rt.fixture) {
      const message = [
        'Antibody · revoke a lane key (offline backend, SIMULATED)',
        `Account: ${account.accountId}`,
        `Lane: ${LANE_LABEL[lane]}`,
        `Key: ${key.publicKeyHex}`,
        `Nonce: ${id}`,
        `Expiration Time: ${new Date(expiresAt).toISOString()}`,
      ].join('\n');
      p = { id, mode: 'message', lane, pub: key.publicKeyHex, owner, message, simulated: true, expiresAt };
    } else if (primaryOf(this.rt.chain) instanceof SdkChainReader) {
      const bytes = await (primaryOf(this.rt.chain) as SdkChainReader).buildRemoveDelegateKey({ sender: owner, accountId: account.accountId, packageId: this.rt.cfg.packageId, registryId: this.rt.cfg.registryId, publicKeyHex: key.publicKeyHex });
      p = { id, mode: 'transaction', lane, pub: key.publicKeyHex, owner, txBytes: Buffer.from(bytes).toString('base64'), chain: `sui:${this.rt.cfg.network}`, simulated: false, expiresAt };
    } else {
      throw new AuthError(501, 'this chain reader cannot build owner transactions');
    }
    this.pending.set(id, p);
    for (const [k, v] of this.pending) if (v.expiresAt < this.now()) this.pending.delete(k);
    return p;
  }

  /** Execute the owner's signature, then record lane.revoke once the chain shows the key gone. */
  async submit(id: string, signed: { signature: string; bytes?: string }): Promise<{ seq: number; digest: string; lane: Lane; pub: string; simulated: boolean }> {
    const p = this.pending.get(id);
    this.pending.delete(id); // single use
    if (!p || p.expiresAt < this.now()) throw new AuthError(410, 'revocation request expired; start again');
    let digest: string;
    if (p.mode === 'message') {
      try {
        await verifyPersonalMessageSignature(new TextEncoder().encode(p.message), signed.signature, { address: p.owner, ...(isZkLogin(signed.signature) ? { client: zk() } : {}) });
      } catch {
        throw new AuthError(403, 'the signature is not the account owner’s');
      }
      digest = (await this.rt.fixture!.admin(p.owner).removeDelegateKey(p.pub)).digest;
    } else {
      const prepared = Buffer.from(p.txBytes, 'base64');
      const bytes = signed.bytes ? Buffer.from(signed.bytes, 'base64') : prepared;
      if (!bytes.equals(prepared) && callOf(bytes) !== callOf(prepared)) throw new AuthError(400, 'the wallet changed the transaction; refusing to submit it');
      const tx = await this.rt.chain.execute(bytes, signed.signature);
      if (!tx.ok) throw new AuthError(502, `remove_delegate_key failed on-chain: ${tx.error ?? 'unknown error'}`);
      digest = tx.digest;
    }
    const rec = await this.control.recordRevoke(p.pub, p.lane, digest);
    return { seq: rec.seq, digest, lane: p.lane, pub: p.pub, simulated: p.simulated };
  }
}
