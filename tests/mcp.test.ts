import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { startGateway } = await import('../backend/main');
const { settings } = await import('../backend/state');
const { cleanServer, parseImport, slug, mcpConfig } = await import('../backend/mcp');
const { queryEvents } = await import('../backend/logbook');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = ''; let savedToken: string | undefined; let dir = '';
const admin = { authorization: 'Bearer mcp-test-secret', 'content-type': 'application/json' };
const call = async (p: string, body?: unknown) => { const r = await fetch(base + p, body === undefined ? { headers: admin } : { method: 'POST', headers: admin, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json()) as any }; };
let rpcId = 0;
const rpc = async (method: string, params: unknown = {}, key = settings.keys[0].value, p = '/mcp') => {
  const r = await fetch(base + p, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  return { status: r.status, session: r.headers.get('mcp-session-id'), body: r.status === 200 ? (await r.json()) as any : await r.text() };
};
// A tiny MCP server answering like a real one: echo and add tools, a session id, and (with ?sse=1) answers as an event stream.
const tools = [{ name: 'echo', description: 'Echoes text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }, { name: 'add', description: 'Adds', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }];
const answer = (m: any) => m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0' } }
  : m.method === 'tools/list' ? { tools } : m.method === 'tools/call' ? (m.params.name === 'add' ? { content: [{ type: 'text', text: String(m.params.arguments.a + m.params.arguments.b) }] } : { content: [{ type: 'text', text: 'echo: ' + m.params.arguments.text }] }) : {};
let seenAuth = ''; const sseClients = new Set<ReadableStreamDefaultController>();
const fixture = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const url = new URL(req.url); seenAuth = req.headers.get('authorization') || seenAuth;
  if (url.pathname === '/legacy' && req.method === 'GET') { let mine: ReadableStreamDefaultController; return new Response(new ReadableStream({ start(c) { mine = c; sseClients.add(c); c.enqueue(new TextEncoder().encode('event: endpoint\ndata: /legacy/messages?s=1\n\n')); }, cancel() { sseClients.delete(mine); } }), { headers: { 'content-type': 'text/event-stream' } }); }
  if (url.pathname === '/legacy/messages') { const m = await req.json() as any; if (m.id !== undefined) for (const c of sseClients) try { c.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: answer(m) })}\n\n`)); } catch { sseClients.delete(c); } return new Response(null, { status: 202 }); }
  if (url.pathname !== '/mcp') return new Response('no', { status: 404 });
  if (req.method === 'DELETE') return new Response(null, { status: 204 });
  const m = await req.json() as any; if (m.id === undefined) return new Response(null, { status: 202 });
  const reply = JSON.stringify({ jsonrpc: '2.0', id: m.id, result: answer(m) });
  const headers = { 'mcp-session-id': 'fixture-session' };
  if (url.searchParams.get('sse')) return new Response(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\nevent: message\ndata: ${reply}\n\n`, { headers: { ...headers, 'content-type': 'text/event-stream' } });
  return new Response(reply, { headers: { ...headers, 'content-type': 'application/json' } });
} });
const stdioScript = `let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);if(m.id===undefined)continue;
const r=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'local',version:'2'}}:m.method==='tools/list'?{tools:[{name:'whoami',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'secret='+(process.env.LOCAL_SECRET||'')+' admin='+(process.env.POLYGATE_ADMIN_TOKEN||'none')}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:r})+'\\n');}});console.error('local server ready');`;

beforeAll(async () => {
  savedToken = process.env.POLYGATE_ADMIN_TOKEN; process.env.POLYGATE_ADMIN_TOKEN = 'mcp-test-secret';
  dir = mkdtempSync(path.join(os.tmpdir(), 'polygate-mcp-')); writeFileSync(path.join(dir, 'server.js'), stdioScript);
  settings.warp = { engine: 'disabled', autoStart: false, pool: 1, rotateMinutes: 0, helperPath: '', endpoint: '' }; settings.mcp = { enabled: true, builtin: true, servers: [] };
  gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`;
});
afterAll(async () => { settings.mcp = { enabled: true, builtin: true, servers: [] }; await gateway?.close(); fixture.stop(true); for (const c of sseClients) try { c.close(); } catch { /* closed */ } if (savedToken === undefined) delete process.env.POLYGATE_ADMIN_TOKEN; else process.env.POLYGATE_ADMIN_TOKEN = savedToken; rmSync(dir, { recursive: true, force: true }); });

test('the hub needs a client API key and answers the MCP handshake', async () => {
  expect((await rpc('initialize', {}, 'wrong-key')).status).toBe(401);
  const init = await rpc('initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'test-client', version: '9' } });
  expect(init.status).toBe(200); expect(init.session).toBeTruthy();
  expect(init.body.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'polygate' } });
  expect((await rpc('ping')).body.result).toEqual({});
  expect((await rpc('resources/list')).body.error.code).toBe(-32601);
  const notified = await fetch(base + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + settings.keys[0].value, 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' });
  expect(notified.status).toBe(202);
  expect((await fetch(base + '/mcp', { headers: { authorization: 'Bearer ' + settings.keys[0].value } })).status).toBe(405);
});
test("Polygate's own tools report on the gateway", async () => {
  const list = await rpc('tools/list'); const names = list.body.result.tools.map((t: any) => t.name);
  expect(names).toEqual(expect.arrayContaining(['polygate__gateway_status', 'polygate__list_models', 'polygate__list_routes', 'polygate__test_route', 'polygate__recent_errors', 'polygate__read_logs', 'polygate__list_mcp_servers']));
  const status = await rpc('tools/call', { name: 'polygate__gateway_status', arguments: {} });
  expect(status.body.result.structuredContent).toMatchObject({ enabled: true, routes: { default: 'direct' } }); expect(status.body.result.isError).toBeUndefined();
  const routes = await rpc('tools/call', { name: 'list_routes', arguments: {} }, undefined, '/mcp/polygate');
  expect(routes.body.result.structuredContent.items[0]).toMatchObject({ id: 'direct', kind: 'direct' });
  const bad = await rpc('tools/call', { name: 'polygate__test_route', arguments: { route: 'nowhere' } });
  expect(bad.body.result.isError).toBe(true); expect(bad.body.result.content[0].text).toContain('list_routes');
  expect((await rpc('tools/call', { name: 'polygate__nope' })).body.error.code).toBe(-32602);
});
test('remote servers (modern HTTP, event-stream answers, older SSE) are combined with prefixed names, and secrets stay hidden', async () => {
  const a = await call('/admin/mcp/servers', { name: 'fixture', transport: 'http', url: `http://127.0.0.1:${fixture.port}/mcp?api_key=abc123secret`, headers: { Authorization: 'Bearer upstream-secret-1' } });
  expect(a.status).toBe(200); expect(a.body.status.state).toBe('ready'); expect(a.body.status.tools.map((t: any) => t.hubName)).toEqual(['fixture__echo', 'fixture__add']);
  expect(a.body.headers.Authorization).toBe('••••••••'); expect(a.body.url).not.toContain('abc123secret');
  expect((await call('/admin/mcp/servers', { name: 'streamed', transport: 'http', url: `http://127.0.0.1:${fixture.port}/mcp?sse=1` })).body.status.state).toBe('ready');
  expect((await call('/admin/mcp/servers', { name: 'legacy', transport: 'sse', url: `http://127.0.0.1:${fixture.port}/legacy` })).body.status.state).toBe('ready');
  const names = (await rpc('tools/list')).body.result.tools.map((t: any) => t.name);
  expect(names).toEqual(expect.arrayContaining(['fixture__echo', 'fixture__add', 'streamed__echo', 'legacy__add']));
  expect((await rpc('tools/call', { name: 'fixture__echo', arguments: { text: 'hi' } })).body.result.content[0].text).toBe('echo: hi'); expect(seenAuth).toBe('Bearer upstream-secret-1');
  expect((await rpc('tools/call', { name: 'streamed__add', arguments: { a: 2, b: 3 } })).body.result.content[0].text).toBe('5');
  expect((await rpc('tools/call', { name: 'legacy__add', arguments: { a: 4, b: 3 } })).body.result.content[0].text).toBe('7');
  // One server alone, with its tools' own names.
  expect((await rpc('tools/list', {}, undefined, '/mcp/fixture')).body.result.tools.map((t: any) => t.name)).toEqual(['echo', 'add']);
  // Saving with the masked values keeps the real ones.
  const kept = await call('/admin/mcp/servers', { ...a.body, title: 'Renamed' }); expect(kept.status).toBe(200);
  const saved = mcpConfig().servers.find(s => s.name === 'fixture')!; expect(saved.headers?.Authorization).toBe('Bearer upstream-secret-1'); expect(saved.url).toContain('abc123secret');
  const state = await call('/admin/mcp'); expect(JSON.stringify(state.body)).not.toContain('upstream-secret-1'); expect(JSON.stringify(state.body)).not.toContain('abc123secret');
  const logged = queryEvents({ sources: ['mcp'], limit: 100 }).entries.map(e => e.message);
  expect(logged.some(m => /^fixture\/echo · \d+ ms$/.test(m))).toBe(true); expect(JSON.stringify(queryEvents({ sources: ['mcp'] }))).not.toContain('upstream-secret-1');
});
test('tools can be switched off, servers limited to some keys, and servers switched off', async () => {
  const s = mcpConfig().servers.find(x => x.name === 'fixture')!;
  await call('/admin/mcp/servers/tools', { id: s.id, disabledTools: ['add'] });
  let names = (await rpc('tools/list')).body.result.tools.map((t: any) => t.name); expect(names).toContain('fixture__echo'); expect(names).not.toContain('fixture__add');
  expect((await rpc('tools/call', { name: 'fixture__add', arguments: { a: 1, b: 1 } })).body.error.code).toBe(-32602);
  const other = { id: 'other-key', name: 'Other', value: 'pg_other_key_for_mcp_tests_123456', enabled: true, limit: 4 }; settings.keys.push(other);
  try {
    await call('/admin/mcp/servers', { id: s.id, keys: [settings.keys[0].id] });
    expect((await rpc('tools/list', {}, other.value)).body.result.tools.map((t: any) => t.name)).not.toContain('fixture__echo');
    expect((await rpc('tools/list')).body.result.tools.map((t: any) => t.name)).toContain('fixture__echo');
  } finally { settings.keys = settings.keys.filter(k => k.id !== other.id); await call('/admin/mcp/servers', { id: s.id, keys: [] }); }
  await call('/admin/mcp/servers/toggle', { id: s.id, enabled: false });
  names = (await rpc('tools/list')).body.result.tools.map((t: any) => t.name); expect(names).not.toContain('fixture__echo');
  expect((await call('/admin/mcp')).body.servers.find((x: any) => x.name === 'fixture').status.state).toBe('off');
  await call('/admin/mcp/servers/toggle', { id: s.id, enabled: true });
});
test('a local program runs without Polygate secrets, and only the manager or the Windows app may add one', async () => {
  const r = await call('/admin/mcp/servers', { name: 'local', transport: 'stdio', command: process.execPath, args: [path.join(dir, 'server.js')], env: { LOCAL_SECRET: 's3cret-value' } });
  expect(r.status).toBe(200); expect(r.body.status.state).toBe('ready'); expect(r.body.env.LOCAL_SECRET).toBe('••••••••');
  const out = (await rpc('tools/call', { name: 'local__whoami', arguments: {} })).body.result.content[0].text;
  expect(out).toBe('secret=s3cret-value admin=none');
  expect(queryEvents({ sources: ['mcp'], q: 'local server ready' }).entries.length).toBeGreaterThan(0);
  // Without the manager's token (a dashboard sign-in), adding or changing a program is refused; switching it or its tools is not.
  const saved = mcpConfig().servers.find(x => x.name === 'local')!;
  expect(() => cleanServer({ name: 'x', transport: 'stdio', command: 'calc' }, undefined, false)).toThrow(/Windows app/);
  expect(() => cleanServer({ args: ['other.js'] }, saved, false)).toThrow(/Windows app/);
  expect(cleanServer({ enabled: false, disabledTools: ['whoami'] }, saved, false).command).toBe(process.execPath);
});
test('a connection can be tested before saving, and tools tried from the dashboard', async () => {
  const ok = await call('/admin/mcp/test', { name: 'trial', transport: 'http', url: `http://127.0.0.1:${fixture.port}/mcp` });
  expect(ok.body).toMatchObject({ ok: true, serverInfo: { name: 'fixture' } }); expect(ok.body.tools.map((t: any) => t.name)).toEqual(['echo', 'add']);
  const bad = await call('/admin/mcp/test', { name: 'trial', transport: 'http', url: `http://127.0.0.1:${fixture.port}/missing` });
  expect(bad.body.ok).toBe(false); expect(bad.body.error).toContain('HTTP 404');
  const s = mcpConfig().servers.find(x => x.name === 'fixture')!;
  expect((await call('/admin/mcp/call', { server: s.id, tool: 'echo', arguments: { text: 'from dashboard' } })).body.content[0].text).toBe('echo: from dashboard');
  expect((await call('/admin/mcp/call', { server: 'polygate', tool: 'list_mcp_servers', arguments: {} })).body.structuredContent.items.length).toBe(4);
});
test('other tools\' MCP settings can be imported', async () => {
  const parsed = parseImport({ mcpServers: { Exa: { url: 'https://mcp.exa.ai/mcp' }, files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/x'], env: { A: '1' } }, old: { url: 'https://x.example/sse' }, broken: {} } });
  expect(parsed).toEqual([{ name: 'Exa', transport: 'http', url: 'https://mcp.exa.ai/mcp', headers: undefined, enabled: true }, { name: 'files', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/x'], env: { A: '1' }, cwd: undefined, enabled: true }, { name: 'old', transport: 'sse', url: 'https://x.example/sse', headers: undefined, enabled: true }, { name: 'broken', invalid: 'It has neither an address nor a command' }]);
  expect(parseImport('{"mcp":{"ctx":{"type":"local","command":["bunx","ctx"],"environment":{"K":"v"}}}}')[0]).toMatchObject({ transport: 'stdio', command: 'bunx', args: ['ctx'], env: { K: 'v' } });
  expect(slug('My Server!', ['my-server'])).toBe('my-server-2'); expect(slug('polygate')).toBe('polygate-tools'); expect(slug('123')).toBe('server');
  const r = await call('/admin/mcp/import', { config: JSON.stringify({ mcpServers: { 'Fixture Two': { url: `http://127.0.0.1:${fixture.port}/mcp`, enabled: false }, broken: {} } }) });
  expect(r.body.added).toEqual(['fixture-two']); expect(r.body.skipped).toEqual([{ name: 'broken', reason: 'It has neither an address nor a command' }]);
});
test('the hub can be turned off', async () => {
  await call('/admin/mcp/settings', { enabled: false });
  try { expect((await rpc('tools/list')).status).toBe(404); } finally { await call('/admin/mcp/settings', { enabled: true }); }
  await call('/admin/mcp/settings', { builtin: false });
  try { expect((await rpc('tools/list')).body.result.tools.map((t: any) => t.name)).not.toContain('polygate__gateway_status'); } finally { await call('/admin/mcp/settings', { builtin: true }); }
});
