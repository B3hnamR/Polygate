import {useEffect,useState} from 'react';
import {Check,FileText,Plus,RefreshCw,Trash2} from 'lucide-react';
import {api} from './api';
import {useConfirm} from './confirm';
import {Button} from './ui';

type Template={id:string;kind:'command'|'skill';name:string;text:string};
type Preferences={instructions:string;templates:Template[];revision:string;sources:{path:string;hash:string;bytes:number}[]};
export function AgentProject({id,busy,onInsert}:{id:string;busy:boolean;onInsert:(text:string)=>void}){
  const [data,setData]=useState<Preferences|null>(null),[instructions,setInstructions]=useState(''),[templates,setTemplates]=useState<Template[]>([]),[error,setError]=useState(''),[saving,setSaving]=useState(false),[saved,setSaved]=useState(false),[source,setSource]=useState<{path:string;text:string}|null>(null);
  const {confirm,dialog}=useConfirm();
  const accept=(p:Preferences)=>{setData(p);setInstructions(p.instructions);setTemplates(p.templates);};
  const load=async()=>{setError('');try{accept(await api('/admin/agent/session/project?id='+encodeURIComponent(id)));setSource(null);}catch(e:any){setError(e.message);}};
  useEffect(()=>{load();},[id]);
  const dirty=!!data&&(instructions!==data.instructions||JSON.stringify(templates)!==JSON.stringify(data.templates));
  const save=async()=>{if(!await confirm('Save this folder’s plain-text Agent instructions and reusable templates? Instructions apply before future messages in all sessions in this folder. Commands and skills are inserted only when you choose them; they never execute shell substitutions or enable project plugins.',{title:'Save project preferences',confirm:'Save preferences',icon:<FileText size={18}/>}))return;setSaving(true);setError('');setSaved(false);try{accept(await api('/admin/agent/session/project',{id,instructions,templates,revision:data?.revision,confirm:true}));setSaved(true);}catch(e:any){setError(e.message);}finally{setSaving(false);}};
  const update=(at:number,key:'name'|'text'|'kind',value:string)=>{setSaved(false);setTemplates(ts=>ts.map((t,i)=>i===at?{...t,[key]:value}:t));};
  return <section className="ag-project"><h3>Project preferences</h3><p className="subtle">Stored by Polygate for this folder. Instructions are applied to future messages; commands and skills are text templates you review before sending. Repository plugins and configuration remain disabled.</p>
    {!data&&!error&&<p className="subtle">Loading project preferences…</p>}
    {data&&<><label>Instructions<textarea dir="auto" aria-label="Project instructions" rows={7} value={instructions} onChange={e=>{setInstructions(e.target.value);setSaved(false);}} placeholder="Coding conventions, preferred test commands, and project context"/></label><p className="subtle">Unsaved edits are discarded when you close this panel or switch workspace tabs.</p>
      <h4>Commands And Skills</h4><p className="subtle">A command is a reusable request; a skill is reusable guidance. Insert adds plain text to the composer. Nothing is sent or run automatically.</p>
      {templates.map((t,i)=><div className="ag-project-template" key={t.id}><h4>{t.name||'New template'}<small>{t.kind}</small></h4>
        <label>Name<input dir="auto" aria-label={`Template ${i+1} name`} maxLength={80} value={t.name} onChange={e=>update(i,'name',e.target.value)}/></label>
        <label>Kind<select aria-label={`Template ${i+1} kind`} value={t.kind} onChange={e=>update(i,'kind',e.target.value)}><option value="command">Command</option><option value="skill">Skill</option></select></label>
        <label>Text<textarea dir="auto" aria-label={`Template ${i+1} text`} rows={6} value={t.text} onChange={e=>update(i,'text',e.target.value)}/></label>
        <div className="button-row"><Button disabled={!t.text.trim()} onClick={()=>onInsert(t.text)}>Insert into message</Button><Button onClick={()=>setTemplates(ts=>ts.filter((_,n)=>n!==i))}><Trash2 size={13}/>Remove</Button></div>
      </div>)}
      <Button disabled={templates.length>=50} onClick={()=>setTemplates(ts=>[...ts,{id:crypto.randomUUID(),kind:'command',name:'',text:''}])}><Plus size={13}/>Add template</Button>
      {!!data.sources.length&&<details className="ag-project-sources"><summary>Review repository text ({data.sources.length})</summary><p className="subtle">Preview only. Import copies text into this editor; Save is still required. No repository files are changed.</p>{data.sources.map(s=><button type="button" key={s.path} onClick={async()=>{try{setSource(await api('/admin/agent/session/project/source',{id,path:s.path,hash:s.hash}));setError('');}catch(e:any){setError(e.message);}}}>{s.path}</button>)}</details>}
      {source&&<section className="ag-project-source"><h4>{source.path}</h4><pre>{source.text}</pre><div className="button-row"><Button onClick={()=>setInstructions(s=>s+(s?'\n\n':'')+source.text)}>Append to instructions</Button><Button disabled={templates.length>=50} onClick={()=>setTemplates(ts=>[...ts,{id:crypto.randomUUID(),kind:/SKILL\.md$/i.test(source.path)?'skill':'command',name:source.path.split('/').slice(-2).join('/'),text:source.text}])}>Import as template</Button></div></section>}
      <div className="button-row ag-project-save"><Button variant="primary" disabled={busy||saving||!dirty} onClick={save}>{saving?'Saving…':'Save preferences'}</Button><Button disabled={saving} onClick={async()=>{if(dirty&&!await confirm('Discard unsaved project preference edits?',{title:'Refresh project preferences',confirm:'Discard and refresh'}))return;await load();}}><RefreshCw size={13}/>Refresh</Button></div>
      {busy&&<p className="subtle">Wait for the session to finish before saving. You can still review or draft text.</p>}{saved&&!dirty&&<p className="green" role="status"><Check size={13}/> Project preferences saved.</p>}
    </>}{error&&<p className="pg-error" role="alert">{error}</p>}{dialog}
  </section>;
}
