/**
 * USD display of payment amounts through the Tatum Data API (spec §11, optional):
 *   GET {api}/v4/data/rate/symbol?symbol=USDC&basePair=USD   header x-api-key
 * Display only. A rate never feeds the policy, so a wrong or missing rate can
 * mislabel a number on screen but can't move money or change a verdict.
 */

export interface UsdRate {
  symbol: string;
  usd: number;
  at: number;
  source: string;
  simulated: boolean;
}

export interface RateSource {
  /** Latest USD rates for these symbols; unknown or failing symbols are left out. */
  usd(symbols: string[]): Promise<Record<string, UsdRate>>;
}

/** Coin symbol from a Move coin type, for the coins this build knows how to price. */
export function symbolOf(coinType: string): string | null {
  const m = /::(\w+)::(\w+)$/.exec(coinType);
  if (!m) return null;
  const sym = m[2]!.toUpperCase();
  return ['USDC', 'SUI', 'USDT', 'WAL'].includes(sym) ? sym : null;
}

export class TatumRates implements RateSource {
  private cache = new Map<string, UsdRate>();
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(apiUrl: string, apiKey: string, opts: { ttlMs?: number; fetchImpl?: typeof fetch } = {}) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async usd(symbols: string[]): Promise<Record<string, UsdRate>> {
    const out: Record<string, UsdRate> = {};
    await Promise.all(
      [...new Set(symbols)].map(async (symbol) => {
        const hit = this.cache.get(symbol);
        if (hit && Date.now() - hit.at < this.ttlMs) return void (out[symbol] = hit);
        try {
          const res = await this.fetchImpl(`${this.apiUrl}/v4/data/rate/symbol?symbol=${encodeURIComponent(symbol)}&basePair=USD`, { headers: { 'x-api-key': this.apiKey }, signal: AbortSignal.timeout(5000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const j = (await res.json()) as { value?: string; source?: string; timestamp?: number };
          const usd = Number(j.value);
          if (!Number.isFinite(usd) || usd <= 0) throw new Error('no rate');
          const r: UsdRate = { symbol, usd, at: Date.now(), source: `Tatum Data API${j.source ? ` (${j.source})` : ''}`, simulated: false };
          this.cache.set(symbol, r);
          out[symbol] = r;
        } catch {
          // Display only: keep the last good value if there is one, otherwise show no USD.
          if (hit) out[symbol] = hit;
        }
      }),
    );
    return out;
  }
}

/** Offline: stablecoins at their peg, labelled simulated; nothing else is priced. */
export class SimulatedRates implements RateSource {
  async usd(symbols: string[]): Promise<Record<string, UsdRate>> {
    const out: Record<string, UsdRate> = {};
    for (const s of symbols) if (s === 'USDC' || s === 'USDT') out[s] = { symbol: s, usd: 1, at: Date.now(), source: 'peg (simulated)', simulated: true };
    return out;
  }
}
