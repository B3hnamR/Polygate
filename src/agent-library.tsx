import {useEffect,useRef,useState} from 'react';
import {BookOpen,Check,ChevronRight,FileUp,Plus,RefreshCw,Trash2} from 'lucide-react';
import {api} from './api';
import {useConfirm} from './confirm';
import {Button} from './ui';
import {parseSkillFile,type LibrarySkill} from './agent-logic';

type Library={instructions:string;skills:LibrarySkill[];revision:string;builtin:{id:string;name:string;description:string}[]};
// Agent settings: the system prompt for every folder, and the skills the agent can load (Polygate's own, and the engine's built-in ones).
export function AgentLibrarySettings({busy}:{busy:boolean}){
  const [data,setData]=useState<Library|null>(null),[instructions,setInstructions]=useState(''),[skills,setSkills]=useState<LibrarySkill[]>([]),[open,setOpen]=useState<string>(''),[error,setError]=useState(''),[saving,setSaving]=useState(false),[saved,setSaved]=useState(false);
  const picker=useRef<HTMLInputElement>(null);const {confirm,dialog}=useConfirm();
  const accept=(l:Library)=>{setData(d=>({...l,builtin:l.builtin||d?.builtin||[]}));setInstructions(l.instructions);setSkills(l.skills);};
  const load=async()=>{setError('');setSaved(false);try{accept(await api('/admin/agent/library'));}catch(e:any){setError(e.message);}};
  useEffect(()=>{load();},[]);
  const dirty=!!data&&(instructions!==data.instructions||JSON.stringify(skills)!==JSON.stringify(data.skills));
  const save=async()=>{
    if(!await confirm('Save the Agent system prompt and skills for every working folder? The system prompt applies before each message you send. Skills switched to “Agent can use it” are listed to the agent, which loads one when a task matches its description; any skill can also be attached from the message box with /. Skills are instructions only: nothing in them runs by itself.',{title:'Save system prompt and skills',confirm:'Save',icon:<BookOpen size={18}/>}))return;
    setSaving(true);setError('');setSaved(false);
    try{accept(await api('/admin/agent/library',{instructions,skills,revision:data?.revision,confirm:true}));setSaved(true);}catch(e:any){setError(e.message);}finally{setSaving(false);}
  };
  const update=(at:number,patch:Partial<LibrarySkill>)=>{setSaved(false);setSkills(list=>list.map((s,i)=>i===at?{...s,...patch}:s));};
  const add=(skill:Omit<LibrarySkill,'id'>)=>{const id='new-'+crypto.randomUUID();setSkills(list=>[...list,{id,...skill}]);setOpen(id);setSaved(false);};
  const importFiles=async(files:File[])=>{setError('');for(const f of files){if(f.size>32000){setError(`${f.name} is larger than 32,000 bytes.`);continue;}add(parseSkillFile(await f.text(),f.name));}};
  return <>
    <section className="ag-set ag-library"><h3>System prompt</h3>
      <p className="subtle">Applied before every message in every working folder, ahead of a folder’s own instructions from its Project tab. Changes apply from the next message you send.</p>
      {!data&&!error&&<p className="subtle">Loading…</p>}
      {data&&<textarea dir="auto" aria-label="Agent system prompt" rows={6} value={instructions} placeholder="How the agent should work for you: language, style, rules it should always follow" onChange={e=>{setInstructions(e.target.value);setSaved(false);}}/>}
    </section>
    <section className="ag-set ag-library"><h3>Skills</h3>
      <p className="subtle">A skill is a set of instructions for one kind of task. With “Agent can use it” on, the agent sees its name and description and loads it when a task matches. Type <kbd>/</kbd> in the message box to attach any skill to a message yourself.</p>
      {data&&<>
        {!skills.length&&<p className="subtle">No skills yet. Add one, or import a SKILL.md file.</p>}
        <ul className="ag-skill-list">{skills.map((s,i)=><li key={s.id} className={open===s.id?'open':undefined}>
          <button type="button" className="ag-skill-head" aria-expanded={open===s.id} onClick={()=>setOpen(o=>o===s.id?'':s.id)}>
            <ChevronRight size={14} className="ag-line-chevron"/><strong dir="auto" className="truncate">{s.name||'New skill'}</strong>
            <small className={s.auto?'green':'subtle'}>{s.auto?'Agent can use it':'Only when you attach it'}</small>
          </button>
          {open!==s.id?(s.description&&<p className="subtle ag-skill-desc" dir="auto">{s.description}</p>):<div className="ag-skill-edit">
            <label>Name<input dir="auto" aria-label={`Skill ${i+1} name`} maxLength={80} value={s.name} onChange={e=>update(i,{name:e.target.value})}/></label>
            <label>When to use it<textarea dir="auto" aria-label={`Skill ${i+1} description`} rows={2} maxLength={1024} value={s.description} placeholder="For example: Use when writing or reviewing database migrations" onChange={e=>update(i,{description:e.target.value})}/></label>
            <label className="ag-skill-auto"><input type="checkbox" checked={s.auto} onChange={e=>update(i,{auto:e.target.checked})}/>Agent can use it by itself</label>
            <label>Instructions<textarea dir="auto" aria-label={`Skill ${i+1} instructions`} rows={9} value={s.text} onChange={e=>update(i,{text:e.target.value})}/></label>
            <div className="button-row"><Button onClick={()=>{setSkills(list=>list.filter((_,n)=>n!==i));setSaved(false);}}><Trash2 size={13}/>Remove skill</Button></div>
          </div>}
        </li>)}</ul>
        <div className="button-row">
          <Button disabled={skills.length>=50} onClick={()=>add({name:'',description:'',text:'',auto:true})}><Plus size={13}/>Add skill</Button>
          <Button disabled={skills.length>=50} onClick={()=>picker.current?.click()}><FileUp size={13}/>Import SKILL.md</Button>
          <input ref={picker} className="ag-file-input" type="file" accept=".md,text/markdown,text/plain" multiple tabIndex={-1} aria-label="Choose SKILL.md files" onChange={e=>{void importFiles(Array.from(e.target.files||[]));e.target.value='';}}/>
        </div>
        {!!data.builtin.length&&<details className="ag-skill-builtin"><summary>Built into the engine ({data.builtin.length})</summary>
          <ul>{data.builtin.map(b=><li key={b.id}><strong>{b.name}</strong><small className="subtle">{b.description}</small></li>)}</ul></details>}
        <div className="button-row ag-project-save">
          <Button variant="primary" disabled={busy||saving||!dirty} onClick={save}>{saving?'Saving…':'Save system prompt and skills'}</Button>
          <Button disabled={saving} onClick={async()=>{if(dirty&&!await confirm('Discard unsaved changes to the system prompt and skills?',{title:'Refresh',confirm:'Discard and refresh'}))return;await load();}}><RefreshCw size={13}/>Refresh</Button>
        </div>
        {dirty&&<p className="subtle">Unsaved changes are discarded when you close Agent settings.</p>}
        {saved&&!dirty&&<p className="green" role="status"><Check size={13}/> Saved.</p>}
      </>}
      {error&&<p className="pg-error" role="alert">{error}</p>}{dialog}
    </section>
  </>;
}
