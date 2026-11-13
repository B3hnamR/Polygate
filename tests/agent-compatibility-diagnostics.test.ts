import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ENGINE_PACKAGES, ENGINE_VERSION, freeIdentityProblem, isBuiltinEngineSkill } from '../backend/agent-engine';
import { skillProblems } from '../backend/agent-library';

test('real 2.3.0 built-in skill URIs are recognized without accepting arbitrary skill paths', () => {
  for (const id of ['opencode', 'report', 'browser']) {
    expect(isBuiltinEngineSkill({ id, path: `skill://${id}/SKILL.md` })).toBe(true);
    expect(isBuiltinEngineSkill({ id, path: `/builtin/${id}.md` })).toBe(true);
  }
  for (const skill of [
    {id:'foreign',path:'skill://foreign/SKILL.md'},
    {id:'opencode',path:'skill://foreign/SKILL.md'},
    {id:'opencode',path:'skill://opencode/SKILL.md/extra'},
    {id:'opencode',path:'/builtin/foreign.md'},
    {id:'opencode',path:'C:\\foreign\\opencode\\SKILL.md'},
  ]) expect(isBuiltinEngineSkill(skill)).toBe(false);
  expect(skillProblems([{id:'opencode',path:'skill://opencode/SKILL.md'}],[])).toEqual([]);
  expect(skillProblems([{id:'foreign',path:'skill://foreign/SKILL.md'}],[])).toHaveLength(1);
});

test('the pinned Agent engine matches the verified current bridge release and registry packages', () => {
  expect(ENGINE_VERSION).toBe('2.3.0');
  expect(freeIdentityProblem('2.3.0')).toBe('');
  expect(freeIdentityProblem('2.2.6')).toContain('compatibility check');
  expect(ENGINE_PACKAGES.x64.integrity).toBe('sha512-0wnPu8aCczjN82X6qK+XmMFiheyvOnBXRsb+hkyTWaeG6WlIeN9cM6J7vKnj741juyIE7q57SmRSRVPWUmun/g==');
  expect(ENGINE_PACKAGES.arm64.integrity).toBe('sha512-dqOtQicdmaKxyA8fSBYysegVl0QrlHYWXy/D/ocgZvGa0bNGi+9KR6N1Za9BCkOu/q7gemroXliMS+aBREhShA==');
});

test('Agent compatibility explains the local version block without claiming an upstream minimum', () => {
  expect(freeIdentityProblem(ENGINE_VERSION)).toBe('');
  expect(freeIdentityProblem('')).toBe('');
  const reason = freeIdentityProblem('9.9.9');
  expect(reason).toContain('compatibility check');
  expect(reason).toContain('9.9.9');
  expect(reason).toContain(ENGINE_VERSION);
  expect(reason).toContain('Resync models does not change engine versions');
  expect(reason).not.toContain('now expects');
});

test('disabled Agent models display their blocking reason instead of relying only on tooltips', () => {
  const source = readFileSync(new URL('../src/agent.tsx', import.meta.url), 'utf8');
  expect(source).toContain('!m.usable&&m.reason&&<small');
  expect(source).toContain('whiteSpace:\'normal\'');
  expect(source).toContain('Resync models does not update the engine');
});
