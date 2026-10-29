import { test, expect, beforeAll, afterAll } from 'bun:test';
import { readdirSync } from 'node:fs';
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
  const tampered = JSON.parse(out.content); tampered.data = Buffer.from('x' + Buffer.from(tampered.data, 'base64').toString('latin1').slice(1), 'latin1').toString('base64');
  expect(() => openBackup(JSON.stringify(tampered), 'correct horse battery')).toThrow('damaged');
  const heavy = JSON.parse(out.content); heavy.kdf.N = 1 << 24; expect(() => openBackup(JSON.stringify(heavy), 'correct horse battery')).toThrow('does not support');
  settings.routes = settings.routes.filter(r => r.id !== 'r-bk');
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
