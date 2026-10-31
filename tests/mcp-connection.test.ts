import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { settings } = await import('../backend/state');
const { mcpConfig, saveServers, callTool, settle, stopMcp, serverStatus } = await import('../backend/mcp');
const dir = mkdtempSync(path.join(os.tmpdir(), 'pg-mcp-'));
const saved = { mcp: settings.mcp };
afterAll(() => { stopMcp(); settings.mcp = saved.mcp; rmSync(dir, { recursive: true, force: true }); fixture.stop(true); });

// An HTTP server that answers like MCP. /slow takes 700 ms to answer anything; every tool call says which path it reached. Every session it starts has
// its own id, so a test can say exactly which session was closed (a shared counter could be satisfied by some other connection's close).
// /slowcall answers tool calls only after 2 s, and records the ones whose client gave up.
let inits = 0, sessionSeq = 0, abandoned = 0; const created = new Set<string>(), deleted = new Set<string>();
const fixture = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const url = new URL(req.url); const sid = req.headers.get('mcp-session-id') || '';
  if (req.method === 'DELETE') { if (sid) deleted.add(sid); return new Response(null, { status: 204 }); }
  if (req.method !== 'POST') return new Response(null, { status: 204 });
  const m = await req.json() as any; if (m.id === undefined) return new Response(null, { status: 202 });
  let session = sid; if (m.method === 'initialize') { inits++; session = 's-' + (++sessionSeq); created.add(session); }
  if (url.pathname === '/slow') await Bun.sleep(700);
  if (url.pathname === '/slowcall' && m.method === 'tools/call') { await Bun.sleep(2000); if (req.signal.aborted) abandoned++; }
  const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : m.method === 'tools/list' ? { tools: [{ name: 'where', inputSchema: { type: 'object' } }] }
    : { content: [{ type: 'text', text: 'reached ' + url.pathname }] };
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }), { headers: { 'content-type': 'application/json', 'mcp-session-id': session } });
} });
const http = (pathname: string) => ({ id: 'srv', name: 'srv', enabled: true, transport: 'http' as const, url: `http://127.0.0.1:${fixture.port}${pathname}`, timeoutSec: 30 });
const text = async (scope: string) => (await callTool('where', {}, undefined, scope, 'dashboard') as any).content[0].text;

test('saving a changed address while a connection is still being made replaces it: the next call reaches the new address', async () => {
  mcpConfig().servers = []; mcpConfig().enabled = true;
  saveServers([http('/slow')]);          // starts connecting, and takes 700 ms
  saveServers([http('/other')]);         // the address is changed before that finishes
  await settle('srv', 10000);
  expect(await text('srv')).toBe('reached /other');
  await Bun.sleep(900);                  // the old connection finishes now and must not take over
  expect(await text('srv')).toBe('reached /other');
});
test('a connection that is already ready is not reused after its address changed', async () => {
  saveServers([http('/first')]); await settle('srv', 10000); expect(await text('srv')).toBe('reached /first');
  mcpConfig().servers = [http('/second')]; // settings changed without the usual re-sync
  expect(await text('srv')).toBe('reached /second');
});

// A local program whose answer is written in two pieces, cut inside a three-byte character.
const script = path.join(dir, 'say.cjs');
writeFileSync(script, `let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);if(m.id===undefined)continue;
const r=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'local',version:'2'}}:m.method==='tools/list'?{tools:[{name:'where',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'你好 🌍'}]};
const out=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:m.id,result:r})+'\\n');const cut=m.method==='tools/call'?out.indexOf(Buffer.from('好'))+1:out.length;
process.stdout.write(out.subarray(0,cut));setTimeout(()=>process.stdout.write(out.subarray(cut)),60);}});`);
test('text from a local program keeps its non-ASCII characters even when a chunk ends inside one', async () => {
  saveServers([{ id: 'loc', name: 'loc', enabled: true, transport: 'stdio', command: process.execPath, args: [script], timeoutSec: 30 }]);
  await settle('loc', 20000);
  expect(await text('loc')).toBe('你好 🌍');
});

test('disabling a server while it is still connecting cancels that connection: its session is closed, it is not installed, and enabling again makes a new one', async () => {
  mcpConfig().servers = []; mcpConfig().enabled = true; inits = 0; created.clear(); deleted.clear();
  saveServers([http('/slow')]);                          // starts connecting, and takes 700 ms
  await Bun.sleep(100);
  saveServers([{ ...http('/slow'), enabled: false }]);   // switched off before it finished
  await Bun.sleep(1400);                                 // the old connection finishes now
  expect(serverStatus(mcpConfig().servers[0]).status.state).toBe('off');
  expect(created.size).toBe(1);                          // the slow initialization did reach the server and start a session
  expect([...created].every(id => deleted.has(id))).toBe(true); // and that very session was closed, though its answer came after the server was disabled
  const before = inits; saveServers([http('/slow')]); await settle('srv', 10000);
  expect(inits).toBe(before + 1);                        // a new connection, not the old one revived
  expect(await text('srv')).toBe('reached /slow');
});

test('disabling a server while a tool call is in flight closes its session and stops waiting for the answer', async () => {
  mcpConfig().servers = []; mcpConfig().enabled = true; created.clear(); deleted.clear(); abandoned = 0;
  saveServers([{ ...http('/slowcall') }]); await settle('srv', 10000);
  const sessions = [...created]; expect(sessions.length).toBe(1);
  const started = Date.now(); const call = callTool('where', {}, undefined, 'srv', 'dashboard') as Promise<any>;
  await Bun.sleep(200); saveServers([{ ...http('/slowcall'), enabled: false }]);
  const result = await call;
  expect(Date.now() - started).toBeLessThan(1500);       // it did not wait the 2 s for the answer
  expect(result.isError).toBe(true);
  await Bun.sleep(300); expect(deleted.has(sessions[0])).toBe(true);
  await Bun.sleep(1800); expect(abandoned).toBeGreaterThan(0); // the server saw the request cancelled
});
