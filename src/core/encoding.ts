import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import canonicalizeImpl from 'canonicalize';

export { bytesToHex, hexToBytes };

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

/** Strict UTF-8 decode: invalid sequences throw instead of becoming U+FFFD. */
export function fromUtf8(b: Uint8Array): string {
  return dec.decode(b);
}

export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256(typeof data === 'string' ? utf8(data) : data));
}

export function sha256Bytes(data: Uint8Array | string): Uint8Array {
  return sha256(typeof data === 'string' ? utf8(data) : data);
}

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export function toBase64Url(b: Uint8Array): string {
  return Buffer.from(b).toString('base64url');
}

/** Decode base64url without padding; rejects any other alphabet or padding. */
export function fromBase64Url(s: string): Uint8Array {
  if (!B64URL_RE.test(s)) throw new Error('not base64url');
  const out = new Uint8Array(Buffer.from(s, 'base64url'));
  // Reject non-canonical encodings (trailing bits set) so one value has one text.
  if (toBase64Url(out) !== s) throw new Error('non-canonical base64url');
  return out;
}

export function toBase64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}

export function fromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

/** RFC 8785 JSON Canonicalization Scheme. */
export function canonicalJson(value: unknown): string {
  const out = (canonicalizeImpl as unknown as (v: unknown) => string | undefined)(value);
  if (out === undefined) throw new Error('value cannot be canonicalised');
  return out;
}

export function isHex(s: string, bytes?: number): boolean {
  if (!/^[0-9a-f]*$/.test(s) || s.length % 2 !== 0) return false;
  return bytes === undefined || s.length === bytes * 2;
}

/**
 * UUIDv7 (RFC 9562): 48-bit unix ms timestamp, version, random. Time and
 * randomness are injectable so tests stay deterministic.
 */
export function uuidv7(nowMs: number, rand: Uint8Array = randomBytes(10)): string {
  const b = new Uint8Array(16);
  let t = BigInt(Math.floor(nowMs));
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  b.set(rand.subarray(0, 10), 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Canonical Sui address: 0x + 64 lowercase hex. */
export const SUI_ADDRESS_RE = /^0x[0-9a-f]{64}$/;

export function isCanonicalSuiAddress(s: string): boolean {
  return SUI_ADDRESS_RE.test(s);
}

/** Pad a short or mixed-case 0x address to canonical form. Never resolves names. */
export function normalizeSuiAddress(s: string): string {
  const t = s.trim().toLowerCase();
  if (!/^0x[0-9a-f]{1,64}$/.test(t)) throw new Error(`not a Sui address: ${s}`);
  return '0x' + t.slice(2).padStart(64, '0');
}

/** Normalise `0x2::sui::SUI` style coin types so equal types compare equal. */
export function normalizeCoinType(s: string): string {
  const t = s.trim();
  const m = /^(0x[0-9a-fA-F]{1,64})::([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)(<.*>)?$/.exec(t);
  if (!m) throw new Error(`not a coin type: ${s}`);
  return `${normalizeSuiAddress(m[1]!)}::${m[2]}::${m[3]}${m[4] ?? ''}`;
}

export function isCoinType(s: string): boolean {
  try {
    normalizeCoinType(s);
    return true;
  } catch {
    return false;
  }
}

export const SUI_COIN_TYPE = normalizeCoinType('0x2::sui::SUI');
