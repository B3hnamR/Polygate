import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { enginePaths } from './agent-engine';
import { writeFileAtomic } from './state';

export type ProjectRule = { id: string; action: string; resources: string[]; effect: 'allow' | 'deny'; created: number };
export type PermissionMode = 'ask' | 'accept-edits' | 'plan' | 'rules' | 'full';
// These literal commands bypass PowerShell aliases and turn off repository-configured executable helpers. Other forms ask.
export function inspectionCommands(git: string | null = Bun.which('git')) {
  if (!git || !path.win32.isAbsolute(git) && !path.isAbsolute(git)) return [];
  const exe = `& '${git.replace(/'/g, "''")}'`;
  const base = `${exe} --no-pager -c core.fsmonitor=false -c core.hooksPath=NUL -c core.pager=cat -c diff.external= -c interactive.diffFilter= -c log.showSignature=false`;
  // Working-tree status/diff can execute clean filters even with external diff disabled. Only inspect index/history automatically.
  return [`${base} ls-files --cached --`,
    `${base} diff --cached --no-ext-diff --no-textconv --ignore-submodules=all --`,
    `${base} log -n 10 --format=oneline --no-show-signature --no-decorate`];
}
const ruleFile = (folder: string, root = enginePaths().root) => path.join(root, 'rules', createHash('sha256').update(path.resolve(folder).replace(/\\/g, '/').toLowerCase()).digest('hex') + '.json');
export function projectRules(folder: string, root?: string): ProjectRule[] {
  try {
    const rules = JSON.parse(readFileSync(ruleFile(folder, root), 'utf8'));
    if (!Array.isArray(rules)) throw new Error('Invalid project rules');
    if (rules.length > 200 || rules.some(r => typeof r?.id !== 'string' || typeof r.action !== 'string' || !['allow', 'deny'].includes(r.effect) || !Array.isArray(r.resources) || !r.resources.length || r.resources.some((x: unknown) => typeof x !== 'string' || !x || x.length > 10000))) throw new Error('Invalid project rules');
    return rules;
  } catch (e: any) { if (e.code === 'ENOENT') return []; throw new Error('Project approval rules could not be read. Repair or remove the rules file before running this session.'); }
}
export function saveProjectRule(folder: string, action: string, resources: string[], effect: 'allow' | 'deny', root?: string) {
  if (!['shell', 'edit', 'read', 'webfetch', 'websearch', 'external_directory', 'subagent'].includes(action) || !resources.length || resources.length > 100 || resources.some(r => !r || r.length > 10000) || !['allow', 'deny'].includes(effect)) throw new Error('This request cannot be saved as a project rule.');
  const rule: ProjectRule = { id: randomBytes(12).toString('hex'), action, resources: [...resources], effect, created: Date.now() };
  const rules = projectRules(folder, root).filter(r => r.action !== action || JSON.stringify(r.resources) !== JSON.stringify(resources));
  if (rules.length >= 200) throw new Error('Remove a project rule before saving another (limit 200).');
  const file = ruleFile(folder, root); mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify([...rules, rule])); return rule;
}
export function removeProjectRule(folder: string, id: string, root?: string) {
  const rules = projectRules(folder, root).filter(r => r.id !== id), file = ruleFile(folder, root);
  mkdirSync(path.dirname(file), { recursive: true }); writeFileAtomic(file, JSON.stringify(rules));
}
export function permissionDecision(mode: PermissionMode, action: string, resources: string[], rules: ProjectRule[], inspections: string[] = inspectionCommands()): 'allow' | 'ask' | 'deny' {
  if (mode === 'plan' && (['shell', 'edit', 'subagent'].includes(action) || action.startsWith('polygate_shared_'))) return 'deny';
  // Code Mode is an isolated orchestration wrapper, not a shell. Each invoked leaf checks its own permissions.
  if (action === 'execute') return 'allow';
  if (mode === 'full') return 'allow';
  if (!resources.length) return 'ask';
  if (mode === 'rules' && action === 'shell' && resources.some(command =>
    /\b(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*\s-(?:enc(?:odedcommand)?|e|ec)\b/i.test(command) ||
    /(?:^|[\s;&|])(?:diskpart|format(?:\.com)?|bcdedit|reg(?:\.exe)?|regedit|cmdkey|vaultcmd)\b/i.test(command) ||
    /\b(?:curl|wget|Invoke-WebRequest|irm|iwr)\b[^\r\n]*\|\s*(?:sh|bash|pwsh|powershell|iex|Invoke-Expression)\b/i.test(command) ||
    /\b(?:Remove-Item|rm|rmdir|rd)\b[^\r\n]*(?:-r(?:ecurse)?\b|-rf\b|\/s\b)/i.test(command))) return 'deny';
  const exact = [...rules].reverse().find(r => r.action === action && JSON.stringify(r.resources) === JSON.stringify(resources));
  if (exact) return exact.effect;
  if (mode === 'rules' && action === 'shell' && resources.every(r => inspections.includes(r))) return 'allow';
  return 'ask';
}
