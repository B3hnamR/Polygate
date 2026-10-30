import { test, expect, beforeAll, afterAll } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN = 'relay-manage-secret';
const { startGateway } = await import('../backend/main');
const { settings, publicSettings, tallyRoute, db } = await import('../backend/state');
const { __timing } = await import('../backend/relay-deploy');
const { relayReport } = await import('../backend/metrics');
__timing.poll = 1; __timing.verify = 1;
let gateway: Awaited<ReturnType<typeof startGateway>>, base = '';
const realFetch = globalThis.fetch; const saved = { routes: settings.routes.slice(), providers: settings.providers, routeId: settings.routeId };
const admin = { authorization: 'Bearer relay-manage-secret', 'content-type': 'application/json' };
const call = async (p: string, body: unknown) => { const r = await realFetch(base + p, { method: 'POST', headers: admin, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json().catch(() => ({}))) as any }; };
const ACCOUNT = 'a'.repeat(32);
type Seen = { method: string; url: string; auth: string; body: any };
let seen: Seen[] = []; let failNetlifyDeploy = false; let failCloudflareSubdomain = false;
const ok = (data: any = {}, status = 200) => Response.json(data, { status });
beforeAll(async () => {
  gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url); const method = init.method || 'GET'; const headers = new Headers(init.headers);
    let body: any; try { body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
    if (/^https:\/\/api\.(vercel|netlify)\.com\//.test(u) || u.startsWith('https://api.cloudflare.com/')) {
      seen.push({ method, url: u, auth: headers.get('authorization') || '', body });
      if (u.includes('api.vercel.com')) {
        if (method === 'POST') return ok({ id: 'dpl_1', readyState: 'READY', alias: [`${body.name}.vercel.app`], url: 'x.vercel.app' });
        return ok({});
      }
      if (u.includes('api.netlify.com')) {
        if (u.endsWith('/sites') && method === 'POST') return ok({ id: 'site-1', name: body.name, account_id: 'acct', default_domain: `${body.name}.netlify.app` });
        if (/\/sites\/[^/]+$/.test(u) && method === 'GET') return ok({ id: 'site-1', name: decodeURIComponent(u.split('/').pop()!).replace('.netlify.app', ''), account_id: 'acct', default_domain: decodeURIComponent(u.split('/').pop()!) });
        if (u.endsWith('/deploys') && method === 'POST') return failNetlifyDeploy ? ok({ message: 'netlify said no' }, 500) : ok({ id: 'd1', state: 'ready', required: [] });
        return ok({});
      }
      if (u.endsWith('/workers/subdomain')) return ok({ result: { subdomain: 'me' } });
      if (u.endsWith('/subdomain') && method === 'POST' && failCloudflareSubdomain) return ok({ errors: [{ message: 'subdomain failed' }] }, 500);
      return ok({});
    }
    if (headers.has('x-relay-key')) return ok({ data: [] });
    return realFetch(url, init);
  }) as any;
});
afterAll(async () => { globalThis.fetch = realFetch; delete settings.deployTokens; delete settings.deployAccounts; settings.routes = saved.routes; settings.providers = saved.providers; settings.routeId = saved.routeId; await gateway?.close(); });
const route = (id: string) => settings.routes.find(r => r.id === id)!;

test('Netlify and Cloudflare tokens can be remembered too, and stay out of the dashboard and errors', async () => {
  const n = await call('/admin/relays/deploy', { platform: 'netlify', token: 'netlify-token-123456', name: 'nl-one', remember: true });
  expect(n.status).toBe(200); expect(settings.deployTokens?.netlify).toBe('netlify-token-123456'); expect(route(n.body.id).deployed).toMatchObject({ platform: 'netlify', name: 'nl-one', siteId: 'site-1' });
  const c = await call('/admin/relays/deploy', { platform: 'cloudflare', token: 'cloudflare-token-123456', name: 'cf-one', accountId: ACCOUNT, remember: true });
  expect(c.status).toBe(200); expect(settings.deployTokens?.cloudflare).toBe('cloudflare-token-123456'); expect(settings.deployAccounts?.cloudflare).toBe(ACCOUNT);
  const shown = JSON.stringify(publicSettings()); for (const secret of ['netlify-token-123456', 'cloudflare-token-123456']) expect(shown).not.toContain(secret);
  expect(publicSettings().deployTokens).toEqual({ netlify: '••••••••', cloudflare: '••••••••' });
  seen = []; const again = await call('/admin/relays/deploy', { platform: 'cloudflare', useSaved: true, name: 'cf-two' }); // no token and no account id typed
  expect(again.status).toBe(200); expect(seen.every(s => s.auth === 'Bearer cloudflare-token-123456')).toBe(true);
  expect((await call('/admin/relays/deploy', { platform: 'netlify', useSaved: true, name: 'nl-two' })).status).toBe(200);
  expect((await call('/admin/relays/token/forget', { platform: 'netlify' })).status).toBe(200);
  expect(settings.deployTokens?.netlify).toBeUndefined(); expect(settings.deployTokens?.cloudflare).toBe('cloudflare-token-123456'); // only that platform's token went
  expect((await call('/admin/relays/deploy', { platform: 'netlify', useSaved: true })).body.error.message).toContain('No Netlify token is saved');
});

test('updating a relay redeploys it under the same name and access token, and never deletes it when the update fails', async () => {
  const v = await call('/admin/relays/deploy', { platform: 'vercel', token: 'vercel-token-123456', name: 'keep-me', region: 'iad1' }); expect(v.status).toBe(200);
  const before = { token: route(v.body.id).token, url: route(v.body.id).url }; seen = [];
  const up = await call('/admin/relays/update', { id: v.body.id, token: 'vercel-token-123456' }); expect(up.status).toBe(200);
  const post = seen.find(s => s.method === 'POST')!; expect(post.body.name).toBe('keep-me'); expect(post.body.regions).toEqual(['iad1']); expect(post.body.env.POLYGATE_RELAY_TOKEN).toBe(before.token);
  expect(route(v.body.id).token).toBe(before.token); expect(route(v.body.id).url).toBe(before.url);
  // Netlify: the existing site is used, no new site and no new environment value, and a failed publish leaves the site in place.
  const nl = await call('/admin/relays/deploy', { platform: 'netlify', token: 'netlify-token-123456', name: 'nl-update' }); seen = [];
  expect((await call('/admin/relays/update', { id: nl.body.id, token: 'netlify-token-123456' })).status).toBe(200);
  expect(seen.some(s => s.method === 'POST' && s.url.endsWith('/sites'))).toBe(false); expect(seen.some(s => s.url.includes('/env'))).toBe(false); expect(seen.some(s => s.method === 'GET' && s.url.includes('/sites/site-1'))).toBe(true);
  failNetlifyDeploy = true; seen = [];
  expect((await call('/admin/relays/update', { id: nl.body.id, token: 'netlify-token-123456' })).status).toBe(502);
  expect(seen.some(s => s.method === 'DELETE')).toBe(false); failNetlifyDeploy = false;
  // Cloudflare: same, a failed update keeps the Worker.
  const cf = await call('/admin/relays/deploy', { platform: 'cloudflare', token: 'cloudflare-token-123456', name: 'cf-update', accountId: ACCOUNT }); failCloudflareSubdomain = true; seen = [];
  expect((await call('/admin/relays/update', { id: cf.body.id, token: 'cloudflare-token-123456' })).status).toBe(502);
  expect(seen.some(s => s.method === 'DELETE')).toBe(false); failCloudflareSubdomain = false;
  // A fresh deployment that fails half way is still cleaned up.
  seen = []; expect((await call('/admin/relays/deploy', { platform: 'cloudflare', token: 'cloudflare-token-123456', name: 'cf-half', accountId: ACCOUNT })).status).toBe(200);
  failCloudflareSubdomain = true; seen = []; expect((await call('/admin/relays/deploy', { platform: 'cloudflare', token: 'cloudflare-token-123456', name: 'cf-half2', accountId: ACCOUNT })).status).toBe(502);
  expect(seen.some(s => s.method === 'DELETE' && s.url.endsWith('/workers/scripts/cf-half2'))).toBe(true); failCloudflareSubdomain = false;
});

test('removing a relay deletes its platform project first, and is refused while something depends on the route', async () => {
  const v = await call('/admin/relays/deploy', { platform: 'vercel', token: 'vercel-token-123456', name: 'remove-me', region: 'fra1' }); seen = [];
  // A provider that has this relay as its only route blocks the removal, and nothing is touched on the platform.
  settings.providers = [{ id: 'p-dep', name: 'Dependent', kind: 'openai', enabled: true, baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', models: [], routeId: v.body.id, routes: { ids: [v.body.id], mode: 'order' } } as any, ...saved.providers];
  const blocked = await call('/admin/relays/remove', { id: v.body.id, token: 'vercel-token-123456' });
  expect(blocked.status).toBe(409); expect(seen.length).toBe(0); expect(route(v.body.id)).toBeDefined();
  settings.providers = saved.providers;
  const done = await call('/admin/relays/remove', { id: v.body.id, token: 'vercel-token-123456' });
  expect(done.status).toBe(200); expect(seen.find(s => s.method === 'DELETE')!.url).toContain('/v9/projects/remove-me'); expect(settings.routes.some(r => r.id === v.body.id)).toBe(false);
  // A relay deployed by an older version is recognised by its name; a custom relay is not Polygate's to remove.
  settings.routes.push({ id: 'r-old', name: 'Vercel relay lhr1 (polygate-relay-lhr1-70e6)', kind: 'relay', url: 'https://polygate-relay-lhr1-70e6.vercel.app', token: 'old-token-12345', enabled: true, models: [] } as any);
  settings.routes.push({ id: 'r-mine', name: 'My own relay', kind: 'relay', url: 'https://mine.example.com', token: 'mine-token-12345', enabled: true, models: [] } as any);
  seen = []; expect((await call('/admin/relays/remove', { id: 'r-old', token: 'vercel-token-123456' })).status).toBe(200); expect(seen[0].url).toContain('/v9/projects/polygate-relay-lhr1-70e6');
  const custom = await call('/admin/relays/remove', { id: 'r-mine', token: 'vercel-token-123456' }); expect(custom.status).toBe(400); expect(custom.body.error.message).toContain('did not deploy');
  expect((await call('/admin/relays/update', { id: 'r-mine', token: 'vercel-token-123456' })).status).toBe(400);
  // The platform refusing the token leaves the route in place.
  settings.routes.push({ id: 'r-keep', name: 'Vercel relay sfo1 (polygate-relay-sfo1-ecc8)', kind: 'relay', url: 'https://k.vercel.app', token: 'keep-token-12345', enabled: true, models: [] } as any);
  const realNow = globalThis.fetch; globalThis.fetch = (async (u: any, i: any) => String(u).includes('api.vercel.com') ? ok({ error: { message: 'Not authorized' } }, 403) : realNow(u, i)) as any;
  expect((await call('/admin/relays/remove', { id: 'r-keep', token: 'wrong-token-123456' })).status).toBe(400); globalThis.fetch = realNow; expect(route('r-keep')).toBeDefined();
});

test('the results table counts what came back through each relay and flags one that never works', () => {
  db.exec('DELETE FROM route_outcomes');
  settings.routes.push({ id: 'r-good', name: 'Vercel relay fra1 (good)', kind: 'relay', url: 'https://g', token: 't', enabled: true, models: [] } as any, { id: 'r-bad', name: 'Vercel relay iad1 (bad)', kind: 'relay', url: 'https://b', token: 't', enabled: true, models: [] } as any);
  for (let i = 0; i < 6; i++) tallyRoute('r-good', 'ok'); tallyRoute('r-good', 'refused');
  for (let i = 0; i < 4; i++) tallyRoute('r-bad', 'refused'); for (let i = 0; i < 2; i++) tallyRoute('r-bad', 'redirected');
  db.query('INSERT INTO route_outcomes (day,route,outcome,n) VALUES (?,?,?,?)').run(Math.floor(Date.now() / 86400000) - 2, 'r-bad', 'failed', 3); // an earlier day, so it has been bad for more than one day
  const report = relayReport(7); const good = report.relays.find(r => r.id === 'r-good')!, bad = report.relays.find(r => r.id === 'r-bad')!;
  expect(good).toMatchObject({ ok: 6, refused: 1, region: 'fra1', tone: 'good' });
  expect(bad).toMatchObject({ ok: 0, refused: 4, redirected: 2, failed: 3, region: 'iad1', activeDays: 2, tone: 'bad' }); expect(bad.advice).toContain('never worked');
  expect(relayReport(30).days).toBe(30);
});

test('the used-up count moves once per used-up spell, not with every re-ask, and a relay that is only used up is not called working', async () => {
  const { routeExhausted } = await import('../backend/transport');
  db.exec('DELETE FROM route_outcomes');
  const relay: any = { id: 'r-spell', name: 'Vercel relay cdg1 (spell)', kind: 'relay', url: 'https://s', token: 't', enabled: true, models: [] };
  settings.routes = [...settings.routes, relay];
  const until = Date.now() + 3600e3;
  routeExhausted(relay, { until, seconds: 3600 }); routeExhausted(relay, { until, seconds: 3600 }); routeExhausted(relay, { until, seconds: 3600 }); // the periodic re-asks while it stays used up
  const row = relayReport(7).relays.find(r => r.id === 'r-spell')!; expect(row.usedUp).toBe(1);
  expect(row.tone).toBe('neutral'); expect(row.advice).toContain('used up');
  relay.exhaustedUntil = 0; routeExhausted(relay, { until, seconds: 3600 }); // a new spell after it recovered
  expect(relayReport(7).relays.find(r => r.id === 'r-spell')!.usedUp).toBe(2);
});

test('updating uses the platform name exactly, even a long one, and never makes a second project', async () => {
  const long = 'polygate-relay-' + 'a'.repeat(45); expect(long.length).toBeGreaterThan(40);
  settings.routes = [...settings.routes, { id: 'r-long', name: `Vercel relay iad1 (${long})`, kind: 'relay', url: `https://${long}.vercel.app`, token: 'long-token-12345', enabled: true, models: [] } as any];
  seen = []; const up = await call('/admin/relays/update', { id: 'r-long', token: 'vercel-token-123456' }); expect(up.status).toBe(200);
  expect(seen.find(s => s.method === 'POST')!.body.name).toBe(long);
});
