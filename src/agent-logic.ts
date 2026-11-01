// The Agent page's transcript: a session's history (from /admin/agent/session) and its live events (from /admin/agent/events), turned
// into the items the page draws. No React here, so tests/agent-logic.test.ts can check it on its own.
import { plainError } from '../backend/plain-error';

export type Mode = 'ask' | 'accept-edits' | 'plan' | 'rules' | 'full';
export const MODES: { id: Mode; label: string }[] = [{ id: 'ask', label: 'Ask for approval' }, { id: 'accept-edits', label: 'Accept edits' }, { id: 'plan', label: 'Plan' }, { id: 'rules', label: 'Rules-based approvals' }, { id: 'full', label: 'Full access' }];
export const modeLabel = (id: string) => MODES.find(m => m.id === id)?.label || id;
const AGENT_MODES: Record<string, Mode> = { 'polygate-ask': 'ask', 'polygate-accept-edits': 'accept-edits', 'polygate-plan': 'plan', 'polygate-rules': 'rules', 'polygate-full': 'full' };

export type ToolStatus = 'preparing' | 'running' | 'done' | 'failed';
export type Item =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'reasoning'; key: string; text: string; done: boolean }
  | { kind: 'tool'; key: string; name: string; input?: any; status: ToolStatus; output?: string; error?: string }
  | { kind: 'note'; key: string; tone: 'info' | 'warn' | 'bad'; text: string }
  | { kind: 'changes'; key: string; message: string; files: FileChange[]; undoable: boolean; why?: string };
export type Approval = { id: string; action: string; resources: string[]; note: string };
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

const textOf = (content: unknown) => Array.isArray(content) ? content.map((c: any) => typeof c?.text === 'string' ? c.text : '').join('') : typeof content === 'string' ? content : '';

export function fromHistory(messages: any[]): Item[] {
  const out: Item[] = [];
  for (const m of messages || []) {
    if (m?.type === 'user') out.push({ kind: 'user', key: m.id, text: String(m.text ?? textOf(m.content)) });
    else if (m?.type === 'assistant') (m.content || []).forEach((c: any, i: number) => {
      const key = `${m.id}:${i}`;
      if (c?.type === 'text' && c.text) out.push({ kind: 'text', key, text: c.text });
      else if (c?.type === 'reasoning' && c.text) out.push({ kind: 'reasoning', key, text: c.text, done: true });
      else if (c?.type === 'tool') {
        const st = c.state || {}; const status: ToolStatus = st.status === 'completed' ? 'done' : st.status === 'error' || st.status === 'failed' ? 'failed' : 'running';
        out.push({ kind: 'tool', key: c.id || key, name: c.name || 'tool', input: st.input, status, output: textOf(st.content), error: st.error?.message || (typeof st.error === 'string' ? st.error : undefined) });
      }
    });
    else if (m?.type === 'idle' && (m.outcome === 'failed' || m.outcome === 'interrupted')) out.push({ kind: 'note', key: m.id, tone: m.outcome === 'failed' ? 'bad' : 'info', text: m.outcome === 'failed' ? 'This turn failed.' : 'Stopped.' });
    else if (m?.type === 'agent-switched' && AGENT_MODES[m.agent]) out.push({ kind: 'note', key: m.id, tone: 'info', text: `Mode: ${modeLabel(AGENT_MODES[m.agent])}` });
  }
  return out;
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
    case 'session.inbox.enqueued':
      if (d.item?.type !== 'user') return items;
      return items.some(x => x.key === d.inboxID) ? items : [...items, { kind: 'user', key: d.inboxID, text: String(d.item.payload?.text ?? '') }];
    case 'session.text.started': return upsert(part('t'), () => ({ kind: 'text', key: part('t'), text: '' }), x => x);
    case 'session.text.delta': return upsert(part('t'), () => ({ kind: 'text', key: part('t'), text: '' }), x => ({ ...x, text: x.text + String(d.delta ?? '') }));
    case 'session.text.ended': return typeof d.text === 'string' ? upsert(part('t'), () => ({ kind: 'text', key: part('t'), text: '' }), x => ({ ...x, text: d.text })) : items;
    case 'session.reasoning.started': return upsert(part('r'), () => ({ kind: 'reasoning', key: part('r'), text: '', done: false }), x => x);
    case 'session.reasoning.delta': return upsert(part('r'), () => ({ kind: 'reasoning', key: part('r'), text: '', done: false }), x => ({ ...x, text: x.text + String(d.delta ?? '') }));
    case 'session.reasoning.ended': return upsert(part('r'), () => ({ kind: 'reasoning', key: part('r'), text: '', done: true }), x => ({ ...x, text: typeof d.text === 'string' ? d.text : x.text, done: true }));
    case 'session.tool.input.started': return upsert(d.id, () => ({ kind: 'tool', key: d.id, name: d.name || 'tool', status: 'preparing' as ToolStatus }), x => x);
    case 'session.tool.called': return upsert(d.id, () => ({ kind: 'tool', key: d.id, name: 'tool', status: 'running' as ToolStatus }), x => ({ ...x, input: d.input, status: 'running' }));
    case 'session.tool.success': return upsert(d.id, () => ({ kind: 'tool', key: d.id, name: 'tool', status: 'done' as ToolStatus }), x => ({ ...x, status: 'done', output: textOf(d.content) }));
    case 'session.tool.failed': return upsert(d.id, () => ({ kind: 'tool', key: d.id, name: 'tool', status: 'failed' as ToolStatus }), x => ({ ...x, status: 'failed', error: d.error?.message || 'Failed' }));
    case 'agent.approval.auto': return [...items, { kind: 'note', key: `auto:${d.requestID}`, tone: 'info', text: `${d.reason || 'Allowed for this session'}: ${(d.resources || []).join(', ')}` }];
    case 'agent.approval.blocked': return [...items, { kind: 'note', key: `blocked:${d.requestID}`, tone: 'bad', text: `Blocked by permission rules: ${(d.resources || []).join(', ')}` }];
    case 'agent.mode': return [...items, { kind: 'note', key: `mode:${e.id || items.length}`, tone: d.mode === 'full' ? 'warn' : 'info', text: d.reason || `Mode: ${modeLabel(d.mode)}` }];
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

// The model picker: providers with how many models each offers, and the models of one provider (or all) matching a search. Every word
// of the search has to appear in the model's name, id or provider.
type PickModel = { id: string; name: string; provider: string; usable: boolean };
export function modelProviders<T extends PickModel>(models: T[]) {
  const out = new Map<string, { name: string; count: number; usable: number }>();
  for (const m of models) { const p = out.get(m.provider) || { name: m.provider, count: 0, usable: 0 }; p.count++; if (m.usable) p.usable++; out.set(m.provider, p); }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function matchModels<T extends PickModel>(models: T[], provider: string, query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found = models.filter(m => (!provider || m.provider === provider) && words.every(w => `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(w)));
  return [...found.filter(m => m.usable), ...found.filter(m => !m.usable)];
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
const STEP: [RegExp, string, string, string?][] = [
  [/^(bash|shell|exec|run)$/, 'ran a command', 'ran {n} commands'],
  [/^read$/, 'read {file}', 'read {n} files', 'file'],
  [/^(edit|multiedit|patch|apply_patch)$/, 'edited {file}', 'edited {n} files', 'file'],
  [/^write$/, 'wrote {file}', 'wrote {n} files', 'file'],
  [/^(grep|glob|list|ls|codesearch)$/, 'searched the code', 'searched the code {n} times'],
  [/^webfetch$/, 'fetched a web page', 'fetched {n} web pages'],
  [/^websearch$/, 'searched the web', 'searched the web {n} times'],
  [/^(task|subagent)$/, 'ran a helper agent', 'ran {n} helper agents'],
  [/^todo(write|read)$/, 'updated the task list', 'updated the task list'],
];
// One line for a run of steps: what was done, in the order it was first done, with how many failed.
export function stepsSummary(tools: Tool[]): string {
  const groups = new Map<string, { one: string; many: string; per?: string; seen: Set<string>; n: number }>();
  for (const t of tools) {
    const [, one, many, per] = STEP.find(([re]) => re.test(t.name.toLowerCase())) || [/./, `used ${t.name}`, `used ${t.name} {n} times`];
    const key = one; const g = groups.get(key) || { one, many, per, seen: new Set<string>(), n: 0 };
    const file = base(t.input?.filePath ?? t.input?.path); g.n++; if (file) g.seen.add(file); groups.set(key, g);
  }
  const parts = [...groups.values()].map(g => {
    const count = g.per ? g.seen.size || g.n : g.n;
    return count === 1 ? g.one.replace('{file}', [...g.seen][0] || 'a file') : g.many.replace('{n}', String(count));
  });
  const failed = tools.filter(t => t.status === 'failed').length;
  const text = parts.join(', ') + (failed ? ` (${failed} failed)` : '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
// The agent's own task list: the newest one it wrote, as {content, status} items.
export type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled' };
export function latestTodos(items: Item[]): Todo[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const t = items[i];
    if (t.kind === 'tool' && /^todowrite$/i.test(t.name) && Array.isArray(t.input?.todos))
      return t.input.todos.filter((x: any) => typeof x?.content === 'string').map((x: any) => ({ content: x.content, status: ['in_progress', 'completed', 'cancelled'].includes(x.status) ? x.status : 'pending' }));
  }
  return [];
}
