/**
 * Phase 0 capability probe (spec §14). Runs once against mainnet and prints
 * PASS or FAIL with evidence (blob IDs, tx digests, raw responses) for each
 * check, and writes probe-evidence.json. P-2, P-4, P-5 and P-7 gate Phase 1.
 *
 * Env:
 *   MEMWAL_ACCOUNT_ID       account created on memory.walrus.xyz
 *   PROBE_DELEGATE_KEY      hex private key of an existing delegate (from the dashboard)
 *   OWNER_SUI_PRIVATE_KEY   throwaway owner (≈0.5 SUI) for P-4/P-5/P-6
 *   TATUM_API_KEY           mainnet key
 *   ANTIBODY_HOME           (P-7) a home where `antibody setup` already ran with ANTIBODY_BACKEND=live
 *
 *   npx tsx scripts/probe.ts [--only P-1,P-2,...]
 */
import { writeFileSync } from 'node:fs';
import { MemWal, MemWalRateLimitedError } from '@mysten-incubation/memwal';
import { addDelegateKey, generateDelegateKey, removeDelegateKey } from '@mysten-incubation/memwal/account';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { MAINNET, loadConfig, type Config } from '../src/config.ts';
import { SdkChainReader } from '../src/adapters/chain-sdk.ts';
import { buildEnvelope, laneQuery } from '../src/core/envelope.ts';
import { sha256Hex, SUI_COIN_TYPE, uuidv7, bytesToHex } from '../src/core/encoding.ts';
import { laneKeyFromSeedHex } from '../src/core/keys.ts';
import { retrieveAll } from '../src/adapters/memory.ts';
import { LiveMemoryClient } from '../src/adapters/memwal-live.ts';
import { createRuntime } from '../src/runtime.ts';
import { buildControl } from '../src/services.ts';
import { writeStatement } from '../src/user/user.ts';
import { loadLaneKey } from '../src/keystore.ts';

type Result = { id: string; title: string; status: 'PASS' | 'FAIL' | 'SKIP'; evidence: Record<string, unknown>; note?: string };
const results: Result[] = [];
const only = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? new Set(process.argv[i + 1]!.split(',')) : null;
})();

async function probe(id: string, title: string, fn: () => Promise<{ pass: boolean; evidence: Record<string, unknown>; note?: string }>) {
  if (only && !only.has(id)) return;
  process.stdout.write(`${id} ${title} … `);
  try {
    const r = await fn();
    results.push({ id, title, status: r.pass ? 'PASS' : 'FAIL', evidence: r.evidence, ...(r.note ? { note: r.note } : {}) });
    console.log(r.pass ? 'PASS' : 'FAIL', r.note ? `(${r.note})` : '');
  } catch (e) {
    const msg = (e as Error).message;
    const skip = msg.startsWith('SKIP:');
    results.push({ id, title, status: skip ? 'SKIP' : 'FAIL', evidence: { error: msg } });
    console.log(skip ? 'SKIP' : 'FAIL', msg);
  }
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`SKIP: set ${name}`);
  return v;
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));

async function main() {
  const cfg: Config = loadConfig({ ...process.env, ANTIBODY_BACKEND: 'live' });
  const accountId = process.env.MEMWAL_ACCOUNT_ID ?? '';
  const chain = new SdkChainReader({ transport: 'grpc', network: 'mainnet', url: cfg.tatumGrpcUrl, apiKey: cfg.tatumApiKey, packageId: MAINNET.packageId });
  const NS = 'probe.ab';

  await probe('P-1', 'Relayer reachable and compatible', async () => {
    const res = await fetch(`${cfg.memwalServerUrl}/config`);
    const conf = (await res.json()) as { packageId: string; registryId: string; network: string };
    const mw = MemWal.create({ key: bytesToHex(new Uint8Array(32).fill(7)), accountId: accountId || MAINNET.registryId, serverUrl: cfg.memwalServerUrl });
    const health = await mw.health();
    const compat = await mw.compatibility();
    return { pass: conf.packageId === MAINNET.packageId && conf.network === 'mainnet', evidence: { config: conf, health, compat } };
  });

  let probeBlob: string | null = null;
  await probe('P-2', 'Original envelope retrieval (byte-identical)', async () => {
    const seed = need('PROBE_DELEGATE_KEY');
    need('MEMWAL_ACCOUNT_ID');
    const key = laneKeyFromSeedHex(seed);
    const mw = new LiveMemoryClient({ seedHex: key.seedHex, publicKeyHex: key.publicKeyHex, accountId, serverUrl: cfg.memwalServerUrl });
    const env = buildEnvelope(
      { id: uuidv7(Date.now()), acct: accountId, ns: NS, lane: 'user', kind: 'statement', ckpt: await chain.latestCheckpoint(), ts: new Date().toISOString(), text: 'Probe | pipes | and emoji 🏠🔐\nsecond line\n\ttabbed "quotes"' },
      key,
    );
    const { blobId } = await mw.remember(env.text, NS, env.header.id);
    probeBlob = blobId;
    // Find it by envelope id first (the rebuild query plan relies on this), then by content.
    let hits = await mw.recall(`id:${env.header.id}`, NS, 10);
    let byId = true;
    if (!hits.some((h) => h.blobId === blobId)) {
      byId = false;
      hits = await mw.recall('Probe pipes and emoji second line tabbed quotes', NS, 10);
    }
    const hit = hits.find((h) => h.blobId === blobId);
    return {
      pass: !!hit && sha256Hex(hit.text) === sha256Hex(env.text),
      evidence: { blobId, envelopeId: env.header.id, foundByIdQuery: byId, sentSha256: sha256Hex(env.text), gotSha256: hit ? sha256Hex(hit.text) : null, recalled: hits.length },
    };
  });

  await probe('P-3', 'Inventory semantics (listMemories)', async () => {
    const seed = need('PROBE_DELEGATE_KEY');
    const key = laneKeyFromSeedHex(seed);
    const mw = new LiveMemoryClient({ seedHex: key.seedHex, publicKeyHex: key.publicKeyHex, accountId, serverUrl: cfg.memwalServerUrl });
    const inv = await mw.inventory(NS);
    const row = inv.find((e) => e.blobId === probeBlob);
    return { pass: !!row, evidence: { inventorySize: inv.length, row: row ?? null, agentIdIsWriterKey: row ? row.agentId === key.publicKeyHex : null }, note: row ? `agent_id = ${row.agentId ?? 'null'}` : 'blob not listed' };
  });

  let probeKey: { privateKey: string; publicKeyHex: string } | null = null;
  await probe('P-4', 'Delegate registration (antibody:probe)', async () => {
    const owner = need('OWNER_SUI_PRIVATE_KEY');
    need('MEMWAL_ACCOUNT_ID');
    const k = await generateDelegateKey();
    const pub = bytesToHex(k.publicKey);
    const add = await addDelegateKey({ packageId: MAINNET.packageId, registryId: MAINNET.registryId, accountId, publicKey: k.publicKey, label: 'antibody:probe', suiPrivateKey: owner, suiNetwork: 'mainnet', suiClient: chain.client });
    const acct = await chain.getAccount(accountId);
    const visible = acct.delegateKeys.some((d) => d.publicKeyHex === pub && d.label === 'antibody:probe');
    const mw = new LiveMemoryClient({ seedHex: k.privateKey, publicKeyHex: pub, accountId, serverUrl: cfg.memwalServerUrl });
    const w = await mw.remember(`probe write with new key ${Date.now()}`, NS, uuidv7(Date.now()));
    probeKey = { privateKey: k.privateKey, publicKeyHex: pub };
    return { pass: visible && !!w.blobId, evidence: { publicKey: pub, addDigest: add.digest, visibleViaTatum: visible, writeBlobId: w.blobId } };
  });

  await probe('P-5', 'Delegate revocation (relayer rejects removed key)', async () => {
    const owner = need('OWNER_SUI_PRIVATE_KEY');
    if (!probeKey) throw new Error('SKIP: P-4 did not run');
    const rm = await removeDelegateKey({ packageId: MAINNET.packageId, registryId: MAINNET.registryId, accountId, publicKey: probeKey.publicKeyHex, suiPrivateKey: owner, suiNetwork: 'mainnet', suiClient: chain.client });
    const acct = await chain.getAccount(accountId);
    const gone = !acct.delegateKeys.some((d) => d.publicKeyHex === probeKey!.publicKeyHex);
    const mw = new LiveMemoryClient({ seedHex: probeKey.privateKey, publicKeyHex: probeKey.publicKeyHex, accountId, serverUrl: cfg.memwalServerUrl });
    let writeError: string | null = null;
    try {
      await mw.remember(`write after removal ${Date.now()}`, NS, uuidv7(Date.now()));
    } catch (e) {
      writeError = (e as Error).message;
    }
    const rejected = writeError !== null && /40[13]|unauthori|forbidden|not.*delegate/i.test(writeError);
    return {
      pass: gone && rejected,
      evidence: { removeDigest: rm.digest, goneOnChain: gone, writeError },
      ...(rejected ? {} : { note: 'writes still succeed: the verifier checkpoint rule (§5 step 6) is the only enforcement — document it' }),
    };
  });

  await probe('P-6', 'Tatum gateway (checkpoint + dry-run)', async () => {
    need('TATUM_API_KEY');
    const owner = need('OWNER_SUI_PRIVATE_KEY');
    const sender = Ed25519Keypair.fromSecretKey(owner).toSuiAddress();
    const grpcCkpt = await chain.latestCheckpoint();
    let rpcCkpt: number | string;
    try {
      rpcCkpt = await new SdkChainReader({ transport: 'jsonrpc', network: 'mainnet', url: cfg.tatumRpcUrl, apiKey: cfg.tatumApiKey, packageId: MAINNET.packageId }).latestCheckpoint();
    } catch (e) {
      rpcCkpt = `JSON-RPC unavailable: ${(e as Error).message.slice(0, 120)}`;
    }
    const bytes = await chain.buildTransfer({ sender, recipient: sender, coinType: SUI_COIN_TYPE, amount: 1_000_000n });
    const sim = await chain.simulate(bytes);
    return { pass: grpcCkpt > 0 && sim.ok, evidence: { grpcCheckpoint: grpcCkpt, jsonRpcCheckpoint: rpcCkpt, dryRun: json(sim) } };
  });

  await probe('P-7', 'Quarantine survives restore', async () => {
    need('MEMWAL_ACCOUNT_ID');
    const pcfg: Config = { ...loadConfig({ ...process.env, ANTIBODY_BACKEND: 'live' }), keyIsolation: 'simulated', role: null };
    const rt = createRuntime(pcfg, 'cli');
    const control = buildControl(rt, { signer: null });
    const before = await control.snapshot();
    if (!before.ledger.ok) throw new Error(`SKIP: run \`antibody setup\` (live) first: ${before.ledger.code}`);
    const user = loadLaneKey(pcfg, 'user');
    const ids = [];
    for (const t of ['P-7 probe fact A', 'P-7 probe fact B', 'P-7 probe fact C']) ids.push(await writeStatement(rt.memory(user), user, pcfg.accountId!, await rt.chain.latestCheckpoint(), t));
    const q = await control.quarantine({ type: 'memory', value: ids[2]!.id }, 'P-7 probe', [ids[2]!.blobId], false);
    const live = await control.snapshot();
    const fresh = buildControl(rt, { signer: null, noCache: true, cacheDirOverride: `${pcfg.home}/cache-probe-${Date.now()}` });
    const rb = await fresh.snapshot();
    const excluded = rb.projection.lineage.nodes.get(ids[2]!.id)?.quarantined === true;
    return { pass: live.projection.digest === rb.projection.digest && excluded, evidence: { quarantineSeq: q.seq, liveDigest: live.projection.digest, rebuildDigest: rb.projection.digest, excluded, memories: ids } };
  });

  let rateLimited = 0;
  await probe('P-8', 'Recall coverage (30 records)', async () => {
    const seed = need('PROBE_DELEGATE_KEY');
    const key = laneKeyFromSeedHex(seed);
    const mw = new LiveMemoryClient({ seedHex: key.seedHex, publicKeyHex: key.publicKeyHex, accountId, serverUrl: cfg.memwalServerUrl });
    const ns = `probe.cov.${Date.now().toString(36)}`;
    const blobs: string[] = [];
    for (let i = 0; i < 30; i++) {
      const env = buildEnvelope({ id: uuidv7(Date.now()), acct: accountId, ns, lane: 'user', kind: 'statement', ckpt: 0, ts: new Date().toISOString(), text: `coverage record ${i}: ${['rent', 'water', 'allowance', 'internet', 'gym'][i % 5]} reminder` }, key);
      for (let attempt = 0; ; attempt++) {
        try {
          blobs.push((await mw.remember(env.text, ns, env.header.id)).blobId);
          break;
        } catch (e) {
          if (e instanceof MemWalRateLimitedError && attempt < 5) {
            rateLimited++;
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
            continue;
          }
          throw e;
        }
      }
    }
    const cov = await retrieveAll(mw, ns, [laneQuery('user', 'statement')], (found, missing) => (missing.length ? ['coverage record', 'reminder'] : []));
    return { pass: cov.missing.length === 0, evidence: { namespace: ns, written: blobs.length, inventory: cov.inventory.length, retrieved: cov.memories.length, missing: cov.missing, queries: cov.queries } };
  });

  await probe('P-9', 'Relayer budget (429s during P-8)', async () => {
    if (results.find((r) => r.id === 'P-8')?.status === 'SKIP' || !results.some((r) => r.id === 'P-8')) throw new Error('SKIP: P-8 did not run');
    return { pass: rateLimited === 0, evidence: { http429: rateLimited }, note: rateLimited ? `${rateLimited} rate-limited writes: batch and pre-seed` : 'no 429s' };
  });

  const out = { at: new Date().toISOString(), account: accountId, results };
  writeFileSync('probe-evidence.json', JSON.stringify(out, null, 2));
  const gate = ['P-2', 'P-4', 'P-5', 'P-7'].every((id) => results.find((r) => r.id === id)?.status === 'PASS');
  console.log(`\nEvidence written to probe-evidence.json. Gate (P-2, P-4, P-5, P-7): ${gate ? 'PASS — Phase 1 may start' : 'NOT MET'}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
