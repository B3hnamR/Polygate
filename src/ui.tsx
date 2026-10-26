import {useState,useEffect,useCallback,useRef,useId,Children,Fragment,isValidElement,type ReactNode,type KeyboardEvent} from 'react';
import {Activity,Box,Check,ChevronDown} from 'lucide-react';
import {api} from './api';
import type {LogRow,Model,Settings} from '../backend/types';
export type Snapshot={settings:Settings;models:Model[];logs:LogRow[];stats:any;queue:{active:number;waiting:number};identity:any;proxy:any;ready:{ready:boolean;models:number;routes:number};notices:number;server:{platform:string;mode:string};version:string;runtime:string;routeInfo:Record<string,{role:'active'|'backup'|'off';label:string;tone:string;detail:string}>;backup:{id:string;name:string;usable:boolean;why:string}[]};
export const ms=(n:number)=>n?`${Math.round(n).toLocaleString()} ms`:'—';
export const time=(n:number)=>new Date(n).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
export const statusState=(n:number)=>n<400?'available':n===429||n===499?'cooldown':'error';
export function Button({children,onClick,variant='',disabled=false,className='',title='',type='button'}:{children:ReactNode;onClick?:()=>void;variant?:string;disabled?:boolean;className?:string;title?:string;type?:'button'|'submit'}){return <button type={type} title={title} disabled={disabled} className={`button ${variant} ${className}`} onClick={onClick}>{children}</button>;}
export function Badge({state,children}:{state:string;children?:ReactNode}){return <span className={`badge ${['available','healthy','running','200'].includes(state)?'good':['cooldown','429','buffered'].includes(state)?'warn':['unavailable','error','502','403'].includes(state)?'bad':'neutral'}`}><i/>{sentence(children||state)}</span>;}
// Only the first letter is capitalized, so a label such as "No clean proxy yet" reads as a sentence.
const sentence=(node:ReactNode):ReactNode=>{if(typeof node==='string')return node.charAt(0).toUpperCase()+node.slice(1);if(Array.isArray(node)){const i=node.findIndex(x=>typeof x==='string'&&x);return i<0?node:node.map((x,j)=>j===i?sentence(x):x);}return node;};
export function Empty({icon:Icon=Box,title,children,action}:{icon?:any;title:string;children:ReactNode;action?:ReactNode}){return <div className="empty"><Icon size={28}/><h3>{title}</h3><p>{children}</p>{action}</div>;}
export function Field({label,hint,children}:{label:string;hint?:string;children:ReactNode}){return <label className="field"><span>{label}</span>{children}{hint&&<small>{hint}</small>}</label>;}
export function Toggle({checked,onChange,label,detail,name}:{checked:boolean;onChange:(x:boolean)=>void;label:string;detail?:string;name?:string}){const tip=name?`${name}: ${label}`:undefined;return <label className="toggle-row"><span><strong>{label}</strong>{detail&&<small>{detail}</small>}</span><input type="checkbox" role="switch" checked={checked} aria-label={tip} title={tip} onChange={e=>onChange(e.target.checked)}/></label>;}
export function Logs({rows,compact=false,onSelect,selected}:{rows:LogRow[];compact?:boolean;onSelect?:(r:LogRow)=>void;selected?:string}){return rows.length?<div className="table-wrap"><table><thead><tr><th>Time</th><th>Model</th><th>Protocol</th>{!compact&&<th>Route</th>}<th>Result</th><th className="numeric">Duration</th></tr></thead><tbody>{rows.slice(0,compact?7:150).map(r=>{const go=onSelect&&r.hasDetail?()=>onSelect(r):undefined;return <tr key={r.id} title={r.error||'Request completed'} className={[go?'clickable':'',selected===r.id?'selected':''].join(' ').trim()||undefined} onClick={go} role={go&&'button'} tabIndex={go&&0} onKeyDown={go&&(e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();go();}})}><td className="mono muted">{time(r.time)}</td><td className="truncate" title={r.model}>{r.model}</td><td><span className="protocol">{r.protocol}</span></td>{!compact&&<td>{r.route||'—'}</td>}<td><Badge state={statusState(r.status)}>{r.status}{r.status>=400?' · failed':' · complete'}</Badge></td><td className="numeric mono">{ms(r.ms)}</td></tr>;})}</tbody></table></div>:<Empty icon={Activity} title="Waiting for the first request">Connect a client or send a message in the playground. Actual activity will appear here.</Empty>;}
export const when=(t:number)=>{if(!t)return '—';const d=Date.now()-t;if(d<60000)return 'just now';if(d<3600000)return Math.round(d/60000)+' min ago';if(d<86400000)return Math.round(d/3600000)+' h ago';return new Date(t).toLocaleDateString();};
export const compact=(n:number)=>n>=1e9?(n/1e9).toFixed(1)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(Math.round(n||0));
// Runs `fn` now and every `every` ms, but only while the window is visible; it runs again at once when the window comes back.
// A tick is skipped while the previous call is still running, so a slow gateway is not sent a growing pile of requests.
export function tickWhileVisible(fn:()=>unknown,every:number){let busy=false;const tick=()=>{if(document.hidden||busy)return;busy=true;Promise.resolve().then(fn).catch(()=>{}).finally(()=>{busy=false;});};tick();const id=setInterval(tick,every);document.addEventListener('visibilitychange',tick);return()=>{clearInterval(id);document.removeEventListener('visibilitychange',tick);};}
// Polls an admin endpoint while the component is mounted; `reload` refreshes immediately after an action.
export function usePoll<T>(path:string,every:number,enabled=true){
  const [box,setBox]=useState<{path:string;value:T}|null>(null);const [error,setError]=useState('');const seq=useRef({path,sent:0,applied:0});
  // A response is dropped if a newer one was already applied or the path changed meanwhile.
  const reload=useCallback(async()=>{
    if(seq.current.path!==path)seq.current={path,sent:0,applied:0};const s=seq.current,id=++s.sent;const fresh=()=>s===seq.current&&id>s.applied;
    try{const next=await api(path);if(fresh()){s.applied=id;setBox({path,value:next});setError('');}}catch(e:any){if(fresh())setError(e.message);}
  },[path]);
  useEffect(()=>{if(!enabled)return;return tickWhileVisible(reload,every);},[reload,every,enabled]);
  // The previous path's data stays visible while the new one loads (no flash when paging), but not once loading it has failed.
  return {data:box&&(box.path===path||!error)?box.value:null,error,reload};
}
export function Progress({value,label}:{value:number;label?:string}){return <div className="progress" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100} aria-label={label}><i style={{width:Math.max(2,Math.min(100,value))+'%'}}/></div>;}
// Left and right arrows move between the tabs of a tablist whose selected tab is its only tab stop.
export const tabKeys=(e:KeyboardEvent<HTMLElement>)=>{const d=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;const tabs=[...e.currentTarget.querySelectorAll<HTMLElement>('[role=tab]')];const i=tabs.indexOf(e.target as HTMLElement);if(!d||i<0)return;e.preventDefault();const t=tabs[(i+d+tabs.length)%tabs.length];t.focus();t.click();};
// A dropdown in the app's own style (the browser's native list ignores the theme). It reads plain <option> children, so a
// <select> becomes a <Select> without restructuring. Keyboard: arrows, Home/End, Enter/Space, Escape, type to jump.
type Opt={value:string;label:string;disabled?:boolean};
function readOptions(children:ReactNode,out:Opt[]=[]):Opt[]{
  Children.forEach(children,child=>{
    if(!isValidElement(child))return;const props:any=child.props;
    if(child.type===Fragment)readOptions(props.children,out);
    else if(child.type==='option'){const label=Children.toArray(props.children).join('');out.push({value:String(props.value??label),label,disabled:!!props.disabled});}
  });return out;
}
export function Select({value,onChange,children,className='',disabled,...rest}:{value:string|number|undefined;onChange:(value:string)=>void;children:ReactNode;className?:string;disabled?:boolean;'aria-label'?:string;title?:string}){
  const options=readOptions(children);const current=String(value??'');const selected=options.find(o=>o.value===current);
  const [open,setOpen]=useState(false);const [active,setActive]=useState(-1);const [up,setUp]=useState(false);
  const root=useRef<HTMLDivElement>(null);const list=useRef<HTMLUListElement>(null);const typed=useRef({text:'',at:0});const id=useId();
  const enabled=(i:number)=>i>=0&&i<options.length&&!options[i].disabled;
  const openMenu=()=>{if(disabled)return;const box=root.current?.getBoundingClientRect();setUp(!!box&&window.innerHeight-box.bottom<Math.min(300,options.length*34+12)&&box.top>window.innerHeight-box.bottom);setActive(Math.max(0,options.findIndex(o=>o.value===current)));setOpen(true);};
  const close=()=>setOpen(false);
  const pick=(i:number)=>{if(!enabled(i))return;const o=options[i];close();if(o.value!==current)onChange(o.value);};
  useEffect(()=>{if(!open)return;const away=(e:MouseEvent)=>{if(!root.current?.contains(e.target as Node))close();};document.addEventListener('mousedown',away);return()=>document.removeEventListener('mousedown',away);},[open]);
  useEffect(()=>{if(open)list.current?.querySelector('[data-active="true"]')?.scrollIntoView({block:'nearest'});},[open,active]);
  const move=(from:number,step:number)=>{let i=from;for(let n=0;n<options.length;n++){i=(i+step+options.length)%options.length;if(enabled(i))return i;}return from;};
  function onKey(e:KeyboardEvent<HTMLButtonElement>){
    if(disabled)return;
    if(!open){if(['ArrowDown','ArrowUp','Enter',' '].includes(e.key)){e.preventDefault();openMenu();}return;}
    if(e.key==='Escape'){e.preventDefault();close();}
    else if(e.key==='ArrowDown'){e.preventDefault();setActive(a=>move(a,1));}
    else if(e.key==='ArrowUp'){e.preventDefault();setActive(a=>move(a,-1));}
    else if(e.key==='Home'){e.preventDefault();setActive(move(-1,1));}
    else if(e.key==='End'){e.preventDefault();setActive(move(options.length,-1));}
    else if(e.key==='Enter'||e.key===' '){e.preventDefault();pick(active);}
    else if(e.key==='Tab')close();
    else if(e.key.length===1&&!e.ctrlKey&&!e.metaKey){const now=Date.now();typed.current={text:(now-typed.current.at<700?typed.current.text:'')+e.key.toLowerCase(),at:now};const hit=options.findIndex(o=>!o.disabled&&o.label.toLowerCase().startsWith(typed.current.text));if(hit>=0)setActive(hit);}
  }
  return <div ref={root} className={`select ${open?'open':''} ${up?'up':''} ${className}`.trim()}>
    <button type="button" className="select-trigger" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open?id:undefined} aria-activedescendant={open&&active>=0?`${id}-${active}`:undefined} disabled={disabled} {...rest} onClick={e=>{e.preventDefault();open?close():openMenu();}} onKeyDown={onKey}>
      <span className="select-value">{selected?.label??current}</span><ChevronDown size={15} className="select-chevron" aria-hidden="true"/>
    </button>
    {open&&<ul ref={list} id={id} className="select-menu" role="listbox" aria-label={rest['aria-label']}>
      {options.map((o,i)=><li key={o.value+i} id={`${id}-${i}`} role="option" aria-selected={o.value===current} aria-disabled={o.disabled||undefined} data-active={i===active} className={`${o.value===current?'chosen':''} ${o.disabled?'disabled':''}`.trim()} onMouseEnter={()=>enabled(i)&&setActive(i)} onMouseDown={e=>e.preventDefault()} onClick={e=>{e.preventDefault();pick(i);}}><span>{o.label}</span>{o.value===current&&<Check size={14} aria-hidden="true"/>}</li>)}
    </ul>}
  </div>;
}
