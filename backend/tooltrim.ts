// OpenCode Free sometimes refuses a request only because of the list of tools the client sent, and words the refusal like a usage limit
// (the same 429 as a used-up allowance). Which lists it refuses is not published: a client with 27 tools can be refused while the same
// request with one of two particular tools removed is answered. When the network layer has confirmed that the exit itself is fine,
// the request is retried once with the standard coding tools only, and the choice is remembered so the next request goes straight there.
import { createHash } from 'node:crypto';

// The tool names OpenCode's own client sends, which the Free tier accepts together.
export const CORE_TOOLS = new Set(['bash', 'shell', 'read', 'edit', 'write', 'glob', 'grep', 'list', 'patch', 'apply_patch', 'multiedit', 'webfetch', 'websearch', 'codesearch', 'task', 'todowrite', 'todoread', 'skill', 'question', 'lsp', 'batch', 'invalid']);
const REMEMBER_MS = 6 * 3600 * 1000;
const learned = new Map<string, number>();
export const __resetToolTrim = () => learned.clear();

const nameOf = (t: any): string => String(t?.function?.name ?? t?.name ?? '');
const keyOf = (providerId: string, tools: any[]) => providerId + ':' + createHash('sha1').update(tools.map(nameOf).sort().join('|')).digest('hex');

// The chat request with only the standard tools, and the names that were left out; undefined when there is nothing to trim
// (no tools, nothing but standard ones, or no standard tool to keep).
export function coreOnly(chat: any): { chat: any; dropped: string[] } | undefined {
  const tools: any[] = Array.isArray(chat?.tools) ? chat.tools : [];
  const keep = tools.filter(t => CORE_TOOLS.has(nameOf(t)));
  if (!keep.length || keep.length === tools.length) return;
  const kept = new Set(keep.map(nameOf));
  const next: any = { ...chat, tools: keep };
  // A forced choice of a tool that is no longer offered would be refused for a different reason.
  const forced = chat.tool_choice?.function?.name ?? chat.tool_choice?.name;
  if (forced && !kept.has(forced)) next.tool_choice = 'auto';
  return { chat: next, dropped: tools.map(nameOf).filter(n => !kept.has(n)) };
}

export const learnTrim = (providerId: string, chat: any) => { if (Array.isArray(chat?.tools) && chat.tools.length) learned.set(keyOf(providerId, chat.tools), Date.now()); };
export function knownTrim(providerId: string, chat: any): boolean {
  if (!Array.isArray(chat?.tools) || !chat.tools.length) return false;
  const k = keyOf(providerId, chat.tools); const at = learned.get(k);
  if (!at) return false; if (Date.now() - at > REMEMBER_MS) { learned.delete(k); return false; } return true;
}
export const forgetTrim = (providerId: string, chat: any) => { if (Array.isArray(chat?.tools) && chat.tools.length) learned.delete(keyOf(providerId, chat.tools)); };
