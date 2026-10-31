import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { models, settings, stateDir } from './state';
import { GatewayError } from './queue';
import { logEvent } from './logbook';
import { ENGINE_MODES, engineConnection, enginePaths, freeIdentityProblem } from './agent-engine';
import { presentedOpenCodeVersion } from './providers';
// The agent controller (docs/agent/PLAN.md, Phase 2a): the only part of Polygate that talks to the agent's engine. The Agent page uses it
// through the desktop-only admin API (admin.ts); the engine's password never reaches the page. It keeps one event stream per working
// folder open to the engine (opened again after an engine restart), hands each session's events to the page, and answers approvals:
// once, for this session (remembered here, for the exact request), or deny. OpenCode's own "always" is never used: in 2.0.32 it saves a
// permanent rule for the whole project with a broad pattern (`shell: node *` from approving one `node -e …`).

const MAX_RETRIES = 3;
type Mode = keyof typeof ENGINE_MODES;
type Pending = { id: string; action: string; resources: string[]; note: string };
type Session = { id: string; folder: string; allowed: Set<string>; pending: Map<string, Pending>; retries: number; paused?: string };
const sessions = new Map<string, Session>();
const listeners = new Map<string, Set<ServerResponse>>();
const folders = new Map<string, { abort: AbortController; ready: Promise<void> }>();

// --- Engine calls ---
async function engine(method: string, route: string, body?: unknown): Promise<any> {
  const c = engineConnection(); if (!c) throw new GatewayError('Start the agent engine first.', 409, 'agent_engine_not_running');
  const r = await fetch(c.url + route, { method, headers: { authorization: c.auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (r.status === 404 && route.startsWith('/api/session/')) throw new GatewayError('The agent has no such session.', 404, 'agent_session_not_found');
  if (!r.ok) throw new GatewayError(`The agent engine answered ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`, 502, 'agent_engine_error');
  // OpenCode 2.x wraps its answers as {data: …} (a list also carries a cursor); callers get what is inside.
  const answer: any = r.status === 204 ? undefined : await r.json().catch(() => undefined);
  return answer && typeof answer === 'object' && !Array.isArray(answer) && 'data' in answer ? answer.data : answer;
}
const q = (folder: string) => `?directory=${encodeURIComponent(folder)}`;
const reply = (sid: string, request: string, decision: 'once' | 'reject', message?: string) =>
  engine('POST', `/api/session/${encodeURIComponent(sid)}/permission/${encodeURIComponent(request)}/reply`, message ? { decision, message } : { decision });

// --- Events from the engine ---
// One stream per working folder: the engine sends a folder's events only to a stream opened for that folder.
function watchFolder(folder: string) {
  const known = folders.get(folder); if (known) return known.ready;
  const abort = new AbortController(); let opened!: () => void; const ready = new Promise<void>(r => (opened = r));
  folders.set(folder, { abort, ready });
  (async () => {
    while (!abort.signal.aborted) {
      const c = engineConnection();
      if (!c) { await Bun.sleep(1000); continue; }
      try {
        const r = await fetch(`${c.url}/api/event${q(folder)}`, { headers: { authorization: c.auth }, signal: abort.signal });
        if (!r.ok || !r.body) throw new Error(`events answered ${r.status}`);
        const reader = r.body.getReader(); let buf = '';
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += new TextDecoder().decode(value, { stream: true }); let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const lines = buf.slice(0, i).split('\n').filter(l => l.startsWith('data:')); buf = buf.slice(i + 2);
            if (!lines.length) continue; opened();
            try { onEvent(JSON.parse(lines.map(l => l.slice(5).trimStart()).join('\n')), folder); } catch { /* one bad event is skipped */ }
          }
        }
      } catch { /* the engine stopped or restarted: open the stream again once it is back */ }
      if (!abort.signal.aborted) await Bun.sleep(500);
    }
  })();
  return Promise.race([ready, Bun.sleep(5000)]);
}
function session(id: string, folder = '') {
  let s = sessions.get(id);
  if (!s) { s = { id, folder, allowed: new Set(), pending: new Map(), retries: 0 }; sessions.set(id, s); }
  if (folder && !s.folder) s.folder = folder;
  return s;
}
const keyOf = (action: string, resources: string[]) => `${action}\n${resources.join('\n')}`;
// The consent note on an approval card (docs/agent/PERMISSIONS.md): approving a command lets it run with the user's own access, and a
// command that runs the project's own code (tests, scripts, installs) runs whatever that code does.
const PROJECT_CODE = /\b(npm|pnpm|yarn|bunx?|npx|node|deno|tsx|ts-node|python3?|py|pip3?|pytest|jest|vitest|mocha|make|cmake|cargo|go|dotnet|gradlew?|mvn|php|composer|ruby|bundle|rake|java)\b|(^|[\s;&|(])\.{1,2}[\\/]/i;
export function noteFor(action: string, resources: string[]) {
  if (action === 'shell') return resources.some(r => PROJECT_CODE.test(r)) ? 'This runs the project\'s code with your account\'s access: whatever its scripts do, they can do as you.' : 'This command runs with your account\'s access.';
  if (action === 'external_directory') return 'This is outside the working folder.';
  if (action === 'webfetch' || action === 'websearch') return 'This goes to the internet.';
  return '';
}
function publish(sid: string, event: unknown) {
  const text = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of listeners.get(sid) || []) { try { res.write(text); } catch { /* the page went away; its close handler removes it */ } }
}
function onEvent(e: any, folder: string) {
  const d = e?.data || {}; const sid = d.sessionID; if (!sid || e.type === 'server.heartbeat') return;
  const s = session(sid, folder);
  if (e.type === 'permission.asked') {
    const resources = Array.isArray(d.resources) ? d.resources.map(String) : []; const key = keyOf(d.action, resources);
    if (s.allowed.has(key)) {
      reply(sid, d.id, 'once').catch(err => logEvent('warn', 'agent', `An approval for this session could not be applied: ${err?.message || err}`));
      publish(sid, { type: 'agent.approval.auto', data: { sessionID: sid, requestID: d.id, action: d.action, resources } }); return;
    }
    const pending = { id: String(d.id), action: String(d.action), resources, note: noteFor(d.action, resources) };
    s.pending.set(pending.id, pending);
    // OpenCode's suggested permanent rule (`save`) is not passed on: the page never offers it.
    const { save, ...rest } = d; publish(sid, { ...e, data: { ...rest, resources, note: pending.note } }); return;
  }
  if (e.type === 'permission.replied') s.pending.delete(String(d.requestID));
  if (e.type === 'session.execution.started') { s.retries = 0; s.paused = undefined; }
  publish(sid, e);
  // The engine retries a failing model request for a long time on its own; after a few tries the turn is stopped and the page told why,
  // so the user can wait, resume or pick another model. A tool action that already ran is never repeated by this.
  if (e.type === 'session.retry.scheduled' && ++s.retries >= MAX_RETRIES && !s.paused) {
    s.paused = String(d.error?.message || 'The model kept failing.');
    engine('POST', `/api/session/${encodeURIComponent(sid)}/interrupt`).catch(() => {});
    publish(sid, { type: 'agent.paused', data: { sessionID: sid, message: s.paused, status: d.error?.status } });
    logEvent('warn', 'agent', `Agent session paused after ${s.retries} failed model requests: ${s.paused}`);
  }
}

// --- What the page asks for ---
// Models the agent can be pinned to: able to call tools, from an enabled provider, not known to be gone. OpenCode Free only while the
// bridge presents the engine's own OpenCode version (agent-engine.ts).
export function agentModels() {
  const presented = presentedOpenCodeVersion();
  return [...models.values()].filter(m => m.tools && m.state !== 'unavailable').flatMap(m => {
    const p = settings.providers.find(x => x.id === m.providerId && x.enabled); if (!p) return [];
    const reason = p.kind === 'free' ? freeIdentityProblem(presented) : '';
    return [{ id: m.id, name: m.name, provider: p.name, context: m.context, output: m.output, reasoning: m.reasoning, usable: !reason, ...(reason ? { reason } : {}) }];
  }).sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
}
const inside = (folder: string, parent: string) => { const rel = path.relative(path.resolve(parent), path.resolve(folder)); return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel)); };
function checkFolder(raw: unknown) {
  const folder = String(raw || '').trim();
  if (!folder || !path.isAbsolute(folder)) throw new GatewayError('Choose the working folder by its full path.', 400, 'agent_folder');
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new GatewayError('That folder does not exist.', 400, 'agent_folder');
  const p = enginePaths();
  if ([stateDir, p.root, p.data].some(own => inside(folder, own) || inside(own, folder))) throw new GatewayError('That is Polygate\'s own folder, or holds it. Choose a project folder.', 400, 'agent_folder');
  return path.resolve(folder);
}
const checkMode = (raw: unknown): Mode => { if (typeof raw === 'string' && raw in ENGINE_MODES) return raw as Mode; throw new GatewayError(`Unknown mode. Use one of: ${Object.keys(ENGINE_MODES).join(', ')}.`, 400, 'agent_mode'); };
const modeOf = (agent: string) => (Object.entries(ENGINE_MODES).find(([, m]) => m.agent === agent)?.[0] || '') as Mode | '';
const summary = (s: any) => ({ id: s.id, title: s.title, mode: modeOf(s.agent || ''), model: s.model?.id || '', folder: s.location?.directory || '', created: s.time?.created, tokens: s.tokens, cost: s.cost, outcome: s.outcome });
// Rules OpenCode saved through "always" (never sent by Polygate) would allow commands without asking in every session of the project.
async function clearSavedPermissions() {
  const found = await engine('GET', '/api/permission/saved'); const saved: any[] = Array.isArray(found) ? found : [];
  for (const s of saved) await engine('DELETE', `/api/permission/saved/${encodeURIComponent(s.id)}`);
  if (saved.length) logEvent('warn', 'agent', `Removed ${saved.length} permission rule(s) saved in the agent engine (${saved.map(s => `${s.action}: ${s.resource}`).join(', ')}); Polygate asks every time unless a session allows it`);
}
async function createSession(b: any) {
  if (!engineConnection()) throw new GatewayError('Start the agent engine first.', 409, 'agent_engine_not_running');
  const folder = checkFolder(b.folder); const mode = checkMode(b.mode); const model = String(b.model || '');
  const list = await engine('GET', `/api/model${q(folder)}`); const known = (Array.isArray(list) ? list : []).some((m: any) => m.providerID === 'polygate' && m.id === model);
  if (!known) throw new GatewayError('The agent engine does not have that model. Pick one from the list, or start the engine again after the catalog changed.', 400, 'agent_model');
  const why = agentModels().find(m => m.id === model)?.reason; if (why) throw new GatewayError(why, 400, 'agent_model');
  await clearSavedPermissions();
  await watchFolder(folder);
  const title = String(b.title || '').trim().slice(0, 120) || `New session ${new Date().toLocaleString()}`;
  const info = await engine('POST', '/api/session', { title, agent: ENGINE_MODES[mode].agent, model: { providerID: 'polygate', id: model }, location: { directory: folder } });
  session(info.id, folder);
  return summary(info);
}
// A session this process has not seen yet (Polygate restarted): its folder comes from the engine.
async function known(id: unknown) {
  const sid = String(id || ''); if (!sid) throw new GatewayError('Which session?', 400);
  const s = sessions.get(sid); if (s?.folder) { await watchFolder(s.folder); return s; }
  const info = await engine('GET', `/api/session/${encodeURIComponent(sid)}`);
  const folder = info?.location?.directory || ''; const out = session(sid, folder); if (folder) await watchFolder(folder);
  return out;
}

export async function agentApi(req: IncomingMessage, res: ServerResponse, pathname: string, readJson: (req: IncomingMessage, max?: number) => Promise<any>, json: (res: ServerResponse, status: number, body: unknown) => void) {
  const method = req.method; const url = new URL(req.url || '/', 'http://x');
  if (pathname === '/admin/agent/models' && method === 'GET') return json(res, 200, { models: agentModels(), modes: Object.fromEntries(Object.entries(ENGINE_MODES).map(([k, m]) => [k, m.description])) });
  if (pathname === '/admin/agent/sessions' && method === 'GET') {
    const folder = checkFolder(url.searchParams.get('folder'));
    const list = await engine('GET', `/api/session${q(folder)}`);
    return json(res, 200, { sessions: (Array.isArray(list) ? list : []).map(summary).sort((a, b) => (b.created || 0) - (a.created || 0)) });
  }
  if (pathname === '/admin/agent/session/create' && method === 'POST') return json(res, 200, await createSession(await readJson(req)));
  if (pathname === '/admin/agent/session' && method === 'GET') {
    const s = await known(url.searchParams.get('id'));
    const [info, messages] = await Promise.all([engine('GET', `/api/session/${encodeURIComponent(s.id)}`), engine('GET', `/api/session/${encodeURIComponent(s.id)}/context`)]);
    return json(res, 200, { session: summary(info), messages: messages || [], pending: [...s.pending.values()], paused: s.paused || '' });
  }
  if (pathname === '/admin/agent/session/prompt' && method === 'POST') {
    const b = await readJson(req, 1024 * 1024); const s = await known(b.id); const text = String(b.text || '');
    if (!text.trim()) throw new GatewayError('Write a message first.', 400);
    s.retries = 0; s.paused = undefined;
    return json(res, 200, { ok: true, message: await engine('POST', `/api/session/${encodeURIComponent(s.id)}/prompt`, { text }) });
  }
  if (pathname === '/admin/agent/session/approve' && method === 'POST') {
    const b = await readJson(req); const s = await known(b.id); const decision = String(b.decision || '');
    if (!['once', 'session', 'deny'].includes(decision)) throw new GatewayError('Answer once, session or deny.', 400, 'agent_decision');
    const p = s.pending.get(String(b.request || '')); if (!p) throw new GatewayError('That request is no longer waiting for an answer.', 404, 'agent_request_gone');
    s.pending.delete(p.id);
    if (decision === 'deny') { await reply(s.id, p.id, 'reject', typeof b.message === 'string' ? b.message.slice(0, 2000) : undefined); return json(res, 200, { ok: true }); }
    await reply(s.id, p.id, 'once');
    if (decision === 'session') {
      // Allowed again in this session without asking, for exactly this action and target; other requests of the same kind waiting now go too.
      const key = keyOf(p.action, p.resources); s.allowed.add(key);
      for (const other of [...s.pending.values()]) if (keyOf(other.action, other.resources) === key) { s.pending.delete(other.id); await reply(s.id, other.id, 'once'); publish(s.id, { type: 'agent.approval.auto', data: { sessionID: s.id, requestID: other.id, action: other.action, resources: other.resources } }); }
    }
    return json(res, 200, { ok: true });
  }
  if (pathname === '/admin/agent/session/cancel' && method === 'POST') { const s = await known((await readJson(req)).id); await engine('POST', `/api/session/${encodeURIComponent(s.id)}/interrupt`); return json(res, 200, { ok: true }); }
  if (pathname === '/admin/agent/session/mode' && method === 'POST') {
    const b = await readJson(req); const mode = checkMode(b.mode); const s = await known(b.id);
    await engine('POST', `/api/session/${encodeURIComponent(s.id)}/agent`, { agent: ENGINE_MODES[mode].agent }); return json(res, 200, { ok: true, mode });
  }
  if (pathname === '/admin/agent/events' && method === 'GET') {
    const s = await known(url.searchParams.get('id'));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    // What the page needs after it (re)connects: approvals still waiting and whether the session is paused.
    res.write(`data: ${JSON.stringify({ type: 'agent.state', data: { sessionID: s.id, pending: [...s.pending.values()], paused: s.paused || '' } })}\n\n`);
    const set = listeners.get(s.id) || new Set(); set.add(res); listeners.set(s.id, set);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15000);
    req.on('close', () => { clearInterval(ping); set.delete(res); if (!set.size) listeners.delete(s.id); });
    return;
  }
  throw new GatewayError('Admin endpoint not found', 404);
}
// Called when the gateway stops: the folder streams end with it.
export function stopAgent() { for (const f of folders.values()) f.abort.abort(); folders.clear(); }
