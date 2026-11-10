import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { models, sessionUsage, settings, stateDir, writeFileAtomic } from './state';
import { GatewayError } from './queue';
import { logEvent } from './logbook';
import { ENGINE_MODES, engineConnection, enginePaths, engineStatus, freeIdentityProblem, syncEngineModels } from './agent-engine';
import { discover, presentedOpenCodeVersion } from './providers';
import { backupBytes, beforeFile, byteDiff, captureBackup, fileKey, filePath, pruneBackups, restoreFile, saveBytes, type Backup, type FileBackup } from './agent-backup';
import { inspectionCommands, permissionDecision, projectRules, removeProjectRule, saveProjectRule } from './agent-permissions';
import { grantTrust, inspectTrust, revokeTrust, trustedFolders } from './agent-trust';
import { pausedAgents, setAgentPause } from './agent-recovery';
import { mergeUndo } from './agent-merge';
import { plainError } from './plain-error';
import { agentFiles, engineFiles } from './agent-attachments';
import { agentMcpCatalog, saveAgentMcpSelection } from './mcp';
import { inspectGit } from './agent-git';
import {clearTerminal,startTerminal,stopAllTerminals,stopTerminal,terminalState,terminalInFolder} from './agent-terminal';
import {projectPreferences,projectSources,readProjectSource,saveProjectPreferences} from './agent-project';
import {agentChains} from './agent-chains';
import {agentLibrary,isBuiltinSkill,saveAgentLibrary,skillProblems,syncSkills} from './agent-library';
// The agent controller (docs/agent/PLAN.md, Phase 2a): the only part of Polygate that talks to the agent's engine. The Agent page uses it
// through the desktop-only admin API (admin.ts); the engine's password never reaches the page. It keeps one event stream per working
// folder open to the engine (opened again after an engine restart), hands each session's events to the page, and answers approvals:
// once, for this session (remembered here, for the exact request), or deny. OpenCode's own "always" is never used: it saves a
// permanent rule for the whole project with a broad pattern (`shell: node *` from approving one `node -e …`).

const MAX_RETRIES = 3;
type Mode = keyof typeof ENGINE_MODES;
type Pending = { id: string; action: string; resources: string[]; note: string; input?: unknown };
type Session = { id: string; folder: string; parent?:string; allowed: Set<string>; pending: Map<string, Pending>; retries: number; paused?: string; busy?: boolean; stepFiles: Set<string>; toolNames: Map<string, string>; toolFiles:Map<string,Set<string>>; turns?: Turn[]; backup?: Backup; recording?: Promise<void>; recovering?: Promise<'committed'|'rolledback'|undefined>; undoing?: boolean; sending?: boolean; mode?: Mode; fullEngine?: string; unsafeTurn?:'busy'|'delegated'; turnMessage?:string };
const sessions = new Map<string, Session>();
const listeners = new Map<string, Set<ServerResponse>>();
const eventEpoch = randomUUID();
const eventJournals = new Map<string, { seq: number; bytes: number; entries: { seq: number; text: string }[] }>();
const eventJournal = (sid: string) => { let journal = eventJournals.get(sid); if (!journal) { journal = { seq: 0, bytes: 0, entries: [] }; eventJournals.set(sid, journal); } return journal; };
const streamStates = new Map<string, { connected: boolean; generation: number }>();
const folders = new Map<string, { abort: AbortController; ready: Promise<void> }>();
const parentChecked=new Set<string>();
const folderKey=(p:string)=>{try{p=realpathSync(p);}catch{}return process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p);};
const sameFolder=(a:string,b:string)=>folderKey(a)===folderKey(b);
const folderConflict=(s:Session)=>[...sessions.values()].some(other=>other.id!==s.id&&sameFolder(other.folder,s.folder)&&(other.busy||other.sending||other.undoing));

// --- Engine calls ---
async function engine(method: string, route: string, body?: unknown, envelope = false): Promise<any> {
  const c = engineConnection(); if (!c) throw new GatewayError('Start the agent engine first.', 409, 'agent_engine_not_running');
  const r = await fetch(c.url + route, { method, headers: { authorization: c.auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (r.status === 404 && route.startsWith('/api/session/')) throw new GatewayError('The agent has no such session.', 404, 'agent_session_not_found');
  if (!r.ok) throw new GatewayError(`The agent engine answered ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`, 502, 'agent_engine_error');
  // OpenCode 2.x wraps its answers as {data: …} (a list also carries a cursor); callers get what is inside.
  const answer: any = r.status === 204 ? undefined : await r.json().catch(() => undefined);
  return !envelope && answer && typeof answer === 'object' && !Array.isArray(answer) && 'data' in answer ? answer.data : answer;
}
// Context is the model's compacted working set, not the transcript. Read every chronological history page instead.
async function history(sid: string) {
  const out: any[] = [], seen = new Set<string>(); let cursor = '';
  do {
    const page = await engine('GET', `/api/session/${enc(sid)}/message?limit=200&${cursor ? `cursor=${enc(cursor)}` : 'order=asc'}`, undefined, true);
    if (!Array.isArray(page?.data)) throw new GatewayError('The agent returned an invalid message history.', 502, 'agent_engine_error');
    out.push(...page.data);
    cursor = page.cursor?.next || '';
    if (cursor && seen.has(cursor)) throw new GatewayError('The agent repeated a message history page.', 502, 'agent_engine_error');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return out;
}
async function requireSharedMcp(folder: string) {
  if (!settings.mcp?.agentTools?.length) return;
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const servers = await engine('GET', `/api/mcp?location[directory]=${encodeURIComponent(folder)}`);
    const state = servers?.find((s: any) => s.name === 'polygate_shared')?.status;
    // 2.2.5 debounces registry updates for 100 ms after discovery reports connected.
    if (state?.status === 'connected') { await Bun.sleep(250); return; }
    if (state?.status && state.status !== 'pending') throw new GatewayError('Shared MCP tools could not connect. Check the MCP hub and Agent settings, then try again.', 409, 'agent_mcp_unavailable');
    await Bun.sleep(100);
  }
  throw new GatewayError('Shared MCP tools are still connecting. Check the MCP hub and try again.', 409, 'agent_mcp_unavailable');
}
const q = (folder: string) => `?directory=${encodeURIComponent(folder)}`;
const reply = (sid: string, request: string, decision: 'once' | 'reject', message?: string) =>
  engine('POST', `/api/session/${encodeURIComponent(sid)}/permission/${encodeURIComponent(request)}/reply`, message ? { decision, message } : { decision });

// --- Events from the engine ---
// 2.2.5's stream is volatile and server-wide; onEvent filters each session to its own working-folder stream.
// Its durable session log has an `after` sequence, but message history has no matching event watermark.
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
        const generation = (streamStates.get(folder)?.generation || 0) + 1;
        streamStates.set(folder, { connected: true, generation });
        for (const s of sessions.values()) if (sameFolder(s.folder, folder)) publish(s.id, { type: 'agent.stream', data: { sessionID: s.id, connected: true, generation } });
        // One decoder for the whole stream: a character split across two chunks is joined, not turned into a replacement mark.
        const reader = r.body.getReader(), decoder = new TextDecoder(); let buf = '';
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += decoder.decode(value, { stream: true }); let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const lines = buf.slice(0, i).split('\n').filter(l => l.startsWith('data:')); buf = buf.slice(i + 2);
            if (!lines.length) continue; opened();
            try { onEvent(JSON.parse(lines.map(l => l.slice(5).trimStart()).join('\n')), folder); } catch { /* one bad event is skipped */ }
          }
        }
      } catch { /* the engine stopped or restarted: open the stream again once it is back */ }
      const state = streamStates.get(folder);
      if (state?.connected) {
        state.connected = false;
        for (const s of sessions.values()) if (sameFolder(s.folder, folder)) publish(s.id, { type: 'agent.stream', data: { sessionID: s.id, ...state } });
      }
      if (!abort.signal.aborted) await Bun.sleep(500);
    }
  })();
  return Promise.race([ready, Bun.sleep(5000)]);
}
function session(id: string, folder = '') {
  let s = sessions.get(id);
  if (!s) {
    s = { id, folder, allowed: new Set(), pending: new Map(), retries: 0, stepFiles: new Set(), toolNames: new Map(), toolFiles:new Map(), paused: pausedAgents().find(s => s.id === id)?.paused };
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
  if (action.startsWith('polygate_shared_')) return 'This calls a shared MCP tool. It can access the server’s files or services with its configured credentials. Sharing a tool does not make it read-only or sandboxed.';
  if (action === 'shell') return resources.some(r => PROJECT_CODE.test(r)) ? 'This runs the project\'s code with your account\'s access: whatever its scripts do, they can do as you.' : 'This command runs with your account\'s access.';
  if (action === 'external_directory') return 'This is outside the working folder.';
  if (action === 'webfetch' || action === 'websearch') return 'This goes to the internet.';
  return '';
}
// Polygate's own events get an id like the engine's, so the page keeps each one apart.
let published = 0;
function publish(sid: string, event: any) {
  const journal = eventJournal(sid), seq = ++journal.seq;
  const text = `id: ${eventEpoch}:${seq}\ndata: ${JSON.stringify({ ...(event && typeof event === 'object' && !event.id ? { id: `pg_${++published}`, ...event } : event), controller: { epoch: eventEpoch, seq } })}\n\n`;
  journal.entries.push({ seq, text }); journal.bytes += Buffer.byteLength(text);
  while (journal.entries.length > 2048 || journal.bytes > 1024 * 1024) journal.bytes -= Buffer.byteLength(journal.entries.shift()!.text);
  for (const res of listeners.get(sid) || []) { try { res.write(text); } catch { /* the page went away; its close handler removes it */ } }
}
function onEvent(e: any, folder: string) {
  const d = e?.data || {}; const sid = d.sessionID || d.form?.sessionID; if (!sid || e.type === 'server.heartbeat') return;
  // Some 2.2.5 events reach every open folder stream. Process a session only on its own stream, once.
  const known = sessions.get(sid); const owner = known?.folder || e.location?.directory;
  if (owner && path.relative(owner, folder)) return;
  const s = session(sid, folder);
  const captured=s;
  if(!parentChecked.has(sid)){parentChecked.add(sid);void engine('GET',`/api/session/${enc(sid)}`).then(info=>{if(info.parentID){captured.parent=info.parentID;const parent=session(info.parentID,folder);parent.unsafeTurn='delegated';for(const file of captured.stepFiles)parent.stepFiles.add(file);}}).catch(()=>parentChecked.delete(sid));}
  if(e.type==='session.created'&&d.parentID){s.parent=d.parentID;const parent=session(d.parentID,folder);parent.unsafeTurn='delegated';}
  if(e.type==='session.inbox.delivered'){if(!s.turnMessage)s.turnMessage=d.inboxID;else if(s.turnMessage!==d.inboxID)s.unsafeTurn=s.unsafeTurn||'busy';}
  if (e.type === 'permission.asked') {
    const resources = Array.isArray(d.resources) ? d.resources.map(String) : []; const key = keyOf(d.action, resources);
    try { requireTrust(s.folder); }
    catch (err: any) {
      s.paused = err.message; setAgentPause(s.id, s.paused); s.allowed.clear(); if (s.mode === 'full') expireFull(s);
      reply(sid, d.id, 'reject', 'Working folder consent is missing.').catch(() => {});
      engine('POST', `/api/session/${enc(s.id)}/interrupt`).catch(() => {});
      publish(sid, { type: 'agent.paused', data: { sessionID: sid, message: s.paused } }); return;
    }
    const full = s.mode === 'full' && s.fullEngine === engineConnection()?.url;
    if (s.mode === 'full' && !full) { expireFull(s); }
    let decision: 'allow' | 'deny' | 'ask' = 'ask';
    try { decision = permissionDecision(full ? 'full' : s.mode || 'ask', d.action, resources, projectRules(s.folder)); }
    catch (err: any) { s.paused = err.message; setAgentPause(s.id, s.paused); engine('POST', `/api/session/${enc(s.id)}/interrupt`).catch(() => {}); publish(sid, { type: 'agent.paused', data: { sessionID: sid, message: s.paused } }); reply(sid, d.id, 'reject').catch(() => {}); return; }
    if (decision === 'deny') {
      reply(sid, d.id, 'reject', 'Blocked by the current permission mode or a saved project rule.').catch(err => logEvent('warn', 'agent', String(err)));
      publish(sid, { type: 'agent.approval.blocked', data: { sessionID: sid, requestID: d.id, action: d.action, resources } }); return;
    }
    if (decision === 'allow' || s.allowed.has(key)) {
      reply(sid, d.id, 'once').catch(err => logEvent('warn', 'agent', `An approval for this session could not be applied: ${err?.message || err}`));
      publish(sid, { type: 'agent.approval.auto', data: { sessionID: sid, requestID: d.id, action: d.action, resources, reason: full ? 'Full access' : decision === 'allow' ? 'Permission rule' : 'Allowed for this session' } }); return;
    }
    const pending: Pending = { id: String(d.id), action: String(d.action), resources, note: noteFor(d.action, resources), ...(String(d.action).startsWith('polygate_shared_') ? { input: d.metadata?.input } : {}) };
    s.pending.set(pending.id, pending);
    // OpenCode's suggested permanent rule (`save`) is not passed on: the page never offers it.
    const { save, ...rest } = d; publish(sid, { ...e, data: { ...rest, resources, note: pending.note, ...(pending.input !== undefined ? { input: pending.input } : {}) } }); return;
  }
  if (e.type === 'permission.replied') s.pending.delete(String(d.requestID));
  if (e.type === 'session.execution.started') { s.retries = 0; s.paused = undefined; setAgentPause(s.id); s.busy = true; }
  // OpenCode 2.2.5 reports step files only in Git projects. File tools still identify their targets in every folder.
  if (e.type === 'session.tool.input.started') s.toolNames.set(d.id, d.name);
  if(e.type==='session.tool.called'&&s.toolNames.get(d.id)==='subagent')s.unsafeTurn='delegated';
  if (e.type === 'session.tool.called' && /^(write|edit|multiedit|patch|apply_patch)$/.test(s.toolNames.get(d.id) || '')) {
    const input = d.input || {};
    const targets=new Set<string>();s.toolFiles.set(d.id,targets);
    const add = (raw: unknown) => {
      if (typeof raw !== 'string' || !raw.trim()) return;
      const rel = path.relative(s.folder, path.resolve(s.folder, raw));
      if (rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) targets.add(rel.replace(/\\/g, '/'));
    };
    add(input.path ?? input.filePath);
    if (Array.isArray(input.edits)) for (const edit of input.edits) add(edit?.path ?? edit?.filePath);
    const patch = input.patchText ?? input.patch;
    if (typeof patch === 'string') for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/gm)) add(match[1].trim());
  }
  if(e.type==='session.tool.success')for(const file of s.toolFiles.get(d.id)||[])s.stepFiles.add(file);
  if(/^session\.tool\.(success|failed)$/.test(e.type))s.toolFiles.delete(d.id);
  // Nested Code Mode leaf calls retain their own success/failure and inputs in final metadata.
  if(/^session\.tool\.(progress|success|failed)$/.test(e.type)&&Array.isArray(d.metadata?.toolCalls))for(const call of d.metadata.toolCalls){
    if(/^(?:tools\.)?subagent$/.test(call.tool||''))s.unsafeTurn='delegated';
    if(call.status!=='completed'||!/^(?:tools\.)?(write|edit|multiedit|patch|apply_patch)$/.test(call.tool||''))continue;
    const edits=Array.isArray(call.input?.edits)?call.input.edits:[];
    const patch=call.input?.patchText??call.input?.patch;
    const targets=[call.input?.path??call.input?.filePath,...edits.map((x:any)=>x.path??x.filePath),...(typeof patch==='string'?[...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/gm)].map(m=>m[1].trim()):[])];
    for(const raw of targets)if(typeof raw==='string'){const rel=path.relative(s.folder,path.resolve(s.folder,raw));if(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel))s.stepFiles.add(rel.replace(/\\/g,'/'));}
  }
  if(s.parent&&s.stepFiles.size){const parent=sessions.get(s.parent);if(parent){parent.unsafeTurn='delegated';for(const file of s.stepFiles)parent.stepFiles.add(file);}}
  if (e.type === 'session.step.ended' && Array.isArray(d.files)) for (const f of d.files) if (typeof f === 'string' && f) s.stepFiles.add(f);
  if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(e.type)) {
    s.busy = false;
    s.pending.clear();
    s.toolNames.clear();
    s.toolFiles.clear();
    s.recording = recordTurn(s).catch(err => logEvent('warn', 'agent', `What the agent changed in this turn could not be recorded, so it cannot be undone from Polygate: ${err?.message || err}`)).finally(prune);
  }
  publish(sid, e);
  // The engine retries a failing model request for a long time on its own; after a few tries the turn is stopped and the page told why,
  // so the user can wait, resume or pick another model. A tool action that already ran is never repeated by this.
  if (e.type === 'session.retry.scheduled' && ++s.retries >= MAX_RETRIES && !s.paused) {
    s.paused = plainError(d.error?.message || 'The model kept failing.');
    setAgentPause(s.id, s.paused);
    engine('POST', `/api/session/${encodeURIComponent(sid)}/interrupt`).catch(() => {});
    publish(sid, { type: 'agent.paused', data: { sessionID: sid, message: s.paused, status: d.error?.status } });
    logEvent('warn', 'agent', `Agent session paused after ${s.retries} failed model requests: ${s.paused}`);
  }
}

function expireFull(s: Session) {
  s.fullEngine = undefined; s.mode = 'ask'; s.allowed.clear();
  engine('POST', `/api/session/${enc(s.id)}/agent`, { agent: ENGINE_MODES.ask.agent }).catch(err => logEvent('warn', 'agent', `Full access expired; resetting the engine agent failed: ${err?.message || err}`));
  publish(s.id, { type: 'agent.mode', data: { sessionID: s.id, mode: 'ask', reason: 'Full access ended. Ask for approval is active.' } });
}

// --- Changes and undo ---
// What each turn changed, kept per session in the agent's folder so it outlives a restart: the files the engine's steps reported, the
// exact pre/post-turn bytes. Undo reverses turns in private scratch copies, merging non-overlapping user edits, then checks the working
// files before writing. Engine snapshots are not used because their Git index can normalize working-tree content.
type FileChange = { file: string; status: string; additions: number; deletions: number; patch: string; after: string | null; before?: FileBackup };
// noBackup: no backup was taken before the turn, because folder backups were off or the message was queued while the agent was working.
type Turn = { message: string; at: number; files: FileChange[]; noBackup?: 'off' | 'busy' | 'delegated' };
const enc = encodeURIComponent;
const turnsFile = (sid: string) => path.join(enginePaths().root, 'turns', `${sid.replace(/[^A-Za-z0-9_-]/g, '')}.json`);
const pendingFile = (sid: string) => turnsFile(sid) + '.pending';
const journalFile=(sid:string)=>turnsFile(sid)+'.undo';
type UndoJournal={message:string;phase:'staged'|'restoring'|'committing';rollback:[string,FileBackup][];target:[string,FileBackup][];history:string[];remaining:Turn[]};
function recoverUndo(s:Session, ownsUndo=false):Promise<'committed'|'rolledback'|undefined>{
  if(s.recovering)return s.recovering;
  if(!existsSync(journalFile(s.id)))return Promise.resolve(undefined);
  if(s.undoing&&!ownsUndo)return Promise.reject(new GatewayError('Undo is already working in this session. Wait for it to finish before recovery.',409,'agent_busy'));
  const undoing=s.undoing;
  s.undoing=true;
  // Publish one transaction to all readers; commit reconciliation keeps its caller's Undo lock.
  s.recovering=(async()=>{
  if(!existsSync(journalFile(s.id)))return;
  const journal:UndoJournal=JSON.parse(readFileSync(journalFile(s.id),'utf8'));
  const info=await engine('GET',`/api/session/${enc(s.id)}`);
  const messages=(await history(s.id)).map(m=>m.id);
  const unchanged=JSON.stringify(messages)===JSON.stringify(journal.history);
  const boundary=journal.history.indexOf(journal.message);
  const committed=!info.revert&&boundary>=0&&messages.length<journal.history.length&&messages.every((id,i)=>id===journal.history[i])&&messages.length<=boundary+1;
  const desired=committed?journal.target:journal.rollback;
  if(!committed&&(!unchanged||info.revert&&info.revert.messageID!==journal.message))throw new GatewayError('Undo outcome is uncertain. Files and history were left untouched; resolve the saved Undo transaction before continuing.',409,'agent_undo_recovery');
  const [active,folderSessions]=await Promise.all([engine('GET','/api/session/active'),engine('GET',`/api/session${q(s.folder)}`)]);
  if(s.busy||s.sending||terminalInFolder(s.folder)||folderConflict(s)||active?.[s.id]||(Array.isArray(folderSessions)&&folderSessions.some(x=>active?.[x.id])))throw new GatewayError('An agent or terminal in this folder is working. Stop it or wait until it is done before Undo recovery. Recovery information is saved.',409,'agent_busy');
  // Never overwrite an edit made after the interrupted transaction.
  for(const [file]of desired){const hash=hashOf(s.folder,file);if(hash!==(new Map(journal.target).get(file)?.hash??null)&&hash!==(new Map(journal.rollback).get(file)?.hash??null))throw new GatewayError('A file changed during interrupted Undo recovery. Nothing was overwritten. Resolve the saved Undo transaction before continuing.',409,'agent_undo_recovery');}
  let uncertain=false;
  for(const [file,bytes]of desired){try{restoreFile(s.folder,file,bytes);}catch{uncertain=true;}}
  if(!committed&&info.revert){try{await engine('DELETE',`/api/session/${enc(s.id)}/revert`);}catch{uncertain=true;}}
  for(const [file,bytes]of desired){try{if(!matchesBackup(s.folder,file,bytes))uncertain=true;}catch{uncertain=true;}}
  if(uncertain)throw new GatewayError('Undo recovery could not restore and verify every file or cancel staged history. Recovery information is saved; resolve the saved Undo transaction before continuing.',409,'agent_undo_recovery');
  if(committed){s.turns=journal.remaining;saveTurns(s);}
  unlinkSync(journalFile(s.id));return committed?'committed' as const:'rolledback' as const;
  })().finally(()=>{s.recovering=undefined;s.undoing=undoing;});
  return s.recovering;
}
// Every saved copy a turn record or a backup waiting for its turn refers to; null when one cannot be read, and then nothing is pruned.
function referencedCopies(): Set<string> | null {
  const dir = path.join(enginePaths().root, 'turns'), refs = new Set<string>();
  let names: string[] = [];
  try { names = readdirSync(dir); } catch (e: any) { if (e.code !== 'ENOENT') return null; }
  for (const name of names.filter(n => n.endsWith('.json') || n.endsWith('.json.pending') || n.endsWith('.json.undo'))) {
    try {
      const v = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
      if(name.endsWith('.undo')){for(const [,f]of [...v.rollback,...v.target])if(f?.hash)refs.add(f.hash);for(const t of v.remaining||[])for(const f of t.files||[]){if(f.before?.hash)refs.add(f.before.hash);if(f.after)refs.add(f.after);}}
      else if (name.endsWith('.pending')) { for (const f of Object.values<any>(v?.files || {})) if (typeof f?.hash === 'string') refs.add(f.hash); }
      else for (const t of Array.isArray(v) ? v : []) for (const f of t?.files || []) { if (typeof f?.before?.hash === 'string') refs.add(f.before.hash); if (typeof f?.after === 'string') refs.add(f.after); }
    } catch { return null; }
  }
  return refs;
}
// Old backup copies are removed after a turn or an undo, at most every ten minutes (or now, when folder backups were switched off). With
// folder backups off, the folders' last backups are dropped too: only the copies turn records still need are kept.
let prunedAt = 0;
export function pruneAgentBackups(now = false) {
  if (!now && Date.now() - prunedAt < 600000) return; prunedAt = Date.now();
  pruneBackups(referencedCopies(), Date.now(), settings.agentBackups === true).catch(err => logEvent('warn', 'agent', `Old agent backups could not be removed: ${err?.message || err}`));
}
const prune = () => pruneAgentBackups();
function loadTurns(s: Session): Turn[] { if (!s.turns) { try { const v = JSON.parse(readFileSync(turnsFile(s.id), 'utf8')); s.turns = Array.isArray(v) ? v : []; } catch { s.turns = []; } } return s.turns!; }
function saveTurns(s: Session) { mkdirSync(path.dirname(turnsFile(s.id)), { recursive: true }); writeFileAtomic(turnsFile(s.id), JSON.stringify(s.turns || [])); }
const hashOf = (folder: string, rel: string) => { try { return createHash('sha256').update(readFileSync(path.join(folder, rel))).digest('hex'); } catch { return null; } };
function matchesBackup(folder: string, file: string, saved: FileBackup) {
  const full = filePath(folder, file);
  try {
    const stat = statSync(full);
    return saved !== null && stat.isFile() && (stat.mode & 0o777) === saved.mode && createHash('sha256').update(readFileSync(full)).digest('hex') === saved.hash;
  } catch (err: any) { if (err.code === 'ENOENT') return saved === null; throw err; }
}
// undoable: every file the turn changed has an exact copy from before it; when not, `why` says so in plain words.
const NO_BACKUP = { off: 'Folder backups were off when this turn ran, so it cannot be undone from Polygate.', busy: 'This execution includes queued or steering messages without separate backup boundaries, so it cannot be safely undone from Polygate.', delegated:'This task includes delegated work with separate child history. Changes are shown, but combined parent/child Undo is unavailable.' };
function publicTurn(t: Turn) {
  const why = t.noBackup ? NO_BACKUP[t.noBackup] : t.files.some(f => f.before === undefined) ? 'Some of these files were not in the backup (the folder is bigger than one backup covers, or the file is left out of backups), so this turn cannot be undone from Polygate.' : '';
  return { message: t.message, at: t.at, undoable: !why, ...(why ? { why } : {}), files: t.files.map(({ after, before, ...f }) => f) };
}
// The engine's diff route answers for the latest turn that changed something, so a turn that changed nothing could be handed the previous
// turn's files: which files a turn changed comes from its own steps, and only the patches from the diff.
async function recordTurn(s: Session) {
  const reported = [...s.stepFiles]; s.stepFiles.clear();
  const backup = s.backup, noBackup = s.unsafeTurn || (s.parent?'delegated' as const:backup ? undefined : settings.agentBackups === true ? 'busy' as const : 'off' as const);
  const displayPaths = new Map(Object.keys(backup?.files || {}).map(file => [fileKey(file), file]));
  const changed = [...new Map(reported.map(file => [fileKey(file), displayPaths.get(fileKey(file)) || path.posix.normalize(file.replace(/\\/g, '/'))])).values()];
  const turnMessage=s.turnMessage;s.turnMessage=undefined;
  s.backup = undefined;
  try { unlinkSync(pendingFile(s.id)); } catch {}
  if (!changed.length) return;
  const [diff, ctx] = await Promise.all([engine('GET', `/api/session/${enc(s.id)}/diff`), engine('GET', `/api/session/${enc(s.id)}/context`)]);
  const message = turnMessage||[...(Array.isArray(ctx) ? ctx : [])].reverse().find((m: any) => m?.type === 'user')?.id; if (!message) return;
  const byFile = new Map<string, any>((Array.isArray(diff) ? diff : []).filter((f: any) => f?.file).map((f: any) => [fileKey(String(f.file)), f]));
  const files: FileChange[] = changed.map(file => {
    const f = byFile.get(fileKey(file)) || {}, before = beforeFile(backup, file);
    const after = hashOf(s.folder, file);
    let patch = { additions: Number(f.additions) || 0, deletions: Number(f.deletions) || 0, patch: String(f.patch || '').slice(0, 200000) };
    if (before !== undefined) {
      try {
        const content = after === null ? Buffer.alloc(0) : readFileSync(filePath(s.folder, file));
        if (content.length > 256 * 1024 * 1024 || after !== null && saveBytes(content) !== after) throw new Error('The changed file cannot be recorded safely.');
        patch = byteDiff(file, before === null ? Buffer.alloc(0) : backupBytes(before), content);
      }
      catch { return { file, status: String(f.status || 'modified'), ...patch, after }; }
    }
    return { file, status: before === null ? 'added' : before !== undefined && after === null ? 'deleted' : String(f.status || 'modified'), ...patch, after, ...(before !== undefined ? { before } : {}) };
  });
  const actual=files.filter(f=>f.before===undefined||f.after!==(f.before?.hash??null));
  if(!actual.length)return;
  const turns = loadTurns(s); const known = turns.find(t => t.message === message);
  // A message can take more than one run (sent again after a pause): its record keeps every file, with the newest state of each.
  const turn: Turn = known ? Object.assign(known, { at: Date.now(), ...(noBackup && !known.noBackup ? { noBackup } : {}), files: [...known.files.filter(f => !actual.some(n => fileKey(n.file) === fileKey(f.file))), ...actual.map(f => { const old = known.files.find(x => fileKey(x.file) === fileKey(f.file)); return old ? { ...f, file: old.file, before: old.before } : f; })] }) : { message, at: Date.now(), files:actual, ...(noBackup ? { noBackup } : {}) };
  if (!known) turns.push(turn);
  saveTurns(s); publish(s.id, { type: 'agent.changes', data: { sessionID: s.id, turn: publicTurn(turn) } });
}
async function undoTurn(s: Session, message: string) {
  if (s.busy || s.undoing || s.sending || terminalInFolder(s.folder)||folderConflict(s)) throw new GatewayError('An agent or terminal in this folder is working. Stop it or wait until it is done, then undo.', 409, 'agent_busy');
  s.undoing = true;
  try {
  const [active,folderSessions]=await Promise.all([engine('GET','/api/session/active'),engine('GET',`/api/session${q(s.folder)}`)]);
  if(Array.isArray(folderSessions)&&folderSessions.some(x=>active?.[x.id]))throw new GatewayError('An agent in this folder is still working. Stop it before Undo.',409,'agent_busy');
  await s.recording;
  const turns = loadTurns(s); const from = turns.findIndex(t => t.message === message);
  if (from < 0) throw new GatewayError('Polygate has no recorded changes for that turn.', 404, 'agent_undo_unknown');
  // Undo goes back through every later turn too, so one of them without a backup stops it as well.
  const unbacked = turns.slice(from).find(t => t.noBackup);
  if (unbacked) throw new GatewayError(`${NO_BACKUP[unbacked.noBackup!]}${unbacked.message !== message ? ' (A later turn, which undo would have to go back through.)' : ''}${unbacked.noBackup === 'off' ? ' Switch on folder backups in Agent settings to be able to undo later turns.' : ''}`, 409, 'agent_undo_unavailable');
  const files = [...new Map(turns.slice(from).flatMap(t => t.files.map(f => [fileKey(f.file), f.file] as const))).values()];
  const rollback = new Map(files.map(file => { const full = filePath(s.folder, file); return [file, existsSync(full) ? { hash: saveBytes(readFileSync(full)), mode: statSync(full).mode & 0o777 } : null] as const; }));
  const target = new Map<string, FileBackup>(), conflicts: { file: string; reason: string }[] = [];
  let merged = 0;
  for (const file of files) {
    try {
      let saved: FileBackup = rollback.get(file) ?? null;
      let current: Buffer | null = saved === null ? null : backupBytes(saved);
      for (const turn of turns.slice(from).reverse()) {
        const change = turn.files.find(f => fileKey(f.file) === fileKey(file)); if (!change) continue;
        if (change.before === undefined) throw new Error('No exact backup exists for this file. Older turns cannot be safely undone.');
        const before = change.before === null ? null : backupBytes(change.before);
        const exact = change.after === (current === null ? null : saveBytes(current));
        const after = exact ? current : change.after === null ? null : backupBytes({ hash: change.after, mode: 0o600 });
        current = mergeUndo(before, after, current);
        if (!exact) merged++;
        saved = current === null ? null : { hash: saveBytes(current), mode: saved?.mode ?? change.before?.mode ?? 0o644 };
      }
      target.set(file, saved);
    } catch (e: any) { conflicts.push({ file, reason: e.message || 'The file could not be safely merged.' }); }
  }
  if (conflicts.length) return { conflicts };
  const journal:UndoJournal={message,phase:'staged',rollback:[...rollback],target:[...target],history:(await history(s.id)).map(m=>m.id),remaining:turns.slice(0,from)};
  const saveJournal=()=>writeFileAtomic(journalFile(s.id),JSON.stringify(journal));saveJournal();
  const restore = new Map(files.map(file => { const saved = target.get(file)!; return [file, saved === null ? undefined : backupBytes(saved)] as const; }));
  const written: string[] = [];
  try {
    // Stage history only. OpenCode's file snapshots can contain normalized rather than actual bytes.
    await engine('POST', `/api/session/${enc(s.id)}/revert/stage`, { messageID: message, files: false });
    for (const file of files) {
      if (hashOf(s.folder, file) !== (rollback.get(file)?.hash ?? null)) throw new GatewayError('A file changed while undo was starting. Nothing was committed.', 409, 'agent_undo_conflict');
    }
    journal.phase='restoring';saveJournal();
    try {
      // Enrol before restore: replacement may succeed even when its final chmod fails.
      for (const file of files) { written.push(file); restoreFile(s.folder, file, target.get(file)!, restore.get(file)); }
      for (const file of files) if (!matchesBackup(s.folder, file, target.get(file)!)) throw new Error('The restored file failed verification.');
      journal.phase='committing';saveJournal();
      await engine('POST', `/api/session/${enc(s.id)}/revert/commit`);
    } catch (err) {
      if(journal.phase==='committing'){
        let outcome;try{outcome=await recoverUndo(s,true);}catch{throw new GatewayError('Undo commit or recovery could not be confirmed. Recovery information is saved. Retry after the engine reconnects.',409,'agent_undo_recovery');}
        if(outcome!=='committed')throw err;
      }else throw err;
    }
  } catch (err) {
    if(journal.phase!=='committing'){
      let uncertain=false;
      for(const file of [...written].reverse()){try{restoreFile(s.folder,file,rollback.get(file)!);}catch{uncertain=true;}}
      try{await engine('DELETE', `/api/session/${enc(s.id)}/revert`);}catch{uncertain=true;}
      for(const file of written){try{if(!matchesBackup(s.folder,file,rollback.get(file)!))uncertain=true;}catch{uncertain=true;}}
      if(!uncertain){try{unlinkSync(journalFile(s.id));}catch{uncertain=true;}}
      if(uncertain)throw new GatewayError('Undo failed and rollback could not be fully verified or staged history could not be cancelled. Recovery information is saved; reconnect when the engine is idle to recover it safely.',409,'agent_undo_recovery');
    }
    throw err;
  }
  s.turns = turns.slice(0, from); saveTurns(s); prune();
  try{unlinkSync(journalFile(s.id));}catch{}
  publish(s.id, { type: 'agent.undone', data: { sessionID: s.id, message, files } });
  logEvent('info', 'agent', `Agent turn undone: ${files.length} file(s) restored${merged ? ', non-overlapping edits preserved' : ''}`);
  return { files, merged: merged > 0 };
  } finally { s.undoing = false; }
}

// --- What the page asks for ---
// Reasoning effort, offered for models that reason: OpenCode names these variants of the model (its default when none is chosen).
const EFFORTS = ['low', 'medium', 'high'];
// Models the agent can be pinned to: able to call tools, from an enabled provider, not known to be gone. OpenCode Free only while the
// bridge presents the engine's own OpenCode version (agent-engine.ts).
export function agentModels() {
  const presented = presentedOpenCodeVersion();
  const individual=[...models.values()].filter(m => m.tools && m.state !== 'unavailable').flatMap(m => {
    const p = settings.providers.find(x => x.id === m.providerId && x.enabled); if (!p) return [];
    const reason = p.kind === 'free' ? freeIdentityProblem(presented) : '';
    return [{ id: m.id, name: m.name, provider: p.name, context: m.context, output: m.output, reasoning: m.reasoning, efforts: m.reasoning ? EFFORTS : [], usable: !reason, ...(reason ? { reason } : {}) }];
  });
  const chains=agentChains().map(c=>{const reason=c.reason||(c.free?freeIdentityProblem(presented):'');return {...c,usable:!reason,reason};});
  return [...individual,...chains].sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
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
// Folders sessions were started in, so every session can be listed whatever its folder. Folders given consent before this list existed
// come from the consent records. Gone folders are left out.
const foldersFile = () => path.join(enginePaths().root, 'folders.json');
function knownFolders(): string[] {
  let saved: unknown = [];
  try { saved = JSON.parse(readFileSync(foldersFile(), 'utf8')); } catch {}
  const out = new Map<string, string>();
  for (const f of [...(Array.isArray(saved) ? saved : []), ...trustedFolders()]) {
    if (typeof f !== 'string') continue;
    try { const key=folderKey(f); if (!out.has(key) && statSync(f).isDirectory()) out.set(key, f); } catch {}
  }
  return [...out.values()];
}
function rememberFolder(folder: string) {
  let saved: unknown = [];
  try { saved = JSON.parse(readFileSync(foldersFile(), 'utf8')); } catch {}
  const unique = new Map<string, string>();
  for (const f of [folder, ...(Array.isArray(saved) ? saved : [])]) if (typeof f === 'string' && !unique.has(folderKey(f))) unique.set(folderKey(f), f);
  const list = [...unique.values()].slice(0, 100);
  mkdirSync(path.dirname(foldersFile()), { recursive: true }); writeFileAtomic(foldersFile(), JSON.stringify(list));
}
// "No folder": a session that is not about a project gets an empty folder of its own, made by Polygate in the user's home folder (where
// the user can find what the agent wrote), allowed at once because nothing in it can be project customization. These folders are left
// out of the recent folders and listed as "No folder" on the page.
export const scratchRoot = () => process.env.POLYGATE_AGENT_SCRATCH || path.join(os.homedir(), 'Polygate Agent');
function scratchFolder() {
  const stamp = new Date().toISOString().replace('T', ' ').replace(/:/g, '-').slice(0, 19);
  let folder = path.join(scratchRoot(), stamp);
  for (let n = 2; existsSync(folder); n++) folder = path.join(scratchRoot(), `${stamp} (${n})`);
  mkdirSync(folder, { recursive: true });
  grantTrust(folder, inspectTrust(folder).fingerprint);
  return folder;
}
const isScratch = (folder: string) => inside(folder, scratchRoot());
function requireTrust(folder: string) {
  const trust = inspectTrust(folder);
  if (!trust.trusted) throw new GatewayError('Trust this working folder before the agent works in it.', 409, 'agent_trust_required');
}
// The skills the engine offers in a folder, once they are exactly the engine's own plus Polygate's saved ones. A save reaches the
// engine through its file watch a moment later, and anything changed in the skills folder outside Polygate is written back first.
async function engineSkills(folder: string) {
  for (let attempt = 0; ; attempt++) {
    const listed = await engine('GET', `/api/skill?directory=${enc(folder)}`);
    const problems = skillProblems(Array.isArray(listed) ? listed : []);
    if (!problems.length) return listed as any[];
    if (attempt === 0) syncSkills();
    if (attempt >= 15) throw new GatewayError(`The agent engine's skills do not match Polygate's library: ${problems.join('; ')}. Restart the engine from Agent settings.`, 409, 'agent_skills');
    await new Promise(r => setTimeout(r, 200));
  }
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
  const mode = checkMode(b.mode); const model = String(b.model || '');
  if (mode === 'full' && b.confirmFull !== true) throw new GatewayError(FULL_CONSENT, 400, 'agent_full_consent');
  const folder = checkFolder(b.noFolder === true && !b.folder ? scratchFolder() : b.folder);
  await requireEngineModel(folder, model);
  const entry = agentModels().find(m => m.id === model); if (entry?.reason) throw new GatewayError(entry.reason, 400, 'agent_model');
  const effort = checkEffort(entry, b.effort);
  requireTrust(folder);
  await clearSavedPermissions();
  if (!isScratch(folder)) rememberFolder(folder);
  await watchFolder(folder);
  const title = String(b.title || '').trim().slice(0, 120) || `New session ${new Date().toLocaleString()}`;
  const info = await engine('POST', '/api/session', { title, agent: ENGINE_MODES[mode].agent, model: { providerID: 'polygate', id: model, ...(effort ? { variant: effort } : {}) }, location: { directory: folder } });
  const s = session(info.id, folder); s.mode = mode;
  if (mode === 'full') { s.fullEngine = engineConnection()?.url; logEvent('warn', 'agent', 'Agent session started with Full access'); }
  return summary(info);
}
const FULL_CONSENT = 'Full access needs explicit confirmation: commands can access your files, network and Polygate data with your account access.';
// The engine knows the models that were in the catalog when it started. One added since (a new provider, a refreshed catalog) is given to
// it first: its model list is written again and the engine reloads it, which takes a moment.
const engineHas = async (folder: string, model: string) => { const list = await engine('GET', `/api/model${q(folder)}`); return (Array.isArray(list) ? list : []).some((m: any) => m.providerID === 'polygate' && m.id === model); };
async function requireEngineModel(folder: string, model: string) {
  const entry=agentModels().find(m=>m.id===model);
  if(settings.chains?.some(c=>c.name===model)&&(!entry||!entry.usable))throw new GatewayError(entry?.reason||'This model chain is switched off. Choose an enabled chain or model.',400,'agent_model');
  if (await engineHas(folder, model)) return;
  if (agentModels().some(m => m.id === model)) {
    syncEngineModels();
    for (const end = Date.now() + 8000; Date.now() < end;) { await Bun.sleep(200); if (await engineHas(folder, model)) return; }
  }
  throw new GatewayError('The agent engine does not have that model. Pick one from the list, or resync the models.', 400, 'agent_model');
}
// A session this process has not seen yet (Polygate restarted): its folder comes from the engine.
async function known(id: unknown) {
  const sid = String(id || ''); if (!sid) throw new GatewayError('Which session?', 400);
  const info = await engine('GET', `/api/session/${encodeURIComponent(sid)}`);
  const folder = info?.location?.directory || ''; const out = session(sid, folder);out.parent=info.parentID;
  if(!out.mode)out.mode = modeOf(info?.agent || '') || 'ask';
  if (out.mode === 'full'&&out.fullEngine!==engineConnection()?.url) { out.mode = 'ask';out.fullEngine=undefined; await engine('POST', `/api/session/${enc(sid)}/agent`, { agent: ENGINE_MODES.ask.agent }); }
  if (folder) await watchFolder(folder);
  const [active,pending]=await Promise.all([engine('GET','/api/session/active'),engine('GET',`/api/session/${enc(sid)}/permission`)]);
  for(const other of sessions.values())if(sameFolder(other.folder,folder))other.busy=!!active?.[other.id];
  out.busy=!!active?.[sid];
  const waiting=Array.isArray(pending)?pending:[];out.pending=new Map(waiting.map((d:any)=>[d.id,{id:d.id,action:d.action,resources:d.resources||[],note:noteFor(d.action,d.resources||[]),input:d.metadata?.input}]));
  if(out.recovering||(!out.busy&&!out.undoing))await recoverUndo(out);
  return out;
}

export async function agentApi(req: IncomingMessage, res: ServerResponse, pathname: string, readJson: (req: IncomingMessage, max?: number) => Promise<any>, json: (res: ServerResponse, status: number, body: unknown) => void) {
  const method = req.method; const url = new URL(req.url || '/', 'http://x');
  if(pathname==='/admin/agent/session/forms'&&method==='GET'){
    const s=await known(url.searchParams.get('id'));return json(res,200,{forms:await engine('GET',`/api/session/${enc(s.id)}/form`)});
  }
  if(pathname==='/admin/agent/session/form'&&method==='POST'){
    const b=await readJson(req),s=await known(b.id);const form=String(b.form||'');
    if(!/^frm_[A-Za-z0-9_-]+$/.test(form))throw new GatewayError('Choose a pending question.',400);
    if(b.cancel===true)await engine('DELETE',`/api/session/${enc(s.id)}/form/${enc(form)}`);
    else{requireTrust(s.folder);if(!b.answer||typeof b.answer!=='object'||Array.isArray(b.answer))throw new GatewayError('Answer the question fields.',400);await engine('POST',`/api/session/${enc(s.id)}/form/${enc(form)}/reply`,{answer:b.answer});}
    return json(res,200,{ok:true});
  }
  if (pathname === '/admin/agent/trust' && method === 'GET') return json(res, 200, inspectTrust(checkFolder(url.searchParams.get('folder'))));
  if (pathname === '/admin/agent/trust/allow' && method === 'POST') { const b = await readJson(req), folder = checkFolder(b.folder); try { const out = grantTrust(folder, String(b.fingerprint || '')); rememberFolder(folder); return json(res, 200, out); } catch (e: any) { throw new GatewayError(e.message, 409, 'agent_trust_changed'); } }
  if (pathname === '/admin/agent/trust/revoke' && method === 'POST') { const b = await readJson(req), folder = checkFolder(b.folder); revokeTrust(folder); for (const s of sessions.values()) if (sameFolder(s.folder, folder)) { stopTerminal(s.id); s.allowed.clear(); s.paused = 'Working folder consent was revoked. Trust the folder again before continuing.'; setAgentPause(s.id, s.paused); if (s.mode === 'full') expireFull(s); await engine('POST', `/api/session/${enc(s.id)}/interrupt`).catch(() => {}); publish(s.id, { type: 'agent.paused', data: { sessionID: s.id, message: s.paused } }); } return json(res, 200, { ok: true }); }
  // The folders sessions can be started in (and listed from), with whether the agent may work in each now.
  if (pathname === '/admin/agent/folders' && method === 'GET') return json(res, 200, { folders: knownFolders().filter(f => !isScratch(f)).map(folder => ({ folder, trusted: inspectTrust(folder).trusted })), scratch: scratchRoot() });
  if (pathname === '/admin/agent/session/git' && method === 'POST') {
    const b = await readJson(req), s = await known(b.id); requireTrust(s.folder);
    if (b.confirm !== true) throw new GatewayError('Confirm Git inspection first: repository clean filters may run with your account access.', 400, 'agent_git_consent');
    if (b.file !== undefined && typeof b.file !== 'string') throw new GatewayError('Choose a valid file.', 400);
    try { return json(res, 200, await inspectGit(s.folder, b.file)); }
    catch (e: any) { throw new GatewayError(e.message, 409, 'agent_git_inspection'); }
  }
  if (pathname === '/admin/agent/session/terminal' && method === 'GET') { const s=await known(url.searchParams.get('id')); return json(res,200,{terminal:terminalState(s.id)}); }
  if (pathname.startsWith('/admin/agent/session/terminal/') && method === 'POST') {
    const b=await readJson(req),s=await known(b.id);
    if(pathname.endsWith('/stop'))return json(res,200,{terminal:stopTerminal(s.id)});
    if(pathname.endsWith('/clear')){clearTerminal(s.id);return json(res,200,{terminal:null});}
    if(!pathname.endsWith('/run'))throw new GatewayError('Endpoint not found',404);
    requireTrust(s.folder);
    if(b.confirm!==true)throw new GatewayError('Confirm this terminal command first. It runs with your account access, outside the Agent permission mode.',400,'agent_terminal_consent');
    const active=await engine('GET','/api/session/active');
    const list=await engine('GET',`/api/session${q(s.folder)}`);
    if(s.busy||s.sending||s.undoing||folderConflict(s)||(Array.isArray(list)&&list.some(x=>active?.[x.id])))throw new GatewayError('Wait for agents in this folder to finish or stop them before running a terminal command.',409,'agent_busy');
    try{return json(res,200,{terminal:startTerminal(s.id,s.folder,String(b.command||''))});}catch(e:any){throw new GatewayError(e.message,409,'agent_terminal');}
  }
  // The system prompt and skills for every folder, with the engine's own skills (only while it runs: they come from the engine).
  if (pathname === '/admin/agent/library' && method === 'GET') {
    const builtin = engineConnection() ? (await engine('GET', `/api/skill?directory=${enc(enginePaths().home)}`).catch(() => []) as any[]).filter(isBuiltinSkill).map(k => ({ id: k.id, name: k.name, description: k.description || '' })) : [];
    return json(res, 200, { ...agentLibrary(), builtin });
  }
  if (pathname === '/admin/agent/library' && method === 'POST') {
    const b = await readJson(req, 400000);
    if (b.confirm !== true) throw new GatewayError('Confirm changes to the Agent system prompt and skills.', 400, 'agent_library_consent');
    try { return json(res, 200, saveAgentLibrary(b)); } catch (e: any) { throw new GatewayError(e.message, 409, 'agent_library'); }
  }
  // What the message box offers after "/": skills to attach (Polygate's and the engine's own) and, in an allowed folder, its templates.
  if (pathname === '/admin/agent/skills' && method === 'GET') {
    const folder = url.searchParams.get('folder') || '';
    const saved = agentLibrary().skills;
    // The skills are the same in every folder, so the engine is asked in its own home rather than in a folder not yet allowed.
    const listed = engineConnection() ? await engineSkills(enginePaths().home) : [];
    const skills = listed.map(k => { const own = saved.find(s => s.id === k.id); return { id: k.id, name: k.name, description: k.description || '', auto: k.autoinvoke !== false && !!k.description, source: own ? 'polygate' : 'builtin' }; });
    let templates: any[] = [];
    if (folder && existsSync(folder) && inspectTrust(folder).trusted) templates = projectPreferences(folder).templates;
    return json(res, 200, { running: !!engineConnection(), skills, templates });
  }
  if (pathname === '/admin/agent/mcp' && method === 'GET') return json(res, 200, agentMcpCatalog());
  if (pathname === '/admin/agent/mcp' && method === 'POST') {
    const b = await readJson(req);
    if (engineConnection() || ['starting', 'restarting', 'stopping'].includes(engineStatus().state)) throw new GatewayError('Stop the agent engine before changing shared MCP tools. Other clients are not affected.', 409, 'agent_mcp_busy');
    saveAgentMcpSelection(b.tools);
    for (const s of sessions.values()) s.allowed.clear();
    return json(res, 200, agentMcpCatalog());
  }
  // The engine's model list, written again from the catalog now (Resync in the model picker).
  if (pathname === '/admin/agent/models/sync' && method === 'POST') { await readJson(req); return json(res, 200, { ok: true, models: syncEngineModels() }); }
  if (pathname === '/admin/agent/models' && method === 'GET') return json(res, 200, { models: agentModels(), modes: Object.fromEntries(Object.entries(ENGINE_MODES).map(([k, m]) => [k, m.description])) });
  // One folder's sessions, or (no folder) every session in every folder the agent has worked in, newest first.
  if (pathname === '/admin/agent/sessions' && method === 'GET') {
    const one = url.searchParams.get('folder');
    const lists = await Promise.all((one ? [checkFolder(one)] : knownFolders()).map(folder => engine('GET', `/api/session${q(folder)}`).catch(() => [])));
    const seen = new Set<string>();
    const all = lists.flatMap(list => Array.isArray(list) ? list : []).filter((s: any) => s?.id && !seen.has(s.id) && seen.add(s.id));
    return json(res, 200, { sessions: all.filter((s:any)=>!s.parentID).map(summary).sort((a, b) => (b.created || 0) - (a.created || 0)) });
  }
  if (pathname === '/admin/agent/session/delete' && method === 'POST') {
    const s = await known((await readJson(req)).id);
    if(terminalState(s.id)?.running)throw new GatewayError('Stop the terminal before deleting this session.',409,'agent_terminal_busy');
    if (s.busy || s.sending || s.undoing) throw new GatewayError('Stop the agent before deleting this session.', 409, 'agent_busy');
    await engine('DELETE', `/api/session/${enc(s.id)}`);
    // Polygate's own records of it go too: its turns (and their undo), a waiting backup and a pause.
    sessions.delete(s.id); setAgentPause(s.id);
    for (const f of [turnsFile(s.id), pendingFile(s.id)]) { try { unlinkSync(f); } catch {} }
    pruneAgentBackups(true);
    publish(s.id, { type: 'agent.deleted', data: { sessionID: s.id } });
    eventJournals.delete(s.id);
    logEvent('info', 'agent', 'Agent session deleted');
    return json(res, 200, { ok: true });
  }
  if (pathname === '/admin/agent/session/create' && method === 'POST') return json(res, 200, await createSession(await readJson(req)));
  if (pathname === '/admin/agent/session' && method === 'GET') {
    const s = await known(url.searchParams.get('id'));
    const before = eventJournal(s.id).seq, streamBefore = { ...streamStates.get(s.folder) };
    // inbox: messages the engine holds and has not handed to the agent yet (queued ones show above the message box). Only user messages.
    const [info, messages, inbox] = await Promise.all([engine('GET', `/api/session/${encodeURIComponent(s.id)}`), history(s.id), engine('GET', `/api/session/${enc(s.id)}/inbox`).catch(() => [])]);
    const active = await engine('GET', '/api/session/active');
    const after = eventJournal(s.id).seq, stream = streamStates.get(s.folder);
    // These are controller capture boundaries, NOT an engine history watermark.
    const reconnect = { epoch: eventEpoch, before, after, stream: stream?.generation || 0, connected: !!stream?.connected, interrupted: !streamBefore.connected || !stream?.connected || streamBefore.generation !== stream?.generation };
    return json(res, 200, { session: { ...summary(info), mode: s.mode || modeOf(info?.agent || '') }, messages: messages || [], inbox: Array.isArray(inbox) ? inbox.filter((x: any) => x?.type === 'user') : [], pending: [...s.pending.values()], paused: s.paused || '', busy: !!active?.[s.id], usage: sessionUsage(s.id), reconnect });
  }
  // A message waiting in the queue: taken back (it never reaches the agent), or sent to the agent now as steering.
  if ((pathname === '/admin/agent/session/inbox/cancel' || pathname === '/admin/agent/session/inbox/steer') && method === 'POST') {
    const b = await readJson(req); const s = await known(b.id); const inbox = String(b.inbox || '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(inbox)) throw new GatewayError('Name the queued message.', 400, 'agent_inbox');
    const route = `/api/session/${enc(s.id)}/inbox/${enc(inbox)}`;
    if (pathname.endsWith('/cancel')) await engine('DELETE', route);
    else { requireTrust(s.folder); await engine('PATCH', route, { delivery: 'steer' }); }
    return json(res, 200, { ok: true });
  }
  if(pathname==='/admin/agent/session/children'&&method==='GET'){
    const parent=await known(url.searchParams.get('id'));requireTrust(parent.folder);
    const active=await engine('GET','/api/session/active');
    const childID=url.searchParams.get('child');
    const verified=async(id:string)=>{const info=await engine('GET',`/api/session/${enc(id)}`);if(info.parentID!==parent.id||path.resolve(info.location?.directory||'')!==path.resolve(parent.folder))throw new GatewayError('That is not a child of this session in the same working folder.',403,'agent_child');return info;};
    if(childID){const info=await verified(childID);return json(res,200,{session:{...summary(info),parentID:info.parentID},messages:await history(childID),pending:[...(sessions.get(childID)?.pending.values()||[])],busy:!!active?.[childID]});}
    const page=await engine('GET',`/api/session?parentID=${enc(parent.id)}&directory=${enc(parent.folder)}&limit=100`,undefined,true);
    const list=Array.isArray(page?.data)?page.data:[];
    return json(res,200,{children:list.filter((c:any)=>c.parentID===parent.id&&path.resolve(c.location?.directory||'')===path.resolve(parent.folder)).map((c:any)=>({...summary(c),parentID:parent.id,busy:!!active?.[c.id],pending:sessions.get(c.id)?.pending.size||0})),more:!!page?.cursor?.next});
  }
  if (pathname === '/admin/agent/session/project' && method === 'GET') {
    const s=await known(url.searchParams.get('id'));requireTrust(s.folder);
    return json(res,200,{...projectPreferences(s.folder),sources:projectSources(s.folder)});
  }
  if (pathname === '/admin/agent/session/project/source' && method === 'POST') {
    const b=await readJson(req),s=await known(b.id);requireTrust(s.folder);
    try{return json(res,200,readProjectSource(s.folder,String(b.path||''),String(b.hash||'')));}catch(e:any){throw new GatewayError(e.message,409,'agent_project_changed');}
  }
  if (pathname === '/admin/agent/session/project' && method === 'POST') {
    const b=await readJson(req,200000),s=await known(b.id);requireTrust(s.folder);
    if(b.confirm!==true)throw new GatewayError('Confirm changes to this folder’s Agent instructions and templates.',400,'agent_project_consent');
    if(s.busy||s.sending||s.undoing||terminalInFolder(s.folder)||folderConflict(s))throw new GatewayError('Wait for this folder to be idle before saving project preferences.',409,'agent_busy');
    try{return json(res,200,{...saveProjectPreferences(s.folder,b),sources:projectSources(s.folder)});}catch(e:any){throw new GatewayError(e.message,409,'agent_project');}
  }
  if (pathname === '/admin/agent/session/prompt' && method === 'POST') {
    const b = await readJson(req, 16 * 1024 * 1024); const s = await known(b.id); const text = String(b.text || '');
    if(terminalInFolder(s.folder))throw new GatewayError('Stop the terminal command in this folder or wait for it to finish before sending an agent message.',409,'agent_terminal_busy');
    let files; try { files = agentFiles(b.files); } catch (e: any) { throw new GatewayError(e.message, 400, 'agent_attachment'); }
    if (Buffer.byteLength(text) > 1024 * 1024) throw new GatewayError('Message text exceeds 1 MiB.', 413, 'request_too_large');
    // While the agent works, a message steers it (taken in at its next step) or waits in the queue for the end of the turn.
    const delivery = b.delivery === 'queue' ? 'queue' : 'steer';
    const picked = b.skills === undefined ? [] : b.skills;
    if (!Array.isArray(picked) || picked.length > 10 || picked.some((k: unknown) => typeof k !== 'string') || new Set(picked).size !== picked.length) throw new GatewayError('Attach up to 10 different skills.', 400, 'agent_skill');
    if (!text.trim() && !files.length && !picked.length) throw new GatewayError('Write a message or attach a file first.', 400);
    requireTrust(s.folder);
    if (s.undoing || s.sending) throw new GatewayError('Wait for the current action to finish before sending another message.', 409, 'agent_busy');
    s.sending = true;
    try {
    await s.recording;
    if(existsSync(journalFile(s.id)))throw new GatewayError('Resolve the interrupted Undo before sending more work. Reconnect when the engine is idle to recover it safely.',409,'agent_undo_recovery');
    if([...sessions.values()].some(x=>x.id!==s.id&&sameFolder(x.folder,s.folder)&&(x.undoing||x.sending)))throw new GatewayError('Another session in this folder is changing a backup boundary. Wait for it to finish.',409,'agent_busy');
    if(folderConflict(s)){s.unsafeTurn='busy';for(const other of sessions.values())if(other.id!==s.id&&sameFolder(other.folder,s.folder)&&other.busy)other.unsafeTurn='busy';}
    // A restarted engine may have captured an incomplete catalog. Restore this session's pin before enqueueing any work.
    const pinned = await engine('GET', `/api/session/${enc(s.id)}`);
    const pinnedId = pinned?.model?.modelID || pinned?.model?.id;
    if (pinnedId) {
      const saved = models.get(pinnedId);
      if (saved?.state === 'unavailable' && saved.error === 'Absent from latest provider catalog') {
        await discover().catch(() => {});
        if (models.get(pinnedId)?.state === 'unavailable' && settings.providers.some(p => p.id === saved.providerId && p.enabled && p.kind === 'openai')) {
          const { probeModel } = await import('./gateway'); await probeModel(pinnedId);
        }
      }
      await requireEngineModel(s.folder, pinnedId);
    }
    await requireSharedMcp(s.folder);
    // Skills the user attached, by the names the engine has for them; only skills it offers from Polygate's library or its own.
    const offered = picked.length ? await engineSkills(s.folder) : [];
    const skills = picked.map((id: string) => { const k = offered.find(x => x.id === id); if (!k) throw new GatewayError(`The skill ${id} is not available. Refresh the skill list.`, 409, 'agent_skill'); return { id: k.id, name: k.name }; });
    // Apply reviewed plain-text preferences as API-managed entries, never by enabling repository config/plugins: the system prompt
    // from Agent settings for every folder, then this folder's own instructions.
    const entries: [string, string, string][] = [['polygate-global', agentLibrary().instructions, 'Polygate Agent system prompt'], ['polygate-project', projectPreferences(s.folder).instructions, 'Polygate project preferences']];
    for (const [key, value, source] of entries) {
      const entry = `/api/experimental/session/${enc(s.id)}/instructions/entries/${key}`;
      if (value.trim()) await engine('PUT', entry, { value: { text: value, source } }); else await engine('DELETE', entry);
    }
    // Folder backups (for Undo) are off unless switched on: then nothing is copied, and turns are recorded without undo.
    if(s.busy)s.unsafeTurn=s.unsafeTurn||'busy';else if(!folderConflict(s))s.unsafeTurn=undefined;
    if (!s.busy && settings.agentBackups === true) {
      s.backup = await captureBackup(s.folder);
      mkdirSync(path.dirname(pendingFile(s.id)), { recursive: true });
      writeFileAtomic(pendingFile(s.id), JSON.stringify(s.backup));
    } else if (!s.busy) {
      // A backup left from before (switched off since, or from before a restart) must not stand for this turn's starting point.
      s.backup = undefined; try { unlinkSync(pendingFile(s.id)); } catch {}
    }
    s.retries = 0; s.paused = undefined; setAgentPause(s.id);
    // limited: the folder is bigger than one backup covers, so the page says that some changes cannot be undone from Polygate.
    const attachments = engineFiles(files);
    return json(res, 200, { ok: true, message: await engine('POST', `/api/session/${encodeURIComponent(s.id)}/prompt`, { text, delivery, ...(attachments.length ? { files: attachments } : {}), ...(skills.length ? { skills } : {}) }), ...(s.backup?.limited ? { limited: true } : {}) });
    } finally { s.sending = false; }
  }
  if (pathname === '/admin/agent/session/approve' && method === 'POST') {
    const b = await readJson(req); const s = await known(b.id); const decision = String(b.decision || '');
    if (!['once', 'session', 'project', 'deny'].includes(decision)) throw new GatewayError('Answer once, session, project or deny.', 400, 'agent_decision');
    const p = s.pending.get(String(b.request || '')); if (!p) throw new GatewayError('That request is no longer waiting for an answer.', 404, 'agent_request_gone');
    if (p.action.startsWith('polygate_shared_') && ['session', 'project'].includes(decision)) throw new GatewayError('MCP tool calls can be allowed once or denied. Use Full access explicitly if you want automatic calls.', 400);
    if (decision !== 'deny') requireTrust(s.folder);
    if (s.mode === 'plan' && (['shell', 'edit', 'subagent'].includes(p.action) || p.action.startsWith('polygate_shared_')) && decision !== 'deny') throw new GatewayError('Leave Plan mode before approving changes, commands or MCP calls.', 409, 'agent_plan');
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
    return json(res, 200, { ok: true, files: out.files, merged: out.merged });
  }
  // Another model for a session, typically one that is paused because its model keeps failing. Same checks as a new session.
  if (pathname === '/admin/agent/session/model' && method === 'POST') {
    const b = await readJson(req); const s = await known(b.id); const model = String(b.model || '');
    const entry = agentModels().find(m => m.id === model);
    if (!entry) throw new GatewayError('The agent cannot use that model: it is unknown, cannot call tools, or its provider is switched off.', 400, 'agent_model');
    if (entry.reason) throw new GatewayError(entry.reason, 400, 'agent_model');
    const effort = checkEffort(entry, b.effort);
    await requireEngineModel(s.folder, model);
    await engine('POST', `/api/session/${enc(s.id)}/model`, { model: { providerID: 'polygate', id: model, ...(effort ? { variant: effort } : {}) } });
    s.paused = undefined; setAgentPause(s.id); s.retries = 0; return json(res, 200, { ok: true });
  }
  if (pathname === '/admin/agent/session/rename' && method === 'POST') {
    const b = await readJson(req); const s = await known(b.id); const title = String(b.title || '').trim().slice(0, 120);
    if (!title) throw new GatewayError('Give the session a name.', 400);
    await engine('PATCH', `/api/session/${enc(s.id)}`, { title }); return json(res, 200, { ok: true, title });
  }
  if (pathname === '/admin/agent/session/cancel' && method === 'POST') { const s = await known((await readJson(req)).id); await engine('POST', `/api/session/${encodeURIComponent(s.id)}/interrupt`); return json(res, 200, { ok: true }); }
  if (pathname === '/admin/agent/session/mode' && method === 'POST') {
    const b = await readJson(req); const mode = checkMode(b.mode); const s = await known(b.id);
    requireTrust(s.folder);
    if (s.busy || s.sending || s.undoing || s.pending.size) throw new GatewayError('Stop the turn and resolve pending approvals before changing mode.', 409, 'agent_busy');
    if (mode === 'full' && b.confirmFull !== true) throw new GatewayError(FULL_CONSENT, 400, 'agent_full_consent');
    await engine('POST', `/api/session/${encodeURIComponent(s.id)}/agent`, { agent: ENGINE_MODES[mode].agent });
    // Full access belongs to this engine run: it stays until the mode is changed, and ends when the app or the engine restarts. No time limit.
    s.fullEngine = mode === 'full' ? engineConnection()?.url : undefined; s.allowed.clear(); s.mode = mode;
    publish(s.id, { type: 'agent.mode', data: { sessionID: s.id, mode } });
    return json(res, 200, { ok: true, mode });
  }
  if (pathname === '/admin/agent/rules' && method === 'GET') { const s = await known(url.searchParams.get('id')); return json(res, 200, { rules: projectRules(s.folder), inspections: inspectionCommands() }); }
  if (pathname === '/admin/agent/rules/remove' && method === 'POST') { const b = await readJson(req), s = await known(b.id); removeProjectRule(s.folder, String(b.rule || '')); return json(res, 200, { ok: true }); }
  if (pathname === '/admin/agent/events' && method === 'GET') {
    const s = await known(url.searchParams.get('id'));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const journal = eventJournal(s.id), last = String(req.headers['last-event-id'] || ''), split = last.lastIndexOf(':'), epoch = last.slice(0, split), seq = Number(last.slice(split + 1));
    const replay = !!last && epoch === eventEpoch && Number.isSafeInteger(seq) && seq >= 0 && seq <= journal.seq && seq >= (journal.entries[0]?.seq ?? journal.seq + 1) - 1;
    // Replay and listener registration are synchronous: capture cannot fall into a subscription gap.
    if (replay) { for (const entry of journal.entries) if (entry.seq > seq) res.write(entry.text); }
    else res.write(`data: ${JSON.stringify({ type: 'agent.replay', data: { reset: true, epoch: eventEpoch, seq: journal.seq } })}\n\n`);
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
export function stopAgent() { stopAllTerminals(); for (const s of sessions.values()) { if (s.mode === 'full') { s.mode = 'ask'; s.fullEngine = undefined; } s.allowed.clear(); } for (const f of folders.values()) f.abort.abort(); folders.clear(); }
