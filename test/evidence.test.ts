// `antibody evidence`: public identifiers only, explorer links, honest labels.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { renderEvidence, type EvidenceState } from '../src/ops/evidence.ts';

const pub = (c: string) => c.repeat(64);
const state = (simulated: boolean): EvidenceState => ({
  backend: simulated ? 'offline' : 'live',
  network: 'mainnet',
  chain: simulated ? 'fixture' : 'tatum-grpc',
  account: { id: '0x' + 'a'.repeat(64), owner: '0x' + 'b'.repeat(64), active: true },
  wallet: '0x' + 'c'.repeat(64),
  checkpoint: 42,
  lanes: [
    { lane: 'agent', label: 'antibody:agent', pub: pub('1'), status: 'active' },
    { lane: 'user', label: 'antibody:user', pub: pub('2'), status: 'active' },
  ],
  ledger: { ok: true, head: { seq: 1, hash: 'h'.repeat(64) }, records: [{ seq: 0, type: 'genesis', blobId: 'G1', payload: {} }, { seq: 1, type: 'lane.rotate', blobId: 'R1', payload: { digest: 'D'.repeat(44) } }], lessons: [] },
  nodes: [
    { id: 'm1', lane: 'user', kind: 'statement', cls: 'trusted', quarantined: false, blobIds: ['B1'] },
    { id: 'm2', lane: 'wallet-objects', kind: 'observation', cls: 'untrusted', quarantined: true, blobIds: ['B2'] },
  ],
  digest: 'd'.repeat(64),
  reports: [],
});

test('live evidence: form fields, explorer links, counts, no memory text', () => {
  const md = renderEvidence(state(false), { setup: { accountId: '', owner: '', wallet: '', lanes: [{ lane: 'agent', label: 'antibody:agent', pub: pub('1'), digest: 'T'.repeat(44) }], genesis: { blobId: 'G1', envelopeId: 'e' }, simulated: false, network: 'mainnet', at: '' }, payments: [{ recipient: '0x' + 'e'.repeat(64), amount: '450000', coinType: '0x2::usdc::USDC', status: 'executed', digest: 'P'.repeat(44) }], generatedAt: 'now', tatumHost: 'sui-mainnet-grpc.gateway.tatum.io' });
  assert.match(md, /^# Antibody · mainnet evidence/);
  assert.match(md, /MEMWAL_AGENT_ID.*`1{64}`/);
  assert.match(md, /\*\*4\*\* \(2 memories \+ 2 ledger records\)/);
  assert.match(md, /suiscan\.xyz\/mainnet\/tx\/T{44}/, 'lane registration digest linked');
  assert.match(md, /suiscan\.xyz\/mainnet\/tx\/D{44}/, 'rotate digest linked');
  assert.match(md, /suiscan\.xyz\/mainnet\/tx\/P{44}/, 'payment linked');
  assert.match(md, /walruscan\.com\/mainnet\/blob\/B2/);
  assert.match(md, /untrusted \(quarantined\)/);
  assert.match(md, /tatum-grpc \(sui-mainnet-grpc\.gateway\.tatum\.io\)/);
});

test('offline evidence says SIMULATED and does not claim Tatum', () => {
  const md = renderEvidence(state(true), { setup: null, payments: [], generatedAt: 'now', tatumHost: 'sui-mainnet-grpc.gateway.tatum.io' });
  assert.match(md, /SIMULATED evidence/);
  assert.doesNotMatch(md, /gateway\.tatum\.io/);
  assert.match(md, /Payments \(signed by Steward's signer, confirmed on-chain\)\n\nNone yet\./);
});

test('B9: a Tatum upload links the quilt patch (the JSON file), never the bare quilt blob or /undefined', async () => {
  const { toResult } = await import('../src/adapters/storage-tatum.ts');
  const certified = toResult({ jobId: 'j1', status: 'CERTIFIED', blobId: 'QUILT', quiltPatchId: 'QUILTpatch', downloadUrlByQuiltPatchId: 'https://aggregator.walrus-mainnet.walrus.space/v1/blobs/by-quilt-patch-id/QUILTpatch', sizeBytes: 10 }, 'r.json');
  assert.equal(certified.url, 'https://aggregator.walrus-mainnet.walrus.space/v1/blobs/by-quilt-patch-id/QUILTpatch');
  const pending = toResult({ jobId: 'j2', status: 'PENDING' }, 'r.json');
  assert.equal(pending.url, '');
  assert.ok(!pending.url.includes('undefined'));
});
