import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { backupBytes, beforeFile, byteDiff, captureBackup, filePath, restoreFile } from '../backend/agent-backup';
import { enginePaths } from '../backend/agent-engine';
const root = mkdtempSync(path.join(tmpdir(), 'pg-backup-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('backups preserve exact CRLF and binary bytes, while excluded trees never look like absent files', () => {
  const project = path.join(root, 'project'); mkdirSync(path.join(project, 'node_modules'), { recursive: true });
  const raw = Buffer.from([0, 255, 13, 10, 0]); writeFileSync(path.join(project, 'raw'), raw);
  writeFileSync(path.join(project, 'node_modules', 'excluded'), 'not backed up');
  const saved = captureBackup(project);
  expect(backupBytes(beforeFile(saved, 'raw')!)).toEqual(raw);
  expect(beforeFile(saved, 'missing')).toBeNull();
  expect(beforeFile(saved, 'node_modules/excluded')).toBeUndefined();
  expect(beforeFile(undefined, 'raw')).toBeUndefined();
  writeFileSync(path.join(project, 'raw'), 'changed');
  restoreFile(project, 'raw', beforeFile(saved, 'raw')!);
  expect(readFileSync(path.join(project, 'raw'))).toEqual(raw);
});

test('restoration rejects paths outside the folder and junctions rather than touching their targets', () => {
  const project = path.join(root, 'paths'), outside = path.join(root, 'outside');
  mkdirSync(project); mkdirSync(outside); writeFileSync(path.join(outside, 'keep'), 'user data');
  symlinkSync(outside, path.join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => filePath(project, '../outside/keep')).toThrow();
  expect(() => restoreFile(project, 'linked/keep', null)).toThrow();
  expect(readFileSync(path.join(outside, 'keep'), 'utf8')).toBe('user data');
});

test('raw diffs count inserted lines correctly and do not hide actual ending changes', () => {
  const original = Buffer.from('one\r\ntwo\r\n');
  expect(byteDiff('a', original, Buffer.from('// comment\r\none\r\ntwo\r\n'))).toMatchObject({ additions: 1, deletions: 0 });
  expect(byteDiff('a', original, Buffer.from('one\ntwo\n'))).toMatchObject({ additions: 2, deletions: 2 });
  expect(byteDiff('a', Buffer.from('one\ntwo\nthree\nfour\nfive\n'), Buffer.from('ONE\ntwo\nthree\nfour\nFIVE\n'))).toMatchObject({ additions: 2, deletions: 2 });
});

test('corrupt backup bytes are rejected instead of restored', () => {
  const project = path.join(root, 'corrupt'); mkdirSync(project); writeFileSync(path.join(project, 'a'), 'preserve');
  const saved = beforeFile(captureBackup(project), 'a')!;
  if (!saved) throw new Error('missing fixture');
  const blob = path.join(enginePaths().root, 'backups', saved.hash), bytes = readFileSync(blob);
  try { writeFileSync(blob, 'damaged'); expect(() => backupBytes(saved)).toThrow(/checksum/); }
  finally { writeFileSync(blob, bytes); }
  expect(readFileSync(path.join(project, 'a'), 'utf8')).toBe('preserve');
});
