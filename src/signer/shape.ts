/**
 * S5: the signer's own reading of what it is asked to sign. Policy R5 checks
 * balance changes; this checks the transaction's commands, so a request that
 * also moves a non-coin object (an NFT, a capability) or calls arbitrary Move
 * code with no balance effect is refused even if the dry-run looks right.
 *
 * Allowed: SplitCoins / MergeCoins, framework coin and balance calls (0x2::coin,
 * 0x2::balance: what coinWithBalance resolves to), and exactly one
 * TransferObjects of results (never raw inputs or the whole gas coin) to the
 * expected recipient.
 */
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { fromBase64 } from '../core/encoding.ts';

const FRAMEWORK = normalizeSuiAddress('0x2');
const ALLOWED_MODULES = new Set(['coin', 'balance']);

type Data = ReturnType<Transaction['getData']>;

export function checkTransferShape(bytes: Uint8Array, recipient: string): string | null {
  const want = normalizeSuiAddress(recipient);
  if (bytes[0] === 0x7b) {
    // Offline fixture transfers are JSON (SIMULATED backend).
    try {
      const t = JSON.parse(new TextDecoder().decode(bytes)) as { kind?: string; recipient?: string };
      if (t.kind !== 'fixture-transfer') return 'not a transfer';
      return normalizeSuiAddress(t.recipient ?? '') === want ? null : 'transfer goes to a different recipient';
    } catch {
      return 'unreadable transaction';
    }
  }
  let d: Data;
  try {
    d = Transaction.from(bytes).getData();
  } catch {
    return 'unreadable transaction';
  }
  return checkCommands(d, want);
}

export function checkCommands(d: Data, want: string): string | null {
  let transfers = 0;
  for (const c of d.commands) {
    switch (c.$kind) {
      case 'SplitCoins':
      case 'MergeCoins':
        break;
      case 'MoveCall': {
        const m = c.MoveCall!;
        if (normalizeSuiAddress(m.package) !== FRAMEWORK || !ALLOWED_MODULES.has(m.module)) return `calls ${m.package.slice(0, 10)}…::${m.module}::${m.function}, which is not a plain coin operation`;
        break;
      }
      case 'TransferObjects': {
        transfers++;
        const t = c.TransferObjects!;
        if (t.objects.some((o) => o.$kind !== 'Result' && o.$kind !== 'NestedResult')) return 'transfers an object that is not a freshly split coin';
        const a = t.address;
        const input = a.$kind === 'Input' ? d.inputs[a.Input!] : undefined;
        const raw = input?.Pure?.bytes;
        if (!raw) return 'transfer recipient is not a plain address';
        const hex = '0x' + Buffer.from(fromBase64(raw)).toString('hex');
        if (normalizeSuiAddress(hex) !== want) return 'transfer goes to a different recipient';
        break;
      }
      default:
        return `contains a ${c.$kind} command`;
    }
  }
  return transfers === 1 ? null : `has ${transfers} transfers (expected exactly one)`;
}
