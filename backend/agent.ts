import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { models, sessionUsage, settings, stateDir, writeFileAtomic } from './state';
import { GatewayError } from './queue';
import { logEvent } from './logbook';
import { ENGINE_MODES, engineConnection, enginePaths, freeIdentityProblem } from './agent-engine';
import { presentedOpenCodeVersion } from './providers';
import { backupBytes, beforeFile, byteDiff, captureBackup, filePath, restoreFile, saveBytes, type Backup, type FileBackup } from './agent-backup';
import { inspectionCommands, permissionDecision, projectRules, removeProjectRule, saveProjectRule } from './agent-permissions';
// The agent controller (docs/agent/PLAN.md, Phase 2a): the only part of Polygate that talks to the agent's engine. The Agent page uses it
// through the desktop-only admin API (admin.ts); the engine's password never reaches the page. It keeps one event stream per working
// folder open to the engine (opened again after an engine restart), hands each session's events to the page, and answers approvals:
// once, for this session (remembered here, for the exact request), or deny. OpenCode's own "always" is never used: in 2.0.32 it saves a
// permanent rule for the whole project with a broad pattern (`shell: node *` from approving one `node -e …`).

const MAX_RETRIES = 3;
type Mode = keyof typeof ENGINE_MODES;
type Pending = { id: string; action: string; resources: string[]; note: string };
type Session = { id: string; folder: string; allowed: Set<string>; pending: Map<string, Pending>; retries: number; paused?: string; busy?: boolean; stepFiles: Set<string>; turns?: Turn[]; backup?: Backup; recording?: Promise<void>; undoing?: boolean; sending?: boolean; mode?: Mode; fullUntil?: number; fullEngine?: string; fullTimer?: ReturnType<typeof setTimeout> };
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
  if (!s) {
    s = { id, folder, allowed: new Set(), pending: new Map(), retries: 0, stepFiles: new Set() };
    try { s.backup = JSON.parse(readFileSync(pendingFile(id), 'utf8')); } catch {}
    sessions.set(id, s);
  }
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
    const full = s.mode === 'full' && !!s.fullUntil && s.fullUntil > Date.now() && s.fullEngine === engineConnection()?.url;
    if (s.mode === 'full' && !full) { expireFull(s); }
    let decision: 'allow' | 'deny' | 'ask' = 'ask';
    try { decision = permissionDecision(full ? 'full' : s.mode || 'ask', d.action, resources, projectRules(s.folder)); }
    catch (err: any) { s.paused = err.message; engine('POST', `/api/session/${enc(s.id)}/interrupt`).catch(() => {}); publish(sid, { type: 'agent.paused', data: { sessionID: sid, message: s.paused } }); reply(sid, d.id, 'reject').catch(() => {}); return; }
    if (decision === 'deny') {
      reply(sid, d.id, 'reject', 'Blocked by the current permission mode or a saved project rule.').catch(err => logEvent('warn', 'agent', String(err)));
      publish(sid, { type: 'agent.approval.blocked', data: { sessionID: sid, requestID: d.id, action: d.action, resources } }); return;
    }
    if (decision === 'allow' || s.allowed.has(key)) {
      reply(sid, d.id, 'once').catch(err => logEvent('warn', 'agent', `An approval for this session could not be applied: ${err?.message || err}`));
      publish(sid, { type: 'agent.approval.auto', data: { sessionID: sid, requestID: d.id, action: d.action, resources, reason: full ? 'Full access' : decision === 'allow' ? 'Permission rule' : 'Allowed for this session' } }); return;
    }
    const pending = { id: String(d.id), action: String(d.action), resources, note: noteFor(d.action, resources) };
    s.pending.set(pending.id, pending);
    // OpenCode's suggested permanent rule (`save`) is not passed on: the page never offers it.
    const { save, ...rest } = d; publish(sid, { ...e, data: { ...rest, resources, note: pending.note } }); return;
  }
  if (e.type === 'permission.replied') s.pending.delete(String(d.requestID));
  if (e.type === 'session.execution.started') { s.retries = 0; s.paused = undefined; s.busy = true; }
  if (e.type === 'session.step.ended' && Array.isArray(d.files)) for (const f of d.files) if (typeof f === 'string' && f) s.stepFiles.add(f);
  if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(e.type)) {
    s.busy = false;
    s.pending.clear();
    if (s.mode === 'full') expireFull(s);
    s.recording = recordTurn(s).catch(err => logEvent('warn', 'agent', `What the agent changed in this turn could not be recorded, so it cannot be undone from Polygate: ${err?.message || err}`));
  }
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

function expireFull(s: Session) {
  if (s.fullTimer) clearTimeout(s.fullTimer);
  s.fullTimer = undefined; s.fullUntil = undefined; s.fullEngine = undefined; s.mode = 'ask'; s.allowed.clear();
  engine('POST', `/api/session/${enc(s.id)}/agent`, { agent: ENGINE_MODES.ask.agent }).catch(err => logEvent('warn', 'agent', `Full access expired; resetting the engine agent failed: ${err?.message || err}`));
  publish(s.id, { type: 'agent.mode', data: { sessionID: s.id, mode: 'ask', fullUntil: 0, reason: 'Full access ended. Ask for approval is active.' } });
}

// --- Changes and undo ---
// What each turn changed, kept per session in the agent's folder so it outlives a restart: the files the engine's steps reported, the
// exact pre-turn bytes and a hash of every changed file as the agent left it. Undo checks those hashes before writing; engine snapshots
// are not used for restoration because their Git index can normalize working-tree content.
type FileChange = { file: string; status: string; additions: number; deletions: number; patch: string; after: string | null; before?: FileBackup };
type Turn = { message: string; at: number; files: FileChange[] };
const enc = encodeURIComponent;
const turnsFile = (sid: string) => path.join(enginePaths().root, 'turns', `${sid.replace(/[^A-Za-z0-9_-]/g, '')}.json`);
const pendingFile = (sid: string) => turnsFile(sid) + '.pending';
function loadTurns(s: Session): Turn[] { if (!s.turns) { try { const v = JSON.parse(readFileSync(turnsFile(s.id), 'utf8')); s.turns = Array.isArray(v) ? v : []; } catch { s.turns = []; } } return s.turns!; }
function saveTurns(s: Session) { mkdirSync(path.dirname(turnsFile(s.id)), { recursive: true }); writeFileAtomic(turnsFile(s.id), JSON.stringify(s.turns || [])); }
const hashOf = (folder: string, rel: string) => { try { return createHash('sha256').update(readFileSync(path.join(folder, rel))).digest('hex'); } catch { return null; } };
const publicTurn = (t: Turn) => ({ message: t.message, at: t.at, files: t.files.map(({ after, before, ...f }) => f) });
// The engine's diff route answers for the latest turn that changed something, so a turn that changed nothing could be handed the previous
// turn's files: which files a turn changed comes from its own steps, and only the patches from the diff.
async function recordTurn(s: Session) {
  const changed = [...s.stepFiles]; s.stepFiles.clear();
  const backup = s.backup;
  s.backup = undefined;
  try { unlinkSync(pendingFile(s.id)); } catch {}
  if (!changed.length) return;
  const [diff, ctx] = await Promise.all([engine('GET', `/api/session/${enc(s.id)}/diff`), engine('GET', `/api/session/${enc(s.id)}/context`)]);
  const message = [...(Array.isArray(ctx) ? ctx : [])].reverse().find((m: any) => m?.type === 'user')?.id; if (!message) return;
  const byFile = new Map<string, any>((Array.isArray(diff) ? diff : []).filter((f: any) => f?.file).map((f: any) => [String(f.file), f]));
  const files: FileChange[] = changed.map(file => {
    const f = byFile.get(file) || {}, before = beforeFile(backup, file);
    const after = hashOf(s.folder, file);
    let patch = { additions: Number(f.additions) || 0, deletions: Number(f.deletions) || 0, patch: String(f.patch || '').slice(0, 200000) };
    if (before !== undefined) {
      try { patch = byteDiff(file, before === null ? Buffer.alloc(0) : backupBytes(before), after === null ? Buffer.alloc(0) : readFileSync(filePath(s.folder, file))); }
      catch { return { file, status: String(f.status || 'modified'), ...patch, after }; }
    }
    return { file, status: before === null ? 'added' : before !== undefined && after === null ? 'deleted' : String(f.status || 'modified'), ...patch, after, ...(before !== undefined ? { before } : {}) };
  });
  const turns = loadTurns(s); const known = turns.find(t => t.message === message);
  // A message can take more than one run (sent again after a pause): its record keeps every file, with the newest state of each.
  const turn = known ? Object.assign(known, { at: Date.now(), files: [...known.files.filter(f => !files.some(n => n.file === f.file)), ...files.map(f => { const old = known.files.find(x => x.file === f.file); return old ? { ...f, before: old.before } : f; })] }) : { message, at: Date.now(), files };
  if (!known) turns.push(turn);
  saveTurns(s); publish(s.id, { type: 'agent.changes', data: { sessionID: s.id, turn: publicTurn(turn) } });
}
async function undoTurn(s: Session, message: string) {
  if (s.busy || s.undoing || s.sending) throw new GatewayError('The agent is working. Stop it or wait until it is done, then undo.', 409, 'agent_busy');
  s.undoing = true;
  try {
  await s.recording;
  const turns = loadTurns(s); const from = turns.findIndex(t => t.message === message);
  if (from < 0) throw new GatewayError('Polygate has no recorded changes for that turn.', 404, 'agent_undo_unknown');
  const latest = new Map<string, string | null>(); for (const t of turns) for (const f of t.files) latest.set(f.file, f.after);
  const target = new Map<string, FileBackup | undefined>();
  for (const t of turns.slice(from)) for (const f of t.files) if (!target.has(f.file)) target.set(f.file, f.before);
  const files = [...target.keys()];
  const between = new Set<string>(), previous = new Map<string, string | null>();
  for (const t of turns.slice(from)) for (const f of t.files) {
    if (previous.has(f.file) && f.before !== undefined && previous.get(f.file) !== (f.before?.hash ?? null)) between.add(f.file);
    previous.set(f.file, f.after);
  }
  const conflicts = files.flatMap(file => target.get(file) === undefined ? [{ file, reason: 'No exact backup exists for this file. Older turns cannot be safely undone.' }]
    : between.has(file) ? [{ file, reason: 'It changed between agent turns. Undoing the earlier turn would also remove that change.' }]
    : hashOf(s.folder, file) !== latest.get(file) ? [{ file, reason: 'It changed after the agent last changed it.' }] : []);
  if (conflicts.length) return { conflicts };
  // Resolve every backup and validate every path before changing either history or files.
  const restore = new Map(files.map(file => { filePath(s.folder, file); const saved = target.get(file)!; return [file, saved === null ? undefined : backupBytes(saved)] as const; }));
  const rollback = new Map(files.map(file => { const full = filePath(s.folder, file); return [file, existsSync(full) ? { hash: saveBytes(readFileSync(full)), mode: statSync(full).mode & 0o777 } : null] as const; }));
  try {
    // Stage history only. OpenCode's file snapshots can contain normalized rather than actual bytes.
    await engine('POST', `/api/session/${enc(s.id)}/revert/stage`, { messageID: message, files: false });
    for (const file of files) {
      if (hashOf(s.folder, file) !== latest.get(file)) throw new GatewayError('A file changed while undo was starting. Nothing was committed.', 409, 'agent_undo_conflict');
    }
    const written: string[] = [];
    try {
      for (const file of files) { written.push(file); restoreFile(s.folder, file, target.get(file)!, restore.get(file)); }
      for (const file of files) if (hashOf(s.folder, file) !== (target.get(file)?.hash ?? null)) throw new Error('The restored file failed verification.');
      await engine('POST', `/api/session/${enc(s.id)}/revert/commit`);
    } catch (err) {
      for (const file of written.reverse()) restoreFile(s.folder, file, rollback.get(file)!);
      throw err;
    }
  } catch (err) { await engine('DELETE', `/api/session/${enc(s.id)}/revert`).catch(() => {}); throw err; }
  s.turns = turns.slice(0, from); saveTurns(s);
  publish(s.id, { type: 'agent.undone', data: { sessionID: s.id, message, files } });
  logEvent('info', 'agent', `Agent turn undone: ${files.length} file(s) restored`);
  return { files };
  } finally { s.undoing = false; }
}

// --- What the page asks for ---
// Reasoning effort, offered for models that reason: OpenCode names these variants of the model (its default when none is chosen).
const EFFORTS = ['low', 'medium', 'high'];
// Models the agent can be pinned to: able to call tools, from an enabled provider, not known to be gone. OpenCode Free only while the
// bridge presents the engine's own OpenCode version (agent-engine.ts).
export function agentModels() {
  const presented = presentedOpenCodeVersion();
  return [...models.values()].filter(m => m.tools && m.state !== 'unavailable').flatMap(m => {
    const p = settings.providers.find(x => x.id === m.providerId && x.enabled); if (!p) return [];
    const reason = p.kind === 'free' ? freeIdentityProblem(presented) : '';
    return [{ id: m.id, name: m.name, provider: p.name, context: m.context, output: m.output, reasoning: m.reasoning, efforts: m.reasoning ? EFFORTS : [], usable: !reason, ...(reason ? { reason } : {}) }];
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
const summary = (s: any) => ({ id: s.id, title: s.title, mode: modeOf(s.agent || ''), model: s.model?.id || '', effort: EFFORTS.includes(s.model?.variant) ? s.model.variant : '', folder: s.location?.directory || '', created: s.time?.created, tokens: s.tokens, cost: s.cost, outcome: s.outcome });
// Rules OpenCode saved through "always" (never sent by Polygate) would allow commands without asking in every session of the project.
async function clearSavedPermissions() {
  const found = await engine('GET', '/api/permission/saved'); const saved: any[] = Array.isArray(found) ? found : [];
  for (const s of saved) await engine('DELETE', `/api/permission/saved/${encodeURIComponent(s.id)}`);
  if (saved.length) logEvent('warn', 'agent', `Removed ${saved.length} permission rule(s) saved in the agent engine (${saved.map(s => `${s.action}: ${s.resource}`).join(', ')}); Polygate asks every time unless a session allows it`);
}
function checkEffort(entry: ReturnType<typeof agentModels>[number] | undefined, raw: unknown) {
  const effort = raw === undefined || raw === '' ? '' : String(raw);
  if (effort && !(entry?.efforts || []).includes(effort)) throw new GatewayError(entry?.reasoning ? `Effort is one of: ${EFFORTS.join(', ')}.` : 'That model does not take a reasoning effort.', 400, 'agent_effort');
  return effort;
}
async function createSession(b: any) {
  if (!engineConnection()) throw new GatewayError('Start the agent engine first.', 409, 'agent_engine_not_running');
  const folder = checkFolder(b.folder); const mode = checkMode(b.mode); const model = String(b.model || '');
  if (mode === 'full') throw new GatewayError('Start in Ask mode, then explicitly enable Full access for this session.', 400, 'agent_full_consent');
  const list = await engine('GET', `/api/model${q(folder)}`); const known = (Array.isArray(list) ? list : []).some((m: any) => m.providerID === 'polygate' && m.id === model);
  if (!known) throw new GatewayError('The agent engine does not have that model. Pick one from the list, or start the engine again after the catalog changed.', 400, 'agent_model');
  const entry = agentModels().find(m => m.id === model); if (entry?.reason) throw new GatewayError(entry.reason, 400, 'agent_model');
  const effort = checkEffort(entry, b.effort);
  await clearSavedPermissions();
  await watchFolder(folder);
  const title = String(b.title || '').trim().slice(0, 120) || `New session ${new Date().toLocaleString()}`;
  const info = await engine('POST', '/api/session', { title, agent: ENGINE_MODES[mode].agent, model: { providerID: 'polygate', id: model, ...(effort ? { variant: effort } : {}) }, location: { directory: folder } });
  session(info.id, folder).mode = mode;
  return summary(info);
}
// A session this process has not seen yet (Polygate restarted): its folder comes from the engine.
async function known(id: unknown) {
  const sid = String(id || ''); if (!sid) throw new GatewayError('Which session?', 400);
  const s = sessions.get(sid); if (s?.folder) { if (s.mode === 'full' && (!s.fullUntil || s.fullUntil <= Date.now() || s.fullEngine !== engineConnection()?.url)) expireFull(s); await watchFolder(s.folder); return s; }
  const info = await engine('GET', `/api/session/${encodeURIComponent(sid)}`);
  const folder = info?.location?.directory || ''; const out = session(sid, folder); out.mode = modeOf(info?.agent || '') || 'ask';
  if (out.mode === 'full') { out.mode = 'ask'; await engine('POST', `/api/session/${enc(sid)}/agent`, { agent: ENGINE_MODES.ask.agent }); }
  if (folder) await watchFolder(folder);
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
    return json(res, 200, { session: { ...summary(info), mode: s.mode || modeOf(info?.agent || '') }, fullUntil: s.fullUntil || 0, messages: messages || [], pending: [...s.pending.values()], paused: s.paused || '', busy: !!s.busy, usage: sessionUsage(s.id) });
  }
  if (pathname === '/admin/agent/session/prompt' && method === 'POST') {
    const b = await readJson(req, 1024 * 1024); const s = await known(b.id); const text = String(b.text || '');
    if (!text.trim()) throw new GatewayError('Write a message first.', 400);
    if (s.undoing || s.sending) throw new GatewayError('Wait for the current action to finish before sending another message.', 409, 'agent_busy');
    s.sending = true;
    try {
    await s.recording;
    if (!s.busy) {
      s.backup = captureBackup(s.folder);
      mkdirSync(path.dirname(pendingFile(s.id)), { recursive: true });
      writeFileAtomic(pendingFile(s.id), JSON.stringify(s.backup));
    }
    s.retries = 0; s.paused = undefined;
    return json(res, 200, { ok: true, message: await engine('POST', `/api/session/${encodeURIComponent(s.id)}/prompt`, { text }) });
    } finally { s.sending = false; }
  }
  if (pathname === '/admin/agent/session/approve' && method === 'POST') {
    const b = await readJson(req); const s = await known(b.id); const decision = String(b.decision || '');
    if (!['once', 'session', 'project', 'deny'].includes(decision)) throw new GatewayError('Answer once, session, project or deny.', 400, 'agent_decision');
    const p = s.pending.get(String(b.request || '')); if (!p) throw new GatewayError('That request is no longer waiting for an answer.', 404, 'agent_request_gone');
    if (s.mode === 'plan' && ['shell', 'edit', 'execute', 'subagent'].includes(p.action) && decision !== 'deny') throw new GatewayError('Leave Plan mode before approving changes or commands.', 409, 'agent_plan');
    if (decision === 'project') saveProjectRule(s.folder, p.action, p.resources, 'allow');
    if (decision === 'deny') { await reply(s.id, p.id, 'reject', typeof b.message === 'string' ? b.message.slice(0, 2000) : undefined); s.pending.delete(p.id); return json(res, 200, { ok: true }); }
    await reply(s.id, p.id, 'once');
    s.pending.delete(p.id);
    if (decision === 'session') {
      // Allowed again in this session without asking, for exactly this action and target; other requests of the same kind waiting now go too.
      const key = keyOf(p.action, p.resources); s.allowed.add(key);
      for (const other of [...s.pending.values()]) if (keyOf(other.action, other.resources) === key) { s.pending.delete(other.id); await reply(s.id, other.id, 'once'); publish(s.id, { type: 'agent.approval.auto', data: { sessionID: s.id, requestID: other.id, action: other.action, resources: other.resources } }); }
    }
    return json(res, 200, { ok: true });
  }
  if (pathname === '/admin/agent/session/changes' && method === 'GET') { const s = await known(url.searchParams.get('id')); return json(res, 200, { turns: loadTurns(s).map(publicTurn) }); }
  if (pathname === '/admin/agent/session/undo' && method === 'POST') {
    const b = await readJson(req); const s = await known(b.id); const out = await undoTurn(s, String(b.message || ''));
    if (out.conflicts) return json(res, 409, { error: { type: 'agent_undo_conflict', message: `Nothing was undone. ${out.conflicts.map(c => `${c.file}: ${c.reason}`).join(' ')} Undoing would overwrite that.` }, conflicts: out.conflicts });
    return json(res, 200, { ok: true, files: out.files });
  }
  // Another model for a session, typically one that is paused because its model keeps failing. Same checks as a new session.
  if (pathname === '/admin/agent/session/model' && method === 'POST') {
    const b = await readJson(req); const s = await known(b.id); const model = String(b.model || '');
    const entry = agentModels().find(m => m.id === model);
    if (!entry) throw new GatewayError('The agent cannot use that model: it is unknown, cannot call tools, or its provider is switched off.', 400, 'agent_model');
    if (entry.reason) throw new GatewayError(entry.reason, 400, 'agent_model');
    const effort = checkEffort(entry, b.effort);
    const list = await engine('GET', `/api/model${q(s.folder)}`);
    if (!(Array.isArray(list) ? list : []).some((m: any) => m.providerID === 'polygate' && m.id === model)) throw new GatewayError('The agent engine does not have that model. Start the engine again after the catalog changed.', 400, 'agent_model');
    await engine('POST', `/api/session/${enc(s.id)}/model`, { model: { providerID: 'polygate', id: model, ...(effort ? { variant: effort } : {}) } });
    s.paused = undefined; s.retries = 0; return json(res, 200, { ok: true });
  }
  if (pathname === '/admin/agent/session/rename' && method === 'POST') {
    const b = await readJson(req); const s = await known(b.id); const title = String(b.title || '').trim().slice(0, 120);
    if (!title) throw new GatewayError('Give the session a name.', 400);
    await engine('PATCH', `/api/session/${enc(s.id)}`, { title }); return json(res, 200, { ok: true, title });
  }
  if (pathname === '/admin/agent/session/cancel' && method === 'POST') { const s = await known((await readJson(req)).id); await engine('POST', `/api/session/${encodeURIComponent(s.id)}/interrupt`); return json(res, 200, { ok: true }); }
  if (pathname === '/admin/agent/session/mode' && method === 'POST') {
    const b = await readJson(req); const mode = checkMode(b.mode); const s = await known(b.id);
    if (s.busy || s.sending || s.undoing || s.pending.size) throw new GatewayError('Stop the turn and resolve pending approvals before changing mode.', 409, 'agent_busy');
    if (mode === 'full' && b.confirmFull !== true) throw new GatewayError('Full access needs explicit confirmation: commands can access your files, network and Polygate data with your account access.', 400, 'agent_full_consent');
    await engine('POST', `/api/session/${encodeURIComponent(s.id)}/agent`, { agent: ENGINE_MODES[mode].agent });
    if (s.fullTimer) clearTimeout(s.fullTimer); s.fullUntil = undefined; s.fullEngine = undefined; s.allowed.clear(); s.mode = mode;
    if (mode === 'full') {
      s.fullUntil = Date.now() + 30 * 60000; s.fullEngine = engineConnection()?.url;
      s.fullTimer = setTimeout(() => { if (s.mode !== 'full') return; engine('POST', `/api/session/${enc(s.id)}/interrupt`).catch(() => {}); expireFull(s); }, 30 * 60000); s.fullTimer.unref?.();
    }
    publish(s.id, { type: 'agent.mode', data: { sessionID: s.id, mode, fullUntil: s.fullUntil || 0 } });
    return json(res, 200, { ok: true, mode, fullUntil: s.fullUntil || 0 });
  }
  if (pathname === '/admin/agent/rules' && method === 'GET') { const s = await known(url.searchParams.get('id')); return json(res, 200, { rules: projectRules(s.folder), inspections: inspectionCommands() }); }
  if (pathname === '/admin/agent/rules/remove' && method === 'POST') { const b = await readJson(req), s = await known(b.id); removeProjectRule(s.folder, String(b.rule || '')); return json(res, 200, { ok: true }); }
  if (pathname === '/admin/agent/events' && method === 'GET') {
    const s = await known(url.searchParams.get('id'));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    // What the page needs after it (re)connects: approvals still waiting and whether the session is paused.
    res.write(`data: ${JSON.stringify({ type: 'agent.state', data: { sessionID: s.id, pending: [...s.pending.values()], paused: s.paused || '', busy: !!s.busy } })}\n\n`);
    const set = listeners.get(s.id) || new Set(); set.add(res); listeners.set(s.id, set);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15000);
    req.on('close', () => { clearInterval(ping); set.delete(res); if (!set.size) listeners.delete(s.id); });
    return;
  }
  throw new GatewayError('Admin endpoint not found', 404);
}
// Called when the gateway stops: the folder streams end with it.
export function stopAgent() { for (const s of sessions.values()) { if (s.fullTimer) clearTimeout(s.fullTimer); if (s.mode === 'full') { s.mode = 'ask'; s.fullUntil = undefined; s.fullEngine = undefined; } s.allowed.clear(); } for (const f of folders.values()) f.abort.abort(); folders.clear(); }
