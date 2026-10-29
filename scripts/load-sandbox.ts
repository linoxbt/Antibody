/**
 * Load test for the hosted sandbox (antibody cloud serve). Each virtual
 * visitor is a fresh Ed25519 wallet that signs in, loads its world, drops an
 * attack coin, quarantines it and reads the state again, like a person
 * clicking through the console. Prints latency percentiles per step and the
 * error breakdown.
 *
 *   npx tsx scripts/load-sandbox.ts --url http://127.0.0.1:8080 --users 30 --concurrency 10
 *   npx tsx scripts/load-sandbox.ts --local --users 50      # starts a throwaway sandbox in-process
 *
 * Only point it at a sandbox you run. The public sandbox's terms forbid load
 * tests, and its global caps will (correctly) start answering 503.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { startCloud } from '../src/web/cloud.ts';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    local: { type: 'boolean', default: false },
    users: { type: 'string', default: '20' },
    concurrency: { type: 'string', default: '5' },
  },
});

const timings = new Map<string, number[]>();
const errors = new Map<string, number>();
const time = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    (timings.get(step) ?? timings.set(step, []).get(step)!).push(performance.now() - t0);
  }
};

async function visitor(base: string): Promise<void> {
  const kp = Ed25519Keypair.generate();
  let cookie = '';
  const call = async (step: string, path: string, body?: unknown) =>
    time(step, async () => {
      const r = await fetch(base + path, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { 'content-type': 'application/json', 'x-antibody-ui': '1', cookie }, body: JSON.stringify(body) });
      if (!r.ok) {
        const k = `${step} ${r.status}`;
        errors.set(k, (errors.get(k) ?? 0) + 1);
        throw new Error(k);
      }
      if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0]!;
      return r.json();
    });
  const ch = await call('challenge', '/api/auth/challenge', { address: kp.toSuiAddress() });
  const signature = (await kp.signPersonalMessage(new TextEncoder().encode(ch.message))).signature;
  await call('sign-in (creates world)', '/api/auth/wallet', { address: kp.toSuiAddress(), message: ch.message, signature });
  await call('state', '/api/state');
  const atk = await call('attack', '/api/sandbox/attack', {});
  await call('quarantine', '/api/quarantine', { type: 'source', value: atk.coin.objectId, reason: 'load test' }).catch(() => undefined);
  await call('state (after)', '/api/state');
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

async function main() {
  const users = Number(values.users);
  const conc = Number(values.concurrency);
  let base = values.url;
  let stop = () => {};
  let dir = '';
  if (values.local) {
    dir = mkdtempSync(join(tmpdir(), 'ab-load-'));
    const c = await startCloud({ dataDir: dir, port: 0, host: '127.0.0.1', maxTenants: users + 10, maxOpen: 40, newTenantsPerHour: users + 10 });
    base = `http://127.0.0.1:${(c.server.address() as { port: number }).port}`;
    stop = () => (c.server.closeAllConnections(), c.server.close(), c.tenants.close());
  }
  if (!base) throw new Error('give --url <sandbox> or --local');
  console.log(`load test: ${users} visitors, ${conc} at a time, against ${base}`);
  const t0 = performance.now();
  let next = 0;
  let ok = 0;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (next < users) {
        next++;
        await visitor(base!).then(() => ok++, () => undefined);
      }
    }),
  );
  const secs = (performance.now() - t0) / 1000;
  console.log(`\n${ok}/${users} visitors completed in ${secs.toFixed(1)} s`);
  console.log('step'.padEnd(26) + 'n'.padStart(5) + 'p50 ms'.padStart(10) + 'p95 ms'.padStart(10) + 'max ms'.padStart(10));
  for (const [step, xs] of timings) console.log(step.padEnd(26) + String(xs.length).padStart(5) + pct(xs, 50).toFixed(0).padStart(10) + pct(xs, 95).toFixed(0).padStart(10) + Math.max(...xs).toFixed(0).padStart(10));
  if (errors.size) {
    console.log('\nerrors');
    for (const [k, n] of errors) console.log(`  ${k}: ${n}`);
  }
  const rss = process.memoryUsage().rss;
  if (values.local) console.log(`\nin-process sandbox RSS ${(rss / 2 ** 20).toFixed(0)} MB`);
  stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
  process.exitCode = ok === users ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
