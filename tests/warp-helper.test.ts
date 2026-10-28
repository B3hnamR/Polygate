import { test, expect, beforeAll, afterAll } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN = 'warp-helper-secret';
const { startGateway } = await import('../backend/main');
const { settings } = await import('../backend/state');
const warp = await import('../backend/warp');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = ''; let saved: typeof settings.warp;
const post = async (body: unknown) => { const r = await fetch(base + '/admin/warp/settings', { method: 'POST', headers: { authorization: 'Bearer warp-helper-secret', 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json()) as any }; };
beforeAll(async () => { saved = settings.warp; settings.warp = { engine: 'disabled', autoStart: false, pool: 1, rotateMinutes: 0, helperPath: '', endpoint: '' }; gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`; });
afterAll(async () => { settings.warp = saved; await gateway?.close(); });

test('only the Windows app or the admin token may point WARP at another helper program', () => {
  settings.warp = { engine: 'disabled', autoStart: false, pool: 1, rotateMinutes: 0, helperPath: '', endpoint: '' };
  expect(() => warp.checkHelperPath('/usr/bin/anything', false)).toThrow(/admin token/);
  expect(() => warp.checkHelperPath(undefined, false)).not.toThrow(); // a save that does not mention it
  expect(() => warp.checkHelperPath('', false)).not.toThrow();        // unchanged
  expect(() => warp.checkHelperPath('/usr/bin/anything', true)).not.toThrow();
  settings.warp = { ...settings.warp, helperPath: '/opt/mine/usque' };
  expect(() => warp.checkHelperPath('/opt/mine/usque', false)).not.toThrow(); // the dashboard resends what is already saved
  expect(() => warp.checkHelperPath('/opt/other', false)).toThrow();
});

test('the settings route, reached with the admin token, can change the helper, and every answer says what this caller may do', async () => {
  const r = await post({ helperPath: '/opt/mine/usque' }); expect(r.status).toBe(200); expect(r.body.config.helperPath).toBe('/opt/mine/usque'); expect(r.body.canSetHelper).toBe(true);
  expect((await post({ helperPath: '' })).body.config.helperPath).toBe('');
  const status = await (await fetch(base + '/admin/warp/status', { headers: { authorization: 'Bearer warp-helper-secret' } })).json() as any; expect(status.canSetHelper).toBe(true);
});

test('a custom MASQUE endpoint must be an IPv4 address and is rejected before anything is saved', async () => {
  for (const bad of ['example.com', '[2606:4700::1]', '1.2.3', '1.2.3.4:443', 'not an endpoint!']) { const r = await post({ endpoint: bad, pool: 3 }); expect(r.status).toBe(400); expect(r.body.error.message).toContain('IPv4'); }
  expect(settings.warp?.endpoint).toBe(''); expect(settings.warp?.pool).toBe(1);
  const ok = await post({ endpoint: '162.159.198.2' }); expect(ok.status).toBe(200); expect(ok.body.config.endpoint).toBe('162.159.198.2');
  expect((await post({ endpoint: '' })).body.config.endpoint).toBe('');
});
