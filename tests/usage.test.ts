import { test, expect } from 'bun:test';
// State folder comes from tests/setup.ts.
const { record, db } = await import('../backend/state');
const { usage } = await import('../backend/metrics');
const DAY = 86400000;
const row = (daysAgo: number, model: string, route: string, status: number, input = 10, output = 20, ms = 100) => ({ id: crypto.randomUUID(), time: Date.now() - daysAgo * DAY, model, provider: 'p', protocol: 'chat', route, status, ms, input, output, error: '', keyId: 'k' });
test('usage groups requests by day, model and route, and fills idle days with zeros', () => {
  db.exec('DELETE FROM usage_daily');
  record(row(0, 'a/one', 'Direct', 200)); record(row(0, 'a/one', 'Direct', 500)); record(row(2, 'a/two', 'Relay', 200, 5, 5, 300)); record(row(40, 'a/one', 'Direct', 200));
  const week = usage(7);
  expect(week.days).toBe(7); expect(week.daily.length).toBe(7);
  expect(week.totals).toMatchObject({ requests: 3, errors: 1, input: 25, output: 45, activeDays: 2 });
  expect(week.daily[6].requests).toBe(2); expect(week.daily[4].requests).toBe(1); expect(week.daily[5].requests).toBe(0);
  const one = week.models.find(m => m.name === 'a/one')!; expect(one).toMatchObject({ requests: 2, errors: 1, tokens: 60, avgMs: 100 }); expect(one.daily[6]).toBe(2);
  expect(week.routes.map(r => r.name).sort()).toEqual(['Direct', 'Relay']);
  expect(usage(30).totals.requests).toBe(3); expect(usage(90).totals.requests).toBe(4); // the request from 40 days ago is only in the longer ranges
  expect(usage(5 as any).days).toBe(30); // an unknown range falls back to 30 days
});
test('usage keeps counting after the request log is pruned', () => {
  const before = usage(30).totals.requests; db.exec('DELETE FROM requests'); expect(usage(30).totals.requests).toBe(before);
});
test('an agent session\'s usage comes from the request log: requests, failures, tokens and the routes it went through', async () => {
  const { sessionUsage } = await import('../backend/state');
  for (const [status, route, ms] of [[200, 'Direct connection', 100], [500, 'Relay one', 200], [200, 'Relay one', 300]] as const) record({ ...row(0, 'a/one', route, status, 10, 20, ms), session: 'ses_usage_test' });
  record({ ...row(0, 'a/one', 'Direct connection', 200), session: 'ses_other' });
  const u = sessionUsage('ses_usage_test');
  expect(u).toMatchObject({ requests: 3, errors: 1, input: 30, output: 60 });
  expect(u.routes).toEqual([{ route: 'Relay one', requests: 2 }, { route: 'Direct connection', requests: 1 }]);
  expect(sessionUsage('ses_none')).toMatchObject({ requests: 0, routes: [] });
});
test('usage also groups by client key: the agent key by its name, and a deleted key or no key for what they are', async () => {
  const { settings } = await import('../backend/state');
  db.exec('DELETE FROM usage_keys_daily');
  const saved = settings.keys; settings.keys = [...saved, { id: 'k-agent', name: 'Polygate Agent', value: 'pg_usage_agent', enabled: true, limit: 4, agent: true }];
  try {
    record({ ...row(0, 'a/one', 'Direct', 200), keyId: 'k-agent' }); record({ ...row(0, 'a/one', 'Direct', 500), keyId: 'k-agent' });
    record({ ...row(1, 'a/two', 'Direct', 200), keyId: 'k-gone-123456' }); record({ ...row(1, 'a/two', 'Direct', 200), keyId: '' });
    const keys = usage(7).keys;
    expect(keys.find(k => k.name === 'Polygate Agent')).toMatchObject({ requests: 2, errors: 1, tokens: 60 });
    expect(keys.map(k => k.name).sort()).toEqual(['Deleted key k-gone', 'No key', 'Polygate Agent']);
    db.exec('DELETE FROM requests'); expect(usage(7).keys.find(k => k.name === 'Polygate Agent')!.requests).toBe(2);
  } finally { settings.keys = saved; }
});
