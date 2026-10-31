import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN = 'spread-secret';
const { startGateway } = await import('../backend/main');
const { settings } = await import('../backend/state');
const { routeFor } = await import('../backend/transport');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = '';
const saved = { routes: settings.routes.slice(), routeId: settings.routeId, rotate: settings.rotate, strategy: settings.strategy, spreadDirect: settings.spreadDirect, failover: settings.failover };
const relay = (id: string): any => { const r: any = { id, name: id, kind: 'relay', url: `https://${id}.example.vercel.app`, enabled: true, models: [] }; settings.routes.push(r); return r; };
beforeAll(async () => { gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`; });
afterAll(async () => { await gateway?.close(); });
afterEach(() => { saved.routes.forEach(r => { r.exhaustedUntil = 0; r.cooldownUntil = 0; r.enabled = true; }); settings.routes.length = 0; settings.routes.push(...saved.routes); settings.routeId = saved.routeId; settings.rotate = saved.rotate; settings.strategy = saved.strategy; settings.spreadDirect = saved.spreadDirect; settings.failover = saved.failover; });
const picks = (n: number, model = 'opencode/x', kind = 'free') => Array.from({ length: n }, () => routeFor(model, '', kind).id);

test('spreading with the old "Selected route" order now takes turns instead of sticking to the first exit', () => {
  relay('sp-a'); relay('sp-b'); relay('sp-c');
  settings.routeId = 'direct'; settings.rotate = true; settings.strategy = 'single';
  const seen = picks(9);
  expect(new Set(seen)).toEqual(new Set(['sp-a', 'sp-b', 'sp-c']));
  expect(seen[0]).not.toBe(seen[1]); // one after another
  expect(seen.includes('direct')).toBe(false); // Direct is left out of the spread by default
});

test('Direct joins the spread when asked, and is skipped while it is used up for OpenCode', () => {
  relay('sp-a'); settings.routeId = 'sp-a'; settings.rotate = true; settings.strategy = 'round_robin'; settings.spreadDirect = true;
  expect(new Set(picks(6))).toEqual(new Set(['direct', 'sp-a']));
  settings.routes.find(r => r.id === 'direct')!.exhaustedUntil = Date.now() + 3600e3;
  expect(new Set(picks(6))).toEqual(new Set(['sp-a'])); // used up: skipped
  expect(new Set(picks(6, 'own/x', 'openai'))).toEqual(new Set(['direct', 'sp-a'])); // a server of your own ignores OpenCode's mark, and a relay carries it
});

test('a used-up relay is skipped while spreading, and the rest keep taking turns', () => {
  relay('sp-a'); relay('sp-b'); settings.rotate = true; settings.strategy = 'round_robin';
  settings.routes.find(r => r.id === 'sp-a')!.exhaustedUntil = Date.now() + 3600e3;
  expect(new Set(picks(6))).toEqual(new Set(['sp-b']));
});

test('without spreading, a used-up selected exit still moves to the first backup and no other', () => {
  relay('sp-a'); relay('sp-b'); settings.rotate = false; settings.routeId = 'direct';
  settings.routes.find(r => r.id === 'direct')!.exhaustedUntil = Date.now() + 3600e3;
  expect(new Set(picks(5))).toEqual(new Set(['sp-a']));
});

test('the dashboard can switch Direct in and out of the spread', async () => {
  const send = (body: unknown) => fetch(base + '/admin/settings', { method: 'POST', headers: { authorization: 'Bearer spread-secret', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect((await send({ spreadDirect: true })).status).toBe(200); expect(settings.spreadDirect).toBe(true);
  expect((await send({ spreadDirect: false })).status).toBe(200); expect(settings.spreadDirect).toBe(false);
  expect((await send({ spreadDirect: 'yes' })).status).toBe(400);
});

test('with spreading on and nothing but Direct left, the refusal says Direct is left out of the spread', () => {
  settings.routes.length = 0; settings.routes.push(...saved.routes.filter(r => r.id === 'direct'));
  settings.routeId = 'direct'; settings.rotate = true; settings.strategy = 'round_robin'; settings.spreadDirect = false;
  let err: any; try { routeFor('opencode/x', '', 'free'); } catch (e) { err = e; }
  expect(err.status).toBe(503); expect(String(err.message)).toContain('Include Direct in the spread');
  settings.spreadDirect = true; expect(routeFor('opencode/x', '', 'free').id).toBe('direct'); // included: it carries the request
});
