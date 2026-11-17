import { expect, spyOn, test } from 'bun:test';
import { initBridge, providerChat, stopBridge } from '../backend/providers';
import type { Model, Provider } from '../backend/types';

test('the internal listener authenticates every request, exposes only inference, and rotates its secret on restart', async () => {
  const handlers: ((req: any, res: any) => unknown)[] = [], stopped: boolean[] = [];
  const serving = spyOn(Bun, 'serve').mockImplementation(((options: any) => {
    handlers.push(options.fetch); const index = handlers.length - 1;
    return { port: 19000 + index, stop: () => { stopped[index] = true; } };
  }) as any);
  let dispatched: { url: string; init: RequestInit } | undefined;
  const fetching = spyOn(globalThis, 'fetch').mockImplementation((async (url: any, init: RequestInit) => {
    dispatched = { url: String(url), init };
    return new Response('data: [DONE]\n\n');
  }) as any);
  const bridge = require('../vendor/bridge/server.js');
  let receivedHeaders: Record<string, string> | undefined;
  const handling = spyOn(bridge, 'handleRequest').mockImplementation((req: any, res: any) => {
    receivedHeaders = { ...req.headers };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  const p = { kind: 'free' } as Provider, model = { upstreamId: 'fixture' } as Model;
  const send = () => providerChat(p, model, { messages: [] }, new AbortController().signal, 'direct', 'fixture');
  const request = (method: string, route: string, secret?: string, handler = handlers.at(-1)!) => handler(new Request('http://127.0.0.1:19000' + route, {
    method, headers: { ...(secret ? { 'x-polygate-bridge': secret } : {}), 'x-polygate-route': 'direct' },
    ...(method === 'POST' ? { body: '{}' } : {}),
  }), { requestIP: () => ({ address: '127.0.0.1' }) }) as Promise<Response>;
  try {
    stopBridge(); await initBridge(); await initBridge();
    expect(handlers).toHaveLength(1);
    await send();
    expect(dispatched!.init.redirect).toBe('error');
    const secret = new Headers(dispatched!.init.headers).get('x-polygate-bridge')!;
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    for (const supplied of [undefined, 'wrong', `${secret}, ${secret}`]) {
      const response = await request('POST', '/v1/chat/completions', supplied);
      expect(response.status).toBe(401); expect(await response.text()).not.toContain(secret);
    }
    const duplicateHeaders = new Headers(); duplicateHeaders.append('x-polygate-bridge', secret); duplicateHeaders.append('x-polygate-bridge', secret);
    const duplicate = await handlers[0](new Request('http://127.0.0.1:19000/v1/chat/completions', { method: 'POST', headers: duplicateHeaders, body: '{}' }), { requestIP: () => ({ address: '127.0.0.1' }) }) as Response;
    expect(duplicate.status).toBe(401); await duplicate.text();
    for (const [method, route] of [['GET', '/v1/chat/completions'], ['POST', '/api/proxy'], ['POST', '/v1/chat/completions?extra=1']]) {
      const response = await request(method, route, secret); expect(response.status).toBe(404); await response.text();
    }
    expect(handling).not.toHaveBeenCalled();
    const accepted = await request('POST', '/v1/chat/completions', secret);
    expect(accepted.status).toBe(200); await accepted.text();
    expect(receivedHeaders?.['x-polygate-bridge']).toBeUndefined();
    stopBridge(); expect(stopped[0]).toBe(true);
    const stoppedResponse = await request('POST', '/v1/chat/completions', secret, handlers[0]); expect(stoppedResponse.status).toBe(401); await stoppedResponse.text();
    await expect(send()).rejects.toMatchObject({ type: 'provider_unavailable' });
    await initBridge(); await send();
    expect(handlers).toHaveLength(2);
    const next = new Headers(dispatched!.init.headers).get('x-polygate-bridge')!;
    expect(next).not.toBe(secret);
    const old = await request('POST', '/v1/chat/completions', secret); expect(old.status).toBe(401); await old.text();
    for (const credential of [secret, next]) { const stale = await request('POST', '/v1/chat/completions', credential, handlers[0]); expect(stale.status).toBe(401); await stale.text(); }
    expect(handling).toHaveBeenCalledTimes(1);
  } finally { stopBridge(); handling.mockRestore(); fetching.mockRestore(); serving.mockRestore(); }
});
