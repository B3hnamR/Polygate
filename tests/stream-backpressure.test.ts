import { expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { serve } from '../backend/serve';

const adapters: any = await import('../vendor/protocols/adapters.mjs');
const enc = new TextEncoder();
const chunk = (content: string, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason }] })}\n\n`;
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
class Sink extends EventEmitter {
  output = ''; writes = 0; destroyed = false; writableEnded = false;
  onWrite: (text: string) => boolean = () => true;
  writeHead() { return this; }
  write(text: string) { this.output += text; this.writes++; return this.onWrite(text); }
  end() { this.writableEnded = true; this.emit('finish'); return this; }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
}
function source(parts: string[], hang = false) {
  let reads = 0, cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(c) { reads++; if (parts.length) c.enqueue(enc.encode(parts.shift()!)); else if (!hang) c.close(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
  return { response, get reads() { return reads; }, get cancelled() { return cancelled; } };
}
function relay(protocol: string, req: any, sink: Sink, response: Response, options: any = {}) {
  if (protocol === 'chat') return adapters.relayStream(req, sink, response, 'fixture', false, null, null, 1, options);
  if (protocol === 'responses') return adapters.relayChatAsResponsesStream(req, sink, response, 'fixture', false, null, null, options);
  return adapters.relayAnthropicStream(req, sink, adapters.sseChunks(response), 'fixture', 'fixture', false, null, null, options);
}
function clean(sink: Sink) {
  for (const name of ['drain', 'close', 'error', 'finish']) expect(sink.listenerCount(name)).toBe(0);
}

for (const sameChunk of [true, false]) test(`chat: upstream error prevents later success in ${sameChunk ? 'the same chunk' : 'separate chunks'}`, async () => {
  const error = { type: 'provider_error', message: 'provider failed', code: 'fixture_error', param: null };
  const failure = `data:${JSON.stringify({ error })}\n\n`;
  const success = chunk('must not appear', 'stop') + 'data: [DONE]\n\n';
  const upstream = source(sameChunk ? [failure + success] : [failure, success], true), sink = new Sink();
  await relay('chat', {}, sink, upstream.response);
  const events = sink.output.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
  expect(events).toEqual([JSON.stringify({ error }), '[DONE]']);
  expect(sink.output).not.toContain('finish_reason'); expect(sink.output).not.toContain('must not appear');
  expect(upstream.reads).toBe(1); expect(upstream.cancelled).toBe(true); expect(sink.writableEnded).toBe(true); clean(sink);
});

for (const protocol of ['chat', 'responses', 'anthropic']) {
  test(`${protocol}: false write stops reads and writes until drain, then resumes in order`, async () => {
    const upstream = source([chunk('one'), chunk('two'), chunk('', 'stop')]);
    const sink = new Sink(), blocked = deferred(); const pressure: boolean[] = [];
    sink.onWrite = () => { blocked.resolve(); return false; };
    const pending = relay(protocol, {}, sink, upstream.response, { onBackpressure: (value: boolean) => pressure.push(value) });
    await blocked.promise; await tick();
    const reads = upstream.reads, writes = sink.writes;
    await tick(); expect(upstream.reads).toBe(reads); expect(sink.writes).toBe(writes); expect(sink.writableEnded).toBe(false);
    sink.onWrite = () => true; sink.emit('drain'); await pending;
    expect(sink.output.indexOf('one')).toBeLessThan(sink.output.indexOf('two'));
    expect(sink.output).not.toContain('"error"'); expect(pressure).toEqual([true, false]); expect(sink.writableEnded).toBe(true); clean(sink);
  });

  test(`${protocol}: synchronous drain inside write is not missed`, async () => {
    const sink = new Sink(); sink.onWrite = () => { sink.emit('drain'); return false; };
    await relay(protocol, {}, sink, source([chunk('ok'), chunk('', 'stop')]).response);
    expect(sink.writableEnded).toBe(true); expect(sink.output).not.toContain('"error"'); clean(sink);
  });

  test(`${protocol}: synchronous close inside write is not missed`, async () => {
    const sink = new Sink(), upstream = source([chunk('one')], true);
    sink.onWrite = () => { sink.destroy(); return false; };
    await relay(protocol, {}, sink, upstream.response);
    expect(sink.writes).toBe(1); expect(upstream.cancelled).toBe(true); clean(sink);
  });

  test(`${protocol}: blocked final event is awaited and earlier events are not duplicated`, async () => {
    const sink = new Sink(), blocked = deferred();
    const terminal = protocol === 'chat' ? '"finish_reason":"stop"' : protocol === 'responses' ? 'event: response.output_item.done' : 'event: message_delta';
    sink.onWrite = text => { if (text.includes(terminal)) { blocked.resolve(); return false; } return true; };
    // Several upstream events in a single byte chunk must still be written serially.
    const pending = relay(protocol, {}, sink, source([chunk('one') + chunk('two') + chunk('', 'stop')]).response);
    await blocked.promise; await tick(); const writes = sink.writes;
    expect(sink.writableEnded).toBe(false); await tick(); expect(sink.writes).toBe(writes);
    sink.onWrite = () => true; sink.emit('drain'); await pending;
    expect(sink.writableEnded).toBe(true); expect(sink.output.split(terminal)).toHaveLength(2); clean(sink);
  });

  for (const event of ['close', 'error', 'abort']) test(`${protocol}: ${event} while backpressured cancels the source and settles`, async () => {
    const upstream = source([chunk('one')], true), sink = new Sink(), blocked = deferred(), controller = new AbortController();
    sink.onWrite = () => { blocked.resolve(); return false; };
    const pending = relay(protocol, { signal: controller.signal }, sink, upstream.response);
    await blocked.promise; await tick(); const writes = sink.writes;
    if (event === 'abort') controller.abort(Object.assign(new Error('client left'), { status: 499 }));
    else if (event === 'error') sink.emit('error', new Error('socket failed'));
    else sink.destroy();
    await pending; expect(upstream.cancelled).toBe(true); expect(sink.writes).toBe(writes); clean(sink);
  });

  test(`${protocol}: close during a pending upstream read cancels immediately`, async () => {
    const upstream = source([], true), sink = new Sink();
    const pending = relay(protocol, {}, sink, upstream.response);
    await tick(); expect(upstream.reads).toBe(1); sink.destroy(); await pending;
    expect(upstream.cancelled).toBe(true); expect(sink.output).not.toContain('"error"'); clean(sink);
  });

  test(`${protocol}: upstream read wall cancels a silent reader without waiting for another chunk`, async () => {
    const timers: Array<{ callback: () => void; cleared: boolean }> = [];
    const set = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { const t = { callback, cleared: false }; timers.push(t); return t; }) as any);
    const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((t: any) => { if (t) t.cleared = true; }) as any);
    try {
      const upstream = source([], true), sink = new Sink();
      const pending = relay(protocol, {}, sink, upstream.response);
      await tick(); expect(upstream.reads).toBe(1); timers.find(t => !t.cleared)!.callback(); await pending;
      expect(upstream.cancelled).toBe(true); expect(sink.output).toContain('upstream stalled past the relay wall');
      expect(sink.output).not.toContain('response.completed'); expect(sink.output).not.toContain('message_stop'); clean(sink);
    } finally { set.mockRestore(); clear.mockRestore(); }
  });

  for (const status of [429, 504]) test(`${protocol}: abort ${status} is emitted in-band even when already aborted`, async () => {
    const controller = new AbortController(), sink = new Sink();
    controller.abort(Object.assign(new Error('specific failure'), { status, type: status === 429 ? 'insufficient_quota' : 'timeout' }));
    await relay(protocol, { signal: controller.signal }, sink, source([], true).response);
    expect(sink.output).toContain('specific failure'); expect(sink.output).toContain(status === 429 ? 'insufficient_quota' : 'timeout');
    expect(sink.output).not.toContain('response.completed'); expect(sink.output).not.toContain('message_stop'); clean(sink);
  });

  test(`${protocol}: quota abort during blocked normal output still flushes an error`, async () => {
    const controller = new AbortController(), sink = new Sink(), blocked = deferred(), upstream = source([chunk('one')], true);
    sink.onWrite = () => { blocked.resolve(); return false; };
    const pending = relay(protocol, { signal: controller.signal }, sink, upstream.response);
    await blocked.promise; await tick(); sink.onWrite = () => true;
    controller.abort(Object.assign(new Error('quota exceeded'), { status: 429, type: 'insufficient_quota' }));
    await pending; expect(sink.output).toContain('insufficient_quota'); expect(upstream.cancelled).toBe(true);
    expect(sink.output).not.toContain('response.completed'); expect(sink.output).not.toContain('message_stop'); clean(sink);
  });

  test(`${protocol}: terminal error drain has a bounded deadline independent of request abort`, async () => {
    const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
    const set = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number) => { const t = { callback, ms, cleared: false }; timers.push(t); return t; }) as any);
    const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((t: any) => { if (t) t.cleared = true; }) as any);
    try {
      const controller = new AbortController(), sink = new Sink(); sink.onWrite = () => false;
      controller.abort(Object.assign(new Error('quota exceeded'), { status: 429, type: 'insufficient_quota' }));
      const pending = relay(protocol, { signal: controller.signal }, sink, source([], true).response);
      await tick(); const terminal = timers.find(t => t.ms === 1000 && !t.cleared)!;
      expect(terminal).toBeDefined(); terminal.callback(); await pending;
      expect(sink.writes).toBe(1); expect(sink.destroyed).toBe(true); expect(timers.every(t => t.cleared)).toBe(true); clean(sink);
    } finally { set.mockRestore(); clear.mockRestore(); }
  });
}

// Capture the actual Bun fetch adapter without binding a socket.
async function shim(handler: (req: any, res: any) => unknown, run: (response: Response, abort: AbortController) => Promise<void>) {
  let options: any;
  const stub = spyOn(Bun, 'serve').mockImplementation(((value: any) => { options = value; return { stop() {} }; }) as any);
  try {
    serve(handler, 0); const controller = new AbortController();
    const response = await options.fetch(new Request('http://fixture.invalid/', { signal: controller.signal }), { requestIP: () => ({ address: '127.0.0.1' }) });
    await run(response, controller);
  } finally { stub.mockRestore(); }
}
test('serve emits drain only after pressure clears, and body cancellation closes once', async () => {
  let res: any, drains = 0, closes = 0;
  await shim((_req, value) => {
    res = value; res.on('drain', () => drains++); res.on('close', () => closes++);
    expect(res.write(new Uint8Array(65536))).toBe(false); expect(res.writableNeedDrain).toBe(true);
  }, async response => {
    await tick(); expect(drains).toBe(0);
    const reader = response.body!.getReader(); await reader.read(); await tick();
    expect(drains).toBe(1); expect(res.writableNeedDrain).toBe(false);
    await reader.cancel(); expect(closes).toBe(1); expect(res.destroyed).toBe(true);
    expect(res.write('late')).toBe(false); expect(drains).toBe(1);
  });
});
test('serve handler failure after commitment errors the body and closes the response', async () => {
  let res: any, closes = 0, errors = 0;
  await shim((_req, value) => { res = value; res.on('close', () => closes++); res.on('error', () => errors++); res.write('partial'); throw new Error('handler failed'); }, async response => {
    await tick(); await expect(response.text()).rejects.toThrow('handler failed');
    expect(closes).toBe(1); expect(errors).toBe(1); expect(res.destroyed).toBe(true);
  });
});
test('serve request abort wakes a blocked response; normal end remains successful', async () => {
  let res: any, closes = 0;
  await shim((_req, value) => { res = value; res.on('close', () => closes++); res.write(new Uint8Array(65536)); }, async (response, controller) => {
    controller.abort(); expect((await response.arrayBuffer()).byteLength).toBe(65536);
    expect(closes).toBe(1); expect(res.destroyed).toBe(true); expect(res.writableNeedDrain).toBe(false);
  });
  await shim((_req, value) => { res = value; res.statusCode = 201; res.end('ok'); }, async response => {
    expect(response.status).toBe(201); expect(await response.text()).toBe('ok'); expect(res.writableEnded).toBe(true);
  });
});

for (const protocol of ['chat', 'responses', 'anthropic']) test(`${protocol}: actual serve shim drains a large frame and completes the relay`, async () => {
  const text = 'x'.repeat(70000), upstream = source([chunk(text), chunk('', 'stop')]);
  let pending!: Promise<void>; const pressure: boolean[] = [], blocked = deferred();
  await shim((req, res) => {
    pending = relay(protocol, req, res, upstream.response, { onBackpressure: (waiting: boolean) => { pressure.push(waiting); if (waiting) blocked.resolve(); } });
    return pending;
  }, async response => {
    await blocked.promise; expect(pressure).toEqual([true]); const reads = upstream.reads;
    await tick(); expect(upstream.reads).toBe(reads);
    const result = await response.text(); await pending;
    expect(result).toContain(text); expect(result).not.toContain('"error"');
    expect(pressure.length % 2).toBe(0); expect(pressure.every((value, i) => value === (i % 2 === 0))).toBe(true);
  });
});
