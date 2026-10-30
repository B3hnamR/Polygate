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
  // POLYGATE_TRUST_PROXY=1 trusts one reverse proxy in front; a larger number trusts that many hops (for example a CDN plus a proxy).
  const hops = /^\d+$/.test(process.env.POLYGATE_TRUST_PROXY || '') ? Math.min(10, Number(process.env.POLYGATE_TRUST_PROXY)) : 0;
  // POLYGATE_DASHBOARD_PATH=/polygate serves the dashboard (and, under the same prefix, the API) at https://server/polygate/ instead of the root.
  // A reverse proxy can then forward just that path and leave the rest of the site alone. Empty (the default) keeps everything at the root.
  const rawPath = (process.env.POLYGATE_DASHBOARD_PATH || '').trim();
  const dashboardPath = /^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*\/?$/.test(rawPath) && !rawPath.split('/').some(part => part === '.' || part === '..') ? rawPath.replace(/\/$/, '') : '';
  return {
    host, dashboardPath, desktop: process.env.POLYGATE_DESKTOP === '1',
    trustProxy: hops > 0, proxyHops: hops,
    // Host-header pinning defends a loopback listener against DNS rebinding; a public listener is protected by login and API keys instead.
    allowAnyHost: list.includes('*') || !loopbackHost.test(host), allowedHosts: list,
    cookieSecure: process.env.POLYGATE_COOKIE_SECURE || 'auto',
  };
}
const bare = (h: string) => h.replace(/^\[|\]$/g, '').toLowerCase();
export const hostAllowed = (hostHeader: string) => {
  const cfg = serverConfig(); const name = hostHeader.replace(/:\d+$/, '').toLowerCase();
  if (cfg.allowAnyHost || loopbackHost.test(name) || cfg.allowedHosts.includes(name)) return true;
  // The name the HTTPS certificate was issued for is this server's own name, even when POLYGATE_HOST was left at loopback.
  const https = settings.https; if (!https || https.mode === 'off') return false;
  return [https.domain, https.ip].some(h => !!h && bare(h) === bare(name));
};
// Each proxy appends the address it received the request from, so only the right-hand entries were written by trusted hops; everything
// to the left of them came from the client and can be forged. The left-most entry used to be taken, which reset lockouts on every request.
export function clientIp(req: IncomingMessage) {
  const cfg = serverConfig();
  // A chain shorter than the number of trusted proxies means a request skipped one of them, so nothing in it can be believed: use the connection's own address.
  if (cfg.trustProxy) { const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean); const f = chain.length >= cfg.proxyHops ? chain[chain.length - cfg.proxyHops] : ''; if (f) return f; }
  return String((req as any).socket?.remoteAddress || 'unknown');
}
export const isHttps = (req: IncomingMessage) => {
  if((req.socket as any)?.encrypted)return true;
  const mode = serverConfig().cookieSecure; if (mode === '1') return true; if (mode === '0') return false;
  return serverConfig().trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
};
// Sliding-window failure counter used for login attempts and invalid API keys.
// IPv6 clients are counted per /64 (one customer's allocation), so cycling through addresses in one network does not reset the count.
export function gateKey(ip: string) {
  const v4 = ip.match(/^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/i); if (v4) return v4[1];
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('%')[0].split('::'); const left = head ? head.split(':') : []; const right = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return full.slice(0, 4).map(x => x.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
export class FailureGate {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number, private capacity = 5000) {}
  private recent(key: string) { const cutoff = Date.now() - this.windowMs; const list = (this.hits.get(key) || []).filter(t => t > cutoff); if (list.length) this.hits.set(key, list); else this.hits.delete(key); return list; }
  retryAfter(ip: string) { const list = this.recent(gateKey(ip)); return list.length >= this.max ? Math.max(1, Math.ceil((list[0] + this.windowMs - Date.now()) / 1000)) : 0; }
  // At capacity the least recently failing addresses are dropped. The map used to be cleared, which reset every lockout at once.
  fail(ip: string) {
    const key = gateKey(ip); const list = [...this.recent(key), Date.now()]; this.hits.delete(key); this.hits.set(key, list);
    for (const old of this.hits.keys()) { if (this.hits.size <= this.capacity) break; this.hits.delete(old); }
  }
  clear(ip: string) { this.hits.delete(gateKey(ip)); }
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
// The local manager's reset (the admin token proves it is on this machine): no current password needed, every signed-in session ends.
export function resetPassword(next: string) {
  if (passwordManagedByEnv()) throw new GatewayError('The dashboard password is set by POLYGATE_ADMIN_PASSWORD; change it there.', 409);
  if (next.length < 12) throw new GatewayError('Use a password of at least 12 characters', 400);
  settings.admin = { password: hashPassword(next), epoch: (settings.admin?.epoch || 0) + 1 }; persist();
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
// Actions that hand every stored secret out, or replace all settings, ask for the dashboard password again in server mode: a stolen session cookie is not enough.
// The desktop app (loopback, no password) and the local manager (it holds the admin token) are not asked.
let knownAdminToken = '';
export const rememberAdminToken = (value: string) => { knownAdminToken = value; };
export function requirePassword(req: IncomingMessage, password: unknown) {
  if (serverConfig().desktop || (req as any).polygateManager === true) return;
  const ip = clientIp(req); const wait = loginGate.retryAfter(ip);
  if (wait) throw new GatewayError(`Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`, 429, 'rate_limit_error');
  if (!verifyPassword(String(password || ''), knownAdminToken)) { loginGate.fail(ip); throw new GatewayError('Enter the dashboard password to confirm this.', 403, 'authentication_error'); }
}
