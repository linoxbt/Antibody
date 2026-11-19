// Command-line client for Reactive MCP (https://mcp.rnk.dev/mcp: public, read-only, no key):
//   npx tsx scripts/rmcp.ts tools                 list the tools
//   npx tsx scripts/rmcp.ts <tool> '<json args>'   call one, e.g. get_rc_health '{"address":"0x…"}'
// The same server is configured for Claude Code in the repository's .mcp.json.
const URL = process.env.REACTIVE_MCP_URL ?? 'https://mcp.rnk.dev/mcp';
let id = 0;

export async function rpc(method: string, params: unknown = {}): Promise<any> {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const text = await res.text();
  const json = text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join(''));
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, args] = process.argv.slice(2);
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'antibody-guard', version: '1' } });
  if (!cmd || cmd === 'tools') {
    const { tools } = await rpc('tools/list');
    for (const t of tools) console.log(`${t.name}: ${String(t.description).split('\n')[0].slice(0, 140)}\n    args: ${Object.keys(t.inputSchema?.properties ?? {}).join(', ')}`);
  } else {
    const r = await rpc('tools/call', { name: cmd, arguments: args ? JSON.parse(args) : {} });
    for (const c of r.content ?? []) console.log(c.type === 'text' ? c.text : JSON.stringify(c));
  }
}
