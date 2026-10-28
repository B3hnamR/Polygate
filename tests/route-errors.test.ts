import { test, expect, afterEach } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { settings } = await import('../backend/state');
const { plainRouteError, routeFailed } = await import('../backend/transport');
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
  settings.routes.push(route);
  routeFailed(route, 'TypeError: ECONNRESET: The socket connection was closed unexpectedly.', true);
  expect(route.status).toContain('Connection reset'); expect(route.status).not.toContain('TypeError');
  const entry = queryEvents({ q: 'Test relay is paused' }).entries[0]; expect(entry).toBeTruthy();
  expect(JSON.stringify(entry)).toContain('ECONNRESET');
});

test('a very large request is named as such in the used-up message, a small one is not', () => {
  const base = { status: 429, message: '{"error":{"type":"FreeUsageLimitError"}}', model: 'opencode/x', route: 'Direct connection', switches: 0, cooldownsEnabled: true, exhausted: { until: Date.now() + 3600e3, seconds: 3600 } };
  const big = explainError({ ...base, requestBytes: 2_721_437, messages: 539 })!;
  expect(big.message).toContain('This request is large'); expect(big.message).toContain('539 messages'); expect(big.message).toContain('2.6 MB'); expect(big.message).toContain('compacting');
  expect(explainError({ ...base, requestBytes: 12_000, messages: 3 })!.message).not.toContain('large');
  expect(explainError(base)!.message).not.toContain('large');
  expect(largeRequestNote(399_999)).toBe(''); expect(largeRequestNote(400_000)).toContain('0.4 MB');
});
