import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {renderToStaticMarkup} from 'react-dom/server';
import {AgentDiff} from '../src/agent-diff';
import {applyEvent,clearSubmitted,currentTrustReport,formAnswer,formChoice,fromHistory,snapshotEvents,snapshotRepair,type FormField,type Item} from '../src/agent-logic';

test('send success clears only the submitted draft snapshot, not pending edits',()=>{
  expect(clearSubmitted('  first  ','  first  ','',1,1)).toBe('');
  expect(clearSubmitted('next message','first','',1,1)).toBe('next message');
  const submitted=[{id:'first',name:'First'}],edited=[...submitted,{id:'next',name:'Next'}];
  expect(clearSubmitted(submitted,submitted,[],1,1)).toEqual([]);
  expect(clearSubmitted(edited,submitted,[],1,1)).toBe(edited);
  const source=readFileSync(new URL('../src/agent.tsx',import.meta.url),'utf8');
  expect(source).toContain("setText(current=>clearSubmitted(current,text,'',draftRevision.current.text,revision.text))");
  expect(source).toContain('setFiles(current=>clearSubmitted(current,files,[],draftRevision.current.files,revision.files))');
  expect(source).toContain('setSkills(current=>clearSubmitted(current,skills,[],draftRevision.current.skills,revision.skills))');
});

test('editing away and back preserves identical text and restored array identities after send',()=>{
  const submitted='A';let current=submitted,revision=4;const sentRevision=revision;
  current='B';revision++;current='A';revision++;
  expect(clearSubmitted(current,submitted,'',revision,sentRevision)).toBe('A');
  const original=[{id:'skill',name:'Skill'}];
  expect(clearSubmitted(original,original,[],6,4)).toBe(original);
  const source=readFileSync(new URL('../src/agent.tsx',import.meta.url),'utf8');
  const session=source.slice(source.indexOf('function SessionView('),source.indexOf('// One piece of the conversation'));
  expect(session).toContain('const revision={...draftRevision.current}');
  expect(session).toContain('draftRevision.current.text++;setText(value)');
  expect(session).toContain('draftRevision.current.files++;setFiles(value)');
  expect(session).toContain('draftRevision.current.skills++;setSkills(value)');
  expect(session).toContain('onChange={editText} files={files} onFiles={editFiles} skills={skills} onSkills={editSkills}');
  expect(session).toContain('onInsert={template=>{editText(');
});

test('choosing a preset discards stale single-choice Other text and its selected state',()=>{
  const field:FormField={key:'q',type:'string',custom:true,options:[{value:'preset',label:'Preset'}]};
  const selected=formChoice(field,'My own answer','preset');
  expect(selected).toEqual({value:'preset',other:'',otherOn:false});
  expect(formAnswer([field],{q:selected.value})).toEqual({q:'preset'});
  // Reopening Other now has no stale display value and clears the preset until an answer is typed.
  expect(selected.other?.trim()||undefined).toBeUndefined();
  expect(formChoice({key:'b',type:'boolean'},false,'true')).toMatchObject({value:true});
  const many:FormField={...field,type:'multiselect'};
  expect(formChoice(many,['Custom'],'preset')).toEqual({value:['Custom','preset']});
  expect(formChoice(many,['Custom','preset'],'preset')).toEqual({value:['Custom']});
  const source=readFileSync(new URL('../src/agent-forms.tsx',import.meta.url),'utf8');
  expect(source).toContain('const next=formChoice(f,value,v);set(next.value)');
  expect(source).toContain('setOther(next.other!);setOtherOn(next.otherOn!)');
  expect(source).toContain('if(!many)set(other.trim()||typed||undefined)');
});

test('diff headers are hidden without hiding header-like additions or deletions inside hunks',()=>{
  const patch='diff --git a/a b/a\nindex 111..222 100644\n--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n--- removed content\n+++ added content\n context\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -0,0 +1 @@\n+new';
  const html=renderToStaticMarkup(<AgentDiff patch={patch}/>);
  expect(html).not.toContain('diff --git');expect(html).not.toContain('index 111');
  expect(html).not.toContain('--- a/');expect(html).not.toContain('+++ b/');
  expect(html).toContain('class="del">--- removed content');
  expect(html).toContain('class="add">+++ added content');
  expect(html).toContain('class="add">+new');
});

test('trust accepts canonical aliases only for the latest request generation',()=>{
  const report={folder:'C:\\real\\project',trusted:true};
  expect(currentTrustReport(report,3,3)).toBe(report);
  expect(currentTrustReport(report,2,3)).toBeNull();
  // A -> B -> A still invalidates the first A, even though the requested path matches again.
  expect(currentTrustReport(report,1,3)).toBeNull();
  const source=readFileSync(new URL('../src/agent.tsx',import.meta.url),'utf8');
  expect(source).toContain('currentTrustReport(result,request,trustRequest.current)');
  expect(source).toContain('folder:canonical');
  expect(source).toContain('FolderTrust folder={report.folder}');
});

const delta=(kind:'text'|'reasoning',value:string,ordinal=0)=>({type:`session.${kind}.delta`,data:{assistantMessageID:'a',ordinal,delta:value}});
test('existing snapshot parts trigger a fresh snapshot instead of dropping suffixes or duplicating deltas',()=>{
  const snapshot=fromHistory([{id:'a',type:'assistant',content:[{type:'text',text:'Hel'},{type:'reasoning',text:'Think'}]}]);
  const replay=snapshotEvents(snapshot,[delta('text','lo'),delta('reasoning','ing')]);
  expect(replay).toEqual({events:[],refresh:true});
  const fresh=fromHistory([{id:'a',type:'assistant',content:[{type:'text',text:'Hello'},{type:'reasoning',text:'Thinking',ordinal:1}]}]);
  expect(snapshotEvents(fresh,[])).toEqual({events:[],refresh:false});
  expect(fresh.map(i=>(i as any).text)).toEqual(['Hello','Thinking']);
  // The same rule handles a snapshot that already contains the buffered text, without guessing an overlap.
  expect(snapshotEvents(fresh,[delta('text','lo')])).toEqual({events:[],refresh:true});
});

test('new parts replay once and authoritative end text resolves buffered deltas without a refresh',()=>{
  const events=[delta('text','Hello'),delta('text',' world')];
  const replay=snapshotEvents([],events);
  expect(replay.refresh).toBe(false);
  expect(replay.events.reduce<Item[]>(applyEvent,[])).toEqual([{kind:'text',key:'a:t0',text:'Hello world'}]);
  const snapshot:Item[]=[{kind:'text',key:'a:t0',text:'Hel'}];
  const end={type:'session.text.ended',data:{assistantMessageID:'a',ordinal:0,text:'Hello'}};
  const complete=snapshotEvents(snapshot,[delta('text','lo'),end]);
  expect(complete.refresh).toBe(false);
  expect(complete.events.reduce(applyEvent,snapshot)).toEqual([{kind:'text',key:'a:t0',text:'Hello'}]);
  // End events without authoritative text cannot resolve the ambiguity, including interrupted streams.
  expect(snapshotEvents(snapshot,[delta('text','lo'),{...end,data:{assistantMessageID:'a',ordinal:0}}]).refresh).toBe(true);
});

function repairClock(){
  let now=0,id=0;const timers=new Map<number,{at:number;fn:()=>void}>();
  return {
    now:()=>now,
    set:(fn:()=>void,delay:number)=>{timers.set(++id,{at:now+delay,fn});return id;},
    clear:(timer:unknown)=>{timers.delete(timer as number);},
    count:()=>timers.size,
    advance:(ms:number)=>{
      const until=now+ms;
      for(;;){const first=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!first||first[1].at>until)break;now=first[1].at;timers.delete(first[0]);first[1].fn();}
      now=until;
    },
  };
}

test('continuous output defers repair to one idle resnapshot rather than periodic slow-snapshot loads',()=>{
  const clock=repairClock();let loads=0;
  const repair=snapshotRepair(()=>{loads++;repair.begin();},clock);
  repair.begin();
  for(let i=0;i<20;i++){clock.advance(100);repair.delta();}
  repair.complete(true);
  for(let i=0;i<100;i++){clock.advance(100);repair.delta();expect(clock.count()).toBe(1);}
  expect(loads).toBe(0);
  clock.advance(499);expect(loads).toBe(0);
  clock.advance(1);expect(loads).toBe(1);
  repair.complete(false);clock.advance(10000);expect(loads).toBe(1);expect(clock.count()).toBe(0);
  repair.dispose();
});

test('execution-end repair coalesces behind an active snapshot and disposal cancels idle repair',()=>{
  const clock=repairClock();let loads=0;
  const repair=snapshotRepair(()=>{loads++;repair.begin();},clock);
  repair.begin();repair.delta();repair.request(true);repair.request(true);
  clock.advance(2000);expect(loads).toBe(0);
  repair.complete(true);clock.advance(0);expect(loads).toBe(1);
  repair.complete(false);clock.advance(1000);expect(loads).toBe(1);
  repair.delta();repair.request();repair.dispose();clock.advance(1000);expect(loads).toBe(1);
  const source=readFileSync(new URL('../src/agent.tsx',import.meta.url),'utf8');
  expect(source).toContain('changed.current();repair.request(true)');
  expect(source).toContain('repair.complete(replay.refresh&&s.reconnect.connected)');
  expect(source).toContain('const next=consistency.receive(e)');
  expect(source).not.toContain('if(replay.refresh)refresh=setTimeout');
});

test('failed snapshots retry only three times with exponential backoff and stop on success',()=>{
  const clock=repairClock();let loads=0;
  const repair=snapshotRepair(()=>{loads++;repair.begin();repair.failed();},clock);
  repair.begin();repair.failed();
  clock.advance(100);repair.delta();repair.request(true);
  clock.advance(899);expect(loads).toBe(0);clock.advance(1);expect(loads).toBe(1);
  clock.advance(1999);expect(loads).toBe(1);clock.advance(1);expect(loads).toBe(2);
  clock.advance(3999);expect(loads).toBe(2);clock.advance(1);expect(loads).toBe(3);
  repair.delta();repair.request(true);clock.advance(60000);expect(loads).toBe(3);expect(clock.count()).toBe(0);
  repair.dispose();
  const recovered=snapshotRepair(()=>{loads++;recovered.begin();recovered.complete(false);},clock);
  recovered.begin();recovered.failed();clock.advance(1000);expect(loads).toBe(4);
  clock.advance(60000);expect(loads).toBe(4);recovered.dispose();
});

test('picker selection and Escape restore trigger focus, while outside clicks do not steal focus',()=>{
  // Source wiring check: no DOM/browser harness is required or launched by this regression file.
  const source=readFileSync(new URL('../src/agent.tsx',import.meta.url),'utf8');
  const popover=source.slice(source.indexOf('function Popover('),source.indexOf('// What Full access means'));
  expect(popover).toContain('if(restore)trigger.current?.focus({preventScroll:true})');
  expect(popover).toContain('ref={trigger}');
  expect(popover).toContain("if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close(true);}");
  expect(popover).toContain('children(()=>close(true))');
  expect(popover).toContain('!panel.current?.contains(t))close();');
});
