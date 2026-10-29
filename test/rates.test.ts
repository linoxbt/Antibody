// USD display via the Tatum Data API: parsed, cached, never fatal.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SimulatedRates, symbolOf, TatumRates } from '../src/adapters/rates.ts';

test('symbols come from coin types; unknown coins are not priced', () => {
  assert.equal(symbolOf('0xdba3::usdc::USDC'), 'USDC');
  assert.equal(symbolOf('0x2::sui::SUI'), 'SUI');
  assert.equal(symbolOf('0xbadc0ffee::usdc_rewards::USDC_REWARDS'), null, 'a look-alike is not USDC');
});

test('Tatum rates: header and query, cached within the TTL, last good value kept on failure', async () => {
  const calls: string[] = [];
  let fail = false;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push(url);
    assert.equal((init.headers as Record<string, string>)['x-api-key'], 'k');
    if (fail) return new Response('boom', { status: 503 });
    const sym = new URL(url).searchParams.get('symbol');
    return Response.json(sym === 'SUI' ? { value: '3.21', source: 'CoinGecko', basePair: 'USD', symbol: 'SUI' } : { value: 'not-a-number' });
  }) as typeof fetch;
  const r = new TatumRates('https://api.tatum.io', 'k', { fetchImpl, ttlMs: 60_000 });
  const a = await r.usd(['SUI', 'USDC']);
  assert.equal(a.SUI!.usd, 3.21);
  assert.match(a.SUI!.source, /Tatum Data API \(CoinGecko\)/);
  assert.equal(a.USDC, undefined, 'a malformed rate is dropped, not shown');
  assert.ok(calls[0]!.includes('/v4/data/rate/symbol?symbol=SUI&basePair=USD'));
  await r.usd(['SUI']);
  assert.equal(calls.filter((c) => c.includes('SUI')).length, 1, 'cached');
  const stale = new TatumRates('https://api.tatum.io', 'k', { fetchImpl, ttlMs: 0 });
  await stale.usd(['SUI']);
  fail = true;
  assert.equal((await stale.usd(['SUI'])).SUI!.usd, 3.21, 'an outage keeps the last good value');
});

test('offline: stablecoins at their peg, labelled simulated', async () => {
  const r = await new SimulatedRates().usd(['USDC', 'SUI']);
  assert.deepEqual(Object.keys(r), ['USDC']);
  assert.equal(r.USDC!.simulated, true);
});
