import { test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { settings } from '../backend/state';
import * as socks from '../backend/socks-bridge';
import { __tunnels, warpTarget, pinWarpTarget, releaseWarpPin, warpPinnedTarget, warpSpent } from '../backend/warp';
import { networkFetch, routeContext, findRoute, routeForProvider, routeAfter, __setCanarySender, __setExitVerifier } from '../backend/transport';
import { newCanaryId, takeExhaustion, takeRefused, takeInconclusive } from '../backend/exhaustion';
import { initBridge, stopBridge, providerChat } from '../backend/providers';

const saved = { routes: settings.routes, warp: settings.warp, exhaustedFailover: settings.exhaustedFailover, failover: settings.failover };
const nativeFetch = globalThis.fetch;
const savedTunnels = new Map(__tunnels);
let bridge: ReturnType<typeof spyOn>;
const tunnel = (port: number, ip = `203.0.113.${port - 41000}`) => ({ port, index: port - 41001, proc: {}, egressIp: ip, failures: 0, cooldownUntil: 0 }) as any;
const limit = () => new Response('FreeUsageLimitError', { status: 429, headers: { 'retry-after': '7200' } });
const send = () => networkFetch('https://opencode.ai/inference/v1/chat/completions', { method: 'POST', body: '{}' }, 'warp');
beforeEach(() => {
  __tunnels.clear(); __tunnels.set(41001, tunnel(41001)); __tunnels.set(41002, tunnel(41002));
  settings.routes = [{ id: 'warp', name: 'WARP', kind: 'warp', enabled: true, url: '', models: [] }];
  settings.warp = { engine: 'embedded' } as any; settings.exhaustedFailover = true;
  bridge = spyOn(socks, 'socksBridge').mockImplementation(async target => `http://127.0.0.1:${target.port}`);
});
afterEach(() => {
  bridge.mockRestore(); globalThis.fetch = nativeFetch; Object.assign(settings, saved); __setCanarySender(); __setExitVerifier();
  __tunnels.clear(); for (const [port, t] of savedTunnels) __tunnels.set(port, t);
});

test('opaque pins preserve the selected port without advancing round-robin and reject arbitrary ports', () => {
  const target = warpTarget()!; const pin = pinWarpTarget('warp', target)!;
  try { expect(warpPinnedTarget(pin)).toEqual(target); expect(findRoute(pin)?.kind).toBe('warp'); expect(warpPinnedTarget('warp-pin:41001')).toBeUndefined(); expect(findRoute('warp-pin:41001')).toBeUndefined(); }
  finally { releaseWarpPin(pin); }
  expect(warpPinnedTarget(pin)).toBeUndefined();
});
test('a pin rejects same-port replacement, changed egress and a disabled parent route', () => {
  const target = warpTarget()!; const pin = pinWarpTarget('warp', target)!;
  try {
    settings.routes[0].enabled = false; expect(warpPinnedTarget(pin)).toBeUndefined(); settings.routes[0].enabled = true;
    __tunnels.get(target.port)!.egressIp = '203.0.113.90'; expect(warpPinnedTarget(pin)).toBeUndefined();
    __tunnels.set(target.port, tunnel(target.port, target.egress)); expect(warpPinnedTarget(pin)).toBeUndefined();
  } finally { releaseWarpPin(pin); }
});
test('confirmation crosses a fresh bridge context on the original port, then retries only the clean tunnel', async () => {
  const ports: number[] = []; let first = 0; const pins: string[] = [];
  globalThis.fetch = (async (_url: any, init: any) => { const port = new URL(init.proxy).port; ports.push(Number(port)); first ||= Number(port); return Number(port) === first ? limit() : new Response('OK'); }) as typeof fetch;
  __setCanarySender(async id => {
    pins.push(id);
    // The HTTP bridge reconstructs context from headers, not from the original AsyncLocalStorage store.
    return routeContext.run({ routeId: id, requestId: newCanaryId() }, () => networkFetch('https://opencode.ai/inference/v1/chat/completions', { method: 'POST', body: '{}' }));
  });
  const response = await routeContext.run({ routeId: 'warp', requestId: 'warp-confirm' }, send);
  expect(await response.text()).toBe('OK'); expect(ports).toEqual([first, first, first === 41001 ? 41002 : 41001]);
  expect(pins[0]).toStartWith('warp-pin:'); expect(findRoute(pins[0])).toBeUndefined();
  expect(settings.routes[0].exhaustedUntil).toBeUndefined(); expect(takeExhaustion('warp-confirm')).toBeUndefined();
  expect(warpTarget('free', true)?.port).not.toBe(first); expect(warpTarget('openai', true)).not.toBeNull();
});
test('all exhausted tunnels stop after one confirmation per tunnel without retiring the route', async () => {
  settings.failover = true;
  settings.routes.push({ id: 'backup', name: 'Backup', kind: 'proxy', enabled: true, url: 'http://127.0.0.1:41003', models: [] });
  const route = settings.routes[0]; Object.assign(route, { cooldownUntil: 0, failures: 2, opened: 1, status: 'healthy' });
  const health = { cooldownUntil: route.cooldownUntil, failures: route.failures, opened: route.opened, status: route.status };
  let calls = 0; globalThis.fetch = (async () => { calls++; return limit(); }) as unknown as typeof fetch;
  __setCanarySender(async id => routeContext.run({ routeId: id, requestId: newCanaryId() }, () => networkFetch('https://opencode.ai/test', { method: 'POST', body: '{}' })));
  const response = await routeContext.run({ routeId: 'warp', requestId: 'warp-all' }, send);
  expect(response.status).toBe(429); void response.body?.cancel(); expect(calls).toBe(4);
  expect(takeExhaustion('warp-all')).toBeDefined(); expect(warpTarget('free', true)).toBeNull(); expect(warpTarget('openai', true)).not.toBeNull();
  expect(settings.routes[0].exhaustedUntil).toBeUndefined();
  for(let i=0;i<3;i++){
    await expect(send()).rejects.toMatchObject({ status: 503, type: 'route_unavailable' }); expect(calls).toBe(4);
    expect(route).toMatchObject(health);
  }
  expect(routeAfter({ kind: 'free' } as any, route)?.id).toBe('backup');
  const paid = { id: 'paid', kind: 'openai', routes: { ids: ['warp'] }, baseUrl: 'https://paid.example.test/v1' } as any;
  expect(routeForProvider(paid, 'test')).toBe(route);
  const target = warpTarget('openai', true)!; let port = 0;
  globalThis.fetch = (async (_url: any, init: any) => { port = Number(new URL(init.proxy).port); return new Response('paid OK'); }) as typeof fetch;
  const responsePaid = await providerChat(paid, { upstreamId: 'test' } as any, { messages: [] }, new AbortController().signal, route.id, 'paid-test');
  expect(await responsePaid.text()).toBe('paid OK'); expect(port).toBe(target.port);
  expect(warpTarget('free', true)).toBeNull();
});
test('a total WARP tunnel outage still opens the route breaker when a backup is available', async () => {
  settings.failover = true;
  settings.routes.push({ id: 'backup', name: 'Backup', kind: 'proxy', enabled: true, url: 'http://127.0.0.1:41003', models: [] });
  __tunnels.clear(); let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('must not dispatch'); }) as unknown as typeof fetch;
  await expect(send()).rejects.toMatchObject({ status: 503, type: 'route_unavailable' });
  expect(calls).toBe(0); expect(settings.routes[0].cooldownUntil).toBeGreaterThan(Date.now());
  expect(settings.routes[0].opened).toBe(1); expect(settings.routes[0].status).toContain('no usable tunnel');
});
test('providerChat carries the pin through the authenticated HTTP bridge header without inherited context', async () => {
  let handler: any; const serving = spyOn(Bun, 'serve').mockImplementation(((options: any) => { handler = options.fetch; return { port: 19441, stop() {} }; }) as any);
  const server = require('../vendor/bridge/server.js'); const ports: number[] = []; let header = '';
  const handling = spyOn(server, 'handleRequest').mockImplementation((async (_req: any, res: any) => {
    const r = await networkFetch('https://opencode.ai/test', { method: 'POST', body: '{}' });
    res.writeHead(r.status); res.end(await r.text());
  }) as any);
  try {
    stopBridge(); await initBridge();
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).startsWith('http://127.0.0.1:19441/')) {
        header = new Headers(init.headers).get('x-polygate-route')!;
        return routeContext.exit(() => handler(new Request(url, init), { requestIP: () => ({ address: '127.0.0.1' }) }));
      }
      ports.push(Number(new URL(init.proxy).port)); return ports.length === 1 ? limit() : new Response('OK');
    }) as typeof fetch;
    __setCanarySender(async id => providerChat({ kind: 'free' } as any, { upstreamId: 'test' } as any, { messages: [] }, new AbortController().signal, id, 'pin-test', newCanaryId()));
    const response = await routeContext.run({ routeId: 'warp', requestId: 'warp-http' }, send); void response.body?.cancel();
    expect(header).toStartWith('warp-pin:'); expect(ports).toHaveLength(2); expect(ports[1]).toBe(ports[0]);
    expect(takeRefused('warp-http')).toBe(true); expect(takeExhaustion('warp-http')).toBeUndefined();
  } finally { stopBridge(); handling.mockRestore(); serving.mockRestore(); }
});
test('a disappeared tunnel makes even a positive canary inconclusive and never tests a replacement', async () => {
  let calls = 0; globalThis.fetch = (async () => { calls++; return limit(); }) as unknown as typeof fetch;
  __setCanarySender(async id => { const target = warpPinnedTarget(id)!; __tunnels.set(target.port, tunnel(target.port)); return limit(); });
  const r = await routeContext.run({ routeId: 'warp', requestId: 'warp-gone' }, send); void r.body?.cancel();
  expect(calls).toBe(1); expect(takeExhaustion('warp-gone')).toBeUndefined(); expect(takeRefused('warp-gone')).toBe(false); expect(takeInconclusive('warp-gone')).toBe(true);
});
test('a new generation or changed egress does not inherit the old tunnel exhaustion', () => {
  const target = warpTarget()!; warpSpent(target, Date.now() + 60000);
  expect(warpTarget('free', true)?.port).not.toBe(target.port);
  __tunnels.set(target.port, tunnel(target.port)); __tunnels.delete(target.port === 41001 ? 41002 : 41001);
  expect(warpTarget('free', true)?.port).toBe(target.port);
});
