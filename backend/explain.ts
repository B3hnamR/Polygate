import { resetTime } from './exhaustion';
// Plain-language versions of the errors a client sees. The raw upstream text is JSON inside JSON and says nothing about when to
// try again, so the client gets a sentence it can show, plus machine-readable fields for tools that want them.
export const human = (seconds: number) => { const s = Math.max(0, Math.round(seconds)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h} h ${m} min` : m ? `${m} min` : `${s} s`; };
// The upstream answer, when it is the provider's JSON error, reduced to its useful fields.
export function upstreamFields(message: string): { type?: string; code?: number; logId?: string; text?: string } {
  try { const d = JSON.parse(message); const e = d?.error ?? d; return { type: e?.type, code: e?.code, logId: e?.log_id, text: typeof e?.message === 'string' ? e.message : undefined }; } catch { return {}; }
}
export type ErrorContext = { status: number; type?: string; message: string; model: string; route: string; switches: number; confirmedClean?: boolean; exhausted?: { until: number; seconds: number; refused?: boolean }; cooldownUntil?: number; cooldownsEnabled: boolean; requestBytes?: number; messages?: number };
export type Explained = { message: string; code: string; extra: Record<string, unknown>; retryAfter?: number };
// A very large conversation is a different story from a small request. The Free limit seems to count what is sent, so an address can
// pass a small test and still refuse a big conversation, and the next address may refuse it too.
const LARGE_REQUEST_BYTES = 400_000;
export const largeRequestNote = (bytes?: number, messages?: number) => bytes && bytes >= LARGE_REQUEST_BYTES
  ? ` This request is large (${messages ? messages + ' messages, ' : ''}${(bytes / 1048576).toFixed(1)} MB), and the Free limit appears to count what is sent, so an address can pass a small test and still refuse a big conversation, and the next address may refuse it too. Starting a new chat, or compacting this one, usually helps.` : '';
export function pausedModel(model: string, until: number, cooldownsEnabled = true): Explained {
  const seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000));
  return { code: 'model_paused', retryAfter: seconds, extra: { resets_at: new Date(until).toISOString(), retry_after_seconds: seconds, model },
    message: `Polygate has paused ${model} until ${resetTime(until)} (in ${human(seconds)}) after the provider returned errors. ${cooldownsEnabled ? 'Turn off "Pause models after errors" under Routing to keep trying, or choose another model.' : 'Choose another model.'}` };
}
export function explainError(c: ErrorContext): Explained | undefined {
  const up = upstreamFields(c.message);
  if (c.exhausted?.refused) {
    return { code: 'relay_refused', extra: { route: c.route, upstream: { status: c.status, ...up } },
      message: `OpenCode Free refused requests through "${c.route}" and no other network exit could serve this one. A relay is the TLS client the provider sees, and the Free tier only accepts Bun's; this relay did not report that it runs Bun, so the refusal is probably its TLS identity and not a used-up allowance. Deploy the Bun relay template (relays/vercel-bun), or choose Direct, WARP or a proxy route.` };
  }
  if (c.exhausted) {
    const seconds = Math.max(0, Math.ceil((c.exhausted.until - Date.now()) / 1000));
    const tried = c.switches ? ` Polygate already moved to ${c.switches} other network exit${c.switches > 1 ? 's' : ''} and none had allowance left.` : '';
    return { code: 'egress_exhausted', retryAfter: seconds,
      extra: { resets_at: new Date(c.exhausted.until).toISOString(), retry_after_seconds: seconds, route: c.route, upstream: { status: c.status, ...up } },
      message: `OpenCode Free: the daily allowance for this network exit (${c.route || 'direct'}) is used up. It resets at ${resetTime(c.exhausted.until)} (in ${human(seconds)}).${tried} This is a limit on the IP address, not a problem with your request or key.${largeRequestNote(c.requestBytes, c.messages)} To continue now, use a different IP (VPN or another network), or add verified proxies or a WARP route in Polygate so it can switch automatically.` };
  }
  if (c.status === 429 && /FreeUsageLimit|Free usage limit/i.test(c.message + (up.type || ''))) {
    return { code: 'request_refused', extra: { route: c.route, upstream: { status: c.status, ...up } },
      message: `OpenCode Free refused this request (HTTP 429). ${c.confirmedClean ? 'A small test request through the same network exit was accepted, so the exit still has allowance and this request itself was refused.' : 'It did not give a reset time, so this does not look like a used-up daily allowance.'} The usual causes are the shape of the request (tools, session, system prompt) or the TLS client in use. Open Requests in Polygate, select this request and read "Request shape" to see what was sent${up.logId ? ` (provider log id ${up.logId})` : ''}.` };
  }
  // The relay's own answer to a wrong access token: nothing to do with the exit address or with OpenCode.
  if (c.status === 401 && /Unauthorized relay request/i.test(up.text || '')) {
    return { code: 'relay_unauthorized', extra: { route: c.route, upstream: { status: c.status, ...up } },
      message: `The relay "${c.route || 'relay'}" rejected the access token Polygate sent (HTTP 401), so nothing can pass through it. The token saved here does not match the one set on the relay. Open the Relays page and correct its token, or deploy the relay again.` };
  }
  if (c.status === 403 || c.status === 401) {
    return { code: 'exit_refused', extra: { route: c.route, upstream: { status: c.status, ...up } },
      message: `The provider refused this connection (HTTP ${c.status}) from the network exit "${c.route || 'direct'}". The exit address may be blocked; try another route or proxy. ${up.text ? 'Provider said: ' + up.text.slice(0, 200) : ''}`.trim() };
  }
  return undefined;
}
