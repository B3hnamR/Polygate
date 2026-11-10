import { test, expect, beforeEach, afterAll } from 'bun:test';
// State folder comes from tests/setup.ts.
const { settings, models, saveModel } = await import('../backend/state');
const { __setProbe, __resetChecks, startCheck, stopCheck, checkRuns, autoCheckTick, nextAutoCheck, autoCheckMinutes } = await import('../backend/model-checks');
const { GatewayError } = await import('../backend/queue');
const { routeForProvider, providerRoutes, routeAfter } = await import('../backend/transport');

const PID = 'check-provider';
const model = (id: string, extra: any = {}) => saveModel({ id: `${PID}/${id}`, upstreamId: id, providerId: PID, name: id, context: 0, output: 0, reasoning: false, tools: true, state: 'unchecked', latency: 0, score: 0, priority: 1, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '', ...extra } as any);
const provider = (extra: any = {}) => ({ id: PID, name: 'Check provider', kind: 'openai', enabled: true, baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', models: [], routeId: '', ...extra }) as any;
const finished = async (tries = 200) => { for (let i = 0; i < tries && checkRuns()[PID]?.running; i++) await new Promise(r => setTimeout(r, 5)); return checkRuns()[PID]; };

beforeEach(() => {
  __resetChecks(); __setProbe();
  settings.providers = settings.providers.filter(p => p.id !== PID);
  for (const id of [...models.keys()]) if (id.startsWith(PID + '/')) models.delete(id);
  settings.providers.push(provider());
});
afterAll(() => { __setProbe(); settings.providers = settings.providers.filter(p => p.id !== PID); for (const id of [...models.keys()]) if (id.startsWith(PID + '/')) models.delete(id); });

test('a run checks every model of the provider and counts the answers', async () => {
  model('a'); model('b', { state: 'unavailable' }); model('c');
  const asked: string[] = [];
  __setProbe(async id => { asked.push(id); return { model: models.get(id)!, status: id.endsWith('/b') ? 404 : 200 }; });
  expect(startCheck(PID).total).toBe(3);
  const run = await finished();
  expect(asked.sort()).toEqual([`${PID}/a`, `${PID}/b`, `${PID}/c`]); // an unavailable model is checked too
  expect(run).toMatchObject({ running: false, done: 3, ok: 2, failed: 1 }); expect(run.note).toBeUndefined();
});

test('a model that is resting is left out, and a run needs at least one model to check', () => {
  model('rest', { cooldownUntil: Date.now() + 60000 });
  expect(() => startCheck(PID)).toThrow(/can be checked/);
});

test('a run stops when the provider asks to slow down', async () => {
  settings.providers = settings.providers.map(p => p.id === PID ? provider({ kind: 'kilo' }) : p); // one at a time
  for (const id of ['a', 'b', 'c', 'd']) model(id);
  let calls = 0; __setProbe(async id => { calls++; return { model: models.get(id)!, status: calls === 2 ? 429 : 200 }; });
  startCheck(PID); const run = await finished();
  expect(calls).toBe(2); expect(run.note).toMatch(/slow down/); expect(run.running).toBe(false);
}, 5000);

test('a model that is only out of its own allowance is passed over: the run goes on to the others', async () => {
  settings.providers = settings.providers.map(p => p.id === PID ? provider({ kind: 'zai' }) : p); // one at a time, like Z.ai
  for (const id of ['glm', 'flash', 'third']) model(id);
  const asked: string[] = [];
  __setProbe(async id => { asked.push(id); return id.endsWith('/glm') ? { model: models.get(id)!, status: 429, scope: 'model' as const } : { model: models.get(id)!, status: 200 }; });
  startCheck(PID); const run = await finished(1400); // a shared provider waits a second between models
  expect(asked).toEqual([`${PID}/glm`, `${PID}/flash`, `${PID}/third`]);
  expect(run).toMatchObject({ done: 3, ok: 2, failed: 1, limited: 1, running: false });
  expect(run.note).toBe('1 model has no allowance of its own left for now; the other models were still checked.');
}, 8000);

test('a 429 with no known scope still stops the run, even after a model-scoped one', async () => {
  settings.providers = settings.providers.map(p => p.id === PID ? provider({ kind: 'zai' }) : p);
  for (const id of ['a', 'b', 'c']) model(id);
  let calls = 0; __setProbe(async id => { calls++; return { model: models.get(id)!, status: 429, ...(calls === 1 ? { scope: 'model' as const } : {}) }; });
  startCheck(PID); const run = await finished(1400);
  expect(calls).toBe(2); expect(run.limited).toBe(1); expect(run.note).toMatch(/slow down.*1 model has no allowance/);
}, 8000);

test('a run stops when no route can take the checks, and when asked to stop', async () => {
  settings.providers = settings.providers.map(p => p.id === PID ? provider({ kind: 'kilo' }) : p);
  for (const id of ['a', 'b', 'c']) model(id);
  __setProbe(async () => { throw new GatewayError('No route for this', 503, 'route_unavailable'); });
  startCheck(PID); let run = await finished(); expect(run.done).toBe(1); expect(run.note).toBe('No route for this');
  __resetChecks();
  __setProbe(async id => { stopCheck(PID); return { model: models.get(id)!, status: 200 }; });
  startCheck(PID); run = await finished(); expect(run.done).toBe(1); expect(run.note).toMatch(/Stopped after 1 of 3/);
}, 5000);

test('a second start joins the run in progress; a switched-off provider cannot be checked', async () => {
  model('a'); let release = () => {}; __setProbe(id => new Promise(resolve => { release = () => resolve({ model: models.get(id)!, status: 200 }); }));
  const first = startCheck(PID); expect(startCheck(PID)).toBe(first); release(); await finished();
  settings.providers = settings.providers.map(p => p.id === PID ? provider({ enabled: false }) : p);
  expect(() => startCheck(PID)).toThrow(/switched off/);
});

test('automatic checks are off until a provider asks for them, and take the model checked longest ago', async () => {
  const now = Date.now(); model('recent', { checkedAt: now - 60000 }); model('old', { checkedAt: now - 7200000 }); model('gone', { state: 'unavailable', checkedAt: now - 9000000 });
  const asked: string[] = []; __setProbe(async id => { asked.push(id); return { model: models.get(id)!, status: 200 }; });
  await autoCheckTick(now); expect(asked).toEqual([]);
  settings.providers = settings.providers.map(p => p.id === PID ? provider({ autoCheckMinutes: 60 }) : p);
  await autoCheckTick(now); expect(asked).toEqual([`${PID}/gone`]); // an unavailable model is found again when it comes back
  await autoCheckTick(now); expect(asked).toEqual([`${PID}/gone`, `${PID}/old`]);
  await autoCheckTick(now); expect(asked.length).toBe(2); // the recent one is not due
});

test('automatic checks wait 15 minutes after the provider asks to slow down, and while the gateway is paused', async () => {
  const now = Date.now(); model('a', { checkedAt: 1 }); model('b', { checkedAt: 2 });
  settings.providers = settings.providers.map(p => p.id === PID ? provider({ autoCheckMinutes: 60 }) : p);
  let calls = 0; __setProbe(async id => { calls++; return { model: models.get(id)!, status: 429 }; });
  const enabled = settings.enabled;
  try { settings.enabled = false; await autoCheckTick(now); expect(calls).toBe(0); } finally { settings.enabled = enabled; }
  await autoCheckTick(now); expect(calls).toBe(1);
  await autoCheckTick(now + 60000); expect(calls).toBe(1);
  await autoCheckTick(now + 16 * 60000); expect(calls).toBe(2);
});

test('automatic checks do not back the provider off for one model\'s own allowance', async () => {
  const now = Date.now(); model('a', { checkedAt: 1 }); model('b', { checkedAt: 2 });
  settings.providers = settings.providers.map(p => p.id === PID ? provider({ autoCheckMinutes: 60 }) : p);
  let calls = 0; __setProbe(async id => { calls++; return { model: models.get(id)!, status: 429, scope: 'model' as const }; });
  await autoCheckTick(now); await autoCheckTick(now + 60000); expect(calls).toBe(2);
});

test('the old all-providers switch still counts, without Kilo', () => {
  const had = settings.autoProbe;
  try {
    settings.autoProbe = true;
    expect(autoCheckMinutes(provider())).toBe(settings.refreshMinutes); expect(autoCheckMinutes(provider({ kind: 'kilo' }))).toBe(0);
    expect(autoCheckMinutes(provider({ autoCheckMinutes: 0 }))).toBe(0);
    settings.autoProbe = false; expect(autoCheckMinutes(provider())).toBe(0); expect(nextAutoCheck(provider())).toBeUndefined();
  } finally { settings.autoProbe = had; }
});

// ---- a paused line
const ROUTES = ['paused-a', 'paused-b'];
const withRoutes = (run: () => void) => {
  const saved = settings.routes; settings.routes = [...saved, ...ROUTES.map(id => ({ id, name: id, kind: 'proxy', url: 'http://127.0.0.1:9', enabled: true, models: [] }) as any)];
  try { run(); } finally { settings.routes = saved; }
};
test('a paused line keeps its place and is not used', () => withRoutes(() => {
  const p = provider({ routes: { ids: ROUTES, paused: ['paused-a'] } });
  expect(providerRoutes(p)!.ids).toEqual(['paused-b']); expect(routeForProvider(p, 'm').id).toBe('paused-b');
  expect(routeAfter(p, settings.routes.find(r => r.id === 'paused-b')!)).toBeUndefined();
  expect(p.routes.ids).toEqual(ROUTES);
}));
test('with every line paused the request fails with the reason, without going anywhere else', () => withRoutes(() => {
  const p = provider({ kind: 'free', routes: { ids: ROUTES, paused: ROUTES, backups: true } });
  expect(() => routeForProvider(p, 'm')).toThrow(/Every route of Check provider is paused/);
}));

// ---- the admin API
const { startGateway } = await import('../backend/main');
test('the admin API keeps paused lines inside the list, checks the automatic choice, and starts and stops a run', async () => {
  const saved = process.env.POLYGATE_ADMIN_TOKEN; process.env.POLYGATE_ADMIN_TOKEN = 'checks-test-secret';
  const gateway = await startGateway(0);
  const post = (p: string, body: unknown) => fetch(`http://127.0.0.1:${gateway.port}${p}`, { method: 'POST', headers: { authorization: 'Bearer checks-test-secret', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const routes = settings.routes; settings.routes = [...routes, { id: 'paused-a', name: 'paused-a', kind: 'proxy', url: 'http://127.0.0.1:9', enabled: true, models: [] } as any];
    try {
      expect((await post('/admin/providers', { ...provider(), routes: { ids: ['paused-a'], paused: ['paused-a', 'not-in-the-list'] }, autoCheckMinutes: 360 })).status).toBe(200);
      const p = settings.providers.find(x => x.id === PID)!; expect(p.routes!.paused).toEqual(['paused-a']); expect(p.autoCheckMinutes).toBe(360);
      expect((await post('/admin/providers', { ...provider(), routes: { ids: ['paused-a'] } })).status).toBe(200);
      expect(settings.providers.find(x => x.id === PID)!.routes!.paused).toBeUndefined(); expect(settings.providers.find(x => x.id === PID)!.autoCheckMinutes).toBe(360); // left out: kept
      expect((await post('/admin/providers', { ...provider(), autoCheckMinutes: 7 })).status).toBe(400);
    } finally { settings.routes = routes; settings.providers = settings.providers.map(x => x.id === PID ? provider() : x); }
    model('a'); let release = () => {}; __setProbe(id => new Promise(resolve => { release = () => resolve({ model: models.get(id)!, status: 200 }); }));
    const started = await post('/admin/probe/provider', { id: PID }); expect(started.status).toBe(200); expect((await started.json() as any).total).toBe(1);
    expect((await (await fetch(`http://127.0.0.1:${gateway.port}/admin/state`, { headers: { authorization: 'Bearer checks-test-secret' } })).json() as any).checks[PID].running).toBe(true);
    expect((await post('/admin/probe/provider', { id: PID, stop: true })).status).toBe(200); release(); await finished();
    expect((await post('/admin/probe/provider', { id: 'nobody' })).status).toBe(404);
  } finally { await gateway.close(); if (saved === undefined) delete process.env.POLYGATE_ADMIN_TOKEN; else process.env.POLYGATE_ADMIN_TOKEN = saved; }
});
