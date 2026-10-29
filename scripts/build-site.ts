/**
 * Build the public demo site: the web view plus demo.json, a recorded
 * walkthrough produced by running the real code on the offline backend
 * (SIMULATED). Every state snapshot is exactly what the control process's
 * /api/state returns at that point in the story.
 *
 *   npx tsx scripts/build-site.ts    → site/
 */
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
      title: 'Four lanes, one account, payees signed by Ada',
      text: 'Each lane is a Walrus Memory delegate key labelled on-chain by the owner wallet. Ada registered her landlord, her sister and the utility through the CLI, signed with the user key after typing the last six characters of each address. Only these addresses can ever be paid.',
    });

    await snap({
      time: '0:00',
      title: 'Steward at work: rent is paid',
      text: 'Steward recalls Ada’s trusted fact and proposes 450 USDC to the landlord. The policy engine checks the ledger, the address, the label, the cap and an exact dry-run: ALLOW. The unprotected agent, with the same model and memories, agrees.',
      run: await run(w, RENT, true),
    });

    const coin = w.airdrop(POISON_COIN);
    const scan = await w.scan();
    await snap({
      time: '0:20',
      title: 'The poison: a coin called “USDC Rewards”',
      text: `A second wallet sends Steward a coin whose description reads: “${POISON_COIN.description}” The ingest worker writes it through the wallet-objects lane as an untrusted observation, and the sentinel scores it ${scan.items[0]?.score.toFixed(2)}: an incident.`,
    });

    await snap({
      time: '0:55',
      title: 'The near-miss: the model was fooled, the code wasn’t',
      text: 'Asked to pay rent, the model believes the “new wallet”, writes itself a note and proposes paying 0xbad0…. The runtime made the note a child of everything the turn read, so it is untrusted. The policy blocks the payment: the landlord is registered to a different address. The unprotected agent would have sent 450 USDC to the attacker.',
      run: await run(w, RENT, true),
    });

    const q = await w.quarantine({ type: 'source', value: coin.objectId }, 'poisoned coin metadata (USDC Rewards)');
    await snap({
      time: '1:40',
      title: 'Blast radius and quarantine',
      text: `One quarantine record (ledger #${q.seq}) excludes the coin’s observation, Steward’s note and the blocked decision from every future prompt and policy input. Nothing is deleted: the forensic view still shows all three. Antibody also learned lesson #${q.lessonSeq} from it.`,
      highlight: q.seq,
    });

    w.airdrop({ type: '0x77777777777777777777777777777777777777777777777777777777777777aa::points::POINTS', name: 'Tenant Points', symbol: 'TPTS', description: 'Thanks for being a great tenant. Points expire soon.' });
    const scan2 = await w.scan();
    const inc = scan2.items[0]?.incident;
    await snap({
      time: '2:05',
      title: 'It learned: the repeat attack is caught on sight',
      text: `The same attacker sends an innocent-looking “Tenant Points” coin: no address, no instructions. The sentinel recognises the sender from lesson #${q.lessonSeq} and the coin is auto-quarantined (ledger #${inc?.quarantineSeq}) before Steward ever reads it.`,
      ...(inc?.quarantineSeq !== undefined ? { highlight: inc.quarantineSeq } : {}),
    });

    await snap({
      time: '2:15',
      title: 'Clean restoration: same digest from Walrus + Sui alone',
      text: 'A fresh process with an empty cache rebuilds everything from the ledger and memories on Walrus and the lane labels on Sui. Its projection digest matches the live one, so the quarantine survived restoration. Rent now goes to the real landlord.',
      run: await run(w, RENT, true),
    }, true);

    await snap({
      time: '2:25',
      title: 'Agent payments over x402, under the same policy',
      text: 'The utility bills over HTTP 402. Its payTo becomes an ordinary proposal; the signer signs the Sui transaction without executing it and the facilitator settles it. A 402 server naming any other address would be blocked like an unknown recipient.',
      run: await run(w, `Pay the electricity bill at http://127.0.0.1:${BILL_PORT}/bill/2026-11`, true),
    }, true);
  } finally {
    bill.close();
    w.dispose();
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
