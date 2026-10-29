/**
 * Envelope verification (spec §5, invariants I-1 and I-2). The first failing
 * step ends verification and the reason is kept for the forensic view.
 */
import { EnvelopeError, parseEnvelope, type ParsedEnvelope } from './envelope.ts';
import { verifyEd25519 } from './keys.ts';
import type { LaneBindings } from './lanes.ts';
import { signingMessage } from './envelope.ts';
import { LANE_KINDS, NS_LEDGER, type Envelope } from './types.ts';

export interface VerifyContext {
  acct: string;
  /** Namespace the text was recalled from. */
  ns: string;
  bindings: LaneBindings;
}

export type VerifyCode =
  | 'MALFORMED'
  | 'BODY_MISMATCH'
  | 'WRONG_ACCOUNT'
  | 'WRONG_NAMESPACE'
  | 'KIND_NOT_ALLOWED'
  | 'UNKNOWN_SIGNER'
  | 'LANE_MISMATCH'
  | 'BAD_SIGNATURE'
  | 'SIGNER_REVOKED'
  | 'SIGNER_REMOVED';

export type VerifyResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; code: VerifyCode; reason: string; /** Header when it parsed, for forensics. */ parsed?: ParsedEnvelope };

export function verifyEnvelope(text: string, ctx: VerifyContext): VerifyResult {
  let p: ParsedEnvelope;
  try {
    p = parseEnvelope(text);
  } catch (e) {
    const code = e instanceof EnvelopeError ? (e.code as VerifyCode) : 'MALFORMED';
    return { ok: false, code, reason: (e as Error).message };
  }
  const h = p.header;
  const fail = (code: VerifyCode, reason: string): VerifyResult => ({ ok: false, code, reason, parsed: p });

  // Step 3: configuration and recall namespace.
  if (h.acct !== ctx.acct) return fail('WRONG_ACCOUNT', `acct ${h.acct} is not the configured account`);
  if (h.ns !== ctx.ns) return fail('WRONG_NAMESPACE', `declared ns ${h.ns} but recalled from ${ctx.ns}`);
  if (!LANE_KINDS[h.lane].includes(h.kind)) return fail('KIND_NOT_ALLOWED', `lane ${h.lane} may not sign kind ${h.kind}`);
  if ((h.kind === 'ledger') !== (h.ns === NS_LEDGER)) {
    return fail('KIND_NOT_ALLOWED', `kind ${h.kind} is not allowed in namespace ${h.ns}`);
  }

  // Step 4: the key must be bound, and its bound lane must be the declared lane.
  const binding = ctx.bindings.get(h.pub);
  if (!binding) return fail('UNKNOWN_SIGNER', 'signer is not an Antibody lane key on this account');
  if (binding.lane !== h.lane) return fail('LANE_MISMATCH', `key is bound to lane ${binding.lane}, envelope declares ${h.lane}`);

  // Step 5: signature.
  if (!verifyEd25519(p.sig, signingMessage(h), h.pub)) return fail('BAD_SIGNATURE', 'Ed25519 signature does not verify');

  // Step 6: authorised at ckpt.
  if (binding.status === 'removed-unrecorded') {
    return fail('SIGNER_REMOVED', 'key was removed on-chain without a lane.revoke record');
  }
  if (binding.maxCkpt !== null && h.ckpt > binding.maxCkpt) {
    return fail('SIGNER_REVOKED', `signed at checkpoint ${h.ckpt}, after revocation at ${binding.maxCkpt}`);
  }
  return { ok: true, envelope: { header: h, body: p.body, text } };
}
