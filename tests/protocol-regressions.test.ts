import { expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';

const adapters: any = await import('../vendor/protocols/adapters.mjs');
const bridge = require('../vendor/bridge/server.js');
const proxy = require('../vendor/bridge/proxy.js');
const enc = new TextEncoder();
const data = (value: any) => `data: ${JSON.stringify(value)}\n\n`;
const chatChunk = (finish: string | null, delta: any = {}) => data({
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const sse = (text: string) => new Response(text, { headers: { 'content-type': 'text/event-stream' } });

// In-memory HTTP doubles: these tests never bind a socket or contact a provider.
function responseSink() {
  const res: any = new EventEmitter();
  res.statusCode = 200;
  res.headersSent = false;
  res.writableEnded = false;
  res.output = '';
  res.setHeader = () => {};
  res.writeHead = (status: number) => { res.statusCode = status; res.headersSent = true; return res; };
  res.write = (text: string) => { res.output += text; return true; };
  res.end = (text = '') => { res.output += text; res.writableEnded = true; res.emit('finish'); };
  return res;
}

test('Responses assistant output_text history survives alongside images and tool turns', () => {
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect this' }, { type: 'input_image', image_url: 'data:image/png;base64,AA==' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Previous answer' }] },
    { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"filePath":"a"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'file contents' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue' }] },
  ];
  const messages = adapters.responsesInputToChatBody({ model: 'fixture', input }).messages;
  expect(messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'assistant', 'tool', 'user']);
  expect(messages[1].content).toEqual([{ type: 'text', text: 'Previous answer' }]);
  expect(messages[0].content[1].type).toBe('image_url');
  expect(messages[2].tool_calls[0].id).toBe(messages[3].tool_call_id);
});

test('agentTools=false preserves native tool names and arguments; enabled mapping still works', () => {
  const before = adapters.config.agentTools;
  const args = { filePath: 'a', workdir: '/project' };
  const completion = { choices: [{ message: { tool_calls: [
    { id: 'call_1', function: { name: 'read', arguments: JSON.stringify(args) } },
    { id: 'call_2', function: { name: 'shell', arguments: '{"command":"pwd","workdir":"/project"}' } },
  ] }, finish_reason: 'tool_calls' }] };
  try {
    adapters.config.agentTools = false;
    expect(adapters.remapAgentTool('read', JSON.stringify(args))).toBeNull();
    const result = adapters.chatToAnthropic(completion, 'fixture', 'fixture');
    expect(result.content[0]).toMatchObject({ name: 'read', input: args });
    expect(result.content[1]).toMatchObject({ name: 'shell', input: { command: 'pwd', workdir: '/project' } });
    adapters.config.agentTools = true;
    expect(adapters.remapAgentTool('read', '{"filePath":"a"}')).toEqual({ name: 'Read', args: '{"file_path":"a"}' });
    expect(adapters.remapAgentTool('shell', '{"command":"pwd","workdir":"/project"}')).toEqual({ name: 'Bash', args: '{"command":"pwd"}' });
  } finally { adapters.config.agentTools = before; }
});

test('streamed Anthropic tool calls also keep native names and argument keys when mapping is off', async () => {
  const before = adapters.config.agentTools;
  try {
    adapters.config.agentTools = false;
    const res = responseSink();
    const upstream = sse(chatChunk(null, { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"a"}' } }] }) + chatChunk('tool_calls'));
    await adapters.relayAnthropicStream({}, res, adapters.sseChunks(upstream), 'fixture', 'fixture');
    const events = res.output.split('\n').filter((line: string) => line.startsWith('data:') && line.trim() !== 'data: [DONE]').map((line: string) => JSON.parse(line.slice(5)));
    expect(events.find((event: any) => event.type === 'content_block_start').content_block.name).toBe('read');
    expect(events.find((event: any) => event.delta?.type === 'input_json_delta').delta.partial_json).toBe('{"filePath":"a"}');
  } finally { adapters.config.agentTools = before; }
});

for (const finish of ['length', 'content_filter', 'stop', 'tool_calls']) {
  const reason = finish === 'length' ? 'max_output_tokens' : finish === 'content_filter' ? 'content_filter' : null;
  test(`collected and streaming Responses preserve ${finish}`, async () => {
    const calls = [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"a"}' } }];
    const collected = adapters.chatToResponses({ choices: [{ message: { content: 'partial', tool_calls: calls }, finish_reason: finish }] }, 'fixture', 'fixture');
    expect(collected.status).toBe(reason ? 'incomplete' : 'completed');
    expect(collected.incomplete_details).toEqual(reason ? { reason } : undefined);
    expect(collected.output[1].name).toBe('read');
    const res = responseSink();
    await adapters.relayChatAsResponsesStream({}, res, sse(chatChunk(null, { content: 'partial', tool_calls: calls }) + chatChunk(finish) + 'data: [DONE]\n\n'), 'fixture');
    const events = res.output.split('\n').filter((line: string) => line.startsWith('data:')).map((line: string) => JSON.parse(line.slice(5)));
    const terminal = events.at(-1);
    expect(terminal.type).toBe(reason ? 'response.incomplete' : 'response.completed');
    expect(terminal.response.status).toBe(collected.status);
    expect(terminal.response.incomplete_details).toEqual(collected.incomplete_details);
    expect(terminal.response.output[0].content[0].text).toBe('partial');
    expect(terminal.response.output[1].arguments).toBe('{"filePath":"a"}');
    const toolItem = events.find((event: any) => event.type === 'response.output_item.added' && event.item.type === 'function_call').item;
    expect(events.find((event: any) => event.type === 'response.function_call_arguments.delta').item_id).toBe(toolItem.id);
    expect(events.find((event: any) => event.type === 'response.function_call_arguments.done').item_id).toBe(toolItem.id);
    if (reason) expect(res.output).not.toContain('response.completed');
  });
}

test('chat-to-Responses stream still rejects nonterminal EOF', async () => {
  const res = responseSink();
  await adapters.relayChatAsResponsesStream({}, res, sse(chatChunk(null, { content: 'partial' })), 'fixture');
  expect(res.output).toContain('event: error');
  expect(res.output).not.toContain('response.completed');
});

function bridgeRequest(stream: boolean) {
  const req: any = new EventEmitter();
  req.method = 'POST';
  req.url = '/v1/chat/completions';
  req.headers = {};
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = responseSink();
  const done = new Promise<void>(resolve => res.once('finish', resolve));
  bridge.handleRequest(req, res);
  req.emit('data', Buffer.from(JSON.stringify({ model: 'protocol-regression-free', messages: [{ role: 'user', content: 'test' }], stream })));
  req.emit('end');
  return { res, done };
}

async function withBridge(upstream: (url: any, init: any) => Promise<Response>, run: () => Promise<void>) {
  const ensure = spyOn(bridge.identity, 'ensureFresh').mockImplementation(() => {});
  const verdict = spyOn(bridge.identity, 'getCatalogVerdict').mockReturnValue('free');
  const fetch = spyOn(proxy, 'netFetch').mockImplementation(upstream);
  bridge.markProtocolSupport('protocol-regression-free', true);
  try { await run(); }
  finally { ensure.mockRestore(); verdict.mockRestore(); fetch.mockRestore(); bridge.__resetProtocolLanes(); }
}

for (const stream of [false, true]) {
  for (const kind of ['empty', 'partial', 'done-only', 'completed', 'incomplete', 'failed']) {
    test(`Free bridge ${stream ? 'SSE' : 'JSON'} requires a real Responses terminal: ${kind}`, async () => {
      const text = kind === 'empty' ? '' : kind === 'done-only' ? 'data: [DONE]\n\n' :
        data({ type: 'response.output_text.delta', delta: 'partial' }) +
        (kind === 'completed' ? data({ type: 'response.completed', response: { status: 'completed' } }) :
          kind === 'incomplete' ? data({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } } }) :
            kind === 'failed' ? data({ type: 'response.failed', response: { error: { message: 'provider failed' } } }) : '');
      await withBridge(async () => sse(text), async () => {
        const { res, done } = bridgeRequest(stream);
        await done;
        const success = kind === 'completed' || kind === 'incomplete';
        if (success) {
          expect(res.statusCode).toBe(200);
          expect(res.output).toContain(`"finish_reason":"${kind === 'incomplete' ? 'content_filter' : 'stop'}"`);
        } else {
          expect(res.output).toContain('"error"');
          expect(res.output).not.toContain('"finish_reason":"stop"');
          if (!stream || kind === 'empty' || kind === 'done-only') expect(res.statusCode).toBe(502);
        }
      });
    });
  }
}

// Timer callbacks are driven manually, not by elapsed wall time.
async function microtasks() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
test('Free bridge replaces first-byte deadline with chunk-rearmed idle and one fixed hour ceiling', async () => {
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const set = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number) => {
    const timer = { callback, ms, cleared: false }; timers.push(timer); return timer;
  }) as any);
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((timer: any) => { if (timer) timer.cleared = true; }) as any);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let signal!: AbortSignal;
  try {
    await withBridge(async (_url, init) => {
      signal = init.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(c) { controller = c; signal.addEventListener('abort', () => c.error(signal.reason), { once: true }); },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }, async () => {
      const { res, done } = bridgeRequest(false);
      await microtasks();
      const first = timers[0];
      expect(first.cleared).toBe(false); // receiving headers did not rearm it
      expect(timers.some(t => t.ms === 3600000)).toBe(false);
      // Raw heartbeat fragments count as bytes even without a complete SSE line.
      controller.enqueue(enc.encode(': heartbeat'));
      await microtasks();
      expect(first.cleared).toBe(true);
      const idle = [...timers].reverse().find(t => t.ms === first.ms)!;
      const ceiling = timers.find(t => t.ms === 3600000)!;
      expect(ceiling).toBeDefined();
      controller.enqueue(enc.encode('\n\n'));
      await microtasks();
      expect(idle.cleared).toBe(true);
      expect(timers.filter(t => t.ms === 3600000)).toHaveLength(1);
      expect(ceiling.cleared).toBe(false);
      [...timers].reverse().find(t => t.ms === first.ms)!.callback();
      await done;
      expect(signal.aborted).toBe(true);
      expect(res.statusCode).toBe(504);
      expect(res.output).toContain('Upstream sent no data');
      expect(timers.every(t => t.cleared)).toBe(true);
    });
  } finally { set.mockRestore(); clear.mockRestore(); }
});

for (const deadline of ['first-byte', 'ceiling']) {
  test(`Free bridge aborts at the ${deadline} deadline`, async () => {
    const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
    const set = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number) => {
      const timer = { callback, ms, cleared: false }; timers.push(timer); return timer;
    }) as any);
    const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((timer: any) => { if (timer) timer.cleared = true; }) as any);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    try {
      await withBridge(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
        start(c) { controller = c; init.signal.addEventListener('abort', () => c.error(init.signal.reason), { once: true }); },
      })), async () => {
        const { res, done } = bridgeRequest(false);
        await microtasks();
        if (deadline === 'ceiling') { controller.enqueue(enc.encode(': heartbeat\n\n')); await microtasks(); }
        (deadline === 'ceiling' ? timers.find(t => t.ms === 3600000)! : timers[0]).callback();
        await done;
        expect(res.statusCode).toBe(504);
        expect(res.output).toContain(deadline === 'ceiling' ? '3600000ms deadline' : 'no response bytes');
        expect(timers.every(t => t.cleared)).toBe(true);
      });
    } finally { set.mockRestore(); clear.mockRestore(); }
  });
}

for (const newerRelease of [false, true]) {
  test(`explicit catalog recheck refreshes a populated catalog without CLI adoption (${newerRelease ? 'newer' : 'same'} release)`, async () => {
    const env = { ua: process.env.OPENCODE_USER_AGENT, mode: process.env.UPDATE_MODE, cache: process.env.OPENCODE_CACHE_DIR };
    delete process.env.OPENCODE_USER_AGENT;
    process.env.UPDATE_MODE = 'reactive';
    process.env.OPENCODE_CACHE_DIR = 'off';
    // A separate identity instance keeps recipe/cache state out of other tests.
    const identityPath = require.resolve('../vendor/bridge/identity.js');
    const cached = require.cache[identityPath];
    let identity: any;
    try {
      delete require.cache[identityPath];
      identity = require(identityPath);
    } finally {
      if (cached) require.cache[identityPath] = cached; else delete require.cache[identityPath];
    }
    const before = identity.getState();
    let catalogCalls = 0;
    const fetch = spyOn(proxy, 'netFetch').mockImplementation(async (url: any) => {
      if (String(url).includes('current=')) return Response.json({ version: newerRelease ? '999.0.0' : before.recipe.version });
      catalogCalls++;
      expect(String(url)).toContain('api.json');
      return Response.json({ opencode: { api: 'https://opencode.ai/catalog-regression/v1', models: {
        'new-free': { cost: { input: 0, output: 0 }, reasoning: true, limit: { output: 4096 } },
        'old-free': { cost: { input: 1, output: 1 } },
      } } });
    });
    try {
      identity.applyRecipe({ freeModels: ['old-free'] });
      identity.__setLastCheckTime(Date.now());
      const result = await identity.refresh({ recheck: true });
      expect(result.error).toBeUndefined();
      expect(identity.getRecipe().version).toBe(before.recipe.version);
      expect(identity.getFreeModels()).toEqual(['new-free']);
      expect(identity.getCatalogVerdict('old-free')).toBe('paid');
      expect(identity.getModelFacts('new-free')).toMatchObject({ reasoning: true, maxOutput: 4096 });
      expect(identity.getEndpoints().chatUrl).toBe('https://opencode.ai/catalog-regression/v1/chat/completions');
      expect(catalogCalls).toBe(1);
      await identity.refresh();
      identity.ensureFresh();
      expect(catalogCalls).toBe(1);
    } finally {
      fetch.mockRestore();
      for (const [key, value] of Object.entries({ OPENCODE_USER_AGENT: env.ua, UPDATE_MODE: env.mode, OPENCODE_CACHE_DIR: env.cache })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
}
