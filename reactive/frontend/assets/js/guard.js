// Antibody Guard data: live state from the Guard service (/api/state, which reads Base Sepolia,
// Ethereum Sepolia and Reactive Lasna), or, if it cannot be reached, the evidence recorded at build time
// (/evidence.json: every deployed contract and every origin → reaction → callback loop).
export const CHAIN = { baseSepolia: 'Base Sepolia', sepolia: 'Ethereum Sepolia', lasna: 'Reactive Lasna' };
export const RULE = {
  UnknownRecipient: ['Unknown recipient', 'The agent tried to pay an address that is not a payee: quarantined.'],
  RepeatedRefusals: ['Repeated refusals', 'Three refused proposals in ten minutes: the vault is frozen.'],
  Burst: ['Burst', 'More than five proposals in two minutes: the vault is frozen.'],
  CrossChainQuarantine: ['Learned elsewhere', 'Quarantined on one chain, so quarantined on every chain.'],
  PayeeVeto: ['Payee veto', 'A payee change towards a known attacker, cancelled before its timelock ended.'],
  ScheduledPayment: ['Scheduled payment', 'A recurring payment paid on Reactive’s CRON, under the same rules.'],
  Retry: ['Retry', 'A callback the network lost, requested again.'],
  AiRisk: ['AI risk report', 'The AI scorer reported the address at 80 or more: quarantined everywhere.'],
};
export const CODES = ['None', 'Frozen', 'Quarantined', 'UnknownPayee', 'LabelMismatch', 'OverCap', 'OverDailyLimit', 'Duplicate', 'TransferFailed'];

let evidence = null;
export async function loadEvidence() {
  if (!evidence) evidence = await (await fetch('/evidence.json', { cache: 'no-store' })).json();
  return evidence;
}

/** { live: true, ...service state } or { live: false, ...a state shaped from the recorded evidence }. */
export async function loadState() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(String(r.status));
    const s = await r.json();
    if (!s.vaults) throw new Error('the Guard service is still starting');
    return { ...s, liveLoops: s.live ?? [], live: true, evidence: await loadEvidence().catch(() => null) };
  } catch {
    const e = await loadEvidence();
    return {
      live: false,
      updatedAt: e.generatedAt,
      vaults: e.contracts.vaults.map((v) => ({ ...v, frozen: null, balance: null, proposals: null, guardian: e.contracts.guard.address })),
      guard: { address: e.contracts.guard.address, lessons: e.lessons ?? [], chains: String(e.contracts.vaults.length), cronOn: false, riskThreshold: 80, reserves: null, debt: null, explorer: e.explorers.lasna },
      oracle: { address: e.contracts.oracle.address, scorer: e.contracts.oracle.scorer, explorer: e.explorers.baseSepolia },
      liveLoops: [], recorded: e.recorded, events: [], explorers: e.explorers, evidence: e,
    };
  }
}

export async function score(message) {
  const r = await fetch('/api/score', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

/** Live loops first (newest first), then the recorded ones the service has not seen. */
export const loopsOf = (s) => [...(s.liveLoops ?? []), ...(s.recorded ?? [])];
export const secs = (n) => (n === null || n === undefined ? '…' : n === 0 ? '<1 s' : `${n} s`);
export const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
export function txLink(explorers, chain, hash) {
  return hash && explorers?.[chain] ? `${explorers[chain]}/tx/${hash}` : null;
}
export function addrLink(explorers, chain, a) {
  return a && explorers?.[chain] ? `${explorers[chain]}/address/${a}` : null;
}
