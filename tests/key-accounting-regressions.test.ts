import { test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { settings, models, logs } from '../backend/state';
import { __captureKeyTestState, authenticate, checkTokenRate, modelAllowed, recordUsage } from '../backend/keys';
import { inference, queue } from '../backend/gateway';
import type { ApiKey, Model } from '../backend/types';

const enc = new TextEncoder();
const sse = (data: unknown) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const chunk = (delta: any, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const reply = (...events: unknown[]) => new Response(events.map(sse).join(''), { headers: { 'content-type': 'text/event-stream' } });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const model = (id: string, upstreamId = id.slice(id.indexOf('/') + 1)): Model => ({ id, upstreamId, providerId: 'accounting', name: id, context: 128000, output: 4096, tools: true, reasoning: true, state: 'available', latency: 0, score: 50, priority: 1, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '' });

class Sink extends EventEmitter {
  headersSent = false; writableEnded = false; statusCode = 0; text = ''; headers: Record<string, unknown> = {};
  onWrite?: (text: string) => void;
  setHeader(name: string, value: unknown) { this.headers[name.toLowerCase()] = value; return this; }
  writeHead(status: number, headers: Record<string, unknown> = {}) { this.statusCode = status; this.headersSent = true; Object.assign(this.headers, headers); return this; }
  write(value: unknown) { const text = String(value); this.text += text; this.onWrite?.(text); return true; }
  end(value?: unknown) { if (value !== undefined) this.write(value); this.writableEnded = true; return this; }
}

async function fixture(run: (f: { key: ApiKey; body: any; send: (body?: any, sink?: Sink) => Promise<Sink>; fetch: (handler: (init: any) => Response | Promise<Response>) => void }) => Promise<void> | void) {
  const old = { ...settings }; const catalog = new Map(models); const nativeFetch = globalThis.fetch;
  const limits = [queue.max, queue.capacity]; const acquire = queue.acquire;
  const restoreKeys = __captureKeyTestState();
  const key: ApiKey = { id: crypto.randomUUID(), name: 'Accounting regression', value: crypto.randomUUID(), enabled: true, limit: 1, used: 0, requests: 0 };
  const body = { model: 'accounting/model', stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] };
  try {
    settings.enabled = true; settings.keys = [key]; settings.retries = 0; settings.timeoutMs = 30000; settings.queueWaitMs = 0; settings.cooldowns = false;
    settings.providers = [{ id: 'accounting', name: 'Accounting', enabled: true, kind: 'openai', baseUrl: 'https://accounting.invalid/v1', apiKey: '', models: [], routeId: 'accounting-direct', routes: { ids: ['accounting-direct'] } }];
    settings.routes = [{ id: 'accounting-direct', name: 'Accounting direct', kind: 'direct', url: '', enabled: true, models: [] }]; settings.routeId = 'accounting-direct'; settings.allowDirect = true; settings.rotate = false; settings.chains = []; settings.notify = undefined;
    models.clear(); models.set(body.model, model(body.model)); queue.max = 0; queue.capacity = 32;
    const installFetch = (handler: (init: any) => Response | Promise<Response>) => {
      globalThis.fetch = (async (url: any, init: any) => {
        if (String(url) !== 'https://accounting.invalid/v1/chat/completions') throw new Error(`Unexpected outbound request: ${url}`);
        return handler(init);
      }) as typeof fetch;
    };
    installFetch(() => reply(chunk({ content: 'answer' }), chunk({}, 'stop'), '[DONE]'));
    const send = async (requestBody = body, sink = new Sink()) => {
      const req = Readable.from([Buffer.from(JSON.stringify(requestBody))]) as IncomingMessage;
      req.headers = { authorization: `Bearer ${key.value}`, 'content-type': 'application/json' };
      await inference(req, sink as unknown as ServerResponse, 'chat'); return sink;
    };
    await run({ key, body, send, fetch: installFetch });
  } finally {
    restoreKeys();
    globalThis.fetch = nativeFetch; queue.acquire = acquire; [queue.max, queue.capacity] = limits;
    Object.assign(settings, old); models.clear(); for (const [id, m] of catalog) models.set(id, m);
  }
}

test('grants use exact catalog IDs or actual upstream IDs, never arbitrary suffixes', async () => {
  await fixture(({ key }) => {
    const allowed = 'a/vendor/model', collision = 'b/a/vendor/model';
    models.set(allowed, model(allowed, 'vendor/model')); models.set(collision, model(collision, 'a/vendor/model'));
    key.models = [allowed]; expect(modelAllowed(key, allowed)).toBe(true); expect(modelAllowed(key, collision)).toBe(false);
    key.models = ['vendor/model']; key.modelGrantKinds = { 'vendor/model': 'upstream' }; expect(modelAllowed(key, allowed)).toBe(true); expect(modelAllowed(key, collision)).toBe(false);
    key.models = ['model']; expect(modelAllowed(key, allowed)).toBe(false); expect(modelAllowed(key, 'accounting/model')).toBe(true);
    expect(modelAllowed(key, 'missing/anything/model')).toBe(false);
  });
});

test('request count includes unsuccessful attempts and failed dispatches retain estimated input, but listing does not count', async () => {
  await fixture(async ({ key, body, send, fetch }) => {
    const req = { headers: { authorization: `Bearer ${key.value}` } } as IncomingMessage;
    authenticate(req, false); expect(key.requests).toBe(0);
    fetch(() => { throw new Error('synthetic upstream failure'); });
    const result = await send(); expect(result.statusCode).toBe(502); expect(key.requests).toBe(1); expect(key.used).toBe(Math.ceil(JSON.stringify(body).length / 4)); expect(key.lastUsed).toBeGreaterThan(0);
    authenticate(req, false); checkTokenRate(key); recordUsage(key.id, 0); expect(key.requests).toBe(1);
  });
});

test('complete usage-less replies debit estimated input and content, not SSE overhead', async () => {
  await fixture(async ({ key, body, send, fetch }) => {
    const text = 'text'; const reasoning = 'reasoning'; const args = '{"x":1}';
    fetch(() => reply({ id: 'metadata'.repeat(200), ...chunk({ content: text, reasoning_content: reasoning, tool_calls: [{ index: 0, function: { arguments: args } }] }) }, chunk({}, 'tool_calls'), '[DONE]'));
    await send(); await send();
    const output = Math.ceil([text, reasoning, args].reduce((n, s) => n + JSON.stringify(s).length - 2, 0) / 4);
    expect(key.used).toBe(2 * (Math.ceil(JSON.stringify(body).length / 4) + output)); expect(key.requests).toBe(2);
  });
});

test('collected usage-less replies are charged and valid terminal zero usage still counts the request', async () => {
  await fixture(async ({ key, body, send, fetch }) => {
    const collected = { ...body, stream: false };
    fetch(() => reply(chunk({ content: 'answer' }), chunk({}, 'stop'), '[DONE]'));
    const result = await send(collected); expect(result.statusCode).toBe(200);
    const estimate = Math.ceil(JSON.stringify(collected).length / 4) + Math.ceil('answer'.length / 4);
    expect(key.used).toBe(estimate);
    fetch(() => reply({ ...chunk({}, 'stop'), usage: { prompt_tokens: 0, completion_tokens: 0 } }, '[DONE]'));
    await send(); expect(key.used).toBe(estimate); expect(key.requests).toBe(2);
  });
});

test('repeated cancellation after content but before usage advances both budget and TPM', async () => {
  await fixture(async ({ key, body, send, fetch }) => {
    const text = 'cancelled answer';
    fetch(init => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(enc.encode(sse(chunk({ content: text }))));
      init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } }));
    for (let i = 0; i < 3; i++) { const sink = new Sink(); sink.onWrite = s => { if (s.includes(text)) sink.emit('close'); }; await send(body, sink); }
    const perRequest = Math.ceil(JSON.stringify(body).length / 4) + Math.ceil(text.length / 4);
    expect(key.used).toBe(3 * perRequest); expect(key.requests).toBe(3);
    const row = logs(20).find(row => row.keyId === key.id); expect(row?.status).toBe(499); expect(row?.output).toBeGreaterThan(0);
    key.tpm = key.used; expect(() => checkTokenRate(key)).toThrow(/Token rate limit/);
    delete key.tpm; key.budget = key.used; expect(() => authenticate({ headers: { authorization: `Bearer ${key.value}` } } as IncomingMessage, false)).toThrow(/Token budget/);
  });
});

test('complete terminal usage is authoritative, while early, partial and interrupted usage use conservative maxima', async () => {
  await fixture(async ({ key, body, send, fetch }) => {
    const long = 'x'.repeat(800); const estimate = Math.ceil(JSON.stringify(body).length / 4);
    fetch(() => reply(chunk({ content: long }), { ...chunk({}, 'stop'), usage: { prompt_tokens: 2, completion_tokens: 3 } }, '[DONE]'));
    await send(); expect(key.used).toBe(5);
    fetch(() => reply({ ...chunk({ content: long }), usage: { prompt_tokens: 1, completion_tokens: 1 } }, chunk({}, 'stop'), '[DONE]'));
    await send(); expect(key.used).toBe(5 + estimate + 200);
    fetch(() => reply(chunk({ content: long }), { ...chunk({}, 'stop'), usage: { prompt_tokens: 1 } }, '[DONE]'));
    await send(); expect(key.used).toBe(5 + 2 * (estimate + 200));
    fetch(() => reply({ ...chunk({ content: 'short' }), usage: { prompt_tokens: 500, completion_tokens: 300 } }));
    await send(); expect(key.used).toBe(805 + 2 * (estimate + 200));
  });
});

for (const change of ['disable', 'delete', 'expiry', 'regenerate', 'scope', 'budget', 'tpm', 'pause'] as const) {
  test(`queued requests revalidate ${change} before calling upstream`, async () => {
    await fixture(async ({ key, send, fetch }) => {
      let calls = 0; fetch(() => { calls++; return reply(chunk({}, 'stop'), '[DONE]'); });
      const entered = deferred(), admit = deferred(); let released = 0;
      queue.acquire = async () => { entered.resolve(); await admit.promise; return () => { released++; }; };
      const pending = send(); await entered.promise;
      switch (change) {
        case 'disable': key.enabled = false; break;
        case 'delete': settings.keys = []; break;
        case 'expiry': key.expiresAt = 1; break;
        case 'regenerate': key.value = 'replacement'; break;
        case 'scope': settings.keys = [{ ...key, models: ['not-permitted'] }]; break;
        case 'budget': key.budget = 1; key.used = 1; break;
        case 'tpm': key.tpm = 1; recordUsage(key.id, 1); break;
        case 'pause': settings.enabled = false; break;
      }
      admit.resolve(); const result = await pending;
      expect(calls).toBe(0); expect(result.statusCode).toBeGreaterThanOrEqual(400); expect(released).toBe(1); expect(key.requests).toBe(1);
    });
  });
}

test('post-queue revalidation does not count RPM twice and refreshed scope selects an allowed auto candidate', async () => {
  await fixture(async ({ key, body, send, fetch }) => {
    key.rpm = 1; models.set('accounting/second', model('accounting/second'));
    const entered = deferred(), admit = deferred();
    queue.acquire = async () => { entered.resolve(); await admit.promise; return () => {}; };
    let selected = ''; fetch(init => { selected = JSON.parse(init.body).model; return reply(chunk({}, 'stop'), '[DONE]'); });
    const pending = send({ ...body, model: 'auto' }); await entered.promise;
    settings.keys = [{ ...key, models: ['accounting/second'] }]; admit.resolve(); const result = await pending;
    expect(result.statusCode).toBe(200); expect(selected).toBe('second'); expect(settings.keys[0].requests).toBe(1);
  });
});

test('cancellation makes even full usage conservative when the stream has not completed', async () => {
  await fixture(async ({ key, body, send, fetch }) => {
    const text = 'x'.repeat(400);
    fetch(init => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(enc.encode(sse({ ...chunk({ content: text }), usage: { prompt_tokens: 1, completion_tokens: 1 } })));
      init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } }));
    const sink = new Sink(); sink.onWrite = s => { if (s.includes(text)) sink.emit('close'); };
    await send(body, sink); expect(key.used).toBe(Math.ceil(JSON.stringify(body).length / 4) + 100);
  });
});

test('one finished choice cannot make multi-choice partial usage authoritative', async () => {
  await fixture(async ({ key, body, send, fetch }) => {
    const request = { ...body, n: 2 }; const text = 'x'.repeat(400);
    fetch(() => reply(chunk({ content: text }), { ...chunk({}, 'stop'), usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    await send(request); expect(key.used).toBe(Math.ceil(JSON.stringify(request).length / 4) + 100);
  });
});

test('a body error after finish does not make reported usage authoritative', async () => {
  await fixture(async ({ key, body, send, fetch }) => {
    const text = 'x'.repeat(400); let source!: ReadableStreamDefaultController<Uint8Array>;
    fetch(() => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      source = controller; controller.enqueue(enc.encode(sse(chunk({ content: text })) + sse({ ...chunk({}, 'stop'), usage: { prompt_tokens: 1, completion_tokens: 1 } })));
    } }), { headers: { 'content-type': 'text/event-stream' } }));
    const sink = new Sink(); sink.onWrite = s => { if (s.includes('finish_reason') && s.includes('stop')) source.error(new Error('synthetic body failure')); };
    await send(body, sink); expect(key.used).toBe(Math.ceil(JSON.stringify(body).length / 4) + 100);
  });
});

test('completed usage is charged before releasing the next queued request', async () => {
  await fixture(async ({ key, body, send, fetch }) => {
    const input = Math.ceil(JSON.stringify(body).length / 4);
    key.budget = input + body.max_tokens; key.limit = 1; queue.max = 1;
    const started = deferred(), finish = deferred(), queued = deferred(); let calls = 0;
    fetch(async () => { calls++; started.resolve(); await finish.promise; return reply(chunk({ content: 'answer' }), { ...chunk({}, 'stop'), usage: { prompt_tokens: input, completion_tokens: body.max_tokens } }, '[DONE]'); });
    const acquire = queue.acquire.bind(queue);
    queue.acquire = (...args) => { const result = acquire(...args); if (queue.waiting.length) queued.resolve(); return result; };
    const first = send(); await started.promise; const second = send(); await queued.promise;
    finish.resolve(); const [, next] = await Promise.all([first, second]);
    expect(calls).toBe(1); expect(next.statusCode).toBe(429); expect(key.used).toBe(key.budget); expect(key.requests).toBe(2);
  });
});
