/**
 * Console sign-in. The owner wallet is Antibody's root of trust, so the web
 * console admits whoever proves control of it: the browser wallet signs a
 * one-time challenge (Sui personal message) and the signature must recover
 * the account owner's address. A second door, the operator link, is a random
 * token the control process writes to its run directory (0600) for whoever
 * already has a shell on this machine.
 *
 * Sessions live in memory (a control restart signs everyone out) and travel
 * in an HttpOnly, SameSite=Strict cookie. Nothing here can move funds or
 * write the ledger beyond what the console already could; it only decides
 * who may use the console at all.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';

export type AuthMethod = 'wallet' | 'operator';
export interface Session {
  id: string;
  method: AuthMethod;
  address: string | null;
  createdAt: number;
  expiresAt: number;
}

export const SESSION_COOKIE = 'ab_session';
const CHALLENGE_TTL = 5 * 60_000;
const SESSION_TTL = 12 * 60 * 60_000;
const FAIL_WINDOW = 60_000;
const FAIL_LIMIT = 10;

export class AuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest();

export class Auth {
  private sessions = new Map<string, Session>();
  private challenges = new Map<string, { address: string; expiresAt: number }>();
  private failures: number[] = [];
  readonly operatorToken: string;
  /** The address allowed to sign in with a wallet: the MemWal account owner. */
  private owner: () => Promise<string>;
  private opts: { operatorToken?: string; now?: () => number };

  constructor(owner: () => Promise<string>, opts: { operatorToken?: string; now?: () => number } = {}) {
    this.owner = owner;
    this.opts = opts;
    this.operatorToken = opts.operatorToken ?? randomBytes(24).toString('base64url');
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private throttle() {
    const t = this.now();
    this.failures = this.failures.filter((f) => t - f < FAIL_WINDOW);
    if (this.failures.length >= FAIL_LIMIT) throw new AuthError(429, 'too many failed sign-in attempts; wait a minute');
  }

  private fail(status: number, message: string): never {
    this.failures.push(this.now());
    throw new AuthError(status, message);
  }

  /** A SIWE-style message for the wallet to sign; single use, five minutes. */
  challenge(addressIn: string, origin: string): { message: string; expiresAt: number } {
    this.throttle();
    if (typeof addressIn !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(addressIn) || !isValidSuiAddress(normalizeSuiAddress(addressIn))) throw new AuthError(400, 'not a Sui address');
    const address = normalizeSuiAddress(addressIn);
    const nonce = randomBytes(16).toString('hex');
    const issued = this.now();
    const expiresAt = issued + CHALLENGE_TTL;
    const host = (() => {
      try {
        return new URL(origin).host;
      } catch {
        return 'antibody';
      }
    })();
    const message = [
      `${host} wants you to sign in to the Antibody console with your Sui account:`,
      address,
      '',
      'Only the owner of this Antibody account can sign in. Signing costs nothing and moves no funds.',
      '',
      `URI: ${origin}`,
      `Nonce: ${nonce}`,
      `Issued At: ${new Date(issued).toISOString()}`,
      `Expiration Time: ${new Date(expiresAt).toISOString()}`,
    ].join('\n');
    this.challenges.set(message, { address, expiresAt });
    for (const [m, c] of this.challenges) if (c.expiresAt < issued) this.challenges.delete(m);
    return { message, expiresAt };
  }

  /** Verify a signed challenge; the signer must be the account owner. */
  async signInWithWallet(addressIn: string, message: string, signature: string): Promise<Session> {
    this.throttle();
    const c = this.challenges.get(message);
    this.challenges.delete(message); // single use, even on failure
    if (!c || c.expiresAt < this.now()) this.fail(401, 'challenge expired or unknown; try again');
    const address = normalizeSuiAddress(addressIn);
    if (address !== c.address) this.fail(401, 'challenge was issued to a different address');
    try {
      await verifyPersonalMessageSignature(new TextEncoder().encode(message), signature, { address });
    } catch {
      this.fail(401, 'signature does not verify for this address');
    }
    const owner = normalizeSuiAddress(await this.owner());
    if (address !== owner) this.fail(403, `this wallet is not the account owner (${owner.slice(0, 8)}…${owner.slice(-4)})`);
    return this.open('wallet', address);
  }

  signInWithOperatorToken(token: string): Session {
    this.throttle();
    const ok = typeof token === 'string' && token.length > 0 && timingSafeEqual(sha(token), sha(this.operatorToken));
    if (!ok) this.fail(401, 'operator link is invalid or from an earlier run');
    return this.open('operator', null);
  }

  private open(method: AuthMethod, address: string | null): Session {
    const t = this.now();
    const s: Session = { id: randomBytes(32).toString('base64url'), method, address, createdAt: t, expiresAt: t + SESSION_TTL };
    this.sessions.set(s.id, s);
    return s;
  }

  /** The session named by a Cookie header, if live. */
  fromCookie(header: string | undefined): Session | null {
    const id = parseCookies(header)[SESSION_COOKIE];
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.expiresAt < this.now()) {
      this.sessions.delete(id);
      return null;
    }
    return s;
  }

  end(id: string) {
    this.sessions.delete(id);
  }

  static setCookie(s: Session): string {
    return `${SESSION_COOKIE}=${s.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor((s.expiresAt - s.createdAt) / 1000)}`;
  }

  static clearCookie(): string {
    return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
