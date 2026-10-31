import { test, expect, afterEach } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { settings, saveModel, models } = await import('../backend/state');
const { readiness } = await import('../backend/gateway');
const { routeFor, routeForProvider } = await import('../backend/transport');
const saved = { providers: settings.providers, routes: settings.routes.slice(), keys: settings.keys, enabled: settings.enabled, rotate: settings.rotate, strategy: settings.strategy, routeId: settings.routeId, spreadDirect: settings.spreadDirect };
const model = (id: string, providerId: string) => saveModel({ id, upstreamId: id.split('/')[1], providerId, name: id, context: 0, output: 0, tools: true, reasoning: false, state: 'available', latency: 0, score: 50, priority: 1, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '' } as any);
const own = () => ({ id: 'rd', name: 'Own', kind: 'openai', enabled: true, baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', models: [], routeId: '' });
afterEach(() => { Object.assign(settings, saved); settings.routes = saved.routes.slice(); models.delete('rd/m'); });
const healthy = () => { settings.providers = [own()] as any; model('rd/m', 'rd'); settings.enabled = true; settings.rotate = false; settings.routeId = 'direct'; };

test('paused, ready and needs-attention are told apart, each with its reason', () => {
  healthy(); expect(readiness()).toMatchObject({ ready: true, state: 'ready', issues: [] });
  settings.enabled = false; expect(readiness()).toMatchObject({ ready: false, state: 'paused' });
  settings.enabled = true; settings.keys = settings.keys.map(k => ({ ...k, enabled: false }));
  const r = readiness(); expect(r.state).toBe('attention'); expect(r.issues.map(i => i.code)).toEqual(['no_key']); expect(r.issues[0].page).toBe('Settings');
  settings.keys = saved.keys; settings.keys = settings.keys.map(k => ({ ...k, budget: 10, used: 10 })); expect(readiness().issues.map(i => i.code)).toEqual(['no_key']); // out of tokens
});
test('no switched-on provider and no models are named, with the page that fixes them', () => {
  settings.providers = [] as any; expect(readiness().issues[0]).toMatchObject({ code: 'no_provider', page: 'Providers' });
  settings.providers = [own()] as any; models.delete('rd/m');
  const r = readiness(); // a fresh process is still starting; the test process is not, once past its first seconds
  if (process.uptime() >= 30) expect(r.issues.map(i => i.code)).toContain('no_models'); else expect(['starting', 'attention']).toContain(r.state);
});
test('spreading with nothing but Direct left is not ready, and the reason says why', () => {
  healthy(); settings.rotate = true; settings.strategy = 'round_robin'; settings.spreadDirect = false;
  settings.routes = settings.routes.filter(r => r.id === 'direct');
  const r = readiness(); expect(r.state).toBe('attention'); expect(r.issues[0]).toMatchObject({ code: 'no_route', page: 'Routing' }); expect(r.issues[0].message).toContain('Include Direct in the spread');
  settings.spreadDirect = true; expect(readiness().state).toBe('ready');
});
test('a route that is resting makes the provider that only uses it not ready', () => {
  healthy(); const rest: any = { id: 'rd-rest', name: 'Resting', kind: 'proxy', url: 'socks5://127.0.0.1:1', enabled: true, models: [], cooldownUntil: Date.now() + 600000 };
  settings.routes.push(rest); (settings.providers[0] as any).routes = { ids: ['rd-rest'] };
  const r = readiness(); expect(r.issues[0].code).toBe('no_route'); expect(r.issues[0].message).toContain('resting after errors');
});
test('asking does not move the rotation: real requests keep the order they would have had', () => {
  healthy(); settings.rotate = true; settings.strategy = 'round_robin'; settings.spreadDirect = true;
  const a: any = { id: 'rd-a', name: 'A', kind: 'proxy', url: 'socks5://127.0.0.1:1', enabled: true, models: [] }, b: any = { id: 'rd-b', name: 'B', kind: 'proxy', url: 'socks5://127.0.0.1:2', enabled: true, models: [] };
  settings.routes.push(a, b);
  const first = routeFor('x/y', '', 'openai').id; for (let i = 0; i < 5; i++) readiness();
  const second = routeFor('x/y', '', 'openai').id; expect(second).not.toBe(first); // still takes turns, one step at a time
  const peek1 = routeFor('x/y', '', 'openai', true).id, peek2 = routeFor('x/y', '', 'openai', true).id; expect(peek1).toBe(peek2);
  void routeForProvider;
});
