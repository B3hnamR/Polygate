import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN = 'followup-secret';
const { startGateway } = await import('../backend/main');
const { settings, saveModel, models } = await import('../backend/state');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = '';
const enc = new TextEncoder();
const choice = (index: number, text: string, finish: string | null = null) => JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'm', choices: [{ index, delta: text ? { content: text } : {}, finish_reason: finish }] });
const sse = (frames: string[], done: boolean) => new Response(enc.encode(frames.map(f => 'data: ' + f + '\n\n').join('') + (done ? 'data: [DONE]\n\n' : '')), { headers: { 'content-type': 'text/event-stream' } });
// What the fake upstream sends depends on the path: n2miss finishes choice 0 and never starts choice 1; n2both finishes both without [DONE]; n2ignored answers with one choice and [DONE].
const up = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const u = new URL(req.url); if (u.pathname.endsWith('/models')) return Response.json({ data: [] });
  if (u.pathname.startsWith('/n2miss')) return sse([choice(0, 'A'), choice(0, '', 'stop')], false);
  if (u.pathname.startsWith('/n2both')) return sse([choice(0, 'A'), choice(1, 'B'), choice(0, '', 'stop'), choice(1, '', 'stop')], false);
  if (u.pathname.startsWith('/n2ignored')) return sse([choice(0, 'A'), choice(0, '', 'stop')], true);
  return sse([choice(0, 'ok'), choice(0, '', 'stop')], true);
} });
const model = (id: string, providerId: string, priority: number, extra: Partial<any> = {}) => saveModel({ id, upstreamId: id.split('/')[1], providerId, name: id, context: 0, output: 0, tools: true, reasoning: false, state: 'available', latency: 0, score: 50, priority, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '', ...extra } as any);
const prov = (id: string, path: string) => ({ id, name: id.toUpperCase(), kind: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${up.port}/${path}/v1`, apiKey: '', models: [], routeId: 'direct' });
const saved: any = {};
beforeAll(async () => {
  Object.assign(saved, { providers: settings.providers, retries: settings.retries, fallback: settings.fallback, chains: settings.chains });
  settings.retries = 0; settings.fallback = true; settings.chains = [];
  gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`;
});
afterEach(() => { for (const id of [...models.keys()]) if (/^(big|fu)\//.test(id)) models.delete(id); });
afterAll(async () => { await gateway?.close(); up.stop(true); settings.providers = saved.providers; settings.retries = saved.retries; settings.fallback = saved.fallback; settings.chains = saved.chains; });
const ask = async (body: any) => { const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + settings.keys[0].value, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], ...body }) }); const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch { /* a stream */ } return { status: r.status, text, json, model: r.headers.get('x-polygate-model'), skipped: decodeURIComponent(r.headers.get('x-polygate-skipped') || '') }; };
const preview = async (body: any) => (await fetch(base + '/admin/route-preview', { method: 'POST', headers: { authorization: 'Bearer followup-secret', 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>;
const tool = { type: 'function', function: { name: 'read_file', description: 'x', parameters: { type: 'object', properties: {} } } };
const pad = (i: number) => String(i).padStart(2, '0');
// 45 models in one provider, in order, none with tool support except the ones named.
const catalog = (capable: number[]) => { settings.providers = [prov('big', 'ok')] as any; for (let i = 1; i <= 45; i++) model('big/m' + pad(i), 'big', i, { tools: capable.includes(i) }); };

// ---- 1. the whole catalog is searched, in the preview and in a real request alike
for (const position of [16, 41]) {
  test(`a tool-capable model at position ${position} of 45 is found by the preview and by a real request`, async () => {
    catalog([position]); const want = 'big/m' + pad(position);
    const p = await preview({ model: 'auto', tools: true });
    const real = await ask({ model: 'auto', stream: false, tools: [tool] });
    expect(real.status).toBe(200); expect(real.model).toBe(want);
    expect(p.steps.find((s: any) => s.status === 'try')?.model).toBe(want); expect(p.notes.join(' ')).not.toContain('tried anyway');
    expect(p.steps.length).toBeLessThanOrEqual(25); // only what is shown is trimmed: the chosen model is in it, and a note says how many more were checked
    expect(p.notes.join(' ')).toMatch(/more models were checked/);
  });
}
test('when no model among 45 is listed as able, both try the best one anyway, and the header of the answer stays short', async () => {
  catalog([]);
  const p = await preview({ model: 'auto', tools: true }); const real = await ask({ model: 'auto', stream: false, tools: [tool] });
  expect(real.status).toBe(200); expect(real.model).toBe('big/m01'); expect(p.steps.find((s: any) => s.status === 'try')?.model).toBe('big/m01');
  expect(real.skipped).toBe('');
});
test('the models passed over in a real request are named, but the list is cut so the header stays small', async () => {
  catalog([30]);
  const real = await ask({ model: 'auto', stream: false, tools: [tool] });
  expect(real.model).toBe('big/m30'); expect(real.skipped.split(', ').length).toBeLessThanOrEqual(11); expect(real.skipped).toContain('big/m01 (no tool support)'); expect(real.skipped).toMatch(/\+\d+ more/);
});

// ---- 3. a choice that never starts
test('n = 2 where the second choice never starts and there is no [DONE] is an error, not a one-choice answer', async () => {
  settings.providers = [prov('fu', 'n2miss')] as any; model('fu/m', 'fu', 1);
  const plain = await ask({ model: 'fu/m', n: 2, stream: false });
  expect(plain.status).toBe(502); expect(plain.text).toContain('ended before a terminal event');
  const streamed = await ask({ model: 'fu/m', n: 2, stream: true });
  expect(streamed.text).toContain('"error"');
});
test('n = 2 with both choices finished is complete even without [DONE], and a provider that ignores n but ends properly is still answered', async () => {
  settings.providers = [prov('fu', 'n2both')] as any; model('fu/m', 'fu', 1);
  const both = await ask({ model: 'fu/m', n: 2, stream: false }); expect(both.status).toBe(200); expect(both.json.choices.map((c: any) => c.message.content)).toEqual(['A', 'B']);
  settings.providers = [prov('fu', 'n2ignored')] as any;
  const ignored = await ask({ model: 'fu/m', n: 2, stream: false }); expect(ignored.status).toBe(200); expect(ignored.json.choices.length).toBe(1);
  settings.providers = [prov('fu', 'n2miss')] as any;
  const single = await ask({ model: 'fu/m', stream: false }); expect(single.status).toBe(200); // without n, one finished choice is the whole answer
});
