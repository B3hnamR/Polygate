import {useEffect,useRef,useState} from 'react';
import {BookOpen,Check,ChevronRight,FileUp,Plus,RefreshCw,Search,Trash2} from 'lucide-react';
import {api} from './api';
import {useConfirm} from './confirm';
import {Button} from './ui';
import {parseSkillFile,type LibrarySkill} from './agent-logic';

type Library={instructions:string;skills:LibrarySkill[];revision:string;builtin:{id:string;name:string;description:string}[]};
// Agent settings → Instructions and Skills: the system prompt for every folder, and the skills the agent can load (Polygate's own, and
// the engine's built-in ones). One instance serves both sections and stays while settings are open, so unsaved edits in one survive a
// visit to the other; `part` says which one is showing (none: nothing is drawn, the edits are kept).
export function AgentLibrarySettings({busy,part}:{busy:boolean;part:'prompt'|'skills'|null}){
  const [data,setData]=useState<Library|null>(null),[instructions,setInstructions]=useState(''),[skills,setSkills]=useState<LibrarySkill[]>([]),[open,setOpen]=useState<string>(''),[error,setError]=useState(''),[saving,setSaving]=useState(false),[saved,setSaved]=useState(false);
  const [query,setQuery]=useState(''),[dropping,setDropping]=useState(false);
  const picker=useRef<HTMLInputElement>(null);const {confirm,dialog}=useConfirm();
  const edits=useRef({instructions:0,skills:0}),operation=useRef(0),locked=useRef(false),lifetime=useRef(0);
  const editInstructions=(value:string)=>{edits.current.instructions++;setInstructions(value);setSaved(false);};
  const editSkills=(change:(list:LibrarySkill[])=>LibrarySkill[])=>{edits.current.skills++;setSkills(change);setSaved(false);};
  const load=async(discard=false)=>{
    if(locked.current)return;locked.current=true;const request=++operation.current,revision={...edits.current};setSaving(true);setSaved(false);
    try{
      if(discard&&!await confirm('Discard unsaved changes to the system prompt and skills?',{title:'Discard changes',confirm:'Discard'}))return;
      if(request!==operation.current)return;setError('');const l:Library=await api('/admin/agent/library');if(request!==operation.current)return;
      setData(d=>({...l,builtin:l.builtin||d?.builtin||[]}));
      if(revision.instructions===edits.current.instructions)setInstructions(l.instructions);
      if(revision.skills===edits.current.skills)setSkills(l.skills);
    }catch(e:any){if(request===operation.current)setError(e.message);}finally{if(request===operation.current){locked.current=false;setSaving(false);}}
  };
  useEffect(()=>{void load();return()=>{operation.current++;lifetime.current++;locked.current=false;};},[]);
  const dirty=!!data&&(instructions!==data.instructions||JSON.stringify(skills)!==JSON.stringify(data.skills));
  const save=async()=>{
    if(locked.current||busy||!data||!dirty)return;locked.current=true;
    const request=++operation.current,revision={...edits.current},submitted={instructions,skills,revision:data.revision,confirm:true};setSaving(true);setSaved(false);
    try{
      if(!await confirm('Save the Agent system prompt and skills for every working folder? The system prompt applies before each message you send. Skills switched to “Agent can use it” are listed to the agent, which loads one when a task matches its description; any skill can also be attached from the message box with /. Skills are instructions only: nothing in them runs by itself.',{title:'Save system prompt and skills',confirm:'Save',icon:<BookOpen size={18}/>}))return;
      if(request!==operation.current)return;setError('');const l:Library=await api('/admin/agent/library',submitted);if(request!==operation.current)return;
      setData(d=>({...l,builtin:l.builtin||d?.builtin||[]}));
      if(revision.instructions===edits.current.instructions)setInstructions(l.instructions);
      // The server preserves submission order but assigns canonical IDs to new skills.
      const ids=new Map(submitted.skills.map((s,i)=>[s.id,l.skills[i].id]));
      if(revision.skills===edits.current.skills)setSkills(l.skills);
      else setSkills(current=>current.map(s=>ids.has(s.id)?{...s,id:ids.get(s.id)!}:s));
      setOpen(current=>ids.get(current)||current);
      setSaved(revision.instructions===edits.current.instructions&&revision.skills===edits.current.skills);
    }catch(e:any){if(request===operation.current)setError(e.message);}finally{if(request===operation.current){locked.current=false;setSaving(false);}}
  };
  const discard=()=>load(true);
  const update=(id:string,patch:Partial<LibrarySkill>)=>editSkills(list=>list.map(s=>s.id===id?{...s,...patch}:s));
  const add=(skill:Omit<LibrarySkill,'id'>)=>{const id='new-'+crypto.randomUUID();editSkills(list=>[...list,{id,...skill}]);setOpen(id);setQuery('');};
  const importFiles=async(files:File[])=>{const owner=lifetime.current;setError('');for(const f of files){if(!/\.(md|markdown|txt)$/i.test(f.name)){setError(`${f.name} is not a Markdown file.`);continue;}if(f.size>32000){setError(`${f.name} is larger than 32,000 bytes.`);continue;}try{const text=await f.text();if(owner!==lifetime.current)return;add(parseSkillFile(text,f.name));}catch(e:any){if(owner!==lifetime.current)return;setError(e?.message||`Could not read ${f.name}.`);}}};
  if(!part)return <>{dialog}</>;
  const words=query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches=(s:{name:string;description:string})=>words.every(w=>`${s.name} ${s.description}`.toLowerCase().includes(w));
  const list=skills.filter(s=>s.id===open||matches(s));const builtin=(data?.builtin||[]).filter(matches);
  const saveBar=dirty&&<div className="ag-savebar" role="status"><span>Unsaved changes to the system prompt and skills</span><Button disabled={saving} onClick={discard}>Discard</Button><Button variant="primary" disabled={busy||saving} onClick={save}>{saving?'Saving…':'Save'}</Button></div>;
  return <div className="ag-library">
    {part==='prompt'&&<>
      <p className="ag-settings-lead">Applied before every message in every working folder, ahead of a folder’s own instructions from its Project tab. Changes apply from the next message you send.</p>
      {!data&&!error&&<p className="subtle">Loading…</p>}
      {data&&<textarea dir="auto" className="ag-prompt" aria-label="Agent system prompt" rows={12} value={instructions} placeholder="How the agent should work for you: language, style, rules it should always follow" onChange={e=>editInstructions(e.target.value)}/>}
    </>}
    {part==='skills'&&<div className={`ag-skills${dropping?' dropping':''}`} onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();setDropping(true);}}} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setDropping(false);}} onDrop={e=>{e.preventDefault();setDropping(false);void importFiles(Array.from(e.dataTransfer.files));}}>
      <p className="ag-settings-lead">A skill teaches the agent one kind of task. Use one in a message by typing <kbd>/</kbd> or pressing the <BookOpen size={13} className="ag-inline-icon" aria-label="skills"/> button beside the message box. With <strong>Auto</strong> on, the agent also loads it by itself when a task matches its description. Drop SKILL.md files here to import them.</p>
      <div className="ag-skill-tools">
        <label className="ag-settings-search"><Search size={14}/><input type="search" aria-label="Search skills" placeholder="Search skills" value={query} onChange={e=>setQuery(e.target.value)}/></label>
        <Button variant="primary" disabled={!data||skills.length>=50} onClick={()=>add({name:'',description:'',text:'',auto:true})}><Plus size={13}/>New skill</Button>
        <Button disabled={!data||skills.length>=50} onClick={()=>picker.current?.click()}><FileUp size={13}/>Import</Button>
        <input ref={picker} className="ag-file-input" type="file" accept=".md,text/markdown,text/plain" multiple tabIndex={-1} aria-label="Choose SKILL.md files" onChange={e=>{void importFiles(Array.from(e.target.files||[]));e.target.value='';}}/>
      </div>
      {!data&&!error&&<p className="subtle">Loading…</p>}
      {data&&<>
        <h4 className="ag-settings-sub">Your skills <span className="subtle">{skills.length}</span></h4>
        {!skills.length?<div className="ag-empty"><BookOpen size={18}/><p>No skills yet. Press <strong>New skill</strong>, or drop a SKILL.md file here.</p></div>
          :!list.length?<p className="subtle">No skill matches “{query}”.</p>
          :<ul className="ag-skill-list">{list.map((s,i)=><li key={s.id} className={open===s.id?'open':undefined}>
            <div className="ag-row ag-skill-row">
              <button type="button" className="ag-skill-head" aria-expanded={open===s.id} onClick={()=>setOpen(o=>o===s.id?'':s.id)}>
                <ChevronRight size={14} className="ag-line-chevron"/><span><strong dir="auto" className="truncate">{s.name||'New skill'}</strong>{s.description&&<small dir="auto">{s.description}</small>}</span>
              </button>
              <label className="ag-switch ag-switch-labelled" title={s.auto?'The agent loads it by itself when a task matches':'Only when you attach it with /'}><span className="ag-switch-text">Auto</span><input type="checkbox" role="switch" aria-label={`Let the agent use ${s.name||'this skill'} by itself`} checked={s.auto} onChange={e=>update(s.id,{auto:e.target.checked})}/><span/></label>
            </div>
            {open===s.id&&<div className="ag-skill-edit">
              <label>Name<input dir="auto" aria-label={`Skill ${i+1} name`} maxLength={80} value={s.name} placeholder="For example: database-migrations" autoFocus={!s.name} onChange={e=>update(s.id,{name:e.target.value})}/></label>
              <label>When to use it<textarea dir="auto" aria-label={`Skill ${i+1} description`} rows={2} maxLength={1024} value={s.description} placeholder="For example: Use when writing or reviewing database migrations" onChange={e=>update(s.id,{description:e.target.value})}/></label>
              <label>Instructions<textarea dir="auto" aria-label={`Skill ${i+1} instructions`} rows={10} value={s.text} placeholder="The steps, rules and examples the agent should follow for this kind of task" onChange={e=>update(s.id,{text:e.target.value})}/></label>
              <div className="button-row"><Button onClick={()=>editSkills(all=>all.filter(x=>x.id!==s.id))}><Trash2 size={13}/>Remove skill</Button></div>
            </div>}
          </li>)}</ul>}
        {!!data.builtin.length&&<>
          <h4 className="ag-settings-sub">Built into the engine <span className="subtle">{data.builtin.length}</span></h4>
          {builtin.length?<ul className="ag-skill-list ag-skill-builtin">{builtin.map(b=><li key={b.id}><div className="ag-row"><div><strong>{b.name}</strong><small>{b.description}</small></div><span className="ag-tag">Built in</span></div></li>)}</ul>:<p className="subtle">No built-in skill matches “{query}”.</p>}
        </>}
      </>}
    </div>}
    {data&&!dirty&&<div className="button-row ag-library-foot">{saved&&<span className="green" role="status"><Check size={13}/> Saved</span>}<Button disabled={saving} onClick={()=>load()}><RefreshCw size={13}/>Reload</Button></div>}
    {error&&<p className="pg-error" role="alert">{error}</p>}
    {saveBar}{dialog}
  </div>;
}
