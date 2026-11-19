// A minimal OpenAI-compatible chat client (Fortytwo's Qwen by default) with tool calls.
// The key: LLM_API_KEY, or none when a proxy injects it (this repo's cloud sessions do for Fortytwo).
export interface ToolCall { id: string; name: string; arguments: string }
export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; reasoning?: unknown }
  | { role: 'tool'; tool_call_id: string; content: string };
export interface Tool { name: string; description: string; parameters: Record<string, unknown> }
export interface Reply { content: string | null; toolCalls: ToolCall[]; reasoning?: unknown; model: string }

export const LLM = {
  baseUrl: process.env.LLM_BASE_URL ?? 'https://api.fortytwo.network/v1',
  model: process.env.LLM_MODEL ?? 'qwen/qwen3.8-27b',
  effort: process.env.LLM_REASONING_EFFORT ?? 'low',
};

export async function chat(messages: Message[], tools: Tool[] = [], maxTokens = 3000): Promise<Reply> {
  const body = {
    model: LLM.model,
    temperature: 0,
    max_tokens: maxTokens,
    reasoning_effort: LLM.effort,
    messages: messages.map((m) =>
      m.role === 'assistant'
        ? {
            role: 'assistant',
            content: m.content,
            ...(m.tool_calls?.length ? { tool_calls: m.tool_calls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) } : {}),
            ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
          }
        : m,
    ),
    ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: t })), tool_choice: 'auto' } : {}),
  };
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${LLM.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LLM_API_KEY ?? 'proxy-injected'}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    if (res.ok) {
      const j: any = await res.json();
      const msg = j.choices?.[0]?.message ?? {};
      return {
        content: msg.content ?? null,
        toolCalls: (msg.tool_calls ?? []).map((t: any) => ({ id: t.id, name: t.function.name, arguments: t.function.arguments })),
        reasoning: msg.reasoning,
        model: j.model ?? LLM.model,
      };
    }
    const text = await res.text();
    if (attempt >= 3 || (res.status < 500 && res.status !== 429)) throw new Error(`model ${res.status}: ${text.slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
}
