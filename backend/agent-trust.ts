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
const isInstructions = (rel: string) => /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/i.test(rel);
const MORE = 'More customization files than are listed; the rest are not loaded either.';
// Consent is per folder, asked once, like other coding agents' "trust this folder": what the folder holds does not block it, and a later
// change does not take it back (Revoke in Agent settings does). The inventory shows what the agent reads there and feeds the Project tab's
// imports. Only instruction files reach the agent: the engine runs with project configuration, Claude Code files and project skills
// switched off whether or not a folder is trusted (agent-engine.ts engineEnv). Links are never followed and large files never read.
export function inspectTrust(folder: string, root?: string) {
  folder = canonical(folder);
  const files: TrustFile[] = [], problems: string[] = [], skipped: string[] = [];
  let count = 0, bytes = 0;
  // problems: instruction files that could not be read in full. They are shown, never blocking.
  const note = (rel: string, why: string) => (isInstructions(rel) ? problems : skipped).push(`${rel}: ${why}`);
  const inspect = (full: string, depth: number) => {
    const rel = path.relative(folder, full).replace(/\\/g, '/');
    try {
      const st = lstatSync(full);
      if (st.isSymbolicLink()) { note(rel, 'a link or junction, not followed.'); return; }
      if (++count > 500 || depth > 8) { if (!skipped.includes(MORE)) skipped.push(MORE); return; }
      if (st.isDirectory()) { for (const entry of readdirSync(full).sort()) { if (count > 500) break; inspect(path.join(full, entry), depth + 1); } return; }
      if (!st.isFile() || st.size > 1024 * 1024 || bytes + st.size > 4 * 1024 * 1024) { note(rel, 'too large to inspect.'); return; }
      const content = readFileSync(full); bytes += content.length;
      files.push({ path: rel, behavior: isInstructions(rel) ? 'instructions' : 'disabled', hash: digest(content), bytes: content.length });
    } catch (e: any) { if (e.code !== 'ENOENT') note(rel, 'could not be read.'); }
  };
  // Instruction files first, so a large customization folder can never push them past the inventory's limits.
  for (const file of ROOT_FILES) inspect(path.join(folder, file), 0);
  // Parent instructions can affect a nested working folder too. Inventory them without scanning unrelated parent directories.
  for (let parent = path.dirname(folder); parent !== path.dirname(parent); parent = path.dirname(parent)) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) inspect(path.join(parent, name), 0);
  }
  for (const dir of DIRS) inspect(path.join(folder, dir), 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const fingerprint = digest(JSON.stringify({ folder, files, problems, skipped }));
  let trusted = false, acceptedAt = 0;
  try { const saved = JSON.parse(readFileSync(trustFile(folder, root), 'utf8')); trusted = saved.folder === folder; acceptedAt = trusted ? saved.acceptedAt : 0; } catch {}
  return { folder, fingerprint, trusted, acceptedAt, complete: true, files, problems, skipped };
}
export function grantTrust(folder: string, _fingerprint?: string, root?: string) {
  const report = inspectTrust(folder, root);
  const file = trustFile(folder, root); mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify({ folder: report.folder, acceptedAt: Date.now() }));
  return inspectTrust(folder, root);
}
// Every folder consent was given for (a consent revoked since leaves none): where agent sessions can have been started.
export function trustedFolders(root = enginePaths().root): string[] {
  let names: string[] = [];
  try { names = readdirSync(path.join(root, 'trust')).filter(n => n.endsWith('.json')); } catch { return []; }
  return names.flatMap(n => { try { const f = JSON.parse(readFileSync(path.join(root, 'trust', n), 'utf8')).folder; return typeof f === 'string' && f ? [f] : []; } catch { return []; } });
}
export function revokeTrust(folder: string, root?: string) {
  const file = trustFile(folder, root); mkdirSync(path.dirname(file), { recursive: true }); writeFileAtomic(file, '{}');
}
