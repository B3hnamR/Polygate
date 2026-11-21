import { test, expect, afterEach } from 'bun:test';
import type { Route } from '../backend/types';
// A relay whose hosting platform switched it off (Vercel's 402 DEPLOYMENT_DISABLED, Cloudflare's error 1027, Netlify's usage pause) answers
// with the platform's page instead of the provider's. That is not the model's answer: the request moves on and the relay rests.
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { settings } = await import('../backend/state');
const { networkFetch, relayPlatformOff, routeFor } = await import('../backend/transport');

let reply = () => new Response('ok', { status: 200, headers: { 'x-relay-runtime': 'cloudflare-worker' } });
const saved = { routes: settings.routes, rotate: settings.rotate, routeId: settings.routeId, failover: settings.failover, allowDirect: settings.allowDirect, exhaustedFailover: settings.exhaustedFailover };
const add = (id: string) => { const r: Route = { id, name: 'Relay ' + id, kind: 'relay', url: `https://${id}.invalid/`, enabled: true, models: [] }; settings.routes = [...settings.routes, r]; return r; };
afterEach(() => { Object.assign(settings, saved); });

const vercelOff = (code = 'DEPLOYMENT_DISABLED') => new Response(`Payment required\n\n${code}\n\nfra1::s656c-1794727502045-279f5f5c45b8\n`, { status: 402, headers: { 'x-vercel-error': code, 'content-type': 'text/plain' } });
async function chat() {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async (url: Parameters<typeof fetch>[0]) => { expect(String(url)).toBe('https://rp-a.invalid/'); return reply(); }, original);
  try { return await networkFetch('https://opencode.ai/zen/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, 'rp-a'); }
  finally { globalThis.fetch = original; }
}

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

test('an answer the relay itself passed on is never taken for the platform, nor are ordinary errors', async () => {
  // The relay marks its own answers: a provider page that mentions the same words still belongs to the provider.
  expect(await relayPlatformOff(new Response('DEPLOYMENT_DISABLED', { status: 402, headers: { 'x-relay-runtime': 'vercel-bun', 'x-vercel-error': 'DEPLOYMENT_DISABLED' } }), 'R')).toBeUndefined();
  expect(await relayPlatformOff(new Response('{"error":"rate limited"}', { status: 429 }), 'R')).toBeUndefined();
  expect(await relayPlatformOff(new Response('fine', { status: 200, headers: { 'x-vercel-error': 'DEPLOYMENT_DISABLED' } }), 'R')).toBeUndefined();
  expect(await relayPlatformOff(new Response('', { status: 500, headers: { 'x-vercel-error': 'FUNCTION_INVOCATION_FAILED' } }), 'R')).toBeUndefined();
});

test('a chat request through a disabled Vercel relay fails as a route problem with a plain message, and the relay rests for six hours', async () => {
  settings.routes = []; const a = add('rp-a'), b = add('rp-b'); settings.failover = true;
  settings.routeId = a.id; settings.rotate = false; settings.exhaustedFailover = false;
  reply = () => vercelOff();
  const err: any = await chat().then(() => undefined, e => e);
  expect(err?.type).toBe('route_unavailable'); expect(err.status).toBe(503);
  expect(err.message).toContain('Vercel has switched off this relay'); expect(err.message).not.toContain('fra1::');
  expect(a.cooldownUntil! - Date.now()).toBeGreaterThan(5.9 * 3600000);
  expect(a.status).toContain('Vercel');
  expect(routeFor('m', '', 'openai')).toBe(b);
  expect(settings.routeId).toBe(a.id);
  a.cooldownUntil = Date.now() - 1;
  expect(routeFor('m', '', 'openai')).toBe(a);
});

test('a resting selected relay fails closed when no eligible backup is allowed', () => {
  settings.routes = []; const a = add('rp-a'), b = add('rp-b');
  a.cooldownUntil = Date.now() + 6 * 3600000;
  settings.routes.push({ id: 'direct', name: 'Direct', kind: 'direct', url: '', enabled: true, models: [] });
  settings.routeId = a.id; settings.rotate = false; settings.allowDirect = false; settings.failover = true;
  b.only = 'kilo';
  add('rp-resting').cooldownUntil = a.cooldownUntil;
  const unavailable = expect.objectContaining({ status: 503, type: 'route_unavailable' });
  expect(() => routeFor('m', '', 'free')).toThrow(unavailable);
  expect(routeFor('m', '', 'kilo')).toBe(b);
  expect(() => routeFor('m', a.id, 'kilo')).toThrow(unavailable);
  settings.failover = false;
  expect(() => routeFor('m', '', 'kilo')).toThrow(unavailable);
});

test('with no other exit to stand in, the relay is not rested, but the answer is still the plain message', async () => {
  settings.routes = []; const a = add('rp-a');
  reply = () => vercelOff();
  const err: any = await chat().then(() => undefined, e => e);
  expect(err?.message).toContain('Vercel has switched off');
  expect(a.cooldownUntil || 0).toBeLessThanOrEqual(Date.now());
});

test('a working relay is untouched', async () => {
  add('rp-a'); reply = () => new Response('{"ok":true}', { status: 200, headers: { 'x-relay-runtime': 'cloudflare-worker', 'content-type': 'application/json' } });
  const r = await chat(); expect(r.status).toBe(200); expect(await r.json()).toEqual({ ok: true });
});
