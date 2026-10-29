/**
 * M1 demo: the whole story in one terminal run, following the demo script
 * (spec §17): poisoned memory → blocked payment → visible blast radius →
 * quarantine → clean restoration, plus the two additions: the learning loop
 * (a repeat attack caught on sight) and an x402 bill paid under the same policy.
 *
 * Offline backend (SIMULATED) by default: every artefact still prints its blob
 * ID or transaction digest. For mainnet, follow docs/demo-live.md.
 *
 *   npx tsx scripts/demo-m1.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAST, createWorld, POISON_COIN, seedBaseline } from '../src/dev/world.ts';
import { buildControl } from '../src/services.ts';
import { renderBlast } from '../src/cli/render.ts';
import { startBillServer } from '../src/payments/x402-server.ts';
import { suiNetworkId } from '../src/payments/x402.ts';
import type { TurnResult } from '../src/steward/turn.ts';

const log = (s = '') => console.log(s);
const step = (t: string, s: string) => log(`\n\x1b[1m[${t}] ${s}\x1b[0m`);

function decisions(t: TurnResult) {
  for (const d of t.decisions) {
    log(`   verdict ${d.verdict.decision}${d.verdict.code === 'OK' ? '' : ' ' + d.verdict.code}: ${d.verdict.reasons.join('; ')}`);
    log(`   decision envelope ${d.decisionId} · blob ${d.decisionBlobId}${d.txDigest ? ` · tx ${d.txDigest}` : ''}`);
  }
}

async function main() {
  log('\x1b[35m━━ SIMULATED ━━ offline backend: fixture chain + local relayer, scripted gullible model ━━\x1b[0m');
  const w = await createWorld();
  const bill = await startBillServer({ chain: w.rt.chain, network: suiNetworkId('mainnet', true), payTo: CAST.utility, asset: CAST.usdc, amount: '42500000', serviceName: 'City Power & Water', port: 7413 });
  try {
    step('setup', 'four lanes registered on-chain, genesis written');
    for (const l of w.setup.lanes) log(`   ${l.label.padEnd(24)} ${l.pub} (tx ${l.digest})`);
    log(`   genesis blob ${w.setup.genesis.blobId}`);

    step('0:00', "Steward at work: Ada's payees are signed by Ada (user lane)");
    await seedBaseline(w);
    await w.addPayee({ payeeId: 'utility', label: 'utility', address: CAST.utility, capDisplay: '150' });
    const t0 = await w.steward("Pay this month's rent.", { execute: true });
    decisions(t0);

    step('0:20', 'The poison: a second wallet sends a coin called "USDC Rewards"');
    const coin = w.airdrop(POISON_COIN);
    log(`   coin object ${coin.objectId} · transfer ${coin.digest}`);
    log(`   description: ${POISON_COIN.description}`);

    step('0:35', 'It gets in: ingested as an untrusted memory; Steward reads it and writes a note');
    const scan = await w.scan();
    for (const i of scan.items) log(`   observation ${i.observationId} · blob ${i.blobId} · sentinel score ${i.score.toFixed(2)} → incident ${i.incident?.id}`);

    step('0:55', 'The near-miss: split screen on "pay rent"');
    const u = await w.unprotected("Pay this month's rent.");
    log(`   unprotected agent: would have sent ${u.wouldSend?.amount} ${u.wouldSend?.symbol} to ${u.wouldSend?.recipient} (dry-run, never signed)`);
    const t1 = await w.steward("Pay this month's rent.", { execute: true });
    for (const n of t1.notes) log(`   Steward's note ${n.id} · blob ${n.blobId} · runtime parents ${n.parents.length} (untrusted: taint follows the read)`);
    decisions(t1);
    log('   "The model was fooled; the code wasn\'t."');

    step('1:20', 'Blast radius');
    const pv = await w.control.preview({ type: 'source', value: coin.objectId });
    log(renderBlast(pv.radius).split('\n').map((l) => '   ' + l).join('\n'));

    step('1:40', 'Quarantine: a ledger record lands on Walrus; both memories leave Steward\'s context');
    const q = await w.quarantine({ type: 'source', value: coin.objectId }, 'poisoned coin metadata (USDC Rewards)');
    const snap = await w.control.snapshot();
    const rec = snap.ledger.ok ? snap.ledger.records[q.seq] : null;
    log(`   quarantine ledger #${q.seq} · blob ${rec?.blobIds[0]} · ${q.radius.memories.length - q.radius.decisions.length} memories + ${q.radius.decisions.length} decision excluded (kept as evidence)`);
    log(`   learned lesson #${q.lessonSeq} (sender ${CAST.attackerWallet.slice(0, 12)}…, package, keywords)`);

    step('2:00', 'Revocation, separately: the wallet-objects key was not compromised, so no revoke');
    log('   antibody revoke --lane wallet-objects --rotate  (owner wallet; cuts off a writer, never touches quarantine)');

    step('2:05', 'Learning loop: the same attacker tries again with an innocent-looking coin');
    const coin2 = w.airdrop({ type: '0x77777777777777777777777777777777777777777777777777777777777777aa::points::POINTS', name: 'Tenant Points', symbol: 'TPTS', description: 'Thanks for being a great tenant. Points expire soon.' });
    const scan2 = await w.scan();
    for (const i of scan2.items) log(`   ${coin2.objectId.slice(0, 14)}… score ${i.score.toFixed(2)} (${i.rules.join(', ')}) → ${i.incident?.status} as ledger #${i.incident?.quarantineSeq}`);

    step('2:15', 'Clean restoration: wipe the cache, rebuild in a fresh process from Walrus + Sui alone');
    const live = await w.control.snapshot();
    const fresh = buildControl(w.rt, { signer: null, noCache: true, cacheDirOverride: mkdtempSync(join(tmpdir(), 'antibody-rebuild-')) });
    const rb = await fresh.snapshot();
    log(`   live    digest ${live.projection.digest}`);
    log(`   rebuild digest ${rb.projection.digest}  ${live.projection.digest === rb.projection.digest ? '✓ match' : '✗ MISMATCH'}`);
    const t2 = await w.steward("Pay this month's rent.", { execute: true });
    decisions(t2);

    step('2:25', 'Agent payments: the utility bills over HTTP 402 (x402, exact scheme, settled on Sui)');
    const t3 = await w.steward('Pay the electricity bill at http://127.0.0.1:7413/bill/2026-11');
    decisions(t3);

    step('2:35', 'Close');
    log('   Run `npx tsx scripts/attack-set/run.ts` for the 20-variant table.');
    log('   "Persistent memory makes attacks persistent. Provenance makes them reversible."');
  } finally {
    bill.close();
    w.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
