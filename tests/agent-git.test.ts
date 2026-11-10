import {test,expect,afterAll} from 'bun:test';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {gitStatus,inspectGit} from '../backend/agent-git';
const folder=mkdtempSync(path.join(tmpdir(),'pg-git-panel-'));
afterAll(()=>rmSync(folder,{recursive:true,force:true}));
const git=(...args:string[])=>execFileSync('git',args,{cwd:folder,encoding:'utf8',windowsHide:true});
const put=(file:string,text:string)=>writeFileSync(path.join(folder,file),text);

test('NUL Git status handles spaces, unicode, rename ordering and branch headers',()=>{
  expect(gitStatus('## main...origin/main\0 M file with spaces.txt\0R  new.txt\0old.txt\0?? فارسی.txt\0')).toEqual({branch:'main...origin/main',files:[{file:'file with spaces.txt',index:' ',worktree:'M'},{file:'new.txt',from:'old.txt',index:'R',worktree:' '},{file:'فارسی.txt',index:'?',worktree:'?'}]});
});
test('inspection does not initialize non-Git folders',async()=>{
  expect(await inspectGit(folder)).toEqual({repository:false});
});
test('Git inspection distinguishes staged, working and untracked changes and leaves index/files unchanged',async()=>{
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.test');git('config','core.autocrlf','false');
  put('a.txt','before\n');mkdirSync(path.join(folder,'nested'));put('nested/b.txt','base\n');git('add','.');git('commit','-qm','Initial fixture');
  put('a.txt','staged\n');git('add','a.txt');put('a.txt','working\n');put('untracked.txt','not opened');put('nested/b.txt','nested change\n');
  const before=readFileSync(path.join(folder,'.git/index'));
  const state=await inspectGit(folder);expect(state.repository).toBe(true);
  expect('files' in state&&state.files).toContainEqual({file:'a.txt',index:'M',worktree:'M'});
  expect('files' in state&&state.files).toContainEqual({file:'untracked.txt',index:'?',worktree:'?'});
  expect('commits' in state&&state.commits[0].subject).toBe('Initial fixture');
  const patch=await inspectGit(folder,'a.txt');expect('staged' in patch&&patch.staged).toContain('+staged');expect('worktree' in patch&&patch.worktree).toContain('+working');
  const nested=await inspectGit(path.join(folder,'nested'));expect('files' in nested&&nested.files).toEqual([{file:'b.txt',index:' ',worktree:'M'}]);
  const nestedPatch=await inspectGit(path.join(folder,'nested'),'b.txt');expect('worktree' in nestedPatch&&nestedPatch.worktree).toContain('+nested change');
  expect(readFileSync(path.join(folder,'.git/index'))).toEqual(before);expect(readFileSync(path.join(folder,'a.txt'),'utf8')).toBe('working\n');
});
test('inspection rejects outside paths and uses literal pathspecs rather than Git magic',async()=>{
  await expect(inspectGit(folder,'../outside')).rejects.toThrow(/inside/);
  await expect(inspectGit(folder,path.join(folder,'a.txt'))).rejects.toThrow(/inside/);
  const patch=await inspectGit(folder,':(glob)*');expect('worktree' in patch&&patch.worktree).toBe('');
});
test('unborn repositories can report files with no commit history',async()=>{
  const empty=path.join(folder,'unborn');mkdirSync(empty);execFileSync('git',['init','-q'],{cwd:empty});writeFileSync(path.join(empty,'new.txt'),'new');
  const state=await inspectGit(empty);expect(state.repository).toBe(true);expect('commits' in state&&state.commits).toEqual([]);
});

test('external diff and file monitor helpers stay disabled, and clean filters do not inherit gateway credentials',async()=>{
  const external=path.join(folder,'external.js'),marker=path.join(folder,'external-ran');
  writeFileSync(external,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');`);
  const command=`"${process.execPath.replace(/\\/g,'/')}" "${external.replace(/\\/g,'/')}"`;
  git('config','diff.external',command);git('config','core.fsmonitor',command);
  await inspectGit(folder,'a.txt');expect(existsSync(marker)).toBe(false);
  git('config','--unset','diff.external');git('config','--unset','core.fsmonitor');
  const filter=path.join(folder,'filter.js'),report=path.join(folder,'filter-env.json');
  writeFileSync(filter,`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({agent:!!process.env.POLYGATE_AGENT_KEY,admin:!!process.env.POLYGATE_ADMIN_TOKEN,provider:!!process.env.PROVIDER_API_KEY}));process.stdout.write(fs.readFileSync(0));`);
  git('config','filter.panel-test.clean',`"${process.execPath.replace(/\\/g,'/')}" "${filter.replace(/\\/g,'/')}"`);
  put('.gitattributes','a.txt filter=panel-test\n');
  const old=process.env.PROVIDER_API_KEY;process.env.PROVIDER_API_KEY='fixture-only-value';
  try{await inspectGit(folder,'a.txt');expect(JSON.parse(readFileSync(report,'utf8'))).toEqual({agent:false,admin:false,provider:false});}
  finally{if(old===undefined)delete process.env.PROVIDER_API_KEY;else process.env.PROVIDER_API_KEY=old;}
});
