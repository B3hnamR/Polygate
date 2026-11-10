import { settings, models } from './state';
import { probeResult } from './gateway';
import { GatewayError } from './queue';
import { logEvent } from './logbook';
import type { Model, Provider } from './types';

// Checking every model of one provider, on request and on a timer. A check is one small real request, so it counts toward the provider's limits:
// runs stop as soon as the provider asks to slow down (HTTP 429), and the timer takes one model at a time and backs off the same way.
// One exception: a refusal the adapter knows to be a single model's own allowance (probe scope 'model') says nothing about the provider's
// other models, so the run counts it (`limited`) and goes on. Any other 429 still stops the run; its cause is not guessed.
export type CheckRun = { providerId: string; total: number; done: number; ok: number; failed: number; limited: number; running: boolean; startedAt: number; finishedAt?: number; note?: string };
export const AUTO_CHECK_CHOICES = [0, 60, 360, 1440];
const KEEP_FINISHED_MS = 10 * 60000;
const AUTO_TICK_MS = 30000;
const AUTO_BACKOFF_MS = 15 * 60000;
// Providers with a shared allowance get one check at a time with a pause between them; a server of your own can take a few at once.
const shared = (p: Provider) => p.kind === 'free' || p.kind === 'kilo' || p.kind === 'zai';

type Probe = (id: string, slots?: number) => Promise<{ model: Model; status: number; scope?: 'model' }>;
let probe: Probe = probeResult;
export const __setProbe = (fn?: Probe) => { probe = fn || probeResult; };

const runs = new Map<string, CheckRun>();
const stopRequests = new Set<string>();
const backoff = new Map<string, number>();
const attempted = new Map<string, number>();
export const __resetChecks = () => { runs.clear(); stopRequests.clear(); backoff.clear(); attempted.clear(); };

export function checkRuns(now = Date.now()): Record<string, CheckRun> {
  const out: Record<string, CheckRun> = {};
  for (const [id, r] of runs) { if (!r.running && now - (r.finishedAt || 0) > KEEP_FINISHED_MS) runs.delete(id); else out[id] = r; }
  return out;
}
const enabledProvider = (id: string) => { const p = settings.providers.find(x => x.id === id); if (!p) throw new GatewayError('Provider not found', 404); if (!p.enabled) throw new GatewayError('This provider is switched off. Switch it on first.', 400); return p; };
const providerModels = (id: string) => [...models.values()].filter(m => m.providerId === id);

// Starts in the background and returns at once; the dashboard follows the counts in /admin/state.
export function startCheck(providerId: string): CheckRun {
  const p = enabledProvider(providerId);
  const current = runs.get(providerId); if (current?.running) return current;
  const list = providerModels(providerId).filter(m => m.cooldownUntil <= Date.now());
  if (!list.length) throw new GatewayError('No model of this provider can be checked right now.', 400);
  const run: CheckRun = { providerId, total: list.length, done: 0, ok: 0, failed: 0, limited: 0, running: true, startedAt: Date.now() };
  runs.set(providerId, run); stopRequests.delete(providerId);
  void work(p, list, run);
  return run;
}
export function stopCheck(providerId: string) { if (runs.get(providerId)?.running) stopRequests.add(providerId); }

async function work(p: Provider, list: Model[], run: CheckRun) {
  const queueOf = [...list]; const slots = shared(p) ? 1 : 3; let halted = '';
  const worker = async () => {
    while (queueOf.length && !halted && !stopRequests.has(p.id)) {
      const m = queueOf.shift()!;
      try {
        const { status, scope } = await probe(m.id, slots);
        run.done++; if (status < 400) run.ok++; else run.failed++;
        if (status >= 400 && scope === 'model') run.limited++;
        else if (status === 429) halted = `${p.name} asked to slow down (HTTP 429), so the run stopped. The rest keep their last result.`;
      } catch (e: any) {
        run.done++; run.failed++;
        if (e instanceof GatewayError && e.type === 'route_unavailable') halted = String(e.message);
      }
      if (shared(p) && queueOf.length && !halted) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  };
  await Promise.all(Array.from({ length: slots }, worker)).catch(() => {});
  const stopped = stopRequests.delete(p.id);
  run.running = false; run.finishedAt = Date.now();
  const own = run.limited ? `${run.limited === 1 ? '1 model has' : `${run.limited} models have`} no allowance of ${run.limited === 1 ? 'its' : 'their'} own left for now; the other models were still checked.` : '';
  run.note = [halted || (stopped ? `Stopped after ${run.done} of ${run.total}.` : ''), own].filter(Boolean).join(' ') || undefined;
  logEvent(halted ? 'warn' : 'info', 'models', `Checked ${run.done} of ${run.total} models of ${p.name}: ${run.ok} answered, ${run.failed} did not`, run.note ? { note: run.note } : undefined);
}

// What the timer does for a provider: its own choice, or (settings from before the choice existed) the old all-providers switch, which never included Kilo.
export const autoCheckMinutes = (p: Provider) => p.autoCheckMinutes ?? (settings.autoProbe && p.kind !== 'kilo' ? settings.refreshMinutes : 0);
// The model the timer would check next: the one checked longest ago, among those past the provider's interval. Unavailable models are included, so one that comes back is found.
export function nextAutoCheck(p: Provider, now = Date.now()) {
  const minutes = autoCheckMinutes(p); if (!minutes) return;
  const due = now - minutes * 60000;
  return providerModels(p.id).filter(m => m.cooldownUntil <= now && Math.max(m.checkedAt || 0, attempted.get(m.id) || 0) < due).sort((a, b) => (a.checkedAt || 0) - (b.checkedAt || 0))[0];
}
export async function autoCheckTick(now = Date.now()) {
  if (!settings.enabled) return;
  await Promise.all(settings.providers.filter(p => p.enabled && !runs.get(p.id)?.running && (backoff.get(p.id) || 0) <= now).map(async p => {
    const m = nextAutoCheck(p, now); if (!m) return;
    attempted.set(m.id, now);
    try { const { status, scope } = await probe(m.id, 1); if (status === 429 && scope !== 'model') backoff.set(p.id, now + AUTO_BACKOFF_MS); }
    catch (e: any) { if (e instanceof GatewayError && e.type === 'route_unavailable') backoff.set(p.id, now + AUTO_BACKOFF_MS); }
  }));
}
export function startAutoChecks() {
  let busy = false;
  const timer = setInterval(() => { if (busy) return; busy = true; void autoCheckTick().finally(() => { busy = false; }); }, AUTO_TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
