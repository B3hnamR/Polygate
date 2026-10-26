import { afterEach, expect, test } from 'bun:test';
import { deployRelay, inspectVercel, __zip, __timing } from '../backend/relay-deploy';
__timing.poll = 1; __timing.verify = 1;
// The deployers talk to Vercel and Netlify. Each test replaces fetch with a recorder that answers like the platform.
const realFetch = globalThis.fetch; afterEach(() => { globalThis.fetch = realFetch; });
type Call = { url: string; method: string; headers: Headers; body: any };
const API_TOKEN = 'platform-api-token-123456';
const isApi = (url: string) => url.startsWith('https://api.vercel.com/') || url.startsWith('https://api.netlify.com/');
function platform(answer: (c: Call) => Response | undefined) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const call = { url: String(url), method: init.method || 'GET', headers: new Headers(init.headers), body: init.body }; calls.push(call);
    // The relay itself answers the verification request that follows a deployment.
    if (!isApi(call.url) && call.headers.has('x-relay-key')) return Response.json({ data: [] });
    return answer(call) || Response.json({}, { status: 404 });
  }) as any;
  return calls;
}
const ok = (data: any) => Response.json(data);
test('Vercel: deploys the Bun-runtime function to production with the access token as an environment value', async () => {
  const calls = platform(c => c.method === 'POST' ? ok({ id: 'dpl_1', readyState: 'QUEUED' }) : ok({ id: 'dpl_1', readyState: 'READY', alias: ['my-relay-abc123def-team.vercel.app', 'my-relay.vercel.app'], url: 'x.vercel.app' }));
  const r = await deployRelay({ platform: 'vercel', token: API_TOKEN, name: 'my-relay', region: 'iad1' });
  expect(r.url).toBe('https://my-relay.vercel.app'); expect(r.runtime).toBe('bun');
  const body = JSON.parse(String(calls[0].body)); expect(body.target).toBe('production'); expect(body.env.POLYGATE_RELAY_TOKEN).toBe(r.accessToken);
  expect(body.projectSettings.serverlessFunctionRegion).toBe('iad1'); const config = JSON.parse(body.files.find((f: any) => f.file === 'vercel.json').data); expect(config.bunVersion).toBe('1.x'); expect(config.regions).toEqual(['iad1']);
  expect(body.files.find((f: any) => f.file === 'api/relay.js').data).toContain('x-relay-runtime');
});
test('Vercel: a failed build is reported with its message', async () => {
  platform(c => c.method === 'POST' ? ok({ id: 'dpl_2', readyState: 'QUEUED' }) : ok({ id: 'dpl_2', readyState: 'ERROR', errorMessage: 'Build failed' }));
  await expect(deployRelay({ platform: 'vercel', token: API_TOKEN })).rejects.toThrow('Build failed');
});
test('The platform and the token are validated before anything is sent', async () => {
  const calls = platform(() => undefined);
  await expect(deployRelay({ platform: 'heroku' as any, token: API_TOKEN })).rejects.toThrow('Choose'); await expect(deployRelay({ platform: 'vercel', token: 'x' })).rejects.toThrow('token'); expect(calls.length).toBe(0);
});
test('Vercel: the account plan and its limits are read before deploying', async () => {
  const calls = platform(c => c.url.includes('/v2/teams') ? ok({ teams: [{ id: 'team_1', slug: 'me', billing: { plan: 'hobby' } }] }) : ok({ projects: [{}, {}, {}], pagination: {} }));
  const hobby = await inspectVercel(API_TOKEN);
  expect(hobby).toMatchObject({ plan: 'hobby', team: 'me', projects: 3, projectsMore: false, limits: { regionsPerProject: 1, deploymentsPerDay: 100, projects: 200 } });
  expect(calls[1].url).toContain('teamId=team_1'); expect(calls[0].headers.get('authorization')).toBe('Bearer ' + API_TOKEN);
  platform(c => c.url.includes('/v2/teams') ? ok({ teams: [{ id: 't', slug: 'co', billing: { plan: 'pro' } }] }) : ok({ projects: [], pagination: { next: 1 } }));
  expect(await inspectVercel(API_TOKEN)).toMatchObject({ plan: 'pro', projectsMore: true, limits: { regionsPerProject: 5, projects: null } });
  await expect(inspectVercel('x')).rejects.toThrow('token');
});
test('Netlify: makes the site public, sets the access token before the function exists, uploads a valid zip, and removes the site if a step fails', async () => {
  let fn: Buffer | undefined;
  const calls = platform(c => {
    if (c.url.endsWith('/api/v1/sites') && c.method === 'POST') return ok({ id: 's1', account_id: 'acct', default_domain: 'my-relay.netlify.app' });
    if (c.url.includes('/functions/relay')) { fn = Buffer.from(c.body); return ok({}); }
    if (c.url.endsWith('/sites/s1/deploys') && c.method === 'POST') return ok({ id: 'd1', state: 'uploading', required: ['x'] });
    if (c.url.endsWith('/deploys/d1') && c.method === 'GET') return ok({ id: 'd1', state: 'ready' });
    return ok({});
  });
  const r = await deployRelay({ platform: 'netlify', token: API_TOKEN, name: 'my-relay' });
  expect(r.url).toBe('https://my-relay.netlify.app/.netlify/functions/relay'); expect(r.buffered).toBe(true); expect(r.runtime).toBe('node-bun-ciphers');
  const order = calls.filter(c => isApi(c.url)).map(c => c.method + ' ' + c.url.replace('https://api.netlify.com/api/v1', '').split('?')[0]);
  expect(order.slice(0, 4)).toEqual(['POST /sites', 'PATCH /sites/s1', 'POST /accounts/acct/env', 'POST /sites/s1/deploys']);
  expect(JSON.parse(String(calls.find(c => c.method === 'PATCH')!.body))).toEqual({ sso_login: false });
  expect(JSON.parse(String(calls.find(c => c.url.includes('/env'))!.body))[0].values[0].value).toBe(r.accessToken);
  expect(fn!.readUInt32LE(0)).toBe(0x04034b50); expect(fn!.toString()).toContain('exports.handler');
  const calls2 = platform(c => c.url.endsWith('/api/v1/sites') && c.method === 'POST' ? ok({ id: 's2', account_id: 'acct' }) : c.method === 'DELETE' ? ok({}) : Response.json({ message: 'nope' }, { status: 500 }));
  await expect(deployRelay({ platform: 'netlify', token: API_TOKEN })).rejects.toThrow('nope');
  expect(calls2.some(c => c.method === 'DELETE' && c.url.endsWith('/sites/s2'))).toBe(true);
});
test('The zip writer produces a readable archive with correct checksums', () => {
  const z = __zip({ 'a.js': 'exports.x = 1;\n', 'dir/b.txt': 'héllo' });
  const eocd = z.length - 22; expect(z.readUInt32LE(eocd)).toBe(0x06054b50); expect(z.readUInt16LE(eocd + 10)).toBe(2);
  let off = 0; const names: string[] = [];
  while (z.readUInt32LE(off) === 0x04034b50) { const size = z.readUInt32LE(off + 18), nl = z.readUInt16LE(off + 26), crc = z.readUInt32LE(off + 14); const data = z.subarray(off + 30 + nl, off + 30 + nl + size); expect(Bun.hash.crc32(data) >>> 0).toBe(crc); names.push(z.subarray(off + 30, off + 30 + nl).toString()); off += 30 + nl + size; }
  expect(names).toEqual(['a.js', 'dir/b.txt']); expect(z.readUInt32LE(eocd + 16)).toBe(off);
});
test('Vercel: the Node runtime option leaves out bunVersion, marks the package as a module and reports the Node runtime', async () => {
  const calls = platform(c => c.method === 'POST' ? ok({ id: 'dpl_3', readyState: 'QUEUED' }) : ok({ id: 'dpl_3', readyState: 'READY', alias: ['my-node-relay.vercel.app'], url: 'x.vercel.app' }));
  const r = await deployRelay({ platform: 'vercel', token: API_TOKEN, name: 'my-node-relay', region: 'fra1', runtime: 'node' });
  expect(r.runtime).toBe('node-bun-ciphers'); expect(r.url).toBe('https://my-node-relay.vercel.app');
  const body = JSON.parse(String(calls[0].body)); const config = JSON.parse(body.files.find((f: any) => f.file === 'vercel.json').data);
  expect(config.bunVersion).toBeUndefined(); expect(config.regions).toEqual(['fra1']); expect(config.functions['api/relay.js'].maxDuration).toBe(300);
  expect(JSON.parse(body.files.find((f: any) => f.file === 'package.json').data).type).toBe('module');
  const bun = platform(c => c.method === 'POST' ? ok({ id: 'dpl_4', readyState: 'QUEUED' }) : ok({ id: 'dpl_4', readyState: 'READY', alias: ['my-bun-relay.vercel.app'], url: 'y.vercel.app' }));
  await deployRelay({ platform: 'vercel', token: API_TOKEN, name: 'my-bun-relay' }); const b = JSON.parse(String(bun[0].body));
  expect(JSON.parse(b.files.find((f: any) => f.file === 'vercel.json').data).bunVersion).toBe('1.x'); expect(JSON.parse(b.files.find((f: any) => f.file === 'package.json').data).type).toBeUndefined();
});
