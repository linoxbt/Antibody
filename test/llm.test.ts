// Steward's model client against an OpenAI-compatible server shaped like
// Fortytwo's: reasoning_effort sent, reasoning returned and sent back,
// models listed, keys refused. No network: a local fake server.
import { strict as assert } from 'node:assert';
import { createServer, type IncomingMessage } from 'node:http';
import { after, before, test } from 'node:test';
import { FORTYTWO, loadLlm, loadConfig } from '../src/config.ts';
import { checkLlm } from '../src/ops/doctor.ts';
import { llmSmokeTest } from '../src/steward/llm-check.ts';
import { OpenAIModel } from '../src/steward/model.ts';

const seen: Record<string, unknown>[] = [];
let base = '';
const server = createServer(async (req: IncomingMessage, res) => {
  const ok = req.headers.authorization === 'Bearer good-key';
  if (!ok) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { code: 'invalid_api_key', message: 'The API key is missing or not valid.' }, request_id: 'req_x' }));
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: FORTYTWO.model, object: 'model', created: 0, owned_by: 'fortytwo' }] }));
  }
  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw) as { messages: { role: string }[] } & Record<string, unknown>;
  seen.push(body);
  const toolTurn = !body.messages.some((m) => m.role === 'tool');
  res.writeHead(200, { 'content-type': 'application/json', 'x-ai-generated': 'true' });
  res.end(
    JSON.stringify({
      id: 'c1',
      object: 'chat.completion',
      created: 0,
      model: body.model,
      choices: [
        {
          index: 0,
          finish_reason: toolTurn ? 'tool_calls' : 'stop',
          message: toolTurn
            ? { role: 'assistant', content: null, reasoning: 'The user wants a ping.', reasoning_details: [{ type: 'reasoning.text', text: 'ping' }], tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ping', arguments: '{"ok":true}' } }] }
            : { role: 'assistant', content: 'ready' },
        },
      ],
    }),
  );
});

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
after(() => server.close());

test('LLM_PROVIDER=fortytwo fills in the URL and Qwen model; only the key is needed', () => {
  const l = loadLlm({ LLM_PROVIDER: 'fortytwo', FORTYTWO_API_KEY: 'k' });
  assert.deepEqual([l.baseUrl, l.model, l.apiKey, l.reasoningEffort], [FORTYTWO.baseUrl, FORTYTWO.model, 'k', 'low']);
  const o = loadLlm({ LLM_PROVIDER: 'fortytwo', LLM_API_KEY: 'k2', LLM_MODEL: 'other/model', LLM_REASONING_EFFORT: 'HIGH', LLM_TIMEOUT_MS: '30000' });
  assert.deepEqual([o.apiKey, o.model, o.reasoningEffort, o.timeoutMs], ['k2', 'other/model', 'high', 30000]);
  const plain = loadLlm({ LLM_BASE_URL: 'https://x.example/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm' });
  assert.equal(plain.reasoningEffort, null, 'other providers get no reasoning_effort unless asked');
  assert.equal(loadLlm({ FORTYTWO_API_KEY: 'k' }).apiKey, null, 'FORTYTWO_API_KEY alone does not switch providers');
  assert.throws(() => loadLlm({ LLM_PROVIDER: 'fortytwo', LLM_REASONING_EFFORT: 'turbo' }), /LLM_REASONING_EFFORT must be one of/);
  assert.throws(() => loadLlm({ LLM_PROVIDER: 'nope' }), /LLM_PROVIDER must be one of/);
});

test('tool calling round trip: reasoning_effort is sent, reasoning goes back unchanged', async () => {
  seen.length = 0;
  const m = new OpenAIModel(base, 'good-key', FORTYTWO.model, { reasoningEffort: 'low', timeoutMs: 5000, provider: 'fortytwo' });
  const r = await llmSmokeTest(m);
  assert.equal(r.toolCalled, true);
  assert.equal(r.reasoning, true);
  assert.equal(r.answer, 'ready');
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.reasoning_effort, 'low');
  assert.equal(seen[0]!.temperature, 0);
  const back = (seen[1]!.messages as Record<string, unknown>[]).find((x) => x.role === 'assistant')!;
  assert.equal(back.reasoning, 'The user wants a ping.');
  assert.deepEqual(back.reasoning_details, [{ type: 'reasoning.text', text: 'ping' }]);
  assert.equal((back.tool_calls as { id: string }[])[0]!.id, 'call_1');
});

test('doctor: model served, wrong model named, key refused, not configured', async () => {
  const cfg = (env: Record<string, string>) => loadConfig({ ANTIBODY_HOME: '/nonexistent-antibody-home', ...env });
  const ok = await checkLlm(cfg({ LLM_PROVIDER: 'fortytwo', LLM_BASE_URL: base, LLM_API_KEY: 'good-key' }), fetch);
  assert.equal(ok.status, 'ok');
  assert.match(ok.detail, /qwen.*reasoning low/);
  const wrong = await checkLlm(cfg({ LLM_PROVIDER: 'fortytwo', LLM_BASE_URL: base, LLM_API_KEY: 'good-key', LLM_MODEL: 'qwen/typo' }), fetch);
  assert.equal(wrong.status, 'fail');
  assert.match(wrong.fix!, new RegExp(FORTYTWO.model.replace(/[.]/g, '\\.')));
  const refused = await checkLlm(cfg({ LLM_PROVIDER: 'fortytwo', LLM_BASE_URL: base, LLM_API_KEY: 'bad' }), fetch);
  assert.equal(refused.status, 'fail');
  assert.match(refused.detail, /refused \(HTTP 401\)/);
  assert.equal((await checkLlm(cfg({ LLM_PROVIDER: 'fortytwo' }), fetch)).status, 'fail', 'fortytwo without a key is a mistake, not a choice');
  assert.equal((await checkLlm(cfg({}), fetch)).status, 'warn', 'no model at all: scripted, SIMULATED');
});
