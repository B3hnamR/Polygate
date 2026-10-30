import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN = 'provider-routes-secret';
const { startGateway } = await import('../backend/main');
const { settings } = await import('../backend/state');
const { routeForProvider, routeAfter, exhaustedRouteAfter, providerPicksAgain, providerSwitches, routeFor, providerRoutes } = await import('../backend/transport');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = '';
const saved = { routes: settings.routes.slice(), routeId: settings.routeId, providers: settings.providers.slice(), rotate: settings.rotate };
const call = async (path: string, body: unknown) => { const r = await fetch(base + path, { method: 'POST', headers: { authorization: 'Bearer provider-routes-secret', 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json()) as any }; };
const proxy = (id: string): any => { const r: any = { id, name: id, kind: 'proxy', url: 'socks5://127.0.0.1:1', enabled: true, models: [] }; settings.routes.push(r); return r; };
const relay = (id = 'prs-relay'): any => { const r: any = { id, name: id, kind: 'relay', url: 'https://example-relay.vercel.app', enabled: true, models: [] }; settings.routes.push(r); return r; };
const own = (routes?: any, extra: any = {}): any => ({ id: 'own', name: 'Own server', kind: 'openai', enabled: true, baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', models: [], routeId: routes?.ids?.[0] || '', ...(routes ? { routes } : {}), ...extra });
beforeAll(async () => { gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`; });
afterAll(async () => { await gateway?.close(); });
afterEach(() => { saved.routes.forEach(r => { r.exhaustedUntil = 0; r.cooldownUntil = 0; r.enabled = true; }); settings.routes.length = 0; settings.routes.push(...saved.routes); settings.routeId = saved.routeId; settings.providers = saved.providers.slice(); settings.rotate = saved.rotate; });

test('a provider with a list uses the first usable route in it, and never one outside it', () => {
  proxy('prs-a'); proxy('prs-b'); settings.routeId = 'prs-b';
  const p = own({ ids: ['prs-a', 'direct'] });
  expect(routeForProvider(p, 'own/x').id).toBe('prs-a'); // not the route in use
  settings.routes.find(r => r.id === 'prs-a')!.enabled = false;
  expect(routeForProvider(p, 'own/x').id).toBe('direct');
});

test('with every route in its list unavailable, a provider is refused with the reason, not sent somewhere else', () => {
  proxy('prs-a'); const direct = settings.routes.find(r => r.id === 'direct')!;
  settings.routeId = 'direct';
  const p = own({ ids: ['prs-a'] });
  settings.routes.find(r => r.id === 'prs-a')!.enabled = false;
  let err: any; try { routeForProvider(p, 'own/x'); } catch (e) { err = e; }
  expect(err?.code ?? err?.type).toBeDefined();
  expect(String(err.message)).toContain('prs-a is switched off'); expect(String(err.message)).toContain('Providers page');
  expect(direct.enabled).toBe(true); // Direct was available, and was still not used
});

test('a route paused after failures says when it is tried again, and can be resumed at once', async () => {
  const direct = settings.routes.find(r => r.id === 'direct')!; settings.routeId = 'direct';
  const p = own({ ids: ['direct'] });
  direct.cooldownUntil = Date.now() + 120000; direct.failures = 0; direct.opened = 3;
  let err: any; try { routeForProvider(p, 'own/x'); } catch (e) { err = e; }
  expect(String(err.message)).toMatch(/Direct connection is resting after errors until \d/); expect(String(err.message)).toContain('Resume it on the Routes page');
  expect((await call('/admin/routes/resume', { id: 'direct' })).status).toBe(200);
  expect(direct.cooldownUntil).toBe(0); expect(direct.opened).toBe(0);
  expect(routeForProvider(p, 'own/x').id).toBe('direct');
  expect((await call('/admin/routes/resume', { id: 'nope' })).status).toBe(404);
});

test('a pinned provider never falls back to the public proxy pool', () => {
  const pool = settings.routes.find(r => r.id === 'proxy-pool');
  if (!pool) return; // the pool route only exists once it has been set up
  pool.enabled = true; settings.routeId = 'direct';
  const p = own({ ids: ['direct'] });
  expect(routeAfter(p, settings.routes.find(r => r.id === 'direct')!)).toBeUndefined();
  expect(routeAfter(own(), settings.routes.find(r => r.id === 'direct')!)?.id).not.toBe('proxy-pool'); // follow mode: not for a server of your own either
});

test('in order: after a failure the next route in the list is used, and never one outside it', () => {
  proxy('prs-a'); proxy('prs-b'); proxy('prs-c');
  const p = own({ ids: ['prs-a', 'prs-b'] });
  const get = (id: string) => settings.routes.find(r => r.id === id)!;
  expect(routeAfter(p, get('prs-a'))?.id).toBe('prs-b');
  expect(routeAfter(p, get('prs-b'))?.id).toBe('prs-a'); // back to the start of the same list, never prs-c
  expect(routeAfter(own({ ids: ['prs-a'] }), get('prs-a'))).toBeUndefined();
  expect(providerSwitches(p)).toBe(true); expect(providerPicksAgain(p)).toBe(false);
});

test('spread: requests take turns over the routes in the list', () => {
  proxy('prs-a'); proxy('prs-b');
  const p = own({ ids: ['prs-a', 'prs-b'], spread: true });
  const seen = Array.from({ length: 6 }, () => routeForProvider(p, 'own/x').id);
  expect(new Set(seen)).toEqual(new Set(['prs-a', 'prs-b']));
  expect(seen[0]).not.toBe(seen[1]);
  expect(providerPicksAgain(p)).toBe(true); expect(providerSwitches(p)).toBe(false);
});

test('a provider with no list follows the route in use and the global rotation switch', () => {
  proxy('prs-a'); settings.routeId = 'prs-a';
  const p = own();
  expect(routeForProvider(p, 'own/x').id).toBe(routeFor('own/x', '', 'openai').id);
  settings.rotate = false; expect(providerPicksAgain(p)).toBe(false);
  settings.rotate = true; expect(providerPicksAgain(p)).toBe(true);
});

test('an old single route reads as a list of one, and OpenCode Free keeps its backup exits', () => {
  proxy('prs-a');
  expect(providerRoutes(own(undefined, { routeId: 'prs-a' }))).toEqual({ ids: ['prs-a'], backups: false });
  expect(providerRoutes({ ...own(undefined, { routeId: 'prs-a' }), kind: 'free' })).toEqual({ ids: ['prs-a'], backups: true });
  expect(providerRoutes(own())).toBeUndefined();
});

test('used-up marks only move OpenCode Free, and only to a backup when the list allows backups', () => {
  const direct = settings.routes.find(r => r.id === 'direct')!; proxy('prs-a'); settings.routeId = 'direct';
  direct.exhaustedUntil = Date.now() + 3600e3;
  const strict: any = { ...own({ ids: ['direct'] }), kind: 'free' };
  const lenient: any = { ...own({ ids: ['direct'], backups: true }), kind: 'free' };
  expect(exhaustedRouteAfter(strict, direct)).toBeUndefined();
  expect(exhaustedRouteAfter(lenient, direct)?.id).toBe('prs-a');
  expect(routeForProvider(own({ ids: ['direct'] }), 'own/x').id).toBe('direct'); // not Free: the mark does not apply
});

test('the dashboard saves a list (a relay may be in it for a server of your own), refuses unknown routes, and clears it', async () => {
  proxy('prs-a'); const r = relay();
  const ok = await call('/admin/providers', { name: 'Listed', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', idPrefix: 'listed', routes: { ids: ['prs-a', 'direct'], spread: true } });
  expect(ok.status).toBe(200);
  const saved1 = settings.providers.find(p => p.id === 'listed')!;
  expect(saved1.routes).toEqual({ ids: ['prs-a', 'direct'], spread: true, backups: false }); expect(saved1.routeId).toBe('prs-a');
  const relayed = await call('/admin/providers', { name: 'Bad', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', idPrefix: 'bad1', routes: { ids: [r.id] } });
  expect(relayed.status).toBe(200);
  const unknown = await call('/admin/providers', { name: 'Bad', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', idPrefix: 'bad2', routes: { ids: ['nope'] } });
  expect(unknown.status).toBe(400);
  const free = await call('/admin/providers', { id: 'listed', name: 'Listed', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', routes: null });
  expect(free.status).toBe(200); expect(settings.providers.find(p => p.id === 'listed')!.routes).toBeUndefined();
  expect(settings.providers.find(p => p.id === 'listed')!.routeId).toBe('');
});

test('a route that is the only one chosen for a provider cannot be switched off or deleted; otherwise it leaves the lists', async () => {
  proxy('prs-a'); proxy('prs-b'); settings.routeId = 'direct';
  settings.providers.push(own({ ids: ['prs-a'] }), { ...own({ ids: ['prs-a', 'prs-b'] }), id: 'two', name: 'Two' });
  const off = await call('/admin/routes/toggle', { id: 'prs-a', enabled: false });
  expect(off.status).toBe(409); expect(off.body.error.message).toContain('Own server');
  const del = await call('/admin/routes/delete', { id: 'prs-b' });
  expect(del.status).toBe(200);
  expect(settings.providers.find(p => p.id === 'two')!.routes!.ids).toEqual(['prs-a']);
});
