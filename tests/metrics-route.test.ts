import { test, expect } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { record } = await import('../backend/state');
const { metrics } = await import('../backend/metrics');

test('the hourly counts are also given per route, so one exit\'s card can show its own activity', () => {
  const now = Date.now();
  const row = (route: string, status: number, ago: number) => record({ id: crypto.randomUUID(), time: now - ago, model: 'm/x', provider: 'm', protocol: 'chat', route, status, ms: 100, input: 1, output: 1, error: '', keyId: 'k', fault: false } as any);
  row('Exit A', 200, 1000); row('Exit A', 500, 2000); row('Exit B', 200, 3000);
  const m: any = metrics();
  const a = m.hourlyByRoute.filter((x: any) => x.route === 'Exit A'), b = m.hourlyByRoute.filter((x: any) => x.route === 'Exit B');
  expect(a.reduce((n: number, x: any) => n + x.requests, 0)).toBe(2); expect(a.reduce((n: number, x: any) => n + x.errors, 0)).toBe(1);
  expect(b.reduce((n: number, x: any) => n + x.requests, 0)).toBe(1);
  expect(m.byRoute.find((x: any) => x.route === 'Exit A').requests).toBe(2);
});
