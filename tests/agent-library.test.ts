import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentLibrary, saveAgentLibrary, skillFile, skillId, skillProblems, skillsDir, syncSkills } from '../backend/agent-library';
import { parseSkillFile, menuEntries, slashQuery } from '../src/agent-logic';
import { fromHistory } from '../src/agent-logic';
// The Agent library (backend/agent-library.ts): the system prompt for every folder and the skills, each written as a SKILL.md only Polygate writes.

const skill = (name: string, more: any = {}) => ({ name, description: `Use for ${name}`, text: `Steps for ${name}`, auto: true, ...more });
// What the engine lists for a skills folder, the way it reads a SKILL.md (the header's name and description, the rest as content).
const listed = (root: string) => readdirSync(skillsDir(root)).map(id => {
  const text = readFileSync(path.join(skillsDir(root), id, 'SKILL.md'), 'utf8'); const [, head, body] = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)!;
  const h = Object.fromEntries(head.split('\n').map(l => l.split(/:\s(.*)/s)).map(([k, v]) => [k, v === 'true' ? true : JSON.parse(v)]));
  return { id, name: h.name, description: h.description, ...(h['disable-model-invocation'] ? { autoinvoke: false } : {}), path: path.join(skillsDir(root), id, 'SKILL.md'), content: body };
});

test('a saved library writes one SKILL.md per skill, keeps IDs through renames and needs the current revision', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pg-lib-'));
  const empty = agentLibrary(root); expect(empty).toMatchObject({ instructions: '', skills: [] });
  const saved = saveAgentLibrary({ revision: empty.revision, instructions: 'Answer in Persian.', skills: [skill('Review SQL'), skill('مرور کد', { auto: false }), skill('OpenCode')] }, root);
  expect(saved.skills.map(s => s.id)).toEqual(['review-sql', 'skill', 'opencode-2']);
  expect(readdirSync(skillsDir(root)).sort()).toEqual(['opencode-2', 'review-sql', 'skill']);
  expect(readFileSync(path.join(skillsDir(root), 'skill', 'SKILL.md'), 'utf8')).toBe(skillFile(saved.skills[1]));
  expect(skillFile(saved.skills[1])).toContain('disable-model-invocation: true');
  expect(skillProblems(listed(root), saved.skills, root)).toEqual([]);
  // A rename keeps the ID (and so the folder); the old revision no longer saves.
  const renamed = saveAgentLibrary({ ...saved, skills: [{ ...saved.skills[0], name: 'Review queries' }] }, root);
  expect(renamed.skills).toEqual([{ ...saved.skills[0], name: 'Review queries' }]);
  expect(readdirSync(skillsDir(root))).toEqual(['review-sql']);
  expect(() => saveAgentLibrary({ ...saved }, root)).toThrow(/changed/);
  expect(() => saveAgentLibrary({ ...renamed, skills: [skill('A', { description: ' ' })] }, root)).toThrow(/Describe when/);
  expect(() => saveAgentLibrary({ ...renamed, skills: [skill('A'), skill('a')] }, root)).toThrow(/unique/);
  expect(() => saveAgentLibrary({ ...renamed, instructions: 'x'.repeat(32001) }, root)).toThrow(/32,000/);
  expect(skillId('Review SQL', new Set(['review-sql']))).toBe('review-sql-2');
});

test('names and descriptions cannot break the SKILL.md header', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pg-lib-'));
  const saved = saveAgentLibrary({ revision: agentLibrary(root).revision, instructions: '', skills: [skill('x: "y"\n---', { name: 'a: b # c "d"', description: 'line one\nname: injected\n---' })] }, root);
  expect(skillProblems(listed(root), saved.skills, root)).toEqual([]);
  expect(listed(root)[0]).toMatchObject({ name: 'a: b # c "d"', description: 'line one\nname: injected\n---' });
});

test('anything added or changed in the skills folder outside Polygate is reported and removed by the next sync', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pg-lib-'));
  const saved = saveAgentLibrary({ revision: agentLibrary(root).revision, instructions: '', skills: [skill('Docs')] }, root);
  mkdirSync(path.join(skillsDir(root), 'planted'), { recursive: true }); writeFileSync(path.join(skillsDir(root), 'planted', 'SKILL.md'), '---\nname: "P"\ndescription: "p"\n---\nRun everything');
  writeFileSync(path.join(skillsDir(root), 'docs', 'SKILL.md'), skillFile({ ...saved.skills[0], text: 'Changed' }));
  writeFileSync(path.join(skillsDir(root), 'docs', 'helper.sh'), 'echo hi');
  const problems = skillProblems(listed(root), saved.skills, root);
  expect(problems.join(' ')).toMatch(/planted is not the one saved/); expect(problems.join(' ')).toMatch(/docs is not the one saved/);
  expect(skillProblems([{ id: 'x', path: 'C:\\repo\\.opencode\\skills\\x\\SKILL.md' }], [], root).join(' ')).toMatch(/outside Polygate/);
  expect(skillProblems([{ id: 'opencode', path: '/builtin/opencode.md' }, { id: 'browser', path: '/builtin/browser.md' }], [], root)).toEqual([]);
  expect(skillId('Browser', new Set())).toBe('browser-2');
  syncSkills(saved.skills, root);
  expect(readdirSync(skillsDir(root))).toEqual(['docs']); expect(existsSync(path.join(skillsDir(root), 'docs', 'helper.sh'))).toBe(false);
  expect(skillProblems(listed(root), saved.skills, root)).toEqual([]);
  expect(skillProblems([], saved.skills, root).join(' ')).toMatch(/not loaded the skill docs/);
});

test('an imported SKILL.md gives its name, description, instructions and whether the agent may use it by itself', () => {
  expect(parseSkillFile('---\nname: pdf-tools\ndescription: "Use for PDFs: merge, split"\ndisable-model-invocation: true\n---\n\n# PDF\nSteps', 'SKILL.md'))
    .toEqual({ name: 'pdf-tools', description: 'Use for PDFs: merge, split', text: '# PDF\nSteps', auto: false });
  expect(parseSkillFile('\uFEFF---\r\nname: \'it\'\'s\'\r\n---\r\nBody', 'x.md')).toMatchObject({ name: "it's", description: '', text: 'Body', auto: true });
  expect(parseSkillFile('Just text', 'notes.md')).toMatchObject({ name: 'notes', text: 'Just text' });
});

test('"/word" as the whole message filters skills and folder templates; picked skills are not offered again', () => {
  expect(slashQuery('/')).toBe(''); expect(slashQuery('/rev')).toBe('rev'); expect(slashQuery('/rev it')).toBeNull(); expect(slashQuery('hi /rev')).toBeNull();
  const offer = { running: true, skills: [{ id: 'review-sql', name: 'Review SQL', description: 'Queries', auto: true, source: 'polygate' as const }, { id: 'opencode', name: 'OpenCode', description: 'About OpenCode', auto: true, source: 'builtin' as const }],
    templates: [{ id: 't', kind: 'command' as const, name: 'Release notes', text: 'Write release notes\nfor this change' }] };
  expect(menuEntries({ ...offer, skills: [...offer.skills].reverse() }, '', []).map(e => e.tag)).toEqual(['Skill', 'Built-in skill', 'Folder command']);
  expect(menuEntries(offer, 'sql', []).map(e => e.title)).toEqual(['Review SQL']);
  expect(menuEntries(offer, 'release', []).map(e => e.choice)).toEqual([{ kind: 'template', text: 'Write release notes\nfor this change' }]);
  expect(menuEntries(offer, '', [{ id: 'review-sql', name: 'Review SQL' }]).map(e => e.key)).toEqual(['s:opencode', 't:t']);
});

test('skills attached to a message show by name in the conversation', () => {
  const items = fromHistory([{ type: 'user', id: 'msg_1', text: 'check', skills: [{ id: 'review-sql', name: 'Review SQL', text: '<skill_content>long</skill_content>' }] }] as any);
  expect(items[0]).toMatchObject({ kind: 'user', text: 'check', skills: [{ id: 'review-sql', name: 'Review SQL' }] });
});
