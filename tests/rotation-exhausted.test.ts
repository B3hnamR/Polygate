import { test, expect, afterEach } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { settings } = await import('../backend/state');
const { routeFor } = await import('../backend/transport');
const saved = { routes: settings.routes.slice(), routeId: settings.routeId, rotate: settings.rotate, strategy: settings.strategy, allow: settings.allowDirect, failover: settings.exhaustedFailover };
afterEach(() => { settings.routes.length = 0; settings.routes.push(...saved.routes); settings.routeId = saved.routeId; settings.rotate = saved.rotate; settings.strategy = saved.strategy; settings.allowDirect = saved.allow; settings.exhaustedFailover = saved.failover; });
const proxy = (id: string, used = false) => { const r: any = { id, name: id, kind: 'proxy', url: 'socks5://127.0.0.1:1', enabled: true, models: [] }; if (used) r.exhaustedUntil = Date.now() + 3600_000; settings.routes.push(r); return r; };

test('round robin keeps rotating over the healthy routes when the selected route is used up', () => {
  proxy('rx-a', true); proxy('rx-b'); proxy('rx-c');
  settings.routeId = 'rx-a'; settings.rotate = true; settings.strategy = 'round_robin'; settings.exhaustedFailover = true;
  const seen = new Set(Array.from({ length: 6 }, () => routeFor('opencode/x').id));
  expect(seen.has('rx-a')).toBe(false); expect(seen.has('rx-b')).toBe(true); expect(seen.has('rx-c')).toBe(true);
});

test('with rotation off, a used-up selected route is still replaced by a clean backup', () => {
  proxy('rx-a', true); proxy('rx-b');
  settings.routeId = 'rx-a'; settings.rotate = false; settings.exhaustedFailover = true;
  expect(routeFor('opencode/x').id).toBe('rx-b');
});

test('when every rotating route is used up, the backup exits still answer', () => {
  settings.routes.length = 0; settings.routes.push(...saved.routes.filter(r => r.id === 'direct'));
  proxy('rx-a', true); proxy('rx-b', true);
  settings.routeId = 'rx-a'; settings.rotate = true; settings.strategy = 'round_robin'; settings.exhaustedFailover = true; settings.allowDirect = true;
  expect(routeFor('opencode/x').id).toBe('direct');
  settings.allowDirect = false;
  expect(() => routeFor('opencode/x')).toThrow(/unavailable or cooling down/);
});
