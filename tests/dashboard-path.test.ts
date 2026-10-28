import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { startGateway } = await import('../backend/main');
const { settings } = await import('../backend/state');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = ''; let ui = ''; const saved: Record<string, string | undefined> = {};
const set = (k: string, v: string | undefined) => { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
const get = (p: string, init: RequestInit = {}) => fetch(base + p, { redirect: 'manual', ...init });
const admin = { authorization: 'Bearer path-test-secret' };

beforeAll(async () => {
  ui = mkdtempSync(path.join(os.tmpdir(), 'polygate-ui-')); mkdirSync(path.join(ui, 'assets'));
  writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>Polygate</title><script type="module" src="./assets/app.js"></script>'); writeFileSync(path.join(ui, 'assets', 'app.js'), 'console.log(1)');
  set('POLYGATE_UI_DIST', ui); set('POLYGATE_ADMIN_TOKEN', 'path-test-secret'); set('POLYGATE_DASHBOARD_PATH', '/polygate');
  settings.warp = { engine: 'disabled', autoStart: false, pool: 1, rotateMinutes: 0, helperPath: '', endpoint: '' };
  gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`;
});
afterAll(async () => { await gateway?.close(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } rmSync(ui, { recursive: true, force: true }); });

test('the dashboard answers under /polygate/, and the bare path and the root lead there', async () => {
  expect((await get('/polygate/')).status).toBe(200); expect(await (await get('/polygate/')).text()).toContain('./assets/app.js');
  const bare = await get('/polygate?tab=1'); expect(bare.status).toBe(301); expect(bare.headers.get('location')).toBe('/polygate/?tab=1');
  const root = await get('/'); expect(root.status).toBe(302); expect(root.headers.get('location')).toBe('/polygate/');
});
test('pages and assets are only served under the path, not at the root', async () => {
  const asset = await get('/polygate/assets/app.js'); expect(asset.status).toBe(200); expect(asset.headers.get('content-type')).toContain('javascript');
  expect((await get('/assets/app.js')).status).toBe(404); expect((await get('/index.html')).status).toBe(404);
});
test('the admin and API surfaces work under the path and, for existing clients and monitoring, at the root', async () => {
  expect((await get('/polygate/healthz')).status).toBe(200); expect((await get('/healthz')).status).toBe(200);
  expect((await get('/polygate/admin/state', { headers: admin })).status).toBe(200); expect((await get('/admin/state', { headers: admin })).status).toBe(200);
  expect((await get('/polygate/admin/state')).status).toBe(401);
  const key = settings.keys[0].value; const withKey = { authorization: 'Bearer ' + key };
  const prefixed = await get('/polygate/v1/models', { headers: withKey }); const plain = await get('/v1/models', { headers: withKey });
  expect(prefixed.status).toBe(200); expect(plain.status).toBe(200); expect(((await prefixed.json()) as any).object).toBe('list');
  expect((await get('/polygate/v1/models')).status).toBe(401);
});
test('signing in through the prefixed path sets a cookie that works under it', async () => {
  const login = await get('/polygate/admin/session', { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: '{}' });
  expect(login.status).toBe(200); const cookie = (login.headers.get('set-cookie') || '').split(';')[0]; expect(cookie).toContain('=');
  expect(login.headers.get('set-cookie')).toContain('Path=/');
  expect((await get('/polygate/admin/whoami', { headers: { cookie } })).status).toBe(200);
  expect(((await (await get('/polygate/admin/whoami', { headers: { cookie } })).json()) as any).authenticated).toBe(true);
});
test('the HTTPS status reports addresses that include the path', async () => {
  const { httpsStatus } = await import('../backend/https');
  expect((await httpsStatus()).httpUrl).toMatch(/\/polygate\/$/);
});
test('without a dashboard path nothing changes: the pages are served at the root', async () => {
  set('POLYGATE_DASHBOARD_PATH', undefined);
  try { expect((await get('/')).status).toBe(200); expect((await get('/assets/app.js')).status).toBe(200); }
  finally { set('POLYGATE_DASHBOARD_PATH', '/polygate'); }
});
test('an unsafe or malformed path setting is ignored', async () => {
  const { serverConfig } = await import('../backend/auth');
  for (const bad of ['polygate', '/a b', '/../x', '//x', '/x?y', '/']) { set('POLYGATE_DASHBOARD_PATH', bad); expect(serverConfig().dashboardPath).toBe(''); }
  set('POLYGATE_DASHBOARD_PATH', '/my/panel/'); expect(serverConfig().dashboardPath).toBe('/my/panel');
  set('POLYGATE_DASHBOARD_PATH', '/polygate');
});
