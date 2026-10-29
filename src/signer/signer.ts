/**
 * Signer (spec §3): the only process holding the Steward wallet key. It
 * accepts requests only from control (enforced by IPC lane auth), and signs
 * only a transaction whose own fresh dry-run moves exactly the expected
 * amount to the expected recipient (defence in depth behind policy R5).
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromBase64, normalizeCoinType, normalizeSuiAddress } from '../core/encoding.ts';
import { checkSimulation } from '../core/policy.ts';
import type { ChainReader, TxInfo } from '../adapters/chain.ts';
import type { Logger } from '../log.ts';

export interface SignRequest {
  mode: 'execute' | 'sign';
  txB64: string;
  expect: { recipient: string; coinType: string; amount: string };
}

export class Signer {
  readonly address: string;

  constructor(
    private readonly keypair: Ed25519Keypair,
    private readonly chain: ChainReader,
    private readonly log: Logger,
    private readonly maxGasMist: string,
  ) {
    this.address = normalizeSuiAddress(keypair.toSuiAddress());
  }

  static fromSecret(secret: string, chain: ChainReader, log: Logger, maxGasMist: string): Signer {
    return new Signer(Ed25519Keypair.fromSecretKey(secret), chain, log, maxGasMist);
  }

  async sign(req: SignRequest): Promise<{ signature: string; digest?: string; tx?: TxInfo }> {
    if (req.mode !== 'execute' && req.mode !== 'sign') throw new Error('mode must be execute or sign');
    const bytes = fromBase64(req.txB64);
    const recipient = normalizeSuiAddress(req.expect.recipient);
    const coinType = normalizeCoinType(req.expect.coinType);
    if (!/^[1-9][0-9]*$/.test(req.expect.amount)) throw new Error('expected amount must be a positive integer');
    const sim = await this.chain.simulate(bytes);
    const mismatch = checkSimulation({ ok: true, ckpt: 0, sender: this.address, simulation: sim, maxGas: this.maxGasMist }, recipient, coinType, BigInt(req.expect.amount));
    if (mismatch) {
      this.log.warn('signer.refused', { reason: mismatch, recipient });
      throw new Error(`signer refused: ${mismatch}`);
    }
    const { signature } = await this.keypair.signTransaction(bytes);
    if (req.mode === 'sign') {
      this.log.info('signer.signed', { recipient, amount: req.expect.amount, coinType });
      return { signature };
    }
    const tx = await this.chain.execute(bytes, signature);
    this.log.info('signer.executed', { digest: tx.digest, ok: tx.ok, recipient, amount: req.expect.amount, coinType });
    return { signature, digest: tx.digest, tx };
  }
}
