import { test, expect, afterAll } from 'bun:test';
// State folder comes from tests/setup.ts.
const { settings } = await import('../backend/state');
const { routeForProvider, routeAfter, exhaustedRouteAfter, steadyExit } = await import('../backend/transport');
const { balance, ZAI_ID } = await import('../backend/zai');
const { startGateway } = await import('../backend/main');

const route = (id: string, kind: string, extra: any = {}) => ({ id, name: id, kind, url: extra.url ?? (kind === 'proxy' ? 'http://127.0.0.1:9' : 'https://relay.example.test'), enabled: true, models: [], ...extra }) as any;
const zai = (routes?: any) => ({ id: ZAI_ID, name: 'Z.ai (ZCode)', kind: 'zai', enabled: true, baseUrl: '', apiKey: '', models: [], routeId: '', ...(routes ? { routes } : {}) }) as any;
const savedRoutes = settings.routes, savedProviders = settings.providers;
const direct = route('direct', 'direct', { url: '' });
const setUp = (...extra: any[]) => { settings.routes = [direct, route('mine', 'proxy'), route('iad1', 'relay'), route('proxy-pool', 'proxy'), route('warp', 'warp', { url: '' }), ...extra]; };
afterAll(() => { settings.routes = savedRoutes; settings.providers = savedProviders; });

test('only an exit with one steady address counts: Direct or a proxy of your own', () => {
  setUp(); const yes = settings.routes.filter(steadyExit).map(r => r.id);
  expect(yes).toEqual(['direct', 'mine']);
  expect(steadyExit(route('list', 'proxy', { poolUrls: ['http://127.0.0.1:1'] }))).toBe(false);
});

test('without a choice Z.ai uses Direct; with one it uses that proxy and nothing else', () => {
  setUp();
  expect(routeForProvider(zai(), 'm').id).toBe('direct');
  const p = zai({ ids: ['mine'] }); expect(routeForProvider(p, 'm').id).toBe('mine');
  expect(routeAfter(p, settings.routes[1])).toBeUndefined(); expect(exhaustedRouteAfter(p, settings.routes[1])).toBeUndefined();
  expect(routeAfter(zai(), direct)).toBeUndefined();
});

test('a paused or switched-off choice fails with the reason, and does not fall back to Direct', () => {
  setUp();
  expect(() => routeForProvider(zai({ ids: ['mine'], paused: ['mine'] }), 'm')).toThrow(/is paused/);
  settings.routes = settings.routes.map(r => r.id === 'mine' ? { ...r, enabled: false } : r);
  expect(() => routeForProvider(zai({ ids: ['mine'] }), 'm')).toThrow(/switched off/);
});

test('billing requests leave through the chosen proxy', async () => {
  const seen: string[] = [];
  const proxy = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) { seen.push(req.url); return Response.json({ code: 0, data: { plans: [], quotas: [] } }); } });
  try {
    setUp(route('local-proxy', 'proxy', { url: `http://127.0.0.1:${proxy.port}` }));
    settings.providers = [zai({ ids: ['local-proxy'] })];
    // A distinct loopback target proves proxy forwarding without an external hostname or DNS.
    await balance('token', 'device', 'http://127.0.0.2:9/api/v1').catch(() => {});
    expect(seen.some(u => u.startsWith('http://127.0.0.2:9/api/v1/'))).toBe(true);
  } finally { proxy.stop(true); settings.providers = savedProviders; }
});

test('the admin API takes one steady exit for Z.ai and refuses the rest', async () => {
  const saved = process.env.POLYGATE_ADMIN_TOKEN; process.env.POLYGATE_ADMIN_TOKEN = 'zai-route-secret';
  const gateway = await startGateway(0);
  const post = (routes: any) => fetch(`http://127.0.0.1:${gateway.port}/admin/providers`, { method: 'POST', headers: { authorization: 'Bearer zai-route-secret', 'content-type': 'application/json' }, body: JSON.stringify({ ...zai(), routes }) });
  try {
    setUp(); settings.providers = [zai()];
    expect((await post({ ids: ['mine'] })).status).toBe(200); expect(settings.providers[0].routes?.ids).toEqual(['mine']);
    for (const id of ['iad1', 'proxy-pool', 'warp']) { const r = await post({ ids: [id] }); expect(r.status).toBe(400); expect(((await r.json()) as any).error.message).toMatch(/steady address/); }
    expect((await post({ ids: ['mine', 'direct'] })).status).toBe(400);
    expect((await post({ ids: ['direct'] })).status).toBe(200); expect(settings.providers[0].routes).toBeUndefined();
  } finally { await gateway.close(); settings.providers = savedProviders; if (saved === undefined) delete process.env.POLYGATE_ADMIN_TOKEN; else process.env.POLYGATE_ADMIN_TOKEN = saved; }
});
