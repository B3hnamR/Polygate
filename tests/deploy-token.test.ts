import { test, expect, beforeAll, afterAll } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN = 'deploy-token-secret';
const { startGateway } = await import('../backend/main');
const { settings, publicSettings, redactError } = await import('../backend/state');
const { __timing } = await import('../backend/relay-deploy');
__timing.poll = 1; __timing.verify = 1;
let gateway: Awaited<ReturnType<typeof startGateway>>, base = '';
const realFetch = globalThis.fetch; const saved = { routes: settings.routes.slice() };
const admin = { authorization: 'Bearer deploy-token-secret', 'content-type': 'application/json' };
const call = async (p: string, body: unknown) => { const r = await realFetch(base + p, { method: 'POST', headers: admin, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json().catch(() => ({}))) as any }; };
const TOKEN = 'vercel-api-token-abcdef123456';
const sent: { url: string; auth: string; body: any }[] = [];
beforeAll(async () => {
  gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`;
  // Only Vercel and the new relay are faked; the dashboard calls to the local gateway go through.
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url); const headers = new Headers(init.headers);
    if (u.startsWith('https://api.vercel.com/')) {
      sent.push({ url: u, auth: headers.get('authorization') || '', body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (headers.get('authorization') !== 'Bearer ' + TOKEN) return Response.json({ error: { message: 'Not authorized' } }, { status: 403 });
      if (init.method === 'POST') { const region = JSON.parse(String(init.body)).regions[0]; return Response.json({ id: 'dpl_' + region, readyState: 'READY', alias: [`relay-${region}.vercel.app`], url: 'x.vercel.app' }); }
      return Response.json({ teams: [{ id: 't1', slug: 'me', billing: { plan: 'pro' } }], projects: [] });
    }
    if (headers.has('x-relay-key')) return Response.json({ data: [] });
    return realFetch(url, init);
  }) as any;
});
afterAll(async () => { globalThis.fetch = realFetch; delete settings.deployTokens; settings.routes = saved.routes.slice(); await gateway?.close(); });

test('a deploy does not keep the token unless asked, and keeps it encrypted-only when asked', async () => {
  const plain = await call('/admin/relays/deploy', { platform: 'vercel', token: TOKEN, region: 'fra1', name: 'one' });
  expect(plain.status).toBe(200); expect(settings.deployTokens).toBeUndefined();
  const kept = await call('/admin/relays/deploy', { platform: 'vercel', token: TOKEN, region: 'iad1', name: 'two', remember: true });
  expect(kept.status).toBe(200); expect(settings.deployTokens?.vercel).toBe(TOKEN);
});

test('the saved token never reaches the dashboard or an error message', () => {
  const shown = JSON.stringify(publicSettings());
  expect(shown).not.toContain(TOKEN); expect(publicSettings().deployTokens?.vercel).toBe('••••••••');
  expect(redactError('Vercel said no to ' + TOKEN)).not.toContain(TOKEN);
});

test('a deploy and a plan check can use the saved token without it being sent again', async () => {
  sent.length = 0;
  const deployed = await call('/admin/relays/deploy', { platform: 'vercel', useSaved: true, region: 'lhr1', name: 'three' });
  expect(deployed.status).toBe(200); expect(sent[0].auth).toBe('Bearer ' + TOKEN);
  const plan = await call('/admin/relays/inspect', { platform: 'vercel', useSaved: true });
  expect(plan.status).toBe(200); expect(plan.body.plan).toBe('pro');
});

test('regions deployed one after another each become their own relay route', async () => {
  const before = settings.routes.filter(r => r.kind === 'relay').length;
  for (const region of ['cdg1', 'arn1', 'dub1']) expect((await call('/admin/relays/deploy', { platform: 'vercel', useSaved: true, region, name: 'multi-' + region })).status).toBe(200);
  const relays = settings.routes.filter(r => r.kind === 'relay');
  expect(relays.length).toBe(before + 3);
  for (const region of ['cdg1', 'arn1', 'dub1']) expect(relays.some(r => r.name.startsWith(`Vercel relay ${region} `) && r.url === `https://relay-${region}.vercel.app`)).toBe(true);
  expect(new Set(relays.map(r => r.token)).size).toBe(relays.length); // every relay has its own access token
});

test('forgetting the token removes it, and a saved-token deploy then asks for one', async () => {
  expect((await call('/admin/relays/token/forget', {})).status).toBe(200);
  expect(settings.deployTokens).toBeUndefined(); expect(publicSettings().deployTokens).toBeUndefined();
  const again = await call('/admin/relays/deploy', { platform: 'vercel', useSaved: true, region: 'fra1' });
  expect(again.status).toBe(400); expect(again.body.error.message).toContain('No Vercel token is saved');
});

test('a token Vercel rejects is not remembered', async () => {
  const bad = await call('/admin/relays/deploy', { platform: 'vercel', token: 'a-wrong-token-123456', region: 'fra1', remember: true });
  expect(bad.status).toBe(400); expect(bad.body.error.message).toContain('check the token'); expect(settings.deployTokens).toBeUndefined();
});
