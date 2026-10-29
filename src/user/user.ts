/**
 * The human CLI / UI role (spec §3): holds the user key. Payee changes,
 * human statements and quarantine releases are signed here, by a
 * deterministic human action, never by a model tool call (I-4).
 */
import { buildEnvelope } from '../core/envelope.ts';
import { uuidv7 } from '../core/encoding.ts';
import type { LaneKey } from '../core/keys.ts';
import { ledgerBodyText, type LedgerPayload, type LedgerRecord, type LedgerType } from '../core/ledger.ts';
import { NS_CONTENT, NS_LEDGER } from '../core/types.ts';
import type { MemoryClient } from '../adapters/memory.ts';
import type { IpcClient } from '../ipc.ts';

export interface Head {
  seq: number;
  prev: string;
  ckpt: number;
  acct: string;
}

export function signUserRecord<T extends 'payee.add' | 'payee.remove' | 'quarantine.release'>(key: LaneKey, head: Head, type: T, payload: LedgerPayload<T>, now: number): string {
  const record = { seq: head.seq, prev: head.prev, type, payload } as LedgerRecord<LedgerType>;
  return buildEnvelope({ id: uuidv7(now), acct: head.acct, ns: NS_LEDGER, lane: 'user', kind: 'ledger', ckpt: head.ckpt, ts: new Date(now).toISOString(), text: ledgerBodyText(record) }, key).text;
}

/** Ask control for the head, sign, submit; retry once if another record landed first. */
export async function submitUserRecord<T extends 'payee.add' | 'payee.remove' | 'quarantine.release'>(control: IpcClient, key: LaneKey, type: T, payload: LedgerPayload<T>, now: () => number = Date.now) {
  for (let attempt = 0; ; attempt++) {
    const head = await control.call<Head>('/ledger/head');
    try {
      return await control.call<{ seq: number; blobId: string; envelopeId: string }>('/ledger/append', { text: signUserRecord(key, head, type, payload, now()) });
    } catch (e) {
      if (attempt < 2 && /stale head/.test((e as Error).message)) continue;
      throw e;
    }
  }
}

/** A trusted statement typed by the human (user lane, no parents → trusted). */
export async function writeStatement(mem: MemoryClient, key: LaneKey, acct: string, ckpt: number, text: string, now: () => number = Date.now) {
  const id = uuidv7(now());
  const env = buildEnvelope({ id, acct, ns: NS_CONTENT, lane: 'user', kind: 'statement', src: [{ t: 'user-msg', id }], ckpt, ts: new Date(now()).toISOString(), text }, key);
  const { blobId } = await mem.remember(env.text, NS_CONTENT, id);
  return { id, blobId };
}
