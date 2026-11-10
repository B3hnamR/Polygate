import type { IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { settings, models, persist, equal } from './state';
import { GatewayError } from './queue';
import { clientIp, keyGate } from './auth';
import { notify } from './notifications';
import type { ApiKey, ModelGrantKind } from './types';
// Scoped client keys: per-key concurrency, requests/minute, tokens/minute, a total token budget, an expiry and a model allow-list.
const reqWindow = new Map<string, number[]>();
const tokenWindow = new Map<string, { t: number; n: number }[]>();
const reservations = new Map<string, Set<{ amount: number }>>();
const reserved = (id: string) => [...(reservations.get(id) || [])].reduce((sum, hold) => sum + hold.amount, 0);
let dirty: ReturnType<typeof setTimeout> | undefined;
// Usage counters are saved a few seconds after a request. A failed write (disk full, a file held by antivirus) is logged and retried
// with the next save instead of throwing from the timer, which ended the process.
const savePending = () => { if (dirty) clearTimeout(dirty); dirty = undefined; try { persist(); } catch (e: any) { console.error('[state] Could not save usage:', e?.message || e); } };
const saveSoon = () => { if (dirty) return; dirty = setTimeout(savePending, 3000); dirty.unref?.(); };
// Called on shutdown so the last few seconds of usage are not lost.
export const flushKeys = () => { if (dirty) savePending(); };
// File-scope test isolation only. Call after requests settle; never exposed through the admin API.
export function __captureKeyTestState() {
  const assertIdle = () => { if (reservations.size) throw new Error('Cannot capture or restore key state while token reservations are active'); };
  assertIdle();
  const requests = structuredClone(reqWindow), tokens = structuredClone(tokenWindow);
  const restoreInvalidKeys = keyGate.__captureTestState();
  const pendingSave = !!dirty;
  const restore = () => {
    assertIdle();
    if (dirty) clearTimeout(dirty); dirty = undefined;
    reqWindow.clear(); for (const [id, list] of requests) reqWindow.set(id, structuredClone(list));
    tokenWindow.clear(); for (const [id, list] of tokens) tokenWindow.set(id, structuredClone(list));
    restoreInvalidKeys();
    if (pendingSave) saveSoon();
  };
  return Object.assign(restore, { assertIdle });
}
const limited = (message: string, retryAfter: number, type = 'rate_limit_error') => new GatewayError(message, 429, type, retryAfter);
export function tokenOf(req: IncomingMessage) {
  const auth = String(req.headers.authorization || '');
  return (/^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : '') || String(req.headers['x-api-key'] || '');
}
// Validates the caller's key. `count` is true for requests that consume capacity (inference), false for listing endpoints.
export function authenticate(req: IncomingMessage, count = false): ApiKey {
  // A valid key is accepted even from an address that is paused for bad keys: on a desktop, or behind a proxy without the trust flag,
  // every client shares one address, and one misconfigured client must not lock out the others. Only failures are throttled.
  const ip = clientIp(req); const value = tokenOf(req); const key = value ? settings.keys.find(k => equal(k.value, value)) : undefined;
  if (!key) { const wait = keyGate.retryAfter(ip); if (wait) throw limited('Too many invalid API keys from this address. Try again later.', wait, 'rate_limited'); keyGate.fail(ip); throw new GatewayError('Invalid gateway API key', 401, 'authentication_error'); }
  keyGate.clear(ip);
  if (!key.enabled) throw new GatewayError('This API key is disabled', 403, 'permission_error');
  if (key.expiresAt && key.expiresAt < Date.now()) throw new GatewayError(`This API key expired on ${new Date(key.expiresAt).toISOString().slice(0, 10)}`, 403, 'key_expired');
  if (key.budget && (key.used || 0) >= key.budget) { notify('Token budget used up', `Key "${key.name}" reached its ${key.budget.toLocaleString()} token budget.`, 'warning', 'budget-' + key.id, 3600000); throw new GatewayError(`Token budget of ${key.budget.toLocaleString()} reached for this key`, 429, 'insufficient_quota'); }
  if (!count) return key;
  const now = Date.now(); const cutoff = now - 60000;
  const reqs = (reqWindow.get(key.id) || []).filter(t => t > cutoff);
  if (key.rpm && reqs.length >= key.rpm) throw limited(`Request rate limit of ${key.rpm}/min reached for this key`, Math.max(1, Math.ceil((reqs[0] + 60000 - now) / 1000)));
  checkTokenRate(key);
  reqs.push(now); reqWindow.set(key.id, reqs);
  key.requests = (key.requests || 0) + 1; key.lastUsed = now; saveSoon(); return key;
}
// Admission can wait behind other requests: recheck tokens without consuming RPM a second time.
export function checkTokenRate(key: ApiKey) {
  const now = Date.now(); const toks = (tokenWindow.get(key.id) || []).filter(e => e.t > now - 60000);
  tokenWindow.set(key.id, toks);
  if (key.tpm && toks.reduce((s, e) => s + e.n, 0) + reserved(key.id) >= key.tpm) throw limited(`Token rate limit of ${key.tpm}/min reached for this key`, Math.max(1, Math.ceil(((toks[0]?.t ?? now - 59000) + 60000 - now) / 1000)));
}
// No await between checking capacity and installing a hold. Holds do not expire: a live stream
// may outlast the TPM window. Settlement records only consumed tokens, never unused output.
export function reserveTokens(key: ApiKey, amount: number) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new GatewayError('Cannot establish a safe token allowance for this request', 400, 'invalid_request_error');
  const active = reserved(key.id);
  if (key.budget && (key.used || 0) + active + amount > key.budget) throw new GatewayError(`This request needs a ${amount.toLocaleString()} token allowance, exceeding this key's remaining token budget. Lower max_completion_tokens/max_tokens or increase the key budget.`, 429, 'insufficient_quota');
  checkTokenRate(key);
  const tokens = tokenWindow.get(key.id) || [];
  if (key.tpm && tokens.reduce((sum, entry) => sum + entry.n, 0) + active + amount > key.tpm) throw limited(`This request needs a ${amount.toLocaleString()} token allowance, exceeding this key's ${key.tpm.toLocaleString()}/min token rate limit. Lower max_completion_tokens/max_tokens or wait for capacity.`, Math.max(1, Math.ceil(((tokens[0]?.t ?? Date.now() - 59000) + 60000 - Date.now()) / 1000)));
  const hold = { amount }; const holds = reservations.get(key.id) || new Set<{ amount: number }>();
  holds.add(hold); reservations.set(key.id, holds); let settled = false;
  return { amount, settle(tokens: number) {
    if (settled) return;
    settled = true; holds.delete(hold); if (!holds.size) reservations.delete(key.id);
    // Malformed upstream usage must not strand a live hold. Retain the allowance as a
    // conservative debit if a caller cannot supply a valid accounting total.
    recordUsage(key.id, Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : amount);
  } };
}
// The agent's own client key (docs/agent/PLAN.md): created the first time the agent engine starts, then kept. Its traffic is attributed to
// it like any client's. Turning it off on the Keys page cuts the agent off from models; a deleted one is replaced at the next start.
export function ensureAgentKey(): ApiKey {
  let key = settings.keys.find(k => k.agent);
  if (!key) { key = { id: crypto.randomUUID(), name: 'Polygate Agent', value: 'pg_' + randomBytes(24).toString('hex'), enabled: true, limit: 0, agent: true }; settings.keys.push(key); persist(); }
  return key;
}
// Legacy slash grants cannot prove whether they were qualified IDs or upstream aliases. Assume
// qualified without rewriting the vault: catalog removal must never widen an existing grant.
const grantKind = (key: ApiKey, grant: string): ModelGrantKind => {
  if (key.modelGrantKinds && Object.hasOwn(key.modelGrantKinds, grant)) return key.modelGrantKinds[grant] === 'upstream' ? 'upstream' : 'qualified';
  return grant.includes('/') ? 'qualified' : 'upstream';
};
export const modelAllowed = (key: ApiKey, model: string) => !key.models?.length || /^auto(:|$)/.test(model) || key.models.some(grant => grantKind(key, grant) === 'qualified' ? grant === model : grant === models.get(model)?.upstreamId);
export function recordUsage(keyId: string, tokens: number) {
  const key = settings.keys.find(k => k.id === keyId); if (!key) return;
  key.used = Math.min(Number.MAX_SAFE_INTEGER, (key.used || 0) + tokens);
  if (tokens > 0) { const list = tokenWindow.get(keyId) || []; list.push({ t: Date.now(), n: tokens }); tokenWindow.set(keyId, list); }
  saveSoon();
}
const whole = (v: unknown, lo: number, hi: number, label: string) => {
  if (v === undefined || v === null || v === '' || v === 0) return undefined; const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new GatewayError(`${label} must be between ${lo} and ${hi}`, 400); return Math.floor(n);
};
// Shared by create and update so both accept the same fields with the same validation.
export function keyFields(b: any, saved?: ApiKey): Partial<ApiKey> {
  const out: Partial<ApiKey> = {};
  if (b.name !== undefined) out.name = String(b.name || 'API key').slice(0, 80);
  if (b.limit !== undefined) out.limit = whole(b.limit, 1, 64, 'Concurrent limit') ?? 0; // empty or 0: no limit
  if (b.rpm !== undefined) out.rpm = whole(b.rpm, 1, 100000, 'Requests per minute');
  if (b.tpm !== undefined) out.tpm = whole(b.tpm, 1, 1e9, 'Tokens per minute');
  if (b.budget !== undefined) out.budget = whole(b.budget, 1, 1e12, 'Token budget');
  if (b.models !== undefined) {
    out.models = Array.isArray(b.models) ? b.models.filter((x: unknown) => typeof x === 'string' && x.length < 200).slice(0, 200) : [];
    // Metadata is derived here, never trusted from the request. Retained grants keep their meaning
    // even when a UI sends the whole comma-separated list after the catalog has changed.
    const upstreamIds = new Set([...models.values()].map(m => m.upstreamId));
    out.modelGrantKinds = Object.fromEntries(out.models!.map(grant => {
      const kind: ModelGrantKind = saved?.models?.includes(grant) ? grantKind(saved, grant) : models.has(grant) ? 'qualified' : upstreamIds.has(grant) ? 'upstream' : grant.includes('/') ? 'qualified' : 'upstream';
      return [grant, kind];
    }));
  }
  if (b.expiresAt !== undefined) { if (!b.expiresAt) out.expiresAt = undefined; else { const t = typeof b.expiresAt === 'number' ? b.expiresAt : Date.parse(String(b.expiresAt)); if (!Number.isFinite(t) || t < Date.now()) throw new GatewayError('Expiry must be a date in the future', 400); out.expiresAt = t; } }
  if (b.enabled !== undefined) out.enabled = !!b.enabled;
  return out;
}
export function createKey(b: any): ApiKey {
  const key: ApiKey = { id: crypto.randomUUID(), name: 'Coding client', value: 'pg_' + randomBytes(24).toString('hex'), enabled: true, limit: 0, created: Date.now(), used: 0, requests: 0, ...keyFields(b) };
  settings.keys.push(key); persist(); return key;
}
export function updateKey(id: string, b: any) {
  const key = settings.keys.find(k => k.id === id); if (!key) throw new GatewayError('Key not found', 404);
  const patch = keyFields(b, key); Object.assign(key, patch);
  for (const field of ['rpm', 'tpm', 'budget', 'expiresAt'] as const) if (field in patch && patch[field] === undefined) delete key[field];
  if (b.resetUsage) { key.used = 0; key.requests = 0; }
  if (b.regenerate) key.value = 'pg_' + randomBytes(24).toString('hex');
  persist(); return key;
}
