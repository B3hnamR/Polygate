import { expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const bridge = require('../vendor/bridge/server.js');
const proxy = require('../vendor/bridge/proxy.js');
const model = 'bridge-contract-fixture';
const tool = (name: string) => ({ type: 'function', function: { name, description: 'A client-owned fixture tool', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } } });
const sse = (data: any, space = '') => `data:${space}${typeof data === 'string' ? data : JSON.stringify(data)}\r\n\r\n`;
const chunk = (delta: any, finish: string | null = null, index = 0) => ({ id: 'completion-fixture', choices: [{ index, delta, finish_reason: finish }] });
const call = (name: string, args = '{"value":"fixture"}', index = 0) => ({ index, id: `call-fixture-${index}`, type: 'function', function: { name, arguments: args } });
const chatCall = (name: string) => sse(chunk({ tool_calls: [call(name)] })) + sse(chunk({}, 'tool_calls')) + sse('[DONE]');
const responseCall = (name: string) => sse({ type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'item-fixture', call_id: 'call-fixture-0', name } }) +
  sse({ type: 'response.function_call_arguments.delta', item_id: 'item-fixture', delta: '{"value":"fixture"}' }) +
  sse({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 5 } } });
const events = (text: string) => text.split('\n').filter(line => line.startsWith('data:') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(5)));
const reconstructedCalls = (text: string) => {
  const calls = new Map<number, { id: string; name: string; arguments: string; idParts: number }>();
  for (const event of events(text)) for (const choice of event.choices || []) for (const delta of choice.delta?.tool_calls || []) {
    const call = calls.get(delta.index) || { id: '', name: '', arguments: '', idParts: 0 };
    if (delta.id) { call.id += delta.id; call.idParts++; }
    call.name += delta.function?.name || '';
    call.arguments += delta.function?.arguments || '';
    calls.set(delta.index, call);
  }
  return [...calls.values()];
};

// Exercise the real HTTP handler with in-memory request/response streams. No
// listener or model is contacted; every upstream call is intercepted below.
async function request(lane: 'chat' | 'responses', stream: boolean, wire: string | string[], extra: any = {}, options: { gateRetry?: boolean; fullCollision?: boolean; holdOpen?: boolean; upstreamError?: Error } = {}) {
  const payloads: any[] = [];
  let cancelled = false;
  const ensure = spyOn(bridge.identity, 'ensureFresh').mockImplementation(() => ({}));
  const verdict = spyOn(bridge.identity, 'getCatalogVerdict').mockReturnValue('free');
  const gate = spyOn(bridge.identity, 'onGateRejection').mockResolvedValue({ retry: true, reason: 'fixture' });
  const definitions = bridge.identity.DEFAULT_TOOLS;
  const tools = spyOn(bridge.identity, 'getTools').mockReturnValue(definitions);
  const list = spyOn(bridge.identity, 'getToolList').mockImplementation((flat: boolean, scope: string) => {
    const names = ['read', 'shell', ...(options.fullCollision && scope === 'full' ? ['read_client'] : [])];
    return names.map(name => {
      const def = definitions[name] || definitions.read;
      return flat ? { type: 'function', name, ...def } : { type: 'function', function: { name, ...def } };
    });
  });
  const upstream = spyOn(proxy, 'netFetch').mockImplementation(async (_url: any, init: any) => {
    payloads.push(JSON.parse(init.body));
    if (options.upstreamError) throw options.upstreamError;
    if (options.gateRetry && payloads.length === 1) return Response.json({ error: { type: 'FreeTierError', message: 'Fixture gate rejection' } }, { status: 403 });
    const pieces = typeof wire === 'string' ? [wire] : wire;
    let i = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (i < pieces.length) controller.enqueue(new TextEncoder().encode(pieces[i++]));
        else if (!options.holdOpen) controller.close();
      },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  bridge.markProtocolSupport(model, lane === 'responses');
  try {
    let text = '';
    const res: any = new EventEmitter();
    res.statusCode = 200;
    res.headersSent = false;
    res.writableEnded = false;
    res.setHeader = () => {};
    res.writeHead = (status: number) => { res.statusCode = status; res.headersSent = true; };
    res.write = (value: any) => { res.headersSent = true; text += String(value); return true; };
    const ended = new Promise<void>(resolve => {
      res.end = (value?: any) => { if (value !== undefined) text += String(value); res.writableEnded = true; resolve(); };
    });
    const req: any = Readable.from([Buffer.from(JSON.stringify({
      model, messages: [{ role: 'system', content: '<env>Working directory: /fixture</env>' }, { role: 'user', content: 'fixture' }], stream, stream_options: { include_usage: true }, ...extra,
    }))]);
    req.method = 'POST';
    req.url = '/v1/chat/completions';
    req.headers = { host: '127.0.0.1', 'content-type': 'application/json', 'x-opencode-project': 'fixture-project' };
    bridge.handleRequest(req, res);
    await ended;
    return { status: res.statusCode, text, payloads, cancelled };
  } finally {
    bridge.markProtocolSupport(model, false);
    ensure.mockRestore(); verdict.mockRestore(); gate.mockRestore(); tools.mockRestore(); list.mockRestore(); upstream.mockRestore();
  }
}

for (const lane of ['chat', 'responses'] as const) for (const stream of [false, true]) {
  const wireCall = lane === 'chat' ? chatCall : responseCall;
  // Only a client that actually constrained tools has a strict contract. An auto request with tools must let the client handle a name the
  // model invented: OpenCode aliases bash to shell and returns a recoverable tool error for other unknown names; aborting the whole stream
  // here is what produced upstream_tool_error 502 for 0.6.6 clients.
  for (const contract of ['absent', 'none', 'object-none'] as const) {
    test(`${lane} ${stream ? 'stream' : 'collected'} rejects ${contract} tool calls without exposing arguments`, async () => {
      const extra = contract === 'absent' ? {} : { tools: [tool('read')], ...(contract === 'none' ? { tool_choice: 'none' } : { tool_choice: { type: 'none' } }) };
      const name = contract === 'none' || contract === 'object-none' ? 'read_client' : 'read';
      const r = await request(lane, stream, wireCall(name), extra);
      expect(r.status).toBe(502);
      expect(JSON.parse(r.text).error.type).toBe('upstream_tool_error');
      expect(r.text).not.toContain('call-fixture');
      expect(r.text).not.toContain('arguments');
      expect(r.payloads).toHaveLength(1);
      expect(r.payloads[0].tools.some((t: any) => (t.name || t.function?.name) === 'read')).toBe(true);
    });
  }

  test(`${lane} ${stream ? 'stream' : 'collected'} restores collision-safe aliases and preserves call IDs`, async () => {
    const r = await request(lane, stream, wireCall('read_client2'), { tools: [tool('read'), tool('read_client')] });
    expect(r.status).toBe(200);
    const calls = stream ? events(r.text).flatMap(e => e.choices?.flatMap((c: any) => c.delta?.tool_calls || []) || []) : JSON.parse(r.text).choices[0].message.tool_calls;
    expect(calls.find((c: any) => c.id)?.id).toBe('call-fixture-0');
    expect(calls.find((c: any) => c.function?.name)?.function.name).toBe('read');
    expect(calls.map((c: any) => c.function?.arguments || '').join('')).toBe('{"value":"fixture"}');
    expect(r.text).not.toContain('read_client2');
  });

  test(`${lane} ${stream ? 'stream' : 'collected'} accepts exact canonical client tools`, async () => {
    const r = await request(lane, stream, wireCall('read'), { tools: [{ type: 'function', function: { name: 'read', ...bridge.identity.DEFAULT_TOOLS.read } }] });
    expect(r.status).toBe(200);
    expect(r.text).toContain('call-fixture-0');
    expect(r.text).not.toContain('upstream_tool_error');
  });

  test(`${lane} ${stream ? 'stream' : 'collected'} does not convert no-event EOF to success`, async () => {
    for (const wire of ['', ': keep-alive\r\n\r\n']) {
      const r = await request(lane, stream, wire);
      expect(r.status).toBe(502);
      expect(JSON.parse(r.text).error.message).toContain('terminal event');
      expect(r.text).not.toContain('[DONE]');
    }
  });

  test(`${lane} ${stream ? 'stream' : 'collected'} accepts data fields with optional whitespace and chunk splits`, async () => {
    for (const space of ['', ' ', '\t']) {
      const wire = lane === 'chat' ? sse(chunk({ content: 'answer' }), space) + sse(chunk({}, 'stop'), space) + sse('[DONE]', space) :
        sse({ type: 'response.output_text.delta', delta: 'answer' }, space) + sse({ type: 'response.completed', response: { status: 'completed' } }, space);
      const r = await request(lane, stream, [wire.slice(0, 8), wire.slice(8, -1), wire.slice(-1)]);
      expect(r.status).toBe(200);
      expect(r.text).toContain('answer');
      expect(r.text).not.toContain('error');
    }
  });

  test(`${lane} ${stream ? 'stream' : 'collected'} refreshes eligibility when full-shape retry changes aliases`, async () => {
    const r = await request(lane, stream, wireCall('read_client2'), { tools: [tool('read')] }, { gateRetry: true, fullCollision: true });
    expect(r.status).toBe(200);
    expect(r.payloads).toHaveLength(2);
    expect(r.payloads[1].tools.filter((t: any) => (t.name || t.function?.name) === 'read_client2')).toHaveLength(1);
    expect(r.text).toContain('call-fixture-0');
  });
}

test('a tool name the client would handle itself is forwarded, not fatal', async () => {
  const tools = [
    { type: 'function', function: { name: 'read', ...bridge.identity.DEFAULT_TOOLS.read } },
    { type: 'function', function: { name: 'shell', ...bridge.identity.DEFAULT_TOOLS.shell } },
  ];
  for (const lane of ['chat', 'responses'] as const) for (const stream of [false, true]) {
    const wire = lane === 'chat' ? chatCall('bash') : responseCall('bash');
    const r = await request(lane, stream, wire, { tools });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('upstream_tool_error');
    const calls = stream ? events(r.text).flatMap(e => e.choices?.flatMap((c: any) => c.delta?.tool_calls || []) || []) : JSON.parse(r.text).choices[0].message.tool_calls;
    expect(calls.map((c: any) => c.function?.name)).toContain('bash');
  }
});

test('a route that never answered keeps its status and plain message through the bridge', async () => {
  const failure: any = new Error('Could not reach api.opencode.ai through the relay "Vercel fra1": Connection reset: the network or the relay host closed it. Another relay or exit may work.');
  failure.status = 502; failure.type = 'route_unreachable';
  const r = await request('chat', false, '', {}, { upstreamError: failure });
  expect(r.status).toBe(502);
  expect(JSON.parse(r.text).error).toMatchObject({ type: 'route_unreachable', code: 502 });
  expect(r.text).toContain('Connection reset');
  expect(r.text).not.toContain('Internal server error');
});

test('chat buffers split names, preserves parallel call IDs and does not alias twice', async () => {
  const wire = sse(chunk({ tool_calls: [call('read_', '{"value":', 0), call('read_client', '{"value":"other"}', 1)] })) +
    sse(chunk({ tool_calls: [{ index: 0, function: { name: 'client2', arguments: '"fixture"}' } }] })) + sse(chunk({}, 'tool_calls')) + sse('[DONE]');
  for (const stream of [false, true]) {
    const r = await request('chat', stream, wire, { tools: [tool('read'), tool('read_client')] });
    expect(r.status).toBe(200);
    const calls = stream ? events(r.text).flatMap(e => e.choices?.flatMap((c: any) => c.delta?.tool_calls || []) || []) : JSON.parse(r.text).choices[0].message.tool_calls;
    expect(calls.map((c: any) => [c.id, c.function.name, c.function.arguments])).toEqual([
      ['call-fixture-0', 'read', '{"value":"fixture"}'], ['call-fixture-1', 'read_client', '{"value":"other"}'],
    ]);
  }
});

test('chat accepts null function names on continuation fragments', async () => {
  const wire = sse(chunk({ tool_calls: [call('read', '{"value":', 0)] })) +
    sse(chunk({ tool_calls: [{ index: 0, function: { name: null, arguments: '"fixture"}' } }] })) +
    sse(chunk({}, 'tool_calls')) + sse('[DONE]');
  for (const stream of [false, true]) {
    const r = await request('chat', stream, wire, { tools: [{ type: 'function', function: { name: 'read', ...bridge.identity.DEFAULT_TOOLS.read } }] });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('upstream_tool_error');
    const calls = stream ? reconstructedCalls(r.text) : JSON.parse(r.text).choices[0].message.tool_calls;
    expect(calls[0].function?.name || calls[0].name).toBe('read');
    expect(calls[0].function?.arguments || calls[0].arguments).toBe('{"value":"fixture"}');
  }
});

test('chat forwards a completed name that extends an offered prefix', async () => {
  const wire = sse(chunk({ tool_calls: [call('lookup', '{"value":"private"}')] })) +
    sse(chunk({ tool_calls: [{ index: 0, function: { name: '_unoffered' } }] })) + sse(chunk({}, 'tool_calls'));
  for (const stream of [false, true]) {
    const r = await request('chat', stream, wire, { tools: [tool('lookup')] });
    expect(r.status).toBe(200);
    const calls = stream ? events(r.text).flatMap(e => e.choices?.flatMap((c: any) => c.delta?.tool_calls || []) || []) : JSON.parse(r.text).choices[0].message.tool_calls;
    expect(calls.find((c: any) => c.function?.name)?.function.name).toBe('lookup_unoffered');
    expect(r.text).toContain('private');
  }
});

test('tool failure after text is an explicit SSE error, never an executable call or successful stop', async () => {
  for (const lane of ['chat', 'responses'] as const) {
    const wire = lane === 'chat' ? sse(chunk({ content: 'partial' })) + chatCall('shell') : sse({ type: 'response.output_text.delta', delta: 'partial' }) + responseCall('shell');
    const r = await request(lane, true, wire);
    expect(r.status).toBe(200);
    expect(events(r.text).find(e => e.error)?.error.type).toBe('upstream_tool_error');
    expect(r.text).toContain('partial');
    expect(r.text).not.toContain('call-fixture');
    expect(r.text).not.toContain('"finish_reason":"stop"');
    expect(r.payloads).toHaveLength(1);
  }
});

test('chat genuine DONE can finish a held valid call, but EOF cannot', async () => {
  for (const stream of [false, true]) {
    const wire = sse(chunk({ tool_calls: [call('lookup')] }));
    const ok = await request('chat', stream, wire + sse('[DONE]'), { tools: [tool('lookup')] });
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('call-fixture-0');
    const cut = await request('chat', stream, wire, { tools: [tool('lookup')] });
    expect(cut.status).toBe(502);
    expect(cut.text).not.toContain('call-fixture');
  }
});

test('Responses rejects function calls with no matching announcement event', async () => {
  for (const stream of [false, true]) for (const ev of [
    { type: 'response.function_call_arguments.delta', item_id: 'unknown', delta: '{"command":"private"}' },
    { type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', name: 'shell', arguments: '{"command":"private"}' }] } },
  ]) {
    const r = await request('responses', stream, sse(ev), { tools: [tool('lookup')] });
    expect(r.status).toBe(502);
    expect(JSON.parse(r.text).error.type).toBe('upstream_tool_error');
    expect(r.text).not.toContain('private');
  }
});

test('chat checks every choice and refuses legacy function calls', async () => {
  for (const stream of [false, true]) for (const wire of [
    sse({ choices: [{ index: 0, delta: {}, finish_reason: null }, { index: 1, delta: { tool_calls: [call('shell')] }, finish_reason: 'tool_calls' }] }),
    sse(chunk({ function_call: { name: 'shell', arguments: '{"command":"private"}' } }, 'function_call')),
  ]) {
    const r = await request('chat', stream, wire, {});
    expect(r.status).toBe(502);
    expect(r.text).not.toContain('private');
    expect(r.text).not.toContain('call-fixture');
  }
});

test('forced tool choices reject a different offered tool in either upstream lane', async () => {
  for (const lane of ['chat', 'responses'] as const) for (const stream of [false, true]) {
    const r = await request(lane, stream, lane === 'chat' ? chatCall('other') : responseCall('other'), {
      tools: [tool('lookup'), tool('other')], tool_choice: { type: 'function', function: { name: 'lookup' } },
    });
    expect(r.status).toBe(502);
    expect(JSON.parse(r.text).error.type).toBe('upstream_tool_error');
  }
});

test('partial text EOF stays an error in streaming and collected branches', async () => {
  for (const lane of ['chat', 'responses'] as const) for (const stream of [false, true]) {
    const wire = lane === 'chat' ? sse(chunk({ content: 'partial' })) : sse({ type: 'response.output_text.delta', delta: 'partial' });
    const r = await request(lane, stream, wire);
    expect(r.status).toBe(stream ? 200 : 502);
    const error = stream ? events(r.text).find(e => e.error)?.error : JSON.parse(r.text).error;
    expect(error.message).toContain('terminal event');
    expect(r.text).not.toContain('"finish_reason":"stop"');
  }
});

test('no-tools and none eligibility remain empty after a full-shape retry', async () => {
  for (const lane of ['chat', 'responses'] as const) for (const extra of [{}, { tools: [tool('read')], tool_choice: 'none' }]) {
    const r = await request(lane, true, lane === 'chat' ? chatCall('read_client2') : responseCall('read_client2'), extra, { gateRetry: true, fullCollision: true });
    expect(r.status).toBe(502);
    expect(JSON.parse(r.text).error.type).toBe('upstream_tool_error');
    expect(r.payloads).toHaveLength(2);
  }
});

test('Responses sends the forced tool under its wire name and restores the client name', async () => {
  const extra = { tools: [tool('read'), tool('lookup')], tool_choice: { type: 'function', function: { name: 'read' } } };
  for (const stream of [false, true]) {
    const r = await request('responses', stream, responseCall('read_client'), extra);
    expect(r.payloads[0].tool_choice).toEqual({ type: 'function', name: 'read_client' });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('read_client');
    const name = stream ? reconstructedCalls(r.text)[0].name : JSON.parse(r.text).choices[0].message.tool_calls[0].function.name;
    expect(name).toBe('read');
  }
});

test('Responses sends none or required rather than silently requesting automatic selection', async () => {
  for (const choice of ['none', { type: 'none' }, 'required']) {
    const required = choice === 'required';
    const wire = required ? responseCall('lookup') : sse({ type: 'response.completed', response: { status: 'completed' } });
    const r = await request('responses', false, wire, { tools: [tool('lookup')], tool_choice: choice });
    expect(r.payloads[0].tool_choice).toBe(required ? 'required' : 'none');
    expect(r.status).toBe(200);
  }
});

test('Chat rejects repeated executable calls and fresh data after a terminal event', async () => {
  const finishedCall = sse(chunk({ tool_calls: [call('lookup', '{}')] }, 'tool_calls'));
  for (const stream of [false, true]) for (const wire of [
    finishedCall + finishedCall,
    finishedCall + sse('[DONE]') + sse(chunk({ tool_calls: [call('lookup', '{}', 1)] })),
    sse(chunk({ content: 'answer' }, 'stop')) + sse(chunk({ content: 'unexpected' })),
    sse('[DONE]') + sse(chunk({ content: 'unexpected' })),
  ]) {
    const r = await request('chat', stream, wire, { tools: [tool('lookup')] }, { holdOpen: true });
    expect(r.cancelled).toBe(true);
    if (stream) {
      const out = r.status === 200 ? events(r.text) : [JSON.parse(r.text)];
      expect(out.find(e => e.error)?.error.type).toBe('upstream_stream_error');
      expect(out.flatMap(e => e.choices?.flatMap((c: any) => c.delta?.tool_calls || []) || []).filter((c: any) => c.function?.name).length).toBeLessThanOrEqual(1);
      expect(r.text).not.toContain('unexpected');
    } else {
      expect(r.status).toBe(502);
      expect(JSON.parse(r.text).error.type).toBe('upstream_stream_error');
      expect(r.text).not.toContain('{}{}');
    }
  }
});

test('a finished Chat choice can have an empty trailer without losing the answer or usage', async () => {
  const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
  for (const delta of [{}, { content: null }, { content: '' }]) for (const stream of [false, true]) {
    const wire = sse(chunk({ content: 'OK' }, 'stop')) + sse({ ...chunk(delta), usage }) + sse('[DONE]');
    const r = await request('chat', stream, wire);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('upstream_stream_error');
    if (stream) {
      const frames = events(r.text);
      expect(frames.flatMap(f => f.choices || []).map(c => c.delta?.content || '').join('')).toBe('OK');
      expect(frames.find(f => f.usage)?.usage.total_tokens).toBe(4);
    } else {
      const answer = JSON.parse(r.text);
      expect(answer.choices[0].message.content).toBe('OK');
      expect(answer.usage.total_tokens).toBe(4);
    }
  }
});

test('duplicate bare Chat terminals are idempotent', async () => {
  const wire = sse(chunk({ tool_calls: [call('lookup', '{}')] }, 'tool_calls')) +
    sse(chunk({}, 'tool_calls')) + sse('[DONE]') + sse('[DONE]') + sse(chunk({}, 'tool_calls'));
  for (const stream of [false, true]) {
    const r = await request('chat', stream, wire, { tools: [tool('lookup')] });
    expect(r.status).toBe(200);
    const calls = stream ? events(r.text).flatMap(e => e.choices?.flatMap((c: any) => c.delta?.tool_calls || []) || []) : JSON.parse(r.text).choices[0].message.tool_calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].function.arguments).toBe('{}');
  }
});

test('malformed SSE data cannot be repaired by a later valid terminal', async () => {
  for (const lane of ['chat', 'responses'] as const) for (const stream of [false, true]) for (const prefix of ['', lane === 'chat' ? sse(chunk({ content: 'partial' })) : sse({ type: 'response.output_text.delta', delta: 'partial' })]) {
    const terminal = lane === 'chat' ? sse(chunk({}, 'stop')) + sse('[DONE]') : sse({ type: 'response.completed', response: { status: 'completed' } });
    for (const malformed of ['{broken', 'null', '[]']) {
      const r = await request(lane, stream, prefix + sse(malformed) + terminal, {}, { holdOpen: true });
      expect(r.cancelled).toBe(true);
      const error = r.status === 200 ? events(r.text).find(e => e.error)?.error : JSON.parse(r.text).error;
      expect(error.type).toBe('upstream_stream_error');
      expect(error.message).toContain('malformed SSE data');
      expect(r.text).not.toContain('"finish_reason":"stop"');
    }
  }
});

const responseAdded = (index: number, id: string, name = 'lookup', callId?: string) => ({ type: 'response.output_item.added', output_index: index, item: { type: 'function_call', id, name, ...(callId ? { call_id: callId } : {}) } });

test('Responses binds every selector and rejects final identity changes', async () => {
  const start = sse(responseAdded(0, 'item-A', 'lookup', 'call-A')) + sse(responseAdded(1, 'item-B', 'other', 'call-B'));
  for (const stream of [false, true]) for (const invalid of [
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'item-B', delta: 'private' },
    { type: 'response.function_call_arguments.delta', output_index: 0, call_id: 'call-B', delta: 'private' },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'changed', delta: 'private' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'item-A', call_id: 'call-A', name: 'other' } },
    { type: 'response.completed', response: { output: [{ type: 'function_call', id: 'changed', call_id: 'call-A', name: 'lookup' }] } },
    { type: 'response.completed', response: { output: [{ type: 'function_call', id: 'item-A', call_id: 'changed', name: 'lookup' }] } },
  ]) {
    const r = await request('responses', stream, start + sse(invalid), { tools: [tool('lookup'), tool('other')] }, { holdOpen: true });
    expect(r.cancelled).toBe(true);
    const error = stream ? events(r.text).find(e => e.error)?.error : JSON.parse(r.text).error;
    expect(error.type).toBe('upstream_tool_error');
    expect(r.text).not.toContain('private');
  }
});

test('Responses allows matching late call IDs and keeps selector namespaces separate', async () => {
  const wire = sse(responseAdded(0, '1')) + sse(responseAdded(1, '0', 'other', 'call-other')) +
    sse({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: '1', call_id: 'call-late', delta: '{"value":"first"}' }) +
    sse({ type: 'response.function_call_arguments.delta', item_id: '0', call_id: 'call-other', delta: '{"value":"second"}' }) +
    sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: '1', call_id: 'call-late', name: 'lookup' } }) +
    sse({ type: 'response.completed', response: { status: 'completed', output: [
      { type: 'function_call', id: '1', call_id: 'call-late', name: 'lookup' }, { type: 'function_call', id: '0', call_id: 'call-other', name: 'other' },
    ] } });
  for (const stream of [false, true]) {
    const r = await request('responses', stream, wire, { tools: [tool('lookup'), tool('other')] });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('error');
    if (stream) {
      expect(reconstructedCalls(r.text)).toEqual([
        { id: 'call-late', name: 'lookup', arguments: '{"value":"first"}', idParts: 1 },
        { id: 'call-other', name: 'other', arguments: '{"value":"second"}', idParts: 1 },
      ]);
    } else {
      expect(JSON.parse(r.text).choices[0].message.tool_calls.map((c: any) => c.id)).toEqual(['call-late', 'call-other']);
    }
  }
});

test('Chat byte accounting is cumulative across choices and fragments', () => {
  // Pure guard seam allows a tiny budget without a production environment knob.
  const guard = bridge.__chatToolGuard(new Map([['lookup', 'lookup']]), 32, 128);
  guard.feed(chunk({ tool_calls: [{ index: 0, function: { name: 'lookup', arguments: 'x'.repeat(10) } }] }));
  guard.feed(chunk({}, 'tool_calls'));
  guard.feed(chunk({ tool_calls: [{ index: 0, function: { name: 'lookup', arguments: 'x'.repeat(10) } }] }, null, 1));
  expect(() => guard.feed(chunk({ tool_calls: [{ index: 0, function: { arguments: 'x' } }] }, null, 1))).toThrow('byte limit');
});

test('Chat production call-count limit cancels upstream without releasing buffered calls', async () => {
  const wire = Array.from({ length: 129 }, (_, i) => sse(chunk({ tool_calls: [call('lookup', '{}', i)] })));
  for (const stream of [false, true]) {
    const r = await request('chat', stream, wire, { tools: [tool('lookup')] }, { holdOpen: true });
    expect(r.cancelled).toBe(true);
    expect(r.status).toBe(502);
    expect(JSON.parse(r.text).error.message).toContain('count limit');
    expect(r.text).not.toContain('call-fixture');
  }
});

test('Responses emits exactly one ID when call_id arrives at done, completed, or never', async () => {
  for (const arrival of ['done', 'completed', 'never']) {
    const item = { type: 'function_call', id: '1', name: 'lookup', ...(arrival === 'never' ? {} : { call_id: 'call-late' }) };
    const wire = sse(responseAdded(0, '1')) +
      sse({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: '1', delta: '{"value":' }) +
      sse({ type: 'response.function_call_arguments.delta', item_id: '1', delta: '"fixture"}' }) +
      (arrival === 'done' ? sse({ type: 'response.output_item.done', output_index: 0, item }) : '') +
      sse({ type: 'response.completed', response: { status: 'completed', output: [item] } });
    const r = await request('responses', true, wire, { tools: [tool('lookup')] });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('error');
    expect(reconstructedCalls(r.text)).toEqual([{ id: arrival === 'never' ? '1' : 'call-late', name: 'lookup', arguments: '{"value":"fixture"}', idParts: 1 }]);
  }
});

// Recorded from OpenCode Free on 2026-11-21 (Direct): DeepSeek sends "tool_calls": null on every chunk of a plain answer, and Nemotron repeats
// its finished choice as {"role":"assistant","content":""} beside the final usage. Both broke 0.6.6 (502 "tool call not permitted", and
// "choice data after its terminal event"); 0.6.5 passed them on.
test('OpenCode Free plain answers pass: null tool_calls on every chunk, and the finished choice repeated with its role beside the usage', () => {
  const deepseek = bridge.__chatToolGuard(new Map());
  const ds = (delta: any, finish: string | null = null) => ({ id: 'c', object: 'chat.completion.chunk', model: 'deepseek-v4.1-flash-free', choices: [{ index: 0, finish_reason: finish, logprobs: null, delta }], usage: null });
  expect(deepseek.feed(ds({ role: 'assistant', content: '', reasoning_content: null, tool_calls: null }))).not.toBeNull();
  const answer = deepseek.feed(ds({ role: null, content: 'OK', reasoning_content: null, tool_calls: null }, 'stop'));
  expect(answer.choices[0].delta.content).toBe('OK'); expect('tool_calls' in answer.choices[0].delta).toBe(false);
  expect(deepseek.feed({ id: 'c', choices: [], usage: { prompt_tokens: 905, completion_tokens: 3 } }).usage.completion_tokens).toBe(3);

  const nemotron = bridge.__chatToolGuard(new Map());
  const nm = (delta: any, finish: string | null = null, usage?: any) => ({ id: 'g', choices: [{ index: 0, finish_reason: finish, delta }], ...(usage ? { usage } : {}) });
  nemotron.feed(nm({ role: 'assistant', content: 'OK' }));
  nemotron.feed(nm({ role: 'assistant', content: '', reasoning: null }, 'stop'));
  const last = nemotron.feed(nm({ role: 'assistant', content: '' }, 'stop', { prompt_tokens: 982, completion_tokens: 21 }));
  expect(last.choices).toEqual([]); expect(last.usage.completion_tokens).toBe(21); // the empty repeat is dropped, the usage kept
  // Something new after the finish is still refused.
  const strict = bridge.__chatToolGuard(new Map());
  strict.feed(nm({ content: 'OK' }, 'stop'));
  expect(() => strict.feed(nm({ role: 'assistant', content: 'more text' }))).toThrow('terminal event');
  // A real tool call is still checked against the offered tools; an empty list is no call.
  const tools = bridge.__chatToolGuard(new Map([['read_file', 'read_file']]));
  expect(tools.feed(nm({ tool_calls: [] })).choices.length).toBe(1);
  expect(() => bridge.__chatToolGuard(new Map()).feed(nm({ tool_calls: [{ index: 0, function: { name: 'rm_rf', arguments: '{}' } }] }))).toThrow();
});
