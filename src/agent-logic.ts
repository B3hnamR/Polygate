// The Agent page's transcript: a session's history (from /admin/agent/session) and its live events (from /admin/agent/events), turned
// into the items the page draws. No React here, so tests/agent-logic.test.ts can check it on its own.
import { plainError } from '../backend/plain-error';
import type { AgentFile } from '../backend/agent-attachments';
import { fromEngineFiles } from '../backend/agent-attachments';
export type { AgentFile } from '../backend/agent-attachments';

export type Mode = 'ask' | 'accept-edits' | 'plan' | 'rules' | 'full';
export const MODES: { id: Mode; label: string }[] = [{ id: 'ask', label: 'Ask for approval' }, { id: 'accept-edits', label: 'Accept edits' }, { id: 'plan', label: 'Plan' }, { id: 'rules', label: 'Rules-based approvals' }, { id: 'full', label: 'Full access' }];
export const modeLabel = (id: string) => MODES.find(m => m.id === id)?.label || id;
const AGENT_MODES: Record<string, Mode> = { 'polygate-ask': 'ask', 'polygate-accept-edits': 'accept-edits', 'polygate-plan': 'plan', 'polygate-rules': 'rules', 'polygate-full': 'full' };

export type ToolStatus = 'preparing' | 'running' | 'done' | 'failed';
export type Item =
  | { kind: 'user'; key: string; text: string; files?: AgentFile[]; skills?: { id: string; name: string }[] }
  // A message sent with "queue" while the agent worked: shown above the message box, not in the conversation, until the agent takes it in.
  | { kind: 'queued'; key: string; text: string; files?: AgentFile[]; skills?: { id: string; name: string }[] }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'reasoning'; key: string; text: string; done: boolean }
  | { kind: 'tool'; key: string; name: string; input?: any; metadata?: any; status: ToolStatus; output?: string; error?: string }
  | { kind: 'note'; key: string; tone: 'info' | 'warn' | 'bad'; text: string }
  | { kind: 'changes'; key: string; message: string; files: FileChange[]; undoable: boolean; why?: string };
export type Approval = { id: string; action: string; resources: string[]; note: string; input?: unknown };
export type FileChange = { file: string; status: string; additions: number; deletions: number; patch: string };
// undoable false (and why) when Polygate kept no exact backup from before the turn, e.g. while folder backups were off.
export type Turn = { message: string; at: number; files: FileChange[]; undoable?: boolean; why?: string };

// A turn's changed files go at the end of that turn: just before the next message the user sent, or at the end.
export function withChanges(items: Item[], turns: Turn[]): Item[] {
  let out: Item[] = items.filter(i => i.kind !== 'changes');
  for (const t of turns) {
    const card: Item = { kind: 'changes', key: `changes:${t.message}`, message: t.message, files: t.files, undoable: t.undoable !== false, ...(t.why ? { why: t.why } : {}) };
    const at = out.findIndex(i => i.key === t.message);
    const next = at < 0 ? -1 : out.findIndex((i, n) => n > at && i.kind === 'user');
    out = next < 0 ? [...out, card] : [...out.slice(0, next), card, ...out.slice(next)];
  }
  return out;
}

// Skills attached to a message: only their names are shown (their full text went to the model, not into the conversation view).
const skillsOf = (list: unknown) => { const skills = Array.isArray(list) ? list.filter((k: any) => typeof k?.id === 'string').map((k: any) => ({ id: k.id, name: String(k.name || k.id) })) : []; return skills.length ? { skills } : {}; };
const textOf = (content: unknown) => Array.isArray(content) ? content.map((c: any) => typeof c?.text === 'string' ? c.text : '').join('') : typeof content === 'string' ? content : '';
const filesOf = (value: unknown) => { const files = fromEngineFiles(value); return files.length ? { files } : {}; };

export function fromHistory(messages: any[]): Item[] {
  const out: Item[] = [];
  for (const m of messages || []) {
    if (m?.type === 'user') out.push({ kind: 'user', key: m.id, text: String(m.text ?? textOf(m.content)), ...filesOf(m.files), ...skillsOf(m.skills) });
    else if (m?.type === 'assistant') {
      // Projected content has no ordinal field. Live ordinals count text and reasoning independently.
      let text = 0, reasoning = 0;
      (m.content || []).forEach((c: any, i: number) => {
        const key = c?.type==='text'?`${m.id}:t${text++}`:c?.type==='reasoning'?`${m.id}:r${reasoning++}`:`${m.id}:${i}`;
        if (c?.type === 'text' && typeof c.text === 'string') out.push({ kind: 'text', key, text: c.text });
        else if (c?.type === 'reasoning' && typeof c.text === 'string') out.push({ kind: 'reasoning', key, text: c.text, done: true });
        else if (c?.type === 'tool') {
          const st = c.state || {}; const status: ToolStatus = st.status === 'completed' ? 'done' : st.status === 'error' || st.status === 'failed' ? 'failed' : 'running';
          out.push({ kind: 'tool', key: c.id || key, name: c.name || 'tool', input: st.input, metadata:st.metadata, status, output: textOf(st.content), error: st.error?.message || (typeof st.error === 'string' ? st.error : undefined) });
        }
      });
    }
    else if (m?.type === 'idle' && (m.outcome === 'failed' || m.outcome === 'interrupted')) out.push({ kind: 'note', key: m.id, tone: m.outcome === 'failed' ? 'bad' : 'info', text: m.outcome === 'failed' ? 'This turn failed.' : 'Stopped.' });
    else if (m?.type === 'agent-switched' && AGENT_MODES[m.agent] && AGENT_MODES[m.agent] !== 'full') out.push({ kind: 'note', key: m.id, tone: 'info', text: `Mode: ${modeLabel(AGENT_MODES[m.agent])}` });
  }
  return out;
}

// A message the engine holds and has not handed to the agent yet (its inbox): a steering one shows in the conversation, as it is
// about to be taken in; a queued one waits above the message box.
const inboxItem = (id: string, item: any): Item | null => item?.type !== 'user' ? null : { kind: item.delivery === 'queue' ? 'queued' : 'user', key: id, text: String(item.payload?.text ?? ''), ...filesOf(item.payload?.files), ...skillsOf(item.payload?.skills) };
export const fromInbox = (list: any[]): Item[] => (list || []).flatMap(x => { const i = inboxItem(String(x?.id || ''), x); return i && i.key ? [i] : []; });
// A queued message the agent now takes in (or that is switched to steer) joins the conversation at its end.
const intoConversation = (items: Item[], key: string): Item[] => {
  const i = items.findIndex(x => x.key === key && x.kind === 'queued'); if (i < 0) return items;
  return [...items.slice(0, i), ...items.slice(i + 1), { ...items[i], kind: 'user' } as Item];
};
export const isQueued = (i: Item): i is Extract<Item, { kind: 'queued' }> => i.kind === 'queued';
// Both revision and value must match: editing away and back still creates a new draft.
export const clearSubmitted = <T,>(current: T, submitted: T, empty: T, revision: number, submittedRevision: number): T => revision === submittedRevision && current === submitted ? empty : current;
// Canonical folder paths need not equal the entered alias. Only the current request may adopt one.
export const currentTrustReport = <T extends { folder: string }>(report: T, request: number, current: number): T | null => request === current ? report : null;
// History has no event watermark. Re-fetch ambiguous parts instead of guessing how much of a delta it contains.
export function snapshotEvents(snapshot: Item[], events: any[]): { events: any[]; refresh: boolean } {
  const keys = new Set(snapshot.map(i => i.key));
  const ended = new Set(events.filter(e => /^session\.(text|reasoning)\.ended$/.test(e.type) && typeof e.data?.text === 'string').map(e => `${e.data.assistantMessageID}:${e.type.includes('reasoning') ? 'r' : 't'}${e.data.ordinal ?? 0}`));
  let refresh = false;
  const safe = events.filter(e => {
    if (!/^session\.(text|reasoning)\.delta$/.test(e.type)) return true;
    const d = e.data || {}, key = `${d.assistantMessageID}:${e.type.includes('reasoning') ? 'r' : 't'}${d.ordinal ?? 0}`;
    if (ended.has(key)) return false;
    if (!keys.has(key)) return true;
    refresh = true; return false;
  });
  return { events: safe, refresh };
}
export type SnapshotBoundary = { epoch: string; before: number; after: number; stream: number; connected: boolean; interrupted: boolean };
// A capture sequence orders controller events, not the engine's asynchronous history projection.
// Keep every snapshot part behind a barrier even after the response: its next delta may already be in history.
export function reconnectConsistency() {
  let generation = 0, epoch = '', seq = 0, syncing = true;
  let buffered: any[] = [], parts = new Set<string>(), fresh = new Set<string>(), overflow = false;
  const authoritative = new Map<string, any>();
  const part = (e: any) => /^session\.(text|reasoning)\./.test(e.type) ? `${e.data?.assistantMessageID}:${e.type.includes('reasoning') ? 'r' : 't'}${e.data?.ordinal ?? 0}` : '';
  const filter = (event: any) => {
    const key = part(event);
    if (/^session\.(text|reasoning)\.started$/.test(event.type) && !parts.has(key)) fresh.add(key);
    if (/^session\.(text|reasoning)\.ended$/.test(event.type) && typeof event.data?.text === 'string') { parts.add(key); fresh.delete(key); authoritative.set(key, event); return { event, refresh: false }; }
    if (/^session\.(text|reasoning)\.delta$/.test(event.type) && (parts.has(key) || !fresh.has(key))) { parts.add(key); return { refresh: true }; }
    return { event, refresh: false };
  };
  return {
    begin() { syncing = true; return ++generation; },
    invalidate(clear = false) { syncing = true; if (clear) { authoritative.clear(); buffered = []; } return ++generation; },
    receive(event: any): { event?: any; refresh: boolean } {
      const cursor = event.controller;
      if (cursor) {
        if (cursor.epoch === epoch && cursor.seq <= seq) return { refresh: false };
        if (cursor.epoch !== epoch) { epoch = cursor.epoch; seq = 0; authoritative.clear(); }
        seq = cursor.seq;
      }
      if (syncing) { buffered.push(event); if (buffered.length > 4096) { buffered.shift(); overflow = true; } return { refresh: false }; }
      return filter(event);
    },
    install(request: number, snapshot: Item[], boundary: SnapshotBoundary): { events: any[]; refresh: boolean } | null {
      if (request !== generation) return null;
      parts = new Set(snapshot.filter(i => i.kind === 'text' || i.kind === 'reasoning').map(i => i.key));
      fresh = new Set();
      const events: any[] = [...authoritative.values()].filter(event => event.controller?.epoch === boundary.epoch);
      for (const event of events) parts.add(part(event));
      let refresh = overflow || boundary.interrupted || !boundary.connected;
      for (const event of buffered) {
        if (event.type === 'agent.state') continue; // The installed snapshot is newer than the subscription's initial state.
        if (event.controller?.epoch !== undefined && event.controller.epoch !== boundary.epoch) continue;
        if (event.controller?.seq <= boundary.before) {
          if (/^session\.(text|reasoning)\.ended$/.test(event.type)) { const next = filter(event); if (next.event) events.push(next.event); }
          else refresh = true;
          continue;
        }
        // State/tool transitions captured during the fetch may already be projected. Reconcile rather than regress them.
        if (event.controller?.seq <= boundary.after && !/^session\.(text|reasoning)\.ended$/.test(event.type)) { const key = part(event); if (key) parts.add(key); refresh = true; continue; }
        const next = filter(event); if (next.event) events.push(next.event); refresh ||= next.refresh;
      }
      epoch = boundary.epoch; seq = Math.max(boundary.after, ...buffered.filter(e => e.controller?.epoch === boundary.epoch).map(e => e.controller.seq)); buffered = []; overflow = false; syncing = false;
      return { events, refresh };
    },
  };
}
// Ambiguity waits for quiet output, not a polling loop during a slow, continuously streaming snapshot.
export function snapshotRepair(refresh: () => void, clock = {
  now: () => Date.now(),
  set: (fn: () => void, delay: number): unknown => setTimeout(fn, delay),
  clear: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}) {
  let timer: unknown, pending = false, running = false, closed = false, ended = false;
  let lastDelta = -Infinity, retryAt = 0, failures = 0;
  const cancel = () => { if (timer !== undefined) clock.clear(timer); timer = undefined; };
  const arm = () => {
    cancel();
    if (closed || running || !pending || failures > 3) return;
    const wait = Math.max(0, retryAt - clock.now(), ended ? 0 : lastDelta + 500 - clock.now());
    timer = clock.set(() => { timer = undefined; refresh(); }, wait);
  };
  return {
    delta() { lastDelta = clock.now(); ended = false; if (pending) arm(); },
    request(immediate = false) { pending = true; if (immediate) ended = true; arm(); },
    begin() { cancel(); running = true; pending = false; },
    complete(ambiguous: boolean) { running = false; failures = 0; retryAt = 0; pending = pending || ambiguous; arm(); },
    failed() { running = false; pending = true; failures++; retryAt = clock.now() + 1000 * 2 ** (failures - 1); arm(); },
    dispose() { closed = true; cancel(); },
  };
}
// One live event applied to the transcript. Returns the same array when nothing changed.
export function applyEvent(items: Item[], e: any): Item[] {
  const d = e?.data || {};
  const upsert = <T extends Item>(key: string, make: () => T, change: (x: T) => T): Item[] => {
    const i = items.findIndex(x => x.key === key);
    if (i < 0) return [...items, change(make())];
    const next = items.slice(); next[i] = change(items[i] as T); return next;
  };
  const part = (kind: 't' | 'r') => `${d.assistantMessageID}:${kind}${d.ordinal ?? 0}`;
  switch (e?.type) {
    case 'session.inbox.enqueued': {
      const next = inboxItem(d.inboxID, d.item);
      return !next || items.some(x => x.key === d.inboxID) ? items : [...items, next];
    }
    case 'session.inbox.delivered': return intoConversation(items, d.inboxID);
    case 'session.inbox.cancelled': { const i = items.findIndex(x => x.key === d.inboxID && (x.kind === 'queued' || x.kind === 'user')); return i < 0 ? items : [...items.slice(0, i), ...items.slice(i + 1)]; }
    case 'session.inbox.delivery.changed': {
      if (d.delivery === 'steer') return intoConversation(items, d.inboxID);
      const i = items.findIndex(x => x.key === d.inboxID && x.kind === 'user'); if (i < 0) return items;
      return [...items.slice(0, i), ...items.slice(i + 1), { ...items[i], kind: 'queued' } as Item];
    }
    case 'session.text.started': return upsert(part('t'), () => ({ kind: 'text', key: part('t'), text: '' }), x => x);
    case 'session.text.delta': return upsert(part('t'), () => ({ kind: 'text', key: part('t'), text: '' }), x => ({ ...x, text: x.text + String(d.delta ?? '') }));
    case 'session.text.ended': return typeof d.text === 'string' ? upsert(part('t'), () => ({ kind: 'text', key: part('t'), text: '' }), x => ({ ...x, text: d.text })) : items;
    case 'session.reasoning.started': return upsert(part('r'), () => ({ kind: 'reasoning', key: part('r'), text: '', done: false }), x => x);
    case 'session.reasoning.delta': return upsert(part('r'), () => ({ kind: 'reasoning', key: part('r'), text: '', done: false }), x => ({ ...x, text: x.text + String(d.delta ?? '') }));
    case 'session.reasoning.ended': return upsert(part('r'), () => ({ kind: 'reasoning', key: part('r'), text: '', done: true }), x => ({ ...x, text: typeof d.text === 'string' ? d.text : x.text, done: true }));
    case 'session.tool.input.started': return upsert(d.id, () => ({ kind: 'tool', key: d.id, name: d.name || 'tool', status: 'preparing' as ToolStatus }), x => x);
    case 'session.tool.called': return upsert(d.id, () => ({ kind: 'tool', key: d.id, name: 'tool', status: 'running' as ToolStatus }), x => x.status === 'done' || x.status === 'failed' ? x : ({ ...x, input: d.input, status: 'running' }));
    case 'session.tool.progress': return upsert(d.id, () => ({ kind: 'tool', key: d.id, name: 'tool', status: 'running' as ToolStatus }), x => x.status === 'done' || x.status === 'failed' ? x : ({ ...x, metadata:d.metadata }));
    case 'session.tool.success': return upsert(d.id, () => ({ kind: 'tool', key: d.id, name: 'tool', status: 'done' as ToolStatus }), x => ({ ...x, status: 'done', metadata:d.metadata, output: textOf(d.content) }));
    case 'session.tool.failed': return upsert(d.id, () => ({ kind: 'tool', key: d.id, name: 'tool', status: 'failed' as ToolStatus }), x => ({ ...x, status: 'failed', metadata:d.metadata, error: d.error?.message || 'Failed' }));
    // In Full access every action is answered yes: the steps already show what was done, so there is no note for each.
    case 'agent.approval.auto': if (d.reason === 'Full access') return items; return [...items, { kind: 'note', key: `auto:${d.requestID}`, tone: 'info', text: `${d.reason || 'Allowed for this session'}: ${(d.resources || []).join(', ')}` }];
    case 'agent.approval.blocked': return [...items, { kind: 'note', key: `blocked:${d.requestID}`, tone: 'bad', text: `Blocked by permission rules: ${(d.resources || []).join(', ')}` }];
    case 'agent.mode': return d.mode === 'full' ? items : [...items, { kind: 'note', key: `mode:${e.id || items.length}`, tone: 'info', text: d.reason || `Mode: ${modeLabel(d.mode)}` }];
    // One note per turn for model retries, updated in place rather than one line per attempt.
    case 'session.retry.scheduled': return upsert('retry', () => ({ kind: 'note', key: 'retry', tone: 'warn', text: '' }), x => ({ ...x, text: `The model request failed: ${d.error?.message ? plainError(d.error.message) : 'no reason given'}. Trying again (attempt ${d.attempt ?? '?'}).` }));
    case 'session.execution.started': return items.filter(x => x.key !== 'retry');
    case 'session.execution.failed': return [...items.filter(x => x.key !== 'retry'), { kind: 'note', key: `failed:${e.id || items.length}`, tone: 'bad', text: d.error?.message ? `This turn failed: ${plainError(d.error.message)}` : 'This turn failed.' }];
    case 'session.execution.interrupted': return [...items.filter(x => x.key !== 'retry'), { kind: 'note', key: `stopped:${e.id || items.length}`, tone: 'info', text: 'Stopped.' }];
    // The engine's own word that the mode changed is not shown live: Polygate makes every mode change and says so (agent.mode), with its reason.
    case 'session.agent.selected': return items;
    // Polygate's record of what a turn changed (at the end of the turn; again, merged, if the same message runs once more).
    case 'agent.changes': {
      const t = d.turn; if (!t?.message) return items;
      const key = `changes:${t.message}`; const card: Item = { kind: 'changes', key, message: t.message, files: t.files || [], undoable: t.undoable !== false, ...(t.why ? { why: t.why } : {}) };
      return items.some(x => x.key === key) ? items.map(x => x.key === key ? card : x) : [...items, card];
    }
    default: return items;
  }
}

// What an approval card says about the request, in plain words.
export function approvalTitle(action: string) {
  return ({ shell: 'Run a command', edit: 'Change files', external_directory: 'Use a folder outside the working folder', webfetch: 'Fetch a web page', websearch: 'Search the web', subagent: 'Start a helper agent', read: 'Read a file' } as Record<string, string>)[action] || `Use ${action}`;
}
// The one line that says what a tool call is about. A path inside the working folder is shown relative to it.
export function toolSubject(name: string, input: any, folder = '') {
  if (!input || typeof input !== 'object') return '';
  const v = input.command ?? input.path ?? input.filePath ?? input.pattern ?? input.url ?? input.query ?? input.description;
  if (typeof v !== 'string') return JSON.stringify(input).slice(0, 200);
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (folder && (input.path ?? input.filePath) === v) {
    const base = norm(folder); const here = norm(v);
    if (here === base) return '.';
    if (here.startsWith(base + '/')) return v.replace(/\\/g, '/').slice(base.length + 1);
  }
  return v;
}

// Undoing a turn goes back through every later turn as well, so a turn can be undone only when it and every later one can. Returns why
// not, per turn message, for those that cannot.
export function undoBlocked(items: Item[]): Map<string, string> {
  const out = new Map<string, string>(); let later = '';
  const cards = items.filter((i): i is Extract<Item, { kind: 'changes' }> => i.kind === 'changes');
  for (const c of [...cards].reverse()) {
    if (!c.undoable) { out.set(c.message, c.why || 'This turn cannot be undone from Polygate.'); later = later || 'Undo also goes back through the later turns, and a later turn cannot be undone.'; }
    else if (later) out.set(c.message, later);
  }
  return out;
}

// The model picker: providers with how many models each offers, and the models of one provider (or all) matching a search.
type PickModel = { id: string; name: string; provider: string; usable: boolean };
export function modelProviders<T extends PickModel>(models: T[]) {
  const out = new Map<string, { name: string; count: number; usable: number }>();
  for (const m of models) { const p = out.get(m.provider) || { name: m.provider, count: 0, usable: 0 }; p.count++; if (m.usable) p.usable++; out.set(m.provider, p); }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
// A forgiving search: every word of it has to be found in the model's name, id or provider, as typed, or ignoring separators ("opus55"
// finds claude-opus-5-5, "gpt61" finds gpt-6.1), or as letters in order within the name or id ("cop" finds claude-opus). Matches that
// start a name or a word come first, then plain ones, then the letters-in-order ones; usable models before the others.
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
// The letters of `needle` in order within a short stretch of `hay` (at most about twice its length), so they read as an abbreviation.
const inOrder = (needle: string, hay: string) => {
  for (let start = hay.indexOf(needle[0]); start >= 0; start = hay.indexOf(needle[0], start + 1)) {
    let i = 1, at = start;
    while (i < needle.length && (at = hay.indexOf(needle[i], at + 1)) >= 0 && at - start < needle.length * 2 + 2) i++;
    if (i === needle.length) return true;
  }
  return false;
};
function matchScore(m: PickModel, words: string[]): number | null {
  const name = m.name.toLowerCase(), id = m.id.toLowerCase(), all = `${name} ${id} ${m.provider.toLowerCase()}`;
  // Letters in order are looked for in the name and the id without its provider prefix ("9rhit2/…"), which would match nearly anything.
  const flat = squash(all), names = [squash(m.name), squash(m.id.split('/').slice(1).join('/') || m.id)];
  let score = 0;
  for (const w of words) {
    const sw = squash(w);
    if (!sw) continue;
    if (name.startsWith(w) || id.split('/').pop()!.startsWith(w)) score += 6;
    else if (new RegExp(`(^|[^a-z0-9])${sw.replace(/[^a-z0-9]/g, '')}`).test(all)) score += 5;
    // Inside a word only from three letters on: two letters ("hi") turn up inside nearly every name.
    else if (w.length > 2 && all.includes(w)) score += 4;
    else if (w.length > 2 && flat.includes(sw)) score += 3;
    else if (sw.length > 2 && names.some(n => inOrder(sw, n))) score += 1;
    else return null;
  }
  return score;
}
export function matchModels<T extends PickModel>(models: T[], provider: string, query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found = models.filter(m => !provider || m.provider === provider).map((m, i) => ({ m, i, s: matchScore(m, words) })).filter(x => x.s !== null);
  found.sort((a, b) => Number(b.m.usable) - Number(a.m.usable) || b.s! - a.s! || a.i - b.i);
  return found.map(x => x.m);
}
// A folder's last part, for the session list's group headings (the full path is shown on hover).
export const folderName = (folder: string) => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder;

// The transcript as the page draws it: runs of tool calls fold into one line of steps, like a chat app's "Ran 2 commands, read a.ts".
export type Tool = Extract<Item, { kind: 'tool' }>;
export type Block = Exclude<Item, Tool> | { kind: 'steps'; key: string; tools: Tool[] };
export function blocks(items: Item[]): Block[] {
  const out: Block[] = [];
  for (const i of items) {
    if (i.kind !== 'tool') { out.push(i); continue; }
    const last = out[out.length - 1];
    if (last?.kind === 'steps') last.tools.push(i); else out.push({ kind: 'steps', key: `steps:${i.key}`, tools: [i] });
  }
  return out;
}
const base = (p: unknown) => String(p ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
// The kind of work a step is, which gives it its colour and icon in the conversation.
export type StepKind = 'run' | 'read' | 'edit' | 'search' | 'web' | 'agent' | 'todo' | 'other';
const STEP: [RegExp, string, string, StepKind, string?][] = [
  [/^(bash|shell|exec|run)$/, 'ran a command', 'ran {n} commands', 'run'],
  [/^read$/, 'read {file}', 'read {n} files', 'read', 'file'],
  [/^(edit|multiedit|patch|apply_patch)$/, 'edited {file}', 'edited {n} files', 'edit', 'file'],
  [/^write$/, 'wrote {file}', 'wrote {n} files', 'edit', 'file'],
  [/^(grep|glob|list|ls|codesearch)$/, 'searched the code', 'searched the code {n} times', 'search'],
  [/^webfetch$/, 'fetched a web page', 'fetched {n} web pages', 'web'],
  [/^websearch$/, 'searched the web', 'searched the web {n} times', 'web'],
  [/^(task|subagent)$/, 'ran a helper agent', 'ran {n} helper agents', 'agent'],
  [/^todo(write|read)$/, 'updated the task list', 'updated the task list', 'todo'],
];
const stepRule = (name: string) => STEP.find(([re]) => re.test(name.toLowerCase()));
export const stepKind = (name: string): StepKind => stepRule(name)?.[3] || 'other';
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// A run of steps as parts, one per kind of work, in the order each was first done: "Ran 2 commands", "Read 2 files".
export function stepsParts(tools: Tool[]): { kind: StepKind; text: string }[] {
  const groups = new Map<string, { one: string; many: string; kind: StepKind; per?: string; seen: Set<string>; n: number }>();
  for (const t of tools) {
    const [, one, many, kind, per] = stepRule(t.name) || [/./, `used ${t.name}`, `used ${t.name} {n} times`, 'other' as StepKind];
    const key = one; const g = groups.get(key) || { one, many, kind, per, seen: new Set<string>(), n: 0 };
    const file = base(t.input?.filePath ?? t.input?.path); g.n++; if (file) g.seen.add(file); groups.set(key, g);
  }
  return [...groups.values()].map(g => {
    const count = g.per ? g.seen.size || g.n : g.n;
    return { kind: g.kind, text: count === 1 ? g.one.replace('{file}', [...g.seen][0] || 'a file') : g.many.replace('{n}', String(count)) };
  });
}
export const failedNote = (tools: Tool[]) => { const failed = tools.filter(t => t.status === 'failed').length; return failed ? ` (${failed} failed)` : ''; };
// One line for a run of steps: what was done, in the order it was first done, with how many failed.
export function stepsSummary(tools: Tool[]): string {
  return capital(stepsParts(tools).map(p => p.text).join(', ') + failedNote(tools));
}
// The agent's own task list: the newest one it wrote, as {content, status} items.
export type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled' };
export function latestTodos(items: Item[]): Todo[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const t = items[i];
    if (t.kind === 'text') {
      // Current stock engines may publish their plan as a Markdown checklist rather than a todo tool.
      // Only explicit checkboxes count, never ordinary lists, code samples or quoted text.
      const list:Todo[]=[];let fence='';
      for(const line of t.text.split('\n')){
        const f=line.match(/^\s*(`{3,}|~{3,})/);if(f){if(!fence)fence=f[1][0];else if(fence===f[1][0])fence='';continue;}
        if(fence)continue;
        const m=line.match(/^\s*[-*+] \[([ xX\/\-])\] (.+)$/);
        if(m)list.push({content:m[2],status:/x/i.test(m[1])?'completed':m[1]==='/'?'in_progress':m[1]==='-'?'cancelled':'pending'});
      }
      if(list.length)return list;
    }
    if(t.kind!=='tool')continue;
    const isTodo=(name:unknown)=>typeof name==='string'&&/(?:^|\.)(todowrite|todo_write|todo)$/i.test(name);
    const calls=Array.isArray(t.metadata?.toolCalls)?t.metadata.toolCalls:[];
    const nested=[...calls].reverse().find(c=>c.status==='completed'&&isTodo(c.tool)&&Array.isArray(c.input?.todos));
    const list=isTodo(t.name)&&t.status==='done'?t.input?.todos:nested?.input?.todos;
    if(Array.isArray(list))return list.filter((x:any)=>typeof x?.content==='string'&&x.content.trim()).map((x:any)=>({content:x.content,status:['in_progress','completed','cancelled'].includes(x.status)?x.status:'pending'}));
  }
  return [];
}

// --- Skills ---
export type LibrarySkill={id:string;name:string;description:string;text:string;auto:boolean};
// Reads a SKILL.md: its name and description from the header, and the rest as the instructions. Nothing in it runs.
export function parseSkillFile(text:string,file:string):Omit<LibrarySkill,'id'>{
  const m=text.replace(/^﻿/,'').match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  const head:Record<string,string>={};
  for(const line of (m?.[1]||'').split(/\r?\n/)){const kv=line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);if(!kv)continue;let v=kv[2].trim();
    if(/^".*"$/.test(v))try{v=JSON.parse(v);}catch{v=v.slice(1,-1);}else if(/^'.*'$/.test(v))v=v.slice(1,-1).replace(/''/g,"'");head[kv[1].toLowerCase()]=v;}
  const fallback=file.replace(/\.md$/i,'').replace(/^SKILL$/i,'')||'Imported skill';
  return {name:(head.name||fallback).slice(0,80),description:head.description||'',text:(m?m[2]:text).replace(/^\s*\n/,''),auto:!/^(true|yes|on|1)$/i.test(head['disable-model-invocation']||'')};
}

export type SkillPick={id:string;name:string};
export type SkillOffer={running:boolean;skills:{id:string;name:string;description:string;auto:boolean;source:'polygate'|'builtin'}[];templates:{id:string;kind:'command'|'skill';name:string;text:string}[]};
export type MenuChoice={kind:'skill';skill:SkillPick}|{kind:'template';text:string};
export type MenuEntry={key:string;title:string;detail:string;tag:string;choice:MenuChoice};
// "/word" as the whole message box opens the menu filtered by that word.
export const slashQuery=(value:string)=>{const m=value.match(/^\/(\S*)$/);return m?m[1]:null;};
export function menuEntries(offer:SkillOffer,query:string,picked:SkillPick[]):MenuEntry[]{
  const q=query.toLowerCase(),match=(...s:string[])=>!q||s.some(x=>x.toLowerCase().includes(q));
  return [
    // Your own skills first, then the engine's built-in ones.
    ...offer.skills.filter(s=>!picked.some(p=>p.id===s.id)&&match(s.id,s.name,s.description)).sort((a,b)=>Number(a.source==='builtin')-Number(b.source==='builtin')).map(s=>({key:'s:'+s.id,title:s.name,detail:s.description,tag:s.source==='builtin'?'Built-in skill':'Skill',choice:{kind:'skill' as const,skill:{id:s.id,name:s.name}}})),
    ...offer.templates.filter(t=>match(t.name,t.text)).map(t=>({key:'t:'+t.id,title:t.name,detail:t.text.split('\n')[0],tag:`Folder ${t.kind}`,choice:{kind:'template' as const,text:t.text}})),
  ];
}

// --- Questions ---
// A field of a question form the agent opens (the engine's Form.Field; the question tool sends string or multiselect fields with options).
export type FormField={key:string;type:string;title?:string;description?:string;required?:boolean;hidden?:boolean;default?:any;placeholder?:string;options?:{value:string;label:string;description?:string}[];custom?:boolean;when?:{key:string;op:string;value:any}[];minimum?:number;maximum?:number;minLength?:number;maxLength?:number;pattern?:string};
export function formChoice(field: FormField, value: any, option: string) {
  if (field.type === 'multiselect') {
    const list: string[] = Array.isArray(value) ? value : [];
    return { value: list.includes(option) ? list.filter(v => v !== option) : [...list, option] };
  }
  return { value: field.type === 'boolean' ? option === 'true' : option, other: '', otherOn: false };
}
// A field shows only while the earlier answers it depends on match.
export const formActive=(f:FormField,values:Record<string,any>)=>(f.when||[]).every(w=>{const v=values[w.key];if(v===undefined)return false;const equal=Array.isArray(v)?v.includes(w.value):v===w.value;return w.op==='eq'?equal:!equal;});
const given=(v:any)=>Array.isArray(v)?v.length>0:v!==undefined&&v!=='';
// What is sent: answered fields that are showing, never an outside interaction (Polygate does not open those).
export const formAnswer=(fields:FormField[],values:Record<string,any>)=>Object.fromEntries(fields.filter(f=>formActive(f,values)&&f.type!=='external'&&given(values[f.key])).map(f=>[f.key,values[f.key]]));
export const formReady=(fields:FormField[],values:Record<string,any>)=>fields.every(f=>!f.required||!formActive(f,values)||f.type==='external'||given(values[f.key]));
// The question tool asks the model to mark its pick with "(Recommended)" at the end of the label; it is shown as a badge instead.
export const splitRecommended=(label:string)=>{const m=label.match(/^(.*?)\s*\((?:recommended|suggested)\)\s*$/i);return m?{label:m[1],recommended:true}:{label,recommended:false};};

// --- Appearance ---
// Fonts the Agent view can use (src/agent-fonts.css). Persian text always keeps Vazirmatn ('Agent Persian' covers only its script).
export const AGENT_FONTS: { id: string; label: string; family?: string; note: string }[] = [
  { id: 'default', label: 'Polygate default', note: 'Barlow for the interface, Segoe UI for messages' },
  { id: 'instrument', label: 'Instrument Sans', family: 'Agent Instrument Sans', note: 'Calm and slightly narrow, soft curves' },
  { id: 'geist', label: 'Geist', family: 'Agent Geist', note: 'Modern and neutral, clear at small sizes' },
  { id: 'dm-sans', label: 'DM Sans', family: 'Agent DM Sans', note: 'Rounder and friendly' },
  { id: 'inter', label: 'Inter', family: 'Agent Inter', note: 'The common interface font' },
  { id: 'figtree', label: 'Figtree', family: 'Agent Figtree', note: 'Light and friendly' },
];
const FALLBACK = "'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif";
// The CSS variables that put a font on the whole Agent view: its interface (--font) and the agent's messages (--agent-text-font).
export function agentFontVars(id: string): Record<string, string> {
  const font = AGENT_FONTS.find(f => f.id === id);
  if (!font?.family) return {};
  const stack = `'Agent Persian','${font.family}',${FALLBACK}`;
  return { '--font': stack, '--agent-text-font': stack };
}
