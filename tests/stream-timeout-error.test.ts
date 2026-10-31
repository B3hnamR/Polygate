import { test, expect, beforeAll, afterAll } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN = 'timeout-secret';
const { startGateway } = await import('../backend/main');
const { settings, saveModel, logs } = await import('../backend/state');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = '';
const enc = new TextEncoder();
const sse = (x: any) => 'data: ' + JSON.stringify(x) + '\n\n';
// Sends one chunk, then nothing for three seconds: a stream that stalls after it has started.
const up = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  if (new URL(req.url).pathname.endsWith('/models')) return Response.json({ data: [] });
  return new Response(new ReadableStream({ async start(c) { c.enqueue(enc.encode(sse({ choices: [{ index: 0, delta: { content: 'partial ' }, finish_reason: null }] }))); await Bun.sleep(3000); try { c.close(); } catch {} } }), { headers: { 'content-type': 'text/event-stream' } });
} });
const saved: any = {};
beforeAll(async () => {
  Object.assign(saved, { providers: settings.providers, timeoutMs: settings.timeoutMs, retries: settings.retries });
  settings.retries = 0; settings.timeoutMs = 600;
  settings.providers = [{ id: 'ps', name: 'S', kind: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${up.port}/stall/v1`, apiKey: '', models: [], routeId: 'direct' }] as any;
  saveModel({ id: 'ps/s1', upstreamId: 's1', providerId: 'ps', name: 's1', context: 128000, output: 4096, tools: true, reasoning: false, state: 'available', latency: 0, score: 50, priority: 1, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '' } as any);
  gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`;
});
afterAll(async () => { await gateway?.close(); up.stop(true); settings.providers = saved.providers; settings.timeoutMs = saved.timeoutMs; settings.retries = saved.retries; });
const get = async (path: string, body: any) => { const r = await fetch(base + path, { method: 'POST', headers: { authorization: 'Bearer ' + settings.keys[0].value, 'x-api-key': settings.keys[0].value, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, text: await r.text() }; };

test('chat: a stream that stalls after it started ends with an error chunk and [DONE], not silence', async () => {
  const r = await get('/v1/chat/completions', { model: 'ps/s1', stream: true, messages: [{ role: 'user', content: 'hi' }] });
  expect(r.text).toContain('partial'); expect(r.text).toContain('"error"'); expect(r.text).toContain('stopped sending data'); expect(r.text.trimEnd().endsWith('data: [DONE]')).toBe(true);
});
test('anthropic: a stalled stream ends with an error event', async () => {
  const r = await get('/v1/messages', { model: 'ps/s1', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'hi' }] });
  expect(r.text).toContain('partial'); expect(r.text).toContain('event: error'); expect(r.text).toContain('stopped sending data');
});
test('responses: a stalled stream ends with an error event', async () => {
  const r = await get('/v1/responses', { model: 'ps/s1', stream: true, input: 'hi' });
  expect(r.text).toContain('partial'); expect(r.text).toContain('event: error'); expect(r.text).toContain('stopped sending data');
});
test('the request is still recorded as a gateway timeout', async () => {
  await get('/v1/chat/completions', { model: 'ps/s1', stream: true, messages: [{ role: 'user', content: 'hi' }] });
  const row = logs(5).find(l => l.model === 'ps/s1'); expect(row?.status).toBe(504);
});
