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
export const keyProblem = (key: ApiKey, now = Date.now()) => !key.enabled ? 'it is switched off' : key.expiresAt && key.expiresAt <= now ? 'it has expired' : key.budget && (key.used || 0) >= key.budget ? 'its token budget is used up' : '';
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// ---- one decision for a model, used by real requests and by the preview alike
export type Verdict = { ok: boolean; reason: string; short: string; via?: string };
// `capability` says whether a model that is listed as unable to do what the request needs is excluded (true for automatic choices, false for a
// model the user named, which is tried anyway and only noted).
export function judge(m: Model, key: ApiKey | undefined, needs: Needs, capability: boolean): Verdict {
  const p = settings.providers.find(x => x.id === m.providerId);
  if (!p || !p.enabled) return { ok: false, short: 'provider off', reason: 'its provider is switched off or removed' };
  if (m.state === 'unavailable') return { ok: false, short: 'unavailable', reason: m.error ? `it is marked unavailable (${m.error.slice(0, 90)})` : 'it is marked unavailable' };
  if (m.cooldownUntil > Date.now()) return { ok: false, short: 'resting', reason: `it is resting until ${clock(m.cooldownUntil)}` };
  if (key && !modelAllowed(key, m.id)) return { ok: false, short: 'key not allowed', reason: 'this client key does not allow that model' };
  const why = lacks(m, needs);
  if (why && capability) return { ok: false, short: why.short, reason: why.long };
  try { const route = routeForProvider(p, m.id, true); return { ok: true, short: '', reason: why ? `eligible, but ${why.long}; it is tried anyway because it was named` : 'eligible', via: route.name }; }
  catch (e: any) { return { ok: false, short: 'route unavailable', reason: `its configured route is unavailable: ${String(e?.message || e).replace(/\s*Change them on the Providers page\.?$/, '').slice(0, 220)}` }; }
}
export type Selection = { picked: Model[]; rows: { m: Model; v: Verdict }[]; fallback?: 'capability' };
// The first `limit` models of an automatic list that can take the request, in order: not resting, allowed for the key, able to do what the request
// needs, and with a route that would really be used. The whole list is searched, however long, so the choice never depends on how much is displayed:
// a capable model at position 200 is found. The models passed over on the way are in `rows` with their reason; `extra` more are judged after the
// limit is reached so a preview can show what comes next.
// When none passes only because of capability, the best ones are tried as they are: the listing may be wrong, and a refusal then costs one attempt.
// With `lastResort` (real requests) the first models are tried even when none passes at all, so the request fails with the real reason, not silently.
export function select(list: Model[], limit: number, key: ApiKey | undefined, needs: Needs, opts: { extra?: number; lastResort?: boolean } = {}): Selection {
  const { extra = 0, lastResort = false } = opts;
  const rows: Selection['rows'] = []; const picked: Model[] = []; let after = 0;
  for (const m of list) {
    if (picked.length >= limit) { if (after >= extra) break; after++; }
    const v = judge(m, key, needs, true); rows.push({ m, v });
    if (v.ok && picked.length < limit) picked.push(m);
  }
  if (picked.length) return { picked, rows };
  if (rows.some(r => !r.v.ok && lacks(r.m, needs))) {
    const alt: Model[] = [];
    for (const m of list) { if (alt.length >= limit) break; if (judge(m, key, needs, false).ok) alt.push(m); }
    if (alt.length) return { picked: alt, rows, fallback: 'capability' };
  }
  return { picked: lastResort ? list.slice(0, limit) : [], rows };
}
// The real-request form: the chosen models, and the models passed over before the last of them, named in `skipped` as `model (why)`. A long list is
// cut after the first few so the answer's header stays small.
const NAMED_SKIPS = 10;
export function pickFrom(list: Model[], limit: number, key: ApiKey | undefined, needs: Needs, skipped: string[]): Model[] {
  const s = select(list, limit, key, needs, { lastResort: true });
  if (s.fallback === 'capability') { logEvent('warn', 'requests', `No model is listed as able to handle this request (${s.rows.filter(r => !r.v.ok).slice(0, 3).map(r => `${r.m.id}: ${r.v.short}`).join(', ')}); trying the best ones anyway`); return s.picked; }
  const last = s.picked.length ? Math.max(...s.picked.map(m => list.indexOf(m))) : -1;
  const passed = s.rows.filter(r => !r.v.ok && list.indexOf(r.m) < last).map(r => `${r.m.id} (${r.v.short})`);
  skipped.push(...passed.slice(0, NAMED_SKIPS)); if (passed.length > NAMED_SKIPS) skipped.push(`+${passed.length - NAMED_SKIPS} more`);
  return s.picked;
}

// ---- the preview: the same choices as a real request, asked without sending anything
export type PlanStep = { model: string; provider: string; status: 'try' | 'backup' | 'skip' | 'later'; reason: string; via?: string; from?: string };
export type Plan = { request: string; kind: 'auto' | 'chain' | 'model'; key: string | null; needs: Needs; steps: PlanStep[]; notes: string[]; summary: string; sent: false };
const SHOW_ROWS = 12;
export function previewRouting(requested: string, key: ApiKey | undefined, needs: Needs): Plan {
  const asked = requested.trim() || 'auto'; const notes: string[] = []; const ranked = rankedModels();
  if (key) { const why = keyProblem(key); if (why) notes.push(`This client key cannot be used right now: ${why}.`); }
  type Row = { id: string; m?: Model; v: Verdict; from?: string; chosen: boolean; note?: string };
  const rows: Row[] = [];
  // An alias (auto, auto:smart, auto:fast) goes through the same selection as a real request; a few models after the chosen ones are shown for context.
  const alias = (name: string, limit: number) => {
    const sel = select(autoOrder(name, ranked), limit, key, needs, { extra: 2 });
    if (!sel.rows.length) notes.push(`No model is available for "${name}" right now.`);
    if (sel.fallback === 'capability') notes.push('No model is listed as able to handle this request, so the best ones are tried anyway: provider listings are not always right.');
    // Everything was judged; only what is shown is cut: the first rows and every chosen model, with a note for the rest.
    const shown = sel.rows.filter((r, i) => i < SHOW_ROWS || sel.picked.includes(r.m));
    if (shown.length < sel.rows.length) notes.push(`${sel.rows.length - shown.length} more models were checked and skipped for the same kinds of reasons.`);
    for (const r of shown) rows.push({ id: r.m.id, m: r.m, v: r.v, from: name === asked ? undefined : name, chosen: sel.picked.includes(r.m) });
    if (sel.fallback === 'capability') for (const m of sel.picked) { const i = rows.findIndex(r => r.m === m); const v = judge(m, key, needs, false); if (i >= 0) rows[i] = { ...rows[i], v: { ...v, reason: `tried anyway: ${rows[i].v.reason}` }, chosen: true }; }
  };
  let kind: Plan['kind'] = 'model';
  const chain = chainFor(asked);
  if (chain) {
    kind = 'chain'; if (!chain.enabled) notes.push(`The chain "${chain.name}" is switched off, so a request for it is refused.`);
    for (const step of chain.models) {
      if (AUTO_STEPS.includes(step)) { alias(step, 3); continue; }
      const m = modelFor(step);
      if (!m) rows.push({ id: step, v: { ok: false, short: 'unknown', reason: 'Polygate no longer lists this model' }, chosen: false });
      else { const v = judge(m, key, needs, false); rows.push({ id: m.id, m, v, chosen: v.ok }); }
    }
  } else if (AUTO_STEPS.includes(asked)) { kind = 'auto'; alias(asked, settings.fallback ? 3 : 1); }
  else {
    const m = models.get(asked) || [...models.values()].find(x => x.upstreamId === asked);
    if (!m) rows.push({ id: asked, v: { ok: false, short: 'unknown', reason: 'Polygate does not know a model or chain with this name' }, chosen: false });
    else { const v = judge(m, key, needs, false); rows.push({ id: m.id, m, v, chosen: v.ok }); }
  }
  let first = true;
  const steps: PlanStep[] = rows.map(r => {
    const provider = r.m ? settings.providers.find(p => p.id === r.m!.providerId)?.name || r.m.providerId : '—';
    const from = r.from ? { from: r.from } : {};
    if (!r.v.ok && !r.chosen) return { model: r.id, provider, status: 'skip' as const, reason: r.v.reason, ...from };
    if (!r.chosen) return { model: r.id, provider, status: 'later' as const, reason: 'not reached: the models before it are tried first', ...from };
    const status = first ? 'try' as const : 'backup' as const; first = false;
    return { model: r.id, provider, status, reason: r.v.reason, via: r.v.via, ...from };
  });
  const head = steps.find(s => s.status === 'try');
  const summary = head ? `Would try ${head.model} first${head.via ? `, through ${head.via}` : ''}.` : 'No model can take this request right now.';
  return { request: asked, kind, key: key?.name ?? null, needs, steps, notes, summary, sent: false };
}
