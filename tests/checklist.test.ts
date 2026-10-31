import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN = 'checklist-secret';
const { startGateway } = await import('../backend/main');
const { settings, saveModel, models } = await import('../backend/state');
const { readiness } = await import('../backend/gateway');
const { discover } = await import('../backend/providers');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = '';
let modelsStatus = 200;
const up = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { if (new URL(req.url).pathname.endsWith('/models')) return modelsStatus === 200 ? Response.json({ data: [{ id: 'm1' }] }) : new Response('boom', { status: modelsStatus }); return new Response('{}'); } });
const add = (id: string, providerId: string) => saveModel({ id, upstreamId: id.split('/')[1], providerId, name: id, context: 0, output: 0, tools: true, reasoning: false, state: 'available', latency: 0, score: 50, priority: 1, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '' } as any);
const own = (extra: any = {}) => ({ id: 'ck', name: 'Own', kind: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${up.port}/v1`, apiKey: '', models: [], routeId: 'direct', ...extra });
const saved: any = {};
beforeAll(async () => {
  Object.assign(saved, { providers: settings.providers, routes: settings.routes.slice(), keys: settings.keys, enabled: settings.enabled, rotate: settings.rotate, routeId: settings.routeId, warp: settings.warp });
  gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`;
});
afterEach(() => { Object.assign(settings, { providers: saved.providers, keys: saved.keys, enabled: saved.enabled, rotate: saved.rotate, routeId: saved.routeId, warp: saved.warp }); settings.routes.length = 0; settings.routes.push(...saved.routes); for (const r of settings.routes) { r.cooldownUntil = 0; r.enabled = true; } models.delete('ck/m1'); });
afterAll(async () => { await gateway?.close(); up.stop(true); });
const ids = () => readiness().checklist.map(i => i.id);
const find = (id: string) => readiness().checklist.find(i => i.id === id);
const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { authorization: 'Bearer checklist-secret', 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('a working setup has an empty checklist, and the problems are named once they appear', () => {
  settings.providers = [own()] as any; add('ck/m1', 'ck'); settings.enabled = true; settings.rotate = false; settings.routeId = 'direct';
  expect(readiness().checklist).toEqual([]);
  settings.keys = settings.keys.map(k => ({ ...k, enabled: false }));
  expect(find('no_key')).toMatchObject({ severity: 'blocking', page: 'Settings', title: 'No client key can be used' });
});
test('a resting route is listed with a button that retries it, and the item is gone once it is retried', async () => {
  settings.providers = [own({ routeId: 'ck-rest', routes: { ids: ['ck-rest'] } })] as any; add('ck/m1', 'ck');
  settings.routes.push({ id: 'ck-rest', name: 'Resting route', kind: 'proxy', url: 'socks5://127.0.0.1:1', enabled: true, models: [], cooldownUntil: Date.now() + 600000 } as any);
  const item = find('rest:ck-rest')!; expect(item).toMatchObject({ severity: 'warning', page: 'Routing', fix: { label: 'Try it again now', endpoint: '/admin/routes/resume', body: { id: 'ck-rest' } } });
  expect(find('no_route')!.severity).toBe('blocking'); // the provider has nowhere else to go
  expect((await post(item.fix!.endpoint, item.fix!.body)).status).toBe(200);
  expect(ids()).not.toContain('rest:ck-rest'); expect(ids()).not.toContain('no_route');
});
test('WARP that is not connected is listed when something uses it, with a reconnect button, and left out when WARP is not used', () => {
  settings.warp = { engine: 'embedded', autoStart: false, pool: 1, rotateMinutes: 0, helperPath: '', endpoint: '', split: 'auto' } as any;
  settings.providers = [own()] as any; add('ck/m1', 'ck'); settings.rotate = false; settings.routeId = 'direct';
  settings.routes.push({ id: 'warp', name: 'Cloudflare WARP', kind: 'warp', url: 'socks5://127.0.0.1:40000', enabled: true, models: [], managed: true } as any);
  expect(ids()).not.toContain('warp_down'); // nothing is assigned to it
  settings.providers = [own({ routes: { ids: ['warp', 'direct'] } })] as any;
  expect(find('warp_down')).toMatchObject({ title: 'Cloudflare WARP is not connected', detail: 'Requests assigned to WARP cannot leave.', fix: { label: 'Reconnect WARP', endpoint: '/admin/warp/connect' } });
  settings.warp = { ...(settings.warp as any), engine: 'disabled' }; expect(ids()).not.toContain('warp_down'); // switched off on purpose
});
test('a key that ran out is listed while another key works, and one switched off on purpose is not', () => {
  settings.providers = [own()] as any; add('ck/m1', 'ck'); settings.enabled = true;
  const [first] = settings.keys;
  settings.keys = [{ ...first, budget: 10, used: 10 }, { ...first, id: 'k2', name: 'Second', value: 'pg_second_key_value', budget: undefined, used: 0 }, { ...first, id: 'k3', name: 'Off', value: 'pg_off_key_value', enabled: false }] as any;
  expect(ids().filter(i => i.startsWith('key:'))).toEqual([`key:${first.id}`]); expect(find(`key:${first.id}`)!.title).toContain('used up its token budget'); expect(ids()).not.toContain('no_key');
});
test('a catalog that could not be read is listed with a refresh button and clears when a refresh works', async () => {
  settings.providers = [own({ id: 'ck' })] as any; settings.enabled = true;
  modelsStatus = 500; await discover().catch(() => {});
  const item = find('catalog:ck')!; expect(item).toMatchObject({ severity: 'warning', page: 'Models', fix: { label: 'Refresh catalog', endpoint: '/admin/discover' } });
  modelsStatus = 200; await discover(); expect(ids()).not.toContain('catalog:ck');
});
test('a provider that lists a deleted route is named', () => {
  settings.providers = [own({ routeId: 'gone', routes: { ids: ['gone', 'direct'] } })] as any; add('ck/m1', 'ck');
  expect(find('missing:ck')).toMatchObject({ severity: 'warning', page: 'Providers' });
});
test('the list never turns on something the user switched off: no fix switches a route on, and Direct stays off', () => {
  settings.providers = [own({ routeId: 'ck-rest', routes: { ids: ['ck-rest'] } })] as any; add('ck/m1', 'ck');
  settings.routes.push({ id: 'ck-rest', name: 'Resting route', kind: 'proxy', url: 'socks5://127.0.0.1:1', enabled: true, models: [], cooldownUntil: Date.now() + 600000 } as any);
  const direct = settings.routes.find(r => r.id === 'direct')!; direct.enabled = false;
  const items = readiness().checklist;
  expect(items.every(i => !i.fix || !/toggle|enable/.test(i.fix.endpoint))).toBe(true); expect(direct.enabled).toBe(false);
});
test('the same problems keep the same ids from one look to the next, so a screen can keep them until they are fixed', () => {
  settings.providers = [own({ routeId: 'ck-rest', routes: { ids: ['ck-rest'] } })] as any; add('ck/m1', 'ck');
  settings.routes.push({ id: 'ck-rest', name: 'Resting route', kind: 'proxy', url: 'socks5://127.0.0.1:1', enabled: true, models: [], cooldownUntil: Date.now() + 600000 } as any);
  expect(ids()).toEqual(ids()); expect(readiness().checklist[0].severity).toBe('blocking'); // what stops requests comes first
});
