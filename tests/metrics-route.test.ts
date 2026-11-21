import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { preserveTestState } from './setup';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { record, db, migrateHourly } = await import('../backend/state');
const { metrics } = await import('../backend/metrics');
let restore: () => void;
beforeEach(() => {
  restore = preserveTestState();
  db.exec('DELETE FROM requests; DELETE FROM usage_hourly');
});
afterEach(() => restore());

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

test('upgrading backfills retained requests once, without shrinking existing busy-hour counters', () => {
  const legacy = new Database(':memory:');
  try {
    legacy.exec(`CREATE TABLE requests(time INTEGER, status INTEGER, input INTEGER, output INTEGER, ms INTEGER);
      INSERT INTO requests VALUES (3600000,200,1,2,10),(3600001,500,3,4,20),(7200000,200,2,3,4)`);
    const snapshot = () => legacy.query('SELECT * FROM usage_hourly ORDER BY hour').all();
    migrateHourly(legacy, 7200000);
    const expected = [{hour: 1, requests: 2, errors: 1, input: 4, output: 6, ms: 30}, {hour: 2, requests: 1, errors: 0, input: 2, output: 3, ms: 4}];
    expect(snapshot()).toEqual(expected);
    migrateHourly(legacy, 7200000);
    expect(snapshot()).toEqual(expected);

    // Simulate the unversioned rollup schema, with one missing hour and more traffic than the remaining detail.
    legacy.exec('PRAGMA user_version=0; DELETE FROM usage_hourly WHERE hour=1; UPDATE usage_hourly SET requests=9, ms=80 WHERE hour=2');
    migrateHourly(legacy, 7200000);
    expect(snapshot()).toEqual([expected[0], {...expected[1], requests: 9, ms: 80}]);
    legacy.exec('DELETE FROM requests');
    migrateHourly(legacy, 7200000);
    expect(snapshot()).toEqual([expected[0], {...expected[1], requests: 9, ms: 80}]);
  } finally { legacy.close(); }
});

test('adjacent rolling windows split cutoff hours and retain whole-hour totals after detail pruning', () => {
  const hour = 3600000, day = 24 * hour;
  const now = Math.floor(Date.now() / hour) * hour + hour / 2, cutoff = now - day;
  const row = (time: number, status = 200, ms = 10) => record({ id: crypto.randomUUID(), time, model: 'm', provider: 'p', protocol: 'chat', route: 'r', status, ms, input: 1, output: 2, error: '', keyId: '' });
  row(cutoff - day); row(cutoff - day + 1); row(cutoff - hour); row(cutoff - 1); row(cutoff);
  row(cutoff + 1, 500, 80); row(cutoff + hour); row(now);
  db.query('DELETE FROM requests WHERE time IN (?,?,?)').run(cutoff - hour, cutoff + hour, now);
  const m = metrics(now);
  expect(m).toMatchObject({requests: 3, previousRequests: 4, successRate: 66.7, errors: 1, inputTokens: 3, outputTokens: 6, avgMs: 33});
  expect(m.hourly).toEqual([cutoff + 1, cutoff + hour, now].map((t, i) => ({hour: Math.floor(t / hour) * hour, requests: 1, tokens: 3, errors: i ? 0 : 1, avgMs: i ? 10 : 80})));
  // A pruned partial-hour request has no recoverable timestamp. Do not guess or include the whole hour.
  db.query('DELETE FROM requests WHERE time=?').run(cutoff + 1);
  expect(metrics(now)).toMatchObject({requests: 2, previousRequests: 4, errors: 0});
});

test('an exact-hour cutoff excludes only the cutoff instant, and excludes future detail', () => {
  const hour = 3600000, now = Math.floor(Date.now() / hour) * hour, cutoff = now - 24 * hour;
  for (const time of [cutoff, cutoff + 1, cutoff + hour, now, now + 1]) record({id: crypto.randomUUID(), time, model: 'm', provider: 'p', protocol: 'chat', route: 'r', status: 200, ms: 10, input: 1, output: 2, error: '', keyId: ''});
  expect(metrics(now)).toMatchObject({requests: 3, previousRequests: 1, hourly: [cutoff, cutoff + hour, now].map(hour => ({hour, requests: 1}))});
});
