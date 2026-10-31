import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { enginePaths } from './agent-engine';
import { writeFileAtomic } from './state';

type SavedFile = { hash: string; mode: number };
export type FileBackup = SavedFile | null;
export type Backup = { files: Record<string, SavedFile>; excluded: string[] };
const MAX_BYTES = 256 * 1024 * 1024, MAX_FILES = 20000;
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv']);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const store = () => path.join(enginePaths().root, 'backups');
const blob = (hash: string) => {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid agent backup checksum.');
  return path.join(store(), hash);
};
export function saveBytes(bytes: Buffer) {
  const hash = digest(bytes), dest = blob(hash);
  mkdirSync(store(), { recursive: true });
  if (!existsSync(dest)) writeFileAtomic(dest, bytes);
  return hash;
}
export function backupBytes(file: SavedFile) {
  const bytes = readFileSync(blob(file.hash));
  if (digest(bytes) !== file.hash) throw new Error('The agent backup failed its checksum check. Nothing was undone.');
  return bytes;
}
// Only normal files inside the working folder are backed up/restored. Never follow a link or junction into another directory.
export function filePath(folder: string, file: string) {
  const root = path.resolve(folder), full = path.resolve(root, file), rel = path.relative(root, full);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('The changed file is outside the working folder.');
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('Undo does not follow symbolic links or junctions.'); }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  }
  return full;
}
export function captureBackup(folder: string): Backup {
  const files: Backup['files'] = Object.create(null), excluded: string[] = [];
  let bytes = 0, count = 0;
  const visit = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { excluded.push(path.relative(folder, dir).replace(/\\/g, '/')); return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name), rel = path.relative(folder, full).replace(/\\/g, '/');
      try {
        if (entry.isSymbolicLink() || (entry.isDirectory() && SKIP.has(entry.name))) { excluded.push(rel); continue; }
        if (entry.isDirectory()) { if (count >= MAX_FILES || bytes >= MAX_BYTES) excluded.push(rel); else visit(full); continue; }
        if (!entry.isFile() || ++count > MAX_FILES) { excluded.push(rel); continue; }
        const st = lstatSync(full);
        if (bytes + st.size > MAX_BYTES) { excluded.push(rel); continue; }
        const content = readFileSync(full); bytes += content.length;
        if (bytes > MAX_BYTES) { excluded.push(rel); continue; }
        files[rel] = { hash: saveBytes(content), mode: st.mode & 0o777 };
      } catch { excluded.push(rel); }
    }
  };
  visit(folder);
  return { files, excluded };
}
export function beforeFile(backup: Backup | undefined, file: string): FileBackup | undefined {
  const rel = file.replace(/\\/g, '/');
  if (!backup || rel.split('/').some(x => SKIP.has(x)) || backup.excluded.some(x => !x || rel === x || rel.startsWith(x + '/'))) return undefined;
  return Object.hasOwn(backup.files, rel) ? backup.files[rel] : null;
}
export function restoreFile(folder: string, file: string, saved: FileBackup, bytes?: Buffer) {
  const full = filePath(folder, file);
  if (saved === null) { try { unlinkSync(full); } catch (e: any) { if (e.code !== 'ENOENT') throw e; } return; }
  mkdirSync(path.dirname(full), { recursive: true });
  // Unique staging names prevent an existing working-tree .tmp file from being overwritten.
  const temp = full + '.polygate-' + randomBytes(8).toString('hex');
  try {
    writeFileAtomic(temp, bytes ?? backupBytes(saved), saved.mode);
    renameSync(temp, full); chmodSync(full, saved.mode);
  } finally { try { unlinkSync(temp); } catch {} }
}
// A bounded line comparison of actual bytes, not the engine's Git-normalized snapshot.
export function byteDiff(file: string, before: Buffer, after: Buffer) {
  if (before.includes(0) || after.includes(0)) return { additions: 0, deletions: 0, patch: 'Binary file changed.' };
  if (before.length + after.length > 2 * 1024 * 1024) return { additions: 0, deletions: 0, patch: 'The file is too large to display a patch. Its exact bytes are backed up.' };
  const old = before.toString('utf8'), next = after.toString('utf8');
  if (old === next) return { additions: 0, deletions: 0, patch: '' };
  const a = old.match(/[^\n]*\n|[^\n]+$/g) || [], b = next.match(/[^\n]*\n|[^\n]+$/g) || [];
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const x = a.slice(start, a.length - end), y = b.slice(start, b.length - end);
  const rows = x.length + 1, cols = y.length + 1;
  const lcs = rows * cols <= 1_000_000 ? new Uint32Array(rows * cols) : undefined;
  if (lcs) for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i * cols + j] = x[i] === y[j] ? 1 + lcs[(i + 1) * cols + j + 1] : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
  const lines = a.slice(Math.max(0, start - 3), start).map(l => ' ' + l);
  let i = 0, j = 0, additions = 0, deletions = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { lines.push(' ' + x[i++]); j++; }
    else if (j < y.length && (i === x.length || (lcs && lcs[i * cols + j + 1] > lcs[(i + 1) * cols + j]))) { lines.push('+' + y[j++]); additions++; }
    else { lines.push('-' + x[i++]); deletions++; }
  }
  lines.push(...a.slice(a.length - end, a.length - end + Math.min(end, 3)).map(l => ' ' + l));
  const oldCount = x.length + Math.min(start, 3) + Math.min(end, 3), newCount = y.length + Math.min(start, 3) + Math.min(end, 3);
  return { additions, deletions, patch: (`--- a/${file}\n+++ b/${file}\n@@ -${oldCount ? Math.max(0, start - 3) + 1 : 0},${oldCount} +${newCount ? Math.max(0, start - 3) + 1 : 0},${newCount} @@\n` + lines.map(l => l.endsWith('\n') ? l : l + '\n\\ No newline at end of file\n').join('')).slice(0, 200000) };
}
