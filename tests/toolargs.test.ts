import { describe, expect, test } from 'bun:test';
import { repairArgs, toolArgRepair } from '../backend/toolargs';

const tools = [
  { type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { filePath: { type: 'string' }, offset: { type: 'number' } }, required: ['filePath'] } } },
  { type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command', 'description'] } } },
  { type: 'function', function: { name: 'edit', parameters: { type: 'object', properties: { filePath: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' } }, required: ['filePath', 'oldString', 'newString'] } } },
];
const schema = (name: string) => { const f = tools.find(t => t.function.name === name)!.function.parameters; return { properties: f.properties as any, required: f.required }; };

async function pipe(events: unknown[], split = 0) {
  const t = toolArgRepair(tools)!;
  const text = events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  const parts = split ? text.match(new RegExp(`[\\s\\S]{1,${split}}`, 'g'))! : [text];
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); } });
  const out = await new Response(body.pipeThrough(t)).text();
  return out.split('\n\n').filter(Boolean).map(b => b.slice(5).trim()).map(r => r === '[DONE]' ? r : JSON.parse(r));
}
const argsOf = (events: any[], index = 0) => events.flatMap(e => e === '[DONE]' ? [] : e.choices.flatMap((c: any) => c.delta?.tool_calls || [])).filter((t: any) => t.index === index).map((t: any) => t.function?.arguments || '').join('');

describe('tool argument repair', () => {
  test('renames path to filePath for read, the DeepSeek mistake', () => {
    expect(repairArgs(schema('read'), '{"path":"src/a.ts"}')).toEqual({ args: '{"filePath":"src/a.ts"}', renamed: ['path → filePath'] });
  });
  test('spelling variants match too: file_path, old_string, new_string', () => {
    const r = repairArgs(schema('edit'), '{"file_path":"a.ts","old_string":"x","new_string":"y"}');
    expect(JSON.parse(r!.args)).toEqual({ filePath: 'a.ts', oldString: 'x', newString: 'y' });
  });
  test('cmd becomes command; the other arguments stay', () => {
    expect(JSON.parse(repairArgs(schema('bash'), '{"cmd":"ls","description":"List files"}')!.args)).toEqual({ command: 'ls', description: 'List files' });
  });
  test('a correct call is never touched', () => {
    expect(repairArgs(schema('read'), '{"filePath":"a.ts","path":"b.ts"}')).toBeUndefined();
  });
  test('an ambiguous call is left alone: two candidates for one argument', () => {
    expect(repairArgs(schema('read'), '{"path":"a.ts","file":"b.ts"}')).toBeUndefined();
  });
  test('a wrong type is not renamed into place', () => {
    expect(repairArgs(schema('read'), '{"path":42}')).toBeUndefined();
  });
  test('broken JSON and unknown tools are left alone', () => {
    expect(repairArgs(schema('read'), '{"path":"a.ts"')).toBeUndefined();
    expect(repairArgs(undefined, '{"path":"a.ts"}')).toBeUndefined();
  });
  test('no stream transform without tools that have required arguments', () => {
    expect(toolArgRepair(undefined)).toBeUndefined();
    expect(toolArgRepair([{ type: 'function', function: { name: 'x', parameters: { type: 'object', properties: {} } } }])).toBeUndefined();
  });

  const head = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm' };
  const stream = [
    { ...head, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Let me read it.' }, finish_reason: null }] },
    { ...head, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '' } }] }, finish_reason: null }] },
    { ...head, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }, finish_reason: null }] },
    { ...head, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th": "src/a.ts"}' } }] }, finish_reason: null }] },
    { ...head, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { ...head, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    '[DONE]',
  ];
  test('a streamed call is held, repaired and sent whole before the finish; reasoning, the call start and usage pass through', async () => {
    for (const split of [0, 7]) {
      const out = await pipe(stream, split);
      expect(argsOf(out)).toBe('{"filePath":"src/a.ts"}');
      expect(out[0].choices[0].delta.reasoning_content).toBe('Let me read it.');
      expect(out[1].choices[0].delta.tool_calls[0]).toEqual({ index: 0, id: 'call_1', type: 'function', function: { name: 'read' } });
      const fin = out.findIndex((e: any) => e !== '[DONE]' && e.choices[0]?.finish_reason);
      const args = out.findIndex((e: any) => e !== '[DONE]' && e.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments);
      expect(args).toBeLessThan(fin);
      expect(out.at(-2).usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
      expect(out.at(-1)).toBe('[DONE]');
    }
  });
  test('a correct streamed call arrives with exactly the text the model wrote', async () => {
    const ok = stream.map(e => typeof e === 'string' ? e : JSON.parse(JSON.stringify(e).replace('{\\"pa', '{\\"filePa')));
    expect(argsOf(await pipe(ok))).toBe('{"filePath": "src/a.ts"}');
  });
  test('parallel calls keep their own indexes', async () => {
    const two = [
      { ...head, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }, { index: 1, id: 'b', type: 'function', function: { name: 'bash', arguments: '{"command":"ls","description":"List"}' } }] }, finish_reason: null }] },
      { ...head, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ];
    const out = await pipe(two);
    expect(argsOf(out, 0)).toBe('{"filePath":"a.ts"}');
    expect(argsOf(out, 1)).toBe('{"command":"ls","description":"List"}');
  });
  test('a call sent whole in its finishing event: the start, then the arguments, then the finish', async () => {
    const once = [
      { ...head, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
      '[DONE]',
    ];
    const out = await pipe(once);
    expect(out[0].choices[0].delta.tool_calls[0]).toEqual({ index: 0, id: 'call_9', type: 'function', function: { name: 'read' } });
    expect(out[0].choices[0].finish_reason).toBeNull();
    expect(out[1].choices[0].delta.tool_calls[0]).toEqual({ index: 0, function: { arguments: '{"filePath":"a.ts"}' } });
    expect(out[2].choices[0]).toEqual({ index: 0, delta: {}, finish_reason: 'tool_calls' });
    expect(out[2].usage).toEqual({ prompt_tokens: 3, completion_tokens: 2 });
    expect(out[3]).toBe('[DONE]');
  });
  test('a stream cut off before its finish still hands over what it held', async () => {
    const out = await pipe(stream.slice(0, 4));
    expect(argsOf(out)).toBe('{"filePath":"src/a.ts"}');
  });
  test('plain text answers pass through byte for byte', async () => {
    const text = [{ ...head, choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] }, { ...head, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]'];
    const t = toolArgRepair(tools)!; const raw = text.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(raw)); c.close(); } });
    expect(await new Response(body.pipeThrough(t)).text()).toBe(raw);
  });
});
