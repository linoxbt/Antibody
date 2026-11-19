// Agent activity: every call agents and people make to the Guard service (the API, the hosted MCP endpoint,
// the site's scorer and watch form), kept in memory and shown on the console's Activity page.
//
// What is public: the time, which kind of client, the tool, what it asked about (an address, a memory entry)
// and the answer. What is never recorded: the text of scored messages (sender, subject, body), IP addresses,
// keys. The console's own reads are not recorded.
import type { IncomingMessage } from 'node:http';

export interface ActivityEntry {
  id: number;
  at: string;              // ISO time
  via: 'mcp' | 'mcp-local' | 'api' | 'sdk' | 'site';
  client: string;          // e.g. Claude, Cursor, curl, Browser
  tool: string;            // the MCP tool name, or the API route
  subject?: { kind: 'address' | 'memory' | 'contract'; chain?: string; address: string; id?: number; source?: string };
  result: string;          // one short line: "block", "usable", "score 95 · reported"
  tone: 'ok' | 'bad' | 'warn' | 'plain';
  tx?: { chain: string; hash: string };
  error?: string;
}

const MAX = 300;

/** A friendly name for the client, from what it sends. Never the IP. */
export function clientOf(req: IncomingMessage): string {
  const told = String(req.headers['x-guard-client'] ?? '').trim();
  if (told) return told.slice(0, 40);
  const ua = String(req.headers['user-agent'] ?? '');
  if (/Claude-User/i.test(ua)) return 'Claude';
  if (/claude-code|ClaudeCode/i.test(ua)) return 'Claude Code';
  if (/Cursor/i.test(ua)) return 'Cursor';
  if (/python-httpx|python-requests|aiohttp/i.test(ua)) return 'Python client';
  if (/curl\//i.test(ua)) return 'curl';
  if (/Mozilla\//.test(ua)) return 'Browser';
  if (/node|undici/i.test(ua)) return 'Node.js';
  return ua ? ua.split(/[ /]/)[0]!.slice(0, 24) : 'Unknown';
}

/** How the call arrived: the hosted MCP endpoint and the npm MCP server say so in headers. */
export function viaOf(req: IncomingMessage, fallback: ActivityEntry['via']): ActivityEntry['via'] {
  const v = String(req.headers['x-guard-via'] ?? '').trim();
  return (['mcp', 'mcp-local', 'api', 'sdk', 'site'] as const).find((x) => x === v) ?? fallback;
}

/** The console itself reading data is not activity. */
export const isConsole = (req: IncomingMessage) => String(req.headers['x-guard-client'] ?? '') === 'console';

export class ActivityLog {
  private entries: ActivityEntry[] = [];
  private next = 1;

  record(e: Omit<ActivityEntry, 'id' | 'at'>) {
    this.entries.push({ id: this.next++, at: new Date().toISOString(), ...e });
    if (this.entries.length > MAX) this.entries.splice(0, this.entries.length - MAX);
  }

  recent(limit = 50): ActivityEntry[] {
    return this.entries.slice(-Math.min(Math.max(limit, 1), MAX)).reverse();
  }

  counts() {
    const by = (k: keyof ActivityEntry) => this.entries.reduce<Record<string, number>>((a, e) => ((a[String(e[k])] = (a[String(e[k])] ?? 0) + 1), a), {});
    return { total: this.entries.length, byVia: by('via'), byClient: by('client') };
  }
}

export const activity = new ActivityLog();
