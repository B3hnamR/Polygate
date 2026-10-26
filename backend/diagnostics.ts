import { createHash } from 'node:crypto';
// Request-shape diagnostics. Records what a request looked like (sizes, counts, header names, whether the prompt carries an
// <env> block with a working directory) and what the upstream answered, never prompt text, completions or credential values.
// The Free gateway answers several different problems with the same 429, so shapes of failures are compared with successes
// to tell a request-shape refusal from an egress (IP) or client-identity refusal.
const short = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 8);
const text = (c: any): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '').join('') : '';
// Headers whose value is safe and useful to keep verbatim. Identity-like headers keep only a format and a short hash, enough to
// see whether two requests shared a session or project without recording the identifier.
const PLAIN_REQUEST = /^(user-agent|x-opencode-client|content-type|accept|accept-encoding|connection)$/i;
const IDENTITY = /session|project|request|affinity|trace|b3|device|machine|install|user-id/i;
const SECRET = /^(authorization|cookie|x-api-key|api-key|proxy-authorization|x-relay-key)$/i;
const PLAIN_RESPONSE = /^(retry-after|x-ratelimit-.*|ratelimit-.*|cf-ray|cf-cache-status|server|date|content-type|x-request-id|via|x-opencode-.*|x-usage-.*|x-billing-.*)$/i;
export type HeaderShape = { names: string[]; values: Record<string, string>; identity: Record<string, string>; auth: string };
export function describeHeaders(headers: Headers | Record<string, any> | [string, string][] | undefined): HeaderShape {
  const h = new Headers(headers as any); const out: HeaderShape = { names: [], values: {}, identity: {}, auth: 'none' };
  h.forEach((value, name) => {
    out.names.push(name);
    if (SECRET.test(name)) { if (name === 'authorization') out.auth = /^Bearer public$/i.test(value) ? 'Bearer public' : /^Bearer /i.test(value) ? `Bearer key (${value.length - 7} chars)` : /^Basic /i.test(value) ? 'Basic' : 'other'; return; }
    if (PLAIN_REQUEST.test(name)) out.values[name] = value.slice(0, 160);
    else if (IDENTITY.test(name)) out.identity[name] = `${value.match(/^[A-Za-z]{2,8}[_-]/)?.[0] || ''}…len${value.length}#${short(value)}`;
  });
  out.names.sort(); return out;
}
export function describeResponseHeaders(headers: Headers) {
  const names: string[] = [], values: Record<string, string> = {};
  headers.forEach((value, name) => { names.push(name); if (PLAIN_RESPONSE.test(name)) values[name] = value.slice(0, 160); });
  return { names: names.sort(), values };
}
export type Shape = Record<string, any>;
export function describeBody(body: any, bytes: number): Shape {
  if (!body || typeof body !== 'object') return { bytes, parsed: false };
  const messages: any[] = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  const roles: Record<string, number> = {}; let systemChars = 0, userChars = 0, lastUserChars = 0, systemText = '';
  for (const m of messages) {
    const role = String(m?.role || m?.type || 'unknown'); roles[role] = (roles[role] || 0) + 1;
    const t = text(m?.content);
    if (role === 'system' || role === 'developer') { systemChars += t.length; systemText += t + '\n'; }
    else if (role === 'user') { userChars += t.length; lastUserChars = t.length; }
  }
  const extra = text(body.system) + (typeof body.instructions === 'string' ? body.instructions : ''); systemChars += extra.length; systemText += extra;
  const tools: any[] = Array.isArray(body.tools) ? body.tools : [];
  const envBlocks = systemText.match(/<env>[\s\S]*?<\/env>/g) || [];
  const hasWd = (s: string) => /Working directory:/i.test(s);
  return {
    bytes, keys: Object.keys(body).sort(), model: typeof body.model === 'string' ? body.model : undefined, stream: body.stream === true,
    maxTokens: body.max_completion_tokens ?? body.max_output_tokens ?? body.max_tokens ?? null, reasoningEffort: body.reasoning_effort ?? body.reasoning?.effort ?? null,
    toolChoice: typeof body.tool_choice === 'string' ? body.tool_choice : body.tool_choice ? 'object' : null, storeFlag: body.store ?? null,
    messages: messages.length, roles, systemChars, userChars, lastUserChars,
    tools: tools.length, toolSchemaBytes: tools.length ? JSON.stringify(tools).length : 0,
    env: { blocks: envBlocks.length, blocksWithWorkingDirectory: envBlocks.filter(hasWd).length, tagPresent: /<env>/.test(systemText), workingDirectoryAnywhereInSystem: hasWd(systemText) },
  };
}
export type Attempt = { at: number; url: string; method: string; headers: HeaderShape; body: Shape; response?: { status: number; ms: number; headers: ReturnType<typeof describeResponseHeaders> }; error?: string };
const attempts = new Map<string, Attempt[]>();
export function beginAttempt(requestId: string, rawUrl: string, init: any): Attempt | undefined {
  if (!requestId || String(init?.method || 'GET').toUpperCase() !== 'POST') return;
  let url: URL; try { url = new URL(rawUrl); } catch { return; }
  let body: Shape = { parsed: false };
  if (typeof init?.body === 'string') { try { body = describeBody(JSON.parse(init.body), init.body.length); } catch { body = { bytes: init.body.length, parsed: false }; } }
  const a: Attempt = { at: Date.now(), url: url.origin + url.pathname, method: 'POST', headers: describeHeaders(init?.headers), body };
  const list = attempts.get(requestId) || []; if (list.length < 4) list.push(a); attempts.set(requestId, list);
  if (attempts.size > 300) attempts.delete(attempts.keys().next().value!);
  return a;
}
export const takeAttempts = (requestId: string) => { const a = attempts.get(requestId) || []; attempts.delete(requestId); return a; };
export function finishAttempt(a: Attempt | undefined, response: Response | undefined, error?: unknown) {
  if (!a) return; if (response) a.response = { status: response.status, ms: Date.now() - a.at, headers: describeResponseHeaders(response.headers) }; else a.error = String((error as any)?.message || error).slice(0, 200);
}
// Egress identity of a route as the upstream's CDN sees it. Cached; looked up only after a failure.
const egress = new Map<string, { at: number; info: Record<string, string> | null }>();
export async function egressInfo(routeId: string, fetcher: (url: string, init: any, routeId: string) => Promise<Response>) {
  if (process.env.POLYGATE_DIAG_EGRESS === '0') return null;
  const hit = egress.get(routeId); if (hit && Date.now() - hit.at < 600000) return hit.info;
  let info: Record<string, string> | null = null;
  try {
    const r = await fetcher('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(4000), polygateQuiet: true }, routeId);
    if (r.ok) { info = {}; for (const line of (await r.text()).split('\n')) { const [k, v] = line.split('='); if (['ip', 'colo', 'loc', 'warp', 'gateway', 'http', 'tls'].includes(k)) info[k] = v; } }
  } catch { /* an unreachable lookup is recorded as unknown */ }
  egress.set(routeId, { at: Date.now(), info }); return info;
}
