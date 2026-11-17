import {useEffect,useRef,useState} from 'react';
import {Check,FileText,Plus,RefreshCw,Trash2} from 'lucide-react';
import {api} from './api';
import {useConfirm} from './confirm';
import {Button} from './ui';

type Template={id:string;kind:'command'|'skill';name:string;text:string};
type Preferences={instructions:string;templates:Template[];revision:string;sources:{path:string;hash:string;bytes:number}[]};
export function AgentProject({id,busy,onInsert}:{id:string;busy:boolean;onInsert:(text:string)=>void}){
  const [data,setData]=useState<Preferences|null>(null),[instructions,setInstructions]=useState(''),[templates,setTemplates]=useState<Template[]>([]),[error,setError]=useState(''),[saving,setSaving]=useState(false),[saved,setSaved]=useState(false),[source,setSource]=useState<{path:string;text:string}|null>(null);
  const {confirm,dialog}=useConfirm();
  const edits=useRef({instructions:0,templates:0}),scope=useRef({id,serial:0,source:0,locked:false,loaded:false});
  if(scope.current.id!==id)scope.current={id,serial:0,source:0,locked:false,loaded:false};
  const editInstructions=(value:string|((current:string)=>string))=>{edits.current.instructions++;setInstructions(value);setSaved(false);};
  const editTemplates=(change:(list:Template[])=>Template[])=>{edits.current.templates++;setTemplates(change);setSaved(false);};
  const load=async(discard=false)=>{
    const owner=scope.current;if(owner.locked)return;owner.locked=true;
    const request=++owner.serial,revision={...edits.current};const current=()=>scope.current===owner&&owner.serial===request;setSaving(true);setSaved(false);
    try{
      if(discard&&!await confirm('Discard unsaved project preference edits?',{title:'Refresh project preferences',confirm:'Discard and refresh'}))return;
      if(!current())return;setError('');const p:Preferences=await api('/admin/agent/session/project?id='+encodeURIComponent(id));if(!current())return;
      owner.loaded=true;setData(p);owner.source++;setSource(null);
      if(revision.instructions===edits.current.instructions)setInstructions(p.instructions);
      if(revision.templates===edits.current.templates)setTemplates(p.templates);
    }catch(e:any){if(current())setError(e.message);}finally{if(current()){owner.locked=false;setSaving(false);}}
  };
  useEffect(()=>{const owner=scope.current;setData(null);setSource(null);void load();return()=>{owner.serial++;owner.source++;owner.locked=false;owner.loaded=false;};},[id]);
  const dirty=!!data&&(instructions!==data.instructions||JSON.stringify(templates)!==JSON.stringify(data.templates));
  const save=async()=>{
    const owner=scope.current;if(owner.locked||!owner.loaded||busy||!data||!dirty)return;owner.locked=true;
    const request=++owner.serial,revision={...edits.current},submitted={id,instructions,templates,revision:data.revision,confirm:true};const current=()=>scope.current===owner&&owner.serial===request;setSaving(true);setSaved(false);
    try{
      if(!await confirm('Save this folder’s plain-text Agent instructions and reusable templates? Instructions apply before future messages in all sessions in this folder. Commands and skills are inserted only when you choose them; they never execute shell substitutions or enable project plugins.',{title:'Save project preferences',confirm:'Save preferences',icon:<FileText size={18}/>}))return;
      if(!current())return;setError('');const p:Preferences=await api('/admin/agent/session/project',submitted);if(!current())return;
      setData(p);
      if(revision.instructions===edits.current.instructions)setInstructions(p.instructions);
      if(revision.templates===edits.current.templates)setTemplates(p.templates);
      setSaved(revision.instructions===edits.current.instructions&&revision.templates===edits.current.templates);
    }catch(e:any){if(current())setError(e.message);}finally{if(current()){owner.locked=false;setSaving(false);}}
  };
  const update=(at:number,key:'name'|'text'|'kind',value:string)=>editTemplates(ts=>ts.map((t,i)=>i===at?{...t,[key]:value}:t));
  const preview=async(path:string,hash:string)=>{const owner=scope.current,request=++owner.source;try{const next=await api('/admin/agent/session/project/source',{id,path,hash});if(scope.current===owner&&owner.source===request){setSource(next);setError('');}}catch(e:any){if(scope.current===owner&&owner.source===request)setError(e.message);}};
  return <section className="ag-project"><h3>Project preferences</h3><p className="subtle">Stored by Polygate for this folder. Instructions are applied to future messages; commands and skills are text templates you review before sending. Repository plugins and configuration remain disabled.</p>
    {!data&&!error&&<p className="subtle">Loading project preferences…</p>}
    {data&&<><label>Instructions<textarea dir="auto" aria-label="Project instructions" rows={7} value={instructions} onChange={e=>editInstructions(e.target.value)} placeholder="Coding conventions, preferred test commands, and project context"/></label><p className="subtle">Unsaved edits are discarded when you close this panel or switch workspace tabs.</p>
      <h4>Commands And Skills</h4><p className="subtle">A command is a reusable request; a skill is reusable guidance. Insert adds plain text to the composer. Nothing is sent or run automatically.</p>
      {templates.map((t,i)=><div className="ag-project-template" key={t.id}><h4>{t.name||'New template'}<small>{t.kind}</small></h4>
        <label>Name<input dir="auto" aria-label={`Template ${i+1} name`} maxLength={80} value={t.name} onChange={e=>update(i,'name',e.target.value)}/></label>
        <label>Kind<select aria-label={`Template ${i+1} kind`} value={t.kind} onChange={e=>update(i,'kind',e.target.value)}><option value="command">Command</option><option value="skill">Skill</option></select></label>
        <label>Text<textarea dir="auto" aria-label={`Template ${i+1} text`} rows={6} value={t.text} onChange={e=>update(i,'text',e.target.value)}/></label>
        <div className="button-row"><Button disabled={!t.text.trim()} onClick={()=>onInsert(t.text)}>Insert into message</Button><Button onClick={()=>editTemplates(ts=>ts.filter((_,n)=>n!==i))}><Trash2 size={13}/>Remove</Button></div>
      </div>)}
      <Button disabled={templates.length>=50} onClick={()=>editTemplates(ts=>[...ts,{id:crypto.randomUUID(),kind:'command',name:'',text:''}])}><Plus size={13}/>Add template</Button>
      {!!data.sources.length&&<details className="ag-project-sources"><summary>Review repository text ({data.sources.length})</summary><p className="subtle">Preview only. Import copies text into this editor; Save is still required. No repository files are changed.</p>{data.sources.map(s=><button type="button" key={s.path} onClick={()=>preview(s.path,s.hash)}>{s.path}</button>)}</details>}
      {source&&<section className="ag-project-source"><h4>{source.path}</h4><pre>{source.text}</pre><div className="button-row"><Button onClick={()=>editInstructions(s=>s+(s?'\n\n':'')+source.text)}>Append to instructions</Button><Button disabled={templates.length>=50} onClick={()=>editTemplates(ts=>[...ts,{id:crypto.randomUUID(),kind:/SKILL\.md$/i.test(source.path)?'skill':'command',name:source.path.split('/').slice(-2).join('/'),text:source.text}])}>Import as template</Button></div></section>}
      <div className="button-row ag-project-save"><Button variant="primary" disabled={busy||saving||!dirty} onClick={save}>{saving?'Saving…':'Save preferences'}</Button><Button disabled={saving} onClick={()=>load(dirty)}><RefreshCw size={13}/>Refresh</Button></div>
      {busy&&<p className="subtle">Wait for the session to finish before saving. You can still review or draft text.</p>}{saved&&!dirty&&<p className="green" role="status"><Check size={13}/> Project preferences saved.</p>}
    </>}{error&&<p className="pg-error" role="alert">{error}</p>}{dialog}
  </section>;
}
