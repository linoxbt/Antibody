/**
 * Structured JSON logs carrying envelope IDs, blob IDs, verdict codes and tx
 * digests (spec §12 observability). Anything running against a simulated
 * component marks every line SIMULATED (spec §12 honest labelling).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  dir?: string;
  role: string;
  simulated: boolean;
  /** Also echo to stderr (ANTIBODY_LOG=stderr). */
  stderr?: boolean;
  base?: Record<string, unknown>;
}

export function createLogger(opts: LoggerOptions): Logger {
  if (opts.dir) mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  const file = opts.dir ? join(opts.dir, `${opts.role}.jsonl`) : null;
  const write = (level: string, event: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify(
      {
        ts: new Date().toISOString(),
        level,
        role: opts.role,
        ...(opts.simulated ? { banner: 'SIMULATED' } : {}),
        event,
        ...opts.base,
        ...fields,
      },
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    );
    if (file) {
      try {
        appendFileSync(file, line + '\n', { mode: 0o600 });
      } catch {
        // A full disk or a removed log folder must never take a daemon down; the line still goes to stderr if enabled.
      }
    }
    if (opts.stderr) process.stderr.write(line + '\n');
  };
  return {
    info: (e, f) => write('info', e, f),
    warn: (e, f) => write('warn', e, f),
    error: (e, f) => write('error', e, f),
    child: (f) => createLogger({ ...opts, base: { ...opts.base, ...f } }),
  };
}

export const nullLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
};
