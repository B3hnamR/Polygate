import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectTrust, grantTrust, revokeTrust } from '../backend/agent-trust';
const root = mkdtempSync(path.join(tmpdir(), 'pg-trust-')), folder = path.join(root, 'project'), store = path.join(root, 'state');
mkdirSync(folder); mkdirSync(store);
afterAll(() => rmSync(root, { recursive: true, force: true }));
test('a folder needs consent even without customization, and consent is removable', () => {
  const report = inspectTrust(folder, store); expect(report.trusted).toBe(false); expect(report.files).toEqual([]);
  grantTrust(folder, report.fingerprint, store); expect(inspectTrust(folder, store).trusted).toBe(true);
  revokeTrust(folder, store); expect(inspectTrust(folder, store).trusted).toBe(false);
});
test('config and instruction changes invalidate consent; stale consent never approves new content', () => {
  mkdirSync(path.join(folder, '.opencode', 'plugins'), { recursive: true });
  writeFileSync(path.join(folder, 'opencode.json'), '{"permissions":"allow"}');
  writeFileSync(path.join(folder, '.opencode', 'plugins', 'repo.js'), 'process.exit(1)');
  writeFileSync(path.join(folder, 'AGENTS.md'), 'Project instructions');
  const before = inspectTrust(folder, store);
  expect(before.files.map(x => x.path)).toContain('.opencode/plugins/repo.js');
  expect(before.files.find(x => x.path === 'opencode.json')!.behavior).toBe('disabled');
  expect(before.files.find(x => x.path === 'AGENTS.md')!.behavior).toBe('instructions');
  grantTrust(folder, before.fingerprint, store); writeFileSync(path.join(folder, 'AGENTS.md'), 'Changed instructions');
  expect(inspectTrust(folder, store).trusted).toBe(false); expect(() => grantTrust(folder, before.fingerprint, store)).toThrow(/changed/);
});
test('trust inspection never follows links or junctions and refuses an incomplete inventory', () => {
  const outside = path.join(root, 'outside'), linked = path.join(root, 'linked'); mkdirSync(outside); mkdirSync(linked);
  writeFileSync(path.join(outside, 'private'), 'not project configuration');
  symlinkSync(outside, path.join(linked, '.opencode'), process.platform === 'win32' ? 'junction' : 'dir');
  const report = inspectTrust(linked, store); expect(report.complete).toBe(false); expect(report.files.some(x => x.path.includes('private'))).toBe(false);
  expect(() => grantTrust(linked, report.fingerprint, store)).toThrow(/inspect/);
});

test('parent instructions are included without walking unrelated parent files', () => {
  const parent = path.join(root, 'parent'), child = path.join(parent, 'nested'); mkdirSync(child, { recursive: true });
  writeFileSync(path.join(parent, 'AGENTS.md'), 'Parent instructions');
  writeFileSync(path.join(parent, 'unrelated'), 'Not loaded');
  const before = inspectTrust(child, store);
  expect(before.files.some(f => f.path === '../AGENTS.md')).toBe(true);
  expect(before.files.some(f => f.path.includes('unrelated'))).toBe(false);
  grantTrust(child, before.fingerprint, store); writeFileSync(path.join(parent, 'AGENTS.md'), 'Changed parent instructions');
  expect(inspectTrust(child, store).trusted).toBe(false);
});
