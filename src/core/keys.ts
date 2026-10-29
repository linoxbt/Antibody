import { createPublicKey, verify as nodeVerify, type KeyObject } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, isHex } from './encoding.ts';

// @noble/ed25519 v2 needs a synchronous SHA-512 for the sync API.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

/**
 * An Ed25519 lane key. The private seed never leaves this object; callers only
 * get `sign`. The same 32-byte seed is the MemWal delegate key for the lane.
 */
export interface LaneKey {
  readonly publicKeyHex: string;
  sign(message: Uint8Array): Uint8Array;
}

export function laneKeyFromSeedHex(seedHex: string): LaneKey & { readonly seedHex: string } {
  const s = seedHex.trim().toLowerCase().replace(/^0x/, '');
  if (!isHex(s, 32)) throw new Error('lane key must be 32 bytes of hex');
  const seed = hexToBytes(s);
  const pub = bytesToHex(ed.getPublicKey(seed));
  return {
    publicKeyHex: pub,
    seedHex: s,
    sign: (m) => ed.sign(m, seed),
  };
}

export function generateSeedHex(): string {
  return bytesToHex(ed.utils.randomPrivateKey());
}

// SPKI DER prefix for a raw 32-byte Ed25519 public key (RFC 8410).
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const keyCache = new Map<string, KeyObject>();

/**
 * Ed25519 verification with Node's native implementation (≈20× faster than
 * pure JS, so a full rebuild verifies hundreds of envelopes well under the
 * 1 s target). Strict RFC 8032 semantics either way.
 */
export function verifyEd25519(sig: Uint8Array, message: Uint8Array, pubHex: string): boolean {
  try {
    if (sig.length !== 64 || !isHex(pubHex, 32)) return false;
    let key = keyCache.get(pubHex);
    if (!key) {
      key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pubHex, 'hex')]), format: 'der', type: 'spki' });
      if (keyCache.size > 1024) keyCache.clear();
      keyCache.set(pubHex, key);
    }
    return nodeVerify(null, message, key, sig);
  } catch {
    return false;
  }
}

/** Reference (pure JS) verifier, used by tests to cross-check the native path. */
export function verifyEd25519Noble(sig: Uint8Array, message: Uint8Array, pubHex: string): boolean {
  try {
    return sig.length === 64 && isHex(pubHex, 32) && ed.verify(sig, message, hexToBytes(pubHex));
  } catch {
    return false;
  }
}
