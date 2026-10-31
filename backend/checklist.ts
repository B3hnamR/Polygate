import { settings } from './state';
import { routeForProvider, providerRoutes } from './transport';
import { catalogProblems } from './providers';
import { engineMode, warpTarget } from './warp';
import { keyProblem } from './plan';
import { resetTime } from './exhaustion';
import type { Model, Provider } from './types';

// The things that stop requests or hurt some of them, each with what it means and where to fix it. It is worked out from the current state on every
// look, so an item stays until its cause is gone, and it comes back after a restart if the cause does. Nothing here changes a setting: a fix is a
// button the user presses, and only ones that retry or refresh (never ones that switch something on, such as Direct) are offered as buttons.
export type Fix = { label: string; endpoint: string; body?: Record<string, unknown> };
export type CheckItem = { id: string; severity: 'blocking' | 'warning'; title: string; detail: string; page: 'Providers' | 'Models' | 'Settings' | 'Routing'; fix?: Fix };
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const REFRESH: Fix = { label: 'Refresh catalog', endpoint: '/admin/discover' };

export function checklist(ctx: { providers: Provider[]; known: Model[]; usable: Model[]; starting: boolean }): CheckItem[] {
  const now = Date.now(); const items: CheckItem[] = [];
  const { providers, known, usable, starting } = ctx;
  // ---- what stops every request
  if (!providers.length) items.push({ id: 'no_provider', severity: 'blocking', title: 'No provider is switched on', detail: 'No provider is switched on.', page: 'Providers' });
  else if (!known.length && !starting) items.push({ id: 'no_models', severity: 'blocking', title: 'No models were found', detail: 'No usable models are known yet. Refresh the model catalog.', page: 'Models', fix: REFRESH });
  else if (known.length && !usable.length) {
    // Listed, but every one is paused after errors: requests are refused until the first comes back.
    const back = Math.min(...known.map(m => m.cooldownUntil));
    items.push({ id: 'models_resting', severity: 'blocking', title: 'Every model is resting', detail: `All ${known.length} known model${known.length === 1 ? ' is' : 's are'} resting after errors; the first is back at ${clock(back)}. The pause can be turned off under Routing.`, page: 'Models' });
  }
  const keys = settings.keys; const usableKeys = keys.filter(k => !keyProblem(k, now));
  if (!usableKeys.length) {
    const why = keys.map(k => `"${k.name}" ${keyProblem(k, now)}`).join('; ');
    items.push({ id: 'no_key', severity: 'blocking', title: 'No client key can be used', detail: keys.length ? `No client API key can be used: ${why}.` : 'No client API key exists. Add one in Settings.', page: 'Settings' });
  } else for (const k of keys) {
    // A key that is switched off was switched off on purpose. One that ran out or expired is worth saying, while another key still works.
    const why = k.expiresAt && k.expiresAt <= now ? 'has expired' : k.budget && (k.used || 0) >= k.budget ? 'has used up its token budget' : '';
    if (why) items.push({ id: `key:${k.id}`, severity: 'warning', title: `Client key "${k.name}" ${why}`, detail: 'Requests that use this key are rejected.', page: 'Settings' });
  }
  if (usable.length) {
    let reason = ''; let routed = false;
    for (const p of providers) { const m = usable.find(x => x.providerId === p.id); if (!m) continue; try { routeForProvider(p, m.id, true); routed = true; break; } catch (e: any) { reason ||= String(e?.message || e); } }
    if (!routed) items.push({ id: 'no_route', severity: 'blocking', title: 'No route can take requests', detail: reason || 'No route can take a request right now.', page: 'Routing' });
  }
  // ---- what hurts some requests
  for (const p of providers) {
    const missing = (providerRoutes(p)?.ids || []).filter(id => !settings.routes.some(r => r.id === id));
    if (missing.length) items.push({ id: `missing:${p.id}`, severity: 'warning', title: `${p.name} lists a route that no longer exists`, detail: 'Choose its routes again on the Providers page.', page: 'Providers' });
  }
  for (const c of catalogProblems()) { const p = providers.find(x => x.id === c.providerId); if (p) items.push({ id: `catalog:${p.id}`, severity: 'warning', title: `${p.name}: the model list could not be read`, detail: c.error, page: 'Models', fix: REFRESH }); }
  const inUse = (id: string) => settings.routeId === id || providers.some(p => providerRoutes(p)?.ids.includes(id));
  let warpSaid = false;
  for (const r of settings.routes.filter(x => x.enabled)) {
    const used = inUse(r.id) || (settings.rotate && (r.kind !== 'direct' || settings.spreadDirect === true));
    if (!used) continue;
    if (r.kind === 'warp' && engineMode() !== 'disabled' && !warpTarget() && !warpSaid) { warpSaid = true; items.push({ id: 'warp_down', severity: 'warning', title: 'Cloudflare WARP is not connected', detail: 'Requests assigned to WARP cannot leave.', page: 'Routing', fix: { label: 'Reconnect WARP', endpoint: '/admin/warp/connect' } }); }
    if (r.cooldownUntil && r.cooldownUntil > now) items.push({ id: `rest:${r.id}`, severity: 'warning', title: `${r.name} is resting after errors`, detail: `Requests wait for it until ${clock(r.cooldownUntil)}. If the connection is back, try it again now.`, page: 'Routing', fix: { label: 'Try it again now', endpoint: '/admin/routes/resume', body: { id: r.id } } });
    if (r.exhaustedUntil && r.exhaustedUntil > now) items.push({ id: `used:${r.id}`, severity: 'warning', title: `${r.name} has used up its daily allowance`, detail: `OpenCode Free is not available through this exit until ${resetTime(r.exhaustedUntil)}.`, page: 'Routing' });
  }
  return items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'blocking' ? -1 : 1));
}
