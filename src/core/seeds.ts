import { isCoinType, normalizeCoinType, normalizeSuiAddress } from './encoding.ts';
import type { EnvelopeHeader, QuarantineSeed, SrcRef } from './types.ts';

/** Normalise identifiers so `0xABC` and `0x0…abc` name the same source. */
export function normalizeIdentifier(v: string): string {
  const t = v.trim();
  if (/^0x[0-9a-fA-F]{1,64}$/.test(t)) return normalizeSuiAddress(t);
  if (isCoinType(t)) return normalizeCoinType(t);
  return t;
}

/** Every identifier an origin ref carries; a `source` seed matches any of them. */
export function srcIdentifiers(ref: SrcRef): string[] {
  const out: string[] = [];
  for (const v of [ref.id, ref.addr, ref.digest, ref.type]) {
    if (typeof v === 'string' && v.length > 0) {
      try {
        out.push(normalizeIdentifier(v));
      } catch {
        out.push(v);
      }
    }
  }
  return out;
}

export function seedKey(s: QuarantineSeed): string {
  return s.type === 'signer-window' ? `${s.type}:${s.value}:${s.from ?? 0}-${s.to ?? 'inf'}` : `${s.type}:${s.value}`;
}

export function normalizeSeed(s: QuarantineSeed): QuarantineSeed {
  switch (s.type) {
    case 'source':
      return { type: 'source', value: normalizeIdentifier(s.value) };
    case 'signer-window':
      return { type: 'signer-window', value: s.value.toLowerCase(), from: s.from ?? 0, ...(s.to !== undefined ? { to: s.to } : {}) };
    default:
      return { type: s.type, value: s.value };
  }
}

/** Does this seed match the memory itself (not counting its ancestors)? */
export function seedMatches(seed: QuarantineSeed, h: EnvelopeHeader): boolean {
  switch (seed.type) {
    case 'memory':
      return h.id === seed.value;
    case 'source':
      // S2: a source seed names something outside (an object, coin type, sender, tx, URL).
      // A human's own message id is not a source; quarantine it with a memory seed.
      return h.src.some((r) => r.t !== 'user-msg' && srcIdentifiers(r).includes(seed.value));
    case 'signer-window':
      return h.pub === seed.value && h.ckpt >= (seed.from ?? 0) && (seed.to === undefined || h.ckpt <= seed.to);
    case 'turn':
      return h.turn !== null && h.turn === seed.value;
  }
}
