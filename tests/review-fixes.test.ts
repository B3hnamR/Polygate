import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN = 'review-fixes-secret';
const { startGateway } = await import('../backend/main');
const { settings } = await import('../backend/state');
const { isPublicHost, parseProxyText } = await import('../backend/proxy-engine');
const { clientIp } = await import('../backend/auth');
const { cleanServer, mcpConfig } = await import('../backend/mcp');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = '';
const saved = { routes: settings.routes.slice(), routeId: settings.routeId, providers: settings.providers.slice(), keys: settings.keys.slice(), mcp: JSON.stringify(settings.mcp ?? null), admin: JSON.stringify(settings.admin ?? null) };
const call = async (path: string, body: unknown, token = 'review-fixes-secret') => { const r = await fetch(base + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json().catch(() => ({}))) as any }; };
beforeAll(async () => { gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`; });
afterAll(async () => { await gateway?.close(); });
afterEach(() => { settings.routes.length = 0; settings.routes.push(...saved.routes); settings.routeId = saved.routeId; settings.providers = saved.providers.slice(); settings.keys = saved.keys.slice(); settings.mcp = JSON.parse(saved.mcp) ?? undefined; settings.admin = JSON.parse(saved.admin) ?? undefined; delete process.env.POLYGATE_TRUST_PROXY; });

test('addresses of this machine and its network are refused in every IPv6 spelling', () => {
  for (const bad of ['::1', '0:0:0:0:0:0:0:1', '::', 'fe80::1', 'fe81::1', 'febf::1', 'fc00::1', 'fd12::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.5', '::ffff:192.168.1.1', '64:ff9b::a00:1', '::127.0.0.1'])
    expect(isPublicHost(bad)).toBe(false);
  for (const good of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '8.8.8.8']) expect(isPublicHost(good)).toBe(true);
});

test('a list made of many address ranges cannot grow past the candidate limit', () => {
  const text = Array.from({ length: 4000 }, (_, i) => `${1 + (i >> 8)}.${i & 255}.1.0/24:8080`).join('\n');
  const found = parseProxyText(text, 'http');
  expect(found.length).toBeLessThanOrEqual(12000); expect(found.length).toBeGreaterThan(0);
});

test('a forwarded chain shorter than the trusted proxies is not believed', () => {
  process.env.POLYGATE_TRUST_PROXY = '2';
  const req = (xff: string) => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: '10.0.0.9' } }) as any;
  expect(clientIp(req('203.0.113.7, 198.51.100.2'))).toBe('203.0.113.7'); // both hops present: the entry the first proxy wrote
  expect(clientIp(req('6.6.6.6'))).toBe('10.0.0.9'); // one hop missing: the connection's own address, not the forged entry
  expect(clientIp(req(''))).toBe('10.0.0.9');
});

test('a saved token or key does not follow an edited address to another server', async () => {
  const added = await call('/admin/routes', { kind: 'proxy', name: 'Secret proxy', url: 'http://user:pw@203.0.113.10:8080', token: 'real-secret' });
  expect(added.status).toBe(200);
  const moved = await call('/admin/routes', { id: added.body.id, kind: 'proxy', name: 'Secret proxy', url: 'http://203.0.113.99:8080', token: '••••••••' });
  expect(moved.status).toBe(400); expect(moved.body.error.message).toContain('Enter the access token again');
  expect(settings.routes.find(r => r.id === added.body.id)!.token).toBe('real-secret');
  const prov = await call('/admin/providers', { name: 'Keyed', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-real', idPrefix: 'keyed', routeId: 'direct' });
  const movedProvider = await call('/admin/providers', { id: prov.body.id, name: 'Keyed', kind: 'openai', baseUrl: 'http://203.0.113.5/v1', apiKey: '••••••••' });
  expect(movedProvider.status).toBe(400); expect(movedProvider.body.error.message).toContain('Enter the API key again');
  expect(settings.providers.find(p => p.id === 'keyed')!.apiKey).toBe('sk-real');
});

test('editing a route cannot switch off the one in use or the only one a provider may use', async () => {
  const added = await call('/admin/routes', { kind: 'proxy', name: 'Edit me', url: 'http://203.0.113.20:8080' });
  settings.routeId = added.body.id;
  const off = await call('/admin/routes', { id: added.body.id, kind: 'proxy', name: 'Edit me', url: 'http://203.0.113.20:8080', enabled: false });
  expect(off.status).toBe(409); expect(settings.routes.find(r => r.id === added.body.id)!.enabled).toBe(true);
  settings.routeId = 'direct';
  settings.providers.push({ id: 'solo', name: 'Solo', kind: 'openai', enabled: true, baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', models: [], routeId: added.body.id, routes: { ids: [added.body.id] } });
  const off2 = await call('/admin/routes', { id: added.body.id, kind: 'proxy', name: 'Edit me', url: 'http://203.0.113.20:8080', enabled: false });
  expect(off2.status).toBe(409); expect(off2.body.error.message).toContain('Solo');
});

test('a renamed MCP header with a masked value must be typed again, not saved empty', () => {
  const saved1: any = { id: 's1', name: 'remote', enabled: true, transport: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer abc' }, routeId: 'direct', created: 1 };
  const same = cleanServer({ headers: { Authorization: '••••••••' } }, saved1, true);
  expect(same.headers).toEqual({ Authorization: 'Bearer abc' });
  expect(() => cleanServer({ headers: { 'X-Api-Key': '••••••••' } }, saved1, true)).toThrow(/Enter the value of "X-Api-Key" again/);
  expect(() => cleanServer({ url: 'https://other.example.org/mcp', headers: { Authorization: '••••••••' } }, saved1, true)).toThrow(/Enter its header values again/);
});

test('an address with a masked secret keeps it on the same server and refuses it on another', () => {
  const saved1: any = { id: 's2', name: 'remote', enabled: true, transport: 'http', url: 'https://mcp.example.com/mcp?api_key=topsecret&x=1', routeId: 'direct', created: 1 };
  const ok = cleanServer({ url: 'https://mcp.example.com/mcp2?api_key=••••••••&x=1' }, saved1, true);
  expect(ok.url).toContain('api_key=topsecret');
  expect(() => cleanServer({ url: 'https://elsewhere.example.net/mcp?api_key=••••••••' }, saved1, true)).toThrow(/again/);
});

test('deleting an API key takes it out of MCP lists, and switches off what only it could use', async () => {
  const made = await call('/admin/keys', { name: 'Only one' });
  expect(made.status).toBe(200);
  const key = settings.keys.find(k => k.name === 'Only one')!;
  const cfg = mcpConfig(); cfg.servers.push({ id: 'ks', name: 'keyed', enabled: true, transport: 'http', url: 'https://mcp.example.com/mcp', routeId: 'direct', keys: [key.id], created: 1 } as any);
  const gone = await call('/admin/keys/delete', { id: key.id });
  expect(gone.status).toBe(200);
  const after = mcpConfig().servers.find(s => s.id === 'ks')!;
  expect(after.keys).toBeUndefined(); expect(after.enabled).toBe(false);
});

test('the local manager can reset the password of a running gateway; a dashboard session cannot', async () => {
  const next = 'a-brand-new-password-123';
  const denied = await call('/admin/reset-password', { password: next }, 'not-the-token');
  expect(denied.status).toBeGreaterThanOrEqual(401);
  const short = await call('/admin/reset-password', { password: 'short' });
  expect(short.status).toBe(400);
  const ok = await call('/admin/reset-password', { password: next });
  expect(ok.status).toBe(200);
  const login = await fetch(base + '/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: next }) });
  expect(login.status).toBe(200);
});

test('editing a provider keeps its model prefix and its routes, and replaces or keeps the key as asked', async () => {
  const made = await call('/admin/providers', { name: 'Editable', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-first', idPrefix: 'editable', routes: { ids: ['direct'] } });
  expect(made.status).toBe(200);
  const sent = { id: 'editable', name: 'Renamed', kind: 'openai', enabled: true, baseUrl: 'http://127.0.0.1:9/v1', models: ['a', 'b'], routeId: 'direct', routes: { ids: ['direct'], spread: false, backups: false } };
  const keep = await call('/admin/providers', { ...sent, apiKey: '••••••••' });
  expect(keep.status).toBe(200);
  let p = settings.providers.find(x => x.id === 'editable')!;
  expect(p.name).toBe('Renamed'); expect(p.apiKey).toBe('sk-first'); expect(p.models).toEqual(['a', 'b']); expect(p.routes!.ids).toEqual(['direct']);
  const replace = await call('/admin/providers', { ...sent, baseUrl: 'http://127.0.0.1:9/v2', apiKey: 'sk-second' });
  expect(replace.status).toBe(200);
  p = settings.providers.find(x => x.id === 'editable')!;
  expect(p.apiKey).toBe('sk-second'); expect(p.baseUrl).toBe('http://127.0.0.1:9/v2'); expect(p.id).toBe('editable');
});
