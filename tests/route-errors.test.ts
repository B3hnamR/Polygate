import { test, expect, afterEach } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { settings } = await import('../backend/state');
const { plainRouteError, routeFailed, networkFailure, networkFetch, routeContext } = await import('../backend/transport');
const { explainError, largeRequestNote } = await import('../backend/explain');
const { queryEvents } = await import('../backend/logbook');

const saved = settings.routes.slice();
afterEach(() => { settings.routes.length = 0; settings.routes.push(...saved); });

test('network failures are named in plain words, with the raw text left to the log', () => {
  const bun = 'TypeError: ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()';
  expect(plainRouteError(bun, 'relay')).toContain('Connection reset'); expect(plainRouteError(bun, 'relay')).toContain('relay host');
  expect(plainRouteError(bun, 'proxy')).toBe('Connection reset: the network closed it');
  expect(plainRouteError('The operation timed out. TimeoutError')).toBe('No answer in time');
  expect(plainRouteError('getaddrinfo ENOTFOUND nigga2-orcin.vercel.app')).toContain('Name not found');
  expect(plainRouteError('ConnectionRefused: Unable to connect')).toContain('Connection refused');
  expect(plainRouteError('unable to verify the first certificate')).toContain('Secure connection failed');
  expect(plainRouteError('HTTP 502')).toBe('HTTP 502');
  expect(plainRouteError('TypeError: something odd happened')).toBe('something odd happened');
  expect(plainRouteError('x'.repeat(400)).length).toBe(160);
});

test('a failed route shows the plain reason and the log keeps the raw one', () => {
  const route: any = { id: 'rf-1', name: 'Test relay', kind: 'relay', url: 'https://x.example/', enabled: true, models: [] };
  settings.routes.push(route, { id: 'rf-spare', name: 'Spare exit', kind: 'proxy', url: 'http://127.0.0.1:9', enabled: true, models: [] } as any); // another exit can take over, so the failed one rests
  routeFailed(route, 'TypeError: ECONNRESET: The socket connection was closed unexpectedly.', true);
  expect(route.status).toContain('Connection reset'); expect(route.status).not.toContain('TypeError');
  const entry = queryEvents({ q: 'Test relay is paused' }).entries[0]; expect(entry).toBeTruthy();
  expect(JSON.stringify(entry)).toContain('ECONNRESET');
});

test('a route that never answered names the route, the cause and the next step', () => {
  const route: any = { id: 'nf-1', name: 'Vercel fra1', kind: 'relay', url: 'https://relay.example/', enabled: true, models: [] };
  const reset = networkFailure(route, new Error('TypeError: ECONNRESET: The socket connection was closed unexpectedly.'), new URL('https://api.opencode.ai/v1/chat/completions'));
  expect(reset.status).toBe(502); expect(reset.type).toBe('route_unreachable');
  expect(reset.message).toContain('Could not reach api.opencode.ai');
  expect(reset.message).toContain('the relay "Vercel fra1"');
  expect(reset.message).toContain('Connection reset');
  expect(reset.message).toContain('network may be blocking the site');
  expect(reset.message).not.toContain('ECONNRESET');

  const dns = networkFailure({ ...route, name: 'Home proxy', kind: 'proxy' }, new Error('getaddrinfo ENOTFOUND missing.example'), new URL('https://api.openai.com/v1'));
  expect(dns.message).toContain('the route "Home proxy"');
  expect(dns.message).toContain('Name not found');
  expect(dns.message).toContain("check the address and this computer's DNS");

  const refused = networkFailure({ ...route, name: 'Direct', kind: 'direct' }, new Error('ConnectionRefused: Unable to connect'), new URL('https://x.example/'));
  expect(refused.message).toContain('nothing is listening');
});

test('networkFetch turns a raw connection failure into a plain route error', async () => {
  const nativeFetch = globalThis.fetch;
  const route: any = { id: 'nf-direct', name: 'Direct', kind: 'direct', url: '', enabled: true, models: [] };
  const savedRoutes = settings.routes.slice();
  try {
    settings.routes.length = 0; settings.routes.push(route);
    globalThis.fetch = (async () => { throw new TypeError('ECONNRESET: The socket connection was closed unexpectedly.'); }) as unknown as typeof fetch;
    const rid = crypto.randomUUID();
    await expect(routeContext.run({ routeId: route.id, requestId: rid }, () => networkFetch('https://api.opencode.ai/v1/chat/completions', { method: 'POST', body: '{}' }))).rejects.toMatchObject({ status: 502, type: 'route_unreachable' });
  } finally { settings.routes.length = 0; settings.routes.push(...savedRoutes); globalThis.fetch = nativeFetch; }
});

test('a request that ran out of time says so and points at the deadline setting', () => {
  const base = { model: 'opencode/x', route: 'Vercel fra1', switches: 0, cooldownsEnabled: true };
  const timed = explainError({ ...base, status: 504, type: 'timeout', message: 'Gateway request deadline exceeded', switches: 2 })!;
  expect(timed.code).toBe('gateway_timeout');
  expect(timed.message).toContain('No answer arrived');
  expect(timed.message).toContain('2 other network exits');
  expect(timed.message).toContain('Deadline');
  const stalled = explainError({ ...base, status: 504, type: 'timeout', message: 'The upstream stopped sending data' })!;
  expect(stalled.code).toBe('stream_stalled');
  expect(stalled.message).toContain('started but then stopped arriving');
});

test('a very large request is named as such in the used-up message, a small one is not', () => {
  const base = { status: 429, message: '{"error":{"type":"FreeUsageLimitError"}}', model: 'opencode/x', route: 'Direct connection', switches: 0, cooldownsEnabled: true, exhausted: { until: Date.now() + 3600e3, seconds: 3600 } };
  const big = explainError({ ...base, requestBytes: 2_721_437, messages: 539 })!;
  expect(big.message).toContain('This request is large'); expect(big.message).toContain('539 messages'); expect(big.message).toContain('2.6 MB'); expect(big.message).toContain('compacting');
  expect(explainError({ ...base, requestBytes: 12_000, messages: 3 })!.message).not.toContain('large');
  expect(explainError(base)!.message).not.toContain('large');
  expect(largeRequestNote(399_999)).toBe(''); expect(largeRequestNote(400_000)).toContain('0.4 MB');
});

test('OpenCode limit diagnostics do not claim a proven daily quota, TLS rejection or broken relay',()=>{
  const base={status:429,message:'{"error":{"type":"FreeUsageLimitError"}}',model:'opencode/x',route:'Vercel fra1',switches:0,cooldownsEnabled:true};
  const limited=explainError({...base,exhausted:{until:Date.now()+3600e3,seconds:3600}})!;
  expect(limited.message).toContain('not a guaranteed daily reset');expect(limited.message).toContain('access restriction');expect(limited.message).not.toContain('use a different IP');
  const unknown=explainError({...base,exhausted:{until:Date.now()+900e3,seconds:900,refused:true}})!;
  expect(unknown.message).toContain('does not prove');expect(unknown.message).not.toContain('probably its TLS identity');
});
