import { test, expect } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { record, db } = await import('../backend/state');
const { metrics } = await import('../backend/metrics');

test('requests are counted per route', () => {
  const now = Date.now();
  const row = (route: string, status: number, ago: number) => record({ id: crypto.randomUUID(), time: now - ago, model: 'm/x', provider: 'm', protocol: 'chat', route, status, ms: 100, input: 1, output: 1, error: '', keyId: 'k', fault: false } as any);
  row('Exit A', 200, 1000); row('Exit A', 500, 2000); row('Exit B', 200, 3000);
  const m: any = metrics();
  expect(m.byRoute.find((x: any) => x.route === 'Exit A')).toMatchObject({ requests: 2, errors: 1 });
  expect(m.byRoute.find((x: any) => x.route === 'Exit B').requests).toBe(1);
});

test('the summary groups failures, leaves out cancelled requests, and counts by provider, line and client', () => {
  const now = Date.now();
  db.exec('DELETE FROM requests');
  const row = (ago: number, provider: string, route: string, status: number, error = '', keyId = '') => record({ id: crypto.randomUUID(), time: now - ago, model: provider + '/m', provider, protocol: 'chat', route, status, ms: 100, input: 1, output: 1, error, keyId } as any);
  const queueFull = JSON.stringify({ error: { type: 'queue_full', message: 'Gateway queue is full. Retry shortly.' } });
  row(1000, 'a', '', 429, queueFull); row(2000, 'a', '', 429, queueFull); row(3000, 'b', 'Relay', 502, 'Slot 12 failed'); row(4000, 'b', 'Relay', 502, 'Slot 34 failed');
  row(5000, 'a', 'Direct connection', 499, 'Client disconnected'); row(6000, 'a', 'Direct connection', 200); row(7000, 'b', 'Relay', 200); row(86400000 + 5000, 'a', 'Direct connection', 200);
  const m: any = metrics();
  expect(m.failures.map((f: any) => [f.message, f.count])).toEqual([['Gateway queue is full. Retry shortly.', 2], ['Slot 12 failed', 2]]); // the JSON is read and numbers do not split a failure
  expect(m.failures.some((f: any) => /disconnected/.test(f.message))).toBe(false);
  expect(m.byProvider.find((p: any) => p.provider === 'a')).toMatchObject({ requests: 4, errors: 3 });
  expect(m.byLink).toContainEqual({ provider: 'b', route: 'Relay', requests: 3 });
  expect(m.byLink.some((l: any) => l.route === '')).toBe(false); // refused before a route was chosen: no line carried it
  expect(m.previousRequests).toBe(1);
  expect(m.byKey[0]).toMatchObject({ name: 'No key', requests: 7 });
});
