import { test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN = 'backup-test-secret';
const { startGateway } = await import('../backend/main');
const { settings, stateDir } = await import('../backend/state');
const { createBackup, openBackup } = await import('../backend/backup');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = '';
const admin = { authorization: 'Bearer backup-test-secret', 'content-type': 'application/json' };
const call = async (p: string, body: unknown) => { const r = await fetch(base + p, { method: 'POST', headers: admin, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json().catch(() => ({}))) as any }; };
// Copies, because a restore replaces these arrays and other test files share this process's settings.
const saved = { providers: settings.providers.slice(), routes: settings.routes.slice(), keys: settings.keys.slice(), admin: settings.admin, mcp: settings.mcp };
beforeAll(async () => { gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`; });
afterAll(async () => { Object.assign(settings, { providers: saved.providers.slice(), routes: saved.routes.slice(), keys: saved.keys.slice() }); settings.admin = saved.admin; settings.mcp = saved.mcp; if (!saved.admin) delete settings.admin; if (!saved.mcp) delete settings.mcp; await gateway?.close(); });

test('a backup holds the settings, is unreadable without the passphrase and leaves the dashboard password out', () => {
  settings.admin = { password: { salt: 'SALT-VALUE', hash: 'HASH-VALUE' }, epoch: 3 };
  settings.routes = [...settings.routes, { id: 'r-bk', name: 'Backed-up relay', kind: 'relay', url: 'https://relay.example.com', token: 'relay-secret-token-1234', enabled: true, models: [] } as any];
  const out = createBackup('correct horse battery');
  expect(out.filename).toMatch(/^polygate-backup-\d{4}-\d{2}-\d{2}\.pgbackup$/);
  for (const secret of ['relay-secret-token-1234', 'HASH-VALUE', 'Backed-up relay', settings.keys[0].value]) expect(out.content).not.toContain(secret);
  expect(() => openBackup(out.content, 'wrong passphrase!')).toThrow('Wrong passphrase');
  expect(() => createBackup('short')).toThrow('at least 8');
  const opened = openBackup(out.content, 'correct horse battery');
  expect(opened.routes.find(r => r.id === 'r-bk')!.token).toBe('relay-secret-token-1234'); expect(opened.admin).toBeUndefined();
  expect(() => openBackup('not json', 'correct horse battery')).toThrow('not a Polygate backup');
  const tampered = JSON.parse(out.content); const bytes = Buffer.from(tampered.data, 'base64'); bytes[0] ^= 1; tampered.data = bytes.toString('base64'); // flipping a bit always changes the ciphertext
  expect(() => openBackup(JSON.stringify(tampered), 'correct horse battery')).toThrow('damaged');
  const heavy = JSON.parse(out.content); heavy.kdf.N = 1 << 24; expect(() => openBackup(JSON.stringify(heavy), 'correct horse battery')).toThrow('does not support');
  settings.routes = settings.routes.filter(r => r.id !== 'r-bk');
});

test('a backup with a path-traversal WireGuard config id is refused', () => {
  const passphrase = 'a long passphrase';
  const file = JSON.parse(createBackup(passphrase).content);
  const key = scryptSync(passphrase, Buffer.from(file.kdf.salt, 'base64'), 32, { N: file.kdf.N, r: file.kdf.r, p: file.kdf.p, maxmem: 128 * 1024 * 1024 });
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
  const data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString());
  data.wireguard = { enabled: true, configs: [{ id: '../../../etc', name: 'bad', config: '[Interface]', enabled: true }] };
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
  const body = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
  file.data = body.toString('base64'); file.tag = cipher.getAuthTag().toString('base64');
  expect(() => openBackup(JSON.stringify(file), passphrase)).toThrow('WireGuard settings');
});

test('restoring replaces the settings, keeps the current dashboard password and keeps a copy of what was there', async () => {
  settings.admin = { password: { salt: 'KEEP-SALT', hash: 'KEEP-HASH' }, epoch: 1 };
  settings.routes = [...settings.routes, { id: 'r-was', name: 'Relay that was backed up', kind: 'relay', url: 'https://was.example.com', token: 'was-token-123456', enabled: true, models: [] } as any];
  const exported = await call('/admin/backup/export', { passphrase: 'a long passphrase' }); expect(exported.status).toBe(200);
  settings.routes = settings.routes.filter(r => r.id !== 'r-was'); settings.routes = [...settings.routes, { id: 'r-later', name: 'Added after the backup', kind: 'relay', url: 'https://later.example.com', token: 'later-token-123456', enabled: true, models: [] } as any];
  settings.admin = { password: { salt: 'NEW-SALT', hash: 'NEW-HASH' }, epoch: 2 };
  const bad = await call('/admin/backup/restore', { content: exported.body.content, passphrase: 'not the passphrase' });
  expect(bad.status).toBe(400); expect(settings.routes.some(r => r.id === 'r-later')).toBe(true); // a failed restore changes nothing
  const done = await call('/admin/backup/restore', { content: exported.body.content, passphrase: 'a long passphrase' });
  expect(done.status).toBe(200);
  expect(settings.routes.some(r => r.id === 'r-was')).toBe(true); expect(settings.routes.some(r => r.id === 'r-later')).toBe(false);
  expect(settings.admin?.password?.hash).toBe('NEW-HASH'); // the password in use now, not the one from the backup
  expect(readdirSync(stateDir).some(f => f.startsWith('settings.vault.before-restore-'))).toBe(true);
});

test('restoring a selected Surfshark onto an idle gateway fails closed before and after restart', async () => {
  const { surfsharkConfig, startSurfshark, surfsharkStatus } = await import('../backend/surfshark');
  const { routeFor } = await import('../backend/transport');
  const { persist } = await import('../backend/state');
  const saved = { routes: settings.routes, routeId: settings.routeId, rotate: settings.rotate, allowDirect: settings.allowDirect,
    managedChoice: settings.managedChoice, previousRouteId: settings.previousRouteId, surfshark: settings.surfshark, psiphon: settings.psiphon };
  try {
    expect(surfsharkStatus().running).toBe(false);
    settings.routes = [{ id: 'direct', name: 'Direct', kind: 'direct', url: '', enabled: true, models: [] },
      { id: 'surfshark', name: 'Surfshark', kind: 'proxy', url: 'surfshark://local', enabled: true, models: [], managed: true }];
    settings.rotate = false; settings.allowDirect = false; settings.routeId = 'surfshark'; settings.previousRouteId = 'direct'; delete settings.managedChoice;
    // Missing keys force startup to stop before a tunnel can launch, even with the client installed.
    settings.surfshark = { ...surfsharkConfig(), enabled: true, autoStart: false, regions: ['de-fra'], privateKey: undefined };
    const passphrase = 'restore selected route'; const { content } = createBackup(passphrase);
    settings.routeId = 'direct'; settings.routes = settings.routes.filter(r => r.id === 'direct');
    expect((await call('/admin/backup/restore', { content, passphrase })).status).toBe(200);
    const checkUnavailable = () => {
      expect(settings.routeId).toBe('surfshark'); expect(surfsharkStatus().route.enabled).toBe(false);
      expect(() => routeFor()).toThrow('disabled or missing');
    };
    checkUnavailable();
    await startSurfshark();
    expect(surfsharkStatus().lastError).toMatch(/key pair|WireGuard client/i); // selection requested a start even though autoStart is false
    checkUnavailable();
  } finally { Object.assign(settings, saved); persist(); }
});

test('a restore from a session that cannot manage this machine does not bring in local programs', async () => {
  settings.mcp = { enabled: true, builtin: true, servers: [{ id: 'planted', name: 'planted', enabled: true, transport: 'stdio', command: 'calc' }, { id: 'remote', name: 'remote', enabled: true, transport: 'http', url: 'https://mcp.example.com' }] } as any;
  const fromBackup = createBackup('a long passphrase');
  settings.mcp = { enabled: true, builtin: true, servers: [{ id: 'local-now', name: 'local now', enabled: true, transport: 'stdio', command: 'present' }] } as any;
  const { restoreBackup } = await import('../backend/backup');
  restoreBackup(fromBackup.content, 'a long passphrase', false);
  const ids = settings.mcp!.servers.map(s => s.id).sort();
  expect(ids).toEqual(['local-now', 'remote']); // the backup's stdio program was dropped, the current one kept, the remote server restored
  restoreBackup(fromBackup.content, 'a long passphrase', true);
  expect(settings.mcp!.servers.map(s => s.id).sort()).toEqual(['planted', 'remote']); // a session that manages this machine restores everything
});

test('a restore from a session that cannot manage this machine keeps the current WARP helper program', async () => {
  const { restoreBackup } = await import('../backend/backup');
  const warp = (helperPath: string) => ({ engine: 'embedded', autoStart: false, pool: 2, rotateMinutes: 0, helperPath, endpoint: '', split: 'auto' }) as any;
  const before = settings.warp;
  try {
    settings.warp = warp('C:\planted\evil.exe'); const planted = createBackup('a long passphrase').content;
    settings.warp = warp('C:\mine\helper.exe');
    restoreBackup(planted, 'a long passphrase', false); expect(settings.warp!.helperPath).toBe('C:\mine\helper.exe');
    restoreBackup(planted, 'a long passphrase', true); expect(settings.warp!.helperPath).toBe('C:\planted\evil.exe');
  } finally { settings.warp = before; }
});

test('backup prototype properties are rejected before live settings or the vault change', async () => {
  const { restoreBackup } = await import('../backend/backup');
  const passphrase = 'prototype regression passphrase';
  const file = JSON.parse(createBackup(passphrase).content);
  const key = scryptSync(passphrase, Buffer.from(file.kdf.salt, 'base64'), 32, { N: file.kdf.N, r: file.kdf.r, p: file.kdf.p, maxmem: 128 * 1024 * 1024 });
  const decrypt = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
  decrypt.setAuthTag(Buffer.from(file.tag, 'base64'));
  const original = JSON.parse(Buffer.concat([decrypt.update(Buffer.from(file.data, 'base64')), decrypt.final()]).toString());
  const before = JSON.stringify(settings), prototype = Object.getPrototypeOf(settings), files = readdirSync(stateDir).sort();
  const vault = path.join(stateDir, 'settings.vault'), vaultBytes = existsSync(vault) ? readFileSync(vault) : undefined;
  for (const providers of [original.providers, []]) {
    const content = { ...original, providers };
    delete content.mcp;
    // Parsed JSON has an own data property, unlike object-literal prototype syntax.
    Object.defineProperty(content, '__proto__', { enumerable: true, value: { mcp: { enabled: true, builtin: false, servers: [{ id: 'injected', name: 'injected', enabled: true, transport: 'stdio', command: 'must-not-start' }] } } });
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(content)), cipher.final()]);
    const raw = JSON.stringify({ ...file, iv: iv.toString('base64'), data: encrypted.toString('base64'), tag: cipher.getAuthTag().toString('base64') });
    for (const local of [false, true]) expect(() => restoreBackup(raw, passphrase, local)).toThrow('usable settings');
    expect(Object.getPrototypeOf(settings)).toBe(prototype);
    expect(JSON.stringify(settings)).toBe(before);
    expect(readdirSync(stateDir).sort()).toEqual(files);
    expect(existsSync(vault) ? readFileSync(vault) : undefined).toEqual(vaultBytes);
  }
});

test('on a server, a signed-in dashboard session must type the dashboard password again to export or restore', async () => {
  const keep = settings.admin; delete settings.admin; // no stored password: the admin token doubles as the dashboard password
  try {
    const login = await fetch(base + '/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'backup-test-secret' }) });
    expect(login.status).toBe(200); const cookie = (login.headers.get('set-cookie') || '').split(';')[0]; expect(cookie).toContain('=');
    const session = async (p: string, body: unknown) => { const r = await fetch(base + p, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json().catch(() => ({}))) as any }; };
    const none = await session('/admin/backup/export', { passphrase: 'a long passphrase' }); expect(none.status).toBe(403); expect(none.body.error.message).toContain('dashboard password');
    expect((await session('/admin/backup/export', { passphrase: 'a long passphrase', password: 'not it' })).status).toBe(403);
    const ok = await session('/admin/backup/export', { passphrase: 'a long passphrase', password: 'backup-test-secret' }); expect(ok.status).toBe(200); expect(ok.body.content).toContain('polygate-backup');
    expect((await session('/admin/backup/restore', { content: ok.body.content, passphrase: 'a long passphrase' })).status).toBe(403); // restoring is asked too
  } finally { if (keep) settings.admin = keep; }
});
