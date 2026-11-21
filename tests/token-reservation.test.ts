import { test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db, settings, models } from '../backend/state';
import { __captureKeyTestState, checkTokenRate, reserveTokens } from '../backend/keys';
import { inference, queue } from '../backend/gateway';
import { GatewayError } from '../backend/queue';
import { timing, zaiBody } from '../backend/zai';
import type { ApiKey, Model } from '../backend/types';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const event = (data: unknown) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const delta = (content = '', finish_reason: string | null = null, index = 0) => ({ choices: [{ index, delta: { content }, finish_reason }] });
const reply = (...data: unknown[]) => new Response(data.map(event).join(''), { headers: { 'content-type': 'text/event-stream' } });
class Sink extends EventEmitter {
  headersSent = false; writableEnded = false; statusCode = 0; text = ''; onWrite?: (text: string) => void;
  setHeader() { return this; }
  writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; }
  write(value: unknown) { const text = String(value); this.text += text; this.onWrite?.(text); return true; }
  end(value?: unknown) { if (value !== undefined) this.write(value); this.writableEnded = true; return this; }
}
async function fixture(run: (f: { key: ApiKey; body: any; model: Model; send: (body?: any, sink?: Sink) => Promise<Sink>; fetch: (handler: (init: any) => Response | Promise<Response>) => void }) => Promise<void> | void) {
  const saved = { ...settings }, catalog = new Map(models), nativeFetch = globalThis.fetch;
  const limits = [queue.max, queue.capacity]; const restore = __captureKeyTestState(); const wait = timing.wait;
  const key: ApiKey = { id: crypto.randomUUID(), value: crypto.randomUUID(), name: 'Reservation', enabled: true, limit: 0, used: 0, requests: 0 };
  const body = { model: 'reservation/model', stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] };
  const model: Model = { id: body.model, upstreamId: 'model', providerId: 'reservation', name: 'Model', context: 128000, output: 64, state: 'available', tools: true, reasoning: false, latency: 0, score: 50, priority: 1, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '' };
  try {
    Object.assign(settings, { enabled: true, keys: [key], retries: 0, timeoutMs: 30000, queueWaitMs: 0, cooldowns: false, fallback: false, chains: [], notify: undefined, allowDirect: true, rotate: false, routeId: 'reservation-direct', providers: [{ id: 'reservation', name: 'Reservation', enabled: true, kind: 'openai', baseUrl: 'https://reservation.invalid/v1', apiKey: '', models: [], routes: { ids: ['reservation-direct'] } }], routes: [{ id: 'reservation-direct', name: 'Direct', kind: 'direct', url: '', enabled: true, models: [] }] });
    models.clear(); models.set(model.id, model); queue.max = 0; queue.capacity = 32;
    const install = (handler: (init: any) => Response | Promise<Response>) => { globalThis.fetch = (async (url: any, init: any) => { if (String(url) !== 'https://reservation.invalid/v1/chat/completions') throw new Error(`Unexpected outbound request: ${url}`); return handler(init); }) as typeof fetch; };
    install(() => reply(delta('ok'), delta('', 'stop'), '[DONE]'));
    const send = async (b = body, sink = new Sink()) => { const req = Readable.from([Buffer.from(JSON.stringify(b))]) as IncomingMessage; req.headers = { authorization: `Bearer ${key.value}` }; try { await inference(req, sink as unknown as ServerResponse, 'chat'); } catch (e) { if (!(e instanceof GatewayError)) throw e; sink.writeHead(e.status); sink.end(JSON.stringify({ error: { message: e.message } })); } return sink; };
    await run({ key, body, model, send, fetch: install });
  } finally { restore(); timing.wait = wait; globalThis.fetch = nativeFetch; [queue.max, queue.capacity] = limits; Object.assign(settings, saved); models.clear(); for (const [id, m] of catalog) models.set(id, m); }
}
const estimate = (body: any) => Math.ceil(JSON.stringify(body).length / 4);
function useZai(model: Model) {
  settings.providers[0].kind = 'zai'; settings.providers[0].id = model.providerId = 'zai';
  settings.zai = { active: 'reservation-account', accounts: [{ id: 'reservation-account', token: 'fixture-token', enabled: true, expiresAt: 0, deviceMid: 'device', name: 'Fixture', email: '', addedAt: 0 }] };
}
const zaiInput = (chat: any) => {
  const { system, messages, tools, tool_choice } = zaiBody(chat, 'model', 'device', 'session');
  return estimate({ system, messages, tools, tool_choice });
};
const zaiReply = (text: string) => reply({ type: 'message_start', message: {} }, { type: 'content_block_delta', delta: { type: 'text_delta', text } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' });

for (const field of ['budget', 'tpm'] as const) test(`${field} atomically counts completed plus in-flight tokens without debiting unused output`, async () => {
  await fixture(async ({ key, body, send, fetch }) => {
    key[field] = estimate(body) + body.max_tokens;
    const started = deferred(), finish = deferred(); let calls = 0;
    fetch(async () => { calls++; started.resolve(); await finish.promise; return reply(delta('ok'), { ...delta('', 'stop'), usage: { prompt_tokens: 2, completion_tokens: 3 } }, '[DONE]'); });
    const first = send(); await started.promise;
    try { const next = await send(); expect(next.statusCode).toBe(429); expect(calls).toBe(1); expect(key.used).toBe(0); expect(() => __captureKeyTestState()).toThrow(/reservations/); }
    finally { finish.resolve(); await first; }
    expect(key.used).toBe(5); expect(() => checkTokenRate(key)).not.toThrow();
    key[field]! += 5; expect((await send()).statusCode).toBe(200); expect(key.used).toBe(10);
  });
});

test('active TPM holds do not expire, state restore refuses them, and settlement is idempotent across key rotation', async () => {
  await fixture(({ key }) => {
    key.tpm = 100; key.budget = 100;
    const restore = __captureKeyTestState(); const hold = reserveTokens(key, 100); const now = Date.now;
    try { Date.now = () => now() + 120000; expect(() => reserveTokens(key, 1)).toThrow(); expect(() => restore()).toThrow(/reservations/); settings.keys = [{ ...key, value: 'rotated', enabled: false }]; }
    finally { Date.now = now; hold.settle(7); hold.settle(99); }
    expect(settings.keys[0].used).toBe(7); expect(() => restore.assertIdle()).not.toThrow();
  });
});

test('cancellation reconciles partial content and releases unused allowance before another request', async () => {
  await fixture(async ({ key, body, send, fetch }) => {
    const cost = estimate(body); key.budget = 2 * (cost + body.max_tokens);
    fetch(init => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(event(delta('partial')))); init.signal.addEventListener('abort', () => c.error(init.signal.reason), { once: true }); } }), { headers: { 'content-type': 'text/event-stream' } }));
    const sink = new Sink(); sink.onWrite = text => { if (text.includes('partial')) sink.emit('close'); };
    await send(body, sink); expect(key.used).toBe(cost + 2);
    fetch(() => reply(delta('ok'), delta('', 'stop'), '[DONE]')); expect((await send()).statusCode).toBe(200); expect(key.used).toBe(2 * cost + 3);
  });
});

test('failed attempts consume estimates and cannot reset the allowance on retries or model fallback', async () => {
  await fixture(async ({ key, body, model, send, fetch }) => {
    settings.retries = 1; key.budget = estimate(body) + body.max_tokens; let calls = 0;
    fetch(() => { calls++; return new Response(JSON.stringify({ error: { message: 'temporary' } }), { status: 503 }); });
    expect((await send()).statusCode).toBe(429); expect(calls).toBe(1); expect(key.used).toBe(estimate(body));
    settings.retries = 0; settings.chains = [{ id: 'reservation-chain', name: 'reservation-chain', enabled: true, models: [model.id, 'reservation/second'], created: Date.now() }];
    models.set('reservation/second', { ...model, id: 'reservation/second', upstreamId: 'second' });
    const chained = { ...body, model: 'reservation-chain' }; key.used = 0; key.budget = estimate(chained) + body.max_tokens; calls = 0;
    expect((await send(chained)).statusCode).toBe(429); expect(calls).toBe(1); expect(key.used).toBe(estimate(chained));
  });
});

test('connection failures settle conservatively without leaking holds', async () => {
  await fixture(async ({ key, body, send, fetch }) => {
    key.budget = 1000; fetch(() => { throw new Error('synthetic connection failure'); });
    expect((await send()).statusCode).toBe(502); expect(key.used).toBe(estimate(body));
    expect(() => __captureKeyTestState()).not.toThrow();
  });
});

test('model fallback reserves the next model default and retains previous attempt consumption', async () => {
  await fixture(async ({ key, body, model, send, fetch }) => {
    const request = { ...body, model: 'bounded-chain' }; delete (request as any).max_tokens;
    settings.chains = [{ id: 'bounded-chain', name: 'bounded-chain', enabled: true, models: [model.id, 'reservation/small'], created: Date.now() }];
    models.set('reservation/small', { ...model, id: 'reservation/small', upstreamId: 'small', output: 8 });
    key.budget = 2 * estimate(request) + model.output; let calls = 0;
    fetch(init => { calls++; return JSON.parse(init.body).model === 'model' ? new Response('temporary', { status: 503 }) : reply(delta('ok'), { ...delta('', 'stop'), usage: { prompt_tokens: 2, completion_tokens: 3 } }, '[DONE]'); });
    expect((await send(request)).statusCode).toBe(200); expect(calls).toBe(2); expect(key.used).toBe(estimate(request) + 5);
  });
});

test('n and best_of reserve every generated choice and unknown output bounds reject only limited keys', async () => {
  await fixture(async ({ key, body, model, send, fetch }) => {
    let calls = 0; fetch(() => { calls++; return reply(delta('ok'), delta('', 'stop'), '[DONE]'); });
    const multi = { ...body, n: 2, best_of: 3 }; key.budget = estimate(multi) + 3 * body.max_tokens - 1;
    expect((await send(multi)).statusCode).toBe(429); expect(calls).toBe(0); expect(key.used).toBe(0);
    model.output = 0; const unbounded = { ...body }; delete (unbounded as any).max_tokens; key.budget = 1000000;
    const rejected = await send(unbounded); expect(rejected.statusCode).toBe(400); expect(rejected.text).toContain('max_completion_tokens'); expect(calls).toBe(0);
    const unsupported = await send({ ...unbounded, max_output_tokens: 1 }); expect(unsupported.statusCode).toBe(400); expect(unsupported.text).toContain('Responses-only'); expect(calls).toBe(0);
    delete key.budget; expect((await send(unbounded)).statusCode).toBe(200); expect(calls).toBe(1);
  });
});

test('known model defaults are reserved without changing requested output and explicit completion limits are honored', async () => {
  await fixture(async ({ key, body, model, send, fetch }) => {
    const request = { ...body, max_completion_tokens: 12 }; delete (request as any).max_tokens; let sent: any;
    fetch(init => { sent = JSON.parse(init.body); return reply(delta('ok'), delta('', 'stop'), '[DONE]'); });
    key.budget = estimate(request) + 12; expect((await send(request)).statusCode).toBe(200); expect(sent.max_completion_tokens).toBe(12);
    const defaults = { ...request }; delete (defaults as any).max_completion_tokens; key.used = 0; key.budget = estimate(defaults) + model.output - 1;
    expect((await send(defaults)).statusCode).toBe(429);
    key.budget++; expect((await send(defaults)).statusCode).toBe(200); expect(sent.max_completion_tokens).toBeUndefined(); expect(sent.max_tokens).toBeUndefined();
  });
});

test('observed streaming usage above reservation aborts and is reconciled, not silently forgiven', async () => {
  await fixture(async ({ key, body, send, fetch }) => {
    key.budget = estimate(body) + body.max_tokens;
    fetch(() => reply(delta('x'.repeat(400)), delta('', 'stop'), '[DONE]'));
    const sink = await send(); expect(sink.text).not.toContain('x'.repeat(400)); expect(key.used).toBe(estimate(body) + 100);
    expect(sink.text).toContain('insufficient_quota'); expect(sink.text).toContain('reserved token allowance');
    expect(() => __captureKeyTestState()).not.toThrow();
  });
});

test('unsafe upstream usage cannot strand reservations or poison later valid requests', async () => {
  await fixture(async ({ key, body, send, fetch }) => {
    key.budget = 1000;
    fetch(() => reply(delta('ok'), { ...delta('', 'stop'), usage: { prompt_tokens: 1e100, completion_tokens: 1e100 } }, '[DONE]'));
    expect((await send()).statusCode).toBe(200); expect(key.used).toBe(estimate(body) + 1);
    expect(() => __captureKeyTestState()).not.toThrow();
    fetch(() => reply(delta('ok'), delta('', 'stop'), '[DONE]')); expect((await send()).statusCode).toBe(200);
    const before = key.used!; const malformed = reserveTokens(key, 10); malformed.settle(1e100);
    expect(key.used).toBe(before + 10); expect(() => __captureKeyTestState()).not.toThrow();
  });
});

test('limited keys reject opaque media and unbounded OpenCode sessions before dispatch', async () => {
  await fixture(async ({ key, body, model, send, fetch }) => {
    key.budget = 1000000; let calls = 0; fetch(() => { calls++; return reply(delta('', 'stop'), '[DONE]'); });
    const image = { ...body, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://image.invalid/tiny-url' } }] }] };
    const media = await send(image); expect(media.statusCode).toBe(400); expect(media.text).toContain('text-only');
    settings.providers[0].kind = 'opencode'; model.upstreamId = 'vendor/model';
    const server = await send(); expect(server.statusCode).toBe(400); expect(server.text).toContain('does not forward'); expect(calls).toBe(0); expect(key.used).toBe(0);
  });
});

test('unaccounted Free bridge retries reject limited keys and Z.ai defaults use their adapter bound', async () => {
  await fixture(async ({ key, body, model, send }) => {
    const request = { ...body, max_tokens: 1 }; key.budget = estimate(request) + 511;
    settings.providers[0].kind = 'free'; const free = await send(request); expect(free.statusCode).toBe(400); expect(free.text).toContain('bridge retries'); expect(key.used).toBe(0);
    useZai(model); const defaults = { ...body }; delete (defaults as any).max_tokens;
    key.budget = zaiInput(defaults) + 127999; expect((await send(defaults)).statusCode).toBe(429); expect(key.used).toBe(0);
  });
});

test('accepted multi-choice output holds its full allowance until every choice settles', async () => {
  await fixture(async ({ key, body, send, fetch }) => {
    const request = { ...body, n: 2 }; key.budget = estimate(request) + 2 * body.max_tokens;
    const started = deferred(), finish = deferred();
    fetch(async () => { started.resolve(); await finish.promise; return reply(delta('one', null, 0), delta('two', null, 1), delta('', 'stop', 0), { ...delta('', 'stop', 1), usage: { prompt_tokens: 2, completion_tokens: 4 } }, '[DONE]'); });
    const first = send(request); await started.promise;
    try { expect((await send(request)).statusCode).toBe(429); expect(key.used).toBe(0); }
    finally { finish.resolve(); await first; }
    expect(key.used).toBe(6); expect(() => __captureKeyTestState()).not.toThrow();
  });
});

test('disabled, regenerated, reset and deleted active keys release holds without losing replacement-key accounting', async () => {
  for (const change of ['disable', 'regenerate', 'reset', 'delete'] as const) await fixture(async ({ key, body, send, fetch }) => {
    key.budget = 1000; const started = deferred(), finish = deferred();
    fetch(async () => { started.resolve(); await finish.promise; return reply(delta('ok'), { ...delta('', 'stop'), usage: { prompt_tokens: 2, completion_tokens: 3 } }, '[DONE]'); });
    const pending = send(); await started.promise;
    if (change === 'delete') settings.keys = [];
    else settings.keys = [{ ...key, enabled: change !== 'disable', value: change === 'regenerate' ? 'new-value' : key.value, used: change === 'reset' ? 0 : key.used }];
    finish.resolve(); await pending; expect(() => __captureKeyTestState()).not.toThrow();
    if (change !== 'delete') expect(settings.keys[0].used).toBe(5);
    else { settings.keys = [key]; const hold = reserveTokens(key, 1000); hold.settle(0); }
  });
});

test('a response failure and cancellation while queued both release capacity', async () => {
  await fixture(async ({ key, body, send, fetch }) => {
    key.budget = 1000;
    const broken = new Sink(); broken.setHeader = () => { throw new Error('synthetic response header failure'); };
    expect((await send(body, broken)).statusCode).toBe(502); expect(key.used).toBe(estimate(body)); expect(() => __captureKeyTestState()).not.toThrow();
    const started = deferred(), finish = deferred(), queued = deferred(); const acquire = queue.acquire;
    key.limit = 1; queue.max = 1;
    queue.acquire = function (...args) { const pending = acquire.apply(this, args); if (this.waiting.length) queued.resolve(); return pending; };
    fetch(async () => { started.resolve(); await finish.promise; return reply(delta('ok'), delta('', 'stop'), '[DONE]'); });
    const first = send(); await started.promise; const sink = new Sink(), second = send(body, sink); await queued.promise;
    try { sink.emit('close'); expect((await second).statusCode).toBe(499); }
    finally { queue.acquire = acquire; finish.resolve(); await first; }
    expect(() => __captureKeyTestState()).not.toThrow();
  });
});

for (const kind of ['openai', 'kilo'] as const) test(`${kind} internal output retry debits refusal usage and reserves the modified output before dispatch`, async () => {
  await fixture(async ({ key, body, model, send, fetch }) => {
    settings.providers[0].kind = kind; model.output = 0;
    const request = { ...body, max_tokens: 9000 }; const input = estimate(request); key.budget = 2 * input + 9000;
    const sent: number[] = [];
    fetch(init => { sent.push(JSON.parse(init.body).max_tokens); return sent.length === 1 ? new Response(JSON.stringify({ error: { message: 'max_tokens maximum is 8192' }, usage: { prompt_tokens: input + 3, completion_tokens: 2 } }), { status: 400 }) : reply(delta('ok'), { ...delta('', 'stop'), usage: { prompt_tokens: 2, completion_tokens: 3 } }, '[DONE]'); });
    expect((await send(request)).statusCode).toBe(200); expect(sent).toEqual([9000, kind === 'openai' ? 8192 : 4096]);
    expect(key.used).toBe(input + 10); expect(() => __captureKeyTestState()).not.toThrow();
  });
});

for (const kind of ['openai', 'kilo'] as const) test(`${kind} internal retry cannot dispatch after its failed-attempt usage exhausts the key`, async () => {
  await fixture(async ({ key, body, model, send, fetch }) => {
    settings.providers[0].kind = kind; model.output = 0; const request = { ...body, max_tokens: 9000 }; key.budget = estimate(request) + 9000; let calls = 0;
    fetch(() => { calls++; return new Response(JSON.stringify({ error: { message: 'max_tokens maximum is 8192' }, usage: { prompt_tokens: key.budget, completion_tokens: 0 } }), { status: 400 }); });
    expect((await send(request)).statusCode).toBe(429); expect(calls).toBe(1); expect(key.used).toBe(key.budget); expect(() => __captureKeyTestState()).not.toThrow();
  });
});

test('mixed output aliases retain smaller bounds while retry accounting charges both attempts', async () => {
  await fixture(async ({ key, body, model, send, fetch }) => {
    model.output = 0;
    const request = { ...body, max_tokens: 1000, max_completion_tokens: 9000 }, input = estimate(request);
    key.budget = 2 * input + 9000;
    const sent: any[] = [];
    fetch(init => {
      sent.push(JSON.parse(init.body));
      return sent.length === 1 ? Response.json({ error: { message: 'max_completion_tokens maximum is 8192' }, usage: { prompt_tokens: input + 3, completion_tokens: 2 } }, { status: 400 })
        : reply(delta('ok'), { ...delta('', 'stop'), usage: { prompt_tokens: 2, completion_tokens: 3 } }, '[DONE]');
    });
    expect((await send(request)).statusCode).toBe(200);
    expect(sent.map(b => [b.max_tokens, b.max_completion_tokens])).toEqual([[1000, 9000], [1000, 8192]]);
    expect(key.used).toBe(input + 10); expect(() => __captureKeyTestState()).not.toThrow();
  });
});

test('mixed output aliases do not dispatch a retry after refusal usage consumes the budget', async () => {
  await fixture(async ({ key, body, model, send, fetch }) => {
    model.output = 0;
    const request = { ...body, max_tokens: 1000, max_completion_tokens: 9000 }; key.budget = estimate(request) + 9000;
    let calls = 0;
    fetch(() => { calls++; return Response.json({ error: { message: 'max_completion_tokens maximum is 8192' }, usage: { prompt_tokens: key.budget, completion_tokens: 0 } }, { status: 400 }); });
    expect((await send(request)).statusCode).toBe(429); expect(calls).toBe(1);
    expect(key.used).toBe(key.budget); expect(() => __captureKeyTestState()).not.toThrow();
  });
});

test('Z.ai reserves the translated prompt and tools, not transport metadata, and uses that input for the stream ceiling', async () => {
  await fixture(async ({ key, body, model, send }) => {
    useZai(model);
    settings.zai!.accounts[0].deviceMid = 'device'.repeat(1000);
    const request = { ...body, max_tokens: 1, metadata: { trace: 'a'.repeat(4096) } };
    const input = zaiInput(request); let calls = 0;
    globalThis.fetch = Object.assign(async () => zaiReply(++calls === 1 ? 'ok' : 'too much'), { preconnect: globalThis.fetch.preconnect });
    key.budget = input + 1; expect(key.budget).toBeLessThan(400);
    const tool = { type: 'function', function: { name: 'lookup', description: 'description '.repeat(32), parameters: { type: 'object' } } };
    for (const larger of [{ ...request, tools: [tool] }, { ...request, messages: [{ role: 'system', content: 'instructions '.repeat(32) }, ...request.messages] }]) {
      expect((await send(larger)).statusCode).toBe(429); expect(calls).toBe(0); expect(key.used).toBe(0);
    }
    key.budget--; expect((await send(request)).statusCode).toBe(429); expect(calls).toBe(0);
    key.budget++; const bounded = await send(request); expect(bounded.text).toContain('[DONE]'); expect(calls).toBe(1); expect(key.used).toBe(input + 1);
    key.budget += input + 1; const excess = await send(request); expect(excess.text).toContain('insufficient_quota'); expect(excess.text).not.toContain('too much'); expect(key.used).toBe(2 * input + 3);
  });
});

test('Z.ai overload retries debit each dispatched input and stop synchronously before exceeding allowance', async () => {
  await fixture(async ({ key, body, model, send }) => {
    useZai(model);
    timing.wait = async () => {};
    const input = zaiInput(body); key.budget = 2 * input + body.max_tokens; let calls = 0;
    globalThis.fetch = (async (url: any) => { if (!String(url).endsWith('/messages')) throw new Error(`Unexpected outbound request: ${url}`); calls++; return new Response(JSON.stringify({ error: { type: 'overloaded_error', message: 'Overloaded' }, usage: { input_tokens: input, output_tokens: 0 } }), { status: 529, headers: { 'content-type': 'application/json' } }); }) as typeof fetch;
    expect((await send()).statusCode).toBe(429); expect(calls).toBe(2); expect(key.used).toBe(2 * input); expect(() => __captureKeyTestState()).not.toThrow();
  });
});

for (const usage of [undefined, { input_tokens: 0, output_tokens: 0 }, { input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 1 }]) test(`cancellation during overload wait settles only dispatched usage: ${JSON.stringify(usage)}`, async () => {
  await fixture(async ({ key, body, model, send }) => {
    useZai(model);
    const waiting = deferred(); timing.wait = async (_ms, signal) => { waiting.resolve(); await new Promise<void>((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); };
    key.budget = zaiInput(body) + body.max_tokens; let calls = 0;
    globalThis.fetch = Object.assign(async () => { calls++; return Response.json({ error: { type: 'overloaded_error', message: 'Overloaded' }, usage }, { status: 529 }); }, { preconnect: globalThis.fetch.preconnect }) as typeof fetch;
    const sink = new Sink(), pending = send(body, sink); await waiting.promise; sink.emit('close');
    expect((await pending).statusCode).toBe(499); expect(calls).toBe(1); expect(key.used).toBe(usage ? usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + usage.output_tokens : zaiInput(body)); expect(() => __captureKeyTestState()).not.toThrow();
  });
});

test('a connection retry attributes each debit to the route used at dispatch', async () => {
  await fixture(async ({ key, body, model, send, fetch }) => {
    settings.failover = true; settings.retries = 1; key.budget = 2 * estimate(body) + body.max_tokens;
    // Unique names isolate the daily counters from other requests for this fixture model.
    const first = `first-${key.id}`, second = `second-${key.id}`;
    settings.routes[0].name = first; settings.routes.push({ ...settings.routes[0], id: 'second-direct', name: second });
    settings.providers[0].routes!.ids.push('second-direct');
    let calls = 0; fetch(() => { if (++calls === 1) throw new Error('synthetic connection failure'); return reply({ ...delta('', 'stop'), usage: { prompt_tokens: 2, completion_tokens: 3 } }, '[DONE]'); });
    expect((await send()).statusCode).toBe(200); expect(calls).toBe(2); expect(key.used).toBe(estimate(body) + 5);
    const byRoute = db.query('SELECT requests,input,output FROM usage_daily WHERE model=? AND route=?');
    expect(byRoute.get(model.id, first)).toEqual({ requests: 0, input: estimate(body), output: 0 });
    expect(byRoute.get(model.id, second)).toEqual({ requests: 1, input: 2, output: 3 });
  });
});

test('a strict adapter refusal before generation does not debit input or leak its preflight hold', async () => {
  await fixture(async ({ key, model, send }) => {
    settings.providers[0].kind = 'zai'; model.providerId = 'reservation'; settings.zai = { active: '', accounts: [] }; key.budget = 10000;
    expect((await send()).statusCode).toBe(503); expect(key.used).toBe(0); expect(() => __captureKeyTestState()).not.toThrow();
  });
});

test('without token limits existing internal output retry behavior remains unchanged', async () => {
  await fixture(async ({ key, body, model, send, fetch }) => {
    model.output = 0; let calls = 0;
    fetch(() => { calls++; return calls === 1 ? new Response('max_tokens maximum is 8192', { status: 400 }) : reply(delta('ok'), { ...delta('', 'stop'), usage: { prompt_tokens: 2, completion_tokens: 3 } }, '[DONE]'); });
    expect((await send({ ...body, max_tokens: 9000 })).statusCode).toBe(200); expect(calls).toBe(2); expect(key.used).toBe(5);
  });
});
