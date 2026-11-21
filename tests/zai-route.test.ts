import { test, expect, afterAll } from 'bun:test';
// State folder comes from tests/setup.ts.
const { settings } = await import('../backend/state');
const { routeForProvider, routeAfter, exhaustedRouteAfter, steadyExit } = await import('../backend/transport');
const { balance, zaiChat, timing, ZAI_ID } = await import('../backend/zai');
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
  expect(steadyExit(route('wireguard', 'proxy', { url: 'wireguard://local' }))).toBe(false);
  expect(steadyExit(route('psiphon', 'proxy'))).toBe(false);
  expect(steadyExit(route('surfshark', 'proxy'))).toBe(false);
});

test('the Z.ai route picker never offers an exit the backend would refuse', async () => {
  // provider-routes imports the dashboard api module, which reads the browser URL at load time.
  const g = globalThis as any; const saved = { location: g.location, sessionStorage: g.sessionStorage, history: g.history };
  g.location = { hash: '', pathname: '/', search: '', href: 'http://localhost/' };
  g.sessionStorage = { removeItem() {} }; g.history = { replaceState() {} };
  const { steadyExit: clientSteadyExit, ZAI_EXITS } = await import('../src/provider-routes');
  g.location = saved.location; g.sessionStorage = saved.sessionStorage; g.history = saved.history;
  for (const id of ['wireguard', 'psiphon', 'surfshark', 'proxy-pool', 'warp'])
    expect(clientSteadyExit(route(id, id === 'warp' ? 'warp' : 'proxy'))).toBe(false);
  expect(clientSteadyExit(route('mine', 'proxy'))).toBe(true);
  expect(clientSteadyExit(route('direct', 'direct'))).toBe(true);
  expect(ZAI_EXITS).toContain('WireGuard');
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

test('default Direct must exist, be enabled, and actually be Direct', () => {
  for (const routes of [[], [route('direct', 'direct', { enabled: false })], [route('direct', 'relay')], [route('direct', 'proxy')]]) {
    settings.routes = routes; expect(() => routeForProvider(zai(), 'm')).toThrow();
  }
  setUp(); expect(routeForProvider(zai(), 'm')).toBe(direct);
});

test('chat and billing fail before dispatch when default Direct is absent or disabled, including a missing provider', async () => {
  const nativeFetch = globalThis.fetch, previous = settings.zai; let calls = 0;
  const p = zai(); const m = { upstreamId: 'GLM-5.3' } as any;
  try {
    settings.zai = { active: 'test-zai', accounts: [{ id: 'test-zai', enabled: true, token: 'test-token', deviceMid: 'test-device' }] } as any;
    globalThis.fetch = (async () => { calls++; throw new Error('unexpected dispatch'); }) as unknown as typeof fetch;
    for (const routes of [[], [route('direct', 'direct', { enabled: false })]]) {
      settings.routes = routes; settings.providers = [p];
      await expect(zaiChat(p, m, { messages: [{ role: 'user', content: 'hello' }] }, new AbortController().signal)).rejects.toMatchObject({ type: 'route_unavailable' });
      await expect(balance('token', 'device')).rejects.toThrow();
    }
    setUp(); settings.providers = [];
    await expect(balance('token', 'device')).rejects.toThrow(); expect(calls).toBe(0);
  } finally { globalThis.fetch = nativeFetch; settings.zai = previous; settings.providers = savedProviders; setUp(); }
});

test('chat rechecks Direct after overload wait and does not dispatch after it is switched off', async () => {
  const nativeFetch = globalThis.fetch, previous = settings.zai, wait = timing.wait; let calls = 0;
  try {
    setUp(); settings.providers = [zai()];
    settings.zai = { active: 'test-zai', accounts: [{ id: 'test-zai', enabled: true, token: 'test-token', deviceMid: 'test-device' }] } as any;
    globalThis.fetch = (async () => { calls++; return Response.json({ error: { type: 'overloaded_error' } }, { status: 529 }); }) as unknown as typeof fetch;
    timing.wait = async () => { settings.routes = settings.routes.map(r => ({ ...r, enabled: false })); };
    await expect(zaiChat(settings.providers[0], { upstreamId: 'GLM-5.3' } as any, { messages: [{ role: 'user', content: 'hello' }] }, new AbortController().signal)).rejects.toMatchObject({ type: 'route_unavailable' });
    expect(calls).toBe(1);
  } finally { globalThis.fetch = nativeFetch; settings.zai = previous; timing.wait = wait; settings.providers = savedProviders; setUp(); }
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
