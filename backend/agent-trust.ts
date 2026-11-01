import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { enginePaths } from './agent-engine';
import { writeFileAtomic } from './state';

type TrustFile = { path: string; behavior: 'disabled' | 'instructions'; hash: string; bytes: number };
const digest = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const canonical = (folder: string) => realpathSync(folder);
const trustFile = (folder: string, root = enginePaths().root) => path.join(root, 'trust', digest(canonical(folder).replace(/\\/g, '/').toLowerCase()) + '.json');
const ROOT_FILES = ['opencode.json', 'opencode.jsonc', 'AGENTS.md', 'CLAUDE.md'];
const DIRS = ['.opencode', '.claude', '.agents'];
// Inventory only. Project plugins/configuration remain disabled even after consent; no project code is loaded by this inspection.
export function inspectTrust(folder: string, root?: string) {
  folder = canonical(folder);
  const files: TrustFile[] = [], problems: string[] = [];
  let count = 0, bytes = 0;
  const inspect = (full: string, depth: number) => {
    const rel = path.relative(folder, full).replace(/\\/g, '/');
    try {
      const st = lstatSync(full);
      if (st.isSymbolicLink()) { problems.push(`${rel}: links and junctions are not inspected.`); return; }
      if (++count > 500 || depth > 8) { if (!problems.includes('Project customization inventory is too large.')) problems.push('Project customization inventory is too large.'); return; }
      if (st.isDirectory()) { for (const entry of readdirSync(full).sort()) { if (count > 500) break; inspect(path.join(full, entry), depth + 1); } return; }
      if (!st.isFile() || st.size > 1024 * 1024 || bytes + st.size > 4 * 1024 * 1024) { problems.push(`${rel}: cannot inspect this customization file within the size limit.`); return; }
      const content = readFileSync(full); bytes += content.length;
      files.push({ path: rel, behavior: /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/i.test(rel) ? 'instructions' : 'disabled', hash: digest(content), bytes: content.length });
    } catch (e: any) { if (e.code !== 'ENOENT') problems.push(`${rel}: could not inspect it.`); }
  };
  for (const file of [...ROOT_FILES, ...DIRS]) inspect(path.join(folder, file), 0);
  // Parent instructions can affect a nested working folder too. Inventory them without scanning unrelated parent directories.
  for (let parent = path.dirname(folder); parent !== path.dirname(parent); parent = path.dirname(parent)) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) inspect(path.join(parent, name), 0);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const fingerprint = digest(JSON.stringify({ folder, files, problems }));
  let trusted = false, acceptedAt = 0;
  try { const saved = JSON.parse(readFileSync(trustFile(folder, root), 'utf8')); trusted = !problems.length && saved.folder === folder && saved.fingerprint === fingerprint; acceptedAt = trusted ? saved.acceptedAt : 0; } catch {}
  return { folder, fingerprint, trusted, acceptedAt, complete: !problems.length, files, problems };
}
export function grantTrust(folder: string, fingerprint: string, root?: string) {
  const report = inspectTrust(folder, root);
  if (!report.complete) throw new Error('Cannot inspect all project customization. Remove the linked, unreadable or oversized customization before trusting this folder.');
  if (report.fingerprint !== fingerprint) throw new Error('Project customization changed since review. Review it again before allowing this folder.');
  const file = trustFile(folder, root); mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify({ folder: report.folder, fingerprint, acceptedAt: Date.now() }));
  return inspectTrust(folder, root);
}
export function revokeTrust(folder: string, root?: string) {
  const file = trustFile(folder, root); mkdirSync(path.dirname(file), { recursive: true }); writeFileAtomic(file, '{}');
}
