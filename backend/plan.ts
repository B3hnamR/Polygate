import { settings, models } from './state';
import { rankedModels } from './providers';
import { routeForProvider } from './transport';
import { chainFor, modelFor, AUTO_STEPS } from './chains';
import { modelAllowed } from './keys';
import { logEvent } from './logbook';
import type { Model, ApiKey } from './types';

// What a request asks of a model, read from the request itself. A model is skipped only when its listing says it cannot do one of these:
// an unknown ability (no information from the provider) never excludes a model, because provider metadata is not always complete or right.
export type Needs = { tools: boolean; images: boolean; tokens: number };
export const noNeeds: Needs = { tools: false, images: false, tokens: 0 };
const IMAGE_PART = new Set(['image_url', 'image', 'input_image']);
export function needsOf(chat: any): Needs {
  const messages: any[] = Array.isArray(chat?.messages) ? chat.messages : [];
  let tools = Array.isArray(chat?.tools) && chat.tools.length > 0; let images = false; let chars = tools ? JSON.stringify(chat.tools).length : 0;
  for (const m of messages) {
    if (m?.role === 'tool' || (Array.isArray(m?.tool_calls) && m.tool_calls.length)) { tools = true; if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length; }
    if (typeof m?.content === 'string') chars += m.content.length;
    else if (Array.isArray(m?.content)) for (const part of m.content) { if (IMAGE_PART.has(part?.type)) images = true; else if (typeof part?.text === 'string') chars += part.text.length; }
  }
  // About four characters to a token; images are left out of the count, so a large picture does not look like a huge prompt.
  return { tools, images, tokens: Math.ceil(chars / 4) };
}
const k = (n: number) => n >= 10000 ? Math.round(n / 1000).toLocaleString() + 'k' : n.toLocaleString();
export function lacks(m: Model, n: Needs): { short: string; long: string } | undefined {
  if (n.tools && m.tools === false) return { short: 'no tool support', long: 'the request needs tool support and this model is listed without it' };
  if (n.images && m.images === false) return { short: 'text only', long: 'the request has an image and this model is listed as text only' };
  if (n.tokens && m.context > 0 && n.tokens > m.context) return { short: 'context too small', long: `the request is about ${k(n.tokens)} tokens and this model's context is ${k(m.context)}` };
  return undefined;
}
export const autoOrder = (requested: string, ranked: Model[]) => requested === 'auto:smart' ? ranked.filter(m => m.reasoning || m.score >= 65) : requested === 'auto:fast' ? [...ranked].sort((a, b) => (a.latency || 1e9) - (b.latency || 1e9)) : ranked;
// The first `limit` models of the list that can handle the request. The models passed over on the way are named in `skipped`. When the listings say
// that none can, the best ones are tried as they are: the listing may be wrong, and a refusal then costs one attempt, not the whole request.
export function pickCapable(list: Model[], needs: Needs, limit: number, skipped: string[]): Model[] {
  const out: Model[] = []; const passed: string[] = [];
  for (const m of list) { if (out.length >= limit) break; const why = lacks(m, needs); if (why) passed.push(`${m.id} (${why.short})`); else out.push(m); }
  if (!out.length) { if (passed.length) logEvent('warn', 'requests', `No model is listed as able to handle this request (${passed.slice(0, 3).join(', ')}); trying the best ones anyway`); return list.slice(0, limit); }
  skipped.push(...passed); return out;
}

// ---- the preview: the same choices as a real request, asked without sending anything
export type PlanStep = { model: string; provider: string; status: 'try' | 'backup' | 'skip' | 'later'; reason: string; via?: string; from?: string };
export type Plan = { request: string; kind: 'auto' | 'chain' | 'model'; key: string | null; needs: Needs; steps: PlanStep[]; notes: string[]; summary: string; sent: false };
export const keyProblem = (key: ApiKey, now = Date.now()) => !key.enabled ? 'it is switched off' : key.expiresAt && key.expiresAt <= now ? 'it has expired' : key.budget && (key.used || 0) >= key.budget ? 'its token budget is used up' : '';
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
type Look = { ok: boolean; reason: string; via?: string };
function look(m: Model, key: ApiKey | undefined, needs: Needs, capabilityApplies: boolean): Look {
  const p = settings.providers.find(x => x.id === m.providerId);
  if (!p || !p.enabled) return { ok: false, reason: 'its provider is switched off or removed' };
  if (m.state === 'unavailable') return { ok: false, reason: m.error ? `it is marked unavailable (${m.error.slice(0, 90)})` : 'it is marked unavailable' };
  if (m.cooldownUntil > Date.now()) return { ok: false, reason: `it is resting until ${clock(m.cooldownUntil)}` };
  if (key && !modelAllowed(key, m.id)) return { ok: false, reason: 'this client key does not allow that model' };
  const why = lacks(m, needs);
  if (why && capabilityApplies) return { ok: false, reason: why.long };
  try { const route = routeForProvider(p, m.id, true); return { ok: true, reason: why ? `eligible, but ${why.long}; it is tried anyway because it was named` : 'eligible', via: route.name }; }
  catch (e: any) { return { ok: false, reason: `its configured route is unavailable: ${String(e?.message || e).replace(/\s*Change them on the Providers page\.?$/, '').slice(0, 220)}` }; }
}
export function previewRouting(requested: string, key: ApiKey | undefined, needs: Needs): Plan {
  const asked = requested.trim() || 'auto'; const notes: string[] = []; const ranked = rankedModels();
  if (key) { const why = keyProblem(key); if (why) notes.push(`This client key cannot be used right now: ${why}.`); }
  const rows: { m?: Model; id: string; look: Look; from?: string; group: string; groupLimit: number }[] = [];
  // An alias (auto, auto:smart, auto:fast) shows the models in its order until enough are eligible, and a few more so the order is clear.
  const alias = (name: string, limit: number) => {
    let found = 0, shown = 0;
    for (const m of autoOrder(name, ranked)) {
      if (shown >= 15 || found >= limit + 2) break;
      const l = look(m, key, needs, true); if (l.ok) found++; shown++;
      rows.push({ m, id: m.id, look: l, from: name === asked ? undefined : name, group: name, groupLimit: limit });
    }
    if (!shown) notes.push(`No model is available for "${name}" right now.`);
  };
  let kind: Plan['kind'] = 'model';
  const chain = chainFor(asked);
  if (chain) {
    kind = 'chain'; if (!chain.enabled) notes.push(`The chain "${chain.name}" is switched off, so a request for it is refused.`);
    for (const step of chain.models) {
      if (AUTO_STEPS.includes(step)) { alias(step, 3); continue; }
      const m = modelFor(step);
      if (!m) rows.push({ id: step, look: { ok: false, reason: 'Polygate no longer lists this model' }, group: step, groupLimit: 1 });
      else rows.push({ m, id: m.id, look: look(m, key, needs, false), group: m.id, groupLimit: 1 });
    }
  } else if (AUTO_STEPS.includes(asked)) { kind = 'auto'; alias(asked, settings.fallback ? 3 : 1); }
  else {
    const m = models.get(asked) || [...models.values()].find(x => x.upstreamId === asked);
    if (!m) rows.push({ id: asked, look: { ok: false, reason: 'Polygate does not know a model or chain with this name' }, group: asked, groupLimit: 1 });
    else rows.push({ m, id: m.id, look: look(m, key, needs, false), group: m.id, groupLimit: 1 });
  }
  const taken = new Map<string, number>(); let first = true;
  const steps: PlanStep[] = rows.map(r => {
    const provider = r.m ? settings.providers.find(p => p.id === r.m!.providerId)?.name || r.m.providerId : '—';
    if (!r.look.ok) return { model: r.id, provider, status: 'skip' as const, reason: r.look.reason, ...(r.from ? { from: r.from } : {}) };
    const n = taken.get(r.group) || 0; taken.set(r.group, n + 1);
    if (n >= r.groupLimit) return { model: r.id, provider, status: 'later' as const, reason: `not reached: only the first ${r.groupLimit} ${r.groupLimit === 1 ? 'is' : 'are'} tried`, ...(r.from ? { from: r.from } : {}) };
    const status = first ? 'try' as const : 'backup' as const; first = false;
    return { model: r.id, provider, status, reason: r.look.reason, via: r.look.via, ...(r.from ? { from: r.from } : {}) };
  });
  const head = steps.find(s => s.status === 'try');
  const summary = head ? `Would try ${head.model} first${head.via ? `, through ${head.via}` : ''}.` : 'No model can take this request right now.';
  return { request: asked, kind, key: key?.name ?? null, needs, steps, notes, summary, sent: false };
}
