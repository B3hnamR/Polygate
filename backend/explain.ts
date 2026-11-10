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
      message: `OpenCode Free returned a limit/access error through "${c.route}". The relay's outbound runtime could not be verified, so Polygate cannot distinguish an allowance limit from an access or client restriction. Missing runtime information does not prove the relay is broken or its TLS identity was rejected. Check the relay diagnostics and the provider response before changing deployments.` };
  }
  if (c.exhausted) {
    const seconds = Math.max(0, Math.ceil((c.exhausted.until - Date.now()) / 1000));
    const tried = c.switches ? ` Polygate tried ${c.switches} other network exit${c.switches > 1 ? 's' : ''} without a successful answer.` : '';
    return { code: 'egress_exhausted', retryAfter: seconds,
      extra: { resets_at: new Date(c.exhausted.until).toISOString(), retry_after_seconds: seconds, route: c.route, upstream: { status: c.status, ...up } },
      message: `OpenCode Free returned a limit/access error through ${c.route || 'direct'}, including for a small check request. The provider's Retry-After says to retry after ${resetTime(c.exhausted.until)} (in ${human(seconds)}); this is not a guaranteed daily reset. The response does not prove whether the cause is an exhausted allowance or another access restriction.${tried}${largeRequestNote(c.requestBytes, c.messages)} Wait for the advertised retry time, use a provider you have access to, or contact OpenCode with its request identifier. This is not evidence of a relay transport failure.` };
  }
  if (c.status === 429 && /FreeUsageLimit|Free usage limit/i.test(c.message + (up.type || ''))) {
    return { code: 'request_refused', extra: { route: c.route, upstream: { status: c.status, ...up } },
      message: `OpenCode Free returned a limit/access error (HTTP 429). ${c.confirmedClean ? 'A small check through the same network exit was accepted, but this request was not.' : 'No confirmed retry time is available; this alone cannot distinguish a quota limit from an access restriction.'} This does not establish a relay failure or a TLS problem. Open Requests in Polygate, select this request and inspect the provider error and "Request shape"${up.logId ? ` (provider log id ${up.logId})` : ''}.` };
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
