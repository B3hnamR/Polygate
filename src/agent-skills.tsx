import {useEffect,useState} from 'react';
import {BookOpen,FileText,Loader2,X} from 'lucide-react';
import {api} from './api';
import {menuEntries,type MenuChoice,type MenuEntry,type SkillOffer,type SkillPick} from './agent-logic';

// The list under the message box: Polygate's skills (attached to the message), the engine's built-in skills, and this folder's templates
// from its Project tab (inserted as text). Keyboard handling stays with the message box, which passes the highlighted row.
export function SkillMenu({folder,query,picked,active,onActive,onEntries,onPick,onClose}:{folder:string;query:string;picked:SkillPick[];active:number;onActive:(n:number)=>void;onEntries:(e:MenuEntry[])=>void;onPick:(c:MenuChoice)=>void;onClose:()=>void}){
  const [offer,setOffer]=useState<SkillOffer|null>(null),[error,setError]=useState('');
  useEffect(()=>{let live=true;api('/admin/agent/skills?folder='+encodeURIComponent(folder)).then(o=>{if(live)setOffer(o);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[folder]);
  const entries=offer?menuEntries(offer,query,picked):[];
  useEffect(()=>{onEntries(entries);},[offer,query,picked.length]);
  return <div className="ag-skill-menu" role="listbox" aria-label="Skills and templates">
    <div className="ag-skill-menu-head"><BookOpen size={14}/><span>Skills and templates</span><button type="button" className="icon-button" aria-label="Close skill list" onClick={onClose}><X size={13}/></button></div>
    {!offer&&!error&&<p className="subtle"><Loader2 size={13} className="spin"/> Loading…</p>}
    {error&&<p className="pg-error">{error}</p>}
    {offer&&!offer.running&&<p className="subtle">Skills are listed once the agent engine runs.</p>}
    {offer&&!entries.length&&<p className="subtle">{query?`Nothing matches “${query}”.`:'No skills yet. Add them in Agent settings → Skills, or folder templates in this session’s Project tab.'}</p>}
    {entries.map((e,i)=><button type="button" role="option" aria-selected={i===active} key={e.key} className={i===active?'active':undefined} onMouseEnter={()=>onActive(i)} onMouseDown={ev=>ev.preventDefault()} onClick={()=>onPick(e.choice)}>
      {e.choice.kind==='skill'?<BookOpen size={14}/>:<FileText size={14}/>}<span><strong dir="auto">{e.title}</strong>{e.detail&&<small dir="auto">{e.detail}</small>}</span><em>{e.tag}</em>
    </button>)}
  </div>;
}
export function SkillChips({skills,remove}:{skills:SkillPick[];remove?:(id:string)=>void}){
  return <ul className="ag-skill-chips" aria-label="Attached skills">{skills.map(s=><li key={s.id}><BookOpen size={12}/><span dir="auto">{s.name}</span>
    {remove&&<button type="button" className="icon-button" aria-label={`Remove skill ${s.name}`} onClick={()=>remove(s.id)}><X size={12}/></button>}</li>)}</ul>;
}
