import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { settings, persist, stateDir, deriveKey, equal } from './state';
import { GatewayError } from './queue';
const day = 86400000;
const loopbackHost = /^(127\.0\.0\.1|localhost|\[::1\])$/i;
// Deployment settings come from the environment so the same build runs as a desktop app and as a headless VPS service.
export function serverConfig() {
  const host = process.env.POLYGATE_HOST || '127.0.0.1';
  const list = (process.env.POLYGATE_ALLOWED_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  return {
    host, desktop: process.env.POLYGATE_DESKTOP === '1',
    trustProxy: process.env.POLYGATE_TRUST_PROXY === '1',
    // Host-header pinning defends a loopback listener against DNS rebinding; a public listener is protected by login and API keys instead.
    allowAnyHost: list.includes('*') || !loopbackHost.test(host), allowedHosts: list,
    cookieSecure: process.env.POLYGATE_COOKIE_SECURE || 'auto',
  };
}
export const hostAllowed = (hostHeader: string) => {
  const cfg = serverConfig(); const name = hostHeader.replace(/:\d+$/, '').toLowerCase();
  return cfg.allowAnyHost || loopbackHost.test(name) || cfg.allowedHosts.includes(name);
};
export function clientIp(req: IncomingMessage) {
  if (serverConfig().trustProxy) { const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (f) return f; }
  return String((req as any).socket?.remoteAddress || 'unknown');
}
export const isHttps = (req: IncomingMessage) => {
  if((req.socket as any)?.encrypted)return true;
  const mode = serverConfig().cookieSecure; if (mode === '1') return true; if (mode === '0') return false;
  return serverConfig().trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
};
// Sliding-window failure counter used for login attempts and invalid API keys.
export class FailureGate {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}
  private recent(key: string) { const cutoff = Date.now() - this.windowMs; const list = (this.hits.get(key) || []).filter(t => t > cutoff); if (list.length) this.hits.set(key, list); else this.hits.delete(key); return list; }
  retryAfter(key: string) { const list = this.recent(key); return list.length >= this.max ? Math.max(1, Math.ceil((list[0] + this.windowMs - Date.now()) / 1000)) : 0; }
  fail(key: string) { if (this.hits.size > 5000) this.hits.clear(); this.hits.set(key, [...this.recent(key), Date.now()]); }
  clear(key: string) { this.hits.delete(key); }
  reset() { this.hits.clear(); }
}
export const loginGate = new FailureGate(5, 10 * 60000);
export const keyGate = new FailureGate(30, 5 * 60000);
// --- dashboard password ---
const passwordFile = path.join(stateDir, 'admin-password.txt');
const hashPassword = (password: string, salt = randomBytes(16).toString('hex')) => ({ salt, hash: scryptSync(password, salt, 32).toString('hex') });
const passwordMatches = (password: string, stored: { salt: string; hash: string }) => { const got = Buffer.from(hashPassword(password, stored.salt).hash, 'hex'); const want = Buffer.from(stored.hash, 'hex'); return got.length === want.length && timingSafeEqual(got, want); };
export const passwordManagedByEnv = () => !!process.env.POLYGATE_ADMIN_PASSWORD;
// Resolves the dashboard password at startup: environment, then a stored hash, then a generated one written to the state directory.
export function ensureAdminPassword(adminToken?: string) {
  if (passwordManagedByEnv() || settings.admin?.password) return { generated: false };
  if (serverConfig().desktop || (adminToken && process.env.POLYGATE_ADMIN_TOKEN)) return { generated: false };
  const password = randomBytes(12).toString('base64url');
  settings.admin = { ...settings.admin, epoch: settings.admin?.epoch || 0, password: hashPassword(password) }; persist();
  writeFileSync(passwordFile, password + '\n', { mode: 0o600 });
  return { generated: true, file: passwordFile };
}
export function verifyPassword(password: string, adminToken: string) {
  if (!password) return false;
  const env = process.env.POLYGATE_ADMIN_PASSWORD;
  if (env) return equal(password, env);
  if (settings.admin?.password) return passwordMatches(password, settings.admin.password);
  return equal(password, adminToken); // no password configured: the admin token doubles as the dashboard password
}
export function changePassword(current: string, next: string, adminToken: string) {
  if (passwordManagedByEnv()) throw new GatewayError('The dashboard password is set by POLYGATE_ADMIN_PASSWORD; change it there.', 409);
  if (!verifyPassword(current, adminToken)) throw new GatewayError('Current password is incorrect', 403);
  if (next.length < 12) throw new GatewayError('Use a password of at least 12 characters', 400);
  settings.admin = { password: hashPassword(next), epoch: (settings.admin?.epoch || 0) + 1 }; persist();
  try { if (existsSync(passwordFile)) unlinkSync(passwordFile); } catch { /* best effort */ }
}
export function signOutEverywhere() { settings.admin = { ...settings.admin, epoch: (settings.admin?.epoch || 0) + 1 }; persist(); }
// --- signed session cookie (stateless, survives restarts, revoked by bumping the epoch) ---
const sessionKey = () => deriveKey('polygate-session');
const sign = (body: string) => createHmac('sha256', sessionKey()).update(body).digest('hex');
export function createSession(days = 7) { const body = `${Date.now() + days * day}.${settings.admin?.epoch || 0}`; return `${body}.${sign(body)}`; }
export function sessionValid(value: string) {
  const [exp, epoch, sig] = value.split('.'); if (!exp || epoch === undefined || !sig) return false;
  const body = `${exp}.${epoch}`; const want = sign(body);
  return equal(sig, want) && Number(exp) > Date.now() && Number(epoch) === (settings.admin?.epoch || 0);
}
const sessionName = 'polygate_session';
export const sessionCookie = (value: string, secure: boolean, maxAgeSeconds = 7 * 86400) => `${sessionName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
export function readSession(req: IncomingMessage) { return String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(sessionName + '='))?.slice(sessionName.length + 1) || ''; }
