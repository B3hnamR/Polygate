import { serverConfig } from './auth';
import { X509Certificate, createPrivateKey, generateKeyPairSync, createHash, sign as signData, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { settings, persist, stateDir, redactError } from './state';
import { GatewayError } from './queue';
import { notify } from './notifications';
import type { HttpsSettings } from './types';
// Built-in HTTPS: Let's Encrypt certificates for a domain or a bare public IP address (ACME http-01, RFC 8555 + RFC 8738),
// or your own certificate. No reverse proxy needed; the panel and the API are served over TLS directly.
const tlsDir = path.join(stateDir, 'tls');
const LETSENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory'; const LETSENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';
const day = 86400000;
export const httpsConfig = (): HttpsSettings => ({ mode: 'off', httpPort: 80, redirect: true, ...settings.https });
type Tls = { cert: string; key: string };
type Rebind = (opts: { port: number; host: string; tls?: Tls }) => Promise<number>;
let rebind: Rebind | undefined; let plain = { port: 4317, host: '127.0.0.1' }; let challengeServer: ReturnType<typeof Bun.serve> | undefined; let renewTimer: ReturnType<typeof setInterval> | undefined;
const challenges = new Map<string, string>();
let job = { running: false, startedAt: 0, finishedAt: 0, steps: [] as { t: number; msg: string; level: 'info' | 'ok' | 'warn' | 'error' }[], error: '', url: '' };
const log = (msg: string, level: 'info' | 'ok' | 'warn' | 'error' = 'info') => { job.steps.push({ t: Date.now(), msg, level }); if (job.steps.length > 60) job.steps.shift(); };
const b64u = (v: Buffer | string) => Buffer.from(v).toString('base64url');
// --- certificate files ---
const certPath = (id: string) => path.join(tlsDir, `${id}-fullchain.pem`); const keyPath = (id: string) => path.join(tlsDir, `${id}-privkey.pem`);
function writeCert(id: string, cert: string, key: string) { mkdirSync(tlsDir, { recursive: true, mode: 0o700 }); writeFileSync(certPath(id), cert); writeFileSync(keyPath(id), key, { mode: 0o600 }); try { chmodSync(keyPath(id), 0o600); } catch { /* windows */ } }
function readTls(cfg: HttpsSettings): (Tls & { cert509: X509Certificate }) | undefined {
  const id = cfg.mode === 'custom' ? 'custom' : cfg.mode; if (cfg.mode === 'off') return undefined;
  const cf = certPath(id), kf = keyPath(id); if (!existsSync(cf) || !existsSync(kf)) return undefined;
  try { const cert = readFileSync(cf, 'utf8'); return { cert, key: readFileSync(kf, 'utf8'), cert509: new X509Certificate(cert) }; } catch { return undefined; }
}
const expiryOf = (c: X509Certificate) => Date.parse(c.validTo);
// --- environment checks ---
const privateV4 = (ip: string) => { const p = ip.split('.').map(Number); return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224; };
let publicIpCache: { ip: string; at: number } | undefined;
export async function detectPublicIp(force = false): Promise<string> {
  if(process.env.POLYGATE_PUBLIC_IP && net.isIPv4(process.env.POLYGATE_PUBLIC_IP))return process.env.POLYGATE_PUBLIC_IP;
  if (!force && publicIpCache && Date.now() - publicIpCache.at < 600000) return publicIpCache.ip;
  for (const url of ['https://1.1.1.1/cdn-cgi/trace', 'https://api.ipify.org', 'https://ifconfig.me/ip']) {
    try { const text = await (await fetch(url, { signal: AbortSignal.timeout(6000) })).text(); const ip = text.match(/^ip=(.+)$/m)?.[1] || text.trim(); if (net.isIPv4(ip)) { publicIpCache = { ip, at: Date.now() }; return ip; } } catch { /* try the next one */ }
  }
  return '';
}
// --- ACME client ---
class Acme {
  private nonce = ''; private dir: any; private kid = ''; private key!: KeyObject; private jwk!: { kty: string; crv: string; x: string; y: string };
  constructor(private directoryUrl: string) {}
  private fetch(url: string, init: RequestInit = {}) { return fetch(url, { ...init, signal: AbortSignal.timeout(30000), ...(process.env.POLYGATE_ACME_INSECURE === '1' ? { tls: { rejectUnauthorized: false } } : {}) } as any); }
  async init() {
    this.dir = await (await this.fetch(this.directoryUrl)).json();
    const file = path.join(tlsDir, 'acme-account.json'); mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
    let stored: { pem?: string; directory?: string; kid?: string } = {}; try { stored = JSON.parse(readFileSync(file, 'utf8')); } catch { /* new account */ }
    if (stored.pem && stored.directory === this.directoryUrl) { this.key = createPrivateKey(stored.pem); this.kid = stored.kid || ''; }
    else { this.key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey; this.kid = ''; }
    const pub = (await import('node:crypto')).createPublicKey(this.key).export({ format: 'jwk' }) as any; this.jwk = { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y };
    this.save = () => writeFileSync(file, JSON.stringify({ pem: this.key.export({ type: 'pkcs8', format: 'pem' }), directory: this.directoryUrl, kid: this.kid }), { mode: 0o600 });
  }
  private save = () => {};
  get thumbprint() { return b64u(createHash('sha256').update(JSON.stringify({ crv: this.jwk.crv, kty: this.jwk.kty, x: this.jwk.x, y: this.jwk.y })).digest()); }
  private async freshNonce() { const r = await this.fetch(this.dir.newNonce, { method: 'HEAD' }); return r.headers.get('replay-nonce') || ''; }
  // POST-as-GET when payload is null. Retries once on badNonce, as the protocol expects.
  async post(url: string, payload: unknown, withJwk = false, retried = false): Promise<{ body: any; headers: Headers; text: string }> {
    const nonce = this.nonce || await this.freshNonce();
    const protectedHeader = b64u(JSON.stringify({ alg: 'ES256', nonce, url, ...(withJwk || !this.kid ? { jwk: this.jwk } : { kid: this.kid }) }));
    const body = payload === null ? '' : b64u(JSON.stringify(payload)); const signature = b64u(signData('sha256', Buffer.from(`${protectedHeader}.${body}`), { key: this.key, dsaEncoding: 'ieee-p1363' }));
    const r = await this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/jose+json' }, body: JSON.stringify({ protected: protectedHeader, payload: body, signature }) });
    this.nonce = r.headers.get('replay-nonce') || ''; const text = await r.text(); let parsed: any = {}; try { parsed = JSON.parse(text); } catch { /* certificate downloads are PEM */ }
    if (!r.ok) {
      if (!retried && /badNonce/.test(parsed.type || '')) return this.post(url, payload, withJwk, true);
      throw new Error(`${parsed.detail || parsed.type || 'ACME request failed'} (HTTP ${r.status})`);
    }
    return { body: parsed, headers: r.headers, text };
  }
  async account(email?: string) {
    const r = await this.post(this.dir.newAccount, { termsOfServiceAgreed: true, ...(email ? { contact: [`mailto:${email}`] } : {}) }, true);
    this.kid = r.headers.get('location') || this.kid; this.save();
  }
  get directory() { return this.dir; }
}
async function issue(cfg: HttpsSettings, identifier: { type: 'dns' | 'ip'; value: string }): Promise<{ cert: string; key: string }> {
  const acme = new Acme(process.env.POLYGATE_ACME_DIRECTORY || (cfg.staging ? LETSENCRYPT_STAGING : LETSENCRYPT));
  log('Contacting the certificate authority…'); await acme.init();
  log('Creating the ACME account…'); await acme.account(cfg.email);
  log(`Placing an order for ${identifier.value}${identifier.type === 'ip' ? ' (short-lived IP certificate)' : ''}…`);
  const order = await acme.post(acme.directory.newOrder, { identifiers: [identifier], ...(identifier.type === 'ip' ? { profile: 'shortlived' } : {}) });
  const orderUrl = order.headers.get('location') || '';
  for (const authzUrl of order.body.authorizations as string[]) {
    const authz = (await acme.post(authzUrl, null)).body; if (authz.status === 'valid') continue;
    const challenge = (authz.challenges as any[]).find(c => c.type === 'http-01'); if (!challenge) throw new Error('The certificate authority offered no http-01 challenge for this address.');
    challenges.set(challenge.token, `${challenge.token}.${acme.thumbprint}`);
    log(`Proving control of ${identifier.value} on port ${cfg.httpPort}…`); await acme.post(challenge.url, {});
    for (let i = 0; ; i++) {
      await Bun.sleep(i < 3 ? 1000 : 2000); const current = (await acme.post(authzUrl, null)).body;
      if (current.status === 'valid') break;
      if (current.status === 'invalid') { const detail = (current.challenges as any[]).find(c => c.error)?.error?.detail; throw new Error(detail ? `Validation failed: ${detail}` : 'Validation failed.'); }
      if (i > 45) throw new Error('Validation timed out.');
    }
    challenges.delete(challenge.token);
  }
  log('Generating the certificate request…');
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  await acme.post(order.body.finalize, { csr: b64u(buildCsr(identifier, keys.privateKey, keys.publicKey)) });
  let current = order.body;
  for (let i = 0; current.status !== 'valid'; i++) {
    await Bun.sleep(1500); current = (await acme.post(orderUrl, null)).body;
    if (current.status === 'invalid') throw new Error('The certificate order was rejected.'); if (i > 40) throw new Error('Issuing the certificate timed out.');
  }
  const cert = (await acme.post(current.certificate, null)).text;
  return { cert, key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
}
// Minimal PKCS#10 certificate request (RFC 2986) with a subjectAltName extension: just enough DER to ask for a DNS name or an IP address.
const der = (tag: number, ...parts: Buffer[]) => { const body = Buffer.concat(parts); const n = body.length; return Buffer.concat([Buffer.from([tag]), n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]), body]); };
const oid = (dotted: string) => { const p = dotted.split('.').map(Number); const out = [p[0] * 40 + p[1]]; for (const n of p.slice(2)) { const chunk = [n & 127]; for (let v = n >> 7; v; v >>= 7) chunk.unshift((v & 127) | 128); out.push(...chunk); } return der(0x06, Buffer.from(out)); };
export function buildCsr(identifier: { type: 'dns' | 'ip'; value: string }, privateKey: KeyObject, publicKey: KeyObject) {
  const subject = identifier.type === 'dns' ? der(0x30, der(0x31, der(0x30, oid('2.5.4.3'), der(0x0c, Buffer.from(identifier.value))))) : der(0x30);
  const name = identifier.type === 'dns' ? der(0x82, Buffer.from(identifier.value, 'ascii')) : der(0x87, Buffer.from(identifier.value.split('.').map(Number)));
  const extensions = der(0x30, der(0x30, oid('2.5.29.17'), der(0x04, der(0x30, name))));
  const attribute = der(0xa0, der(0x30, oid('1.2.840.113549.1.9.14'), der(0x31, extensions)));
  const info = der(0x30, Buffer.from([0x02, 0x01, 0x00]), subject, publicKey.export({ type: 'spki', format: 'der' }) as Buffer, attribute);
  const signature = signData('sha256', info, { key: privateKey, dsaEncoding: 'der' });
  return der(0x30, info, der(0x30, oid('1.2.840.10045.4.3.2')), der(0x03, Buffer.from([0]), signature));
}
// --- port 80: ACME challenges and the HTTP→HTTPS redirect ---
export async function startChallengeServer() {
  const cfg = httpsConfig(); if (challengeServer) return;
  challengeServer = Bun.serve({
    port: cfg.httpPort, hostname: '0.0.0.0',
    fetch(req) {
      const url = new URL(req.url); const token = url.pathname.startsWith('/.well-known/acme-challenge/') ? url.pathname.slice('/.well-known/acme-challenge/'.length) : '';
      if (token && challenges.has(token)) return new Response(challenges.get(token), { headers: { 'content-type': 'text/plain' } });
      const current = httpsConfig(); if (!current.redirect || current.mode === 'off') return new Response('Not found', { status: 404 });
      // Only this server's own name is redirected to: a forged Host header must not turn this port into an open redirect.
      const asked = (req.headers.get('host') || '').replace(/:\d+$/, '').toLowerCase(); const own = [current.domain, current.ip].filter((x): x is string => !!x);
      const host = own.find(x => x.toLowerCase() === asked) || own[0] || ''; const port = current.port || 443;
      if (!host) return new Response('Not found', { status: 404 });
      return Response.redirect(`https://${host}${port === 443 ? '' : ':' + port}${url.pathname}${url.search}`, 301);
    },
  });
}
export function stopChallengeServer() { challengeServer?.stop(true); challengeServer = undefined; }
// --- public API ---
export function httpsRuntime(): { tls?: Tls; port?: number } {
  const cfg = httpsConfig(); const tls = readTls(cfg);
  // Keep an expired certificate on TLS while renewal recovers; never downgrade a configured secure panel to public HTTP.
  if (!tls) return {};
  return { tls: { cert: tls.cert, key: tls.key }, port: cfg.port };
}
export async function httpsStatus() {
  const cfg = httpsConfig(); const tls = readTls(cfg); const expiresAt = tls ? expiryOf(tls.cert509) : 0;
  return {
    mode: cfg.mode, domain: cfg.domain || '', ip: cfg.ip || '', email: cfg.email || '', port: cfg.port || 443, httpPort: cfg.httpPort, redirect: cfg.redirect, staging: !!cfg.staging,
    active: !!tls && expiresAt > Date.now(), issuedAt: tls ? Date.parse(tls.cert509.validFrom) : 0, expiresAt, daysLeft: tls ? Math.floor((expiresAt - Date.now()) / day) : 0, issuer: tls ? tls.cert509.issuer.split('\n').find(l => l.startsWith('O='))?.slice(2) || tls.cert509.issuer.replace(/\n/g, ', ') : '',
    lastError: cfg.lastError || '', challengeServer: !!challengeServer, publicIp: await detectPublicIp(), job: { ...job },
    url: cfg.mode === 'off' ? '' : `https://${cfg.domain || cfg.ip}${(cfg.port || 443) === 443 ? '' : ':' + (cfg.port || 443)}${serverConfig().dashboardPath}/`,
    httpUrl: `http://${cfg.domain || cfg.ip || process.env.POLYGATE_PUBLIC_IP || plain.host}:${plain.port}${serverConfig().dashboardPath}/`,
  };
}
const hostnameOk = (h: string) => h.length <= 253 && /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(h);
// The checks at the start of a request (looking up the public address, reading a pasted certificate) take time before the job is marked as
// running, so a second click in that time would start a second request. This flag is taken at once.
let applying = false;
export async function httpsApply(b: any) {
  if (job.running || applying) throw new GatewayError('A certificate request is already running', 409);
  applying = true;
  try { return await applyHttps(b); } finally { applying = false; }
}
async function applyHttps(b: any) {
  if (job.running) throw new GatewayError('A certificate request is already running', 409);
  const mode = String(b.mode || ''); if (!['domain', 'ip', 'custom'].includes(mode)) throw new GatewayError('Choose domain, ip or custom', 400);
  const next: HttpsSettings = { ...httpsConfig(), mode: mode as HttpsSettings['mode'], port: Number(b.port) || 443, httpPort: Number(b.httpPort) || 80, redirect: b.redirect !== false, staging: !!b.staging, email: b.email ? String(b.email).trim() : undefined, lastError: '' };
  if (next.port! < 1 || next.port! > 65535 || next.httpPort < 1 || next.httpPort > 65535) throw new GatewayError('Ports must be between 1 and 65535', 400);
  if (next.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next.email)) throw new GatewayError('Enter a valid e-mail address or leave it empty', 400);
  let identifier: { type: 'dns' | 'ip'; value: string } | undefined; let custom: { cert: string; key: string } | undefined;
  if (mode === 'domain') { const d = String(b.domain || '').trim().toLowerCase(); if (!hostnameOk(d)) throw new GatewayError('Enter a full domain name such as panel.example.com (wildcards are not supported)', 400); next.domain = d; next.ip = undefined; identifier = { type: 'dns', value: d }; }
  if (mode === 'ip') { const ip = String(b.ip || '').trim() || await detectPublicIp(true); if (!net.isIPv4(ip) || privateV4(ip)) throw new GatewayError(ip ? 'That is not a public IPv4 address, so a certificate cannot be issued for it.' : 'Could not detect this server\'s public IP address. Enter it manually.', 400); next.ip = ip; next.domain = undefined; identifier = { type: 'ip', value: ip }; }
  if (mode === 'custom') {
    const cert = String(b.certPem || '').trim(), key = String(b.keyPem || '').trim(); if (!cert || !key) throw new GatewayError('Paste both the certificate chain and the private key', 400);
    try { const c = new X509Certificate(cert); if (!c.checkPrivateKey(createPrivateKey(key))) throw new Error('The private key does not match the certificate.'); if (expiryOf(c) < Date.now()) throw new Error('The certificate has expired.'); const names = c.subjectAltName || c.subject; next.domain = names.match(/DNS:([^,\s]+)/)?.[1] || c.subject.match(/CN=(.+)/)?.[1] || undefined; next.ip = names.match(/IP Address:([^,\s]+)/)?.[1] || undefined; }
    catch (e: any) { throw new GatewayError(`Invalid certificate: ${e.message}`, 400); }
    custom = { cert: cert + '\n', key: key + '\n' };
  }
  job = { running: true, startedAt: Date.now(), finishedAt: 0, steps: [], error: '', url: '' };
  const previous = { ...httpsConfig() };
  void (async () => {
    try {
      let result = custom;
      if (identifier) {
        if (identifier.type === 'dns') { log(`Checking DNS for ${identifier.value}…`); const ips = await dns.resolve4(identifier.value).catch(() => [] as string[]); const mine = await detectPublicIp(); if (!ips.length) throw new Error(`${identifier.value} has no A record yet. Point it at ${mine || 'this server'} and try again.`); if (mine && !ips.includes(mine)) log(`${identifier.value} points to ${ips.join(', ')}, but this server's public IP looks like ${mine}. Validation will fail unless that is the same machine.`, 'warn'); else log('DNS points at this server.', 'ok'); }
        log(`Opening port ${next.httpPort} for the validation request…`); settings.https = { ...next }; stopChallengeServer(); try { await startChallengeServer(); } catch (e: any) { throw new Error(`Could not listen on port ${next.httpPort} (${e.code || e.message}). Free it, or run the service with permission to bind low ports.`); }
        result = await issue(next, identifier);
      }
      const id = mode === 'custom' ? 'custom' : mode; writeCert(id, result!.cert, result!.key);
      const c = new X509Certificate(result!.cert); next.issuedAt = Date.parse(c.validFrom); next.expiresAt = expiryOf(c); settings.https = next; persist();
      log('Certificate installed. Switching the listener to HTTPS…', 'ok'); await applyListener();
      if (mode === 'custom') { stopChallengeServer(); if (renewTimer) clearInterval(renewTimer); renewTimer = undefined; } else { await startChallengeServer().catch(() => {}); startRenewal(); }
      job.url = `https://${next.domain || next.ip}${next.port === 443 ? '' : ':' + next.port}${serverConfig().dashboardPath}/`; log(`HTTPS is active at ${job.url}`, 'ok');
      notify('HTTPS enabled', `The dashboard is now served at ${job.url}`, 'success', 'https-on', 0);
    } catch (e: any) { job.error = redactError(String(e.message || e)); log(job.error, 'error'); settings.https = { ...previous, lastError: job.error }; persist(); }
    finally { challenges.clear(); job.running = false; job.finishedAt = Date.now(); }
  })();
  return httpsStatus();
}
async function applyListener() {
  if (!rebind) return; const cfg = httpsConfig(); const tls = readTls(cfg);
  await rebind({ port: cfg.mode === 'off' ? plain.port : cfg.port || 443, host: cfg.mode === 'off' ? plain.host : '0.0.0.0', tls: cfg.mode === 'off' || !tls ? undefined : { cert: tls.cert, key: tls.key } });
}
export async function httpsDisable() {
  settings.https = { ...httpsConfig(), mode: 'off', lastError: '' }; persist(); stopChallengeServer(); if (renewTimer) clearInterval(renewTimer); renewTimer = undefined;
  await applyListener(); return httpsStatus();
}
// Re-issues the managed certificate. Called by the timer and by the "Renew now" button.
export async function httpsRenew() {
  const cfg = httpsConfig(); if (cfg.mode !== 'domain' && cfg.mode !== 'ip') throw new GatewayError('Only Let\'s Encrypt certificates can be renewed here', 400);
  if (job.running) throw new GatewayError('A certificate request is already running', 409);
  return httpsApply({ mode: cfg.mode, domain: cfg.domain, ip: cfg.ip, email: cfg.email, port: cfg.port, httpPort: cfg.httpPort, redirect: cfg.redirect, staging: cfg.staging });
}
function startRenewal() {
  if (renewTimer) return;
  const check = () => {
    const cfg = httpsConfig(); if (cfg.mode !== 'domain' && cfg.mode !== 'ip') return; const tls = readTls(cfg); if (job.running) return;
    const expires = tls ? expiryOf(tls.cert509) : 0; const lifetime = tls ? expires - Date.parse(tls.cert509.validFrom) : 0; const threshold = Math.max(day, lifetime / 3);
    if (!tls || expires - Date.now() < threshold) { notify('Renewing the HTTPS certificate', `Requesting a new certificate for ${cfg.domain || cfg.ip}.`, 'info', 'https-renew', 3600000); void httpsRenew().catch(e => notify('HTTPS renewal failed', String(e.message || e), 'error', 'https-renew-fail', 3600000)); }
  };
  renewTimer = setInterval(check, 6 * 3600000); renewTimer.unref?.(); setTimeout(check, 30000).unref?.();
}
export async function startHttps(rebindFn: Rebind, plainListener: { port: number; host: string }) {
  rebind = rebindFn; plain = plainListener; const cfg = httpsConfig(); if (cfg.mode === 'off' || cfg.mode === 'custom') return;
  await startChallengeServer().catch(e => notify('HTTPS redirect unavailable', `Could not listen on port ${cfg.httpPort}: ${e.code || e.message}`, 'warning', 'https-80'));
  startRenewal();
}
export function stopHttps() { stopChallengeServer(); if (renewTimer) clearInterval(renewTimer); renewTimer = undefined; }
