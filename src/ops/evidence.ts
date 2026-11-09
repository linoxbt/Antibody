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
  /** offline = fixture chain + local relayer: nothing on-chain. Other SIMULATED labels (key isolation) do not make evidence simulated. */
  backend: 'live' | 'offline';
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
  /** M3: the digest a fresh process rebuilt from Walrus and Sui alone (empty cache), when it was run. */
  rebuild?: { digest: string; memories: number; queries: number; ms: number; at: string };
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

/** The live demo attack (scripts/mainnet/attack.ts): public identifiers only, never the attacker key. */
export interface AttackEvidence {
  attacker: string;
  packageId?: string;
  publishDigest?: string;
  sent?: { coin: string; digest: string }[];
}

export function loadAttackEvidence(home: string): AttackEvidence | null {
  const p = join(home, 'attack.json');
  if (!existsSync(p)) return null;
  const a = JSON.parse(readFileSync(p, 'utf8')) as AttackEvidence & { attackerSecret?: string };
  return { attacker: a.attacker, ...(a.packageId ? { packageId: a.packageId } : {}), ...(a.publishDigest ? { publishDigest: a.publishDigest } : {}), ...(a.sent ? { sent: a.sent } : {}) };
}

export function renderEvidence(s: EvidenceState, o: { setup: SetupEvidence | null; payments: EvidencePayment[]; generatedAt: string; tatumHost: string; attack?: AttackEvidence | null }): string {
  const net = s.network ?? 'mainnet';
  const memories = s.nodes.filter((n) => n.blobIds.length);
  const ledgerBlobs = s.ledger.ok ? s.ledger.records.filter((r) => r.blobId) : [];
  const total = memories.length + ledgerBlobs.length;
  const byLane = new Map<string, number>();
  for (const n of memories) byLane.set(`${n.lane} · ${n.kind}`, (byLane.get(`${n.lane} · ${n.kind}`) ?? 0) + 1);
  const agent = s.lanes.find((l) => l.lane === 'agent' && l.status === 'active');
  const lines: string[] = [
    `# Antibody · ${s.backend === 'offline' ? 'SIMULATED evidence (offline backend, nothing on-chain)' : `${net} evidence`}`,
    '',
    `Generated ${o.generatedAt} by \`antibody evidence\`. ${s.backend === 'offline' ? 'Fixture chain' : `Chain reads via ${s.chain} (${o.tatumHost})`}, checkpoint ${s.checkpoint}.`,
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
      return `| \`${l.label}\` | \`${l.pub}\` | ${l.status} | ${d && d !== 'already-registered' ? txLink(d, net) : 'on-chain (see the account)'} |`;
    }),
  ];
  if (o.setup?.createdAccount) lines.push('', `Account created by ${txLink(o.setup.createdAccount.digest, net)}.`);
  if (o.setup) lines.push('', `Genesis ledger record: ${blobLink(o.setup.genesis.blobId, net)}.`);
  if (o.attack) {
    lines.push('', '## The attack (live, from a separate wallet)', '', `Attacker ${addrLink(o.attack.attacker, net)}${o.attack.packageId ? ` published package ${objLink(o.attack.packageId, net)}` : ''}${o.attack.publishDigest ? ` in ${txLink(o.attack.publishDigest, net)}` : ''}.`, '');
    for (const x of o.attack.sent ?? []) lines.push(`- sent \`${x.coin.split('::').slice(1).join('::')}\` to Steward: ${txLink(x.digest, net)}`);
  }
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
  lines.push('', '</details>', '', '## Payments (signed by Steward\'s signer, confirmed on-chain)', '');
  const paid = o.payments.filter((p) => p.digest);
  if (paid.length) {
    lines.push('| Status | Amount (base units) | Recipient | Transaction |', '| --- | --- | --- | --- |');
    for (const p of paid) lines.push(`| ${p.status} | ${p.amount} ${p.coinType.split('::').pop()} | ${addrLink(p.recipient, net)} | ${txLink(p.digest!, net)} |`);
  } else lines.push('None yet.');
  lines.push('', '## Incident reports (Tatum Storage API → Walrus)', '');
  // The latest readable upload per quarantine (earlier uploads linked the bare quilt, which is not the JSON file).
  const latest = new Map<number, (typeof s.reports)[number]>();
  for (const r of s.reports) if (/^https:\/\//.test(r.url) || r.simulated) latest.set(r.seq, r);
  for (const r of latest.values()) lines.push(`- ledger #${r.seq}: ${r.simulated ? '(simulated) ' : ''}[${r.url}](${r.url})`);
  if (latest.size === 0) lines.push('None yet: `antibody report <quarantine seq>`.');
  lines.push('', '## Restore', '', `Projection digest (this machine, with its cache): \`${s.digest}\``);
  if (s.rebuild) {
    const same = s.rebuild.digest === s.digest;
    lines.push(
      `Projection digest (fresh rebuild, empty cache, Walrus and Sui alone, ${s.rebuild.at}): \`${s.rebuild.digest}\``,
      '',
      same ? `**Match.** The fresh rebuild read ${s.rebuild.memories} memories in ${s.rebuild.queries} recall queries (${(s.rebuild.ms / 1000).toFixed(1)} s) and reached the same state.` : '**MISMATCH**: the fresh rebuild disagrees with this machine. Investigate before trusting either.',
      '',
    );
  } else lines.push('', 'A fresh process (`antibody rebuild --fresh`) must print the same digest from Walrus and Sui alone.', '');
  return lines.join('\n');
}
