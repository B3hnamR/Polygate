import {afterAll,test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {projectPreferences,projectSources,readProjectSource,saveProjectPreferences} from '../backend/agent-project';
const root=mkdtempSync(path.join(tmpdir(),'pg-project-')),folder=path.join(root,'project');mkdirSync(folder);
afterAll(()=>rmSync(root,{recursive:true,force:true}));
test('project preferences persist independently of repository files and reject stale updates',()=>{
  const original=projectPreferences(folder,root);expect(original.instructions).toBe('');
  const saved=saveProjectPreferences(folder,{...original,instructions:'Use the project test runner.',templates:[{kind:'command',name:'Review',text:'Review changes. Never run $(shell) or !`commands` automatically.'}]},root);
  expect(projectPreferences(folder,root)).toEqual(saved);expect(saved.templates[0].id).toBeTruthy();
  expect(()=>saveProjectPreferences(folder,{...original,instructions:'stale',templates:[]},root)).toThrow(/changed/);
  expect(()=>saveProjectPreferences(folder,{...saved,instructions:'x'.repeat(32001)},root)).toThrow(/32,000/);
  expect(()=>saveProjectPreferences(folder,{...saved,templates:[...saved.templates,...saved.templates]},root)).toThrow(/unique/);
});
test('source imports preview only reviewed markdown and detect changed content; configuration and scripts stay excluded',()=>{
  mkdirSync(path.join(folder,'.agents/skills/review'),{recursive:true});mkdirSync(path.join(folder,'.opencode/commands'),{recursive:true});
  writeFileSync(path.join(folder,'AGENTS.md'),'Project guidance');writeFileSync(path.join(folder,'opencode.json'),'{}');
  writeFileSync(path.join(folder,'.agents/skills/review/SKILL.md'),'Skill text');writeFileSync(path.join(folder,'.opencode/commands/review.md'),'Review text');writeFileSync(path.join(folder,'.opencode/run.js'),'throw Error("not executed")');
  const sources=projectSources(folder);expect(sources.map(s=>s.path)).toEqual(['.agents/skills/review/SKILL.md','.opencode/commands/review.md','AGENTS.md']);
  const source=sources.find(s=>s.path==='AGENTS.md')!;
  expect(readProjectSource(folder,source.path,source.hash).text).toBe('Project guidance');expect(readFileSync(path.join(folder,'opencode.json'),'utf8')).toBe('{}');
  writeFileSync(path.join(folder,'AGENTS.md'),'Changed guidance');expect(()=>readProjectSource(folder,source.path,source.hash)).toThrow(/changed/);
  expect(()=>readProjectSource(folder,'../outside','any')).toThrow(/inventory/);
});
