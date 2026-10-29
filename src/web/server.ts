/**
 * Web view (FR-16, M3): lanes panel, blast-radius graph, split screen against
 * the unprotected agent, quarantine and revoke, both digests. Served by the
 * control process on 127.0.0.1 only; state-changing calls require the
 * x-antibody-ui header so a cross-site form post cannot trigger them.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { bodyContent } from '../core/envelope.ts';
import { contextEligible } from '../core/projection.ts';
import { LANE_LABEL, type QuarantineSeed } from '../core/types.ts';
import type { Control } from '../control/control.ts';
import { IpcClient, unixTransport } from '../ipc.ts';
import type { Runtime } from '../runtime.ts';
import { createModel } from '../services.ts';
import { runUnprotectedTurn } from '../steward/unprotected.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STATIC: Record<string, [string, string]> = {
  '/': ['web/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['web/app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['web/styles.css', 'text/css; charset=utf-8'],
};

const pexec = promisify(execFile);

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

export async function stateJson(rt: Runtime, control: Control) {
  const snap = await control.snapshot();
  const p = snap.projection;
  const ledger = snap.ledger;
  const nodes = p.lineage.order.map((id) => {
    const n = p.lineage.nodes.get(id)!;
    const h = n.env.header;
    return {
      id,
      lane: h.lane,
      kind: h.kind,
      cls: n.cls,
      quarantined: n.quarantined,
      unresolved: n.unresolved,
      eligible: contextEligible(n),
      seedHits: n.seedHits,
      parents: h.parents,
      src: h.src,
      turn: h.turn,
      ckpt: h.ckpt,
      blobIds: n.blobIds,
      text: bodyContent(n.env.body),
      notes: n.notes,
    };
  });
  return {
    simulated: rt.simulated,
    banners: rt.banners,
    backend: rt.cfg.backend,
    chain: rt.chain.kind,
    account: { id: snap.account.accountId, owner: snap.account.owner, active: snap.account.active },
    wallet: rt.cfg.stewardWallet,
    checkpoint: snap.ckpt,
    lanes: (p.bindings?.all() ?? []).map((b) => ({ ...b, label: LANE_LABEL[b.lane] })),
    ledger: ledger.ok
      ? {
          ok: true,
          head: ledger.head,
          firstSync: ledger.firstSync,
          payees: ledger.payees,
          quarantines: ledger.quarantines,
          lessons: ledger.lessons,
          revocations: ledger.revocations,
          rotations: ledger.rotations,
          records: ledger.records.map((r) => ({ seq: r.record.seq, type: r.record.type, lane: r.env.header.lane, blobId: r.blobIds[0], envelopeId: r.env.header.id, payload: r.record.payload })),
        }
      : { ok: false, code: ledger.code, detail: ledger.detail },
    nodes,
    failed: p.lineage.forensic,
    digest: p.digest,
    coverage: p.coverage,
    incidents: control.incidents.list().slice(-20).reverse(),
  };
}

export function startWeb(rt: Runtime, control: Control, port: number): Promise<Server> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    };
    try {
      const st = STATIC[url.pathname];
      if (req.method === 'GET' && st) {
        res.writeHead(200, { 'content-type': st[1], 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" });
        res.end(readFileSync(join(ROOT, st[0])));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return send(200, await stateJson(rt, control));
      if (req.method === 'GET' && url.pathname === '/api/blast') {
        const r = await control.blast(Number(url.searchParams.get('seq')));
        return send(200, { seq: r.seedSeq, sources: r.sources, memories: r.memories.map((m) => m.id), decisions: r.decisions.map((m) => m.id), txDigests: r.txDigests, edges: r.edges });
      }
      if (req.method !== 'POST') return send(404, { error: 'not found' });
      if (req.headers['x-antibody-ui'] !== '1') return send(403, { error: 'missing x-antibody-ui header' });
      const body = (await readBody(req)) as Record<string, unknown>;

      if (url.pathname === '/api/quarantine') {
        const seed: QuarantineSeed = { type: body.type as QuarantineSeed['type'], value: String(body.value) };
        const q = await control.quarantine(seed, String(body.reason ?? 'quarantined from the web view'), [seed.value], false);
        return send(200, { seq: q.seq, lessonSeq: q.lessonSeq, memories: q.radius.memories.length, decisions: q.radius.decisions.length });
      }
      if (url.pathname === '/api/preview') {
        const pv = await control.preview({ type: body.type as QuarantineSeed['type'], value: String(body.value) });
        return send(200, { memories: pv.memories, decisions: pv.decisions, txDigests: pv.txDigests, ids: pv.radius.memories.map((m) => m.id) });
      }
      if (url.pathname === '/api/run') {
        const instruction = String(body.instruction ?? '');
        const execute = body.execute === true;
        // Protected: the agent daemon runs the real Steward turn (agent key + LLM key live there).
        const agent = new IpcClient(control.d.key, unixTransport(join(rt.cfg.home, 'run', 'agent.sock'), 300_000));
        const [prot, unprot] = await Promise.allSettled([
          agent.call('/turn', { instruction, execute }),
          runUnprotectedTurn({ mem: control.d.mem, chain: rt.chain, wallet: rt.cfg.stewardWallet ?? '', model: createModel(rt.cfg) }, instruction),
        ]);
        return send(200, {
          protected: prot.status === 'fulfilled' ? prot.value : { error: (prot.reason as Error).message },
          unprotected: unprot.status === 'fulfilled' ? unprot.value : { error: (unprot.reason as Error).message },
        });
      }
      if (url.pathname === '/api/rebuild') {
        // A fresh process with an empty cache, reading only Walrus and Sui.
        const { stdout } = await pexec(process.execPath, [join(ROOT, 'bin', 'antibody.mjs'), 'rebuild', '--fresh', '--json'], { env: { ...process.env, ANTIBODY_ROLE: 'control', NO_COLOR: '1' }, timeout: 300_000 });
        const line = stdout.trim().split('\n').filter((l) => l.startsWith('{')).at(-1);
        return send(200, line ? JSON.parse(line) : { error: stdout });
      }
      if (url.pathname === '/api/report') {
        const r = await control.report(Number(body.seq));
        return send(200, r.upload);
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(500, { error: (e as Error).message });
    }
  });
  return new Promise((resolveP) => server.listen(port, '127.0.0.1', () => resolveP(server)));
}
