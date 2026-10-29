/**
 * Ingest worker + sentinel (spec §9, FR-03, FR-13). Holds the wallet-objects
 * key and the Tatum key. Every new coin type or object in Steward's wallet is
 * written through the wallet-objects lane before anything else sees it, then
 * scored against heuristics, the Sui Guardians lists and the lessons learned
 * from earlier quarantines. Scores at or above the threshold raise incidents.
 */
import { join } from 'node:path';
import { buildEnvelope } from '../core/envelope.ts';
import { normalizeCoinType, uuidv7 } from '../core/encoding.ts';
import type { LaneKey } from '../core/keys.ts';
import type { LessonEntry } from '../core/ledger.ts';
import { matchLessons, type LessonMatch } from '../core/lessons.ts';
import { formatUnits } from '../core/units.ts';
import { NS_CONTENT, type SrcRef } from '../core/types.ts';
import type { ChainReader, OwnedObject } from '../adapters/chain.ts';
import { JsonFileStore } from '../adapters/filestore.ts';
import type { MemoryClient } from '../adapters/memory.ts';
import type { Incident } from '../control/store.ts';
import type { Logger } from '../log.ts';
import { blocklisted, type GuardianLists } from './guardians.ts';
import { scoreText } from './heuristics.ts';

/** How ingest reaches control: lessons in, incidents out. */
export interface SentinelSink {
  lessons(): Promise<LessonEntry[]>;
  incident(i: Omit<Incident, 'id' | 'at' | 'status'>): Promise<Incident>;
}

export interface IngestDeps {
  acct: string;
  wallet: string;
  chain: ChainReader;
  mem: MemoryClient;
  key: LaneKey;
  sink: SentinelSink | null;
  guardians: GuardianLists;
  log: Logger;
  cacheDir: string;
  threshold: number;
  now?: () => number;
}

export interface ScanItem {
  objectId: string;
  observationId: string;
  blobId: string;
  kind: 'coin' | 'object';
  type: string;
  sender: string | null;
  score: number;
  rules: string[];
  lessonMatches: LessonMatch[];
  blocklisted: boolean;
  incident: Incident | null;
}

export interface ScanResult {
  items: ScanItem[];
  skipped: number;
  checkpoint: number;
}

const COIN_RE = /^0x0*2::coin::Coin<(.+)>$/;

/** Description, name and display text of a non-coin object, verbatim. */
function objectText(o: OwnedObject): { name: string; description: string; extra: string } {
  const j = o.json ?? {};
  const pick = (k: string) => (typeof j[k] === 'string' ? (j[k] as string) : '');
  return { name: pick('name'), description: pick('description'), extra: [pick('url'), pick('image_url'), pick('link')].filter(Boolean).join(' ') };
}

export async function scanWallet(d: IngestDeps): Promise<ScanResult> {
  const now = d.now ?? Date.now;
  const seen = new JsonFileStore<Record<string, string>>(join(d.cacheDir, 'ingest-seen.json'), () => ({}));
  const [objects, ckpt, lessons] = await Promise.all([d.chain.listOwnedObjects(d.wallet), d.chain.latestCheckpoint(), d.sink ? d.sink.lessons() : Promise.resolve([] as LessonEntry[])]);
  const items: ScanItem[] = [];
  let skipped = 0;

  for (const o of objects) {
    const coinMatch = COIN_RE.exec(o.type);
    const coinType = coinMatch ? normalizeCoinType(coinMatch[1]!) : null;
    // Coins are observed once per coin type (the metadata is the carrier);
    // every other object is observed once per object.
    const key = coinType ? `coin:${coinType}` : `object:${o.objectId}`;
    if (seen.read()[key] || (await alreadyObserved(d.mem, o.objectId, coinType))) {
      skipped++;
      continue;
    }

    const sender = o.previousTransaction ? ((await d.chain.getTransaction(o.previousTransaction))?.sender ?? null) : null;
    const src: SrcRef[] = [{ t: 'sui-object', id: o.objectId, ver: o.version, type: coinType ?? o.type }];
    if (coinType) src.push({ t: 'coin-type', type: coinType });
    if (sender) src.push({ t: 'sender', addr: sender });
    if (o.previousTransaction) src.push({ t: 'tx', digest: o.previousTransaction });

    let text: string;
    let scoredText: string;
    if (coinType) {
      const meta = await d.chain.getCoinMetadata(coinType);
      const bal = typeof o.json?.balance === 'string' && meta ? formatUnits(o.json.balance, meta.decimals) : String(o.json?.balance ?? '?');
      text = [
        `Observed in Steward wallet ${d.wallet}: coin object ${o.objectId} of type ${coinType}.`,
        `Coin name: ${JSON.stringify(meta?.name ?? '')} · symbol: ${JSON.stringify(meta?.symbol ?? '')} · amount: ${bal}`,
        sender ? `Sent by ${sender} in transaction ${o.previousTransaction}.` : 'Sender unknown.',
        `Coin description (verbatim, external): ${JSON.stringify(meta?.description ?? '')}`,
      ].join('\n');
      scoredText = `${meta?.name ?? ''}\n${meta?.symbol ?? ''}\n${meta?.description ?? ''}`;
    } else {
      const t = objectText(o);
      text = [
        `Observed in Steward wallet ${d.wallet}: object ${o.objectId} of type ${o.type}.`,
        sender ? `Sent by ${sender} in transaction ${o.previousTransaction}.` : 'Sender unknown.',
        `Display name (verbatim, external): ${JSON.stringify(t.name)}`,
        `Description (verbatim, external): ${JSON.stringify(t.description)}`,
        ...(t.extra ? [`Links (external): ${JSON.stringify(t.extra)}`] : []),
      ].join('\n');
      scoredText = `${t.name}\n${t.description}`;
    }

    const id = uuidv7(now());
    const env = buildEnvelope({ id, acct: d.acct, ns: NS_CONTENT, lane: 'wallet-objects', kind: 'observation', src, ckpt, ts: new Date(now()).toISOString(), text: text.slice(0, 7000) }, d.key);
    const { blobId } = await d.mem.remember(env.text, NS_CONTENT, id);
    seen.update((s) => {
      s[key] = id;
    });

    const h = scoreText(scoredText);
    const lm = matchLessons({ ...(sender ? { sender } : {}), ...(coinType ? { coinType } : {}), objectType: o.type, text: scoredText }, lessons);
    const isBlocked = blocklisted(d.guardians, coinType ?? o.type);
    const score = isBlocked ? 1 : 1 - (1 - h.score) * (1 - lm.score);
    const rules = [...h.hits.map((x) => `${x.rule}:${x.match}`), ...(isBlocked ? ['guardians-blocklist'] : []), ...lm.matches.map((m) => `lesson#${m.lessonSeq}:${m.indicator}`)];
    let incident: Incident | null = null;
    if (score >= d.threshold && d.sink) {
      incident = await d.sink.incident({
        objectId: o.objectId,
        observationId: id,
        ...(coinType ? { coinType } : {}),
        ...(sender ? { sender } : {}),
        score: Math.round(score * 1000) / 1000,
        rules,
        lessonMatches: lm.matches.map((m) => ({ lessonSeq: m.lessonSeq, indicator: m.indicator, value: m.value })),
        blocklisted: isBlocked,
        proposedSeed: { type: 'source', value: o.objectId },
      });
    }
    d.log.info('ingest.observation', { envelopeId: id, blobId, objectId: o.objectId, type: coinType ?? o.type, sender, score, rules, incident: incident?.id ?? null });
    items.push({ objectId: o.objectId, observationId: id, blobId, kind: coinType ? 'coin' : 'object', type: coinType ?? o.type, sender, score, rules, lessonMatches: lm.matches, blocklisted: isBlocked, incident });
  }
  return { items, skipped, checkpoint: ckpt };
}

/** After a cache wipe, ask the relayer whether this object was already written. */
async function alreadyObserved(mem: MemoryClient, objectId: string, coinType: string | null): Promise<boolean> {
  const hits = await mem.recall(coinType ?? objectId, NS_CONTENT, 20);
  const needle = coinType ? `of type ${coinType}.` : `object ${objectId} `;
  return hits.some((h) => h.text.includes('[lane:wallet-objects kind:observation') && h.text.includes(needle));
}

/**
 * Text the human pasted from outside (an email, a chat message). It is
 * external content, so it enters through the wallet-objects lane as an
 * untrusted observation, never as a user statement.
 */
export async function ingestExternalText(d: IngestDeps, text: string, origin: string): Promise<ScanItem> {
  const now = d.now ?? Date.now;
  const ckpt = await d.chain.latestCheckpoint();
  const lessons = d.sink ? await d.sink.lessons() : [];
  const id = uuidv7(now());
  const src: SrcRef[] = [{ t: 'url', id: origin }];
  const body = [`External text pasted by the user (origin: ${origin}). Verbatim, external:`, JSON.stringify(text.slice(0, 6000))].join('\n');
  const env = buildEnvelope({ id, acct: d.acct, ns: NS_CONTENT, lane: 'wallet-objects', kind: 'observation', src, ckpt, ts: new Date(now()).toISOString(), text: body }, d.key);
  const { blobId } = await d.mem.remember(env.text, NS_CONTENT, id);
  const h = scoreText(text);
  const lm = matchLessons({ text }, lessons);
  const score = 1 - (1 - h.score) * (1 - lm.score);
  const rules = [...h.hits.map((x) => `${x.rule}:${x.match}`), ...lm.matches.map((m) => `lesson#${m.lessonSeq}:${m.indicator}`)];
  let incident: Incident | null = null;
  if (score >= d.threshold && d.sink) {
    incident = await d.sink.incident({ objectId: origin, observationId: id, score: Math.round(score * 1000) / 1000, rules, lessonMatches: lm.matches.map((m) => ({ lessonSeq: m.lessonSeq, indicator: m.indicator, value: m.value })), blocklisted: false, proposedSeed: { type: 'source', value: origin } });
  }
  d.log.info('ingest.external_text', { envelopeId: id, blobId, origin, score });
  return { objectId: origin, observationId: id, blobId, kind: 'object', type: 'external-text', sender: null, score, rules, lessonMatches: lm.matches, blocklisted: false, incident };
}
