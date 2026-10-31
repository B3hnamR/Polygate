// Stands in for `opencode serve` (2.0.32) in tests/agent-engine.test.ts and tests/agent.test.ts: the endpoints the engine manager and the
// agent controller use, answered from the configuration Polygate wrote. FAKE_OPENCODE_MODE makes it misbehave the way a real engine could;
// a file named by FAKE_OPENCODE_CRASH_FILE makes it exit once it has answered the self-test (once: the file is removed), so a slow machine
// cannot turn the crash into a failed start. FAKE_OPENCODE_SAVED=1 starts it with one saved permission, the kind OpenCode's "always" leaves.
// Like the real engine, answers are wrapped as {data: …} except /api/info and /api/config. Two routes exist for tests only: POST /test/emit sends an event to the folder's event streams, GET /test/calls lists what it was asked.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2); const port = Number(args[args.indexOf('--port') + 1]);
writeFileSync(path.join(process.cwd(), 'fake-env.json'), JSON.stringify({ args, env: process.env }));
const mode = process.env.FAKE_OPENCODE_MODE || 'ok';
const configDir = path.join(process.env.XDG_CONFIG_HOME || '', 'opencode');
const config = JSON.parse(readFileSync(path.join(configDir, 'opencode.json'), 'utf8'));
const expected = 'Basic ' + Buffer.from('opencode:' + (process.env.OPENCODE_PASSWORD || '')).toString('base64');
const json = (body: unknown, status = 200) => Response.json(body, { status });
const calls: { method: string; path: string; body: any }[] = [];
const sessions = new Map<string, any>(); const prompts = new Map<string, string[]>(); let next = 0;
let saved = process.env.FAKE_OPENCODE_SAVED === '1' ? [{ id: 'psv_planted', projectID: 'p', action: 'shell', resource: 'node *' }] : [];
const streams = new Set<{ directory: string; send: (text: string) => void }>();
const broadcast = (event: any, directory: string) => { for (const s of streams) if (s.directory === directory) s.send(`data: ${JSON.stringify({ id: 'evt_' + ++next, created: Date.now(), location: { directory }, ...event })}\n\n`); };
const folderOf = (id: string) => sessions.get(id)?.location?.directory || '';
Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 0, async fetch(req) {
  if (!process.env.OPENCODE_PASSWORD || req.headers.get('authorization') !== expected) return new Response('unauthorized', { status: 401 });
  const url = new URL(req.url); const p = url.pathname; const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await req.json().catch(() => undefined);
  if (p.startsWith('/api/') && !['/api/info', '/api/config', '/api/model', '/api/agent'].includes(p)) calls.push({ method: req.method, path: p, body });
  if (p === '/api/info') return json({ version: mode === 'old-version' ? '1.19.5' : '2.0.32', pid: process.pid });
  if (p === '/api/config') return json([
    { type: 'document', path: path.join(configDir, 'opencode.json'), info: config }, { type: 'directory', path: configDir },
    ...(mode === 'project-config' ? [{ type: 'document', path: 'C:\\work\\cloned-repo\\opencode.json', info: {} }] : []),
  ]);
  if (p === '/api/model') return json({ data: [
    ...Object.keys(config.providers.polygate.models).map(id => ({ id, providerID: 'polygate', limit: config.providers.polygate.models[id].limit })),
    ...(mode === 'other-provider' ? [{ id: 'm', providerID: 'evil' }] : []),
  ] });
  // Like OpenCode 2.0.32: built-in rules, the shared configured ones, the agent's own, then a closing browser rule.
  if (p === '/api/agent') { crashSoon(); return json({ data: ['build', ...Object.keys(config.agents || {})].filter(id => !(mode === 'missing-agent' && id === 'polygate-plan')).map(id => ({ id, permissions: [
    { action: '*', resource: '*', effect: 'allow' }, ...config.permissions, ...(id === 'build' ? [] : config.agents[id].permissions), { action: 'browser', resource: '*', effect: 'deny' },
    ...(mode === 'loose-rules' ? [{ action: 'shell', resource: '*', effect: 'allow' }] : []),
  ] })) }); }
  if (p === '/api/permission/saved') return json({ data: saved });
  if (p.startsWith('/api/permission/saved/') && req.method === 'DELETE') { saved = saved.filter(s => s.id !== p.split('/').pop()); return new Response(null, { status: 204 }); }
  if (p === '/api/event') {
    const directory = url.searchParams.get('directory') || ''; let entry: any;
    return new Response(new ReadableStream({ start(ctrl) {
      entry = { directory, send: (text: string) => { try { ctrl.enqueue(new TextEncoder().encode(text)); } catch { streams.delete(entry); } } }; streams.add(entry);
      entry.send(`data: ${JSON.stringify({ id: 'evt_0', type: 'server.connected', data: {} })}\n\n`);
    }, cancel() { streams.delete(entry); } }), { headers: { 'content-type': 'text/event-stream' } });
  }
  if (p === '/api/session' && req.method === 'GET') return json({ data: [...sessions.values()].filter(s => s.location.directory === url.searchParams.get('directory')) });
  if (p === '/api/session' && req.method === 'POST') {
    const id = 'ses_fake' + ++next; const info = { id, title: body.title || 'New session', agent: body.agent, model: body.model, location: body.location, time: { created: Date.now() } };
    sessions.set(id, info); return json({ data: info });
  }
  const m = /^\/api\/session\/([^/]+)(?:\/(.+))?$/.exec(p);
  if (m) {
    const [, id, rest] = m; if (!sessions.has(id)) return json({ _tag: 'SessionNotFound', message: 'Session not found' }, 404);
    if (!rest && req.method === 'GET') return json({ data: sessions.get(id) });
    if (rest === 'context') return json({ data: (prompts.get(id) || []).map((text, i) => ({ id: `msg_${id}_${i}`, type: 'user', text })) });
    if (rest === 'prompt') { prompts.set(id, [...(prompts.get(id) || []), body.text]); broadcast({ type: 'session.execution.started', data: { sessionID: id } }, folderOf(id)); return json({ data: { id: 'msg_' + ++next } }); }
    if (rest === 'interrupt') { broadcast({ type: 'session.execution.interrupted', data: { sessionID: id } }, folderOf(id)); return json({ data: { interrupted: true } }); }
    if (rest === 'agent') { sessions.get(id).agent = body.agent; return new Response(null, { status: 204 }); }
    if (rest === 'model') { sessions.get(id).model = body.model; return new Response(null, { status: 204 }); }
    const reply = /^permission\/([^/]+)\/reply$/.exec(rest || '');
    if (reply) { broadcast({ type: 'permission.replied', data: { sessionID: id, requestID: reply[1], reply: body.decision } }, folderOf(id)); return new Response(null, { status: 204 }); }
  }
  if (p === '/test/emit') { broadcast(body.event, body.directory || folderOf(body.event?.data?.sessionID)); return json({ ok: true }); }
  if (p === '/test/calls') return json(calls);
  return new Response('not found', { status: 404 });
} });
function crashSoon() { const crash = process.env.FAKE_OPENCODE_CRASH_FILE; if (crash && existsSync(crash)) { rmSync(crash); setTimeout(() => process.exit(3), 300); } }
