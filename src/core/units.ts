/** Decimal display amounts ⇄ integer base units, without floating point. */

export function toBaseUnits(display: string, decimals: number): bigint {
  const s = display.trim().replace(/_/g, '');
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`"${display}" is not a non-negative decimal amount`);
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`"${display}" has more than ${decimals} decimal places`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

export function formatUnits(base: bigint | string, decimals: number): string {
  const v = BigInt(base);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const scale = 10n ** BigInt(decimals);
  const whole = a / scale;
  const frac = (a % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}
