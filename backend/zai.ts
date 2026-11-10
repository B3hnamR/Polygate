import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { models, persist, saveModel, settings, ZAI_BASE, ZAI_ID } from './state';
import { resetTime } from './exhaustion';
import { networkFetch, routeForProvider } from './transport';
import { LIMIT_SCOPE, type Model, type Provider, type ZaiAccount } from './types';
// Z.ai's ZCode coding plan (GLM-5.3, GLM-5.3-Flash), ported from AutoZCoder's gateway (zcode_gateway/zcode_protocol.py, upstream.py, quota.py,
// model_retry.py; its docs/reference/PROTOCOL.md). Requests go to the plan's Anthropic-style messages endpoint with the ZCode desktop app's
// headers and system context, and answers are turned back into OpenAI chunks for the gateway.
// Deliberately not ported: switching to another account (or another network exit) when Z.ai flags a request as unusual activity, randomised
// send spacing, and spreading requests over accounts. One account is active at a time; the user picks it. Requests go direct or through the one
// proxy the user chose for Z.ai (steadyExit in transport.ts), and nothing here changes that exit.
export { ZAI_ID, ZAI_BASE };
// Model and billing requests leave the same way. Quiet: Z.ai's answers say nothing about the route's own health or any exit's Free allowance.
const zaiFetch = (url: string, init: RequestInit) => {
  const p = settings.providers.find(x => x.id === ZAI_ID); const route = p ? routeForProvider(p, '') : undefined;
  return !route || route.kind === 'direct' ? fetch(url, init) : networkFetch(url, { ...init, polygateQuiet: true }, route.id);
};
export const ZAI_MODELS = ['GLM-5.3', 'GLM-5.3-Flash'];
const CONTEXT = 1_000_000, MAX_OUTPUT = 128_000;
// The ZCode desktop build AutoZCoder tracks. The plan shown by the billing call is version-gated (3.16.1+ names the plan).
const APP_VERSION = '3.16.3';
const USER_AGENT = `ZCode/${APP_VERSION} ai-sdk/provider-utils/4.0.27 runtime/node.js/24`;
const MESSAGES = '/zcode-plan/anthropic/v1/messages';
const BALANCE = '/zcode-plan/billing/balance';
// The ZCode app's own system context, sent ahead of the caller's instructions (zcode_bootstrap.py).
export const ZCODE_IDENTITY = 'You are ZCode, an interactive coding agent';
export const ZCODE_HARNESS = `
You are an interactive ZCode agent that helps users with software engineering tasks.

IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.

# Harness
- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.
- Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.
- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.
- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.
- Reference code as \`file_path:line_number\` — it's clickable.`;
// Overloads (529, code 1305) are retried like the ZCode app does: 11 attempts, 2 s doubling, at most 60 s, 50-100% jitter.
export const OVERLOAD = { attempts: 11, baseMs: 2000, maxMs: 60000 };
// A quota error with no known reset rests the model this long before Polygate asks again.
const UNKNOWN_RESET_MS = 60 * 60000;

// Answers Polygate makes itself. An account that cannot be used (none active, a dead token, a block) is 503 rather than 401/403: the gateway
// then lets "auto" and chains move on to other providers' models instead of ending the request. It never moves to another Z.ai account.
const fail = (status: number, message: string, retryAfter?: number) => new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...(retryAfter ? { 'retry-after': String(Math.max(1, Math.ceil(retryAfter))) } : {}) } });
const zaiState = () => (settings.zai ||= { active: '', accounts: [] });
export const zaiAccounts = () => zaiState().accounts;
export const activeAccount = () => { const z = zaiState(); return z.accounts.find(a => a.id === z.active && a.enabled); };
export const label = (a: ZaiAccount) => a.name || a.email || a.id.slice(0, 8);

// --- Identity ---
// The ZCode app's headers. This machine's own platform, OS version, language and time zone; the account's device ID.
function clientHeaders(token: string, deviceMid: string, billing: boolean) {
  const id = () => randomUUID();
  const h: Record<string, string> = {
    accept: '*/*', 'content-type': 'application/json', 'http-referer': 'https://zcode.z.ai', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'mid-conversation-system-2026-04-07',
    authorization: 'Bearer ' + token, 'x-api-key': token, 'user-agent': USER_AGENT,
    'x-client-language': Intl.DateTimeFormat().resolvedOptions().locale || 'en-US', 'x-client-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    'x-os-category': process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux', 'x-os-version': os.release(),
    'x-platform': `${process.platform}-${process.arch}`, 'x-release-channel': 'production', 'x-title': 'Z Code@electron', 'x-zcode-agent': 'glm',
    'x-zcode-app-version': APP_VERSION, 'x-zcode-session-type': 'main', 'x-query-id': id(), 'x-request-id': id(), 'x-zcode-trace-id': id(), 'x-session-id': id(),
  };
  // Model requests carry the device in the body's metadata; billing requests carry it as a header (PROTOCOL.md).
  if (billing) h['x-device-mid'] = deviceMid;
  return h;
}

// --- Request ---
export function effort(body: any): 'low' | 'high' | 'max' {
  const raw = String(body.reasoning_effort ?? body.reasoningEffort ?? body.reasoning?.effort ?? 'high').toLowerCase();
  // GLM on the coding plan always reasons; asking for none gets the lightest setting rather than a refused request.
  return ({ none: 'low', off: 'low', minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'max', extra: 'max', max: 'max' } as const)[raw as 'low'] || 'high';
}
function blocks(content: any): any[] {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) throw new Error('Message content must be text or a list of parts.');
  return content.flatMap((part: any) => {
    const kind = part?.type;
    if (kind === 'text' || kind === 'input_text') return [{ type: 'text', text: String(part.text ?? '') }];
    if (kind === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (typeof url !== 'string') throw new Error('image_url.url must be a string.');
      if (!url.startsWith('data:')) return [{ type: 'image', source: { type: 'url', url } }];
      const comma = url.indexOf(','), head = url.slice(5, comma);
      if (comma < 0 || !head.includes(';base64')) throw new Error('Images must be base64 data URLs.');
      return [{ type: 'image', source: { type: 'base64', media_type: head.split(';')[0], data: url.slice(comma + 1) } }];
    }
    if (['image', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking'].includes(kind)) return [structuredClone(part)];
    throw new Error(`Unsupported content part: ${kind}.`);
  });
}
// An OpenAI chat request as the plan's messages body (zcode_protocol.build_body). Throws a plain Error for a request it cannot carry.
export function zaiBody(chat: any, model: string, deviceMid: string, sessionId: string) {
  const messages: any[] = [], system: any[] = [];
  for (const m of chat.messages || []) {
    let role = m.role; let content = blocks(m.content);
    if (role === 'system' || role === 'developer') { if (content.some(b => b.type !== 'text')) throw new Error('System messages must be text.'); system.push(...content); continue; }
    if (role === 'tool') { content = [{ type: 'tool_result', tool_use_id: m.tool_call_id, content }]; role = 'user'; }
    else if (role === 'assistant') for (const call of m.tool_calls || []) {
      let input: any = call.function?.arguments || '{}';
      try { input = typeof input === 'string' ? JSON.parse(input || '{}') : input; } catch { throw new Error('Tool call arguments must be valid JSON.'); }
      content.push({ type: 'tool_use', id: call.id, name: call.function?.name, input });
    }
    if (role !== 'user' && role !== 'assistant') throw new Error(`Unsupported message role: ${role}.`);
    if (!content.length) continue;
    // The messages API wants turns to alternate, with tool results inside user turns.
    const last = messages[messages.length - 1];
    if (last?.role === role) last.content.push(...content); else messages.push({ role, content });
  }
  if (!messages.length) throw new Error('At least one user or assistant message is required.');
  const out: any = { model, messages };
  const choice = chat.tool_choice;
  const none = choice === 'none' || choice?.type === 'none';
  if (Array.isArray(chat.tools) && chat.tools.length && !none) {
    out.tools = chat.tools.map((t: any) => { if (t.type !== 'function') throw new Error('Only function tools are supported.'); return { name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object' } }; });
    if (typeof choice === 'string' && choice !== 'auto') out.tool_choice = { type: choice === 'required' ? 'any' : choice };
    else if (choice && typeof choice === 'object' && choice.function?.name) out.tool_choice = { type: 'tool', name: choice.function.name };
    if (chat.parallel_tool_calls === false) out.tool_choice = { ...(out.tool_choice || { type: 'auto' }), disable_parallel_tool_use: true };
  }
  if (none && messages.some(m => m.content.some((b: any) => b.type === 'tool_use' || b.type === 'tool_result'))) throw new Error('tool_choice "none" with earlier tool calls is not supported by Z.ai\'s coding plan.');
  if (chat.response_format != null && chat.response_format?.type !== 'text') throw new Error('response_format is not supported by Z.ai\'s coding plan.');
  for (const k of ['temperature', 'top_p', 'top_k']) if (chat[k] != null) out[k] = chat[k];
  if (chat.stop != null) out.stop_sequences = typeof chat.stop === 'string' ? [chat.stop] : chat.stop;
  const asked = chat.max_tokens ?? chat.max_completion_tokens ?? MAX_OUTPUT;
  out.max_tokens = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_OUTPUT) : MAX_OUTPUT;
  out.thinking = { type: 'enabled' }; out.output_config = { effort: effort(chat) };
  out.metadata = { user_id: JSON.stringify({ device_id: deviceMid, account_uuid: '', session_id: sessionId }) };
  out.system = [{ type: 'text', text: ZCODE_IDENTITY }, { type: 'text', text: ZCODE_HARNESS }, ...system];
  out.stream = true;
  return out;
}

// --- Answer ---
// The plan's Anthropic-style stream as OpenAI chunks (zcode_protocol.OpenAITranslator). A stream that ends before message_stop is an error.
export function toOpenAI(upstream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder(), dec = new TextDecoder(); let buf = '', stopped = false; const tools = new Map<number, number>(), empty = new Set<number>(); const usage: any = {};
  let id = 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 24); const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: any, finish: string | null = null) => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] });
  const frame = (o: any) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);
  const feed = (e: any, out: (o: any) => void) => {
    switch (e?.type) {
      case 'message_start': id = 'chatcmpl-' + (e.message?.id || id); Object.assign(usage, e.message?.usage || {}); out(chunk({ role: 'assistant', content: '' })); break;
      case 'content_block_start': {
        const b = e.content_block || {};
        if (b.type === 'tool_use') { const n = tools.size; tools.set(e.index, n); const init = b.input && Object.keys(b.input).length ? JSON.stringify(b.input) : ''; if (!init) empty.add(e.index); out(chunk({ tool_calls: [{ index: n, id: b.id, type: 'function', function: { name: b.name, arguments: init } }] })); }
        else if (b.text) out(chunk({ content: b.text }));
        else if (b.thinking) out(chunk({ reasoning_content: b.thinking }));
        break;
      }
      case 'content_block_delta': {
        const d = e.delta || {};
        if (d.type === 'text_delta') out(chunk({ content: d.text || '' }));
        else if (d.type === 'thinking_delta') out(chunk({ reasoning_content: d.thinking || '' }));
        else if (d.type === 'input_json_delta' && tools.has(e.index)) { if (d.partial_json) empty.delete(e.index); out(chunk({ tool_calls: [{ index: tools.get(e.index), function: { arguments: d.partial_json || '' } }] })); }
        break;
      }
      case 'content_block_stop': if (empty.delete(e.index)) out(chunk({ tool_calls: [{ index: tools.get(e.index), function: { arguments: '{}' } }] })); break;
      case 'message_delta': {
        Object.assign(usage, e.usage || {}); const stop = e.delta?.stop_reason;
        if (stop) out(chunk({}, ({ end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'content_filter' } as any)[stop] || 'stop'));
        break;
      }
      case 'message_stop': {
        stopped = true; const cache = Number(usage.cache_read_input_tokens || 0), prompt = Number(usage.input_tokens || 0) + cache + Number(usage.cache_creation_input_tokens || 0), completion = Number(usage.output_tokens || 0);
        out({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: cache } } });
        break;
      }
      case 'error': throw new Error(`Z.ai: ${e.error?.message || 'the stream reported an error'}${e.error?.code ? ` (code ${e.error.code})` : ''}`);
    }
  };
  const reader = upstream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { if (!stopped) { ctrl.error(new Error('Z.ai\'s answer ended before it was complete.')); return; } ctrl.enqueue(enc.encode('data: [DONE]\n\n')); ctrl.close(); return; }
        buf += dec.decode(value, { stream: true }); let sent = false; let at: number;
        while ((at = buf.search(/\r?\n\r?\n/)) >= 0) {
          const raw = buf.slice(0, at); buf = buf.slice(at + (buf[at] === '\r' ? 4 : 2));
          const data = raw.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
          if (!data.trim() || data === '[DONE]') continue;
          let event: any; try { event = JSON.parse(data); } catch { continue; }
          try { feed(event, o => { ctrl.enqueue(frame(o)); sent = true; }); } catch (e) { ctrl.error(e); reader.cancel().catch(() => {}); return; }
        }
        if (sent) return;
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

// --- Errors ---
const parseError = (status: number, text: string) => {
  try { const d = JSON.parse(text); const e = d?.error ?? d; if (e && typeof e === 'object') return { code: String(e.code ?? e.statusCode ?? e.type ?? `http_${status}`), message: String(e.message ?? e.msg ?? text.slice(0, 400)) }; } catch { /* not JSON */ }
  return { code: `http_${status}`, message: text.slice(0, 400) };
};
const isOverload = (status: number, code: string) => status === 529 || code === '1305' || code === 'overloaded_error';
const isQuota = (status: number, code: string) => status === 402 || code === '11113' || code === '1005';
const isBlock = (status: number, code: string, message: string) => status === 405 || code.includes('3012') || /unusual activity/i.test(message);
const isEntitlement = (code: string) => /ENTITLEMENT|SUBSCRIB|PLAN/i.test(code);
function retryAfterMs(h: Headers) {
  const ms = Number(h.get('retry-after-ms')); if (Number.isFinite(ms) && ms >= 0 && h.get('retry-after-ms') !== null) return ms;
  const raw = h.get('retry-after'); if (raw === null) return undefined;
  const s = Number(raw); if (Number.isFinite(s) && s >= 0) return s * 1000;
  const at = Date.parse(raw); return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}
export const overloadDelay = (retry: number, after?: number) => after !== undefined ? Math.min(after, OVERLOAD.maxMs) : Math.min(OVERLOAD.baseMs * 2 ** (retry - 1), OVERLOAD.maxMs) * (0.5 + Math.random() * 0.5);
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const t = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(t); reject(signal.reason); }; signal.addEventListener('abort', stop, { once: true });
});

// --- Chat ---
// Waits between overload retries; tests replace it.
export const timing = { wait };
export async function zaiChat(p: Provider, m: Model, chat: any, signal: AbortSignal, accounting?: import('./providers').GenerationAccounting): Promise<Response> {
  const a = activeAccount(), model = m.upstreamId;
  if (!a) return fail(503, 'No Z.ai account is active. Import an account under Providers → Z.ai (ZCode) and choose it as the active one.');
  if (a.problem) return fail(503, `Z.ai account "${label(a)}" cannot be used: ${a.problem} Import a fresh copy of it, or choose another account under Providers → Z.ai (ZCode).`);
  if (a.expiresAt && a.expiresAt <= Date.now()) return fail(503, `The token of Z.ai account "${label(a)}" has expired. Import a fresh copy of it, or choose another account under Providers → Z.ai (ZCode).`);
  const blocked = a.blocked?.[model];
  if (blocked) return fail(503, blockedText(a, model, blocked.message));
  const until = a.exhausted?.[model] || 0;
  if (until > Date.now()) return quotaFail(a, model, until);
  let body: any; try { body = zaiBody(chat, model, a.deviceMid, randomUUID()); } catch (e: any) { return fail(400, e.message); }
  const url = (p.baseUrl || ZAI_BASE).replace(/\/$/, '') + MESSAGES;
  for (let attempt = 1; ; attempt++) {
    accounting?.before({ ...chat, max_tokens: body.max_tokens });
    const r = await zaiFetch(url, { method: 'POST', headers: clientHeaders(a.token, a.deviceMid, false), body: JSON.stringify(body), signal });
    const json = (r.headers.get('content-type') || '').includes('application/json');
    if (r.ok && !json && r.body) return new Response(toOpenAI(r.body, m.upstreamId), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const text = await r.text().catch(() => '');
    if (accounting) { let usage; try { usage = JSON.parse(text)?.usage; } catch {} accounting.failed(usage); }
    const { code, message } = parseError(r.status, text);
    // A 200 that carries a JSON error envelope is a refusal: quota codes are quota, anything else is a server problem.
    const status = r.ok ? (isQuota(0, code) ? 402 : 502) : r.status;
    if (isOverload(status, code) && attempt < OVERLOAD.attempts) { await timing.wait(overloadDelay(attempt, retryAfterMs(r.headers)), signal); continue; }
    if (isOverload(status, code)) return fail(503, `Z.ai's ${model} is overloaded and did not answer after ${OVERLOAD.attempts} tries. Try again in a minute.`);
    if (status === 401) { a.problem = 'Z.ai rejected its token (HTTP 401).'; persist(); return fail(503, `Z.ai rejected the token of account "${label(a)}". Import a fresh copy of it, or choose another account under Providers → Z.ai (ZCode).`); }
    if (isQuota(status, code)) { const at = await quotaReset(a, model); (a.exhausted ||= {})[model] = at; persist(); return quotaFail(a, model, at); }
    if (isBlock(status, code, message)) { (a.blocked ||= {})[model] = { at: Date.now(), message: message.slice(0, 300) }; persist(); return fail(503, blockedText(a, model, message)); }
    if (status === 403 && isEntitlement(code)) return fail(503, `The plan of Z.ai account "${label(a)}" does not include ${model}.`);
    if (status === 429) return fail(429, `Z.ai is rate limiting ${model} for account "${label(a)}": ${message}`, (retryAfterMs(r.headers) ?? 30000) / 1000);
    return fail(status >= 400 ? status : 502, `Z.ai answered ${r.status}${code && !code.startsWith('http_') ? ` (code ${code})` : ''}: ${message}`);
  }
}
// Quota is counted per model: the refusal is marked as this model's own, so a check of the provider's other models goes on.
const quotaFail = (a: ZaiAccount, model: string, until: number) => { const r = fail(429, quotaText(a, model, until), (until - Date.now()) / 1000); r.headers.set(LIMIT_SCOPE, 'model'); return r; };
const quotaText = (a: ZaiAccount, model: string, until: number) => `Z.ai account "${label(a)}" has no ${model} quota left until ${resetTime(until)}. Polygate does not switch Z.ai accounts by itself: choose another account under Providers → Z.ai (ZCode), or use another model.`;
const blockedText = (a: ZaiAccount, model: string, message: string) => `Z.ai blocked account "${label(a)}" for ${model}${message ? `: ${message}` : ''}. Polygate stopped using this account for ${model} and does not switch to another account. Clear the block under Providers → Z.ai (ZCode) when you want to try again.`;
// When the model's quota comes back: the reset from a fresh balance if Z.ai gives one, otherwise an hour from now.
async function quotaReset(a: ZaiAccount, model: string) {
  try { await refreshQuota(a); } catch { /* the saved balance, if any, still says something */ }
  const at = a.quotas?.[model]?.resetsAt || 0;
  return at > Date.now() ? at : Date.now() + UNKNOWN_RESET_MS;
}

// --- Accounts ---
const SAFE = (v: unknown, max = 254) => typeof v === 'string' && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function claims(token: string) {
  const part = token.split('.')[1]; if (!part) throw new Error('That is not a Z.ai account copy or a JWT token.');
  let c: any; try { c = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { throw new Error('The token\'s payload is not readable.'); }
  if (!c || typeof c !== 'object') throw new Error('The token\'s payload is not readable.');
  return c;
}
// What a pasted import holds: AutoZCoder's "Copy account for sharing" text (autozcoder-account v1) or a bare token. Nothing is checked with Z.ai yet.
export function parseImport(raw: unknown) {
  if (typeof raw !== 'string') throw new Error('Paste an account copy or a JWT token.');
  let text = raw.trim(); let bundle: any;
  if (text.startsWith('{')) {
    if (text.length > 24576) throw new Error('That account copy is too large.');
    try { bundle = JSON.parse(text); } catch { throw new Error('That account copy is not valid JSON.'); }
    if (bundle?.format !== 'autozcoder-account' || bundle.version !== 1) throw new Error('That is not an AutoZCoder account copy (format autozcoder-account, version 1).');
    if (typeof bundle.access_token !== 'string') throw new Error('That account copy has no token.');
    text = bundle.access_token.trim();
  }
  if (/^bearer /i.test(text)) text = text.slice(7).trim();
  if (!text || text.length > 16384 || /\s/.test(text)) throw new Error('Paste one JWT token (not the whole snapshot).');
  const c = claims(text);
  if (c.user_id && c.sub && c.user_id !== c.sub) throw new Error('The token names two different accounts.');
  const id = String(c.user_id || c.sub || ''); if (!UUID.test(id)) throw new Error('The token has no Z.ai account ID.');
  const exp = c.exp ?? 0; if (typeof exp !== 'number' || !Number.isFinite(exp) || exp < 0 || exp > 253402300799) throw new Error('The token\'s expiry is not valid.');
  if (exp && exp * 1000 <= Date.now()) throw new Error('This token has expired. Copy the account again from where it is signed in.');
  if (bundle && bundle.account_id !== undefined && String(bundle.account_id).toLowerCase() !== id.toLowerCase()) throw new Error('The account copy\'s ID does not match its token.');
  const email = bundle?.email ?? '', name = bundle?.name ?? '', deviceMid = bundle?.device_mid ?? '';
  if (![email, name, deviceMid].every(v => SAFE(v))) throw new Error('The account copy has invalid details.');
  if (email && (email.split('@').length !== 2 || /\s/.test(email))) throw new Error('The account copy has an invalid email.');
  return { id: id.toLowerCase(), token: text, expiresAt: exp * 1000, email: email.trim(), name: name.trim(), deviceMid: deviceMid.trim() };
}
// Normalised plan quotas, per model (quota.py parse_balance). Z.ai's times are in seconds; the result's resetsAt is in ms.
export function parseBalance(data: any, nowMs = Date.now()) {
  const now = nowMs / 1000, known = (show: string) => ZAI_MODELS.find(m => m.toLowerCase() === String(show || '').toLowerCase());
  const plans = (Array.isArray(data?.plans) ? data.plans : []).map((x: any) => ({ id: x.user_plan_id, name: String(x.name || x.plan_id || ''), status: String(x.status || ''), starts: Number(x.starts_at) || 0, ends: Number(x.ends_at) || 0, entitlements: x.entitlements }));
  const active = new Set(plans.filter((x: any) => x.status === 'active' && (!x.starts || x.starts <= now) && (!x.ends || x.ends > now)).map((x: any) => x.id));
  const quotas: Record<string, { remaining: number; total: number; used: number; resetsAt: number }> = {}; const seen = new Set<string>();
  const add = (model: string, remaining: number, total: number, used: number, starts = 0, end = 0) => {
    if (starts > now) return; // a grant that starts later is not capacity yet
    const q = quotas[model] ||= { remaining: 0, total: 0, used: 0, resetsAt: 0 };
    q.remaining += remaining; q.total += total; q.used += used;
    if (end > now) q.resetsAt = q.resetsAt ? Math.min(q.resetsAt, end * 1000) : end * 1000;
  };
  for (const b of Array.isArray(data?.balances) ? data.balances : []) {
    if (!active.has(b.user_plan_id)) continue;
    if (b.entitlement_id) seen.add(b.entitlement_id);
    if ((b.expires_at && b.expires_at <= now) || (b.period_end && b.period_end <= now)) continue;
    const model = known(b.show_name); if (!model) continue;
    add(model, Math.max(0, Number(b.available_units ?? b.remaining_units ?? 0)), Number(b.total_units) || 0, Number(b.used_units) || 0, Math.max(b.starts_at || 0, b.effective_at || 0, b.period_start || 0), b.period_end || 0);
  }
  // Plan entitlements without a live bucket (a grant outside its window) count only when they are already in effect.
  for (const x of plans) if (active.has(x.id)) for (const ent of Array.isArray(x.entitlements) ? x.entitlements : []) {
    if (!ent || (ent.entitlement_id && seen.has(ent.entitlement_id))) continue;
    const grant = Number(ent.grant_units) || 0, model = known(ent.show_name); if (grant <= 0 || !model) continue;
    add(model, grant, grant, 0, ent.effective_at || 0);
  }
  return { plans: plans.map((x: any) => ({ name: x.name, status: x.status, endsAt: x.ends * 1000 })), quotas };
}
// Asks Z.ai's billing service for this token's plans and quotas. Decoding a JWT proves nothing; this is the check that Z.ai accepts it.
export async function balance(token: string, deviceMid: string, base = ZAI_BASE) {
  let r: Response;
  try { r = await zaiFetch(base.replace(/\/$/, '') + BALANCE + '?app_version=' + APP_VERSION, { headers: clientHeaders(token, deviceMid, true), signal: AbortSignal.timeout(20000), redirect: 'manual' }); }
  catch { throw Object.assign(new Error('Could not reach Z.ai to check this account. Try again later.'), { status: 502 }); }
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Z.ai rejected this token.'), { status: 401 });
  if (!r.ok) throw Object.assign(new Error(`Z.ai's billing service answered ${r.status}. Try again later.`), { status: 502 });
  const envelope: any = await r.json().catch(() => undefined);
  if (envelope?.code !== 0 || !envelope.data || typeof envelope.data !== 'object') throw Object.assign(new Error('Z.ai did not accept this token as a coding-plan account.'), { status: 400 });
  return parseBalance(envelope.data);
}
export async function refreshQuota(a: ZaiAccount) {
  try {
    const b = await balance(a.token, a.deviceMid, settings.providers.find(p => p.id === ZAI_ID)?.baseUrl || ZAI_BASE);
    a.plans = b.plans; a.quotas = b.quotas; a.checkedAt = Date.now(); a.problem = undefined;
    // A model with quota again is usable again; one Z.ai blocked stays blocked until the user clears it.
    for (const [model, q] of Object.entries(b.quotas)) if (q.remaining > 0 && a.exhausted?.[model]) delete a.exhausted[model];
  } catch (e: any) { if (e.status === 401) a.problem = 'Z.ai rejected its token.'; a.checkedAt = Date.now(); persist(); throw e; }
  persist(); return a;
}
// Checks an import with Z.ai, then saves it. An account already in the list is updated in place (a newer token, its details).
export async function importAccount(raw: unknown) {
  const x = parseImport(raw); const z = zaiState(); const old = z.accounts.find(a => a.id === x.id);
  const deviceMid = x.deviceMid || old?.deviceMid || randomUUID();
  const b = await balance(x.token, deviceMid, settings.providers.find(p => p.id === ZAI_ID)?.baseUrl || ZAI_BASE);
  const a: ZaiAccount = { ...(old || { enabled: true, addedAt: Date.now() }), id: x.id, token: x.token, expiresAt: x.expiresAt, email: x.email || old?.email || '', name: x.name || old?.name || '', deviceMid, plans: b.plans, quotas: b.quotas, checkedAt: Date.now(), problem: undefined, exhausted: {} } as ZaiAccount;
  if (!old && z.accounts.length >= 200) throw new Error('Keep at most 200 Z.ai accounts.');
  if (old) Object.assign(old, a); else z.accounts.push(a);
  if (!activeAccount()) z.active = a.id;
  persist(); return { account: publicAccount(old || a), updated: !!old };
}
// The same text AutoZCoder's "Copy account for sharing" makes, so it can be imported there or in another Polygate. It is a credential.
export function exportAccount(id: string) {
  const a = zaiAccounts().find(x => x.id === id); if (!a) return undefined;
  return { format: 'autozcoder-account', version: 1, account_id: a.id, email: a.email, name: a.name, device_mid: a.deviceMid, access_token: a.token, expires_at_ms: a.expiresAt };
}
// What the dashboard sees: never the token.
export const publicAccount = (a: ZaiAccount) => ({ id: a.id, email: a.email, name: a.name, enabled: a.enabled, addedAt: a.addedAt, checkedAt: a.checkedAt || 0, expiresAt: a.expiresAt, plans: a.plans || [], quotas: a.quotas || {}, problem: a.problem || '', exhausted: Object.fromEntries(Object.entries(a.exhausted || {}).filter(([, t]) => t > Date.now())), blocked: a.blocked || {}, active: a.id === zaiState().active });
export const publicAccounts = () => ({ active: zaiState().active, accounts: zaiAccounts().map(publicAccount) });
// Choosing an account (or clearing a block) makes the Z.ai models worth asking again: the pause a former account's errors put on them goes.
export function freshModels() {
  for (const m of models.values()) if (m.providerId === ZAI_ID && m.state === 'cooldown') { m.state = 'unchecked'; m.cooldownUntil = 0; m.error = ''; saveModel(m); }
}
export function updateAccount(id: string, change: { enabled?: unknown; active?: unknown; name?: unknown; clearBlock?: unknown }) {
  const z = zaiState(); const a = z.accounts.find(x => x.id === id); if (!a) return undefined;
  if (change.name !== undefined) { if (!SAFE(change.name, 80)) throw new Error('Names are up to 80 characters.'); a.name = String(change.name).trim(); }
  if (change.enabled !== undefined) { a.enabled = change.enabled === true; if (!a.enabled && z.active === a.id) z.active = ''; }
  if (change.active === true) { if (!a.enabled) throw new Error('Switch the account on before making it active.'); z.active = a.id; freshModels(); }
  if (change.clearBlock !== undefined) { if (typeof change.clearBlock === 'string') delete a.blocked?.[change.clearBlock]; else a.blocked = {}; freshModels(); }
  persist(); return publicAccount(a);
}
export function removeAccount(id: string) {
  const z = zaiState(); const before = z.accounts.length; z.accounts = z.accounts.filter(a => a.id !== id);
  if (z.active === id) z.active = ''; persist(); return z.accounts.length < before;
}
// The catalog: the plan's two models, while at least one account is switched on.
export function zaiCatalog() {
  if (!zaiAccounts().some(a => a.enabled)) throw new Error('Import a Z.ai account first (Providers → Z.ai (ZCode)).');
  return ZAI_MODELS.map(id => ({ id, name: id, context_length: CONTEXT, maxOutput: MAX_OUTPUT, reasoning: true, tool_call: true, modalities: { input: ['text', 'image'] } }));
}
