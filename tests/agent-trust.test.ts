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
test('consent is per folder: what the folder holds and later changes to it do not block or undo it', () => {
  mkdirSync(path.join(folder, '.opencode', 'plugins'), { recursive: true });
  writeFileSync(path.join(folder, 'opencode.json'), '{"permissions":"allow"}');
  writeFileSync(path.join(folder, '.opencode', 'plugins', 'repo.js'), 'process.exit(1)');
  writeFileSync(path.join(folder, 'AGENTS.md'), 'Project instructions');
  const before = inspectTrust(folder, store);
  expect(before.files.map(x => x.path)).toContain('.opencode/plugins/repo.js');
  expect(before.files.find(x => x.path === 'opencode.json')!.behavior).toBe('disabled');
  expect(before.files.find(x => x.path === 'AGENTS.md')!.behavior).toBe('instructions');
  grantTrust(folder, undefined, store); writeFileSync(path.join(folder, 'AGENTS.md'), 'Changed instructions');
  expect(inspectTrust(folder, store).trusted).toBe(true);
  revokeTrust(folder, store); expect(inspectTrust(folder, store).trusted).toBe(false);
});
test('the inventory never follows links or reads large files; neither blocks consent', () => {
  const outside = path.join(root, 'outside'), linked = path.join(root, 'linked'); mkdirSync(outside); mkdirSync(linked);
  writeFileSync(path.join(outside, 'private'), 'not project configuration');
  symlinkSync(outside, path.join(linked, '.opencode'), process.platform === 'win32' ? 'junction' : 'dir');
  // (A directory junction stands in for a file link, which Windows allows only with extra rights; the inventory treats both the same.)
  symlinkSync(outside, path.join(linked, 'CLAUDE.md'), process.platform === 'win32' ? 'junction' : 'dir');
  mkdirSync(path.join(linked, '.claude', 'skills', 'big'), { recursive: true }); writeFileSync(path.join(linked, '.claude', 'skills', 'big', 'tool.exe'), Buffer.alloc(1024 * 1024 + 1));
  const report = inspectTrust(linked, store);
  expect(report.files.some(x => x.path.includes('private'))).toBe(false);
  expect(report.problems).toEqual(['CLAUDE.md: a link or junction, not followed.']);
  expect(report.skipped).toEqual(['.opencode: a link or junction, not followed.', '.claude/skills/big/tool.exe: too large to inspect.']);
  grantTrust(linked, undefined, store); expect(inspectTrust(linked, store).trusted).toBe(true);
});

test('parent instructions are listed without walking unrelated parent files', () => {
  const parent = path.join(root, 'parent'), child = path.join(parent, 'nested'); mkdirSync(child, { recursive: true });
  writeFileSync(path.join(parent, 'AGENTS.md'), 'Parent instructions');
  writeFileSync(path.join(parent, 'unrelated'), 'Not loaded');
  const before = inspectTrust(child, store);
  expect(before.files.some(f => f.path === '../AGENTS.md')).toBe(true);
  expect(before.files.some(f => f.path.includes('unrelated'))).toBe(false);
});
