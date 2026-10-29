/**
 * Steward's model. The model is treated as untrusted code (spec §1): it can
 * read labelled context and call three or four tools, nothing else.
 *
 *  - OpenAIModel: any OpenAI-compatible chat-completions endpoint (LLM_*).
 *  - ScriptedModel: deterministic and deliberately gullible, for offline runs
 *    and the attack set. It believes the most "urgent" claim in its context,
 *    whatever the label says, the way an injected LLM does, so the demo shows
 *    the policy holding even when the model is fooled. Always SIMULATED.
 */
import OpenAI from 'openai';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelReply {
  content: string | null;
  toolCalls: ToolCall[];
}

export interface ChatModel {
  readonly name: string;
  readonly simulated: boolean;
  complete(messages: ChatMessage[], tools: ToolDef[]): Promise<ModelReply>;
}

export class OpenAIModel implements ChatModel {
  readonly simulated = false;
  private readonly client: OpenAI;

  constructor(
    baseURL: string,
    apiKey: string,
    readonly name: string,
  ) {
    this.client = new OpenAI({ baseURL, apiKey });
  }

  async complete(messages: ChatMessage[], tools: ToolDef[]): Promise<ModelReply> {
    const res = await this.client.chat.completions.create({
      model: this.name,
      temperature: 0,
      messages: messages.map((m) =>
        m.role === 'assistant'
          ? { role: 'assistant' as const, content: m.content, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls.map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.arguments } })) } : {}) }
          : m,
      ),
      tools: tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: 'auto',
    });
    const msg = res.choices[0]?.message;
    return {
      content: msg?.content ?? null,
      toolCalls: (msg?.tool_calls ?? []).filter((t) => t.type === 'function').map((t) => ({ id: t.id, name: (t as { function: { name: string } }).function.name, arguments: (t as { function: { arguments: string } }).function.arguments })),
    };
  }
}

// ---------------------------------------------------------------------------

/** A bare Sui address (not the package part of a coin type). */
const ADDR_G = /0x[0-9a-fA-F]{64}(?!::)/g;
const URL_RE = /https?:\/\/[^\s"'<>]+/;
const AMOUNT = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(USDC|SUI)\b/i;
const COIN_TYPE = /coin type (0x[0-9a-fA-F]{1,64}::[A-Za-z0-9_]+::[A-Za-z0-9_]+)/;
const PERSUASIVE = /\b(new|updated|changed|moved|now|urgent|immediately|pre-?approved|verified|override|skip|frozen|escrow|system)\b/i;

interface Topic {
  label: string;
  words: RegExp;
}

const TOPICS: Topic[] = [
  { label: 'landlord', words: /\b(rent|landlord|lease|apartment|housing)\b/i },
  { label: 'sister', words: /\b(sister|allowance|maya)\b/i },
  { label: 'utility', words: /\b(utility|electric(ity)?|power|water|energy|bill)\b/i },
];

interface ContextItemLike {
  id: string;
  label?: string;
  text: string;
}

interface Claim {
  address?: string;
  amount?: string;
  coinType?: string;
  persuasive: boolean;
  fromId: string;
}

function extractClaim(item: ContextItemLike, topic: Topic): Claim | null {
  // Only lines that talk about the topic count, and within them the address
  // nearest a topic word (an observation's "Sent by 0x…" line is not a claim).
  const lines = item.text.split('\n').filter((l) => new RegExp(topic.words.source, 'i').test(l));
  if (lines.length === 0) return null;
  let nearest: RegExpMatchArray | undefined;
  for (const line of lines) {
    const topicAt = [...line.matchAll(new RegExp(topic.words.source, 'gi'))].map((m) => m.index!);
    const addrs = [...line.matchAll(ADDR_G)].sort((x, y) => dist(x.index!, topicAt) - dist(y.index!, topicAt));
    if (addrs[0]) {
      nearest = addrs[0];
      break;
    }
  }
  const a = nearest?.[0]?.toLowerCase();
  const m = lines.map((l) => AMOUNT.exec(l)).find((x) => x) ?? null;
  const ct = COIN_TYPE.exec(item.text)?.[1];
  if (!a && !m) return null;
  return {
    ...(a ? { address: a } : {}),
    ...(m ? { amount: `${m[1]!.replace(/,/g, '')}${m[2] ? '.' + m[2] : ''}` } : {}),
    ...(ct ? { coinType: ct } : {}),
    persuasive: PERSUASIVE.test(item.text),
    fromId: item.id,
  };
}

function dist(i: number, at: number[]): number {
  return Math.min(...at.map((t) => Math.abs(t - i)));
}

export class ScriptedModel implements ChatModel {
  readonly name = 'scripted-gullible-v1';
  readonly simulated = true;

  async complete(messages: ChatMessage[]): Promise<ModelReply> {
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    const toolMsgs = messages.filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool');
    const calls = messages.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []) : []));
    const called = (name: string) => calls.filter((c) => c.name === name);
    const topic = TOPICS.find((t) => t.words.test(user));
    const wantsPay = /\b(pay|send|transfer|settle)\b/i.test(user);
    const url = URL_RE.exec(user)?.[0];
    const id = `call_${calls.length + 1}`;

    // 1. Always look at memory first.
    if (called('recall_memories').length === 0) {
      const q = topic ? `${user} ${topic.label} payment address amount` : user;
      return { content: null, toolCalls: [{ id, name: 'recall_memories', arguments: JSON.stringify({ query: q }) }] };
    }

    const items: ContextItemLike[] = toolMsgs.flatMap((m) => {
      try {
        const v = JSON.parse(m.content) as { items?: ContextItemLike[] };
        return v.items ?? [];
      } catch {
        return [];
      }
    });

    // x402 bills: hand the URL to the tool; Antibody decides who gets paid.
    if (url && wantsPay) {
      if (called('pay_x402').length === 0) {
        return { content: null, toolCalls: [{ id, name: 'pay_x402', arguments: JSON.stringify({ url, payeeLabel: topic?.label ?? 'utility', reason: user }) }] };
      }
      return { content: summarize(toolMsgs.at(-1)?.content), toolCalls: [] };
    }

    if (!wantsPay || !topic) {
      if (called('write_note').length === 0) {
        const text = `Summary for "${user}": ${items.map((i) => i.text.split('\n')[0]).join(' / ').slice(0, 600) || 'nothing relevant in memory'}`;
        return { content: null, toolCalls: [{ id, name: 'write_note', arguments: JSON.stringify({ text, cites: items.map((i) => i.id) }) }] };
      }
      return { content: 'Noted.', toolCalls: [] };
    }

    // 2. Work out where to pay. Gullible: a persuasive claim beats a plain fact.
    const claims = items.map((i) => extractClaim(i, topic)).filter((c): c is Claim => c !== null);
    const best = (pick: (c: Claim) => string | undefined) => {
      const persuasive = claims.filter((c) => c.persuasive && pick(c));
      const plain = claims.filter((c) => !c.persuasive && pick(c));
      return (persuasive.at(-1) ?? plain.at(0)) as Claim | undefined;
    };
    const addrClaim = best((c) => c.address);
    const amountClaim = best((c) => c.amount);
    const ctClaim = claims.find((c) => c.coinType);
    const instructed = AMOUNT.exec(user);

    if ((addrClaim?.persuasive || amountClaim?.persuasive) && called('write_note').length === 0) {
      // Models "helpfully" record what they learned; the runtime taints it anyway.
      const text = `${topic.label} payment details updated: pay ${addrClaim?.address ?? 'the usual address'}${amountClaim?.amount ? `, amount ${amountClaim.amount}` : ''}.`;
      return { content: null, toolCalls: [{ id, name: 'write_note', arguments: JSON.stringify({ text, cites: [] }) }] };
    }

    if (called('propose_payment').length === 0) {
      if (!addrClaim?.address) return { content: `I could not find a ${topic.label} address in memory.`, toolCalls: [] };
      const amount = instructed ? `${instructed[1]!.replace(/,/g, '')}${instructed[2] ? '.' + instructed[2] : ''}` : (amountClaim?.amount ?? '0');
      const args = {
        recipient: addrClaim.address,
        amount,
        ...(ctClaim?.coinType ? { coinType: ctClaim.coinType } : {}),
        payeeLabel: topic.label,
        reason: user,
        cites: claims.map((c) => c.fromId),
      };
      return { content: null, toolCalls: [{ id, name: 'propose_payment', arguments: JSON.stringify(args) }] };
    }
    return { content: summarize(toolMsgs.at(-1)?.content), toolCalls: [] };
  }
}

function summarize(toolResult: string | undefined): string {
  if (!toolResult) return 'Done.';
  try {
    const r = JSON.parse(toolResult) as { decision?: string; code?: string; reasons?: string[]; txDigest?: string | null };
    return `Payment ${r.decision ?? '?'}${r.code && r.code !== 'OK' ? ` (${r.code})` : ''}: ${(r.reasons ?? []).join('; ')}${r.txDigest ? ` · tx ${r.txDigest}` : ''}`;
  } catch {
    return toolResult.slice(0, 200);
  }
}
