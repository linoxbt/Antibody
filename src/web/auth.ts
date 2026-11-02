/**
 * Console sign-in. The owner wallet is Antibody's root of trust, so the web
 * console admits whoever proves control of it: the browser wallet signs a
 * one-time challenge (Sui personal message) and the signature must recover
 * the account owner's address. A second door, the operator link, is a random
 * token the control process writes to its run directory (0600) for whoever
 * already has a shell on this machine.
 *
 * Sessions live in memory (a control restart signs everyone out) unless a
 * session file is given (the hosted sandbox, so a redeploy keeps visitors
 * signed in); the file stores only SHA-256 hashes of session ids, never the
 * ids themselves. Sessions travel in an HttpOnly, SameSite=Strict cookie. Nothing here can move funds or
 * write the ledger beyond what the console already could; it only decides
 * who may use the console at all.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';
import { parseSerializedSignature } from '@mysten/sui/cryptography';
import type { SigClient } from '../adapters/zklogin.ts';

/** Whether a serialized signature uses the zkLogin scheme. */
export function isZkLogin(signature: string): boolean {
  try {
    return parseSerializedSignature(signature).signatureScheme === 'ZkLogin';
  } catch {
    return false;
  }
}

export type AuthMethod = 'wallet' | 'operator';
export interface Session {
  id: string;
  method: AuthMethod;
  address: string | null;
  createdAt: number;
  expiresAt: number;
  /**
   * S11: a second secret the page keeps in localStorage (scoped to this exact
   * origin, port included) and sends as x-antibody-session. A cookie alone is
   * sent to every port on 127.0.0.1, so on the local console it is not enough.
   */
  csrf: string;
}

export const SESSION_COOKIE = 'ab_session';
const CHALLENGE_TTL = 5 * 60_000;
const SESSION_TTL = 12 * 60 * 60_000;
const FAIL_WINDOW = 60_000;
const FAIL_LIMIT = 10;
/** S8: bounded state for unauthenticated callers. */
const MAX_CHALLENGES = 10_000;
const MAX_CHALLENGES_PER_ADDRESS = 5;
const MAX_SESSIONS_PER_ADDRESS = 5;
const ZKLOGIN_PER_MINUTE = 30;

export class AuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest();

export interface AuthOptions {
  operatorToken?: string;
  now?: () => number;
  statement?: string;
  client?: () => SigClient;
  /** Persist sessions here (hashed ids, 0600) so a restart keeps people signed in. */
  sessionFile?: string;
  /** Count failed sign-ins per client and lock out after FAIL_LIMIT (default true; the sandbox turns it off: signatures can't be guessed, and IP buckets there only enabled lockouts). */
  throttleFailures?: boolean;
  /** Cookie name (the hosted sandbox uses __Host-ab_session). */
  cookieName?: string;
  /** S11: require x-antibody-session alongside the cookie (the local console). */
  requireSessionHeader?: boolean;
}

const idHash = (id: string) => createHash('sha256').update(id).digest('base64url');

export class Auth {
  private sessions = new Map<string, Session>();
  private challenges = new Map<string, { address: string; expiresAt: number }>();
  /** Recent failures per client (an IP on the hosted sandbox, one bucket locally). */
  private failures = new Map<string, number[]>();
  readonly operatorToken: string;
  /**
   * The address allowed to sign in with a wallet: the MemWal account owner.
   * null on the hosted sandbox, where any wallet may sign in to its own world.
   */
  private owner: (() => Promise<string>) | null;
  private opts: AuthOptions;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(owner: (() => Promise<string>) | null, opts: AuthOptions = {}) {
    this.owner = owner;
    this.opts = opts;
    this.operatorToken = opts.operatorToken ?? randomBytes(24).toString('base64url');
    if (opts.sessionFile && existsSync(opts.sessionFile)) {
      try {
        const saved = JSON.parse(readFileSync(opts.sessionFile, 'utf8')) as Record<string, Omit<Session, 'id'>>;
        for (const [h, v] of Object.entries(saved)) if (v.expiresAt > this.now()) this.sessions.set(h, { ...v, csrf: v.csrf ?? '', id: '' });
      } catch {
        /* a damaged file just signs everyone out */
      }
    }
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private throttle(client: string) {
    this.sweep();
    if (this.opts.throttleFailures === false) return;
    const t = this.now();
    const recent = (this.failures.get(client) ?? []).filter((f) => t - f < FAIL_WINDOW);
    this.failures.set(client, recent);
    if (this.failures.size > 10_000) for (const [k, v] of this.failures) if (!v.length) this.failures.delete(k);
    if (recent.length >= FAIL_LIMIT) throw new AuthError(429, 'too many failed sign-in attempts; wait a minute');
  }

  private fail(status: number, message: string, client: string): never {
    if (this.opts.throttleFailures !== false) this.failures.set(client, [...(this.failures.get(client) ?? []), this.now()]);
    throw new AuthError(status, message);
  }

  private lastSweep = 0;
  /** Outstanding challenge messages per address (S8: no full scan to count them). */
  private byAddress = new Map<string, string[]>();
  private zkTimes: number[] = [];

  /** S8: expire challenges, failures and sessions in bulk, at most every few seconds (never a full scan per request). */
  private sweep(force = false) {
    const t = this.now();
    if (!force && t - this.lastSweep < 5_000) return;
    this.lastSweep = t;
    // Insertion order is issue order and every challenge lives CHALLENGE_TTL: expired ones are at the front.
    for (const [m, c] of this.challenges) {
      if (c.expiresAt >= t) break;
      this.challenges.delete(m);
    }
    for (const [a, list] of this.byAddress) {
      const live = list.filter((m) => this.challenges.has(m));
      if (live.length) this.byAddress.set(a, live);
      else this.byAddress.delete(a);
    }
    for (const [k, v] of this.failures) if (!v.some((f) => t - f < FAIL_WINDOW)) this.failures.delete(k);
    let removed = false;
    for (const [h, sess] of this.sessions) if (sess.expiresAt < t) (this.sessions.delete(h), (removed = true));
    if (removed) this.save();
  }

  /** A SIWE-style message for the wallet to sign; single use, five minutes. */
  challenge(addressIn: string, origin: string, client = 'local'): { message: string; expiresAt: number } {
    this.throttle(client);
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
      this.opts.statement ?? 'Only the owner of this Antibody account can sign in. Signing costs nothing and moves no funds.',
      '',
      `URI: ${origin}`,
      `Nonce: ${nonce}`,
      `Issued At: ${new Date(issued).toISOString()}`,
      `Expiration Time: ${new Date(expiresAt).toISOString()}`,
    ].join('\n');
    // S8: at most a few outstanding challenges per address (oldest dropped), and a global cap.
    const mine = (this.byAddress.get(address) ?? []).filter((m) => this.challenges.has(m));
    if (mine.length >= MAX_CHALLENGES_PER_ADDRESS) this.challenges.delete(mine.shift()!);
    if (this.challenges.size >= MAX_CHALLENGES) {
      this.sweep(true);
      if (this.challenges.size >= MAX_CHALLENGES) throw new AuthError(503, 'too many sign-ins in progress; try again in a minute');
    }
    this.challenges.set(message, { address, expiresAt });
    mine.push(message);
    this.byAddress.set(address, mine);
    return { message, expiresAt };
  }

  /** Verify a signed challenge; the signer must be the account owner. */
  async signInWithWallet(addressIn: string, message: string, signature: string, client = 'local'): Promise<Session> {
    return this.open('wallet', await this.verifyWallet(addressIn, message, signature, client));
  }

  /**
   * Check a signed challenge and return the verified address, without opening a
   * session (the sandbox creates the visitor's world first, so a refused world
   * never leaves a session behind).
   */
  async verifyWallet(addressIn: string, message: string, signature: string, client = 'local'): Promise<string> {
    this.throttle(client);
    const c = this.challenges.get(message);
    this.challenges.delete(message); // single use, even on failure
    if (!c || c.expiresAt < this.now()) this.fail(401, 'challenge expired or unknown; try again', client);
    const address = normalizeSuiAddress(addressIn);
    if (address !== c.address) this.fail(401, 'challenge was issued to a different address', client);
    if (isZkLogin(signature)) {
      // S8: each zkLogin check is an outbound RPC call: rate-limited on its own.
      const t = this.now();
      this.zkTimes = this.zkTimes.filter((x) => t - x < 60_000);
      if (this.zkTimes.length >= ZKLOGIN_PER_MINUTE) throw new AuthError(503, 'zkLogin sign-in is busy; try again in a minute');
      this.zkTimes.push(t);
    }
    try {
      // zkLogin signatures (e.g. Slush accounts made with Google) are checked against the chain.
      await verifyPersonalMessageSignature(new TextEncoder().encode(message), signature, { address, ...(this.opts.client && isZkLogin(signature) ? { client: this.opts.client() } : {}) });
    } catch {
      this.fail(401, 'signature does not verify for this address', client);
    }
    if (this.owner) {
      const owner = normalizeSuiAddress(await this.owner());
      if (address !== owner) this.fail(403, `this wallet is not the account owner (${owner.slice(0, 8)}…${owner.slice(-4)})`, client);
    }
    return address;
  }

  /** A session for an address already verified with verifyWallet. */
  openWallet(address: string): Session {
    return this.open('wallet', address);
  }

  signInWithOperatorToken(token: string, client = 'local'): Session {
    this.throttle(client);
    const ok = typeof token === 'string' && token.length > 0 && timingSafeEqual(sha(token), sha(this.operatorToken));
    if (!ok) this.fail(401, 'operator link is invalid or from an earlier run', client);
    return this.open('operator', null);
  }

  private open(method: AuthMethod, address: string | null): Session {
    const t = this.now();
    this.sweep();
    if (address) {
      // S8: a handful of sessions per address; the oldest goes.
      const mine = [...this.sessions].filter(([, x]) => x.address === address).sort((a, b) => a[1].createdAt - b[1].createdAt);
      while (mine.length >= MAX_SESSIONS_PER_ADDRESS) this.sessions.delete(mine.shift()![0]);
    }
    const s: Session = { id: randomBytes(32).toString('base64url'), method, address, createdAt: t, expiresAt: t + SESSION_TTL, csrf: randomBytes(24).toString('base64url') };
    this.sessions.set(idHash(s.id), s);
    this.save();
    return s;
  }

  /** Write sessions soon (debounced). */
  private save() {
    if (!this.opts.sessionFile) return;
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 200);
    this.saveTimer.unref();
  }

  /** Write sessions now, atomically. Only hashes of ids are stored. */
  flush() {
    const file = this.opts.sessionFile;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!file || !this.dirty) return;
    this.dirty = false;
    const now = this.now();
    const out: Record<string, Omit<Session, 'id'>> = {};
    for (const [h, v] of this.sessions) if (v.expiresAt > now) out[h] = { method: v.method, address: v.address, createdAt: v.createdAt, expiresAt: v.expiresAt, csrf: v.csrf };
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      /* best effort: sessions stay valid in memory */
    }
  }

  /** The session named by a Cookie header, if live (and, on the local console, proven by its x-antibody-session secret). */
  fromCookie(header: string | undefined, sessionHeader?: string | string[]): Session | null {
    const id = parseCookies(header)[this.cookieName];
    if (!id) return null;
    const h = idHash(id);
    const s = this.sessions.get(h);
    if (!s) return null;
    if (s.expiresAt < this.now()) {
      this.sessions.delete(h);
      this.save();
      return null;
    }
    if (this.opts.requireSessionHeader) {
      const got = typeof sessionHeader === 'string' ? sessionHeader : '';
      if (!s.csrf || !got || !timingSafeEqual(sha(got), sha(s.csrf))) return null;
    }
    return { ...s, id };
  }

  get cookieName(): string {
    return this.opts.cookieName ?? SESSION_COOKIE;
  }

  /** Set-Cookie for this Auth's cookie name. The __Host- prefix always gets Secure. */
  cookie(s: Session, secure = false): string {
    const sec = secure || this.cookieName.startsWith('__Host-');
    return `${this.cookieName}=${s.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor((s.expiresAt - s.createdAt) / 1000)}${sec ? '; Secure' : ''}`;
  }

  clearCookieHeader(secure = false): string {
    const sec = secure || this.cookieName.startsWith('__Host-');
    return `${this.cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${sec ? '; Secure' : ''}`;
  }

  end(id: string) {
    this.sessions.delete(idHash(id));
    this.save();
  }

  /** Live sessions (metrics). */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** `secure` adds the Secure flag: set it whenever the browser reached us over HTTPS. */
  static setCookie(s: Session, secure = false): string {
    return `${SESSION_COOKIE}=${s.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor((s.expiresAt - s.createdAt) / 1000)}${secure ? '; Secure' : ''}`;
  }

  static clearCookie(secure = false): string {
    return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
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
