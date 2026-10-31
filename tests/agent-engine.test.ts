import { test, expect, afterAll } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// The agent's engine manager (docs/agent/PLAN.md, Phase 1): the pinned OpenCode download, how it is run, and the self-test that refuses
// an engine that is not using Polygate's configuration. The state folder comes from tests/setup.ts; the engine gets a folder of its own.
process.env.POLYGATE_AGENT_DIR = mkdtempSync(path.join(tmpdir(), 'pg-agent-'));
const engine = await import('../backend/agent-engine');
const { settings } = await import('../backend/state');
const { ensureAgentKey } = await import('../backend/keys');
const FAKE = [process.execPath, path.join(import.meta.dir, 'fixtures', 'fake-opencode.ts')];
const keysBefore = settings.keys.map(k => k.id);

// A tar.gz the way npm packs one.
function tgz(entries: [string, string | Buffer][]) {
  const blocks: Buffer[] = [];
  for (const [name, body] of entries) {
    const data = Buffer.from(body); const h = Buffer.alloc(512);
    h.write(name, 0, 100); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.from(Bun.gzipSync(Buffer.concat(blocks)));
}
const integrity = (b: Buffer) => 'sha512-' + createHash('sha512').update(b).digest('base64');
const program = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(70000, 7)]);
const pkg = JSON.stringify({ name: '@opencode/cli-windows-x64', version: engine.ENGINE_VERSION });
const archives: Record<string, Buffer> = {
  '/good.tgz': tgz([['package/package.json', pkg], ['package/bin/opencode.exe', program]]),
  '/hostile.tgz': tgz([['package/package.json', pkg], ['../../escaped.txt', 'x'], ['package/bin/../../../escaped2.txt', 'x'], ['package/bin/opencode.exe', program], ['package/postinstall.js', 'x']]),
  '/not-a-program.tgz': tgz([['package/package.json', pkg], ['package/bin/opencode.exe', 'echo hi']]),
};
const registry = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: req => { const body = archives[new URL(req.url).pathname]; return new Response(body ? new Uint8Array(body) : 'missing', { status: body ? 200 : 404 }); } });
const source = (name: string, sum = integrity(archives[name])) => ({ url: `http://127.0.0.1:${registry.port}${name}`, integrity: sum });
const paths = () => engine.enginePaths();
const alive = (pid?: number) => { try { process.kill(pid!, 0); return true; } catch { return false; } };
const until = async (check: () => boolean, ms = 15000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await Bun.sleep(100); } };

afterAll(async () => {
  await engine.stopEngine(); registry.stop(true);
  settings.keys = settings.keys.filter(k => keysBefore.includes(k.id));
  delete process.env.FAKE_OPENCODE_MODE; delete process.env.FAKE_OPENCODE_CRASH_FILE; delete process.env.POLYGATE_AGENT_DIR;
});

test('downloads come from the npm registry over HTTPS, and nowhere else', () => {
  expect(engine.tarballUrl('@opencode/cli-windows-x64')).toBe(`https://registry.npmjs.org/@opencode/cli-windows-x64/-/cli-windows-x64-${engine.ENGINE_VERSION}.tgz`);
  expect(() => engine.assertRegistry(engine.tarballUrl('@opencode/cli-windows-arm64'))).not.toThrow();
  for (const bad of ['http://registry.npmjs.org/x.tgz', 'https://registry.npmjs.org.evil.example/x.tgz', 'https://user:pw@registry.npmjs.org/x.tgz', 'https://registry.npmjs.org:8443/x.tgz', 'https://evil.example/x.tgz'])
    expect(() => engine.assertRegistry(bad)).toThrow();
});

test('an engine download that does not match the published checksum is refused, and nothing is left behind', async () => {
  await expect(engine.installEngine({ source: source('/good.tgz', integrity(Buffer.from('something else'))), arch: 'x64' })).rejects.toThrow(/checksum/);
  expect(engine.engineStatus().installed).toBe(false);
  expect(existsSync(paths().bin)).toBe(false);
  expect(readdirSync(path.dirname(paths().bin)).filter(n => n.startsWith('.download'))).toEqual([]);
});

test('an archive whose program is not a Windows executable is refused', async () => {
  await expect(engine.installEngine({ source: source('/not-a-program.tgz'), arch: 'x64' })).rejects.toThrow(/Windows program/);
  expect(engine.engineStatus().installed).toBe(false);
});

test('only the program and its package file are taken from the archive, whatever else it holds or wherever it points', async () => {
  await engine.installEngine({ source: source('/hostile.tgz'), arch: 'x64' });
  const p = paths();
  expect(readdirSync(p.bin).sort()).toEqual(['manifest.json', 'opencode.exe', 'package.json']);
  expect(readFileSync(p.exe).equals(program)).toBe(true);
  for (const dir of [p.root, path.dirname(p.root), path.dirname(p.bin), path.dirname(path.dirname(p.bin))]) for (const n of ['escaped.txt', 'escaped2.txt']) expect(existsSync(path.join(dir, n))).toBe(false);
  const manifest = JSON.parse(readFileSync(path.join(p.bin, 'manifest.json'), 'utf8'));
  expect(manifest).toMatchObject({ version: engine.ENGINE_VERSION, package: '@opencode/cli-windows-x64', exeSha256: createHash('sha256').update(program).digest('hex') });
  expect(engine.engineStatus()).toMatchObject({ installed: true, state: 'installed' });
});

test('a changed engine program is not started', async () => {
  const p = paths(); const saved = readFileSync(p.exe);
  writeFileSync(p.exe, Buffer.concat([saved, Buffer.from('tampered')]));
  engine.setEngineGateway('http://127.0.0.1:9');
  await expect(engine.startEngine()).rejects.toThrow(/changed since it was installed/);
  writeFileSync(p.exe, saved);
});

test('the engine configuration holds Polygate as the only provider, the ask-first rules and the scrub plugin, and no secret', () => {
  const cfg = engine.engineConfig({ gatewayUrl: 'http://127.0.0.1:4317', models: [
    { id: 'opencode/deepseek-v4.1-flash-free', name: 'DeepSeek', context: 200000, output: 32000 }, { id: 'kilo/kilo-auto/free', name: 'Kilo', context: 0, output: 0 },
  ] });
  expect(Object.keys(cfg.providers)).toEqual(['polygate']);
  expect(cfg.providers.polygate.settings).toEqual({ baseURL: 'http://127.0.0.1:4317/v1', apiKey: '{env:POLYGATE_AGENT_KEY}' });
  expect(cfg.providers.polygate.models['opencode/deepseek-v4.1-flash-free'].limit).toEqual({ context: 200000, output: 32000 });
  expect(cfg.providers.polygate.models['kilo/kilo-auto/free'].limit.context).toBeGreaterThan(0);
  expect(cfg.policies).toEqual([{ action: 'provider.use', resource: '*', effect: 'deny' }, { action: 'provider.use', resource: 'polygate', effect: 'allow' }]);
  expect(cfg.permissions[0]).toEqual({ action: '*', resource: '*', effect: 'ask' });
  const effect = (action: string, resource = '*') => cfg.permissions.filter((r: any) => r.action === action && r.resource === resource).at(-1)?.effect;
  expect([effect('read'), effect('read', '*.env'), effect('edit'), effect('shell'), effect('external_directory'), effect('webfetch')]).toEqual(['allow', 'ask', 'ask', 'ask', 'ask', 'ask']);
  expect(cfg).toMatchObject({ update: 'disable', share: 'disabled', snapshots: true, plugins: ['./polygate-scrub'] });
  expect(JSON.stringify(cfg)).not.toMatch(/pg_[0-9a-f]{10}/);
});

test('each mode is an engine agent with its own rules, and Polygate\'s folders stay closed to file tools in every mode', () => {
  const state = path.join(tmpdir(), 'Polygate', 'state'); const folder = path.resolve(state).replace(/\\/g, '/');
  const cfg = engine.engineConfig({ gatewayUrl: 'http://127.0.0.1:4317', models: [], protect: [state, state + path.sep] });
  expect(Object.keys(cfg.agents).sort()).toEqual(['polygate-accept-edits', 'polygate-ask', 'polygate-full', 'polygate-plan', 'polygate-rules']);
  const last = (rules: any[], action: string) => rules.filter(r => r.action === action && r.resource === '*').at(-1)?.effect;
  const rulesOf = (agent: string) => [...cfg.permissions, ...cfg.agents[agent].permissions];
  expect(['edit', 'shell', 'external_directory'].map(a => last(rulesOf('polygate-ask'), a))).toEqual(['ask', 'ask', 'ask']);
  expect(['edit', 'shell', 'external_directory'].map(a => last(rulesOf('polygate-accept-edits'), a))).toEqual(['allow', 'ask', 'ask']);
  expect(['read', 'edit', 'shell', 'external_directory'].map(a => last(rulesOf('polygate-plan'), a))).toEqual(['allow', 'deny', 'deny', 'ask']);
  // The folder rules close every list, after a mode's own rules, and a folder named twice is written once.
  const guard = ['external_directory', 'read', 'edit'].map(action => ({ action, resource: `${folder}/*`, effect: 'deny' }));
  expect(cfg.permissions.slice(-3)).toEqual(guard);
  for (const agent of Object.keys(cfg.agents).filter(id => id !== 'polygate-full')) expect(cfg.agents[agent].permissions.slice(-3)).toEqual(guard);
  expect(cfg.agents['polygate-full'].permissions).toEqual([{ action: '*', resource: '*', effect: 'ask' }]);
  expect(['edit', 'shell'].map(a => last(rulesOf('polygate-rules'), a))).toEqual(['allow', 'ask']);
});

test('the agent\'s shell is chosen by Polygate: PowerShell 7 when it is installed, Windows PowerShell otherwise, and written to the configuration', () => {
  expect(engine.chooseShell(name => name === 'pwsh' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null)).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  expect(engine.chooseShell(() => null)).toBe(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  expect(engine.engineConfig({ gatewayUrl: 'http://127.0.0.1:4317', models: [], shell: 'C:\\pwsh.exe' }).shell).toBe('C:\\pwsh.exe');
});

test('the engine gets none of Polygate\'s secrets, a password of its own and every hardening switch', () => {
  const saved = { ...process.env };
  Object.assign(process.env, { POLYGATE_ADMIN_TOKEN: 'admin-secret', POLYGATE_ADMIN_PASSWORD: 'pw', OPENCODE_CONFIG: 'C:\\elsewhere.json', XDG_CONFIG_HOME: 'C:\\mine' });
  try {
    const env = engine.engineEnv(paths(), 'engine-password', 'pg_agentkey');
    expect(Object.keys(env).filter(k => /^POLYGATE_/i.test(k))).toEqual(['POLYGATE_AGENT_KEY']);
    expect(env.OPENCODE_CONFIG).toBeUndefined();
    expect(env).toMatchObject({ OPENCODE_PASSWORD: 'engine-password', POLYGATE_AGENT_KEY: 'pg_agentkey', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', XDG_CONFIG_HOME: paths().config, XDG_DATA_HOME: paths().data, OPENCODE_TEST_HOME: paths().userhome });
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});

test('the engine data folder stays short enough for Git snapshots', () => {
  expect(paths().data.length).toBeLessThanOrEqual(engine.MAX_DATA_PATH);
  expect(engine.enginePaths('C:\\' + 'x'.repeat(150)).data.length).toBeLessThanOrEqual(engine.MAX_DATA_PATH);
});

test('a started engine passes its self-test on a loopback port with a fresh password, and stopping it ends the process', async () => {
  engine.setEngineGateway('http://127.0.0.1:9');
  const first = await engine.startEngine({ command: FAKE });
  expect(first).toMatchObject({ state: 'running', problems: [] });
  expect(JSON.stringify(first)).not.toContain(engine.engineConnection()!.auth.slice(6));
  const report = JSON.parse(readFileSync(path.join(paths().home, 'fake-env.json'), 'utf8'));
  expect(report.args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', String(first.port)]);
  expect(report.env.OPENCODE_PASSWORD.length).toBeGreaterThanOrEqual(30);
  expect(report.env.POLYGATE_ADMIN_TOKEN).toBeUndefined();
  expect(report.env.POLYGATE_AGENT_KEY).toBe(ensureAgentKey().value);
  const written = JSON.parse(readFileSync(path.join(paths().configDir, 'opencode.json'), 'utf8'));
  expect(written.providers.polygate.settings.baseURL).toBe('http://127.0.0.1:9/v1');
  expect(existsSync(path.join(paths().configDir, 'polygate-scrub', 'index.js'))).toBe(true);
  const pid = first.pid; await engine.stopEngine();
  expect(engine.engineStatus().state).not.toBe('running');
  await until(() => !alive(pid));
  const second = await engine.startEngine({ command: FAKE });
  expect(JSON.parse(readFileSync(path.join(paths().home, 'fake-env.json'), 'utf8')).env.OPENCODE_PASSWORD).not.toBe(report.env.OPENCODE_PASSWORD);
  await engine.stopEngine(); await until(() => !alive(second.pid));
});

test('an engine that reads a project\'s configuration, offers another provider, loosens the rules or is another version is stopped, with the reason', async () => {
  const reasons: Record<string, RegExp> = { 'project-config': /cloned-repo/, 'other-provider': /evil/, 'loose-rules': /permission rules/, 'old-version': /1\.19\.5/, 'missing-agent': /polygate-plan agent/ };
  try {
    for (const [mode, reason] of Object.entries(reasons)) {
      process.env.FAKE_OPENCODE_MODE = mode;
      await expect(engine.startEngine({ command: FAKE })).rejects.toThrow(reason);
      const s = engine.engineStatus(); expect(s.state).toBe('failed'); expect(s.problems.join(' ')).toMatch(reason);
    }
  } finally { delete process.env.FAKE_OPENCODE_MODE; }
  expect(engine.engineConnection()).toBeUndefined();
});

test('an engine that stops by itself is started again, and stays stopped once asked to stop', async () => {
  const flag = path.join(paths().root, 'crash-once'); writeFileSync(flag, '1');
  process.env.FAKE_OPENCODE_CRASH_FILE = flag;
  try {
    const first = await engine.startEngine({ command: FAKE });
    await until(() => engine.engineStatus().restarts >= 1 && engine.engineStatus().state === 'running');
    const now = engine.engineStatus(); expect(now.pid).not.toBe(first.pid); expect(alive(first.pid)).toBe(false);
    await engine.stopEngine(); await Bun.sleep(1500);
    expect(engine.engineStatus().state).not.toBe('running'); expect(alive(now.pid)).toBe(false);
  } finally { delete process.env.FAKE_OPENCODE_CRASH_FILE; }
});

test('a change to the engine\'s configuration that Polygate did not make stops the engine at once, and leftovers are removed before a start', async () => {
  const p = paths(); const config = path.join(p.configDir, 'opencode.json');
  const first = await engine.startEngine({ command: FAKE });
  writeFileSync(config, readFileSync(config, 'utf8').replace('"permissions": [', '"permissions": [{"action":"shell","resource":"*","effect":"allow"},'));
  await until(() => engine.engineStatus().state === 'failed');
  expect(engine.engineStatus().problems.join(' ')).toContain('opencode.json was changed'); expect(engine.engineConnection()).toBeUndefined();
  await until(() => !alive(first.pid));
  // A planted agent in the configuration folder: removed when Polygate writes the folder again, and caught if it appears while running.
  const planted = path.join(p.configDir, 'agents'); mkdirSync(planted, { recursive: true }); writeFileSync(path.join(planted, 'evil.md'), '---\nmode: primary\n---\n');
  const second = await engine.startEngine({ command: FAKE });
  expect(existsSync(planted)).toBe(false); expect(JSON.parse(readFileSync(config, 'utf8')).permissions[0]).toEqual({ action: '*', resource: '*', effect: 'ask' });
  mkdirSync(planted, { recursive: true }); writeFileSync(path.join(planted, 'evil.md'), '---\nmode: primary\n---\n');
  await until(() => engine.engineStatus().state === 'failed');
  expect(engine.engineStatus().problems.join(' ')).toContain('was added');
  await until(() => !alive(second.pid));
});

test('the snapshot check says whether undo can work, and why not', () => {
  const p = { ...paths(), data: mkdtempSync(path.join(tmpdir(), 'pg-snap-')) };
  expect(engine.snapshotCheck(p)).toEqual({ ok: true });
  expect(engine.snapshotCheck(p, 'git-that-is-not-installed').reason).toContain('Git is not installed');
  expect(readdirSync(path.join(p.data, 'opencode', 'snapshot'))).toEqual([]);
});

test('the agent\'s own client key is created once and kept, and a turned-off key stops the engine from starting', async () => {
  const a = ensureAgentKey(); const b = ensureAgentKey();
  expect(b.id).toBe(a.id); expect(a).toMatchObject({ agent: true, enabled: true }); expect(settings.keys.filter(k => k.agent)).toHaveLength(1);
  a.enabled = false;
  try { await expect(engine.startEngine({ command: FAKE })).rejects.toThrow(/turned off/); } finally { a.enabled = true; }
});

test('the engine routes answer in the desktop app only', async () => {
  const { startGateway } = await import('../backend/main');
  const saved = { token: process.env.POLYGATE_ADMIN_TOKEN, desktop: process.env.POLYGATE_DESKTOP };
  process.env.POLYGATE_ADMIN_TOKEN = 'agent-engine-secret'; delete process.env.POLYGATE_DESKTOP;
  const gateway = await startGateway(0);
  const get = () => fetch(`http://127.0.0.1:${gateway.port}/admin/agent/engine`, { headers: { authorization: 'Bearer agent-engine-secret' } });
  try {
    expect((await get()).status).toBe(404);
    process.env.POLYGATE_DESKTOP = '1';
    const r = await get(); expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ version: engine.ENGINE_VERSION, installed: true });
  } finally {
    await gateway.close();
    if (saved.token === undefined) delete process.env.POLYGATE_ADMIN_TOKEN; else process.env.POLYGATE_ADMIN_TOKEN = saved.token;
    if (saved.desktop === undefined) delete process.env.POLYGATE_DESKTOP; else process.env.POLYGATE_DESKTOP = saved.desktop;
  }
});
