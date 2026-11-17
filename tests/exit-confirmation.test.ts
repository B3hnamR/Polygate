import { test, expect, afterEach } from 'bun:test';
import { settings } from '../backend/state';
import { networkFetch, routeContext, __setCanarySender, __setExitVerifier } from '../backend/transport';
import { suspectExhaustion, takeExhaustion, takeRefused, takeInconclusive } from '../backend/exhaustion';

const saved = settings.routes;
const nativeFetch = globalThis.fetch;
const limit = () => new Response('Free usage limit reached', { status: 429, headers: { 'retry-after': '7200' } });
afterEach(() => { settings.routes = saved; globalThis.fetch = nativeFetch; __setCanarySender(); __setExitVerifier(); });

async function request(answer?: () => Promise<Response | undefined>) {
  const route = { id: 'confirmation-direct', name: 'Direct', kind: 'direct' as const, url: '', enabled: true, models: [] };
  settings.routes = [route];
  globalThis.fetch = (async () => limit()) as unknown as typeof fetch;
  __setCanarySender(answer);
  const rid = crypto.randomUUID();
  const response = await routeContext.run({ routeId: route.id, requestId: rid }, () => networkFetch('https://opencode.ai/test', { method: 'POST', body: '{}' }));
  expect(await response.text()).toBe('Free usage limit reached');
  return { route: route as typeof route & { exhaustedUntil?: number }, exhausted: takeExhaustion(rid), refused: takeRefused(rid), inconclusive: takeInconclusive(rid) };
}

for (const status of [400, 401, 403, 404, 410, 429, 500, 502, 503]) {
  test(`a canary HTTP ${status} unrelated error cannot confirm the original countdown`, async () => {
    const result = await request(async () => new Response('Model capacity unavailable', { status, headers: { 'retry-after': '7200' } }));
    expect(result.exhausted).toBeUndefined(); expect(result.route.exhaustedUntil).toBeUndefined();
    expect(result.refused).toBe(false); expect(result.inconclusive).toBe(true);
  });
}
test('missing and failed canaries remain inconclusive', async () => {
  for (const answer of [async () => undefined, async (): Promise<Response> => { throw new Error('network unavailable'); }]) {
    const result = await request(answer); expect(result.exhausted).toBeUndefined(); expect(result.refused).toBe(false); expect(result.inconclusive).toBe(true);
  }
});
test('the default sender with no enabled Free provider never trusts the original countdown', async () => {
  const providers = settings.providers;
  try {
    settings.providers = [];
    const result = await request();
    expect(result.exhausted).toBeUndefined(); expect(result.inconclusive).toBe(true);
  } finally { settings.providers = providers; }
});
test('only explicit limit evidence confirms exhaustion; a passing canary confirms a request refusal', async () => {
  const used = await request(async () => limit()); expect(used.exhausted?.seconds).toBe(7200); expect(used.route.exhaustedUntil).toBeGreaterThan(Date.now());
  const clean = await request(async () => new Response('OK')); expect(clean.exhausted).toBeUndefined(); expect(clean.refused).toBe(true); expect(clean.inconclusive).toBe(false);
});
test('a limit without a countdown also requires positive confirmation', async () => {
  const result = await request(async () => new Response('FreeUsageLimitError', { status: 429 })); expect(result.exhausted).toBeDefined();
});
test('error-body classification reads only a bounded prefix', async () => {
  let pulls = 0;
  const response = new Response(new ReadableStream({ pull(c) { pulls++; c.enqueue(new TextEncoder().encode('x'.repeat(1024))); }, cancel() {} }), { status: 429 });
  expect(await suspectExhaustion(response)).toBeUndefined(); expect(pulls).toBeLessThan(10); void response.body?.cancel().catch(() => {});
  const late = new Response('x'.repeat(2100) + 'FreeUsageLimitError', { status: 429, headers: { 'retry-after': '7200' } });
  expect(await suspectExhaustion(late)).toBeUndefined();
});
test('a stalled canary body is bounded in time and is not positive evidence', async () => {
  const result = await request(async () => new Response(new ReadableStream({ start() {} }), { status: 429 }));
  expect(result.exhausted).toBeUndefined(); expect(result.inconclusive).toBe(true);
}, 4000);
