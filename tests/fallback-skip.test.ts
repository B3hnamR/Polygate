import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN = 'fallback-secret';
const { startGateway } = await import('../backend/main');
const { settings, saveModel } = await import('../backend/state');
const { __setExitVerifier } = await import('../backend/transport');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = '';
const FREE_LIMIT = JSON.stringify({ error: { message: 'Free usage limit reached. Free models work in OpenCode (https://opencode.ai)', type: 'FreeUsageLimitError', code: 429, log_id: 'l' } });
const sse = (x: any) => 'data: ' + JSON.stringify(x) + '\n\n';
const up = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const u = new URL(req.url); if (u.pathname.endsWith('/models')) return Response.json({ data: [] });
  if (u.pathname.startsWith('/limit')) return new Response(FREE_LIMIT, { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '7200' } });
  return new Response(sse({ choices: [{ index: 0, delta: { content: 'from B' }, finish_reason: null }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
} });
const model = (id: string, providerId: string, priority: number) => saveModel({ id, upstreamId: id.split('/')[1], providerId, name: id, context: 128000, output: 4096, tools: true, reasoning: false, state: 'available', latency: 0, score: 50, priority, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '' } as any);
const prov = (id: string, name: string, path: string, extra: any = {}) => ({ id, name, kind: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${up.port}/${path}/v1`, apiKey: '', models: [], routeId: 'direct', ...extra });
const saved: any = {};
beforeAll(async () => {
  Object.assign(saved, { providers: settings.providers, routes: settings.routes.slice(), retries: settings.retries, warp: settings.warp });
  settings.retries = 0; settings.warp = { engine: 'disabled', autoStart: false, pool: 1, rotateMinutes: 0, helperPath: '', endpoint: '' } as any;
  settings.routes.push({ id: 'r-cool', name: 'Cooling route', kind: 'proxy', url: 'socks5://127.0.0.1:1', enabled: true, models: [], cooldownUntil: Date.now() + 600000 } as any);
  gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`;
});
afterEach(() => { __setExitVerifier(); for (const r of settings.routes) if (r.id === 'direct') r.exhaustedUntil = 0; });
afterAll(async () => { await gateway?.close(); up.stop(true); settings.providers = saved.providers; settings.routes.length = 0; settings.routes.push(...saved.routes); settings.retries = saved.retries; settings.warp = saved.warp; });
const ask = async () => { const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + settings.keys[0].value, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'auto', stream: false, messages: [{ role: 'user', content: 'hi' }] }) }); return { status: r.status, model: r.headers.get('x-polygate-model'), body: await r.json() as any }; };

test('a provider whose chosen route is resting does not stop the next provider from answering', async () => {
  settings.providers = [prov('pa', 'A', 'a', { routeId: 'r-cool', routes: { ids: ['r-cool'] } }), prov('pb', 'B', 'b')] as any;
  model('pa/a1', 'pa', 1); model('pb/b1', 'pb', 100);
  const r = await ask(); expect(r.status).toBe(200); expect(r.model).toBe('pb/b1'); expect(r.body.choices[0].message.content).toBe('from B');
});
test('when every provider is on a resting route, the last one says why', async () => {
  settings.providers = [prov('pa', 'A', 'a', { routeId: 'r-cool', routes: { ids: ['r-cool'] } }), prov('pb', 'B', 'b', { routeId: 'r-cool', routes: { ids: ['r-cool'] } })] as any;
  model('pa/a1', 'pa', 1); model('pb/b1', 'pb', 100);
  const r = await ask(); expect(r.status).toBe(503); expect(r.body.error.message).toContain('resting after errors');
});
test('a provider whose exit is used up does not stop a provider that is not on that allowance', async () => {
  __setExitVerifier(async () => 'exhausted');
  settings.providers = [prov('pa', 'A', 'limit'), prov('pb', 'B', 'b')] as any;
  model('pa/a1', 'pa', 1); model('pb/b1', 'pb', 100);
  const r = await ask(); expect(r.status).toBe(200); expect(r.model).toBe('pb/b1');
});
test('when nothing else can answer after an exit was used up, the used-up message with its reset time is still what the client reads', async () => {
  __setExitVerifier(async () => 'exhausted');
  settings.providers = [prov('pa', 'A', 'limit')] as any; model('pa/a1', 'pa', 1);
  const r = await ask(); expect(r.status).toBe(429); expect(r.body.error.code).toBe('egress_exhausted');
});
