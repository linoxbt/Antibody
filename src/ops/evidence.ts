/**
 * `antibody evidence`: the judging evidence for one install, as Markdown with
 * explorer links: account, lane keys and their registration transactions,
 * every memory and ledger blob, quarantines, lessons, payments, reports and
 * the projection digest. Public identifiers only: no memory text, no keys.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupResult } from '../setup.ts';

export const SETUP_EVIDENCE = 'setup-evidence.json';

export type SetupEvidence = SetupResult & { createdAccount?: { accountId: string; digest: string }; at: string; network: string };

export function saveSetupEvidence(home: string, r: SetupResult, network: string): void {
  writeFileSync(join(home, SETUP_EVIDENCE), JSON.stringify({ ...r, network, at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
}

export function loadSetupEvidence(home: string): SetupEvidence | null {
  const p = join(home, SETUP_EVIDENCE);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as SetupEvidence) : null;
}

/** The subset of /api/state the report reads. */
export interface EvidenceState {
  simulated: boolean;
  network?: string;
  chain: string;
  account: { id: string; owner: string; active: boolean };
  wallet: string | null;
  checkpoint: number;
  lanes: { lane: string; label: string; pub: string; status: string }[];
  ledger: { ok: true; head: { seq: number; hash: string }; records: { seq: number; type: string; blobId?: string; payload: Record<string, unknown> }[]; lessons: { seq: number; active: boolean }[] } | { ok: false; code: string; detail: string };
  nodes: { id: string; lane: string; kind: string; cls: string; quarantined: boolean; blobIds: string[] }[];
  digest: string;
  reports: { seq: number; url: string; blobId?: string; simulated: boolean }[];
}

export interface EvidencePayment {
  recipient: string;
  amount: string;
  coinType: string;
  status: string;
  digest?: string;
}

const scan = (network: string) => `https://suiscan.xyz/${network}`;
const blobLink = (id: string, network: string) => `[\`${id}\`](https://walruscan.com/${network}/blob/${id})`;
const txLink = (d: string, network: string) => `[\`${d}\`](${scan(network)}/tx/${d})`;
const objLink = (id: string, network: string) => `[\`${id}\`](${scan(network)}/object/${id})`;
const addrLink = (a: string, network: string) => `[\`${a}\`](${scan(network)}/account/${a})`;

export function renderEvidence(s: EvidenceState, o: { setup: SetupEvidence | null; payments: EvidencePayment[]; generatedAt: string; tatumHost: string }): string {
  const net = s.network ?? 'mainnet';
  const memories = s.nodes.filter((n) => n.blobIds.length);
  const ledgerBlobs = s.ledger.ok ? s.ledger.records.filter((r) => r.blobId) : [];
  const total = memories.length + ledgerBlobs.length;
  const byLane = new Map<string, number>();
  for (const n of memories) byLane.set(`${n.lane} · ${n.kind}`, (byLane.get(`${n.lane} · ${n.kind}`) ?? 0) + 1);
  const agent = s.lanes.find((l) => l.lane === 'agent' && l.status === 'active');
  const lines: string[] = [
    `# Antibody · ${s.simulated ? 'SIMULATED evidence (offline backend, nothing on-chain)' : `${net} evidence`}`,
    '',
    `Generated ${o.generatedAt} by \`antibody evidence\`. ${s.simulated ? 'Fixture chain' : `Chain reads via ${s.chain} (${o.tatumHost})`}, checkpoint ${s.checkpoint}.`,
    '',
    '## Submission form',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Account ID (MemWalAccount) | ${objLink(s.account.id, net)} |`,
    `| SUI address (owner) | ${addrLink(s.account.owner, net)} |`,
    `| MEMWAL_AGENT_ID (Steward's \`antibody:agent\` delegate key) | ${agent ? `\`${agent.pub}\`` : '— (no active agent lane)'} |`,
    `| Steward's wallet | ${s.wallet ? addrLink(s.wallet, net) : '—'} |`,
    `| Memories on Walrus | **${total}** (${memories.length} ${memories.length === 1 ? 'memory' : 'memories'} + ${ledgerBlobs.length} ledger ${ledgerBlobs.length === 1 ? 'record' : 'records'}) |`,
    '',
    '## Lanes (delegate keys on the account)',
    '',
    '| Label | Public key | Status | Registered in |',
    '| --- | --- | --- | --- |',
    ...s.lanes.map((l) => {
      const d = o.setup?.lanes.find((x) => x.pub === l.pub)?.digest;
      return `| \`${l.label}\` | \`${l.pub}\` | ${l.status} | ${d ? txLink(d, net) : '—'} |`;
    }),
  ];
  if (o.setup?.createdAccount) lines.push('', `Account created by ${txLink(o.setup.createdAccount.digest, net)}.`);
  if (o.setup) lines.push('', `Genesis ledger record: ${blobLink(o.setup.genesis.blobId, net)}.`);
  lines.push('', '## Control ledger (hash-chained, on Walrus)', '');
  if (s.ledger.ok) {
    lines.push(`Head: seq **${s.ledger.head.seq}**, hash \`${s.ledger.head.hash}\`.`, '', '| Seq | Record | Blob | On-chain |', '| --- | --- | --- | --- |');
    for (const r of s.ledger.records) {
      const d = typeof r.payload.digest === 'string' ? txLink(r.payload.digest, net) : '';
      lines.push(`| ${r.seq} | \`${r.type}\` | ${r.blobId ? blobLink(r.blobId, net) : '—'} | ${d} |`);
    }
    const active = s.ledger.lessons.filter((l) => l.active).length;
    lines.push('', `Lessons learned: ${s.ledger.lessons.length} (${active} active). Quarantine records: ${s.ledger.records.filter((r) => r.type === 'quarantine').length}.`);
  } else lines.push(`**Ledger failed verification: ${s.ledger.code}** (${s.ledger.detail}). Every payment is blocked.`);
  lines.push('', '## Memories', '', '| Lane · kind | Count |', '| --- | --- |', ...[...byLane].sort().map(([k, v]) => `| ${k} | ${v} |`), '');
  lines.push('<details><summary>Every memory blob</summary>', '', '| Memory | Lane · kind | Class | Blob |', '| --- | --- | --- | --- |');
  for (const n of memories) lines.push(`| \`${n.id}\` | ${n.lane} · ${n.kind} | ${n.cls}${n.quarantined ? ' (quarantined)' : ''} | ${blobLink(n.blobIds[0]!, net)} |`);
  lines.push('', '</details>', '', '## Payments (executed through the signer)', '');
  const paid = o.payments.filter((p) => p.digest);
  if (paid.length) {
    lines.push('| Status | Amount (base units) | Recipient | Transaction |', '| --- | --- | --- | --- |');
    for (const p of paid) lines.push(`| ${p.status} | ${p.amount} ${p.coinType.split('::').pop()} | ${addrLink(p.recipient, net)} | ${txLink(p.digest!, net)} |`);
  } else lines.push('None yet.');
  lines.push('', '## Incident reports (Tatum Storage API → Walrus)', '');
  if (s.reports.length) for (const r of s.reports) lines.push(`- ledger #${r.seq}: ${r.simulated ? '(simulated) ' : ''}[${r.url}](${r.url})`);
  else lines.push('None yet: `antibody report <quarantine seq>`.');
  lines.push('', '## Restore', '', `Projection digest \`${s.digest}\`. A fresh process (\`antibody rebuild --fresh\`) must print the same digest from Walrus and Sui alone.`, '');
  return lines.join('\n');
}
