import { test, expect, beforeAll, afterAll } from 'bun:test';
import { preserveTestState } from './setup';
const restore = preserveTestState();
// A conversation that once carried an image, sent to a model that takes none: the provider refuses every later message (the image is still in
// the history), which left an agent session unusable. The gateway now sends it again with each image replaced by a note, and remembers the model.
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN = 'image-refusal-secret';
const { startGateway } = await import('../backend/main');
const { settings, saveModel, models } = await import('../backend/state');
const { withoutImages, refusesImages, IMAGE_NOTE } = await import('../backend/plan');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = '';
const seen: any[] = [];
const sse = (x: any) => 'data: ' + JSON.stringify(x) + '\n\n';
const hasImage = (body: any) => JSON.stringify(body.messages).includes('"image_url"');
// Like Kilo/OpenRouter for a text-only model: a 404 whenever any message holds an image.
const up = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const u = new URL(req.url); if (u.pathname.endsWith('/models')) return Response.json({ data: [] });
  const body: any = await req.json(); seen.push(body);
  if (hasImage(body)) return Response.json({ error: { message: 'No endpoints found that support image input', code: 404, metadata: { failed_routing_step: 'Filter by Image Support' } } }, { status: 404 });
  return new Response(sse({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
} });
beforeAll(async () => {
  settings.retries = 0; settings.fallback = true; settings.chains = [];
  models.clear(); settings.enabled = true; settings.rotate = false; settings.routeId = 'direct';
  settings.routes = [{ id: 'direct', name: 'Fixture direct', kind: 'direct', url: '', enabled: true, models: [] }];
  settings.providers = [{ id: 'txt', name: 'Txt', kind: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${up.port}/v1`, apiKey: '', models: [], routeId: 'direct' }] as any;
  saveModel({ id: 'txt/ernie', upstreamId: 'ernie', providerId: 'txt', name: 'Ernie', context: 0, output: 0, tools: true, reasoning: false, state: 'available', latency: 0, score: 50, priority: 1, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '' } as any);
  gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`;
});
afterAll(async () => { try { await gateway?.close(); } finally { up.stop(true); restore(); } });
const picture = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
const ask = async (messages: any[], model = 'txt/ernie', key = settings.keys[0].value) => { const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: false, messages }) }); const j: any = await r.json().catch(() => ({})); return { status: r.status, text: j.choices?.[0]?.message?.content || j.error?.message || '' }; };

test('images are recognised and replaced by a note; the refusals are recognised, other errors are not', () => {
  const w = withoutImages({ model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'see' }, picture] }, { role: 'user', content: 'plain' }] });
  expect(w.count).toBe(1); expect(w.chat.messages[0].content).toEqual([{ type: 'text', text: 'see' }, { type: 'text', text: IMAGE_NOTE }]); expect(w.chat.messages[1].content).toBe('plain');
  const none = { messages: [{ role: 'user', content: 'hi' }] }; expect(withoutImages(none)).toEqual({ chat: none, count: 0 });
  expect(refusesImages(404, 'No endpoints found that support image input')).toBe(true);
  expect(refusesImages(400, 'This model does not support image input')).toBe(true);
  expect(refusesImages(400, 'Image input is not supported for this model')).toBe(true);
  expect(refusesImages(400, 'Unsupported content type: image/tiff')).toBe(false);
  expect(refusesImages(400, 'This model does not support image format TIFF')).toBe(false);
  expect(refusesImages(429, 'rate limited')).toBe(false); expect(refusesImages(500, 'does not support images')).toBe(false); expect(refusesImages(404, 'model not found')).toBe(false);
});

test('a session that once sent an image to a text-only model works again: the message goes through with the image replaced, and the model is remembered', async () => {
  seen.length = 0;
  // The session as it was left: an image early on, then a plain message that used to fail every time.
  const history = [{ role: 'user', content: [{ type: 'text', text: 'what is in this picture' }, picture] }, { role: 'assistant', content: '' }, { role: 'user', content: 'check' }];
  const first = await ask(history);
  expect(first.status).toBe(200); expect(first.text).toBe('ok');
  expect(seen.length).toBe(2); expect(hasImage(seen[0])).toBe(true); expect(hasImage(seen[1])).toBe(false);
  expect(JSON.stringify(seen[1].messages)).toContain('cannot see images');
  expect(models.get('txt/ernie')!.images).toBe(false);
  // The next message of the same session: the image is replaced before it is sent, so there is no refused attempt at all.
  seen.length = 0;
  const next = await ask([...history, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'and now?' }]);
  expect(next.status).toBe(200); expect(seen.length).toBe(1); expect(hasImage(seen[0])).toBe(false);
});

test('an explicit Agent chain keeps working after learning that its tool model is text-only', async () => {
  const m = models.get('txt/ernie')!, oldImages = m.images, oldTools = m.tools;
  const key = { ...settings.keys[0], id: 'image-agent', value: 'image-agent-token', agent: true, models: [] };
  const oldChains = settings.chains;
  settings.keys.push(key);
  settings.chains = [{ id: 'image-chain', name: 'Image chain', enabled: true, models: [m.id] }];
  delete m.images;
  const history = [{ role: 'user', content: [{ type: 'text', text: 'inspect this' }, picture] }];
  try {
    seen.length = 0;
    expect((await ask(history, 'Image chain', key.value)).status).toBe(200);
    expect(seen).toHaveLength(2); expect(models.get(m.id)?.images).toBe(false);
    seen.length = 0;
    expect((await ask([...history, { role: 'user', content: 'continue' }], 'Image chain', key.value)).status).toBe(200);
    expect(seen).toHaveLength(1); expect(hasImage(seen[0])).toBe(false);
    m.tools = false; seen.length = 0;
    expect((await ask(history, 'Image chain', key.value)).status).toBe(503);
    expect(seen).toHaveLength(0);
  } finally {
    settings.keys = settings.keys.filter(k => k !== key); settings.chains = oldChains;
    m.images = oldImages; m.tools = oldTools;
  }
});
