import type { IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { settings, persist, equal } from './state';
import { GatewayError } from './queue';
import { clientIp, keyGate } from './auth';
import { notify } from './notifications';
import type { ApiKey } from './types';
// Scoped client keys: per-key concurrency, requests/minute, tokens/minute, a total token budget, an expiry and a model allow-list.
const reqWindow = new Map<string, number[]>();
const tokenWindow = new Map<string, { t: number; n: number }[]>();
let dirty: ReturnType<typeof setTimeout> | undefined;
const saveSoon = () => { if (dirty) return; dirty = setTimeout(() => { dirty = undefined; persist(); }, 3000); dirty.unref?.(); };
const limited = (message: string, retryAfter: number, type = 'rate_limit_error') => new GatewayError(message, 429, type, retryAfter);
export function tokenOf(req: IncomingMessage) {
  const auth = String(req.headers.authorization || '');
  return (/^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : '') || String(req.headers['x-api-key'] || '');
}
// Validates the caller's key. `count` is true for requests that consume capacity (inference), false for listing endpoints.
export function authenticate(req: IncomingMessage, count = false): ApiKey {
  const ip = clientIp(req); const wait = keyGate.retryAfter(ip);
  if (wait) throw limited('Too many invalid API keys from this address. Try again later.', wait, 'rate_limited');
  const value = tokenOf(req); const key = value ? settings.keys.find(k => equal(k.value, value)) : undefined;
  if (!key) { keyGate.fail(ip); throw new GatewayError('Invalid gateway API key', 401, 'authentication_error'); }
  keyGate.clear(ip);
  if (!key.enabled) throw new GatewayError('This API key is disabled', 403, 'permission_error');
  if (key.expiresAt && key.expiresAt < Date.now()) throw new GatewayError(`This API key expired on ${new Date(key.expiresAt).toISOString().slice(0, 10)}`, 403, 'key_expired');
  if (key.budget && (key.used || 0) >= key.budget) { notify('Token budget used up', `Key "${key.name}" reached its ${key.budget.toLocaleString()} token budget.`, 'warning', 'budget-' + key.id, 3600000); throw new GatewayError(`Token budget of ${key.budget.toLocaleString()} reached for this key`, 429, 'insufficient_quota'); }
  if (!count) return key;
  const now = Date.now(); const cutoff = now - 60000;
  const reqs = (reqWindow.get(key.id) || []).filter(t => t > cutoff); const toks = (tokenWindow.get(key.id) || []).filter(e => e.t > cutoff);
  if (key.rpm && reqs.length >= key.rpm) throw limited(`Request rate limit of ${key.rpm}/min reached for this key`, Math.max(1, Math.ceil((reqs[0] + 60000 - now) / 1000)));
  if (key.tpm && toks.reduce((s, e) => s + e.n, 0) >= key.tpm) throw limited(`Token rate limit of ${key.tpm}/min reached for this key`, Math.max(1, Math.ceil((toks[0].t + 60000 - now) / 1000)));
  reqs.push(now); reqWindow.set(key.id, reqs); tokenWindow.set(key.id, toks); return key;
}
export const modelAllowed = (key: ApiKey, model: string) => !key.models?.length || /^auto(:|$)/.test(model) || key.models.includes(model) || key.models.some(m => model.endsWith('/' + m));
export function recordUsage(keyId: string, tokens: number) {
  const key = settings.keys.find(k => k.id === keyId); if (!key) return;
  key.requests = (key.requests || 0) + 1; key.used = (key.used || 0) + tokens; key.lastUsed = Date.now();
  if (tokens > 0) { const list = tokenWindow.get(keyId) || []; list.push({ t: Date.now(), n: tokens }); tokenWindow.set(keyId, list); }
  saveSoon();
}
const whole = (v: unknown, lo: number, hi: number, label: string) => {
  if (v === undefined || v === null || v === '' || v === 0) return undefined; const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new GatewayError(`${label} must be between ${lo} and ${hi}`, 400); return Math.floor(n);
};
// Shared by create and update so both accept the same fields with the same validation.
export function keyFields(b: any): Partial<ApiKey> {
  const out: Partial<ApiKey> = {};
  if (b.name !== undefined) out.name = String(b.name || 'API key').slice(0, 80);
  if (b.limit !== undefined) out.limit = whole(b.limit, 1, 64, 'Concurrent limit') ?? 4;
  if (b.rpm !== undefined) out.rpm = whole(b.rpm, 1, 100000, 'Requests per minute');
  if (b.tpm !== undefined) out.tpm = whole(b.tpm, 1, 1e9, 'Tokens per minute');
  if (b.budget !== undefined) out.budget = whole(b.budget, 1, 1e12, 'Token budget');
  if (b.models !== undefined) out.models = Array.isArray(b.models) ? b.models.filter((x: unknown) => typeof x === 'string' && x.length < 200).slice(0, 200) : [];
  if (b.expiresAt !== undefined) { if (!b.expiresAt) out.expiresAt = undefined; else { const t = typeof b.expiresAt === 'number' ? b.expiresAt : Date.parse(String(b.expiresAt)); if (!Number.isFinite(t) || t < Date.now()) throw new GatewayError('Expiry must be a date in the future', 400); out.expiresAt = t; } }
  if (b.enabled !== undefined) out.enabled = !!b.enabled;
  return out;
}
export function createKey(b: any): ApiKey {
  const key: ApiKey = { id: crypto.randomUUID(), name: 'Coding client', value: 'pg_' + randomBytes(24).toString('hex'), enabled: true, limit: 4, created: Date.now(), used: 0, requests: 0, ...keyFields(b) };
  settings.keys.push(key); persist(); return key;
}
export function updateKey(id: string, b: any) {
  const key = settings.keys.find(k => k.id === id); if (!key) throw new GatewayError('Key not found', 404);
  const patch = keyFields(b); Object.assign(key, patch);
  for (const field of ['rpm', 'tpm', 'budget', 'expiresAt'] as const) if (field in patch && patch[field] === undefined) delete key[field];
  if (b.resetUsage) { key.used = 0; key.requests = 0; }
  if (b.regenerate) key.value = 'pg_' + randomBytes(24).toString('hex');
  persist(); return key;
}
