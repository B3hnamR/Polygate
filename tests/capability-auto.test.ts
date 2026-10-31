import { test, expect, beforeAll, afterAll } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN = 'capability-secret';
const { startGateway } = await import('../backend/main');
const { settings, saveModel, models } = await import('../backend/state');
const { needsOf, lacks } = await import('../backend/plan');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = '';
let hits = 0;
const sse = (x: any) => 'data: ' + JSON.stringify(x) + '\n\n';
const up = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const u = new URL(req.url); if (u.pathname.endsWith('/models')) return Response.json({ data: [] });
  hits++;
  return new Response(sse({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
} });
const add = (id: string, priority: number, extra: Partial<any> = {}) => saveModel({ id, upstreamId: id.split('/')[1], providerId: 'cap', name: id, context: 0, output: 0, tools: true, reasoning: false, state: 'available', latency: 0, score: 50, priority, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '', ...extra } as any);
const saved: any = {};
beforeAll(async () => {
  Object.assign(saved, { providers: settings.providers, chains: settings.chains, fallback: settings.fallback, retries: settings.retries });
  settings.retries = 0; settings.fallback = true; settings.chains = [];
  settings.providers = [{ id: 'cap', name: 'Cap', kind: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${up.port}/v1`, apiKey: '', models: [], routeId: 'direct' }] as any;
  gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`;
});
afterAll(async () => { await gateway?.close(); up.stop(true); settings.providers = saved.providers; settings.chains = saved.chains; settings.fallback = saved.fallback; settings.retries = saved.retries; for (const id of [...models.keys()]) if (id.startsWith('cap/')) models.delete(id); });
const tool = { type: 'function', function: { name: 'read_file', description: 'x', parameters: { type: 'object', properties: {} } } };
const ask = async (body: any) => { const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + settings.keys[0].value, 'content-type': 'application/json' }, body: JSON.stringify({ stream: false, messages: [{ role: 'user', content: 'hi' }], ...body }) }); await r.text(); return { status: r.status, model: r.headers.get('x-polygate-model'), skipped: decodeURIComponent(r.headers.get('x-polygate-skipped') || '') }; };
const reset = () => { for (const id of [...models.keys()]) if (id.startsWith('cap/')) models.delete(id); };

test('what a request needs is read from the request: tools, images and a rough size', () => {
  expect(needsOf({ messages: [{ role: 'user', content: 'hi' }] })).toEqual({ tools: false, images: false, tokens: 1 });
  expect(needsOf({ messages: [{ role: 'user', content: 'hi' }], tools: [tool] }).tools).toBe(true);
  expect(needsOf({ messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{}' } }] }, { role: 'tool', content: 'out' }] }).tools).toBe(true); // a conversation that already used tools
  const img = needsOf({ messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(400000) } }] }] });
  expect(img.images).toBe(true); expect(img.tokens).toBeLessThan(20); // the picture is not counted as text
  expect(needsOf({ messages: [{ role: 'user', content: 'x'.repeat(4000) }] }).tokens).toBe(1000);
});
test('a model is excluded only when its listing says it cannot do what is asked; unknown never excludes', () => {
  const m = (x: any) => ({ id: 'a/b', context: 0, tools: true, ...x }) as any;
  expect(lacks(m({ tools: false }), { tools: true, images: false, tokens: 0 })?.short).toBe('no tool support');
  expect(lacks(m({ tools: false }), { tools: false, images: false, tokens: 0 })).toBeUndefined();
  expect(lacks(m({}), { tools: true, images: true, tokens: 999999 })).toBeUndefined(); // images and context unknown
  expect(lacks(m({ images: false }), { tools: false, images: true, tokens: 0 })?.short).toBe('text only');
  expect(lacks(m({ context: 8000 }), { tools: false, images: false, tokens: 9000 })?.long).toContain('9,000 tokens');
});
test('auto skips a model without tool support when the request uses tools, and says which and why', async () => {
  reset(); add('cap/a', 1, { tools: false }); add('cap/b', 2); add('cap/c', 3);
  const r = await ask({ model: 'auto', tools: [tool] });
  expect(r.status).toBe(200); expect(r.model).toBe('cap/b'); expect(r.skipped).toBe('cap/a (no tool support)');
});
test('the same model is used when the request needs no tools', async () => {
  const r = await ask({ model: 'auto' });
  expect(r.model).toBe('cap/a'); expect(r.skipped).toBe('');
});
test('an image skips a text-only model, and a prompt larger than a model\'s context skips that model', async () => {
  reset(); add('cap/t', 1, { images: false }); add('cap/s', 2, { context: 500 }); add('cap/v', 3);
  const picture = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
  const a = await ask({ model: 'auto', messages: [{ role: 'user', content: [{ type: 'text', text: 'see' }, picture] }] });
  expect(a.model).toBe('cap/s'); expect(a.skipped).toBe('cap/t (text only)');
  const b = await ask({ model: 'auto', messages: [{ role: 'user', content: 'x'.repeat(4000) }] });
  expect(b.model).toBe('cap/t'); expect(b.skipped).toBe('cap/s (context too small)'); // 1000 tokens against a 500-token context; the text-only model is fine for text
});
test('when no model is listed as able, the best ones are tried anyway, because a listing can be wrong', async () => {
  reset(); add('cap/a', 1, { tools: false }); add('cap/b', 2, { tools: false });
  const before = hits; const r = await ask({ model: 'auto', tools: [tool] });
  expect(r.status).toBe(200); expect(r.model).toBe('cap/a'); expect(r.skipped).toBe(''); expect(hits).toBe(before + 1);
});
test('a model asked for by name, or named in a chain, is never swapped for another', async () => {
  reset(); add('cap/a', 1, { tools: false }); add('cap/b', 2);
  expect((await ask({ model: 'cap/a', tools: [tool] })).model).toBe('cap/a');
  settings.chains = [{ id: 'ch1', name: 'mine', enabled: true, models: ['cap/a', 'cap/b'] }] as any;
  const c = await ask({ model: 'mine', tools: [tool] }); expect(c.model).toBe('cap/a'); expect(c.skipped).toBe('');
  settings.chains = [{ id: 'ch2', name: 'viaauto', enabled: true, models: ['auto'] }] as any;
  const d = await ask({ model: 'viaauto', tools: [tool] }); expect(d.model).toBe('cap/b'); expect(d.skipped).toBe('cap/a (no tool support)'); // the auto step of a chain does skip
});
test('the preview and a real request choose the same model, with and without tools', async () => {
  reset(); add('cap/a', 1, { tools: false }); add('cap/b', 2); add('cap/c', 3);
  for (const tools of [true, false]) {
    const p = await (await fetch(base + '/admin/route-preview', { method: 'POST', headers: { authorization: 'Bearer capability-secret', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'auto', tools }) })).json() as any;
    const real = await ask({ model: 'auto', ...(tools ? { tools: [tool] } : {}) });
    expect(p.steps.find((s: any) => s.status === 'try').model).toBe(real.model);
    expect(p.steps.filter((s: any) => s.status === 'skip').map((s: any) => s.model + ' (' + (s.reason.includes('tool') ? 'no tool support' : s.reason) + ')')).toEqual(real.skipped ? [real.skipped] : []);
  }
});
