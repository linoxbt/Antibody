/**
 * `antibody llm test`: one tiny tool-calling round trip against Steward's
 * configured model, so a provider (Fortytwo, OpenAI, a local server) can be
 * checked before a real turn. Two short requests; nothing is remembered.
 */
import type { ChatMessage, ChatModel, ToolDef } from './model.ts';

const PING: ToolDef = {
  name: 'ping',
  description: 'Answer a connectivity check. Always call it exactly once with ok=true.',
  parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
};

export interface LlmCheck {
  model: string;
  ms: number;
  toolCalled: boolean;
  /** The model returned its own reasoning (and got it back on the second call). */
  reasoning: boolean;
  answer: string | null;
}

export async function llmSmokeTest(model: ChatModel, now: () => number = Date.now): Promise<LlmCheck> {
  const t0 = now();
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a connectivity check. Call the ping tool once with ok=true, then reply with the single word: ready.' },
    { role: 'user', content: 'Run the check.' },
  ];
  const first = await model.complete(messages, [PING]);
  const call = first.toolCalls.find((c) => c.name === 'ping');
  if (!call) return { model: model.name, ms: now() - t0, toolCalled: false, reasoning: !!first.reasoning, answer: first.content };
  messages.push({ role: 'assistant', content: first.content, tool_calls: first.toolCalls, ...(first.reasoning ? { reasoning: first.reasoning } : {}) });
  for (const c of first.toolCalls) messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ pong: true }) });
  const second = await model.complete(messages, [PING]);
  return { model: model.name, ms: now() - t0, toolCalled: true, reasoning: !!first.reasoning, answer: second.content };
}
