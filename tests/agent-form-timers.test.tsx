import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createElement,Fragment} from 'react';
import {clearSubmitted,formActive,formAnswer,formChoice,formReady,splitRecommended,type FormField} from '../src/agent-logic';
import * as agentLogic from '../src/agent-logic';

// Execute the actual components and their returned event handlers without a DOM,
// global module mocks, network requests, or a new renderer dependency.
const transpiler=new Bun.Transpiler({loader:'tsx',tsconfig:{compilerOptions:{jsx:'react',jsxFactory:'createElement',jsxFragmentFactory:'Fragment'}}});
function component(file:string,start:string,end:string,bindings:Record<string,unknown>){
  const source=readFileSync(new URL(`../src/${file}`,import.meta.url),'utf8');
  const code=source.slice(source.indexOf(`function ${start}(`),end?source.indexOf(end,source.indexOf(`function ${start}(`)):undefined);
  return new Function(...Object.keys(bindings),transpiler.transformSync(code)+`\nreturn ${start};`)(...Object.values(bindings));
}
function hooks(){
  const cells:any[]=[],effects:{deps:unknown[];cleanup?:()=>void}[]=[];let cursor=0,effect=0,pending:(()=>void)[]=[],unmounted=false,staleWrites=0;
  return {
    useState(initial:any){const i=cursor++;if(!(i in cells))cells[i]=typeof initial==='function'?initial():initial;return [cells[i],(value:any)=>{if(unmounted)staleWrites++;cells[i]=typeof value==='function'?value(cells[i]):value;}];},
    useRef(initial:any){const i=cursor++;return cells[i]??(cells[i]={current:initial});},
    useEffect(run:()=>void|(()=>void),deps:unknown[]){const i=effect++,old=effects[i];if(!old||deps.some((v,n)=>!Object.is(v,old.deps[n]))||deps.length!==old.deps.length)pending.push(()=>{old?.cleanup?.();effects[i]={deps,cleanup:run()||undefined};});},
    render(fn:()=>any){cursor=0;effect=0;pending=[];const tree=fn();pending.forEach(run=>run());return tree;},
    unmount(){unmounted=true;effects.forEach(e=>e.cleanup?.());},
    staleWrites:()=>staleWrites,
  };
}
function nodes(tree:any):any[]{if(Array.isArray(tree))return tree.flatMap(nodes);if(!tree||typeof tree!=='object')return [];return [tree,...nodes(tree.props?.children)];}
const find=(tree:any,predicate:(node:any)=>boolean)=>{const node=nodes(tree).find(predicate);if(!node)throw new Error('Expected component/control not found');return node;};
const deferred=()=>{let resolve!:(value:any)=>void,reject!:(reason:Error)=>void;const promise=new Promise<any>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function apiQueue(){const calls:{path:string;body:any;request:ReturnType<typeof deferred>}[]=[];return {calls,api:(path:string,body:any)=>{const request=deferred();calls.push({path,body,request});return request.promise;}};}
function clock(){
  let now=0,id=0;const timers=new Map<number,{at:number;fn:()=>void}>();
  return {setTimeout(fn:()=>void,ms:number){timers.set(++id,{at:now+ms,fn});return id;},clearTimeout(id:number){timers.delete(id);},count:()=>timers.size,
    advance(ms:number){const end=now+ms;for(;;){const first=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!first||first[1].at>end)break;now=first[1].at;timers.delete(first[0]);first[1].fn();}now=end;}};
}
const icons=Object.fromEntries(['Hammer','ShieldAlert','ArrowLeft','ArrowRight','Check','MessageCircleQuestion','Send','X'].map(name=>[name,name]));
const file=(name:string)=>({name,mime:'text/plain',data:'YQ==',source:{type:'inline' as const}});
const skill=(id:string)=>({id,name:id});
function newSession(onCreated?:(...args:any[])=>void){
  const state=hooks(),requests=apiQueue(),created:any[]=[],stored:any[]=[];
  const NewSession=component('agent.tsx','NewSession','function SessionView(',{...state,...requests,...icons,createElement,Fragment,clearSubmitted,
    useConfirm:()=>({confirm:async()=>true,dialog:null}),stored:()=>'',store:(...args:any[])=>stored.push(args),MODES:[{id:'ask'}],currentTrustReport:()=>null,tickWhileVisible:()=>()=>{},LIMITED:'limited',
    Composer:'Composer',FolderChip:'FolderChip',ModeChip:'ModeChip',ModelChip:'ModelChip',FolderTrust:'FolderTrust'});
  const props={models:{models:[{id:'model',usable:true,efforts:[]}],modes:{}},folders:[],reloadFolders:()=>{},onResync:async()=>0,onCreated:(...args:any[])=>{created.push(args);onCreated?.(...args);}};
  let tree:any;const render=()=>{tree=state.render(()=>NewSession(props));return find(tree,n=>n.type==='Composer').props;};
  return {...requests,created,stored,render,tree:()=>tree,unmount:state.unmount,staleWrites:state.staleWrites};
}
const session={id:'session',title:'First',folder:'/scratch',model:'model',mode:'ask',effort:''};

test('session history and stream replay survive unavailable file changes; only core history can confirm deletion',async()=>{
  const state=hooks(),requests=apiQueue();let stream:any,deleted=0;
  const controls=Object.fromEntries('Pencil Folder Files ListChecks ShieldCheck TriangleAlert AgentForms Composer ModeChip ModelChip Row'.split(' ').map(k=>[k,k]));
  const SessionView=component('agent.tsx','SessionView','// One piece of the conversation',{...state,...requests,...agentLogic,...controls,createElement,Fragment,
    useMemo:(fn:()=>unknown)=>fn(),useConfirm:()=>({}),usePoll:()=>({}),at:(path:string)=>path,EventSource:class{constructor(){stream=this;}close(){}}});
  const render=()=>nodes(state.render(()=>SessionView({start:session,opening:{error:'Prompt failed'},scratch:'',onDeleted:()=>deleted++})));
  const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
  const history={session,messages:[{id:'u',type:'user',text:'Saved message'}],reconnect:{epoch:'e',before:0,after:0,connected:true}};
  const missing=Object.assign(new Error('Not found'),{status:404});
  render();stream.onopen();stream.onmessage({data:JSON.stringify({type:'session.text.ended',controller:{epoch:'e',seq:1},data:{assistantMessageID:'a',ordinal:0,text:'Live reply'}})});
  requests.calls[1].request.reject(Object.assign(new Error('Recording pending'),{status:409}));requests.calls[0].request.resolve(history);await flush();
  let view=render();expect(view.filter(n=>n.type==='Row').map(n=>n.props.block.text)).toEqual(['Saved message','Live reply']);
  expect(view.some(n=>n.props.children==='Live')).toBe(true);expect(view.some(n=>n.props.children==='Prompt failed')).toBe(true);
  expect(view.find(n=>n.props.className==='agent-warn')?.props.children).toContain('Recorded file changes are unavailable. Recording pending');
  stream.onopen();stream.onerror();requests.calls[2].request.resolve({...history,messages:[]});requests.calls[3].request.resolve({turns:[]});await flush();
  view=render();expect(view.some(n=>n.props.className==='agent-warn')).toBe(true);expect(view.some(n=>n.props.children==='Reconnecting…')).toBe(true);
  stream.onopen();requests.calls[4].request.resolve(history);requests.calls[5].request.resolve({turns:[{message:'u',files:[]}]});await flush();
  view=render();expect(view.some(n=>n.props.className==='agent-warn')).toBe(false);expect(view.some(n=>n.props.block?.kind==='changes')).toBe(true);
  stream.onopen();requests.calls[7].request.reject(missing);await flush();expect(deleted).toBe(0);
  requests.calls[6].request.reject(missing);await flush();expect(deleted).toBe(1);state.unmount();
});

test('new-session handlers capture originals synchronously and hand off edits made during create AND prompt',async()=>{
  const h=newSession(),c=h.render(),originalFiles=[file('first.txt')],originalSkills=[skill('first')];
  c.onChange('  first  ');c.onFiles(originalFiles);c.onSkills(originalSkills);
  const sent=c.onSend();await c.onSend();expect(h.calls).toHaveLength(1);
  c.onChange('during create');c.onFiles([file('create.txt')]);c.onSkills([skill('create')]);
  h.calls[0].request.resolve(session);await Promise.resolve();
  expect(h.calls[0].body.title).toBe('first');
  expect(h.calls[1].body).toEqual({id:'session',text:'first',files:originalFiles,skills:['first']});
  const pending=h.render();pending.onChange('during prompt');pending.onFiles([]);pending.onSkills([skill('prompt')]);
  await pending.onSend();expect(h.calls).toHaveLength(2);
  h.calls[1].request.resolve({limited:true});await sent;
  expect(h.created).toEqual([[session,{draft:'during prompt',files:[],skills:[skill('prompt')],notice:'limited'}]]);
  await pending.onSend();expect(h.calls).toHaveLength(2);
});

test('new-session success clears only unchanged fields and preserves away-and-back revisions',async()=>{
  const h=newSession(),c=h.render(),files=[file('first.txt')],skills=[skill('first')];
  c.onChange('  first  ');c.onFiles(files);c.onSkills(skills);const sent=c.onSend();
  c.onChange('changed');c.onChange('  first  ');c.onSkills([]);c.onSkills(skills);
  h.calls[0].request.resolve(session);await Promise.resolve();h.calls[1].request.resolve({});await sent;
  expect(h.created[0][1]).toEqual({draft:'  first  ',files:[],skills});
  const untouched=newSession(),u=untouched.render();u.onChange('first');u.onFiles(files);u.onSkills(skills);const clean=u.onSend();
  untouched.calls[0].request.resolve(session);await Promise.resolve();untouched.calls[1].request.resolve({});await clean;
  expect(untouched.created[0][1]).toEqual({draft:'',files:[],skills:[]});
});

test('new-session prompt failure opens the existing session with latest drafts, never captured stale edits',async()=>{
  const h=newSession(),c=h.render();c.onChange('original');c.onFiles([file('original.txt')]);c.onSkills([skill('original')]);const sent=c.onSend();
  c.onChange('create edit');h.calls[0].request.resolve(session);await Promise.resolve();
  c.onChange('');c.onFiles([file('new.txt')]);c.onSkills([]);h.calls[1].request.reject(new Error('prompt failed'));await sent;
  expect(h.created).toEqual([[session,{draft:'',files:[file('new.txt')],skills:[],error:'prompt failed'}]]);
  const unchanged=newSession(),u=unchanged.render();u.onChange('  original  ');u.onFiles([file('original.txt')]);u.onSkills([skill('original')]);const failed=u.onSend();
  unchanged.calls[0].request.resolve(session);await Promise.resolve();unchanged.calls[1].request.reject(new Error('prompt failed'));await failed;
  expect(unchanged.created[0][1]).toEqual({draft:'  original  ',files:[file('original.txt')],skills:[skill('original')],error:'prompt failed'});
});

test('new-session create failure stays on the latest draft without opening an invalid session and allows retry',async()=>{
  const h=newSession(),c=h.render();c.onChange('original');const sent=c.onSend();
  c.onChange('latest');c.onFiles([file('latest.txt')]);c.onSkills([skill('latest')]);h.calls[0].request.reject(new Error('create failed'));await sent;
  expect(h.created).toEqual([]);const retry=h.render();expect(retry.value).toBe('latest');expect(retry.files).toEqual([file('latest.txt')]);expect(retry.skills).toEqual([skill('latest')]);expect(retry.sending).toBe(false);
  expect(nodes(h.tree()).some(n=>n.props?.children==='create failed')).toBe(true);
  const second=retry.onSend();expect(h.calls).toHaveLength(2);expect(h.calls[1].body.title).toBe('latest');h.calls[1].request.reject(new Error('still unavailable'));await second;
});

for(const outcome of ['success','failure'] as const){
  test(`abandoned new-session create ${outcome} neither posts a prompt nor replaces the next composer`,async()=>{
    let selected='draft A';const handoff=()=>{selected='old session';};
    const a=newSession(handoff),first=a.render();first.onChange('draft A');const sent=first.onSend();a.unmount();
    selected='draft B';const b=newSession(handoff),next=b.render();next.onChange('draft B');next.onFiles([file('B.txt')]);next.onSkills([skill('B')]);
    if(outcome==='success')a.calls[0].request.resolve(session);else a.calls[0].request.reject(new Error('late create failure'));
    await sent;await first.onSend();
    expect(a.calls).toHaveLength(1);expect(a.created).toEqual([]);expect(a.stored).toEqual([]);expect(a.staleWrites()).toBe(0);expect(selected).toBe('draft B');
    const draft=b.render();expect(draft.value).toBe('draft B');expect(draft.files).toEqual([file('B.txt')]);expect(draft.skills).toEqual([skill('B')]);expect(draft.sending).toBe(false);b.unmount();
  });

  test(`abandoned new-session prompt ${outcome} finishes without stale state or navigation handoff`,async()=>{
    let selected='draft A';const handoff=()=>{selected='old session';};
    const a=newSession(handoff),first=a.render();first.onChange('draft A');const sent=first.onSend();a.calls[0].request.resolve(session);await Promise.resolve();
    expect(a.calls).toHaveLength(2);expect(a.calls[1].body.text).toBe('draft A');a.unmount();
    selected='draft B';const b=newSession(handoff),next=b.render();next.onChange('draft B');const storedBefore=a.stored.length;
    if(outcome==='success')a.calls[1].request.resolve({limited:true});else a.calls[1].request.reject(new Error('late prompt failure'));
    await sent;await first.onSend();
    expect(a.calls).toHaveLength(2);expect(a.created).toEqual([]);expect(a.stored).toHaveLength(storedBefore);expect(a.staleWrites()).toBe(0);expect(selected).toBe('draft B');expect(b.render().value).toBe('draft B');b.unmount();
  });
}

const fields:FormField[]=['first','second','third'].map(key=>({key,title:key,type:'string',custom:true,options:[{value:'a',label:'A'},{value:'b',label:'B'}]}));
function question(initial=fields){
  const state=hooks(),time=clock(),requests=apiQueue();let done=0;
  const Question=component('agent-forms.tsx','Question','// The answer area',{...state,...time,...requests,...icons,createElement,Fragment,formActive,formAnswer,formReady,formChoice,splitRecommended,Answer:'Answer'});
  const Answer=component('agent-forms.tsx','Answer','',{...icons,createElement,formChoice,splitRecommended});
  let props={session:'session',form:{id:'form',title:'Questions',fields:initial},onDone:()=>done++},tree:any;
  const render=()=>{tree=state.render(()=>Question(props));return tree;};
  const answer=()=>find(tree,n=>n.type==='Answer');
  const click=(value:string)=>find(Answer(answer().props),n=>n.type==='button'&&(value==='Other'?nodes(n).some(x=>x.props?.children==='Other'):n.key===value)).props.onClick();
  render();
  return {...requests,...time,render,click,unmount:state.unmount,field:()=>answer().props.field.key,
    update:(next:Partial<typeof props>)=>{props={...props,...next};render();},
    tab:(index:number)=>find(tree,n=>n.type==='nav').props.children[index].props.onClick(),
    back:()=>find(tree,n=>n.type==='button'&&nodes(n).some(x=>x.type==='ArrowLeft')).props.onClick(),
    submit:()=>tree.props.onSubmit({preventDefault(){}}),
    dismiss:()=>find(tree,n=>n.props?.['aria-label']==='Dismiss question').props.onClick(),done:()=>done};
}

test('single-choice double click/reselection owns one 160ms timer and advances exactly one question',()=>{
  const q=question();q.click('a');q.advance(80);q.click('b');expect(q.count()).toBe(1);
  q.advance(80);q.render();expect(q.field()).toBe('first');q.advance(79);q.render();expect(q.field()).toBe('first');
  q.advance(1);q.render();expect(q.field()).toBe('second');q.advance(1000);q.render();expect(q.field()).toBe('second');
  q.tab(0);q.render();q.click('a');q.click('a');expect(q.count()).toBe(1);q.advance(160);q.render();expect(q.field()).toBe('second');q.unmount();
});

test('question auto-advance is cancelled by Other, tabs, Back, manual Next, and unmount',()=>{
  const q=question();q.click('a');q.click('Other');expect(q.count()).toBe(0);q.advance(160);q.render();expect(q.field()).toBe('first');
  q.click('a');q.tab(1);q.render();q.advance(160);q.render();expect(q.field()).toBe('second');
  q.click('a');q.back();q.render();q.advance(160);q.render();expect(q.field()).toBe('first');
  q.click('a');q.submit();q.render();q.advance(160);q.render();expect(q.field()).toBe('second');
  q.click('a');q.unmount();expect(q.count()).toBe(0);q.advance(1000);expect(q.calls).toHaveLength(0);
});

test('question timer uses the latest conditional list including a newly revealed next question',()=>{
  const q=question([fields[0],{...fields[1],when:[{key:'first',op:'eq',value:'a'}]}]);
  q.click('a');q.render();q.advance(160);q.render();expect(q.field()).toBe('second');q.unmount();
  const changed=question();changed.click('a');changed.update({form:{id:'form',title:'Questions',fields:[fields[0],fields[2]]}});
  changed.advance(160);changed.render();expect(changed.field()).toBe('third');changed.unmount();
});

test('replacing question/session identity cancels an old auto-advance',()=>{
  const q=question();q.click('a');q.update({form:{id:'replacement',title:'Questions',fields}});expect(q.count()).toBe(0);q.advance(160);q.render();expect(q.field()).toBe('first');
  q.click('a');q.update({session:'replacement-session'});expect(q.count()).toBe(0);q.advance(160);q.render();expect(q.field()).toBe('first');q.unmount();
});

test('hidden/replaced visible fields cancel advancement and multi-select does not auto-advance',()=>{
  const q=question();q.click('a');q.update({form:{id:'form',title:'Questions',fields:[{...fields[0],hidden:true},fields[1],fields[2]]}});
  expect(q.count()).toBe(0);q.advance(160);q.render();expect(q.field()).toBe('second');q.unmount();
  const many=question([{...fields[0],type:'multiselect'},fields[1]]);many.click('a');many.render();many.click('b');many.render();expect(many.count()).toBe(0);many.advance(160);many.render();expect(many.field()).toBe('first');many.unmount();
});

test('submit and dismiss cancel timers and synchronous duplicate handlers send only once',async()=>{
  const q=question();q.tab(2);q.render();q.click('a');expect(q.count()).toBe(1);q.submit();q.submit();expect(q.count()).toBe(0);expect(q.calls).toHaveLength(1);
  expect(q.calls[0].body.answer).toEqual({third:'a'});q.advance(160);q.render();expect(q.field()).toBe('third');q.calls[0].request.resolve({});await Promise.resolve();expect(q.done()).toBe(1);q.unmount();
  const cancel=question();cancel.click('a');const sent=cancel.dismiss();await cancel.dismiss();expect(cancel.count()).toBe(0);expect(cancel.calls).toHaveLength(1);expect(cancel.calls[0].body).toEqual({id:'session',form:'form',cancel:true});
  cancel.advance(160);cancel.render();expect(cancel.field()).toBe('first');cancel.calls[0].request.resolve({});await sent;cancel.unmount();
});
