import { test, expect, beforeAll, afterAll } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN = 'preview-secret';
const { startGateway } = await import('../backend/main');
const { settings, saveModel, models } = await import('../backend/state');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = '';
let hits = 0;
const up = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { hits++; return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }); } });
const add = (id: string, providerId: string, priority: number, extra: Partial<any> = {}) => saveModel({ id, upstreamId: id.split('/')[1], providerId, name: id, context: 0, output: 0, tools: true, reasoning: false, state: 'available', latency: 0, score: 50, priority, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '', ...extra } as any);
const prov = (id: string, name: string, extra: any = {}) => ({ id, name, kind: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${up.port}/${id}/v1`, apiKey: '', models: [], routeId: 'direct', ...extra });
const saved: any = {};
beforeAll(async () => {
  Object.assign(saved, { providers: settings.providers, routes: settings.routes.slice(), chains: settings.chains, keys: settings.keys, fallback: settings.fallback });
  settings.routes.push(
    { id: 'pv-cool', name: 'Cooling route', kind: 'proxy', url: 'socks5://127.0.0.1:1', enabled: true, models: [], cooldownUntil: Date.now() + 600000 } as any,
    { id: 'pv-relay', name: 'Vercel relay fra1', kind: 'relay', url: 'https://relay.example.vercel.app', token: 'tok-1234567', enabled: true, models: [] } as any);
  settings.providers = [prov('opn', 'OpenCode', { routeId: 'pv-cool', routes: { ids: ['pv-cool'] } }), prov('kil', 'Kilo', { routeId: 'pv-relay', routes: { ids: ['pv-relay'] } }), prov('paid', 'Paid provider')] as any;
  add('opn/free-model', 'opn', 1); add('kil/kilo-model', 'kil', 2); add('paid/big-model', 'paid', 3);
  settings.keys = [...settings.keys, { id: 'k-vs', name: 'VS Code', value: 'pg_preview_key_vscode', enabled: true, limit: 4, models: ['opn/free-model', 'kil/kilo-model'] } as any];
  settings.chains = [{ id: 'c1', name: 'my-coding', enabled: true, models: ['opn/free-model', 'kil/kilo-model', 'paid/big-model'] }] as any;
  gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`;
});
afterAll(async () => { await gateway?.close(); up.stop(true); settings.providers = saved.providers; settings.routes.length = 0; settings.routes.push(...saved.routes); settings.chains = saved.chains; settings.keys = saved.keys; settings.fallback = saved.fallback; for (const id of [...models.keys()]) if (/^(opn|kil|paid)\//.test(id)) models.delete(id); });
const preview = async (body: any, token = 'preview-secret') => { const r = await fetch(base + '/admin/route-preview', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any }; };

test('a chain preview says why each step is skipped or tried, and nothing is sent', async () => {
  const before = hits;
  const r = await preview({ model: 'my-coding', keyId: 'k-vs' });
  expect(r.status).toBe(200); expect(r.body).toMatchObject({ request: 'my-coding', kind: 'chain', key: 'VS Code', sent: false });
  const [a, b, c] = r.body.steps;
  expect(a).toMatchObject({ model: 'opn/free-model', status: 'skip' }); expect(a.reason).toContain('its configured route is unavailable'); expect(a.reason).toContain('resting after errors');
  expect(b).toMatchObject({ model: 'kil/kilo-model', status: 'try', via: 'Vercel relay fra1' });
  expect(c).toMatchObject({ model: 'paid/big-model', status: 'skip', reason: 'this client key does not allow that model' });
  expect(r.body.summary).toBe('Would try kil/kilo-model first, through Vercel relay fra1.');
  expect(hits).toBe(before); // no model request was sent
});
test('without a key the permission check is left out, and the later eligible steps are backups', async () => {
  const r = await preview({ model: 'my-coding' });
  expect(r.body.key).toBeNull(); expect(r.body.steps.map((s: any) => s.status)).toEqual(['skip', 'try', 'backup']);
});
test('a key that cannot be used is said so in the notes', async () => {
  settings.keys.find(k => k.id === 'k-vs')!.enabled = false;
  try { expect((await preview({ model: 'auto', keyId: 'k-vs' })).body.notes.join(' ')).toContain('switched off'); } finally { settings.keys.find(k => k.id === 'k-vs')!.enabled = true; }
});
test('auto is previewed with the capability check, and the preview can be asked about tools, images or a long prompt', async () => {
  add('kil/kilo-model', 'kil', 2, { tools: false });
  try {
    const plain = await preview({ model: 'auto' }); expect(plain.body.steps.find((s: any) => s.model === 'kil/kilo-model').status).not.toBe('skip');
    const withTools = await preview({ model: 'auto', tools: true });
    expect(withTools.body.needs.tools).toBe(true); expect(withTools.body.steps.find((s: any) => s.model === 'kil/kilo-model')).toMatchObject({ status: 'skip', reason: expect.stringContaining('tool support') });
    const long = await preview({ model: 'auto', tokens: 400000 }); expect(long.body.needs.tokens).toBe(400000);
  } finally { add('kil/kilo-model', 'kil', 2); }
});
test('an unknown model, an unknown key and a request without the admin token are handled', async () => {
  expect((await preview({ model: 'nope/none' })).body.steps[0]).toMatchObject({ status: 'skip', reason: expect.stringContaining('does not know') });
  expect((await preview({ model: 'auto', keyId: 'missing' })).status).toBe(404);
  expect((await preview({ model: 'auto' }, 'wrong-token')).status).toBe(401);
});
