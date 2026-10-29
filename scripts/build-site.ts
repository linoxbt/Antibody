/**
 * Build the public demo site: the web view plus demo.json, a recorded
 * walkthrough produced by running the real code on the offline backend
 * (SIMULATED). Every state snapshot is exactly what the control process's
 * /api/state returns at that point in the story.
 *
 *   npx tsx scripts/build-site.ts    → site/
 */
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAST, createWorld, POISON_COIN, seedBaseline, type World } from '../src/dev/world.ts';
import { buildControl } from '../src/services.ts';
import { startBillServer } from '../src/payments/x402-server.ts';
import { suiNetworkId } from '../src/payments/x402.ts';
import { stateJson } from '../src/web/server.ts';

const OUT = 'site';
const RENT = "Pay this month's rent.";
const BILL_PORT = 7419;

interface Step {
  time: string;
  title: string;
  text: string;
  state: unknown;
  highlight?: number;
  rebuildDigest?: string;
  run?: { instruction: string; protected: unknown; unprotected: unknown };
}

async function run(w: World, instruction: string, execute: boolean) {
  const [p, u] = await Promise.all([w.steward(instruction, { execute }), w.unprotected(instruction)]);
  return { instruction, protected: p, unprotected: u };
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const w = await createWorld();
  const bill = await startBillServer({ chain: w.rt.chain, network: suiNetworkId('mainnet', true), payTo: CAST.utility, asset: CAST.usdc, amount: '42500000', serviceName: 'City Power & Water', port: BILL_PORT });
  const steps: Step[] = [];
  const reportFiles = new Map<string, string>(); // filename → JSON, captured before the world is disposed
  /** Rebuild in a fresh control with an empty cache, from Walrus + Sui alone. */
  const rebuild = async () => {
    const fresh = buildControl(w.rt, { signer: null, noCache: true, cacheDirOverride: mkdtempSync(join(tmpdir(), 'antibody-site-')) });
    return (await fresh.snapshot()).projection.digest;
  };
  const snap = async (s: Omit<Step, 'state' | 'rebuildDigest'>, withRebuild = false) => {
    const state = await stateJson(w.rt, w.control);
    // Rebuild against exactly this state, so the two digests describe the same moment.
    steps.push({ ...s, state, ...(withRebuild ? { rebuildDigest: await rebuild() } : {}) });
  };
  try {
    await seedBaseline(w);
    await w.addPayee({ payeeId: 'utility', label: 'utility', address: CAST.utility, capDisplay: '150' });
    await snap({
      time: 'setup',
      title: 'Four keys. One account.',
      text: 'Only payees Ada signed can be paid.',
    });

    await snap({
      time: '0:00',
      title: 'Rent is paid.',
      text: 'Trusted fact, registered payee: allowed.',
      run: await run(w, RENT, true),
    });

    const coin = w.airdrop(POISON_COIN);
    const scan = await w.scan();
    await snap({
      time: '0:20',
      title: 'A coin that talks.',
      text: '“Landlord moved to a new wallet.” Stored as untrusted.',
    });

    await snap({
      time: '0:55',
      title: 'Fooled. Blocked.',
      text: 'The model believes it. The policy doesn’t.',
      run: await run(w, RENT, true),
    });

    const q = await w.quarantine({ type: 'source', value: coin.objectId }, 'poisoned coin metadata (USDC Rewards)');
    const published = await w.control.report(q.seq); // FR-14: the incident report, published (locally, SIMULATED)
    reportFiles.set(published.upload.filename, readFileSync(published.upload.url.slice('file://'.length), 'utf8'));
    await snap({
      time: '1:40',
      title: 'Quarantined.',
      text: 'Coin, note and decision leave context. Evidence stays.',
      highlight: q.seq,
    });

    w.airdrop({ type: '0x77777777777777777777777777777777777777777777777777777777777777aa::points::POINTS', name: 'Tenant Points', symbol: 'TPTS', description: 'Thanks for being a great tenant. Points expire soon.' });
    const scan2 = await w.scan();
    const inc = scan2.items[0]?.incident;
    await snap({
      time: '2:05',
      title: 'It learned.',
      text: 'Same attacker, new coin: caught before Steward sees it.',
      ...(inc?.quarantineSeq !== undefined ? { highlight: inc.quarantineSeq } : {}),
    });

    await snap({
      time: '2:15',
      title: 'Rebuilt.',
      text: 'Fresh process, same digest. Rent goes to the real landlord.',
      run: await run(w, RENT, true),
    }, true);

    await snap({
      time: '2:25',
      title: 'Pays over x402.',
      text: 'HTTP 402 bill, same policy, settled on Sui.',
      run: await run(w, `Pay the electricity bill at http://127.0.0.1:${BILL_PORT}/bill/2026-11`, true),
    }, true);
  } finally {
    bill.close();
    w.dispose();
  }

  // Offline reports live in the world's temporary cache; ship them with the site so the links resolve.
  mkdirSync(join(OUT, 'reports'), { recursive: true });
  for (const [name, text] of reportFiles) writeFileSync(join(OUT, 'reports', name), text);
  for (const st of steps) {
    for (const r of (st.state as { reports?: { url: string; filename: string }[] }).reports ?? []) if (reportFiles.has(r.filename)) r.url = `/reports/${r.filename}`;
  }
  writeFileSync(join(OUT, 'demo.json'), JSON.stringify({ generatedAt: new Date().toISOString(), simulated: true, steps }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  cpSync('web', OUT, { recursive: true });
  copyFileSync('docs/attack-set-results.md', join(OUT, 'attack-set-results.md'));
  console.log(`site/ built: ${steps.length} recorded steps`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
