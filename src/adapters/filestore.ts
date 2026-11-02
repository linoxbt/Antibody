/** Tiny JSON file store with a cross-process lock, for the offline backend. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Mark a lock directory with its holder, so a live holder's lock is never broken (B5). */
function claim(lock: string): void {
  writeFileSync(`${lock}/owner`, `${process.pid}\n${hostname()}\n`);
}

/**
 * A lock may be broken only when its holder is gone: a dead pid on this host,
 * or no heartbeat for `staleMs` (holders refresh the lock's mtime while they
 * run). A slow holder that is still alive keeps its lock.
 */
function breakIfAbandoned(lock: string, staleMs: number): void {
  try {
    const st = statSync(lock);
    let pid = 0;
    let host = '';
    try {
      [pid, host] = ((s) => [Number(s[0]), s[1] ?? ''] as const)(readFileSync(`${lock}/owner`, 'utf8').split('\n'));
    } catch {
      /* not written yet (just created) or a lock from an older build */
    }
    const sameHost = host === hostname();
    const dead = sameHost && pid > 0 && !alive(pid);
    if (dead || Date.now() - st.mtimeMs > staleMs) rmSync(lock, { recursive: true, force: true });
  } catch {
    /* released meanwhile */
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class JsonFileStore<T> {
  constructor(
    private readonly path: string,
    private readonly initial: () => T,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  read(): T {
    if (!existsSync(this.path)) return this.initial();
    return JSON.parse(readFileSync(this.path, 'utf8')) as T;
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }

  /**
   * Read-modify-write under an exclusive lock (mkdir is atomic). fn mutates the
   * state in place; with `replace`, fn's return value (unless undefined) becomes
   * the new state instead.
   */
  update<R>(fn: (state: T) => R, replace = false): R {
    const lock = `${this.path}.lock`;
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        mkdirSync(lock);
        claim(lock);
        break;
      } catch {
        // Break locks left by a crashed process (never a live one).
        breakIfAbandoned(lock, 15_000);
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`);
        sleepSync(5);
      }
    }
    try {
      let state = this.read();
      const out = fn(state);
      if (replace) {
        if (out === undefined) return out;
        state = out as unknown as T;
      }
      const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
      renameSync(tmp, this.path);
      return out;
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}

/**
 * Async exclusive lock across processes (the ledger's single local writer,
 * spec §7). Also serialises callers inside this process.
 */
const chains = new Map<string, Promise<unknown>>();
const HEARTBEAT_STALE_MS = 30_000;

export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, timeoutMs = 60_000): Promise<T> {
  const prev = chains.get(lockPath) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(async () => {
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        mkdirSync(lockPath);
        claim(lockPath);
        break;
      } catch {
        breakIfAbandoned(lockPath, HEARTBEAT_STALE_MS);
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${lockPath}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    // Heartbeat: a long append (slow relayer, retries) keeps its lock.
    const beat = setInterval(() => {
      try {
        const t = new Date();
        utimesSync(lockPath, t, t);
      } catch {
        /* lock dir gone */
      }
    }, 5_000);
    beat.unref();
    try {
      return await fn();
    } finally {
      clearInterval(beat);
      rmSync(lockPath, { recursive: true, force: true });
    }
  });
  chains.set(lockPath, run);
  try {
    return await run;
  } finally {
    if (chains.get(lockPath) === run) chains.delete(lockPath);
  }
}
