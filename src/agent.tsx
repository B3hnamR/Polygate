import {useCallback,useEffect,useMemo,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import {ArrowLeft,ArrowUp,Bot,Check,CheckCircle2,ChevronDown,ChevronRight,Circle,Cpu,Download,Folder,FolderOpen,ListChecks,Loader2,Pencil,Play,Plus,RefreshCw,Search,Settings2,ShieldAlert,ShieldCheck,Square,Trash2,TriangleAlert,Undo2,X} from 'lucide-react';
import {api,at} from './api';
import {Button,Progress,Toggle,compact,usePoll,when} from './ui';
import {MODES,modeLabel,fromHistory,applyEvent,approvalTitle,toolSubject,withChanges,undoBlocked,modelProviders,matchModels,folderName,blocks,stepsSummary,latestTodos,type Approval,type Block,type Item,type Mode,type Todo,type Tool} from './agent-logic';
import {useConfirm} from './confirm';
import {Dialog} from './mcp';
import {Markdown} from './markdown';
import {plainError} from '../backend/plain-error';
// The Agent (docs/agent/PLAN.md): a coding agent working in folders the user chooses, through Polygate's own models. It takes the whole
// window: the sessions of every folder on the left, one conversation in the middle, and the model and mode beside the message box.
// Everything goes through the agent controller (backend/agent.ts); the page never talks to the engine itself. Desktop app only.

type Engine={state:string;installed:boolean;version:string;message:string;problems:string[];progress?:number;backups?:boolean;snapshots?:{ok:boolean;reason?:string};freeIdentity?:{presented:string;engine:string;usable:boolean}};
type AgentModel={id:string;name:string;provider:string;context:number;output:number;reasoning:boolean;efforts:string[];usable:boolean;reason?:string};
type Models={models:AgentModel[];modes:Record<string,string>};
type RouteUsage={requests:number;errors:number;input:number;output:number;last:number;routes:{route:string;requests:number}[]};
type SessionInfo={id:string;title:string;mode:Mode|'';model:string;effort:string;folder:string;created?:number;tokens?:{input:number;output:number;reasoning?:number;cache?:{read:number;write:number}}};
type FolderInfo={folder:string;trusted:boolean};
// What a new session hands to its first view: a message that could not be sent, or a note about its backup.
type Opening={draft?:string;error?:string;notice?:string};
const cap=(s:string)=>s.charAt(0).toUpperCase()+s.slice(1);
const sameFolder=(a:string,b:string)=>a.replace(/\\/g,'/').replace(/\/$/,'').toLowerCase()===b.replace(/\\/g,'/').replace(/\/$/,'').toLowerCase();
// Remembered on this computer only: the open session, and the folder, model and mode the next new session starts with.
const stored=(key:string)=>{try{return localStorage.getItem(key)||'';}catch{return '';}};
const store=(key:string,value:string)=>{try{localStorage.setItem(key,value);}catch{/* storage can be off */}};
const LIMITED='This folder is bigger than one backup covers (20,000 files, 256 MB, files up to 8 MB each). Changes to the files left out cannot be undone from Polygate.';

const ENGINE_LABEL:Record<string,string>={not_installed:'Not installed',installing:'Downloading',installed:'Off',starting:'Starting',restarting:'Restarting',running:'Running',stopping:'Stopping',failed:'Stopped with a problem'};
const engineTone=(s:string)=>s==='running'?'good':s==='failed'?'bad':['installing','starting','restarting','stopping'].includes(s)?'warn':'';

export function AgentApp({onBack}:{onBack:()=>void}){
  const {data:engine,error:engineError,reload:reloadEngine}=usePoll<Engine>('/admin/agent/engine',2000);
  const running=engine?.state==='running';
  const {data:list,error:listError,reload:reloadList}=usePoll<{sessions:SessionInfo[]}>('/admin/agent/sessions',10000,running);
  const {data:models,reload:reloadModels}=usePoll<Models>('/admin/agent/models',60000);
  // Resync in the model picker: the engine is given the models added since it started.
  const resync=async()=>{const r=await api('/admin/agent/models/sync',{});reloadModels();return Number(r.models)||0;};
  const {data:folderList,reload:reloadFolders}=usePoll<{folders:FolderInfo[]}>('/admin/agent/folders',15000);
  const [open,setOpen]=useState(()=>stored('polygate-agent-open'));const [fresh,setFresh]=useState<{info:SessionInfo;opening:Opening}|null>(null);
  const [settings,setSettings]=useState(false);const [problem,setProblem]=useState('');
  const [busy,setBusy]=useState('');
  const act=async(path:string,label:string)=>{setBusy(label);setProblem('');try{await api(path,{});}catch(e:any){setProblem(e.message);}finally{setBusy('');reloadEngine();}};
  const choose=(id:string)=>{setOpen(id);store('polygate-agent-open',id);if(fresh?.info.id!==id)setFresh(null);};
  const sessions=list?.sessions||[];
  const info=sessions.find(s=>s.id===open)||(fresh?.info.id===open?fresh.info:undefined);
  // Sessions grouped by their folder, the folder with the newest session first (the list comes newest first).
  const groups=useMemo(()=>{const out=new Map<string,SessionInfo[]>();for(const s of sessions){const k=[...out.keys()].find(f=>sameFolder(f,s.folder))??s.folder;out.set(k,[...(out.get(k)||[]),s]);}return [...out.entries()];},[sessions]);
  const {confirm,dialog}=useConfirm();
  const remove=async(s:SessionInfo)=>{
    if(!await confirm(<>Delete <strong>{s.title}</strong>? Its conversation and Polygate's records of what it changed (and its undo) are removed. The files in <code>{s.folder}</code> are not changed.</>,{title:'Delete session',confirm:'Delete session'}))return;
    setProblem('');try{await api('/admin/agent/session/delete',{id:s.id});if(s.id===open)choose('');reloadList();}catch(e:any){setProblem(e.message);}
  };
  const main=!engine?<div className="ag-center">{engineError?<div className="pg-error">{engineError}</div>:<p className="subtle ag-loading"><Loader2 className="spin" size={15}/> Checking the agent engine…</p>}</div>
    :!running?<div className="ag-center"><div className="ag-column"><div className="ag-card"><EngineCard engine={engine} busy={busy} act={act}/></div></div></div>
    :!list&&!listError&&open&&!info?<div className="ag-center"><p className="subtle ag-loading"><Loader2 className="spin" size={15}/> Loading sessions…</p></div>
    :info?<SessionView key={info.id} start={info} opening={fresh?.info.id===info.id?fresh.opening:undefined} models={models} onResync={resync} onChanged={reloadList} onDeleted={()=>{choose('');reloadList();}}/>
    :<NewSession models={models} folders={folderList?.folders||[]} reloadFolders={reloadFolders} onResync={resync} onCreated={(s,opening)=>{setFresh({info:s,opening});setOpen(s.id);store('polygate-agent-open',s.id);reloadList();reloadFolders();}}/>;
  return <div className="ag-app">
    <aside className="ag-side" aria-label="Agent sessions">
      <div className="ag-side-head"><button className="ag-back" onClick={onBack} title="Back to Polygate"><ArrowLeft size={16}/>Polygate</button><span className="ag-side-title"><Bot size={17}/>Agent</span></div>
      <button className={`ag-new${running&&!info?' active':''}`} onClick={()=>choose('')} disabled={!running}><Plus size={16}/>New session</button>
      <nav className="ag-sessions">
        {groups.map(([folder,items])=><section key={folder} className="ag-group">
          <h3 title={folder}><Folder size={13}/><span className="truncate">{folderName(folder)}</span></h3>
          <ul>{items.map(s=><li key={s.id} className={s.id===info?.id?'active':''}>
            <button className="ag-session" aria-current={s.id===info?.id?'true':undefined} onClick={()=>choose(s.id)} title={`${s.title}\n${s.folder}`}><span className="truncate">{s.title}</span><small>{when(s.created||0)}{s.mode?` · ${modeLabel(s.mode)}`:''}</small></button>
            <button className="icon-button danger ag-session-delete" aria-label={`Delete session ${s.title}`} title="Delete session" onClick={()=>remove(s)}><Trash2 size={14}/></button>
          </li>)}</ul>
        </section>)}
        {running&&list&&!sessions.length&&<p className="ag-side-empty">No sessions yet. Start one with a working folder, a model and a message.</p>}
        {running&&listError&&<p className="pg-error">{listError}</p>}
      </nav>
      <div className="ag-side-foot">
        <span className={`ag-dot ${engineTone(engine?.state||'')}`}/><span className="truncate">{engine?`Engine ${(ENGINE_LABEL[engine.state]||engine.state).toLowerCase()}`:'Engine'}</span>
        <span className="toolbar-spacer"/>
        <button className="icon-button" aria-label="Agent settings" title="Agent settings" onClick={()=>setSettings(true)}><Settings2 size={17}/></button>
      </div>
    </aside>
    <main className="ag-main">
      {problem&&<div className="pg-error ag-problem" role="alert"><span>{problem}</span><button className="icon-button" aria-label="Dismiss" onClick={()=>setProblem('')}><X size={14}/></button></div>}
      {main}
    </main>
    {settings&&<AgentSettings engine={engine||null} busy={busy} act={act} folders={folderList?.folders||[]} reloadEngine={reloadEngine} reloadFolders={reloadFolders} onClose={()=>setSettings(false)}/>}
    {dialog}
  </div>;
}

// The engine's state with the one action it needs now: install, start or stop.
function EngineCard({engine,busy,act}:{engine:Engine;busy:string;act:(path:string,label:string)=>void}){
  const s=engine.state;const running=s==='running';const working=['installing','starting','restarting','stopping'].includes(s)||!!busy;
  return <div className="ag-engine">
    <div className="ag-engine-head">
      <span className={`ag-dot ${engineTone(s)}`}/><div><strong>Agent engine</strong> <span className="subtle">OpenCode {engine.version}</span><small className="subtle">{s==='installing'?`Downloading ${engine.progress??0}%`:ENGINE_LABEL[s]||s}</small></div>
      <span className="toolbar-spacer"/>
      {s==='not_installed'&&<Button variant="primary" disabled={working} onClick={()=>act('/admin/agent/engine/install','install')}><Download size={15}/>Install</Button>}
      {(s==='installed'||s==='failed')&&<Button variant="primary" disabled={working} onClick={()=>act('/admin/agent/engine/start','start')}>{busy==='start'?<Loader2 className="spin" size={15}/>:<Play size={15}/>}Start</Button>}
      {(running||s==='restarting')&&<Button disabled={working} onClick={()=>act('/admin/agent/engine/stop','stop')}><Square size={14}/>Stop</Button>}
      {working&&!busy&&<Loader2 className="spin" size={16}/>}
    </div>
    {s==='not_installed'&&<p className="subtle">The agent runs on OpenCode, an open-source coding agent. Polygate downloads its pinned version once from npm (about 100 MB), checks it against the published checksum, and runs it on this computer only. Its model requests go through Polygate under its own key.</p>}
    {s==='installing'&&<Progress value={engine.progress||0} label="Downloading the agent engine"/>}
    {s==='installed'&&<p className="subtle">Start the engine to work with the agent. Other clients are not affected by it.</p>}
    {engine.message&&!running&&<p className={s==='failed'?'agent-error-text':'subtle'}>{engine.message}</p>}
    {engine.problems?.length>0&&<ul className="agent-problems">{engine.problems.map(p=><li key={p}>{p}</li>)}</ul>}
    {running&&engine.snapshots&&!engine.snapshots.ok&&<p className="agent-warn"><TriangleAlert size={15}/>Engine snapshots are unavailable: {engine.snapshots.reason} Polygate uses its own exact file backups for recorded turns.</p>}
    {running&&engine.freeIdentity&&!engine.freeIdentity.usable&&<p className="agent-warn"><TriangleAlert size={15}/>OpenCode Free models are unavailable to the agent: OpenCode Free now expects OpenCode {engine.freeIdentity.presented}, and the agent runs {engine.freeIdentity.engine}.</p>}
  </div>;
}

// Settings that belong to the agent alone: its engine, folder backups for undo, and the folders it may work in.
function AgentSettings({engine,busy,act,folders,reloadEngine,reloadFolders,onClose}:{engine:Engine|null;busy:string;act:(path:string,label:string)=>void;folders:FolderInfo[];reloadEngine:()=>void;reloadFolders:()=>void;onClose:()=>void}){
  const [error,setError]=useState('');const [backups,setBackups]=useState<boolean|null>(null);const {confirm,dialog}=useConfirm();
  const on=backups??!!engine?.backups;
  const switchBackups=async(next:boolean)=>{setBackups(next);setError('');try{await api('/admin/settings',{agentBackups:next});reloadEngine();}catch(e:any){setBackups(null);setError(e.message);}};
  const revoke=async(folder:string)=>{
    if(!await confirm(<>Stop running turns in <code>{folder}</code> and require consent again before another message there? Saved project rules remain stored.</>,{title:'Revoke folder trust',confirm:'Revoke and stop',icon:<ShieldAlert size={18}/>}))return;
    setError('');try{await api('/admin/agent/trust/revoke',{folder});reloadFolders();}catch(e:any){setError(e.message);}
  };
  return <Dialog title="Agent settings" icon={<Settings2 size={18}/>} onClose={onClose} wide>
    <section className="ag-set"><h3>Engine</h3>{engine?<EngineCard engine={engine} busy={busy} act={act}/>:<p className="subtle">Checking the agent engine…</p>}</section>
    <section className="ag-set"><h3>Undo</h3>
      <Toggle checked={on} onChange={switchBackups} label="Back up the working folder before each message"
        detail="Lets you undo what the agent changed in a turn. Before each message Polygate copies the folder's files it has not copied yet: up to 20,000 files and 256 MB, files up to 8 MB each. Off: nothing is copied, and new turns cannot be undone from Polygate. Switching it off removes the copies only it kept; turns already recorded keep their undo."/>
    </section>
    <section className="ag-set"><h3>Working folders</h3>
      {folders.length?<ul className="ag-folders">{folders.map(f=><li key={f.folder}><Folder size={15}/><div><code title={f.folder}>{f.folder}</code><small className={f.trusted?'green':'amber'}>{f.trusted?'Allowed':'Needs review before the next message'}</small></div>{f.trusted&&<Button onClick={()=>revoke(f.folder)}>Revoke</Button>}</li>)}</ul>
        :<p className="subtle">No folders yet. A folder is added when you allow the agent to work in it.</p>}
    </section>
    {error&&<div className="pg-error">{error}</div>}
    {dialog}
  </Dialog>;
}

type TrustReport={folder:string;fingerprint:string;trusted:boolean;complete:boolean;files:{path:string;behavior:'disabled'|'instructions';bytes:number}[];problems:string[]};
// Consent for one folder, asked before the agent first works in it and again whenever its project customization changes.
function FolderTrust({folder,report,error,reload}:{folder:string;report:TrustReport|null;error:string;reload:()=>void}){
  const [busy,setBusy]=useState(false);const [problem,setProblem]=useState('');const {confirm,dialog}=useConfirm();
  const allow=async()=>{
    if(!report||!await confirm(<>Allow the agent to work in <code>{folder}</code>? It may read project instructions. Approved commands run project code with your account's access. Project plugins, commands and permission overrides remain disabled; this consent does not enable them. This is not a sandbox.</>,{title:'Allow working folder',confirm:'Allow this folder',icon:<ShieldCheck size={18}/>}))return;
    setBusy(true);setProblem('');try{await api('/admin/agent/trust/allow',{folder,fingerprint:report.fingerprint});reload();}catch(e:any){setProblem(e.message);reload();}finally{setBusy(false);}
  };
  return <div className="agent-folder-trust">
    <p className="agent-warn"><ShieldCheck size={14}/><span>{report?<>Review <code>{folder}</code> before the agent works in it. Its project instructions or customization may be new or changed.</>:'Checking project customization…'}</span></p>
    {report&&<><details><summary>Project customization ({report.files.length})</summary><p className="subtle">Instructions may affect the agent. Repository plugins, commands and permission settings remain disabled.</p>
      {report.files.length?<ul>{report.files.map(f=><li key={f.path}><code>{f.path}</code><small>{f.behavior==='instructions'?'Project instructions':'Not loaded'}</small></li>)}</ul>:<p className="subtle">No customization was found in the checked project locations.</p>}
      {report.problems.map(p=><p className="agent-error-text" key={p}>{p}</p>)}</details>
      <Button variant="primary" disabled={busy||!report.complete} onClick={allow}>{busy?'Working…':'Review and allow'}</Button></>}
    {(error||problem)&&<p className="pg-error">{problem||error}</p>}{dialog}
  </div>;
}

// A small button beside the message box that opens a panel above (or below, where there is more room) it. The panel is placed on the
// screen itself, kept inside the window, so no scrolling area around the button can cut it off.
function Popover({label,icon,title,disabled,width=320,children}:{label:ReactNode;icon?:ReactNode;title:string;disabled?:boolean;width?:number;children:(close:()=>void)=>ReactNode}){
  const [open,setOpen]=useState(false);const [place,setPlace]=useState<CSSProperties>({});const root=useRef<HTMLDivElement>(null);const panel=useRef<HTMLDivElement>(null);
  const toggle=()=>{
    if(open||!root.current){setOpen(false);return;}
    const r=root.current.getBoundingClientRect();const above=r.top-16,below=window.innerHeight-r.bottom-16;const up=above>=Math.min(440,below)||above>below;
    const w=Math.min(width,window.innerWidth-32);
    setPlace({width:w,left:Math.max(16,Math.min(r.left,window.innerWidth-16-w)),maxHeight:Math.max(180,Math.min(460,up?above:below)),...(up?{bottom:window.innerHeight-r.top+6}:{top:r.bottom+6})});setOpen(true);
  };
  useEffect(()=>{
    if(!open)return;
    const close=()=>setOpen(false);
    const away=(e:MouseEvent)=>{const t=e.target as Node;if(!root.current?.contains(t)&&!panel.current?.contains(t))close();};
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();close();}};
    const scrolled=(e:Event)=>{if(!(e.target instanceof Node&&panel.current?.contains(e.target)))close();};
    document.addEventListener('mousedown',away);document.addEventListener('keydown',key);window.addEventListener('scroll',scrolled,true);window.addEventListener('resize',close);
    return()=>{document.removeEventListener('mousedown',away);document.removeEventListener('keydown',key);window.removeEventListener('scroll',scrolled,true);window.removeEventListener('resize',close);};
  },[open]);
  return <div ref={root} className="ag-pop">
    <button type="button" className={`ag-chip${open?' open':''}`} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} title={title} onClick={toggle}>{icon}<span className="truncate">{label}</span><ChevronDown size={13}/></button>
    {open&&<div ref={panel} className="ag-pop-panel" role="dialog" aria-label={title} style={place}>{children(()=>setOpen(false))}</div>}
  </div>;
}

// What Full access means, said each time it is switched on (when a session starts in it, or inside one).
const FULL_WARNING=<>The agent will run commands and access files and the internet without ordinary approval prompts, with your account's access, including access to Polygate's data. This is not a sandbox. Full access ends after this turn, or when the app or engine restarts.</>;
// The one place the mode is chosen. The caller asks for confirmation before Full access.
function ModeChip({mode,modes,disabled,onPick}:{mode:Mode;modes:Record<string,string>;disabled?:boolean;onPick:(mode:Mode)=>void}){
  return <Popover icon={mode==='full'?<TriangleAlert size={14}/>:<ShieldCheck size={14}/>} label={modeLabel(mode)} title={disabled?'Stop the turn and answer waiting approvals before changing mode':'Permission mode'} disabled={disabled} width={360}>
    {close=><ul className="ag-menu" role="listbox" aria-label="Permission mode">{MODES.map(m=><li key={m.id}>
      <button type="button" role="option" aria-selected={m.id===mode} className={m.id===mode?'chosen':''} onClick={()=>{close();if(m.id!==mode)onPick(m.id);}}>
        <span><strong>{m.label}</strong><small>{modes[m.id]}</small></span>{m.id===mode&&<Check size={14}/>}
      </button></li>)}</ul>}
  </Popover>;
}

function ModelChip({models,value,effort,disabled,onPick,onResync}:{models:AgentModel[];value:string;effort:string;disabled?:boolean;onPick:(id:string,effort:string)=>void;onResync:()=>Promise<number>}){
  const current=models.find(m=>m.id===value);
  return <Popover icon={<Cpu size={14}/>} label={current?`${current.name}${effort?` · ${cap(effort)}`:''}`:value||'Choose a model'} title={disabled?'Wait until the agent is done to change the model':'Model'} disabled={disabled} width={640}>
    {close=><ModelPicker models={models} value={value} effort={effort} onResync={onResync} onPick={(id,e)=>{close();if(id!==value||e!==effort)onPick(id,e);}}/>}
  </Popover>;
}
// Provider first, then the model, with a search over both. Models the agent cannot use right now are listed with the reason. Resync gives
// the engine the models added since it started (a new provider, a refreshed catalog).
function ModelPicker({models,value,effort,onPick,onResync}:{models:AgentModel[];value:string;effort:string;onPick:(id:string,effort:string)=>void;onResync:()=>Promise<number>}){
  const [query,setQuery]=useState('');const [provider,setProvider]=useState(()=>models.find(m=>m.id===value)?.provider||'');
  const [sync,setSync]=useState<{busy?:boolean;text?:string;bad?:boolean}>({});
  const providers=modelProviders(models);const shown=matchModels(models,provider,query);const current=models.find(m=>m.id===value);
  const pick=(m:AgentModel)=>onPick(m.id,m.efforts.includes(effort)?effort:'');
  const resync=async()=>{setSync({busy:true});try{const n=await onResync();setSync({text:`The engine has ${n} models`});}catch(e:any){setSync({text:e.message,bad:true});}};
  return <div className="ag-models">
    <label className="ag-models-search"><Search size={15}/><input autoFocus aria-label="Search models" placeholder={provider?`Search ${provider} models`:'Search all models'} value={query} onChange={e=>setQuery(e.target.value)}
      onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();const first=shown.find(m=>m.usable);if(first)pick(first);}}}/></label>
    <div className="ag-models-body">
      <div className="ag-providers-col">
      <ul className="ag-providers" aria-label="Providers">
        <li><button type="button" className={!provider?'chosen':''} onClick={()=>setProvider('')}><span className="truncate">All providers</span><small>{models.length}</small></button></li>
        {providers.map(p=><li key={p.name}><button type="button" className={provider===p.name?'chosen':''} onClick={()=>setProvider(p.name)} title={p.usable<p.count?`${p.count-p.usable} unavailable to the agent now`:p.name}><span className="truncate">{p.name}</span><small>{p.count}</small></button></li>)}
      </ul>
      <div className="ag-resync"><button type="button" disabled={sync.busy} onClick={resync} title="Give the agent engine the models added since it started"><RefreshCw size={13} className={sync.busy?'spin':''}/>Resync models</button>
        {sync.text&&<small className={sync.bad?'red':''}>{sync.text}</small>}</div>
      </div>
      <ul className="ag-model-list" role="listbox" aria-label="Models">
        {shown.length?shown.slice(0,400).map(m=><li key={m.id}><button type="button" role="option" aria-selected={m.id===value} disabled={!m.usable} className={m.id===value?'chosen':''} title={m.reason||m.id} onClick={()=>pick(m)}>
          <span><strong className="truncate">{m.name}</strong><small className="truncate">{provider?'':`${m.provider} · `}{m.context?`${compact(m.context)} context`:'Context size unknown'}{m.context>0&&m.context<32000?' (small for longer tasks)':''}{m.reasoning?' · reasons':''}{m.usable?'':' · unavailable now'}</small></span>{m.id===value&&<Check size={14}/>}
        </button></li>):<li className="ag-models-none">{models.length?'No model matches.':'No model can run the agent yet: it needs one that can call tools, from a provider that is switched on.'}</li>}
      </ul>
    </div>
    {current&&current.efforts.length>0&&<div className="ag-effort"><span>Effort for {current.name}</span>{['',...current.efforts].map(x=><button type="button" key={x} className={x===effort?'chosen':''} onClick={()=>onPick(current.id,x)}>{x?cap(x):'Default'}</button>)}</div>}
  </div>;
}

function FolderChip({folder,folders,onPick}:{folder:string;folders:FolderInfo[];onPick:(folder:string)=>void}){
  const bridge=window.polygateDesktop;const [text,setText]=useState('');
  return <Popover icon={<Folder size={14}/>} label={folder?folderName(folder):'Choose a working folder'} title={folder||'Working folder'} width={460}>
    {close=><div className="ag-folder-pick">
      {folders.length>0&&<ul className="ag-menu" role="listbox" aria-label="Working folders">{folders.map(f=><li key={f.folder}><button type="button" role="option" aria-selected={sameFolder(f.folder,folder)} className={sameFolder(f.folder,folder)?'chosen':''} onClick={()=>{close();onPick(f.folder);}}>
        <span><strong className="truncate">{folderName(f.folder)}</strong><small className="truncate">{f.folder}{f.trusted?'':' · needs review'}</small></span>{sameFolder(f.folder,folder)&&<Check size={14}/>}</button></li>)}</ul>}
      {bridge?.pickFolder?<button type="button" className="ag-folder-browse" onClick={async()=>{const f=await bridge.pickFolder!();if(f){close();onPick(f);}}}><FolderOpen size={15}/>Choose another folder…</button>
        // In a browser (not the desktop app) there is no folder dialog: the path is typed and checked by the gateway.
        :<form className="ag-folder-form" onSubmit={e=>{e.preventDefault();if(text.trim()){close();onPick(text.trim());setText('');}}}><input aria-label="Working folder path" placeholder="C:\path\to\project" value={text} onChange={e=>setText(e.target.value)}/><Button type="submit">Use</Button></form>}
    </div>}
  </Popover>;
}

function Composer({value,onChange,onSend,canSend,sending,busy,onStop,placeholder,chips,autoFocus}:{value:string;onChange:(v:string)=>void;onSend:()=>void;canSend:boolean;sending:boolean;busy?:boolean;onStop?:()=>void;placeholder:string;chips:ReactNode;autoFocus?:boolean}){
  const ready=canSend&&!sending&&!!value.trim();
  return <div className="ag-composer">
    <textarea aria-label="Message to the agent" placeholder={placeholder} value={value} rows={2} autoFocus={autoFocus}
      onChange={e=>onChange(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();if(ready)onSend();}}}/>
    <div className="ag-composer-row">{chips}<span className="toolbar-spacer"/>
      {busy&&onStop&&<button type="button" className="ag-stop" onClick={onStop} title="Stop the agent"><Square size={12}/>Stop</button>}
      <button type="button" className="ag-send" aria-label={busy?'Queue message':'Send'} title={busy?'Queue: sent when the agent is done':'Send (Enter)'} disabled={!ready} onClick={onSend}>{sending?<Loader2 className="spin" size={16}/>:<ArrowUp size={17}/>}</button>
    </div>
  </div>;
}

// A new session: a folder, a model, a mode and the first message. Sending creates the session and sends the message to it.
function NewSession({models,folders,reloadFolders,onResync,onCreated}:{models:Models|null;folders:FolderInfo[];reloadFolders:()=>void;onResync:()=>Promise<number>;onCreated:(s:SessionInfo,opening:Opening)=>void}){
  const {confirm,dialog}=useConfirm();
  // Full access is confirmed when it is picked, and never remembered as the mode the next session starts in.
  const pickMode=async(m:Mode)=>{if(m==='full'&&!await confirm(FULL_WARNING,{title:'Start with Full access',confirm:'Use Full access',icon:<ShieldAlert size={18}/>}))return;setMode(m);};
  const [folder,setFolder]=useState(()=>stored('polygate-agent-folder'));
  const [model,setModel]=useState(()=>stored('polygate-agent-model'));const [effort,setEffort]=useState(()=>stored('polygate-agent-effort'));
  const [mode,setMode]=useState<Mode>(()=>{const m=stored('polygate-agent-mode');return MODES.some(x=>x.id===m&&x.id!=='full')?m as Mode:'ask';});
  const [text,setText]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const all=models?.models||[];const usable=all.filter(m=>m.usable);const current=usable.find(m=>m.id===model)||usable[0];
  const {data:trust,error:trustError,reload:reloadTrust}=usePoll<TrustReport>(folder?'/admin/agent/trust?folder='+encodeURIComponent(folder):'/admin/agent/folders',5000,!!folder);
  const report=folder&&trust&&sameFolder(trust.folder,folder)?trust:null;const trusted=!!report?.trusted;
  const pickFolder=(f:string)=>{setFolder(f);store('polygate-agent-folder',f);setError('');};
  const start=async()=>{
    const t=text.trim();if(!t||!current||!trusted)return;setBusy(true);setError('');
    const chosen=current.efforts.includes(effort)?effort:'';
    let s:SessionInfo;
    try{s=await api('/admin/agent/session/create',{folder,model:current.id,mode,confirmFull:mode==='full',effort:chosen,title:t.split('\n')[0].slice(0,80)});}catch(e:any){setError(e.message);setBusy(false);return;}
    store('polygate-agent-model',current.id);store('polygate-agent-effort',chosen);if(mode!=='full')store('polygate-agent-mode',mode);
    // The session exists from here on: if the message cannot be sent, it opens with the message still in its box and the reason.
    let opening:Opening={};
    try{const r=await api('/admin/agent/session/prompt',{id:s.id,text:t});if(r.limited)opening={notice:LIMITED};}catch(e:any){opening={draft:t,error:e.message};}
    setBusy(false);onCreated(s,opening);
  };
  const placeholder=!folder?'Choose a working folder first…':!trusted?'Allow this folder first…':!current?'No model can run the agent yet…':'What should the agent do in this folder?';
  return <div className="ag-center">
    <div className="ag-column ag-new-session">
      <div className="ag-hero"><Bot size={30}/><h1>What should the agent do?</h1><p>It reads, edits and runs commands in the folder you choose, through Polygate's own models, and asks first where its mode says so.</p></div>
      {report&&!report.trusted&&<FolderTrust folder={folder} report={report} error={trustError} reload={()=>{reloadTrust();reloadFolders();}}/>}
      {folder&&!report&&trustError&&<div className="pg-error">{trustError}</div>}
      {models&&!usable.length&&<p className="agent-warn"><TriangleAlert size={15}/>No model can run the agent yet: it needs one that can call tools, from a provider that is switched on.</p>}
      <Composer value={text} onChange={setText} onSend={start} canSend={!!current&&trusted} sending={busy} placeholder={placeholder} autoFocus
        chips={<><FolderChip folder={folder} folders={folders} onPick={pickFolder}/><ModeChip mode={mode} modes={models?.modes||{}} onPick={pickMode}/><ModelChip models={all} value={current?.id||''} effort={current?.efforts.includes(effort)?effort:''} onResync={onResync} onPick={(id,e)=>{setModel(id);setEffort(e);}}/></>}/>
      {mode==='full'&&<p className="agent-warn"><TriangleAlert size={15}/>This session starts with Full access: its first turn runs without approval prompts.</p>}
      {error&&<div className="pg-error">{error}</div>}
    </div>
    {dialog}
  </div>;
}

function SessionView({start,opening,models:modelData,onResync,onChanged,onDeleted}:{start:SessionInfo;opening?:Opening;models:Models|null;onResync:()=>Promise<number>;onChanged:()=>void;onDeleted:()=>void}){
  const id=start.id,folder=start.folder;const models=modelData?.models||[];
  const [info,setInfo]=useState<SessionInfo>(start);const [items,setItems]=useState<Item[]>([]);const [pending,setPending]=useState<Approval[]>([]);
  const [paused,setPaused]=useState('');const [busy,setBusy]=useState(false);const [usage,setUsage]=useState<SessionInfo['tokens']>(start.tokens);
  const [error,setError]=useState(opening?.error||'');const [notice,setNotice]=useState(opening?.notice||'');const [live,setLive]=useState<'connecting'|'live'|'lost'>('connecting');const [requests,setRequests]=useState<RouteUsage|null>(null);
  const [text,setText]=useState(opening?.draft||'');const [sending,setSending]=useState(false);
  const [rules,setRules]=useState(false);
  const thread=useRef<HTMLDivElement>(null);const changed=useRef(onChanged);changed.current=onChanged;const deleted=useRef(onDeleted);deleted.current=onDeleted;
  const {data:trust,error:trustError,reload:reloadTrust}=usePoll<TrustReport>('/admin/agent/trust?folder='+encodeURIComponent(folder),10000,!!folder);
  const untrusted=trust&&sameFolder(trust.folder,folder)&&!trust.trusted?trust:null;
  const load=useCallback(async()=>{
    try{const [s,changes]=await Promise.all([api('/admin/agent/session?id='+encodeURIComponent(id)),api('/admin/agent/session/changes?id='+encodeURIComponent(id))]);setInfo(s.session);setItems(withChanges(fromHistory(s.messages),changes.turns||[]));setRequests(s.usage||null);setPending(s.pending||[]);setPaused(s.paused||'');setBusy(!!s.busy);setUsage(s.session.tokens);}
    catch(e:any){setError(e.message);}
  },[id]);
  // History first, then the live stream. After a dropped connection the history is read again, so nothing missed meanwhile is lost.
  useEffect(()=>{
    let source:EventSource|undefined;let closed=false;let lost=false;
    const handle=(e:any)=>{
      const d=e.data||{};
      if(e.type==='agent.deleted'){deleted.current();return;}
      if(e.type==='agent.state'){setPending(d.pending||[]);setPaused(d.paused||'');setBusy(!!d.busy);return;}
      if(e.type==='permission.asked'){setPending(p=>p.some(x=>x.id===d.id)?p:[...p,{id:d.id,action:d.action,resources:d.resources||[],note:d.note||''}]);return;}
      if(e.type==='permission.replied'){setPending(p=>p.filter(x=>x.id!==d.requestID));return;}
      if(e.type==='agent.approval.auto')setPending(p=>p.filter(x=>x.id!==d.requestID));
      if(e.type==='agent.paused'){setPaused(d.message||'The model kept failing.');setBusy(false);return;}
      if(e.type==='agent.undone'){load();return;}
      if(e.type==='agent.mode')setInfo(i=>({...i,mode:d.mode}));
      if(e.type==='session.execution.started'){setBusy(true);setPaused('');}
      if(/^session\.execution\.(succeeded|failed|interrupted)$/.test(e.type)){setBusy(false);changed.current();api('/admin/agent/session?id='+encodeURIComponent(id)).then(s=>setRequests(s.usage||null),()=>{});}
      if(e.type==='session.usage.updated'&&d.tokens)setUsage(d.tokens);
      setItems(list=>applyEvent(list,e));
    };
    (async()=>{
      await load();if(closed)return;
      source=new EventSource(at('/admin/agent/events?id='+encodeURIComponent(id)));
      source.onopen=()=>{setLive('live');if(lost){lost=false;load();}};
      source.onerror=()=>{lost=true;setLive('lost');};
      source.onmessage=m=>{try{handle(JSON.parse(m.data));}catch{/* a malformed event is skipped */}};
    })();
    return ()=>{closed=true;source?.close();};
  },[id,load]);
  // Follows the newest output while the reader is near the bottom; reading further up is left alone.
  useEffect(()=>{const el=thread.current;if(el&&el.scrollHeight-el.scrollTop-el.clientHeight<160)el.scrollTop=el.scrollHeight;},[items,pending,busy]);
  const send=async()=>{const t=text.trim();if(!t)return;setSending(true);setError('');setNotice('');try{const r=await api('/admin/agent/session/prompt',{id,text:t});setText('');if(r.limited)setNotice(LIMITED);}catch(e:any){setError(e.message);}finally{setSending(false);}};
  const stop=async()=>{try{await api('/admin/agent/session/cancel',{id});}catch(e:any){setError(e.message);}};
  const {confirm,dialog}=useConfirm();
  const changeMode=async(mode:Mode)=>{
    if(mode==='full'&&!await confirm(FULL_WARNING,{title:'Enable Full access',confirm:'Enable Full access',icon:<ShieldAlert size={18}/>}))return;
    setError('');try{await api('/admin/agent/session/mode',{id,mode,confirmFull:mode==='full'});setInfo(i=>({...i,mode}));}catch(e:any){setError(e.message);}
  };
  const switchModel=async(model:string,effort:string)=>{setError('');try{await api('/admin/agent/session/model',{id,model,effort});setInfo(i=>({...i,model,effort}));if(paused){setPaused('');setNotice('Model changed. Send a message to carry on.');}}catch(e:any){setError(e.message);}};
  // Undo goes back to just before this turn's message: this turn and every later one are undone, and their messages leave the conversation.
  const blocked=useMemo(()=>undoBlocked(items),[items]);
  const undo=async(message:string)=>{
    const cards=items.filter((i):i is Extract<Item,{kind:'changes'}>=>i.kind==='changes');const from=cards.findIndex(c=>c.message===message);if(from<0)return;
    const files=[...new Set(cards.slice(from).flatMap(c=>c.files.map(f=>f.file)))];const later=cards.length-from-1;
    const ok=await confirm(<>Remove this turn's changes from {files.length===1?<code>{files[0]}</code>:`${files.length} files`}.{later>0?` This also undoes the ${later} later turn${later>1?'s':''} that changed files.`:''} The conversation from this message on is removed. Your non-overlapping edits are preserved. If any file cannot be safely merged, nothing is undone.</>,{title:'Undo this turn',confirm:'Undo',icon:<Undo2 size={18}/>});
    if(!ok)return;setError('');setNotice('');
    try{const r=await api('/admin/agent/session/undo',{id,message});setNotice(`Undone: ${r.files.length} file${r.files.length===1?'':'s'} restored.${r.merged?' Your non-overlapping edits were preserved.':''}`);}catch(e:any){setError(e.message);}
  };
  const [naming,setNaming]=useState<string|null>(null);const rename=async()=>{const title=(naming||'').trim();if(!title||title===info.title){setNaming(null);return;}try{await api('/admin/agent/session/rename',{id,title});setInfo(i=>({...i,title}));changed.current();}catch(e:any){setError(e.message);}setNaming(null);};
  const answer=async(p:Approval,decision:'once'|'session'|'project'|'deny')=>{
    if(decision==='project'&&!await confirm(<>Save this exact {p.action} request for this working folder? It will be allowed in future sessions without asking. It does not match broader command prefixes. Remove it under Project rules.</>,{title:'Save project rule',confirm:'Save and allow',icon:<ShieldCheck size={18}/>}))return;
    setPending(list=>list.filter(x=>x.id!==p.id));
    try{await api('/admin/agent/session/approve',{id,request:p.id,decision});}catch(e:any){setError(e.message);load();}
  };
  const shown=useMemo(()=>blocks(items),[items]);const todos=useMemo(()=>latestTodos(items),[items]);
  // When the current turn started, for the working time under the conversation.
  const [busySince,setBusySince]=useState(0);useEffect(()=>{setBusySince(busy?Date.now():0);},[busy]);
  const mode=(info.mode||'ask') as Mode;const tokens=usage?usage.input+usage.output+(usage.reasoning||0):0;
  const hint=mode==='plan'?'In Plan mode it reads and plans; it does not change files or run commands.':mode==='accept-edits'?'It changes files without asking and asks before running commands.':mode==='full'?'Full access: it runs commands and changes files without asking, for this turn.':'It reads freely and asks before changing files or running commands.';
  return <>
    <header className="ag-head">
      <div className="ag-head-title">{naming!==null?<input className="agent-rename" aria-label="Session name" autoFocus value={naming} maxLength={120} onChange={e=>setNaming(e.target.value)} onBlur={rename} onKeyDown={e=>{if(e.key==='Enter')rename();if(e.key==='Escape')setNaming(null);}}/>
        :<h2 title={info.title}><span className="truncate">{info.title||'Session'}</span><button className="icon-button agent-rename-button" aria-label="Rename session" title="Rename" onClick={()=>setNaming(info.title||'')}><Pencil size={13}/></button></h2>}
        <span className="subtle truncate" title={folder}><Folder size={12}/>{folder}</span></div>
      <span className="toolbar-spacer"/>
      {tokens>0&&<span className="pg-stat" title="Tokens this session has used, as the engine counts them">{compact(tokens)} tokens</span>}
      {requests&&requests.requests>0&&<span className={`pg-stat${requests.errors?' warn':''}`} title={`Model requests this session made through Polygate, by route:\n${requests.routes.map(r=>`${r.route||'—'}: ${r.requests}`).join('\n')}`}>
        {requests.requests} request{requests.requests===1?'':'s'}{requests.errors?`, ${requests.errors} failed`:''}</span>}
      <button className={`ag-chip${rules?' open':''}`} aria-expanded={rules} onClick={()=>setRules(r=>!r)} title="Saved approvals for this folder"><ListChecks size={14}/>Project rules</button>
      <span className={`agent-live ${live}`}>{live==='live'?'Live':live==='lost'?'Reconnecting…':'Connecting…'}</span>
    </header>
    {rules&&<ProjectRules id={id} mode={mode}/>}
    <div className="ag-thread" ref={thread} aria-live="polite"><div className="ag-column">
      {mode==='full'&&<div className="agent-paused" role="status"><TriangleAlert size={17}/><div><strong>Full access.</strong> Commands run with your account's access without asking, until this turn ends (or the app or engine restarts). No sandbox.</div></div>}
      {untrusted&&<FolderTrust folder={folder} report={untrusted} error={trustError} reload={reloadTrust}/>}
      {shown.length?shown.map(b=><Row key={b.key} block={b} folder={folder} busy={busy} blocked={b.kind==='changes'?blocked.get(b.message):undefined} onUndo={undo}/>):<p className="subtle agent-hint">Tell the agent what to do in this folder. {hint}</p>}
      {busy&&<Working since={busySince} waiting={pending.length>0}/>}
    </div></div>
    <div className="ag-bottom"><div className="ag-column">
      {todos.length>0&&(busy||todos.some(t=>t.status!=='completed'))&&<TodoCard todos={todos}/>}
      {pending.map(p=><ApprovalCard key={p.id} request={p} answer={answer}/>)}
      {paused&&<div className="agent-paused" role="status"><TriangleAlert size={17}/><div><strong>Paused.</strong> {plainError(paused)} Send a message to try again, or pick another model below.</div></div>}
      {notice&&!error&&<div className="agent-notice" role="status">{notice}</div>}
      {error&&<div className="pg-error agent-error">{error}</div>}
      <Composer value={text} onChange={setText} onSend={send} canSend={!untrusted} sending={sending} busy={busy} onStop={stop}
        placeholder={busy?'The agent is working. A message now is queued for when it is done.':'Reply to the agent…'}
        chips={<><ModeChip mode={mode} modes={modelData?.modes||{}} disabled={busy||pending.length>0} onPick={changeMode}/><ModelChip models={models} value={info.model} effort={info.effort} disabled={busy} onResync={onResync} onPick={switchModel}/></>}/>
    </div></div>
    {dialog}
  </>;
}

// One piece of the conversation, drawn like a chat app: your messages in a box on the right, the agent's replies as plain text, and
// what it did as quiet one-line summaries that open to show each step.
function Row({block,folder,busy,blocked,onUndo}:{block:Block;folder:string;busy:boolean;blocked?:string;onUndo:(message:string)=>void}){
  if(block.kind==='changes')return <ChangesLine files={block.files} busy={busy} blocked={blocked} undo={()=>onUndo(block.message)}/>;
  if(block.kind==='user')return <div className="ag-msg-user"><pre>{block.text}</pre></div>;
  if(block.kind==='text')return block.text?<div className="ag-msg-agent"><Markdown text={block.text}/></div>:null;
  if(block.kind==='reasoning')return <details className="ag-line"><summary>{block.done?'Thought':<><Loader2 size={13} className="spin"/>Thinking</>}<ChevronRight size={13} className="ag-line-chevron"/></summary><pre className="ag-thought">{block.text}</pre></details>;
  if(block.kind==='note')return <div className={`agent-note ${block.tone}`}>{block.text}</div>;
  return <Steps tools={block.tools} folder={folder}/>;
}
function Steps({tools,folder}:{tools:Tool[];folder:string}){
  const working=tools.some(t=>t.status==='running'||t.status==='preparing');
  return <details className="ag-line"><summary>{working&&<Loader2 size={13} className="spin"/>}{stepsSummary(tools)}<ChevronRight size={13} className="ag-line-chevron"/></summary>
    <div className="ag-steps">{tools.map(t=><Step key={t.key} tool={t} folder={folder}/>)}</div>
  </details>;
}
function Step({tool:t,folder}:{tool:Tool;folder:string}){
  const subject=toolSubject(t.name,t.input,folder);
  const icon=t.status==='done'?<Check size={13} className="green"/>:t.status==='failed'?<X size={13} className="red"/>:<Loader2 size={13} className="spin"/>;
  return <details className={`agent-tool ${t.status}`}><summary>{icon}<strong>{t.name}</strong>{subject&&<code className="truncate" title={subject}>{subject}</code>}</summary>
    {t.error&&<p className="agent-error-text">{t.error}</p>}
    {t.output?<pre>{t.output.length>6000?t.output.slice(0,6000)+'\n…':t.output}</pre>:!t.error&&<p className="subtle">{t.status==='done'?'No output.':'Waiting for the result…'}</p>}
  </details>;
}
// "Working 1m 12s" under the conversation while a turn runs.
function Working({since,waiting}:{since:number;waiting:boolean}){
  const [now,setNow]=useState(Date.now());useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[]);
  const s=Math.max(0,Math.round((now-(since||now))/1000));
  return <div className="ag-working"><Loader2 size={14} className="spin"/>{waiting?'Waiting for your approval':'Working'}<span>{s>=60?`${Math.floor(s/60)}m ${s%60}s`:`${s}s`}</span></div>;
}
// The agent's own task list (the newest it wrote), above the message box like a chat app's plan.
function TodoCard({todos}:{todos:Todo[]}){
  return <ul className="ag-todos" aria-label="The agent's task list">{todos.map((t,i)=><li key={i} className={t.status}>
    {t.status==='completed'?<CheckCircle2 size={15}/>:t.status==='in_progress'?<Loader2 size={15} className="spin"/>:<Circle size={15}/>}<span>{t.content}</span></li>)}</ul>;
}

const STATUS:Record<string,string>={added:'Added',deleted:'Deleted',modified:'Changed',renamed:'Renamed'};
// What one turn changed: one line with the counts that opens to each file and its patch (a file a command changed may have none), and
// Undo, or why it cannot be undone.
function ChangesLine({files,busy,blocked,undo}:{files:Extract<Item,{kind:'changes'}>['files'];busy:boolean;blocked?:string;undo:()=>void}){
  const add=files.reduce((s,f)=>s+f.additions,0),del=files.reduce((s,f)=>s+f.deletions,0);
  const names=files.length===1?files[0].file.split(/[\\/]/).pop():`${files.length} files`;
  return <div className="ag-changes">
    <details className="ag-line"><summary>Changed {names}{add>0&&<span className="green">+{add}</span>}{del>0&&<span className="red">−{del}</span>}<span className="ag-line-link">View changes</span><ChevronRight size={13} className="ag-line-chevron"/></summary>
      <div className="agent-changes">{files.map(f=><details key={f.file} className="agent-change"><summary><span className={`agent-change-status ${f.status}`}>{STATUS[f.status]||f.status}</span><code className="truncate" title={f.file}>{f.file}</code>{f.additions>0&&<small className="green">+{f.additions}</small>}{f.deletions>0&&<small className="red">−{f.deletions}</small>}</summary>
        {f.patch?<Diff patch={f.patch}/>:<p className="subtle">No patch was recorded for this file (it was changed by a command).</p>}</details>)}</div>
    </details>
    {blocked?<span className="ag-no-undo" title={blocked}>Can't be undone<small>{blocked}</small></span>:<button className="ag-undo" disabled={busy} onClick={undo}><Undo2 size={13}/>Undo</button>}
  </div>;
}
function Diff({patch}:{patch:string}){
  const lines=patch.replace(/\r/g,'').split('\n').filter(l=>!/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(l));
  return <pre className="agent-diff">{lines.map((l,i)=><span key={i} className={l.startsWith('+')?'add':l.startsWith('-')?'del':l.startsWith('@@')?'hunk':''}>{l||' '}{'\n'}</span>)}</pre>;
}

function ApprovalCard({request:p,answer}:{request:Approval;answer:(p:Approval,decision:'once'|'session'|'project'|'deny')=>void}){
  return <div className="agent-approval" role="alert">
    <div className="agent-approval-head"><ShieldCheck size={18}/><strong>{approvalTitle(p.action)}</strong></div>
    {p.resources.map(r=><code key={r} className="agent-approval-target">{r}</code>)}
    {p.note&&<p className="agent-approval-note">{p.note}</p>}
    <div className="agent-approval-actions">
      <Button variant="primary" onClick={()=>answer(p,'once')}>Allow once</Button>
      <Button onClick={()=>answer(p,'session')}>Allow for this session</Button>
      {['shell','edit','read','webfetch','websearch','external_directory','subagent'].includes(p.action)&&<Button onClick={()=>answer(p,'project')}>Save project rule</Button>}
      <Button onClick={()=>answer(p,'deny')}>Deny</Button>
    </div>
    <p className="subtle">Allow for this session: this exact request goes ahead without asking again until the session ends. Deny stops this turn, together with anything else the agent asked to do at the same time.</p>
  </div>;
}

type SavedRule={id:string;action:string;resources:string[];effect:'allow'|'deny';created:number};
function ProjectRules({id,mode}:{id:string;mode:Mode}){
  const [data,setData]=useState<{rules:SavedRule[];inspections:string[]}|null>(null);const [error,setError]=useState('');
  const load=useCallback(async()=>{try{setData(await api('/admin/agent/rules?id='+encodeURIComponent(id)));setError('');}catch(e:any){setError(e.message);}},[id]);
  useEffect(()=>{void load();},[load]);
  const remove=async(rule:string)=>{try{await api('/admin/agent/rules/remove',{id,rule});await load();}catch(e:any){setError(e.message);}};
  return <div className="agent-project-rules">
    <p className="subtle">Saved by Polygate for this working folder. Only the exact action and targets match; Plan still blocks commands and edits. Full access bypasses these rules for its current turn.</p>
    {error&&<p className="pg-error">{error}</p>}
    {!data&&!error?<p className="subtle">Loading…</p>:data?.rules.length?<ul>{data.rules.map(r=><li key={r.id}><div><strong>{r.effect==='allow'?'Allow':'Deny'} {r.action}</strong>{r.resources.map((x,i)=><code key={i} className="agent-approval-target">{x}</code>)}</div><Button onClick={()=>remove(r.id)}>Remove</Button></li>)}</ul>:<p className="subtle">No saved rules. Save one from an approval card.</p>}
    {mode==='rules'&&data&&<><p className="subtle">Only these exact hardened inspections are automatically approved. Ordinary git commands, scripts and unrecognized arguments still ask.</p>{data.inspections.map(x=><code className="agent-approval-target" key={x}>{x}</code>)}</>}
  </div>;
}
