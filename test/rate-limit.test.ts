// Rate-limited gRPC calls (Tatum's 429) are retried; other errors are not.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { UnaryCall, type RpcTransport } from '@protobuf-ts/runtime-rpc';
import { isRateLimited, RateLimitRetry } from '../src/adapters/rate-limit.ts';

function fake(errors: unknown[]): RpcTransport & { calls: number } {
  const t = {
    calls: 0,
    mergeOptions: (o?: object) => ({ ...(o ?? {}) }),
    unary(method: never, input: object) {
      t.calls++;
      const e = errors.shift();
      const ok = <T>(v: T) => (e ? Promise.reject(e) : Promise.resolve(v));
      const parts = [ok({}), ok({ answer: 42 }), ok({ code: 'OK', detail: '' }), ok({})] as const;
      for (const q of parts) q.catch(() => undefined);
      return new UnaryCall(method, {}, input, parts[0], parts[1] as never, parts[2], parts[3]);
    },
  };
  return t as unknown as RpcTransport & { calls: number };
}
const method = { name: 'GetServiceInfo' } as never;

test('a 429 is retried until the call succeeds', async () => {
  const inner = fake([new Error('Received HTTP status code 429'), new Error('RESOURCE_EXHAUSTED: slow down')]);
  const t = new RateLimitRetry(inner, 5, 1, async () => undefined);
  assert.deepEqual(await t.unary(method, {}, {}).response, { answer: 42 });
  assert.equal(inner.calls, 3);
});

test('other errors fail at once, and retries are bounded', async () => {
  const bad = fake([new Error('INVALID_ARGUMENT: no such object')]);
  await assert.rejects(new RateLimitRetry(bad, 5, 1, async () => undefined).unary(method, {}, {}).response, /INVALID_ARGUMENT/);
  assert.equal(bad.calls, 1);
  const limited = fake(Array.from({ length: 10 }, () => new Error('HTTP status code 429')));
  await assert.rejects(new RateLimitRetry(limited, 3, 1, async () => undefined).unary(method, {}, {}).response, /429/);
  assert.equal(limited.calls, 3);
  assert.equal(isRateLimited({ code: 'RESOURCE_EXHAUSTED' }), true);
  assert.equal(isRateLimited(new Error('timeout')), false);
});
