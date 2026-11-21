import { test, expect, afterAll, afterEach } from 'bun:test';
// A relay whose hosting platform switched it off (Vercel's 402 DEPLOYMENT_DISABLED, Cloudflare's error 1027, Netlify's usage pause) answers
// with the platform's page instead of the provider's. That is not the model's answer: the request moves on and the relay rests.
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { settings } = await import('../backend/state');
const { networkFetch, relayPlatformOff } = await import('../backend/transport');

let reply = () => new Response('ok', { status: 200, headers: { 'x-relay-runtime': 'cloudflare-worker' } });
const relay = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => reply() });
const savedRoutes = settings.routes.slice(), savedEnabled = savedRoutes.map(r => r.enabled), savedFailover = settings.failover;
const add = (id: string) => { const r: any = { id, name: 'Relay ' + id, kind: 'relay', url: `http://127.0.0.1:${relay.port}/`, enabled: true, models: [] }; settings.routes.push(r); return r; };
afterEach(() => { settings.routes.length = 0; settings.routes.push(...savedRoutes); savedRoutes.forEach((r, i) => { r.enabled = savedEnabled[i]; }); settings.failover = savedFailover; });
afterAll(() => { relay.stop(true); });

const vercelOff = (code = 'DEPLOYMENT_DISABLED') => new Response(`Payment required\n\n${code}\n\nfra1::s656c-1794727502045-279f5f5c45b8\n`, { status: 402, headers: { 'x-vercel-error': code, 'content-type': 'text/plain' } });
// What Vercel sends an API request when Deployment Protection is on: the relay never runs.
const vercelProtected = () => new Response(JSON.stringify({
  error: { code: '401', message: 'Protected deployment' },
  protection: { vercel_auth_callback: 'https://vercel.com/sso-api?url=https%3A%2F%2Frelay.vercel.app' },
}), { status: 401, headers: { 'content-type': 'application/json' } });
// The same protection for a request Vercel does not answer as JSON: a login redirect to its SSO page.
const vercelProtectedRedirect = (status = 302) => new Response(null, { status, headers: { location: 'https://vercel.com/sso-api?url=https%3A%2F%2Frelay.vercel.app' } });
const chat = () => networkFetch('https://opencode.ai/zen/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, 'rp-a');

test('the platform pages are recognised: Vercel disabled or deleted, Cloudflare 1027, Netlify usage pause', async () => {
  const disabled = await relayPlatformOff(vercelOff(), 'R');
  expect(disabled?.message).toContain('Vercel has switched off');
  expect(disabled!.until - Date.now()).toBeGreaterThan(50 * 60000);
  expect((await relayPlatformOff(vercelOff('DEPLOYMENT_NOT_FOUND'), 'R'))?.message).toContain('no longer has');
  // Only the body says it (a proxy in between dropped the header).
  expect(await relayPlatformOff(new Response('Payment required\n\nDEPLOYMENT_DISABLED\n', { status: 402 }), 'R')).toBeDefined();
  const cf = await relayPlatformOff(new Response('error code: 1027', { status: 429 }), 'R');
  expect(cf?.message).toContain('error 1027'); expect(new Date(cf!.until).getUTCHours()).toBe(0);
  expect((await relayPlatformOff(new Response('<h1>Site not available</h1><p>This site was paused as it reached its usage limits.</p>', { status: 503, headers: { server: 'Netlify' } }), 'R'))?.message).toContain('Netlify has paused');
});

test('Vercel Deployment Protection is the platform blocking the relay, not the provider refusing the exit', async () => {
  const blocked = await relayPlatformOff(vercelProtected(), 'R');
  expect(blocked?.message).toContain('Vercel');
  expect(blocked?.message).toContain('Deployment Protection');
  expect(blocked!.until - Date.now()).toBeGreaterThan(50 * 60000);
  // The login page is the other shape the protection takes.
  expect(await relayPlatformOff(new Response('<html><title>Authentication Required</title><a href="https://vercel.com/sso-api?url=x">Log in</a></html>', { status: 401, headers: { 'content-type': 'text/html' } }), 'R')).toBeDefined();
  // And an SSO redirect when Vercel does not answer the request as JSON.
  const redirect = await relayPlatformOff(vercelProtectedRedirect(), 'R');
  expect(redirect?.message).toContain('Deployment Protection');
  expect(redirect!.until - Date.now()).toBeGreaterThan(50 * 60000);
  expect(await relayPlatformOff(vercelProtectedRedirect(307), 'R')).toBeDefined();
  // A redirect passed through by the relay keeps the runtime header: not the platform.
  expect(await relayPlatformOff(new Response(null, { status: 302, headers: { location: 'https://vercel.com/sso-api?url=x', 'x-relay-runtime': 'vercel-bun' } }), 'R')).toBeUndefined();
  // A provider's own 401 passed through by the relay keeps the relay's runtime header: not the platform.
  expect(await relayPlatformOff(new Response(JSON.stringify({ error: { code: '401', message: 'Protected deployment' } }), { status: 401, headers: { 'x-relay-runtime': 'vercel-bun', 'content-type': 'application/json' } }), 'R')).toBeUndefined();
  expect(await relayPlatformOff(new Response('{"error":{"message":"invalid api key"}}', { status: 401, headers: { 'content-type': 'application/json' } }), 'R')).toBeUndefined();
});

test('an answer the relay itself passed on is never taken for the platform, nor are ordinary errors', async () => {
  // The relay marks its own answers: a provider page that mentions the same words still belongs to the provider.
  expect(await relayPlatformOff(new Response('DEPLOYMENT_DISABLED', { status: 402, headers: { 'x-relay-runtime': 'vercel-bun', 'x-vercel-error': 'DEPLOYMENT_DISABLED' } }), 'R')).toBeUndefined();
  expect(await relayPlatformOff(new Response('{"error":"rate limited"}', { status: 429 }), 'R')).toBeUndefined();
  expect(await relayPlatformOff(new Response('fine', { status: 200, headers: { 'x-vercel-error': 'DEPLOYMENT_DISABLED' } }), 'R')).toBeUndefined();
  expect(await relayPlatformOff(new Response('', { status: 500, headers: { 'x-vercel-error': 'FUNCTION_INVOCATION_FAILED' } }), 'R')).toBeUndefined();
});

test('a chat request through a disabled Vercel relay fails as a route problem with a plain message, and the relay rests for six hours', async () => {
  const a = add('rp-a'); add('rp-b'); settings.failover = true;
  reply = () => vercelOff();
  const err: any = await chat().then(() => undefined, e => e);
  expect(err?.type).toBe('route_unavailable'); expect(err.status).toBe(503);
  expect(err.message).toContain('Vercel has switched off this relay'); expect(err.message).not.toContain('fra1::');
  expect(a.cooldownUntil - Date.now()).toBeGreaterThan(5.9 * 3600000);
  expect(a.status).toContain('Vercel');
});

// The gateway's move to the working relay is covered end to end in tests/fallback-skip.test.ts; this level proves the route error it acts on.
test('a chat request through a relay behind Deployment Protection fails as a route problem the gateway can fail over on', async () => {
  const a = add('rp-a'); add('rp-b'); settings.failover = true;
  reply = () => vercelProtected();
  const err: any = await chat().then(() => undefined, e => e);
  expect(err?.type).toBe('route_unavailable'); expect(err.status).toBe(503);
  expect(err.message).toContain('Deployment Protection');
  expect(a.cooldownUntil - Date.now()).toBeGreaterThan(5.9 * 3600000);
  expect(a.status).toContain('Deployment Protection');
});

test('the SSO redirect Vercel sends instead of the 401 is the same route problem, not a redirect failure', async () => {
  const a = add('rp-a'); add('rp-b'); settings.failover = true;
  reply = () => vercelProtectedRedirect();
  const err: any = await chat().then(() => undefined, e => e);
  expect(err?.type).toBe('route_unavailable'); expect(err.status).toBe(503);
  expect(err.message).toContain('Deployment Protection');
  expect(err.message).not.toContain('redirected');
  expect(a.cooldownUntil - Date.now()).toBeGreaterThan(5.9 * 3600000);
});

test('with no other exit to stand in, the relay is not rested, but the answer is still the plain message', async () => {
  const a = add('rp-a'); settings.routes.forEach(r => { if (r.id !== 'rp-a') r.enabled = false; });
  reply = () => vercelOff();
  const err: any = await chat().then(() => undefined, e => e);
  expect(err?.message).toContain('Vercel has switched off');
  expect(a.cooldownUntil || 0).toBeLessThanOrEqual(Date.now());
});

test('a working relay is untouched', async () => {
  add('rp-a'); reply = () => new Response('{"ok":true}', { status: 200, headers: { 'x-relay-runtime': 'cloudflare-worker', 'content-type': 'application/json' } });
  const r = await chat(); expect(r.status).toBe(200); expect(await r.json()).toEqual({ ok: true });
});
