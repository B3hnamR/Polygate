import { test, expect, beforeAll, afterAll } from 'bun:test';
import { preserveTestState } from './setup';
const restore = preserveTestState();
// The whole path: a provider that streams read {"path"} reaches the client as read {"filePath"}, in every protocol.
process.env.POLYGATE_ADMIN_TOKEN = 'toolargs-secret';
const { startGateway } = await import('../backend/main');
const { settings, saveModel, models } = await import('../backend/state');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = '';
const sse = (x: any) => 'data: ' + JSON.stringify(x) + '\n\n';
let argsSent = '{"path": "src/a.ts"}';
const up = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const u = new URL(req.url); if (u.pathname.endsWith('/models')) return Response.json({ data: [] });
  const half = Math.floor(argsSent.length / 2);
  return new Response(
    sse({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Reading it.' }, finish_reason: null }] }) +
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: argsSent.slice(0, half) } }] }, finish_reason: null }] }) +
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsSent.slice(half) } }] }, finish_reason: null }] }) +
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5 } }) + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
} });
const read = { type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } } };
beforeAll(async () => {
  settings.retries = 0; settings.fallback = false; settings.chains = [];
  models.clear(); settings.enabled = true; settings.rotate = false; settings.routeId = 'direct';
  settings.routes = [{ id: 'direct', name: 'Fixture direct', kind: 'direct', url: '', enabled: true, models: [] }] as any;
  settings.providers = [{ id: 'cap', name: 'Cap', kind: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${up.port}/v1`, apiKey: '', models: [], routeId: 'direct' }] as any;
  saveModel({ id: 'cap/ds', upstreamId: 'ds', providerId: 'cap', name: 'cap/ds', context: 0, output: 0, tools: true, reasoning: false, state: 'available', latency: 0, score: 50, priority: 1, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '' } as any);
  gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`;
});
afterAll(async () => { try { await gateway?.close(); } finally { up.stop(true); restore(); } });
const post = (path: string, body: any) => fetch(base + path, { method: 'POST', headers: { authorization: 'Bearer ' + settings.keys[0].value, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const chatArgs = (text: string) => text.split('\n\n').filter(b => b.startsWith('data: {')).flatMap(b => JSON.parse(b.slice(6)).choices?.flatMap((c: any) => c.delta?.tool_calls || []) || []).map((t: any) => t.function?.arguments || '').join('');

test('chat, streamed: the misnamed argument is renamed and the reasoning still arrives', async () => {
  argsSent = '{"path": "src/a.ts"}';
  const text = await (await post('/v1/chat/completions', { model: 'cap/ds', stream: true, tools: [read], messages: [{ role: 'user', content: 'read a' }] })).text();
  expect(JSON.parse(chatArgs(text))).toEqual({ filePath: 'src/a.ts' });
  expect(text).toContain('Reading it.');
});
test('chat, not streamed: the same', async () => {
  const j: any = await (await post('/v1/chat/completions', { model: 'cap/ds', stream: false, tools: [read], messages: [{ role: 'user', content: 'read a' }] })).json();
  expect(JSON.parse(j.choices[0].message.tool_calls[0].function.arguments)).toEqual({ filePath: 'src/a.ts' });
});
test('anthropic messages: the tool_use input carries the right name', async () => {
  const j: any = await (await post('/v1/messages', { model: 'cap/ds', max_tokens: 100, stream: false, tools: [{ name: 'read', description: 'Read a file', input_schema: read.function.parameters }], messages: [{ role: 'user', content: 'read a' }] })).json();
  expect(j.content.find((b: any) => b.type === 'tool_use').input).toEqual({ filePath: 'src/a.ts' });
});
test('a correct call reaches the client exactly as the model wrote it', async () => {
  argsSent = '{"filePath": "src/a.ts"}';
  const text = await (await post('/v1/chat/completions', { model: 'cap/ds', stream: true, tools: [read], messages: [{ role: 'user', content: 'read a' }] })).text();
  expect(chatArgs(text)).toBe('{"filePath": "src/a.ts"}');
});
