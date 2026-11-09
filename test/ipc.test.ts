// S13: IPC authentication edges — concurrent replay, restarts, body size, and who may answer.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createIpcHandler, IpcClient, MAX_IPC_BODY, type IpcRequest, type Transport } from '../src/ipc.ts';
import { generateSeedHex, laneKeyFromSeedHex } from '../src/core/keys.ts';

const caller = laneKeyFromSeedHex(generateSeedHex());
const server = laneKeyFromSeedHex(generateSeedHex());
const impostor = laneKeyFromSeedHex(generateSeedHex());
const routes = { '/x': { lanes: ['agent' as const], handler: async () => { await new Promise((r) => setTimeout(r, 20)); return { ok: true }; } } };
const laneOf = async (pub: string) => (pub === caller.publicKeyHex ? ('agent' as const) : undefined);

test('three concurrent copies of one signed request: only one runs', async () => {
  let captured: IpcRequest | null = null;
  const handler = createIpcHandler(routes, async (p) => (await new Promise((r) => setTimeout(r, 10)), laneOf(p)));
  const spy: Transport = async (req) => ((captured = req), handler(req));
  await new IpcClient(caller, spy).call('/x');
  const replays = await Promise.all([1, 2, 3].map(() => handler(captured!)));
  assert.deepEqual(replays.map((r) => r.status), [401, 401, 401], 'the original already used the nonce');
  // Fresh request replayed concurrently.
  let fresh: IpcRequest | null = null;
  const h2 = createIpcHandler(routes, async (p) => (await new Promise((r) => setTimeout(r, 10)), laneOf(p)));
  await new IpcClient(caller, async (req) => ((fresh = req), { status: 200, body: 'null' })).call('/x');
  const all = await Promise.all([1, 2, 3].map(() => h2(fresh!)));
  assert.equal(all.filter((r) => r.status === 200).length, 1);
});

test('a request signed before the daemon started is refused (no replay across a restart)', async () => {
  let t = 1_000_000;
  const client = new IpcClient(caller, async (req) => createIpcHandler(routes, laneOf, () => t + 10_000)(req), () => t);
  await assert.rejects(client.call('/x'), /predates this daemon/);
});

test('bodies over the limit are refused', async () => {
  const h = createIpcHandler(routes, laneOf);
  const r = await h({ path: '/x', body: 'x'.repeat(MAX_IPC_BODY + 1), headers: {} });
  assert.equal(r.status, 413);
});

test('responses must be signed by the expected daemon key', async () => {
  const good = createIpcHandler(routes, laneOf, Date.now, server);
  const bad = createIpcHandler(routes, laneOf, Date.now, impostor);
  const unsigned = createIpcHandler(routes, laneOf);
  const expect = (pub: string) => pub === server.publicKeyHex;
  assert.deepEqual(await new IpcClient(caller, good, Date.now, expect).call('/x'), { ok: true });
  await assert.rejects(new IpcClient(caller, bad, Date.now, expect).call('/x'), /not signed by the expected daemon/);
  await assert.rejects(new IpcClient(caller, unsigned, Date.now, expect).call('/x'), /not signed by the expected daemon/);
});

test('B7: an IPC timeout is reported as a timeout, never as "cannot reach" (which would trigger a second write)', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createServer } = await import('node:http');
  const { unixTransport } = await import('../src/ipc.ts');
  const sock = join(mkdtempSync(join(tmpdir(), 'ab-ipc-')), 's.sock');
  const server = createServer(() => undefined); // never answers
  await new Promise<void>((r) => server.listen(sock, r));
  try {
    await assert.rejects(unixTransport(sock, 200)({ path: '/x', body: '{}', headers: {} }), (e: Error) => /timeout/.test(e.message) && !/cannot reach/.test(e.message));
    await assert.rejects(unixTransport(sock + '.missing', 200)({ path: '/x', body: '{}', headers: {} }), /cannot reach/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
