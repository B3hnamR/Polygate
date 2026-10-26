import { randomBytes, createHash } from 'node:crypto';
import { GatewayError } from './queue';
import vercelModule from '../relays/vercel-bun/api/relay.js' with { type: 'text' };
import netlifyModule from '../relays/netlify-relay.js' with { type: 'text' };
import cloudflareModule from '../relays/cloudflare-worker.js' with { type: 'text' };
// One-click relay deployment. The platform API token is used for this call only: it is never written to settings, logs or the saved route.
// The relay's own access token is generated here, stored as a secret on the platform, and returned once to be saved in the Polygate route.
// A relay is the TLS client OpenCode Free sees, and the Free tier accepts a client only if its handshake lists Bun's 17 cipher suites in Bun's order
//. Vercel runs the relay on Bun. Netlify runs it on Node with that cipher list. Cloudflare Workers and Deno Deploy
// give a function no control over the cipher list, and OpenCode Free refused a Cloudflare Worker, so a Worker relay forwards to Kilo only (Kilo does not check the handshake).
const sources = { vercel: vercelModule as unknown as string, netlify: netlifyModule as unknown as string, cloudflare: cloudflareModule as unknown as string };
export type Platform = 'vercel' | 'netlify' | 'cloudflare';
// runtime (Vercel only): 'bun' (default) or 'node' (the same relay with Bun's cipher list set explicitly).
// accountId (Cloudflare only): the account the Worker is created in.
export type DeployInput = { platform: Platform; token: string; name?: string; region?: string; teamId?: string; runtime?: 'bun' | 'node'; accountId?: string };
export type DeployResult = { platform: Platform; name: string; url: string; accessToken: string; buffered: boolean; runtime: 'bun' | 'node-bun-ciphers' | 'cloudflare-worker'; region?: string; only?: 'kilo'; reachable: boolean; status: number; detail: string };
export const PLATFORMS: Platform[] = ['vercel', 'netlify', 'cloudflare'];
const fail = (message: string, status = 502) => new GatewayError(message, status, 'deploy_failed');
const slug = (value: string | undefined, fallback: string) => { const s = String(value || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); return s || fallback + '-' + randomBytes(2).toString('hex'); };
const accessToken = () => randomBytes(24).toString('base64url');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// Waits between status checks; tests shorten them.
export const __timing = { poll: 2000, verify: 2500 };
// What a platform said went wrong, without echoing a secret back to the dashboard.
function reason(data: any, text: string, secrets: string[]) {
  const found = data?.errors?.[0]?.message || data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || data?.message || (Array.isArray(data?.errors) && typeof data.errors[0] === 'string' ? data.errors[0] : '') || text;
  return secrets.filter(Boolean).reduce((s, x) => s.split(x).join('***'), String(found)).replace(/\s+/g, ' ').slice(0, 300);
}
async function api(label: string, url: string, init: RequestInit, secrets: string[], okStatuses: number[] = []): Promise<any> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(90000) }).catch(e => { throw fail(`${label} could not be reached: ${reason(undefined, String(e?.message || e), secrets)}`); });
  const text = await r.text(); let data: any; try { data = JSON.parse(text); } catch { data = undefined; }
  if (!r.ok && !okStatuses.includes(r.status)) throw fail(`${label} refused the request (HTTP ${r.status}${r.status === 401 || r.status === 403 ? ', check the token and its permissions' : ''}): ${reason(data, text, secrets)}`, r.status === 401 || r.status === 403 ? 400 : 502);
  return data ?? {};
}
const json = (token: string, extra: Record<string, string> = {}) => ({ authorization: 'Bearer ' + token, 'content-type': 'application/json', ...extra });
// A store-only zip, enough for one function file; no dependency needed.
export function __zip(files: Record<string, string>) {
  const parts: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name); const data = Buffer.from(content); const crc = Bun.hash.crc32(data) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(0x21, 14); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(nameBuf.length, 28); dir.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, data); central.push(dir, nameBuf); offset += 30 + nameBuf.length + data.length;
  }
  const dirBuf = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(dirBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dirBuf, end]);
}
async function deployVercel(i: DeployInput, access: string): Promise<{ name: string; url: string; buffered: boolean; runtime: 'bun' | 'node-bun-ciphers'; region: string }> {
  const region = /^[a-z]{3}\d$/.test(String(i.region || '')) ? String(i.region) : 'fra1';
  const name = slug(i.name, `polygate-relay-${region}`); const secrets = [i.token, access]; const team = i.teamId ? `&teamId=${encodeURIComponent(i.teamId)}` : '';
  const node = i.runtime === 'node';
  const config = JSON.stringify({ ...(node ? {} : { bunVersion: '1.x' }), regions: [region], rewrites: [{ source: '/(.*)', destination: '/api/relay' }], functions: { 'api/relay.js': { maxDuration: 300 } } });
  const created = await api('Vercel', `https://api.vercel.com/v13/deployments?skipAutoDetectionConfirmation=1${team}`, { method: 'POST', headers: json(i.token), body: JSON.stringify({
    name, target: 'production', regions: [region], projectSettings: { framework: null, serverlessFunctionRegion: region }, env: { POLYGATE_RELAY_TOKEN: access },
    files: [{ file: 'api/relay.js', data: sources.vercel, encoding: 'utf-8' }, { file: 'vercel.json', data: config, encoding: 'utf-8' }, { file: 'package.json', data: JSON.stringify({ name, ...(node ? { type: 'module' } : {}), private: true }), encoding: 'utf-8' }] }) }, secrets);
  let d = created; const until = Date.now() + 120000;
  while (d.readyState !== 'READY' && Date.now() < until) {
    if (d.readyState === 'ERROR' || d.readyState === 'CANCELED') throw fail(`Vercel could not build the relay (${d.readyState}${d.errorMessage ? ': ' + reason(undefined, d.errorMessage, secrets) : ''}).`);
    await sleep(__timing.poll); d = await api('Vercel', `https://api.vercel.com/v13/deployments/${created.id}?${team.slice(1)}`, { headers: json(i.token) }, secrets);
  }
  if (d.readyState !== 'READY') throw fail('Vercel did not finish the deployment within two minutes. Check the project in the Vercel dashboard.');
  const alias: string = (d.alias || []).find((a: string) => a.endsWith('.vercel.app') && !/-[a-z0-9]{9}-/.test(a)) || (d.alias || [])[0] || d.url;
  return { name, url: 'https://' + alias, buffered: false, runtime: node ? 'node-bun-ciphers' : 'bun', region };
}
async function deployNetlify(i: DeployInput, access: string): Promise<{ name: string; url: string; buffered: boolean; runtime: 'node-bun-ciphers' }> {
  const secrets = [i.token, access]; const auth = json(i.token); const base = 'https://api.netlify.com/api/v1';
  let site: any; let name = slug(i.name, 'polygate-relay');
  for (let tries = 0; tries < 3 && !site?.id; tries++) {
    const r = await fetch(`${base}/sites`, { method: 'POST', headers: auth, body: JSON.stringify({ name }), signal: AbortSignal.timeout(60000) });
    const text = await r.text(); let data: any; try { data = JSON.parse(text); } catch { data = {}; }
    if (r.ok) site = data; else if (r.status === 422) name = slug(i.name, 'polygate-relay') + '-' + randomBytes(2).toString('hex'); else throw fail(`Netlify refused the request (HTTP ${r.status}${r.status === 401 ? ', check the token' : ''}): ${reason(data, text, secrets)}`, r.status === 401 ? 400 : 502);
  }
  if (!site?.id) throw fail('Netlify did not accept any site name; try a different one.');
  // A new site starts behind Netlify's team login, which would answer the relay's callers with a login page; the relay has its own access token.
  // If anything after this point fails, the half-made site is removed so a retry does not leave stray sites behind.
  try {
    await api('Netlify', `${base}/sites/${site.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ sso_login: false }) }, secrets);
    // The access token must exist before the function is deployed, or the function would start without it.
    await api('Netlify', `${base}/accounts/${site.account_id || site.account_slug}/env?site_id=${site.id}`, { method: 'POST', headers: auth, body: JSON.stringify([{ key: 'POLYGATE_RELAY_TOKEN', values: [{ value: access, context: 'all' }] }]) }, secrets);
    const html = '<!doctype html><title>Polygate relay</title>'; const fn = __zip({ 'relay.js': sources.netlify });
    const deploy = await api('Netlify', `${base}/sites/${site.id}/deploys`, { method: 'POST', headers: auth, body: JSON.stringify({ files: { '/index.html': createHash('sha1').update(html).digest('hex') }, functions: { relay: createHash('sha256').update(fn).digest('hex') } }) }, secrets);
    const octet = { authorization: 'Bearer ' + i.token, 'content-type': 'application/octet-stream' };
    if ((deploy.required || []).length) await api('Netlify', `${base}/deploys/${deploy.id}/files/index.html`, { method: 'PUT', headers: octet, body: html }, secrets);
    await api('Netlify', `${base}/deploys/${deploy.id}/functions/relay?runtime=js`, { method: 'PUT', headers: octet, body: fn }, secrets);
    let d = deploy; const until = Date.now() + 120000;
    while (d.state !== 'ready' && Date.now() < until) {
      if (d.state === 'error') throw fail(`Netlify could not publish the relay: ${reason(undefined, d.error_message || 'deploy error', secrets)}`);
      await sleep(__timing.poll); d = await api('Netlify', `${base}/deploys/${deploy.id}`, { headers: auth }, secrets);
    }
    if (d.state !== 'ready') throw fail('Netlify did not finish the deployment within two minutes. Check the site in the Netlify dashboard.');
  } catch (e) { await fetch(`${base}/sites/${site.id}`, { method: 'DELETE', headers: auth, signal: AbortSignal.timeout(30000) }).catch(() => {}); throw e; }
  const host = String(site.default_domain || site.ssl_url?.replace(/^https:\/\//, '') || `${name}.netlify.app`);
  return { name, url: `https://${host}/.netlify/functions/relay`, buffered: true, runtime: 'node-bun-ciphers' };
}
// A Worker needs the account's workers.dev address to be reachable; creating that address would rename the whole account's subdomain, so it is only asked for.
async function deployCloudflare(i: DeployInput, access: string): Promise<{ name: string; url: string; buffered: boolean; runtime: 'cloudflare-worker'; only: 'kilo' }> {
  const account = String(i.accountId || '').trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(account)) throw new GatewayError('Enter the Cloudflare Account ID: 32 letters and digits, shown in the dashboard under Workers & Pages', 400);
  const secrets = [i.token, access]; const auth = { authorization: 'Bearer ' + i.token }; const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
  const name = slug(i.name, 'polygate-relay');
  const subdomain = (await api('Cloudflare', `${base}/workers/subdomain`, { headers: auth }, secrets))?.result?.subdomain;
  if (!subdomain) throw fail('This Cloudflare account has no workers.dev address yet. Open Workers & Pages in the Cloudflare dashboard once to create it, then deploy again.', 400);
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ main_module: 'worker.js', compatibility_date: '2025-01-01', bindings: [{ type: 'secret_text', name: 'RELAY_TOKEN', text: access }] })], { type: 'application/json' }));
  form.append('worker.js', new Blob([sources.cloudflare], { type: 'application/javascript+module' }), 'worker.js');
  await api('Cloudflare', `${base}/workers/scripts/${encodeURIComponent(name)}`, { method: 'PUT', headers: auth, body: form }, secrets);
  // If anything after the upload fails, the half-made Worker is removed so a retry does not leave stray Workers behind.
  try { await api('Cloudflare', `${base}/workers/scripts/${encodeURIComponent(name)}/subdomain`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) }, secrets); }
  catch (e) { await fetch(`${base}/workers/scripts/${encodeURIComponent(name)}`, { method: 'DELETE', headers: auth, signal: AbortSignal.timeout(30000) }).catch(() => {}); throw e; }
  return { name, url: `https://${name}.${subdomain}.workers.dev`, buffered: false, runtime: 'cloudflare-worker', only: 'kilo' };
}
// What the Vercel account allows. Limits are the published ones (vercel.com/docs/limits and /docs/functions/configuring-functions/region, read 26 October 2026).
const PLAN_LIMITS: Record<string, { regionsPerProject: number; deploymentsPerDay: number; projects: number | null }> = {
  hobby: { regionsPerProject: 1, deploymentsPerDay: 100, projects: 200 }, pro: { regionsPerProject: 5, deploymentsPerDay: 6000, projects: null }, enterprise: { regionsPerProject: 99, deploymentsPerDay: 24000, projects: null },
};
export type VercelPlan = { plan: string; team: string; teams: number; projects: number; projectsMore: boolean; limits?: (typeof PLAN_LIMITS)[string] };
export async function inspectVercel(rawToken: string, teamId?: string): Promise<VercelPlan> {
  const token = String(rawToken || '').trim(); if (token.length < 8) throw new GatewayError('Enter the platform API token', 400);
  const headers = { authorization: 'Bearer ' + token }; const secrets = [token];
  const teams = (await api('Vercel', 'https://api.vercel.com/v2/teams', { headers }, secrets)).teams || [];
  const team = teamId ? teams.find((t: any) => t.id === teamId || t.slug === teamId) : teams[0];
  const plan = String(team?.billing?.plan || 'unknown').toLowerCase();
  const scope = team?.id ? `&teamId=${encodeURIComponent(team.id)}` : '';
  const list = await api('Vercel', `https://api.vercel.com/v9/projects?limit=100${scope}`, { headers }, secrets);
  return { plan, team: String(team?.slug || ''), teams: teams.length, projects: (list.projects || []).length, projectsMore: !!list.pagination?.next, limits: PLAN_LIMITS[plan] };
}
// Calls the new relay once, with its token, for something that is not limited (the model catalog). Fresh deployments take a few seconds to answer.
// A new Worker is not live on every Cloudflare edge at once (early requests get Cloudflare's own "not found" page), so it must answer its ping several times in a row.
async function verifyWorker(url: string, token: string): Promise<{ reachable: boolean; status: number }> {
  let status = 0, streak = 0;
  for (let i = 0; i < 60 && streak < 4; i++) {
    try { const r = await fetch(url, { headers: { 'x-relay-key': token, 'x-relay-control': 'ping' }, signal: AbortSignal.timeout(15000) }); status = r.status; const json = (r.headers.get('content-type') || '').includes('json'); await r.body?.cancel(); streak = r.ok && json ? streak + 1 : 0; } catch { streak = 0; }
    await sleep(__timing.verify);
  }
  return { reachable: streak >= 4, status };
}
export async function verifyRelay(url: string, token: string): Promise<{ reachable: boolean; status: number }> {
  let status = 0;
  for (let i = 0; i < 8; i++) {
    try { const r = await fetch(url, { headers: { 'x-relay-key': token, 'x-relay-target': 'https://opencode.ai', 'x-relay-path': '/inference/v1/models' }, signal: AbortSignal.timeout(15000) }); status = r.status; await r.body?.cancel(); if (r.ok) return { reachable: true, status }; } catch { status = 0; }
    await sleep(__timing.verify);
  }
  return { reachable: false, status };
}
export async function deployRelay(input: DeployInput): Promise<DeployResult> {
  if (!PLATFORMS.includes(input.platform)) throw new GatewayError('Choose Vercel, Netlify or Cloudflare', 400);
  const token = String(input.token || '').trim(); if (token.length < 8) throw new GatewayError('Enter the platform API token', 400);
  const i = { ...input, token }; const access = accessToken();
  const made = i.platform === 'netlify' ? await deployNetlify(i, access) : i.platform === 'cloudflare' ? await deployCloudflare(i, access) : await deployVercel(i, access);
  const check = i.platform === 'cloudflare' ? await verifyWorker(made.url, access) : await verifyRelay(made.url, access);
  return { platform: i.platform, ...made, accessToken: access, ...check, detail: check.reachable ? (i.platform === 'cloudflare' ? 'The Worker answered its status check several times in a row through its access token. It forwards to Kilo only.' : 'The relay answered a catalog request through its access token.') : `The relay was deployed but did not answer yet (HTTP ${check.status || 'no answer'}). Give it a minute and use Test.` };
}
