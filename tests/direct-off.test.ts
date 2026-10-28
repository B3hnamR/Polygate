import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN = 'direct-off-secret';
const { startGateway } = await import('../backend/main');
const { settings } = await import('../backend/state');
const { routeFor, describeRoutes, backupChain } = await import('../backend/transport');
const { mcpDefaultRoute } = await import('../backend/mcp');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = '';
const savedRoutes = settings.routes.slice(); const savedRoute = settings.routeId; const savedRotate = settings.rotate; const savedAllow = settings.allowDirect;
const toggle = async (id: string, enabled: boolean) => { const r = await fetch(base + '/admin/routes/toggle', { method: 'POST', headers: { authorization: 'Bearer direct-off-secret', 'content-type': 'application/json' }, body: JSON.stringify({ id, enabled }) }); return { status: r.status, body: (await r.json()) as any }; };
const proxy = (id: string) => { const r: any = { id, name: 'Proxy ' + id, kind: 'proxy', url: 'socks5://127.0.0.1:1', enabled: true, models: [] }; settings.routes.push(r); return r; };
beforeAll(async () => { gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`; });
afterAll(async () => { await gateway?.close(); });
// Other test files leave providers pinned to Direct in the shared state, which (correctly) stops it being switched off: these tests start without that.
const savedProviders = settings.providers;
beforeEach(() => { settings.providers = savedProviders.map(p => ({ ...p, routeId: '' })); });
afterEach(() => { settings.providers = savedProviders; settings.routes.length = 0; settings.routes.push(...savedRoutes); settings.routes.forEach(r => { if (r.id === 'direct') r.enabled = true; }); settings.routeId = savedRoute; settings.rotate = savedRotate; settings.allowDirect = savedAllow; });

test('Direct cannot be switched off while it is the selected route, or while nothing else is on', async () => {
  settings.routeId = 'direct';
  const selected = await toggle('direct', false); expect(selected.status).toBe(409); expect(selected.body.error.message).toContain('Select another route');
  settings.routeId = 'direct'; const alone = proxy('do-a'); alone.enabled = false; settings.routeId = 'do-a'; // another route exists but is off, and is the selected one
  const none = await toggle('direct', false); expect(none.status).toBe(409);
  expect(settings.routes.find(r => r.id === 'direct')!.enabled).toBe(true);
});

test('with another route on and selected, Direct can be switched off: it is then never used, and can be switched back on', async () => {
  const p = proxy('do-b'); settings.routeId = 'do-b';
  expect((await toggle('direct', false)).status).toBe(200);
  const direct = settings.routes.find(r => r.id === 'direct')!; expect(direct.enabled).toBe(false);
  expect(routeFor('opencode/x').id).toBe('do-b');
  settings.allowDirect = true; // even as a last resort
  expect(() => routeFor('opencode/x', 'direct')).toThrow(/disabled or missing/); // asking for it by name is refused too
  expect(describeRoutes().direct.role).toBe('off');
  expect(backupChain().find(r => r.id === 'direct')!.why).toBe('switched off'); expect(backupChain().find(r => r.id === 'direct')!.usable).toBe(false);
  expect(mcpDefaultRoute()).toBe('do-b'); p.enabled = true;
  expect((await toggle('direct', true)).status).toBe(200); expect(mcpDefaultRoute()).toBe('direct'); expect(describeRoutes().direct.role).not.toBe('off');
});

test('with Direct off, MCP uses another route that can carry it, never a relay', async () => {
  const relay: any = { id: 'do-relay', name: 'Relay', kind: 'relay', url: 'https://r.example/', enabled: true, models: [] }; settings.routes.push(relay);
  const p = proxy('do-c'); settings.routeId = 'do-relay';
  expect((await toggle('direct', false)).status).toBe(200);
  expect(mcpDefaultRoute()).toBe('do-c'); expect(p.enabled).toBe(true);
});

test('a provider pinned to Direct keeps it on: Direct is not switched off from under it', async () => {
  proxy('do-d'); settings.routeId = 'do-d'; settings.providers = savedProviders.map((p, i) => ({ ...p, routeId: i === 0 ? 'direct' : '' }));
  const r = await toggle('direct', false); expect(r.status).toBe(409); expect(r.body.error.message).toContain('Select another route');
});
