import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createElement,Fragment} from 'react';
import {parseSkillFile} from '../src/agent-logic';

const deferred=()=>{let resolve!:(value:any)=>void,reject!:(error:Error)=>void;const promise=new Promise<any>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const nodes=(tree:any):any[]=>Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree,...nodes(tree.props?.children)]:[];
const text=(tree:any):string=>Array.isArray(tree)?tree.map(text).join(''):tree&&typeof tree==='object'?text(tree.props?.children):typeof tree==='string'?tree:'';

function harness(kind:'library'|'project'){
  const slots:any[]=[],effects:(()=>void)[]=[];let at=0,tree:any,writes=0;
  const useState=(initial:any)=>{const i=at++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],(value:any)=>{writes++;slots[i]=typeof value==='function'?value(slots[i]):value;}];};
  const useRef=(value:any)=>{const i=at++;return slots[i]??(slots[i]={current:value});};
  const useEffect=(fn:()=>any,deps:any[])=>{const i=at++,old=slots[i];if(!old||deps.some((d,n)=>!Object.is(d,old.deps[n]))){slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=fn();});}};
  const requests:{path:string;body:any;pending:ReturnType<typeof deferred>}[]=[],confirmations:ReturnType<typeof deferred>[]=[];
  const bindings={createElement,Fragment,useState,useRef,useEffect,parseSkillFile,api:(path:string,body:any)=>{const pending=deferred();requests.push({path,body,pending});return pending.promise;},useConfirm:()=>({dialog:null,confirm:()=>{const pending=deferred();confirmations.push(pending);return pending.promise;}}),Button:'button',BookOpen:()=>null,Check:()=>null,ChevronRight:()=>null,FileUp:()=>null,Plus:()=>null,RefreshCw:()=>null,Search:()=>null,Trash2:()=>null,FileText:()=>null};
  const name=kind==='library'?'AgentLibrarySettings':'AgentProject';
  const source=readFileSync(new URL(`../src/agent-${kind}.tsx`,import.meta.url),'utf8').split('\n').filter(l=>!l.startsWith('import ')).join('\n').replace('export function','function');
  const transpiler=new Bun.Transpiler({loader:'tsx',tsconfig:{compilerOptions:{jsx:'react',jsxFactory:'createElement',jsxFragmentFactory:'Fragment'}}});
  const Component=new Function(...Object.keys(bindings),transpiler.transformSync(source)+`\nreturn ${name};`)(...Object.values(bindings));
  let props:any={busy:false,part:'prompt',id:'A',onInsert:()=>{}};
  const render=(patch:any={})=>{props={...props,...patch};at=0;tree=Component(props);while(effects.length)effects.shift()!();return tree;};
  const find=(predicate:(node:any)=>boolean)=>{const result=nodes(tree).find(predicate);if(!result)throw new Error('Missing fixture control: '+text(tree));return result;};
  const button=(label:string)=>find(n=>n.type==='button'&&text(n)===label);
  render();
  return {render,requests,confirmations,button,find,content:()=>text(tree),writes:()=>writes,
    click:(label:string)=>button(label).props.onClick(),
    edit:(label:string,value:string)=>{find(n=>n.props['aria-label']===label).props.onChange({target:{value}});render();},
    unmount:()=>{for(const s of slots)s?.cleanup?.();},
  };
}
const library=(instructions='base',skills:any[]=[],revision='r1')=>({instructions,skills,revision,builtin:[{id:'builtin',name:'Built in skill',description:'engine'}]});
const project=(instructions='base',templates:any[]=[],revision='r1')=>({instructions,templates,revision,sources:[{path:'AGENTS.md',hash:'hash',bytes:4}]});
const skill=(id='saved',name='Skill')=>({id,name,description:'Description',text:'Instructions',auto:true});
const template=(id='t')=>({id,name:'Command',kind:'command',text:'Text'});
async function loaded(kind:'library'|'project',data:any){const h=harness(kind);h.requests[0].pending.resolve(data);await flush();h.render();return h;}

for(const kind of ['library','project'] as const){
  const label=kind==='library'?'Agent system prompt':'Project instructions',save=kind==='library'?'Save':'Save preferences';
  const result=kind==='library'?library:project;
  test(`${kind}: edits during confirmation and save survive with the new baseline revision`,async()=>{
    const h=await loaded(kind,result());h.edit(label,'submitted');const first=h.click(save);h.click(save);expect(h.confirmations).toHaveLength(1);
    h.edit(label,'during confirm');h.confirmations[0].resolve(true);await flush();expect(h.requests).toHaveLength(2);expect(h.requests[1].body.instructions).toBe('submitted');
    h.edit(label,'during request');h.requests[1].pending.resolve(result('submitted',[],'r2'));await first;h.render();
    expect(h.find(n=>n.props['aria-label']===label).props.value).toBe('during request');expect(h.content()).not.toContain('preferences saved');expect(h.content()).not.toContain(' Saved');
    const second=h.click(save);h.confirmations[1].resolve(true);await flush();expect(h.requests[2].body.revision).toBe('r2');expect(h.requests[2].body.instructions).toBe('during request');
    h.requests[2].pending.resolve(result('during request',[],'r3'));await second;h.render();expect(h.content()).toContain(kind==='library'?'Saved':'Project preferences saved');
  });
  test(`${kind}: away-and-back revisions suppress false saved state, cancellation and errors preserve drafts`,async()=>{
    const h=await loaded(kind,result());h.edit(label,'submitted');const first=h.click(save);h.edit(label,'away');h.edit(label,'submitted');h.confirmations[0].resolve(true);await flush();h.requests[1].pending.resolve(result('submitted',[],'r2'));await first;h.render();
    expect(h.content()).not.toContain('preferences saved');expect(h.content()).not.toContain(' Saved');
    h.edit(label,'next');const cancel=h.click(save);h.confirmations[1].resolve(false);await cancel;h.render();expect(h.requests).toHaveLength(2);
    const failing=h.click(save);h.confirmations[2].resolve(true);await flush();h.edit(label,'latest');h.requests[2].pending.reject(new Error('revision conflict'));await failing;h.render();
    expect(h.content()).toContain('revision conflict');expect(h.find(n=>n.props['aria-label']===label).props.value).toBe('latest');
    const retry=h.click(save);h.confirmations[3].resolve(true);await flush();expect(h.requests[3].body.revision).toBe('r2');h.requests[3].pending.resolve(result('latest',[],'r3'));await retry;
  });
  test(`${kind}: refresh/discard preserves edits made after confirmation and unmount ignores responses`,async()=>{
    const h=await loaded(kind,result());h.edit(label,'discard me');const loading=h.click(kind==='library'?'Discard':'Refresh');h.edit(label,'keep me');h.confirmations[0].resolve(true);await flush();h.requests[1].pending.resolve(result('remote',[],'r2'));await loading;h.render();
    expect(h.find(n=>n.props['aria-label']===label).props.value).toBe('keep me');
    const saving=h.click(save);h.confirmations[1].resolve(true);await flush();expect(h.requests[2].body.revision).toBe('r2');h.unmount();const writes=h.writes();h.requests[2].pending.resolve(result('keep me',[],'r3'));await saving;expect(h.writes()).toBe(writes);
  });
}

test('library canonical IDs preserve newer row edits, additions, deletions and expanded identity',async()=>{
  const h=await loaded('library',library());h.render({part:'skills'});h.click('New skill');h.render();h.edit('Skill 1 name','First');h.edit('Skill 1 description','Description');h.edit('Skill 1 instructions','Original');
  const saving=h.click('Save');h.confirmations[0].resolve(true);await flush();const submitted=h.requests[1].body.skills;
  h.edit('Skill 1 name','Renamed');h.edit('Skill 1 instructions','New instructions');h.find(n=>n.props.role==='switch').props.onChange({target:{checked:false}});h.render();
  h.requests[1].pending.resolve(library('base',[{...submitted[0],id:'first'}],'r2'));await saving;h.render();expect(h.find(n=>n.props['aria-label']==='Skill 1 name').props.value).toBe('Renamed');expect(h.find(n=>n.props.role==='switch').props.checked).toBe(false);
  const next=h.click('Save');h.confirmations[1].resolve(true);await flush();expect(h.requests[2].body.skills[0]).toMatchObject({id:'first',name:'Renamed',text:'New instructions',auto:false});
  h.click('Remove skill');h.render();h.click('New skill');h.render();h.edit('Skill 1 name','Second');h.requests[2].pending.resolve(library('base',h.requests[2].body.skills,'r3'));await next;h.render();
  expect(h.find(n=>n.props['aria-label']==='Skill 1 name').props.value).toBe('Second');expect(h.content()).not.toContain('Renamed');
});

test('library drops cannot replace existing skills before load or change the draft during save',async()=>{
  const h=harness('library');h.render({part:'skills'});
  let reads=0;const file={name:'Guide.md',size:10,text:async()=>{reads++;return 'Guide body';}};
  const drop=()=>h.find(n=>n.props.onDrop).props.onDrop({preventDefault(){},dataTransfer:{files:[file]}});
  drop();await flush();expect(reads).toBe(0);
  const existing=skill('existing','Existing skill');h.requests[0].pending.resolve(library('base',[existing]));await flush();h.render();
  expect(h.content()).toContain('Existing skill');expect(h.content()).not.toContain('Unsaved changes');
  drop();await flush();h.render();const saving=h.click('Save');drop();h.confirmations[0].resolve(true);await flush();h.render();
  expect(h.requests[1].body.skills).toEqual([existing,expect.objectContaining({text:'Guide body'})]);
  expect(h.button('Import').props.disabled).toBe(true);drop();await flush();expect(reads).toBe(1);
  h.requests[1].pending.resolve(library('base',h.requests[1].body.skills,'r2'));await saving;h.render();expect(h.content()).not.toContain('Unsaved changes');
});

test('library delayed import blocks reload and is retained across a save and hidden section switches',async()=>{
  const h=await loaded('library',library());h.render({part:'skills'});const read=deferred();h.find(n=>n.props['aria-label']==='Choose SKILL.md files').props.onChange({target:{files:[{name:'guide.md',size:20,text:()=>read.promise}],value:'file'}});
  h.render();expect(h.button('Reload').props.disabled).toBe(true);h.click('Reload');expect(h.requests).toHaveLength(1);
  h.render({part:'prompt'});h.edit('Agent system prompt','submitted');expect(h.button('Discard').props.disabled).toBe(true);
  const saving=h.click('Save');h.confirmations[0].resolve(true);await flush();
  read.resolve('---\nname: Guide\ndescription: Use this guide\n---\nFollow these steps');await flush();h.render({part:null});h.requests[1].pending.resolve({instructions:'submitted',skills:[],revision:'r2'});await saving;h.render({part:'skills'});
  expect(h.content()).toContain('Guide');expect(h.content()).toContain('Unsaved changes');expect(h.content()).toContain('Built in skill');
  h.render({part:'prompt'});expect(h.find(n=>n.props['aria-label']==='Agent system prompt').props.value).toBe('submitted');
});

test('library accepts canonical normalization with no new edits and drops imports after unmount',async()=>{
  const h=await loaded('library',library('base',[skill('new-temporary',' Name ')]));h.render({part:'skills'});h.find(n=>n.props.className==='ag-skill-head').props.onClick();h.render();h.edit('Skill 1 description',' Description ');
  const saving=h.click('Save');h.confirmations[0].resolve(true);await flush();h.requests[1].pending.resolve({instructions:'base',skills:[skill('canonical','Name')],revision:'r2'});await saving;h.render();
  expect(h.find(n=>n.props['aria-label']==='Skill 1 name').props.value).toBe('Name');expect(h.content()).toContain(' Saved');expect(h.content()).not.toContain('Unsaved changes');
  const read=deferred();h.find(n=>n.props['aria-label']==='Choose SKILL.md files').props.onChange({target:{files:[{name:'guide.md',size:4,text:()=>read.promise}],value:'file'}});h.unmount();const writes=h.writes();read.reject(new Error('late read'));await flush();expect(h.writes()).toBe(writes);
});

test('project accepts server normalization only for untouched fields',async()=>{
  const h=await loaded('project',project('base',[template()]));h.edit('Template 1 name','  Name  ');const saving=h.click('Save preferences');h.confirmations[0].resolve(true);await flush();h.edit('Project instructions','new draft');
  h.requests[1].pending.resolve(project('base',[{...template(),name:'Name'}],'r2'));await saving;h.render();expect(h.find(n=>n.props['aria-label']==='Template 1 name').props.value).toBe('Name');expect(h.find(n=>n.props['aria-label']==='Project instructions').props.value).toBe('new draft');expect(h.content()).not.toContain('Project preferences saved');
});

test('project template mutations and source imports remain editable during save',async()=>{
  const h=await loaded('project',project('base',[template()]));h.edit('Project instructions','submitted');
  const preview=h.click('AGENTS.md');h.requests[1].pending.resolve({path:'AGENTS.md',text:'source text'});await preview;h.render();
  const saving=h.click('Save preferences');h.confirmations[0].resolve(true);await flush();h.edit('Template 1 name','New name');h.edit('Template 1 kind','skill');h.edit('Template 1 text','New text');h.click('Append to instructions');h.render();h.click('Import as template');h.render();
  h.requests[2].pending.resolve(project('submitted',[template()],'r2'));await saving;h.render();expect(h.find(n=>n.props['aria-label']==='Project instructions').props.value).toBe('submitted\n\nsource text');expect(h.find(n=>n.props['aria-label']==='Template 1 name').props.value).toBe('New name');expect(h.find(n=>n.props['aria-label']==='Template 2 text').props.value).toBe('source text');
  const next=h.click('Save preferences');h.confirmations[1].resolve(true);await flush();expect(h.requests[3].body.templates[0]).toMatchObject({kind:'skill',text:'New text'});h.click('Remove');h.render();h.click('Add template');h.render();h.requests[3].pending.resolve(project(h.requests[3].body.instructions,h.requests[3].body.templates,'r3'));await next;h.render();
  expect(h.find(n=>n.props['aria-label']==='Template 1 text').props.value).toBe('source text');expect(h.find(n=>n.props['aria-label']==='Template 2 text').props.value).toBe('');
});

test('project scope changes ignore old save, preview, load errors and pending confirmations',async()=>{
  const h=await loaded('project',project());h.edit('Project instructions','A edit');const saving=h.click('Save preferences');h.confirmations[0].resolve(true);await flush();const preview=h.click('AGENTS.md');
  h.render({id:'B'});h.requests[3].pending.resolve(project('B base',[],'b1'));await flush();h.render();h.edit('Project instructions','B edit');
  h.requests[1].pending.resolve(project('A edit',[],'a2'));h.requests[2].pending.resolve({path:'AGENTS.md',text:'old preview'});await saving;await preview;h.render();expect(h.find(n=>n.props['aria-label']==='Project instructions').props.value).toBe('B edit');expect(h.content()).not.toContain('old preview');
  const confirming=h.click('Save preferences');h.render({id:'C'});h.render({id:'D'});h.requests[4].pending.reject(new Error('old C error'));h.requests[5].pending.resolve(project('D base',[],'d1'));h.confirmations[1].resolve(true);await confirming;await flush();h.render();
  expect(h.requests).toHaveLength(6);expect(h.content()).not.toContain('old C error');expect(h.find(n=>n.props['aria-label']==='Project instructions').props.value).toBe('D base');
});
