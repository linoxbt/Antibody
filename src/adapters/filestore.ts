/** Tiny JSON file store with a cross-process lock, for the offline backend. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

  /** Read-modify-write under an exclusive lock (mkdir is atomic). */
  update<R>(fn: (state: T) => R): R {
    const lock = `${this.path}.lock`;
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        mkdirSync(lock);
        break;
      } catch {
        // Break locks left by a crashed process.
        try {
          if (Date.now() - statSync(lock).mtimeMs > 15_000) rmSync(lock, { recursive: true, force: true });
        } catch {
          /* raced with the owner releasing it */
        }
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`);
        sleepSync(5);
      }
    }
    try {
      const state = this.read();
      const out = fn(state);
      const tmp = `${this.path}.${process.pid}.tmp`;
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

export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, timeoutMs = 60_000): Promise<T> {
  const prev = chains.get(lockPath) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(async () => {
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        mkdirSync(lockPath);
        break;
      } catch {
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > timeoutMs) rmSync(lockPath, { recursive: true, force: true });
        } catch {
          /* released meanwhile */
        }
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${lockPath}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    try {
      return await fn();
    } finally {
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
