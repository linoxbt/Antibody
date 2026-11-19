// The stdio server, driven by a real MCP client: tools are listed and answer from the API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const api = process.env.GUARD_API ?? 'https://antibody-guard-reactive.netlify.app';

async function connect(env: Record<string, string> = {}) {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/index.ts'], env: { ...process.env, GUARD_API: api, ...env } as Record<string, string> }));
  return client;
}
const textOf = (r: any) => r.content[0].text as string;

test('lists the read tools; action tools only with keys', async () => {
  const c = await connect();
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['guard_attacker_details', 'guard_audit_source', 'guard_check_address', 'guard_list_attackers', 'guard_list_memories', 'guard_list_vaults', 'guard_recall_memory', 'guard_recent_decisions', 'guard_score_message', 'guard_status']);
  await c.close();
});

test('check, recall and audit answer from the live deployment', async () => {
  const c = await connect();
  const bad = JSON.parse(textOf(await c.callTool({ name: 'guard_check_address', arguments: { address: '0x00000000000000000000000000000000bad3e301' } })));
  assert.equal(bad.knownAttacker, true);
  const mem = '0xd4638e87d66e2543f305b5189318506c562e5ef6';
  const planted = JSON.parse(textOf(await c.callTool({ name: 'guard_recall_memory', arguments: { chain: 'baseSepolia', memory: mem, id: 2 } })));
  assert.equal(planted.usable, false);
  assert.equal(planted.status, 'quarantined-source');
  const audit = JSON.parse(textOf(await c.callTool({ name: 'guard_audit_source', arguments: { chain: 'baseSepolia', memory: mem, source: '0x00000000000000000000000000000000bad3e301' } })));
  assert.deepEqual(audit.entries, [2]);
  const status = JSON.parse(textOf(await c.callTool({ name: 'guard_status', arguments: {} })));
  assert.ok(status.counts.lessons >= 9);
  await c.close();
});

test('bad input is an error result, not a crash', async () => {
  const c = await connect();
  const r: any = await c.callTool({ name: 'guard_recall_memory', arguments: { chain: 'baseSepolia', memory: '0xd4638e87d66e2543f305b5189318506c562e5ef6', id: 999 } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /no entry 999/);
  await c.close();
});
