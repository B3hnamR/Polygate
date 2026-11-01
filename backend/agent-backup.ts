import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import { lstat, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { enginePaths } from './agent-engine';
import { writeFileAtomic } from './state';

type SavedFile = { hash: string; mode: number };
export type FileBackup = SavedFile | null;
// limited: the folder is bigger than one backup covers, so the limits below left files out (not only skipped folders and links).
export type Backup = { files: Record<string, SavedFile>; excluded: string[]; limited?: boolean };
// A file as the last backup of its folder saw it: the same size and times mean its saved copy is still exact, so it is not read again.
type Seen = SavedFile & { size: number; mtimeMs: number; ctimeMs: number };
let MAX_BYTES = 256 * 1024 * 1024, MAX_FILES = 20000;
const MAX_FILE = 8 * 1024 * 1024;
// For tests: smaller limits, so a folder cut short can be built from a few files.
export function __setBackupLimits(files = 20000, bytes = 256 * 1024 * 1024) { MAX_FILES = files; MAX_BYTES = bytes; }
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv']);
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const store = () => path.join(enginePaths().root, 'backups');
const blob = (hash: string) => {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid agent backup checksum.');
  return path.join(store(), hash);
};
// A saved copy used again gets a fresh time: pruning spares recent copies, so it cannot remove one before the record that needs it is written.
const touch = (dest: string) => { try { const now = new Date(); utimesSync(dest, now, now); } catch { /* best effort */ } };
export function saveBytes(bytes: Buffer) {
  const hash = digest(bytes), dest = blob(hash);
  mkdirSync(store(), { recursive: true });
  if (!existsSync(dest)) writeFileAtomic(dest, bytes); else touch(dest);
  return hash;
}
async function saveBytesAsync(bytes: Buffer) {
  const hash = digest(bytes), dest = blob(hash);
  if (existsSync(dest)) { touch(dest); return hash; }
  mkdirSync(store(), { recursive: true });
  // Not flushed to disk one by one (thousands of copies): a copy cut short by a power loss fails its checksum and is never restored.
  const temp = `${dest}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, bytes, { mode: 0o600 });
  try { await rename(temp, dest); } catch (e) { await rm(temp, { force: true }); if (!existsSync(dest)) throw e; }
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
// The last backup of each folder stays on disk: the next one reads only the files that changed since, and pruning keeps its copies.
const KEEP_BASELINES = 5;
const baselineDir = () => path.join(enginePaths().root, 'baselines');
const baselineFile = (folder: string) => path.join(baselineDir(), digest(path.resolve(folder).replace(/\\/g, '/').toLowerCase()) + '.json');
function baseline(folder: string): Record<string, Seen> {
  try {
    const saved = JSON.parse(readFileSync(baselineFile(folder), 'utf8'));
    if (saved?.folder === path.resolve(folder) && saved.files && typeof saved.files === 'object') return saved.files;
  } catch { /* none yet, or unreadable: every file is read again */ }
  return Object.create(null);
}
// Backups running now: pruning does not run meanwhile, so a copy a backup is about to reuse is never removed.
let capturing = 0;
// Does not hold up the gateway: reads and writes are asynchronous (up to 16 files of a folder at once), and files unchanged since the last
// backup are not read. Folders are taken one at a time, depth first, so a folder too big for the limits is covered project by project.
export async function captureBackup(folder: string): Promise<Backup> {
  const files: Backup['files'] = Object.create(null), seen: Record<string, Seen> = Object.create(null), excluded: string[] = [], last = baseline(folder);
  let bytes = 0, count = 0, limited = false;
  const atLimit = () => count >= MAX_FILES || bytes >= MAX_BYTES;
  // File checks that finish one after another can keep the event loop from timers (and the gateway's own work) for over a second: after
  // every 20 ms of work the backup waits a moment, so other work goes first.
  let worked = performance.now();
  const breathe = async () => { if (performance.now() - worked > 20) { await Bun.sleep(1); worked = performance.now(); } };
  const file = async (full: string, rel: string) => {
    try {
      const st = await lstat(full);
      // The limits are claimed in one step, between awaits, so parallel reads cannot overshoot them.
      if (++count > MAX_FILES) { excluded.push(rel); limited = true; return; }
      if (st.size > MAX_FILE || bytes + st.size > MAX_BYTES) { excluded.push(rel); limited = true; return; }
      bytes += st.size;
      const mode = st.mode & 0o777, old = last[rel];
      let hash: string;
      if (old && old.size === st.size && old.mtimeMs === st.mtimeMs && old.ctimeMs === st.ctimeMs && /^[a-f0-9]{64}$/.test(old.hash) && existsSync(blob(old.hash))) hash = old.hash;
      else {
        const content = await readFile(full); bytes += content.length - st.size;
        if (content.length > MAX_FILE || bytes > MAX_BYTES) { excluded.push(rel); limited = true; return; }
        hash = await saveBytesAsync(content);
      }
      files[rel] = { hash, mode }; seen[rel] = { hash, mode, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
    } catch { excluded.push(rel); }
  };
  const relOf = (full: string) => path.relative(folder, full).replace(/\\/g, '/');
  // A folder the limits cut short is excluded as a whole: what it holds beyond the files already saved is unknown (never "did not exist").
  const visit = async (dir: string): Promise<void> => {
    await breathe();
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { excluded.push(relOf(dir)); return; }
    const found: string[] = [], dirs: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (entry.isDirectory() && SKIP.has(entry.name)) || !entry.isDirectory() && !entry.isFile()) excluded.push(relOf(path.join(dir, entry.name)));
      else (entry.isDirectory() ? dirs : found).push(path.join(dir, entry.name));
    }
    for (let i = 0; i < found.length; i += 16) {
      if (atLimit()) { excluded.push(relOf(dir)); limited = true; return; }
      await Promise.all(found.slice(i, i + 16).map(f => file(f, relOf(f))));
      await breathe();
    }
    for (const f of dirs) {
      if (atLimit()) { excluded.push(relOf(dir)); limited = true; return; }
      await visit(f);
    }
  };
  capturing++;
  try { await visit(folder); }
  finally { capturing--; }
  try { mkdirSync(baselineDir(), { recursive: true }); writeFileAtomic(baselineFile(folder), JSON.stringify({ folder: path.resolve(folder), files: seen })); } catch { /* the next backup reads every file again */ }
  return { files, excluded, ...(limited ? { limited } : {}) };
}
// Removes saved copies nothing refers to any more: not in a folder's last backup, a turn's record or a backup waiting for its turn (`refs`,
// from agent.ts). Copies saved or used in the last hour are spared, so one being recorded right now is never lost. refs is null when a record
// could not be read; then nothing is removed.
let pruning = false;
export async function pruneBackups(refs: Set<string> | null, now = Date.now()) {
  if (!refs || pruning || capturing) return 0;
  pruning = true;
  try {
    const keep = new Set(refs);
    let names: string[] = [];
    try { names = readdirSync(baselineDir()).filter(n => n.endsWith('.json')); } catch (e: any) { if (e.code !== 'ENOENT') return 0; }
    const dated = names.map(n => { const f = path.join(baselineDir(), n); try { return { f, t: statSync(f).mtimeMs }; } catch { return { f, t: 0 }; } }).sort((a, b) => b.t - a.t);
    for (const { f } of dated.slice(KEEP_BASELINES)) { try { unlinkSync(f); } catch { /* removed next time */ } }
    for (const { f } of dated.slice(0, KEEP_BASELINES)) {
      try { for (const s of Object.values<any>(JSON.parse(readFileSync(f, 'utf8')).files || {})) if (typeof s?.hash === 'string') keep.add(s.hash); }
      catch { return 0; }
    }
    let blobs: string[] = [];
    try { blobs = readdirSync(store()); } catch { return 0; }
    let removed = 0;
    for (const name of blobs) {
      if (!/^[a-f0-9]{64}$/.test(name) || keep.has(name)) continue;
      const f = path.join(store(), name);
      try { if (now - statSync(f).mtimeMs < 3600000) continue; unlinkSync(f); removed++; } catch { /* in use or already gone */ }
      if (removed % 200 === 199) await Bun.sleep(0);
    }
    return removed;
  } finally { pruning = false; }
}
export function beforeFile(backup: Backup | undefined, file: string): FileBackup | undefined {
  const rel = file.replace(/\\/g, '/');
  if (!backup || rel.split('/').some(x => SKIP.has(x))) return undefined;
  // A saved file first: a folder the limits cut short is excluded, though the files saved before the cut are exact.
  if (Object.hasOwn(backup.files, rel)) return backup.files[rel];
  return backup.excluded.some(x => !x || rel === x || rel.startsWith(x + '/')) ? undefined : null;
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
