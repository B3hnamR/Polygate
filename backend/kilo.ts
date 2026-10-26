import { models, saveModel, redactError, KILO_ID, KILO_BASE } from './state';
import { networkFetch } from './transport';
import type { Provider, Model } from './types';
// Kilo Gateway's free tier: OpenAI-compatible, no account. Behaviour below was measured against the live service and cross-checked with other
// open clients: the catalog marks free models with a boolean `isFree`; any Authorization header is validated (even a placeholder is a 401), so none
// is sent unless the user saved a real key; an unknown or paid model answers 401 PAID_MODEL_AUTH_REQUIRED, not 404; and anonymous use has a limit per
// network address that answers every free model with 429 PROMOTION_MODEL_LIMIT_REACHED, while ordinary per-model 429s name one model.
export { KILO_ID, KILO_BASE };
// The address-wide limit has no Retry-After and no published window; one request after this pause finds out whether it has lifted.
export const KILO_LIMIT_PAUSE_MS = 30 * 60000;
// A per-model 429 usually clears within minutes (the shared free pool moves), so the first pause is short.
export const KILO_MODEL_PAUSE_MS = 2 * 60000;
const CLAMPED_TOKENS = 4096;
const base = (p: Provider) => (p.baseUrl || KILO_BASE).replace(/\/$/, '');
const headers = (p: Provider): Record<string, string> => ({ 'content-type': 'application/json', accept: 'text/event-stream', ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}) });
// Safety classifiers and other non-chat entries come back marked free but cannot answer a conversation.
const NOT_CHAT = /content-safety|guard|moderation/i;
// Catalog entries Polygate lists: free chat models, in the shape discover() reads.
export function freeCatalog(list: any[]) {
  return list.filter(x => x && x.isFree === true && typeof x.id === 'string' && !NOT_CHAT.test(x.id)).map(x => {
    const params: string[] = Array.isArray(x.supported_parameters) ? x.supported_parameters : [];
    return { id: x.id, name: x.name || x.id, context_length: Number(x.context_length) || 0, maxOutput: Number(x.top_provider?.max_completion_tokens) || 0, reasoning: params.includes('reasoning'), tool_call: params.length ? params.includes('tools') : true };
  });
}
export async function kiloCatalog(p: Provider, routeId: string) {
  const r = await networkFetch(base(p) + '/models', { headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}, signal: AbortSignal.timeout(30000) }, routeId);
  if (!r.ok) throw new Error(`Catalog HTTP ${r.status}`);
  const data: any = await r.json(); const list = data.data || data.models;
  if (!Array.isArray(list)) throw new Error('Catalog response has no model list');
  return freeCatalog(list);
}
// Kilo answers a model it does not serve with 401, which the gateway would read as a blocked network exit. It means "this model is not available
// to you", so it is passed on as 404 and the model is retired like any other model the provider no longer has.
async function asUnavailable(r: Response): Promise<Response> {
  if (r.status !== 401) return r;
  const text = await r.text().catch(() => '');
  if (!/paid_model_auth_required/i.test(text)) return new Response(text, { status: r.status, headers: r.headers });
  return new Response(text, { status: 404, headers: { 'content-type': r.headers.get('content-type') || 'application/json' } });
}
export async function kiloChat(p: Provider, m: Model, body: any, signal: AbortSignal, routeId: string): Promise<Response> {
  const send = (b: any) => networkFetch(base(p) + '/chat/completions', { method: 'POST', headers: headers(p), body: JSON.stringify({ ...b, model: m.upstreamId, stream: true }), signal }, routeId);
  let r = await send(body);
  if (r.status === 400) {
    // A request asking for more output than the model allows is refused with 400; the same request with a smaller ceiling usually passes.
    const key = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'].find(k => typeof body[k] === 'number' && body[k] > CLAMPED_TOKENS);
    if (key) { const retry = await send({ ...body, [key]: CLAMPED_TOKENS }); if (retry.ok) { r.body?.cancel().catch(() => {}); r = retry; } else retry.body?.cancel().catch(() => {}); }
  }
  return asUnavailable(r);
}
// The address-wide anonymous limit, as opposed to one model being busy.
export const isAddressLimit = (status: number, message: string) => status === 429 && /PROMOTION_MODEL_LIMIT_REACHED/.test(message);
// Every Kilo model shares the limit, so all of them rest together; one request after the pause tells whether it has lifted.
export function pauseKilo(providerId: string, message: string, ms = KILO_LIMIT_PAUSE_MS) {
  const until = Date.now() + ms; const note = redactError(message).slice(0, 300);
  for (const m of models.values()) if (m.providerId === providerId && m.state !== 'unavailable') { m.state = 'cooldown'; m.cooldownUntil = until; m.error = note; saveModel(m); }
  return until;
}
