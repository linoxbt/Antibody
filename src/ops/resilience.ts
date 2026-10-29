/**
 * Retries with backoff for the two network dependencies (Walrus Memory relayer
 * and the Sui RPC), and a per-process health record the console shows as a
 * degraded-service banner. Retrying never weakens a check: a call that still
 * fails after its retries throws exactly as before, and every verification
 * that depends on it fails closed.
 */

export type Dependency = 'relayer' | 'chain' | 'chain-crosscheck';

export interface DependencyHealth {
  ok: boolean;
  /** Consecutive failed calls (after retries). */
  failures: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastOkAt: string | null;
}

export class Health {
  private readonly deps = new Map<Dependency, DependencyHealth>();
  constructor(private readonly now: () => number = Date.now) {}

  ok(dep: Dependency): void {
    const h = this.get(dep);
    this.deps.set(dep, { ...h, ok: true, failures: 0, lastOkAt: new Date(this.now()).toISOString() });
  }

  fail(dep: Dependency, err: unknown): void {
    const h = this.get(dep);
    this.deps.set(dep, { ...h, ok: false, failures: h.failures + 1, lastError: errorText(err), lastErrorAt: new Date(this.now()).toISOString() });
  }

  get(dep: Dependency): DependencyHealth {
    return this.deps.get(dep) ?? { ok: true, failures: 0, lastError: null, lastErrorAt: null, lastOkAt: null };
  }

  snapshot(): { degraded: boolean; deps: Partial<Record<Dependency, DependencyHealth>> } {
    const deps = Object.fromEntries(this.deps) as Partial<Record<Dependency, DependencyHealth>>;
    return { degraded: [...this.deps.values()].some((d) => !d.ok), deps };
  }
}

/** One health record per process: the control daemon's is what the console shows. */
export const processHealth = new Health();

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Failures before the request reached the server: always safe to retry, even for writes. */
export function isConnectError(e: unknown): boolean {
  const code = (e as { code?: string; cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code ?? '';
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'EPIPE'].includes(code) || /fetch failed|socket hang up|network error/i.test(errorText(e));
}

/** Overload or a flaky upstream: 429, 502, 503, 504, gRPC UNAVAILABLE/DEADLINE_EXCEEDED/RESOURCE_EXHAUSTED. */
export function isTransient(e: unknown): boolean {
  if (isConnectError(e)) return true;
  const status = (e as { status?: number; statusCode?: number })?.status ?? (e as { statusCode?: number })?.statusCode;
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  return /\b(429|502|503|504)\b|too many requests|service unavailable|bad gateway|gateway timeout|UNAVAILABLE|DEADLINE_EXCEEDED|RESOURCE_EXHAUSTED|timed? ?out/i.test(errorText(e));
}

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  retryable?: (e: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Exponential backoff with full jitter. */
export async function withRetry<T>(fn: () => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const retries = o.retries ?? 3;
  const base = o.baseMs ?? 250;
  const max = o.maxMs ?? 4000;
  const retryable = o.retryable ?? isTransient;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = o.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || !retryable(e)) throw e;
      await sleep(Math.round(random() * Math.min(max, base * 2 ** attempt)));
    }
  }
}

/**
 * Wrap every async method of `target`: retries for transient failures (only
 * connect-level failures for methods listed in `writes`, so a request the
 * server may have applied is never sent twice unless it is idempotent), and
 * health bookkeeping for `dep`. Non-function properties pass through.
 */
export function resilient<T extends object>(target: T, dep: Dependency, o: RetryOptions & { writes?: readonly string[]; health?: Health; skip?: readonly string[] } = {}): T {
  const health = o.health ?? processHealth;
  const writes = new Set(o.writes ?? []);
  const skip = new Set(o.skip ?? []);
  return new Proxy(target, {
    get(t, prop) {
      const v = Reflect.get(t, prop);
      if (typeof v !== 'function' || typeof prop !== 'string' || skip.has(prop) || prop === 'constructor') return v;
      return (...args: unknown[]) => {
        const out = (v as (...a: unknown[]) => unknown).apply(t, args);
        if (!(out instanceof Promise)) return out;
        let first = true;
        const call = () => (first ? ((first = false), out) : ((v as (...a: unknown[]) => Promise<unknown>).apply(t, args)));
        return withRetry(call, { ...o, retryable: writes.has(prop) ? isConnectError : (o.retryable ?? isTransient) }).then(
          (r) => (health.ok(dep), r),
          (e) => {
            health.fail(dep, e);
            throw e;
          },
        );
      };
    },
  });
}
