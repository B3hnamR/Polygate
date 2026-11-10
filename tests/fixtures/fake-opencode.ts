// Stands in for `opencode serve` (the pinned version) in tests/agent-engine.test.ts and tests/agent.test.ts: the endpoints the engine manager and the
// agent controller use, answered from the configuration Polygate wrote. FAKE_OPENCODE_MODE makes it misbehave the way a real engine could;
// a file named by FAKE_OPENCODE_CRASH_FILE makes it exit once it has answered the self-test (once: the file is removed), so a slow machine
// cannot turn the crash into a failed start. FAKE_OPENCODE_SAVED=1 starts it with one saved permission, the kind OpenCode's "always" leaves.
// Like the real engine, answers are wrapped as {data: …} except /api/info and /api/config. Three routes exist for tests only: POST /test/session
// sets what a session's diff, staged undo and undo are. Like the real engine, staging an undo already writes the files (the given
// contents) and clearing the stage puts them back; committing keeps them; POST /test/emit sends an event to the folder's event streams, GET /test/calls lists what it was asked.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
// It reports the version Polygate pins, as the real engine of that version would.
import { ENGINE_VERSION } from '../../backend/agent-engine';
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
const active=new Set<string>(),permissions=new Map<string,any>(),forms=new Map<string,any>();
const scripted = new Map<string, { diff?: any[]; stage?: any[]; revert?: { file: string; content: string | null }[]; commitFails?: boolean; commitLost?:boolean; messages?: any[]; context?: any[]; inbox?: any[]; historyDelay?: number }>();
const staged = new Map<string, { file: string; content: string | null }[]>();
let saved = process.env.FAKE_OPENCODE_SAVED === '1' ? [{ id: 'psv_planted', projectID: 'p', action: 'shell', resource: 'node *' }] : [];
const streams = new Set<{ directory: string; send: (text: string, split?: boolean) => void; close: () => void }>();
// split: the event goes out in two chunks cut inside its first multi-byte character, as a real stream can deliver it.
const broadcast = (event: any, directory: string, split = false) => {
 const d=event.data||{};
 if(event.type==='session.execution.started')active.add(d.sessionID);
 if(/^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type))active.delete(d.sessionID);
 if(event.type==='permission.asked')permissions.set(d.id,d);
 if(event.type==='permission.replied')permissions.delete(d.requestID);
 if(event.type==='form.created')forms.set(d.form.id,d.form);
 if(event.type==='form.replied'||event.type==='form.cancelled')forms.delete(d.id);
 for (const s of streams) if (s.directory === directory) s.send(`data: ${JSON.stringify({ id: 'evt_' + ++next, created: Date.now(), location: { directory }, ...event })}\n\n`, split); };
const folderOf = (id: string) => sessions.get(id)?.location?.directory || '';
// Like the real engine: its own skills, then <dir>/<id>/SKILL.md in each configured skills folder, read as they are on disk now.
const skills = () => [
  { id: 'opencode', name: 'OpenCode', description: 'Questions about OpenCode itself.', path: 'skill://opencode/SKILL.md', content: 'About OpenCode.' },
  { id: 'browser', name: 'Browser', description: 'Browse pages.', path: 'skill://browser/SKILL.md', content: 'About browsing.' },
  ...(mode === 'foreign-skill' ? [{ id: 'planted', name: 'Planted', description: 'From elsewhere', path: 'C:\\work\\cloned-repo\\.opencode\\skills\\planted\\SKILL.md', content: 'x' }] : []),
  ...(config.skills || []).flatMap((dir: string) => { try { return readdirSync(dir); } catch { return []; } }).flatMap((id: string) => {
    const file = path.join(config.skills[0], id, 'SKILL.md'); if (!existsSync(file)) return [];
    const m = readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/); if (!m) return [];
    const head = Object.fromEntries(m[1].split('\n').map(l => l.split(/:\s(.*)/s)).map(([k, v]) => [k, v === 'true' ? true : JSON.parse(v)]));
    return [{ id, name: head.name, description: head.description, ...(head['disable-model-invocation'] ? { autoinvoke: false } : {}), path: file, content: m[2] }];
  }),
];
Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 0, async fetch(req) {
  if (!process.env.OPENCODE_PASSWORD || req.headers.get('authorization') !== expected) return new Response('unauthorized', { status: 401 });
  const url = new URL(req.url); const p = url.pathname; const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await req.json().catch(() => undefined);
  if (p.startsWith('/api/') && !['/api/info', '/api/config', '/api/model', '/api/agent'].includes(p)) calls.push({ method: req.method, path: p, body });
  if (p === '/api/info') return json({ version: mode === 'old-version' ? '1.19.5' : ENGINE_VERSION, pid: process.pid });
  if (p === '/api/config') return json([
    { type: 'document', path: path.join(configDir, 'opencode.json'), info: config }, { type: 'directory', path: configDir },
    ...(mode === 'project-config' ? [{ type: 'document', path: 'C:\\work\\cloned-repo\\opencode.json', info: {} }] : []),
  ]);
  // Like the real engine, a configuration written again while it runs is read again: the model list follows the file.
  if (p === '/api/model') { const live = JSON.parse(readFileSync(path.join(configDir, 'opencode.json'), 'utf8')).providers.polygate.models; return json({ data: [
    ...Object.keys(live).map(id => ({ id, providerID: 'polygate', limit: live[id].limit })),
    ...(mode === 'other-provider' ? [{ id: 'm', providerID: 'evil' }] : []),
  ] }); }
  // Like OpenCode 2.x: built-in rules, the shared configured ones, the agent's own, then a closing browser rule.
  if (p === '/api/agent') { crashSoon(); return json({ data: ['build', ...Object.keys(config.agents || {})].filter(id => !(mode === 'missing-agent' && id === 'polygate-plan')).map(id => ({ id, permissions: [
    { action: '*', resource: '*', effect: 'allow' }, ...config.permissions, ...(id === 'build' ? [] : config.agents[id].permissions), { action: 'browser', resource: '*', effect: 'deny' },
    ...(mode === 'loose-rules' ? [{ action: 'shell', resource: '*', effect: 'allow' }] : []),
  ] })) }); }
  if (p === '/api/permission/saved') return json({ data: saved });
  if (p.startsWith('/api/permission/saved/') && req.method === 'DELETE') { saved = saved.filter(s => s.id !== p.split('/').pop()); return new Response(null, { status: 204 }); }
  if (p === '/api/event') {
    const directory = url.searchParams.get('directory') || ''; let entry: any;
    return new Response(new ReadableStream({ start(ctrl) {
      entry = { directory, close: () => { try { ctrl.close(); } catch {} streams.delete(entry); }, send: (text: string, split = false) => { try {
        const bytes = new TextEncoder().encode(text), cut = split ? bytes.findIndex(b => b >= 0x80) + 1 : 0;
        if (cut > 0) { ctrl.enqueue(bytes.slice(0, cut)); setTimeout(() => { try { ctrl.enqueue(bytes.slice(cut)); } catch { streams.delete(entry); } }, 30); } else ctrl.enqueue(bytes);
      } catch { streams.delete(entry); } } }; streams.add(entry);
      entry.send(`data: ${JSON.stringify({ id: 'evt_0', type: 'server.connected', data: {} })}\n\n`);
    }, cancel() { streams.delete(entry); } }), { headers: { 'content-type': 'text/event-stream' } });
  }
  if(p==='/api/session/active')return json({data:Object.fromEntries([...active].map(id=>[id,{type:'running'}]))});
  if (p === '/api/session' && req.method === 'GET') return json({ data: [...sessions.values()].filter(s => s.location.directory === url.searchParams.get('directory')&&(!url.searchParams.has('parentID')||s.parentID===url.searchParams.get('parentID'))) });
  if (p === '/api/session' && req.method === 'POST') {
    const id = (process.env.FAKE_OPENCODE_SESSION_PREFIX || 'ses_fake') + ++next; const info = { id, parentID:body.parentID, title: body.title || 'New session', agent: body.agent, model: body.model, location: body.location, time: { created: Date.now() } };
    sessions.set(id, info); return json({ data: info });
  }
  if (p === '/api/skill') return json({ location: {}, data: skills() });
  if(/^\/api\/experimental\/session\/[^/]+\/instructions\/entries\/polygate-(project|global)$/.test(p))return new Response(null,{status:204});
  const m = /^\/api\/session\/([^/]+)(?:\/(.+))?$/.exec(p);
  if (m) {
    const [, id, rest] = m; if (!sessions.has(id)) return json({ _tag: 'SessionNotFound', message: 'Session not found' }, 404);
    if (!rest && req.method === 'GET') return json({ data: sessions.get(id) });
    if (!rest && req.method === 'PATCH') { Object.assign(sessions.get(id), { title: body.title }); return json({ data: sessions.get(id) }); }
    if (!rest && req.method === 'DELETE') { sessions.delete(id); prompts.delete(id); return new Response(null, { status: 204 }); }
    if(rest==='permission')return json({data:[...permissions.values()].filter(p=>p.sessionID===id)});
    if(rest==='form'&&req.method==='GET')return json({data:[...forms.values()].filter(f=>f.sessionID===id)});
    if(rest?.startsWith('form/')){const fid=rest.split('/')[1],form=forms.get(fid);if(!form||form.sessionID!==id)return json({error:'form gone'},404);broadcast({type:req.method==='DELETE'?'form.cancelled':'form.replied',data:{sessionID:id,id:fid,answer:body?.answer}},folderOf(id));return new Response(null,{status:204});}
    if (rest === 'diff') return json({ data: scripted.get(id)?.diff || [] });
    if (rest === 'revert/stage') {
      sessions.get(id).revert={messageID:body.messageID};
      const kept: { file: string; content: string | null }[] = [];
      for (const f of body.files === false ? [] : scripted.get(id)?.revert || []) {
        const file = path.join(folderOf(id), f.file); kept.push({ file, content: existsSync(file) ? readFileSync(file, 'utf8') : null });
        if (f.content === null) rmSync(file, { force: true }); else { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, f.content); }
      }
      staged.set(id, kept);
      return json({ data: { messageID: body.messageID, snapshot: 'snap', files: scripted.get(id)?.stage || [] } });
    }
    if (rest === 'revert' && req.method === 'DELETE') { for (const k of staged.get(id) || []) { if (k.content === null) rmSync(k.file, { force: true }); else writeFileSync(k.file, k.content); } staged.delete(id);delete sessions.get(id).revert; return new Response(null, { status: 204 }); }
    if (rest === 'revert/commit') { if (scripted.get(id)?.commitFails) return json({ error: 'commit failed' }, 500); staged.delete(id);if(scripted.get(id)?.commitLost){const boundary=sessions.get(id).revert?.messageID;const script=scripted.get(id)!;const all=script.messages||[];script.messages=all.slice(0,all.findIndex(m=>m.id===boundary)+1);delete sessions.get(id).revert;return json({error:'response lost after commit'},502);}delete sessions.get(id).revert; return new Response(null, { status: 204 }); }
    const messages = () => scripted.get(id)?.messages || (prompts.get(id) || []).map((text, i) => ({ id: `msg_${id}_${i}`, type: 'user', text }));
    if (rest === 'context') return json({ data: scripted.get(id)?.context || messages() });
    if (rest === 'message') {
      const all = messages(), start = Number(url.searchParams.get('cursor') || 0), limit = Number(url.searchParams.get('limit') || 20);
      const page = { data: all.slice(start, start + limit), cursor: start + limit < all.length ? { next: String(start + limit) } : {} };
      if (scripted.get(id)?.historyDelay) await Bun.sleep(scripted.get(id)!.historyDelay!);
      return json(page);
    }
    if (rest === 'prompt' && (body.skills || []).some((k: any) => !skills().some(x => x.id === k.id && x.name === k.name))) return json({ _tag: 'InvalidRequestError', message: 'Skill not found', field: 'skills' }, 400);
    if (rest === 'prompt') { prompts.set(id, [...(prompts.get(id) || []), body.text]); broadcast({ type: 'session.execution.started', data: { sessionID: id } }, folderOf(id)); return json({ data: { id: 'msg_' + ++next } }); }
    // The inbox: messages not handed to the agent yet (scripted per session), taken back or switched to steer.
    if (rest === 'inbox') return json({ data: scripted.get(id)?.inbox || [] });
    const pendingInput = /^inbox\/([^/]+)$/.exec(rest || '');
    if (pendingInput && req.method === 'DELETE') { broadcast({ type: 'session.inbox.cancelled', data: { sessionID: id, inboxID: pendingInput[1] } }, folderOf(id)); return new Response(null, { status: 204 }); }
    if (pendingInput && req.method === 'PATCH') { broadcast({ type: 'session.inbox.delivery.changed', data: { sessionID: id, inboxID: pendingInput[1], delivery: body.delivery } }, folderOf(id)); return new Response(null, { status: 204 }); }
    if (rest === 'interrupt') { broadcast({ type: 'session.execution.interrupted', data: { sessionID: id } }, folderOf(id)); return json({ data: { interrupted: true } }); }
    if (rest === 'agent') { sessions.get(id).agent = body.agent; return new Response(null, { status: 204 }); }
    if (rest === 'model') { sessions.get(id).model = body.model; return new Response(null, { status: 204 }); }
    const reply = /^permission\/([^/]+)\/reply$/.exec(rest || '');
    if (reply) { broadcast({ type: 'permission.replied', data: { sessionID: id, requestID: reply[1], reply: body.decision } }, folderOf(id)); return new Response(null, { status: 204 }); }
  }
  if (p === '/test/emit') { broadcast(body.event, body.directory || folderOf(body.event?.data?.sessionID), body.split === true); return json({ ok: true }); }
  if (p === '/test/calls') return json(calls);
  if (p === '/test/disconnect-events') { for (const stream of [...streams]) stream.close(); return json({ ok: true }); }
  if(p==='/test/idle'){for(const id of [...active])broadcast({type:'session.execution.interrupted',data:{sessionID:id}},folderOf(id));return json({ok:true});}
  if (p === '/test/session') { scripted.set(body.sessionID, { ...scripted.get(body.sessionID), ...body }); return json({ ok: true }); }
  return new Response('not found', { status: 404 });
} });
function crashSoon() { const crash = process.env.FAKE_OPENCODE_CRASH_FILE; if (crash && existsSync(crash)) { rmSync(crash); setTimeout(() => process.exit(3), 300); } }
