import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { __setBackupLimits, backupBytes, beforeFile, byteDiff, captureBackup, filePath, pruneBackups, restoreFile, saveBytes } from '../backend/agent-backup';
import { enginePaths } from '../backend/agent-engine';
const root = mkdtempSync(path.join(tmpdir(), 'pg-backup-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('backups preserve exact CRLF and binary bytes, while excluded trees never look like absent files', async () => {
  const project = path.join(root, 'project'); mkdirSync(path.join(project, 'node_modules'), { recursive: true });
  const raw = Buffer.from([0, 255, 13, 10, 0]); writeFileSync(path.join(project, 'raw'), raw);
  writeFileSync(path.join(project, 'node_modules', 'excluded'), 'not backed up');
  const saved = await captureBackup(project);
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

test('corrupt backup bytes are rejected instead of restored', async () => {
  const project = path.join(root, 'corrupt'); mkdirSync(project); writeFileSync(path.join(project, 'a'), 'preserve');
  const saved = beforeFile(await captureBackup(project), 'a')!;
  if (!saved) throw new Error('missing fixture');
  const blob = path.join(enginePaths().root, 'backups', saved.hash), bytes = readFileSync(blob);
  try { writeFileSync(blob, 'damaged'); expect(() => backupBytes(saved)).toThrow(/checksum/); }
  finally { writeFileSync(blob, bytes); }
  expect(readFileSync(path.join(project, 'a'), 'utf8')).toBe('preserve');
});

test('a second backup reads only files that changed, and keeps exact bytes for both', async () => {
  const project = path.join(root, 'incremental'); mkdirSync(project);
  writeFileSync(path.join(project, 'same'), 'unchanged'); writeFileSync(path.join(project, 'edit'), 'first');
  const first = await captureBackup(project);
  writeFileSync(path.join(project, 'edit'), 'second, longer');
  // An unchanged file is not read again: a copy that went missing in between would not be noticed if it were.
  const blob = path.join(enginePaths().root, 'backups', first.files.same.hash), saved = readFileSync(blob);
  const second = await captureBackup(project);
  expect(second.files.same.hash).toBe(first.files.same.hash);
  expect(backupBytes(second.files.edit).toString()).toBe('second, longer');
  expect(backupBytes(first.files.edit).toString()).toBe('first');
  // A missing copy is never assumed: the file is read and saved again.
  rmSync(blob); expect((await captureBackup(project)).files.same.hash).toBe(first.files.same.hash);
  expect(readFileSync(blob)).toEqual(saved);
});

test('pruning does not run while a backup is being taken', async () => {
  const project = path.join(root, 'during'); mkdirSync(project); writeFileSync(path.join(project, 'a'), 'a');
  const loose = saveBytes(Buffer.from('old and unreferenced, pruned only between backups'));
  const old = new Date(Date.now() - 2 * 3600000); utimesSync(path.join(enginePaths().root, 'backups', loose), old, old);
  const taking = captureBackup(project);
  expect(await pruneBackups(new Set())).toBe(0);
  await taking;
  expect(existsSync(path.join(enginePaths().root, 'backups', loose))).toBe(true);
});

test('a file too large for a backup is left out and the backup says it is limited; a folder within the limits is not', async () => {
  const project = path.join(root, 'large'); mkdirSync(project);
  writeFileSync(path.join(project, 'small'), 'x');
  expect((await captureBackup(project)).limited).toBeUndefined();
  writeFileSync(path.join(project, 'big'), Buffer.alloc(8 * 1024 * 1024 + 1));
  const saved = await captureBackup(project);
  expect(saved.limited).toBe(true);
  expect(beforeFile(saved, 'big')).toBeUndefined();
  expect(beforeFile(saved, 'small')).not.toBeUndefined();
});

test('the backup does not hold up other work while it reads the folder', async () => {
  const project = path.join(root, 'busy'); mkdirSync(project);
  for (let i = 0; i < 300; i++) writeFileSync(path.join(project, `f${i}`), `content ${i} `.repeat(2000));
  let ticks = 0; const timer = setInterval(() => ticks++, 1);
  try { await captureBackup(project); } finally { clearInterval(timer); }
  expect(ticks).toBeGreaterThan(0);
});

test('pruning removes old copies nothing refers to, and keeps referenced, last-backup and recent ones', async () => {
  const project = path.join(root, 'prune'); mkdirSync(project); writeFileSync(path.join(project, 'kept'), 'in the last backup');
  const kept = (await captureBackup(project)).files.kept.hash;
  const loose = saveBytes(Buffer.from('nothing refers to this')), turn = saveBytes(Buffer.from('a turn record refers to this')), fresh = saveBytes(Buffer.from('saved a moment ago'));
  const blob = (hash: string) => path.join(enginePaths().root, 'backups', hash);
  const hourAgo = new Date(Date.now() - 2 * 3600000);
  for (const h of [kept, loose, turn]) utimesSync(blob(h), hourAgo, hourAgo);
  expect(await pruneBackups(null)).toBe(0);
  expect(existsSync(blob(loose))).toBe(true);
  await pruneBackups(new Set([turn]));
  expect(existsSync(blob(loose))).toBe(false);
  for (const h of [kept, turn, fresh]) expect(existsSync(blob(h))).toBe(true);
});

test('in a folder the limits cut short, saved files stay exact and files never seen are unknown, never taken as absent', async () => {
  const project = path.join(root, 'cut'); mkdirSync(path.join(project, 'deep'), { recursive: true });
  for (const name of ['a', 'b', 'c', 'd']) writeFileSync(path.join(project, name), name);
  writeFileSync(path.join(project, 'deep', 'e'), 'e');
  __setBackupLimits(2);
  try {
    const saved = await captureBackup(project);
    expect(saved.limited).toBe(true);
    const known = Object.keys(saved.files);
    expect(known.length).toBeLessThanOrEqual(2);
    for (const rel of known) expect(backupBytes(beforeFile(saved, rel)!).toString()).toBe(rel);
    for (const rel of ['a', 'b', 'c', 'd', 'deep/e', 'created-later'].filter(r => !known.includes(r))) expect(beforeFile(saved, rel)).toBeUndefined();
  } finally { __setBackupLimits(); }
});
