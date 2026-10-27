import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { settings, models, stateDir, redactError } from './state';
import { GatewayError } from './queue';
import { logEvent } from './logbook';
export type Notice = { id: string; title: string; message: string; type: 'info' | 'success' | 'warning' | 'error'; time: number; read: boolean };
const file = path.join(stateDir, 'notifications.json');
let items: Notice[] = [];
try { if (existsSync(file)) items = JSON.parse(readFileSync(file, 'utf8')); } catch { items = []; }
const save = () => { try { writeFileSync(file, JSON.stringify(items.slice(0, 100))); } catch { /* the in-memory list still works */ } };
const recent = new Map<string, number>();
// Repeats of the same event inside the quiet period are dropped so a flapping route cannot flood the list or the webhook.
export function notify(title: string, message: string, type: Notice['type'] = 'info', key = title + '|' + message, quietMs = 10 * 60000) {
  const last = recent.get(key); if (last && Date.now() - last < quietMs) return;
  recent.set(key, Date.now()); if (recent.size > 500) recent.clear();
  const item: Notice = { id: randomUUID(), title, message, type, time: Date.now(), read: false };
  items.unshift(item); items = items.slice(0, 100); save(); void deliver(item);
  logEvent(type === 'error' ? 'error' : type === 'warning' ? 'warn' : 'info', noticeSource(title), `${title}: ${message}`);
}
const noticeSource = (title: string) => /warp/i.test(title) ? 'warp' : /https|certificate/i.test(title) ? 'https' : /prox/i.test(title) ? 'proxies' : /kilo|model/i.test(title) ? 'models' : /route|exit/i.test(title) ? 'routes' : /budget|key/i.test(title) ? 'keys' : 'gateway';
export const notices = () => ({ items: items.slice(0, 50), unread: items.filter(n => !n.read).length });
export function markAllRead() { for (const n of items) n.read = true; save(); }
export function clearNotices() { items = []; save(); }
// force (the test button) ignores the minimum level, so a test is never silently suppressed. Returns how delivery went.
async function deliver(item: Notice, force = false): Promise<{ ok: boolean; error?: string }> {
  const url = settings.notify?.webhookUrl; if (!url) return { ok: false, error: 'No webhook URL is saved' };
  const levels = ['info', 'success', 'warning', 'error']; if (!force && levels.indexOf(item.type) < levels.indexOf(settings.notify?.minLevel || 'warning')) return { ok: true };
  const text = `[Polygate] ${item.title}: ${item.message}`;
  try {
    const body = /discord(app)?\.com\/api\/webhooks/.test(url) ? { content: text } : /hooks\.slack\.com/.test(url) ? { text } : { title: item.title, message: item.message, type: item.type, time: new Date(item.time).toISOString(), text };
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    await r.body?.cancel();
    if (!r.ok) return { ok: false, error: `the webhook answered HTTP ${r.status}` };
    return { ok: true };
  } catch (error) { console.warn('[notify] webhook failed:', redactError(String(error))); return { ok: false, error: redactError(String((error as Error)?.message || error)).slice(0, 120) }; }
}
// Sends one test message and waits for the webhook's answer, so the button reports what really happened.
export async function testWebhook() {
  if (!settings.notify?.webhookUrl) throw new GatewayError('Save a webhook URL first', 400);
  const item: Notice = { id: randomUUID(), title: 'Test notification', message: 'If you can read this, the webhook works.', type: 'warning', time: Date.now(), read: false };
  items.unshift(item); items = items.slice(0, 100); save();
  const result = await deliver(item, true); if (!result.ok) throw new GatewayError(`The webhook did not accept the test message: ${result.error}`, 502, 'webhook_failed');
}
// Watches coarse health transitions and raises one notice per change (not per request).
export function startNotifier() {
  let routesUp: boolean | undefined, modelsUp: boolean | undefined;
  const tick = () => {
    const now = Date.now();
    const usable = settings.routes.filter(r => r.enabled && (!r.cooldownUntil || r.cooldownUntil < now)).length;
    if (routesUp !== undefined && (usable > 0) !== routesUp) usable > 0 ? notify('Routes recovered', `${usable} network route(s) are available again.`, 'success', 'routes-up') : notify('No network route available', 'Every enabled route is cooling down. Requests will fail until one recovers.', 'error', 'routes-down');
    routesUp = usable > 0;
    const ready = [...models.values()].filter(m => m.state !== 'unavailable' && m.cooldownUntil <= now && settings.providers.some(p => p.id === m.providerId && p.enabled)).length;
    if (modelsUp !== undefined && (ready > 0) !== modelsUp) ready > 0 ? notify('Models recovered', `${ready} model(s) are ready.`, 'success', 'models-up') : notify('No model is ready', 'Every model is cooling down or unavailable.', 'error', 'models-down');
    modelsUp = ready > 0;
  };
  const timer = setInterval(tick, 30000); timer.unref(); setTimeout(tick, 2000).unref(); return () => clearInterval(timer);
}
