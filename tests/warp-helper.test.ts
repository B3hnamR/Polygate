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

test('a failed registration reports the helper own reason, not the echoed command line', () => {
  const reason = 'Failed to register: Post "https://api.devices.cloudflare.com/v0a4471/reg": net/http: TLS handshake timeout';
  const raw = [reason, 'Command failed: C:/app/warp/usque.exe -c C:/state/identity-1.json register --accept-tos', '2026/10/28 14:38:25 +0330 Config file not found: failed to open config'].join('\n');
  expect(warp.helperProblem(raw)).toBe(reason);
  expect(warp.helperProblem('only noise\nCommand failed: x')).toBe('only noise');
  expect(warp.helperProblem('Command failed: x')).toBe('Command failed: x'); // nothing better to show
  expect(warp.helperProblem('x'.repeat(900)).length).toBe(300);
});

test('handshake splitting: auto tries plain first, remembers what worked, and off or on force one way', () => {
  expect(warp.splitOrder('auto')).toEqual(['', '64:2:2048']);
  expect(warp.splitOrder(undefined)).toEqual(['', '64:2:2048']);
  expect(warp.splitOrder('auto', '64:2:2048')).toEqual(['64:2:2048', '']);
  expect(warp.splitOrder('auto', '')).toEqual(['', '64:2:2048']);
  expect(warp.splitOrder('off', '64:2:2048')).toEqual(['']);
  expect(warp.splitOrder('on', '')).toEqual(['64:2:2048']);
});

test('a failed tunnel start says what probably happened and what to do', () => {
  expect(warp.shortReason('write tcp 1.2.3.4:5->162.159.198.2:443: wsasend: An existing connection was forcibly closed by the remote host.')).toBe('connection reset');
  expect(warp.shortReason('Failed: net/http: TLS handshake timeout')).toBe('no answer in time');
  expect(warp.shortReason('dial tcp: lookup example: no such host')).toBe('name lookup failed');
  const reset = warp.explainTunnelFailure(['162.159.198.183 plain: connection reset', '162.159.198.183 split: connection reset']);
  expect(reset).toContain('reset the connection'); expect(reset).toContain('162.159.198.183 plain: connection reset'); expect(reset).toContain('VPN'); expect(reset).toContain('another network');
  expect(warp.explainTunnelFailure(['x plain: no answer in time'])).toContain('did not answer in time');
  expect(warp.explainTunnelFailure(['x plain: helper stopped'])).toContain('could not open its tunnel');
});

test('the splitting choice is validated and saved with the other WARP settings', async () => {
  const bad = await post({ split: 'sometimes' }); expect(bad.status).toBe(400); expect(bad.body.error.message).toContain('auto, off or on');
  expect(settings.warp?.split ?? 'auto').toBe('auto');
  const ok = await post({ split: 'off' }); expect(ok.status).toBe(200); expect(ok.body.config.split).toBe('off');
  expect((await post({ split: 'auto' })).body.config.split).toBe('auto');
});

test('"connection closed" (an EOF from the helper) is named plainly and explained', () => {
  expect(warp.shortReason('Failed to connect tunnel: connect-ip: failed to send request: Connect "https://cloudflareaccess.com": EOF')).toBe('connection closed');
  expect(warp.shortReason('something EOFX else')).not.toBe('connection closed');
  const text = warp.explainTunnelFailure(['162.159.198.183 plain: connection closed', '162.159.198.183 split: connection closed']);
  expect(text).toContain('closed before it was ready'); expect(text).toContain('VPN');
});

test('a helper file that exists but cannot be run is reported with the fix, not as missing', async () => {
  if (process.platform !== 'linux') { expect(warp.helperMissing()).toContain('WARP helper'); return; }
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'polygate-helper-')); const file = path.join(dir, 'usque-linux-amd64'); writeFileSync(file, 'x'); chmodSync(file, 0o644);
  const saved = settings.warp; settings.warp = { engine: 'embedded', autoStart: false, pool: 1, rotateMinutes: 0, helperPath: file, endpoint: '' };
  try { const text = warp.helperMissing(); expect(text).toContain('cannot be run'); expect(text).toContain('chmod +x ' + file); chmodSync(file, 0o755); expect(warp.findWarpHelper()).toBe(file); }
  finally { settings.warp = saved; rmSync(dir, { recursive: true, force: true }); }
});

test('the used-up mark on the WARP route is dropped when the tunnels change', async () => {
  const savedRoutes = settings.routes;
  try {
    settings.routes = [...savedRoutes.filter(r => r.id !== 'warp'), { id: 'warp', name: 'Cloudflare WARP', kind: 'warp', url: 'socks5://127.0.0.1:40000', enabled: true, models: [], managed: true, exhaustedUntil: Date.now() + 3600000, status: 'Daily Free allowance used (resets 00:20)' } as any];
    await warp.warpDisconnect();
    const route = settings.routes.find(r => r.id === 'warp')!; expect(route.exhaustedUntil).toBe(0); expect(route.status).toBe('');
  } finally { settings.routes = savedRoutes; }
});
