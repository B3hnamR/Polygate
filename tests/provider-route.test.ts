import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN = 'provider-route-secret';
const { startGateway } = await import('../backend/main');
const { settings } = await import('../backend/state');
const { routeFor } = await import('../backend/transport');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = '';
const saved = { routes: settings.routes.slice(), routeId: settings.routeId, providers: settings.providers.slice(), rotate: settings.rotate };
const post = async (path: string, body: unknown) => { const r = await fetch(base + path, { method: 'POST', headers: { authorization: 'Bearer provider-route-secret', 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json()) as any }; };
const relay = () => { const r: any = { id: 'pr-relay', name: 'A relay', kind: 'relay', url: 'https://example-relay.vercel.app', enabled: true, models: [] }; settings.routes.push(r); settings.routeId = r.id; return r; };
beforeAll(async () => { gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`; });
afterAll(async () => { await gateway?.close(); });
afterEach(() => { saved.routes.forEach(r => { r.exhaustedUntil = 0; }); settings.routes.length = 0; settings.routes.push(...saved.routes); settings.routes.forEach(r => { if (r.id === 'direct') r.enabled = true; }); settings.routeId = saved.routeId; settings.providers = saved.providers.slice(); settings.rotate = saved.rotate; });

test('a new provider takes the model prefix the user typed, or one made from its name, never a random one', async () => {
  const typed = await post('/admin/providers', { name: 'My server', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', idPrefix: 'mybox', routeId: 'direct' });
  expect(typed.status).toBe(200); expect(typed.body.id).toBe('mybox');
  const derived = await post('/admin/providers', { name: 'Test 1 (lab)', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', routeId: 'direct' });
  expect(derived.body.id).toBe('test-1-lab');
  const again = await post('/admin/providers', { name: 'Test 1 (lab)', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', routeId: 'direct' });
  expect(again.status).toBe(200); expect(again.body.id).toMatch(/^test-1-lab-[0-9a-f]{6}$/); // the name is taken: made unique, not refused
  for (const bad of ['My Box', 'a/b', '-x', 'x'.repeat(31), 'opencode', 'kilo', 'mybox']) {
    const r = await post('/admin/providers', { name: 'Other', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', idPrefix: bad });
    expect(r.status).toBe(400);
  }
  expect(settings.providers.some(p => p.id.startsWith('p-'))).toBe(false);
});

test('a provider on its own server cannot be pinned to a relay, which only carries OpenCode and Kilo traffic', async () => {
  const r = relay();
  const own = await post('/admin/providers', { name: 'Own', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', routeId: r.id });
  expect(own.status).toBe(400); expect(own.body.error.message).toContain('Relays only carry OpenCode and Kilo');
  const free = await post('/admin/providers', { name: 'Kilo extra', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', routeId: 'direct' });
  expect(free.status).toBe(200);
});

test('when a relay is the route in use, a provider on its own server is reached directly, and OpenCode still uses the relay', () => {
  const r = relay();
  expect(routeFor('own/model', '', 'openai').id).toBe('direct');
  expect(routeFor('opencode/x', '', 'free').id).toBe(r.id);
  expect(routeFor('kilo/x', '', 'kilo').id).toBe(r.id);
  settings.routes.find(x => x.id === 'direct')!.enabled = false;
  expect(() => routeFor('own/model', '', 'openai')).toThrow(/relay routes only carry/);
});

test('rotation never offers a relay to a provider on its own server', () => {
  const r = relay(); settings.rotate = true; settings.strategy = 'round_robin';
  const proxy: any = { id: 'pr-proxy', name: 'A proxy', kind: 'proxy', url: 'socks5://127.0.0.1:1', enabled: true, models: [] }; settings.routes.push(proxy);
  const seen = new Set(Array.from({ length: 6 }, () => routeFor('own/model', '', 'openai').id));
  expect(seen.has(r.id)).toBe(false); expect(seen.has('pr-proxy')).toBe(true);
  const free = new Set(Array.from({ length: 6 }, () => routeFor('opencode/x', '', 'free').id));
  expect(free.has(r.id)).toBe(true);
});

test('a route that is used up for OpenCode Free is still the right one for a provider on its own server', () => {
  const direct = settings.routes.find(r => r.id === 'direct')!; settings.routeId = 'direct';
  const proxy: any = { id: 'pr-proxy2', name: 'A proxy', kind: 'proxy', url: 'socks5://127.0.0.1:1', enabled: true, models: [] }; settings.routes.push(proxy);
  direct.exhaustedUntil = Date.now() + 3600e3;
  expect(routeFor('opencode/x', '', 'free').id).toBe('pr-proxy2'); // OpenCode moves to a clean exit
  expect(routeFor('own/model', '', 'openai').id).toBe('direct'); // the user's own server does not care
  expect(routeFor('kilo/x', '', 'kilo').id).toBe('direct');
  settings.rotate = true; settings.strategy = 'round_robin';
  expect(routeFor('own/model', '', 'openai').id).toBe('pr-proxy2'); // rotation still only uses routes that are not failing
});
