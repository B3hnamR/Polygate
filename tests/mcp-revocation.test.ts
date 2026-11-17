import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { preserveTestState } from './setup';
import { settings } from '../backend/state';
import { agentMcpCatalog, callTool, handleMcp, mcpConfig, reconnect, stopMcp } from '../backend/mcp';
import type { ApiKey, McpServer } from '../backend/types';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
let restore: ReturnType<typeof preserveTestState>;
let fixture: ReturnType<typeof Bun.serve>, key: ApiKey, server: McpServer;
let inits = 0, dispatched = 0, executed = 0, description = 'Original tool';
let hold: { method: string; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
let expire: (() => void) | undefined;
const gates: Array<ReturnType<typeof deferred>> = [];
const pause = (method: string) => { const release = deferred(); gates.push(release); return hold = { method, entered: deferred(), release }; };
const rpc = (method: string, id = 1) => ({ jsonrpc: '2.0', id, method, ...(method === 'tools/call' ? { params: { name: 'srv__where', arguments: {} } } : {}) });

// Invoke the real inbound handler, keeping the body independently releasable after admission.
function inbound(body: unknown, delayed = false) {
  const req = Object.assign(new PassThrough(), { method: 'POST', headers: { authorization: `Bearer ${key.value}` }, socket: { remoteAddress: '127.0.0.1' } });
  let result: any;
  const res = { setHeader() {}, writeHead() {}, end(value?: string) { result = value ? JSON.parse(value) : undefined; } };
  const pending = handleMcp(req as unknown as IncomingMessage, res as unknown as ServerResponse, '/mcp').then(() => result);
  const send = () => req.end(JSON.stringify(body));
  if (!delayed) send();
  return { pending, send };
}
const counters = () => ({ requests: key.requests, lastUsed: key.lastUsed, used: key.used });

beforeAll(() => { restore = preserveTestState(); });
beforeEach(() => {
  stopMcp(); inits = dispatched = executed = 0; description = 'Original tool'; hold = undefined; expire = undefined;
  fixture = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    if (req.method === 'DELETE') return new Response(null, { status: 204 });
    const m = await req.json() as any;
    if (m.id === undefined) return new Response(null, { status: 202 });
    if (m.method === 'initialize') inits++;
    if (m.method === 'tools/call') {
      dispatched++;
      if (expire) { const action = expire; expire = undefined; action(); return new Response(null, { status: 404 }); }
    }
    if (hold && hold.method === m.method) { const gate = hold; hold = undefined; gate.entered.resolve(); await gate.release.promise; }
    if (m.method === 'tools/call') executed++;
    const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
      : m.method === 'tools/list' ? { tools: [{ name: 'where', description, inputSchema: { type: 'object' } }] }
      : { content: [{ type: 'text', text: 'fixture result' }] };
    return Response.json({ jsonrpc: '2.0', id: m.id, result }, { headers: { 'mcp-session-id': 'fixture-session' } });
  } });
  key = { id: 'revocation-key', name: 'Fixture client', value: 'pg_revocation_fixture_secret', enabled: true, limit: 0, requests: 7, used: 3, lastUsed: 123 };
  server = { id: 'srv', name: 'srv', enabled: true, transport: 'http', url: `http://127.0.0.1:${fixture.port}/mcp`, routeId: 'direct' };
  settings.keys = [key]; settings.mcp = { enabled: true, builtin: true, servers: [server] };
  settings.routes = [{ id: 'direct', name: 'Direct', kind: 'direct', url: '', enabled: true, models: [] }];
});
afterEach(() => { for (const gate of gates.splice(0)) gate.resolve(); stopMcp(); fixture.stop(true); });
afterAll(() => restore());

const keyRevocations: Array<[string, () => void]> = [
  ['in-place regeneration', () => { key.value = 'pg_replaced_fixture_secret'; }],
  ['deletion', () => { settings.keys = []; }],
  ['same-ID/value replacement', () => { settings.keys = [{ ...key }]; }],
  ['ID mutation', () => { key.id = 'changed-id'; }],
  ['disablement', () => { key.enabled = false; }],
  ['expiry', () => { key.expiresAt = Date.now() - 1; }],
  ['budget exhaustion', () => { key.budget = key.used; }],
];
for (const [label, revoke] of keyRevocations) {
  test(`client ${label} during body reading invalidates the admitted key`, async () => {
    const before = counters(); const request = inbound([rpc('initialize'), rpc('tools/call', 2)], true);
    revoke(); request.send();
    const results = await request.pending;
    expect(results.every((r: any) => r.error?.code === -32602)).toBe(true);
    expect(inits).toBe(0); expect(dispatched).toBe(0); expect(counters()).toEqual(before);
    expect(JSON.stringify(results)).not.toContain('pg_');
  });
  test(`client ${label} during readiness prevents remote dispatch`, async () => {
    const before = counters(), gate = pause('tools/list');
    const request = inbound(rpc('tools/call'));
    try { await gate.entered.promise; revoke(); }
    finally { gate.release.resolve(); }
    expect((await request.pending).error?.code).toBe(-32602);
    expect(dispatched).toBe(0); expect(counters()).toEqual(before);
  });
  test(`client ${label} between batch operations prevents subsequent execution`, async () => {
    const before = counters(), gate = pause('tools/call');
    const request = inbound([rpc('tools/call'), rpc('tools/call', 2), rpc('ping', 3)]);
    try { await gate.entered.promise; revoke(); }
    finally { gate.release.resolve(); }
    const results = await request.pending;
    expect(results[0].result.content[0].text).toBe('fixture result');
    expect(results.slice(1).every((r: any) => r.error?.code === -32602)).toBe(true);
    expect(dispatched).toBe(1); expect(executed).toBe(1); expect(counters()).toEqual(before);
  });
}

const serverRevocations: Array<[string, () => void]> = [
  ['deletion', () => { mcpConfig().servers = []; }],
  ['replacement', () => { mcpConfig().servers = [{ ...server }]; }],
  ['disablement', () => { server.enabled = false; }],
  ['hub disablement', () => { mcpConfig().enabled = false; }],
  ['ACL revocation', () => { server.keys = ['another-key']; }],
  ['tool disablement', () => { server.disabledTools = ['where']; }],
  ['connection signature change', () => { server.headers = { 'x-fixture': 'changed' }; }],
];
for (const [label, revoke] of serverRevocations) {
  test(`server ${label} during readiness prevents remote dispatch`, async () => {
    const before = counters(), gate = pause('tools/list');
    const request = inbound(rpc('tools/call'));
    try { await gate.entered.promise; revoke(); }
    finally { gate.release.resolve(); }
    expect((await request.pending).error?.code).toBe(-32602);
    expect(dispatched).toBe(0); expect(counters()).toEqual(before);
  });
  test(`tools/list rechecks server ${label} after its connection wait`, async () => {
    const gate = pause('tools/list'), request = inbound(rpc('tools/list'));
    try { await gate.entered.promise; revoke(); }
    finally { gate.release.resolve(); }
    const result = await request.pending;
    if (label === 'hub disablement') expect(result.error?.code).toBe(-32602);
    else expect(result.result.tools.some((t: any) => t.name === 'srv__where')).toBe(false);
    expect(dispatched).toBe(0);
  });
}

test('tools/list rejects an admitted key regenerated during readiness', async () => {
  const gate = pause('tools/list'), request = inbound(rpc('tools/list'));
  try { await gate.entered.promise; key.value = 'pg_new_fixture_secret'; }
  finally { gate.release.resolve(); }
  expect((await request.pending).error?.code).toBe(-32602);
});

test('tools/list rereads builtin settings after readiness', async () => {
  const gate = pause('tools/list'), request = inbound(rpc('tools/list'));
  try { await gate.entered.promise; mcpConfig().builtinKeys = ['another-key']; }
  finally { gate.release.resolve(); }
  const result = await request.pending;
  expect(result.result.tools.some((t: any) => t.name.startsWith('polygate__'))).toBe(false);
  expect(result.result.tools.some((t: any) => t.name === 'srv__where')).toBe(true);
});

for (const [label, revoke] of [...keyRevocations.map(([label, revoke]) => [`key ${label}`, revoke] as const), ...serverRevocations.map(([label, revoke]) => [`server ${label}`, revoke] as const)]) {
  test(`session expiry checks ${label} before reconnecting`, async () => {
    const before = counters(); expire = revoke;
    const result = await inbound(rpc('tools/call')).pending;
    expect(result.error?.code).toBe(-32602);
    expect(inits).toBe(1); expect(dispatched).toBe(1); expect(executed).toBe(0); expect(counters()).toEqual(before);
  });
}

test('a valid session expiry retries once without quota increments', async () => {
  const before = counters(); expire = () => {};
  expect((await inbound(rpc('tools/call')).pending).result.content[0].text).toBe('fixture result');
  expect(inits).toBe(2); expect(dispatched).toBe(2); expect(executed).toBe(1); expect(counters()).toEqual(before);
});

test('key regeneration during the session-expiry reconnect prevents the retry dispatch', async () => {
  const before = counters(); let gate: ReturnType<typeof pause> | undefined;
  const reconnecting = deferred();
  expire = () => { gate = pause('tools/list'); reconnecting.resolve(); };
  const request = inbound(rpc('tools/call'));
  await reconnecting.promise;
  try { await gate!.entered.promise; key.value = 'pg_regenerated_during_reconnect'; }
  finally { gate!.release.resolve(); }
  expect((await request.pending).error?.code).toBe(-32602);
  expect(inits).toBe(2); expect(dispatched).toBe(1); expect(executed).toBe(0); expect(counters()).toEqual(before);
});

for (const [label, revoke] of serverRevocations.filter(([label]) => ['hub disablement', 'ACL revocation', 'tool disablement'].includes(label))) {
  test(`server ${label} between batch calls stops the next tool`, async () => {
    const gate = pause('tools/call'), request = inbound([rpc('tools/call'), rpc('tools/call', 2)]);
    try { await gate.entered.promise; revoke(); }
    finally { gate.release.resolve(); }
    const results = await request.pending;
    expect(results[0].result.content[0].text).toBe('fixture result');
    expect(results[1].error?.code).toBe(-32602); expect(dispatched).toBe(1);
  });
}

test('builtin ACL revocation between batch operations prevents builtin execution', async () => {
  const gate = pause('tools/call');
  const request = inbound([rpc('tools/call'), { ...rpc('tools/call', 2), params: { name: 'polygate__gateway_status' } }]);
  try { await gate.entered.promise; mcpConfig().builtinKeys = ['another-key']; }
  finally { gate.release.resolve(); }
  const results = await request.pending;
  expect(results[0].result.content[0].text).toBe('fixture result');
  expect(results[1].error?.code).toBe(-32602);
});

test('Agent approval is checked against the fresh tool definition after readiness', async () => {
  await callTool('where', {}, undefined, 'srv', 'dashboard'); dispatched = executed = 0;
  key.agent = true;
  const approved = agentMcpCatalog().servers.find(s => s.id === server.id)!.tools[0];
  mcpConfig().agentTools = [{ server: server.id, tool: approved.name, fingerprint: approved.fingerprint }];
  const gate = pause('tools/list'), connecting = reconnect(server.id);
  await gate.entered.promise;
  const request = inbound(rpc('tools/call'));
  // A direct call starts synchronously with the approved cached definition and shares the pending connection.
  const direct = callTool('where', {}, key, 'srv', 'client').then(() => false, () => true);
  description = 'Changed tool definition'; gate.release.resolve();
  await connecting;
  expect(await direct).toBe(true); expect((await request.pending).error?.code).toBe(-32602);
  expect(dispatched).toBe(0);
});

test('Agent consent revoked during readiness is not inherited by a pending call', async () => {
  await callTool('where', {}, undefined, 'srv', 'dashboard'); dispatched = executed = 0;
  key.agent = true;
  const approved = agentMcpCatalog().servers.find(s => s.id === server.id)!.tools[0];
  mcpConfig().agentTools = [{ server: server.id, tool: approved.name, fingerprint: approved.fingerprint }];
  const gate = pause('tools/list'), connecting = reconnect(server.id);
  await gate.entered.promise;
  const pending = callTool('where', {}, key, 'srv', 'client').then(() => false, () => true);
  mcpConfig().agentTools = []; gate.release.resolve();
  await connecting;
  expect(await pending).toBe(true); expect(dispatched).toBe(0);
});

test('dashboard no-key authority remains explicit; client no-key calls fail', async () => {
  await expect(callTool('where', {}, undefined, 'srv', 'client')).rejects.toThrow('client API key');
  expect(dispatched).toBe(0);
  expect((await callTool('where', {}, undefined, 'srv', 'dashboard')).content[0].text).toBe('fixture result');
  const before = counters();
  expect((await inbound(rpc('tools/call')).pending).result.content[0].text).toBe('fixture result');
  expect((await inbound({ ...rpc('tools/call'), params: { name: 'polygate__gateway_status' } }).pending).result.isError).toBeUndefined();
  expect(counters()).toEqual(before);
});

test('a copied key object cannot stand in for the admitted key identity', async () => {
  const before = counters();
  await expect(callTool('where', {}, { ...key }, 'srv', 'client')).rejects.toThrow('changed or was removed');
  expect(dispatched).toBe(0); expect(counters()).toEqual(before);
});

test('unknown RPC methods and malformed requests do not change key accounting', async () => {
  const before = counters();
  expect((await inbound({ jsonrpc: '2.0', id: 11, method: 'unknown-method' }).pending).error).toBeDefined();
  expect((await inbound({ jsonrpc: 'invalid', id: 12, method: 'tools/call' }).pending).error).toBeDefined();
  expect(dispatched).toBe(0); expect(counters()).toEqual(before);
});
