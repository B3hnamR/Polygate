import {useCallback,useEffect,useMemo,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import {ArrowDown,ArrowLeft,ArrowUp,BookOpen,Hammer,Brain,CornerDownRight,ListEnd,FileText,Globe,SquareTerminal,Wrench,ClipboardList,ScrollText,Workflow,Check,CheckCircle2,ChevronDown,ChevronRight,Circle,Copy,Cpu,Download,Files,Folder,FolderOpen,ListChecks,Loader2,Pencil,Play,Plus,RefreshCw,Search,Settings2,ShieldAlert,ShieldCheck,Square,Trash2,TriangleAlert,Undo2,X} from 'lucide-react';
import {api,at} from './api';
import {MAX_AGENT_FILES,MAX_AGENT_FILE_BYTES,type AgentFile} from '../backend/agent-attachments';
import {Button,Progress,Toggle,compact,usePoll,tickWhileVisible,when} from './ui';
import {AGENT_FONTS,agentFontVars,slashQuery,type MenuChoice,type SkillPick,MODES,modeLabel,fromHistory,fromInbox,isQueued,clearSubmitted,currentTrustReport,reconnectConsistency,snapshotRepair,applyEvent,approvalTitle,toolSubject,withChanges,undoBlocked,modelProviders,matchModels,folderName,blocks,stepsParts,stepKind,failedNote,type StepKind,latestTodos,type Approval,type Block,type Item,type Mode,type Todo,type Tool} from './agent-logic';
import {useConfirm} from './confirm';
import {Dialog} from './mcp';
import {Markdown} from './markdown';
import {plainError} from '../backend/plain-error';
import {AgentDiff as Diff} from './agent-diff';
import {AgentWorkspace} from './agent-workspace';
import {AgentForms} from './agent-forms';
import {AgentLibrarySettings} from './agent-library';
import {SkillChips,SkillMenu} from './agent-skills';
// The Agent (docs/agent/PLAN.md): a coding agent working in folders the user chooses, through Polygate's own models. It takes the whole
// window: the sessions of every folder on the left, one conversation in the middle, and the model and mode beside the message box.
// Everything goes through the agent controller (backend/agent.ts); the page never talks to the engine itself. Desktop app only.

type Engine={state:string;installed:boolean;version:string;message:string;problems:string[];progress?:number;backups?:boolean;snapshots?:{ok:boolean;reason?:string};freeIdentity?:{presented:string;engine:string;usable:boolean}};
type AgentModel={id:string;name:string;provider:string;context:number;output:number;reasoning:boolean;efforts:string[];usable:boolean;reason?:string;members?:string[];description?:string};
type Models={models:AgentModel[];modes:Record<string,string>};
type RouteUsage={requests:number;errors:number;input:number;output:number;last:number;routes:{route:string;requests:number}[]};
type SessionInfo={id:string;title:string;mode:Mode|'';model:string;effort:string;folder:string;created?:number;tokens?:{input:number;output:number;reasoning?:number;cache?:{read:number;write:number}}};
type FolderInfo={folder:string;trusted:boolean};
// What a new session hands to its first view: a message that could not be sent, or a note about its backup.
type Opening={draft?:string;files?:AgentFile[];skills?:SkillPick[];error?:string;notice?:string};
const cap=(s:string)=>s.charAt(0).toUpperCase()+s.slice(1);
const sameFolder=(a:string,b:string)=>a.replace(/\\/g,'/').replace(/\/$/,'').toLowerCase()===b.replace(/\\/g,'/').replace(/\/$/,'').toLowerCase();
const inFolder=(f:string,root:string)=>{const n=(p:string)=>p.replace(/\\/g,'/').replace(/\/$/,'').toLowerCase();return n(f).startsWith(n(root)+'/');};
// The session list's group for sessions started with "No folder".
const NO_FOLDER='\u0000no-folder';
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
  const {data:folderList,reload:reloadFolders}=usePoll<{folders:FolderInfo[];scratch?:string}>('/admin/agent/folders',15000);
  const [open,setOpen]=useState(()=>stored('polygate-agent-open'));const [fresh,setFresh]=useState<{info:SessionInfo;opening:Opening}|null>(null);
  const [settings,setSettings]=useState(false);const [problem,setProblem]=useState('');
  // The Agent's font, remembered on this computer (Agent settings → Appearance).
  const [font,setFont]=useState(()=>stored('polygate-agent-font')||'default');const pickFont=(id:string)=>{setFont(id);store('polygate-agent-font',id);};
  const [busy,setBusy]=useState('');
  const autoStarted=useRef(false);
  const act=useCallback(async(path:string,label:string)=>{if(label==='stop'||label==='start')autoStarted.current=true;setBusy(label);setProblem('');try{await api(path,{});}catch(e:any){setProblem(e.message);}finally{setBusy('');reloadEngine();}},[reloadEngine]);
  useEffect(()=>{
    if(!engine||busy||autoStarted.current)return;
    if(['running','starting','restarting'].includes(engine.state)){autoStarted.current=true;return;}
    if(engine.installed&&['installed','failed'].includes(engine.state)){
      autoStarted.current=true;void act('/admin/agent/engine/start','start');
    }
  },[engine,busy,act]);
  const choose=(id:string)=>{setOpen(id);store('polygate-agent-open',id);if(fresh?.info.id!==id)setFresh(null);};
  // A new session, empty or (with +) in one folder; seq starts a fresh screen even when the same folder is asked for again.
  const [start,setStart]=useState<{folder?:string|null;seq:number}>({seq:0});
  const newSession=(folder?:string|null)=>{choose('');setStart(x=>({folder,seq:x.seq+1}));};
  const sessions=list?.sessions||[];
  const info=sessions.find(s=>s.id===open)||(fresh?.info.id===open?fresh.info:undefined);
  // Sessions grouped by their folder, the folder with the newest session first (the list comes newest first). Sessions started with
  // "No folder" (each in its own empty folder under the scratch folder) share one group.
  const scratch=folderList?.scratch||'';
  const groups=useMemo(()=>{const out=new Map<string,SessionInfo[]>();for(const s of sessions){const k=scratch&&inFolder(s.folder,scratch)?NO_FOLDER:[...out.keys()].find(f=>sameFolder(f,s.folder))??s.folder;out.set(k,[...(out.get(k)||[]),s]);}return [...out.entries()];},[sessions,scratch]);
  // Folded folder groups, remembered on this computer.
  const [folded,setFolded]=useState<string[]>(()=>{try{const v=JSON.parse(stored('polygate-agent-folded')||'[]');return Array.isArray(v)?v:[];}catch{return [];}});
  const fold=(k:string)=>setFolded(f=>{const next=f.includes(k)?f.filter(x=>x!==k):[...f,k];store('polygate-agent-folded',JSON.stringify(next));return next;});
  const {confirm,dialog}=useConfirm();
  const remove=async(s:SessionInfo)=>{
    if(!await confirm(<>Delete <strong>{s.title}</strong>? Its conversation and Polygate's records of what it changed (and its undo) are removed. The files in <code>{s.folder}</code> are not changed.</>,{title:'Delete session',confirm:'Delete session'}))return;
    setProblem('');try{await api('/admin/agent/session/delete',{id:s.id});if(s.id===open)choose('');reloadList();}catch(e:any){setProblem(e.message);}
  };
  const main=!engine?<div className="ag-center">{engineError?<div className="pg-error">{engineError}</div>:<p className="subtle ag-loading"><Loader2 className="spin" size={15}/> Checking the agent engine…</p>}</div>
    :!running?<div className="ag-center"><div className="ag-column">{busy==='start'||['starting','restarting'].includes(engine.state)?<p className="subtle ag-loading" role="status"><Loader2 className="spin" size={15}/> Starting the agent engine…</p>:<div className="ag-card"><EngineCard engine={engine} busy={busy} act={act}/></div>}</div></div>
    :!list&&!listError&&open&&!info?<div className="ag-center"><p className="subtle ag-loading"><Loader2 className="spin" size={15}/> Loading sessions…</p></div>
    :info?<SessionView key={info.id} start={info} opening={fresh?.info.id===info.id?fresh.opening:undefined} scratch={scratch} models={models} onResync={resync} onChanged={reloadList} onDeleted={()=>{choose('');reloadList();}}/>
    :<NewSession key={start.seq} startFolder={start.folder} models={models} folders={folderList?.folders||[]} reloadFolders={reloadFolders} onResync={resync} onCreated={(s,opening)=>{setFresh({info:s,opening});setOpen(s.id);store('polygate-agent-open',s.id);reloadList();reloadFolders();}}/>;
  return <div className="ag-app" style={agentFontVars(font) as CSSProperties}>
    <aside className="ag-side" aria-label="Agent sessions">
      <div className="ag-side-head"><button className="ag-back" onClick={onBack} title="Back to Polygate"><ArrowLeft size={16}/>Polygate</button><span className="ag-side-title"><Hammer size={17}/>Agent</span></div>
      <button className={`ag-new${running&&!info?' active':''}`} onClick={()=>newSession()} disabled={!running}><Plus size={16}/>New session</button>
      <nav className="ag-sessions">
        {groups.map(([folder,items])=>{const shut=folded.includes(folder);return <section key={folder} className="ag-group">
          <h3><button type="button" className="ag-group-head" aria-expanded={!shut} title={folder===NO_FOLDER?'Sessions started without a project folder':folder} onClick={()=>fold(folder)}><span className="truncate">{folder===NO_FOLDER?'No folder':folderName(folder)}</span><ChevronDown size={13} className={shut?'shut':''}/></button>{running&&<button type="button" className="icon-button ag-group-new" aria-label={`New session in ${folder===NO_FOLDER?'No folder':folderName(folder)}`} title={folder===NO_FOLDER?'New session without a folder':`New session in ${folder}`} onClick={()=>newSession(folder===NO_FOLDER?'':folder)}><Plus size={14}/></button>}</h3>
          {!shut&&<ul>{items.map(s=><li key={s.id} className={s.id===info?.id?'active':''}>
            <button className="ag-session" aria-current={s.id===info?.id?'true':undefined} onClick={()=>choose(s.id)} title={`${s.title}\n${when(s.created||0)}${s.mode?` · ${modeLabel(s.mode)}`:''}\n${s.folder}`}><span className="truncate">{s.title}</span></button>
            <button className="icon-button danger ag-session-delete" aria-label={`Delete session ${s.title}`} title="Delete session" onClick={()=>remove(s)}><Trash2 size={14}/></button>
          </li>)}</ul>}
        </section>;})}
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
    {settings&&<AgentSettings font={font} onFont={pickFont} engine={engine||null} busy={busy} act={act} folders={folderList?.folders||[]} reloadEngine={reloadEngine} reloadFolders={reloadFolders} onClose={()=>setSettings(false)}/>}
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
      {s==='installing'&&<Button onClick={()=>act('/admin/agent/engine/install/cancel','cancel')} title="Stop the download; nothing is installed"><Square size={14}/>Cancel</Button>}
      {working&&!busy&&s!=='installing'&&<Loader2 className="spin" size={16}/>}
    </div>
    {s==='not_installed'&&<p className="subtle">The agent runs on OpenCode, an open-source coding agent. Polygate downloads its pinned version once from npm (about 100 MB), checks it against the published checksum, and runs it on this computer only. Its model requests go through Polygate under its own key.</p>}
    {s==='installing'&&<Progress value={engine.progress||0} label="Downloading the agent engine"/>}
    {s==='installed'&&<p className="subtle">Start the engine to work with the agent. Other clients are not affected by it.</p>}
    {engine.message&&!running&&<p className={s==='failed'?'agent-error-text':'subtle'}>{engine.message}</p>}
    {engine.problems?.length>0&&<ul className="agent-problems">{engine.problems.map(p=><li key={p}>{p}</li>)}</ul>}
    {running&&engine.snapshots&&!engine.snapshots.ok&&<p className="agent-warn"><TriangleAlert size={15}/>Engine snapshots are unavailable: {engine.snapshots.reason} Polygate uses its own exact file backups for recorded turns.</p>}
    {running&&engine.freeIdentity&&!engine.freeIdentity.usable&&<p className="agent-warn"><TriangleAlert size={15}/>Polygate's Agent compatibility check blocks OpenCode Free: the bridge reports {engine.freeIdentity.presented}, but the Agent engine is pinned to {engine.freeIdentity.engine}. Resync models does not update the engine.</p>}
  </div>;
}

// Settings that belong to the agent alone: its engine, folder backups for undo, and the folders it may work in.
function AgentSettings({font,onFont,engine,busy,act,folders,reloadEngine,reloadFolders,onClose}:{font:string;onFont:(id:string)=>void;engine:Engine|null;busy:string;act:(path:string,label:string)=>void;folders:FolderInfo[];reloadEngine:()=>void;reloadFolders:()=>void;onClose:()=>void}){
  const [error,setError]=useState('');const [backups,setBackups]=useState<boolean|null>(null);const {confirm,dialog}=useConfirm();
  const on=backups??!!engine?.backups;
  const switchBackups=async(next:boolean)=>{setBackups(next);setError('');try{await api('/admin/settings',{agentBackups:next});reloadEngine();}catch(e:any){setBackups(null);setError(e.message);}};
  const revoke=async(folder:string)=>{
    if(!await confirm(<>Stop running turns in <code>{folder}</code> and require consent again before another message there? Saved project rules remain stored.</>,{title:'Revoke folder trust',confirm:'Revoke and stop',icon:<ShieldAlert size={18}/>}))return;
    setError('');try{await api('/admin/agent/trust/revoke',{folder});reloadFolders();}catch(e:any){setError(e.message);}
  };
  return <Dialog title="Agent settings" icon={<Settings2 size={18}/>} onClose={onClose} wide>
    <section className="ag-set"><h3>Engine</h3>{engine?<EngineCard engine={engine} busy={busy} act={act}/>:<p className="subtle">Checking the agent engine…</p>}</section>
    <section className="ag-set"><h3>Appearance</h3>
      <p className="subtle">The font for the whole Agent view: the conversation, the message box and the menus. Persian text keeps Vazirmatn. Remembered on this computer.</p>
      <div className="ag-fonts" role="radiogroup" aria-label="Agent font">{AGENT_FONTS.map(f=><button type="button" key={f.id} role="radio" aria-checked={font===f.id} className={`ag-font${font===f.id?' chosen':''}`} style={f.family?{fontFamily:`'Agent Persian','${f.family}',sans-serif`}:undefined} onClick={()=>onFont(f.id)}>
        <span className="ag-font-name">{f.label}{font===f.id&&<Check size={14}/>}</span><span className="ag-font-sample">The agent edited 3 files. سلام، کار انجام شد.</span><small>{f.note}</small>
      </button>)}</div>
    </section>
    <section className="ag-set"><h3>Undo</h3>
      <Toggle checked={on} onChange={switchBackups} label="Back up the working folder before each message"
        detail="Lets you undo what the agent changed in a turn. Before each message Polygate copies the folder's files it has not copied yet: up to 20,000 files and 256 MB, files up to 8 MB each. Off: nothing is copied, and new turns cannot be undone from Polygate. Switching it off removes the copies only it kept; turns already recorded keep their undo."/>
    </section>
    <AgentLibrarySettings busy={!!busy}/>
    <AgentMcpSettings running={!engine||['running','starting','restarting','stopping'].includes(engine.state)} busy={!!busy}/>
    <section className="ag-set"><h3>Working folders</h3>
      {folders.length?<ul className="ag-folders">{folders.map(f=><li key={f.folder}><Folder size={15}/><div><code title={f.folder}>{f.folder}</code><small className={f.trusted?'green':'amber'}>{f.trusted?'Allowed':'Needs review before the next message'}</small></div>{f.trusted&&<Button onClick={()=>revoke(f.folder)}>Revoke</Button>}</li>)}</ul>
        :<p className="subtle">No folders yet. A folder is added when you allow the agent to work in it.</p>}
    </section>
    {error&&<div className="pg-error">{error}</div>}
    {dialog}
  </Dialog>;
}

type McpChoice={server:string;tool:string;fingerprint:string};
type McpCatalog={enabled:boolean;selected:McpChoice[];servers:{id:string;name:string;available:boolean;state:string;tools:{name:string;title?:string;description?:string;fingerprint:string;selected:boolean;changed:boolean;disabled:boolean}[]}[]};
function AgentMcpSettings({running,busy}:{running:boolean;busy:boolean}){
  const [catalog,setCatalog]=useState<McpCatalog|null>(null),[choices,setChoices]=useState<McpChoice[]>([]),[error,setError]=useState(''),[saving,setSaving]=useState(false),[saved,setSaved]=useState(false);
  const {confirm,dialog}=useConfirm();
  const load=async()=>{setError('');setSaved(false);try{const c:McpCatalog=await api('/admin/agent/mcp');setCatalog(c);setChoices(c.selected);}catch(e:any){setError(e.message);}};
  useEffect(()=>{load();},[]);
  const dirty=!!catalog&&JSON.stringify(choices)!==JSON.stringify(catalog.selected);
  const toggle=(server:string,tool:string,fingerprint:string,on:boolean)=>{setSaved(false);setChoices(c=>[...c.filter(x=>x.server!==server||x.tool!==tool),...(on?[{server,tool,fingerprint}]:[])]);};
  const save=async()=>{
    if(choices.length&&!await confirm('Share only these selected MCP tools with the Agent in all working folders? Tools run with their server’s configured access and credentials. Plan mode blocks MCP calls; other modes ask, except Full access. This is not a sandbox.',{title:'Share selected MCP tools',confirm:'Save sharing',icon:<ShieldAlert size={18}/>}))return;
    setSaving(true);setError('');try{const c:McpCatalog=await api('/admin/agent/mcp',{tools:choices});setCatalog(c);setChoices(c.selected);setSaved(true);}catch(e:any){setError(e.message);}finally{setSaving(false);}
  };
  return <section className="ag-set"><h3>Shared MCP tools</h3>
    <p className="subtle">Nothing is shared by default. Choose individual tools from the MCP hub. New or changed tools need a fresh selection; server credentials stay in Polygate. These choices apply to every Agent working folder.</p>
    {running&&<p className="subtle">Stop the engine above to change sharing, then start it again. Other clients keep their MCP connections.</p>}
    {catalog&&!catalog.enabled&&<p className="agent-warn">The MCP hub is off. Turn it on from the MCP page before sharing tools.</p>}
    {!catalog&&!error&&<p className="subtle">Loading MCP tools…</p>}
    {catalog?.servers.map(s=><details className="ag-mcp-server" key={s.id}><summary>{s.name}<span className="subtle">{choices.filter(c=>c.server===s.id).length} selected · {s.state}</span></summary>
      {!s.available&&<p className="subtle">Unavailable: check that this server is on and allows the Polygate Agent key on the MCP page.</p>}
      {!s.tools.length&&<p className="subtle">No tools listed. Connect or refresh this server on the MCP page, then refresh this list.</p>}
      {s.tools.map(t=><label className="ag-mcp-tool" key={t.name}>
        <input type="checkbox" checked={choices.some(c=>c.server===s.id&&c.tool===t.name)} disabled={running||busy||saving||(!s.available||t.disabled)&&!choices.some(c=>c.server===s.id&&c.tool===t.name)} onChange={e=>toggle(s.id,t.name,t.fingerprint,e.target.checked)}/>
        <span><strong>{t.title||t.name}</strong>{t.description&&<small>{t.description}</small>}{t.changed&&<small className="amber">Changed since sharing. Uncheck and select again to review the current definition.</small>}{t.disabled&&<small className="amber">Disabled on the MCP page</small>}</span>
      </label>)}
    </details>)}
    {catalog&&choices.some(c=>!catalog.servers.some(s=>s.id===c.server&&s.tools.some(t=>t.name===c.tool)))&&<p className="agent-warn">Some saved tools are no longer available. Clear the selection to remove them, then select the available tools again.</p>}
    <div className="button-row"><Button disabled={saving||busy} onClick={load}><RefreshCw size={14}/>Refresh list</Button><Button disabled={running||saving||busy||!choices.length} onClick={()=>{setChoices([]);setSaved(false);}}>Clear selection</Button><Button variant="primary" disabled={running||saving||busy||!dirty} onClick={save}>{saving?'Saving…':'Save sharing'}</Button></div>
    {saved&&<p className="green" role="status">Sharing saved. Start the engine to use these tools.</p>}{error&&<p className="pg-error" role="alert">{error}</p>}{dialog}
  </section>;
}

type TrustReport={folder:string;fingerprint:string;trusted:boolean;complete:boolean;files:{path:string;behavior:'disabled'|'instructions';bytes:number}[];problems:string[];skipped?:string[]};
// Asked once per folder, like other coding agents' "trust this folder". The card is the question: one click allows it.
function FolderTrust({folder,report,error,reload}:{folder:string;report:TrustReport|null;error:string;reload:()=>void}){
  const [busy,setBusy]=useState(false);const [problem,setProblem]=useState('');
  const allow=async()=>{setBusy(true);setProblem('');try{await api('/admin/agent/trust/allow',{folder});reload();}catch(e:any){setProblem(e.message);reload();}finally{setBusy(false);}};
  const read=report?.files.filter(f=>f.behavior==='instructions')||[];
  return <div className="agent-folder-trust">
    <p className="agent-trust-title"><ShieldCheck size={16}/><span>Trust <code>{folder}</code>?</span></p>
    <p className="subtle">The agent can read and change files here and run the commands you approve, with your account's access. It is not a sandbox.{read.length?<> It also follows {read.length===1?'this folder’s instructions':`${read.length} instruction files`}: {read.map(f=><code key={f.path}>{f.path}</code>)}.</>:''}</p>
    <div className="button-row"><Button variant="primary" disabled={busy||!report} onClick={allow}>{busy?'Trusting…':'Trust this folder'}</Button></div>
    {(error||problem)&&<p className="pg-error">{problem||error}</p>}
  </div>;
}

// A small button beside the message box that opens a panel above (or below, where there is more room) it. The panel is placed on the
// screen itself, kept inside the window, so no scrolling area around the button can cut it off.
function Popover({label,icon,title,disabled,width=320,tone='',children}:{label:ReactNode;icon?:ReactNode;title:string;disabled?:boolean;width?:number;tone?:string;children:(close:()=>void)=>ReactNode}){
  const [open,setOpen]=useState(false);const [place,setPlace]=useState<CSSProperties>({});const root=useRef<HTMLDivElement>(null);const panel=useRef<HTMLDivElement>(null);const trigger=useRef<HTMLButtonElement>(null);
  const close=(restore=false)=>{setOpen(false);if(restore)trigger.current?.focus({preventScroll:true});};
  const toggle=()=>{
    if(open||!root.current){setOpen(false);return;}
    const r=root.current.getBoundingClientRect();const above=r.top-16,below=window.innerHeight-r.bottom-16;const up=above>=Math.min(440,below)||above>below;
    const w=Math.min(width,window.innerWidth-32);
    setPlace({width:w,left:Math.max(16,Math.min(r.left,window.innerWidth-16-w)),maxHeight:Math.max(180,Math.min(460,up?above:below)),...(up?{bottom:window.innerHeight-r.top+6}:{top:r.bottom+6})});setOpen(true);
  };
  useEffect(()=>{
    if(!open)return;
    const away=(e:MouseEvent)=>{const t=e.target as Node;if(!root.current?.contains(t)&&!panel.current?.contains(t))close();};
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close(true);}};
    const scrolled=(e:Event)=>{if(!(e.target instanceof Node&&panel.current?.contains(e.target)))close(!!panel.current?.contains(document.activeElement));};
    const resized=()=>close(!!panel.current?.contains(document.activeElement));
    document.addEventListener('mousedown',away);document.addEventListener('keydown',key);window.addEventListener('scroll',scrolled,true);window.addEventListener('resize',resized);
    return()=>{document.removeEventListener('mousedown',away);document.removeEventListener('keydown',key);window.removeEventListener('scroll',scrolled,true);window.removeEventListener('resize',resized);};
  },[open]);
  return <div ref={root} className="ag-pop">
    <button ref={trigger} type="button" className={`ag-chip${tone?' ag-pill '+tone:''}${open?' open':''}`} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} title={title} onClick={toggle}>{icon}<span className="ag-chip-label">{label}</span><ChevronDown size={13} className="ag-chip-caret"/></button>
    {open&&<div ref={panel} className="ag-pop-panel" role="dialog" aria-label={title} style={place}>{children(()=>close(true))}</div>}
  </div>;
}

// What Full access means, said each time it is switched on (when a session starts in it, or inside one).
const FULL_WARNING=<>The agent will run commands and access files and the internet without ordinary approval prompts, with your account's access, including access to Polygate's data. This is not a sandbox. Full access stays on until you change the mode, and ends when the app or engine restarts.</>;
// The one place the mode is chosen. The caller asks for confirmation before Full access.
// Each mode's mark, used on the button and in its menu. Full access is amber everywhere it shows.
const MODE_ICON:Record<Mode,ReactNode>={ask:<ShieldCheck size={14}/>,'accept-edits':<Pencil size={14}/>,plan:<ClipboardList size={14}/>,rules:<ScrollText size={14}/>,full:<TriangleAlert size={14}/>};
const MODE_SHORT:Record<Mode,string>={ask:'Ask first','accept-edits':'Accept edits',plan:'Plan',rules:'Rules',full:'Full access'};
function ModeChip({mode,modes,disabled,onPick}:{mode:Mode;modes:Record<string,string>;disabled?:boolean;onPick:(mode:Mode)=>void}){
  return <Popover tone={`ag-mode ag-mode-${mode}`} icon={MODE_ICON[mode]} label={MODE_SHORT[mode]||modeLabel(mode)} title={disabled?'Stop the turn and answer waiting approvals before changing mode':`Permission mode: ${modeLabel(mode)}`} disabled={disabled} width={380}>
    {close=><ul className="ag-menu ag-mode-menu" role="listbox" aria-label="Permission mode">{MODES.map(m=><li key={m.id}>
      <button type="button" role="option" aria-selected={m.id===mode} className={`${m.id===mode?'chosen':''} ag-mode-${m.id}`} onClick={()=>{close();if(m.id!==mode)onPick(m.id);}}>
        <span className="ag-mode-mark">{MODE_ICON[m.id]}</span><span><strong>{m.label}</strong><small>{modes[m.id]}</small></span>{m.id===mode&&<Check size={14}/>}
      </button></li>)}</ul>}
  </Popover>;
}

function ModelChip({models,value,effort,disabled,onPick,onResync}:{models:AgentModel[];value:string;effort:string;disabled?:boolean;onPick:(id:string,effort:string)=>void;onResync:()=>Promise<number>}){
  const current=models.find(m=>m.id===value);
  // Provider (muted), model, and the effort as its own tag; a chain shows its chain mark.
  const label=current?<><span className="ag-chip-provider">{current.provider}</span><span className="ag-chip-name">{current.name}</span>{effort&&<span className="ag-chip-tag">{cap(effort)}</span>}</>:<span className="ag-chip-name">{value||'Choose a model'}</span>;
  return <Popover tone="ag-model-pill" icon={current?.members?<Workflow size={14}/>:<Cpu size={14}/>} label={label} title={disabled?'Wait until the agent is done to change the model':current?`Model: ${current.provider} · ${current.name}${effort?` · ${cap(effort)} effort`:''}`:'Model'} disabled={disabled} width={640}>
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
           <span><strong className="truncate">{m.name}</strong><small className="truncate">{provider?'':`${m.provider} · `}{m.members?`${m.members.length} steps · shared limits · `:''}{m.context?`${compact(m.context)} context`:'Context size unknown'}{m.context>0&&m.context<32000?' (small for longer tasks)':''}{m.reasoning?' · reasons':''}{m.usable?'':' · unavailable now'}</small>{!m.usable&&m.reason&&<small style={{whiteSpace:'normal'}}>{m.reason}</small>}{m.members&&<small className="truncate" title={m.members.join(' → ')}>{m.members.join(' → ')}</small>}</span>{m.id===value&&<Check size={14}/>}
        </button></li>):<li className="ag-models-none">{models.length?'No model matches.':'No model can run the agent yet: it needs one that can call tools, from a provider that is switched on.'}</li>}
      </ul>
    </div>
    {current&&current.efforts.length>0&&<div className="ag-effort"><span>Effort for {current.name}</span>{['',...current.efforts].map(x=><button type="button" key={x} className={x===effort?'chosen':''} onClick={()=>onPick(current.id,x)}>{x?cap(x):'Default'}</button>)}</div>}
  </div>;
}

// The working folder of a new session: a search, "No folder", the recent folders, or another folder from disk. `folder` is null until one
// is chosen ("Choose…"), and "" for No folder; both start a session in an empty folder of its own.
function FolderChip({folder,folders,onPick}:{folder:string|null;folders:FolderInfo[];onPick:(folder:string)=>void}){
  const bridge=window.polygateDesktop;const [text,setText]=useState('');const [query,setQuery]=useState('');
  const q=query.trim().toLowerCase();const shown=folders.filter(f=>!q||f.folder.toLowerCase().includes(q));
  return <Popover icon={<Folder size={14}/>} label={folder===null?'Choose…':folder===''?'No folder':folderName(folder)} title={folder||'Working folder'} width={420}>
    {close=>{const choose=(f:string)=>{close();setQuery('');onPick(f);};return <div className="ag-folder-pick">
      <label className="ag-models-search"><Search size={15}/><input autoFocus aria-label="Search folders" placeholder="Search folders…" value={query} onChange={e=>setQuery(e.target.value)}
        onKeyDown={e=>{if(e.key==='Enter'&&shown[0]){e.preventDefault();choose(shown[0].folder);}}}/></label>
      <ul className="ag-menu" role="listbox" aria-label="Working folders">
        {!q&&<li><button type="button" role="option" aria-selected={folder===''} className={folder===''?'chosen':''} onClick={()=>choose('')}><span><strong>No folder</strong><small>An empty folder of its own, for a task that is not about a project</small></span>{folder===''&&<Check size={14}/>}</button></li>}
        {shown.length>0&&<li className="ag-menu-label" role="presentation">Recent</li>}
        {shown.map(f=><li key={f.folder}><button type="button" role="option" aria-selected={!!folder&&sameFolder(f.folder,folder)} className={folder&&sameFolder(f.folder,folder)?'chosen':''} title={f.folder} onClick={()=>choose(f.folder)}>
          <span><strong className="truncate">{folderName(f.folder)}</strong><small className="truncate">{f.folder}{f.trusted?'':' · needs review'}</small></span>{!!folder&&sameFolder(f.folder,folder)&&<Check size={14}/>}</button></li>)}
        {q&&!shown.length&&<li className="ag-models-none">No recent folder matches.</li>}
      </ul>
      {bridge?.pickFolder?<button type="button" className="ag-folder-browse" onClick={async()=>{const f=await bridge.pickFolder!();if(f)choose(f);}}><FolderOpen size={15}/>Open folder…</button>
        // In a browser (not the desktop app) there is no folder dialog: the path is typed and checked by the gateway.
        :<form className="ag-folder-form" onSubmit={e=>{e.preventDefault();if(text.trim()){choose(text.trim());setText('');}}}><input aria-label="Working folder path" placeholder="C:\path\to\project" value={text} onChange={e=>setText(e.target.value)}/><Button type="submit">Open</Button></form>}
    </div>;}}
  </Popover>;
}

// The message box, with send (and stop while the agent works) inside it, and the folder, mode and model in a row under it.
// While the agent works, Enter (and the send button) queues the message for the end of the turn, and Ctrl+Enter steers it: the message is
// taken in at its next step.
// Typing / as the whole message (or the book button) lists skills to attach and the folder's templates to insert.
function Composer({value,onChange,files,onFiles,skills,onSkills,folder,onSend,onQueue,canSend,sending,busy,onStop,placeholder,left,right,autoFocus}:{value:string;onChange:(v:string)=>void;files:AgentFile[];onFiles:(files:AgentFile[])=>void;skills:SkillPick[];onSkills:(skills:SkillPick[])=>void;folder:string;onSend:()=>void;onQueue?:()=>void;canSend:boolean;sending:boolean;busy?:boolean;onStop?:()=>void;placeholder:string;left?:ReactNode;right:ReactNode;autoFocus?:boolean}){
  const picker=useRef<HTMLInputElement>(null);const box=useRef<HTMLTextAreaElement>(null);const reading=useRef(false);const [loading,setLoading]=useState(false);const [fileError,setFileError]=useState('');
  const [browsing,setBrowsing]=useState(false),[closed,setClosed]=useState<string|null>(null),[active,setActive]=useState(0),[entries,setEntries]=useState<{choice:MenuChoice}[]>([]);
  const typed=slashQuery(value),query=typed??'',menu=(typed!==null&&closed!==value)||browsing;
  useEffect(()=>{setActive(0);},[query]);
  const closeMenu=()=>{setBrowsing(false);setClosed(value);};
  const pick=(c:MenuChoice)=>{
    if(c.kind==='skill'){if(!skills.some(s=>s.id===c.skill.id)&&skills.length<10)onSkills([...skills,c.skill]);if(typed!==null)onChange('');}
    else onChange(typed!==null?c.text:value+(value?'\n\n':'')+c.text);
    setBrowsing(false);setClosed(null);box.current?.focus();
  };
  const ready=canSend&&!sending&&!loading&&(!!value.trim()&&typed===null||files.length>0||skills.length>0);
  const attach=async(selected:File[])=>{
    if(!selected.length||reading.current||sending)return;setFileError('');
    if(files.length+selected.length>MAX_AGENT_FILES){setFileError(`Attach up to ${MAX_AGENT_FILES} files per message.`);return;}
    const bytes=files.reduce((sum,f)=>sum+f.data.length*3/4,0)+selected.reduce((sum,f)=>sum+f.size,0);
    if(bytes>MAX_AGENT_FILE_BYTES){setFileError('Attachments must total 10 MiB or less per message.');return;}
    reading.current=true;setLoading(true);
    try{const added=await Promise.all(selected.map(f=>new Promise<AgentFile>((resolve,reject)=>{
      if(!f.size){reject(new Error(`${f.name} is empty.`));return;}
      const reader=new FileReader();reader.onerror=()=>reject(new Error(`Could not read ${f.name}.`));
      reader.onload=()=>resolve({name:f.name,mime:/\.(txt|md|csv|log|ts|tsx|js|jsx|py|sh|css|html|json|yaml|yml|toml|xml|sql)$/i.test(f.name)?'text/plain':f.type||'application/octet-stream',data:String(reader.result).split(',')[1],source:{type:'inline'}});reader.readAsDataURL(f);
    })));onFiles([...files,...added]);}catch(e:any){setFileError(e.message);}finally{reading.current=false;setLoading(false);}
  };
  return <div className="ag-compose">
    {menu&&<SkillMenu folder={folder} query={query} picked={skills} active={active} onActive={setActive} onEntries={setEntries} onPick={pick} onClose={closeMenu}/>}
    {skills.length>0&&<SkillChips skills={skills} remove={sending?undefined:id=>onSkills(skills.filter(s=>s.id!==id))}/>}
    {files.length>0&&<Attachments files={files} remove={sending||loading?undefined:i=>onFiles(files.filter((_,n)=>n!==i))}/>}
    {files.some(f=>f.mime.startsWith('image/'))&&<p className="ag-attachment-hint subtle">Images require a model that supports image input.</p>}
    {fileError&&<p className="pg-error" role="alert">{fileError}</p>}
    <div className="ag-composer">
      <input ref={picker} className="ag-file-input" type="file" multiple tabIndex={-1} aria-label="Choose attachments" onChange={e=>{void attach(Array.from(e.target.files||[]));e.target.value='';}}/>
      <button type="button" className="icon-button ag-attach" aria-label="Attach files" title="Attach files, or paste an image" disabled={sending||loading} onClick={()=>picker.current?.click()}>{loading?<Loader2 size={17} className="spin"/>:<Plus size={19}/>}</button>
      <button type="button" className={`icon-button ag-attach${menu?' active':''}`} aria-label="Skills" aria-expanded={menu} title="Skills and templates (type / in the message)" disabled={sending} onClick={()=>menu?closeMenu():setBrowsing(true)}><BookOpen size={17}/></button>
      <textarea ref={box} dir="auto" aria-label="Message to the agent" placeholder={placeholder} value={value} rows={1} autoFocus={autoFocus}
        onPaste={e=>{const pasted=Array.from(e.clipboardData.files);if(pasted.length){e.preventDefault();void attach(pasted);}}}
        onChange={e=>{onChange(e.target.value);setClosed(null);}} onKeyDown={e=>{
          if(menu&&!e.nativeEvent.isComposing){
            if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(entries.length)setActive(n=>(n+(e.key==='ArrowDown'?1:entries.length-1))%entries.length);return;}
            if((e.key==='Enter'&&!e.shiftKey||e.key==='Tab')&&entries[active]){e.preventDefault();pick(entries[active].choice);return;}
            if(e.key==='Escape'){e.preventDefault();closeMenu();return;}
          }
          if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();if(ready)(busy&&onQueue&&!(e.ctrlKey||e.metaKey)?onQueue:onSend)();}}}/>
      <div className="ag-composer-actions">
        {busy&&onStop&&<button type="button" className="ag-stop" onClick={onStop} title="Stop the agent"><Square size={12}/>Stop</button>}
        <button type="button" className="ag-send" aria-label={busy&&onQueue?'Queue for after this turn':'Send'} title={busy&&onQueue?'Queue (Enter): sent when this turn ends. Ctrl+Enter steers the agent now: it takes the message in at its next step.':'Send (Enter)'} disabled={!ready} onClick={busy&&onQueue?onQueue:onSend}>{sending?<Loader2 className="spin" size={16}/>:<ArrowUp size={17}/>}</button>
      </div>
    </div>
    <div className="ag-under">{left}<span className="toolbar-spacer"/>{right}</div>
  </div>;
}
function Attachments({files,remove}:{files:AgentFile[];remove?:(index:number)=>void}){
  return <ul className="ag-attachments" aria-label="Attached files">{files.map((f,i)=><li key={i} className={/^image\/(png|jpeg|webp|gif)$/.test(f.mime)&&f.data?'ag-image-attachment':undefined}>
    {/^image\/(png|jpeg|webp|gif)$/.test(f.mime)&&f.data?<img src={`data:${f.mime};base64,${f.data}`} alt={f.name||'Attached image'}/>:<span className="ag-file-mark"><Folder size={18}/></span>}
    {!(/^image\/(png|jpeg|webp|gif)$/.test(f.mime)&&f.data)&&<span className="truncate" dir="auto" title={f.name}>{f.name||'Attached file'}</span>}
    {remove&&<button type="button" className="icon-button" aria-label={`Remove attachment ${f.name}`} onClick={()=>remove(i)}><X size={13}/></button>}
  </li>)}</ul>;
}

// A new session: a folder, a model, a mode and the first message. Sending creates the session and sends the message to it.
function NewSession({startFolder,models,folders,reloadFolders,onResync,onCreated}:{startFolder?:string|null;models:Models|null;folders:FolderInfo[];reloadFolders:()=>void;onResync:()=>Promise<number>;onCreated:(s:SessionInfo,opening:Opening)=>void}){
  const {confirm,dialog}=useConfirm();
  // Full access is confirmed when it is picked, and never remembered as the mode the next session starts in.
  const pickMode=async(m:Mode)=>{if(m==='full'&&!await confirm(FULL_WARNING,{title:'Start with Full access',confirm:'Use Full access',icon:<ShieldAlert size={18}/>}))return;setMode(m);};
  // "New session" starts with No folder (""); a folder's own + starts in that folder.
  const [folder,setFolder]=useState<string|null>(()=>startFolder!==undefined&&startFolder!==null?startFolder:'');
  const [model,setModel]=useState(()=>stored('polygate-agent-model'));const [effort,setEffort]=useState(()=>stored('polygate-agent-effort'));
  const [mode,setMode]=useState<Mode>(()=>{const m=stored('polygate-agent-mode');return MODES.some(x=>x.id===m&&x.id!=='full')?m as Mode:'ask';});
  const [text,setText]=useState('');const [files,setFiles]=useState<AgentFile[]>([]);const [skills,setSkills]=useState<SkillPick[]>([]);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const all=models?.models||[];const usable=all.filter(m=>m.usable);const current=usable.find(m=>m.id===model)||usable[0];
  const [trust,setTrust]=useState<{requested:string;report:TrustReport}|null>(null),[trustError,setTrustError]=useState(''),[trustReload,setTrustReload]=useState(0);const trustRequest=useRef(0);
  useEffect(()=>{
    const requested=folder;++trustRequest.current;setTrustError('');if(!requested)return;let active=true;
    const stop=tickWhileVisible(async()=>{if(!active)return;const request=++trustRequest.current;try{const result:TrustReport=await api('/admin/agent/trust?folder='+encodeURIComponent(requested));const report=currentTrustReport(result,request,trustRequest.current);if(active&&report){setTrust({requested,report});setTrustError('');}}catch(e:any){if(active&&request===trustRequest.current){setTrust(null);setTrustError(e.message);}}},5000);
    return()=>{active=false;++trustRequest.current;stop();};
  },[folder,trustReload]);
  const reloadTrust=()=>setTrustReload(n=>n+1);
  const report=folder&&trust?.requested===folder?trust.report:null;const trusted=!folder||!!report?.trusted;const canonical=report?.folder||folder;
  // A folder picked from disk joins the recent folders at once.
  const pickFolder=(f:string)=>{++trustRequest.current;setTrust(null);setTrustError('');setFolder(f);reloadTrust();setError('');if(f)reloadFolders();};
  const start=async()=>{
    const t=text.trim();if((!t&&!files.length&&!skills.length)||!current||!trusted)return;setBusy(true);setError('');
    const chosen=current.efforts.includes(effort)?effort:'';
    let s:SessionInfo;
    try{s=await api('/admin/agent/session/create',{...(canonical?{folder:canonical}:{noFolder:true}),model:current.id,mode,confirmFull:mode==='full',effort:chosen,title:(t||skills[0]?.name||files[0]?.name||'Attachment').split('\n')[0].slice(0,80)});}catch(e:any){setError(e.message);setBusy(false);return;}
    store('polygate-agent-model',current.id);store('polygate-agent-effort',chosen);if(mode!=='full')store('polygate-agent-mode',mode);
    // The session exists from here on: if the message cannot be sent, it opens with the message still in its box and the reason.
    let opening:Opening={};
    try{const r=await api('/admin/agent/session/prompt',{id:s.id,text:t,files,skills:skills.map(k=>k.id)});if(r.limited)opening={notice:LIMITED};}catch(e:any){opening={draft:t,files,skills,error:e.message};}
    setBusy(false);onCreated(s,opening);
  };
  const placeholder=!current?'No model can run the agent yet…':!trusted?'Trust this folder first…':'Describe a task or ask a question';
  return <div className="ag-center">
    <div className="ag-column ag-new-session">
      <div className="ag-hero"><Hammer size={30}/><h1>What should the agent do?</h1><p>It reads, edits and runs commands in the folder you choose, through Polygate's own models, and asks first where its mode says so.</p></div>
      {folder&&report&&!report.trusted&&<FolderTrust folder={report.folder} report={report} error={trustError} reload={()=>{reloadTrust();reloadFolders();}}/>}
      {folder&&!report&&trustError&&<div className="pg-error">{trustError}</div>}
      {models&&!usable.length&&<p className="agent-warn"><TriangleAlert size={15}/>No model can run the agent yet: it needs one that can call tools, from a provider that is switched on.</p>}
      <Composer value={text} onChange={setText} files={files} onFiles={setFiles} skills={skills} onSkills={setSkills} folder={canonical||''} onSend={start} canSend={!!current&&trusted} sending={busy} placeholder={placeholder} autoFocus
        left={<FolderChip folder={canonical} folders={folders} onPick={pickFolder}/>}
        right={<><ModeChip mode={mode} modes={models?.modes||{}} onPick={pickMode}/><ModelChip models={all} value={current?.id||''} effort={current?.efforts.includes(effort)?effort:''} onResync={onResync} onPick={(id,e)=>{setModel(id);setEffort(e);}}/></>}/>
      {error&&<div className="pg-error">{error}</div>}
    </div>
    {dialog}
  </div>;
}

function SessionView({start,opening,scratch,models:modelData,onResync,onChanged,onDeleted}:{start:SessionInfo;opening?:Opening;scratch:string;models:Models|null;onResync:()=>Promise<number>;onChanged:()=>void;onDeleted:()=>void}){
  const id=start.id,folder=start.folder;const models=modelData?.models||[];const noFolder=!!scratch&&inFolder(folder,scratch);
  const [info,setInfo]=useState<SessionInfo>(start);const [items,setItems]=useState<Item[]>([]);const [pending,setPending]=useState<Approval[]>([]);
  const [paused,setPaused]=useState('');const [busy,setBusy]=useState(false);const [usage,setUsage]=useState<SessionInfo['tokens']>(start.tokens);
  const [error,setError]=useState(opening?.error||'');const [notice,setNotice]=useState(opening?.notice||'');const [live,setLive]=useState<'connecting'|'syncing'|'recovering'|'live'|'lost'>('connecting');const [requests,setRequests]=useState<RouteUsage|null>(null);
  const [text,setText]=useState(opening?.draft||'');const [files,setFiles]=useState<AgentFile[]>(opening?.files||[]);const [skills,setSkills]=useState<SkillPick[]>(opening?.skills||[]);const [sending,setSending]=useState(false);
  const draftRevision=useRef({text:0,files:0,skills:0});
  const editText=(value:string|((current:string)=>string))=>{draftRevision.current.text++;setText(value);};
  const editFiles=(value:AgentFile[])=>{draftRevision.current.files++;setFiles(value);};
  const editSkills=(value:SkillPick[])=>{draftRevision.current.skills++;setSkills(value);};
  const [rules,setRules]=useState(false);
  const [workspace,setWorkspace]=useState(false);const [workspaceTab,setWorkspaceTab]=useState<'changes'|'plan'>('changes');
  const thread=useRef<HTMLDivElement>(null);const changed=useRef(onChanged);changed.current=onChanged;const deleted=useRef(onDeleted);deleted.current=onDeleted;
  const follow=useRef(true);const [away,setAway]=useState(false);
  const {data:trust,error:trustError,reload:reloadTrust}=usePoll<TrustReport>('/admin/agent/trust?folder='+encodeURIComponent(folder),10000,!!folder);
  const untrusted=trust&&sameFolder(trust.folder,folder)&&!trust.trusted?trust:null;
  const resync=useRef(()=>{});
  // Subscribe before loading history; buffer live traffic until the snapshot is installed.
  useEffect(()=>{
    let source:EventSource|undefined;let closed=false;let syncing=false;let again=false;let connected=false;let engineConnected=true;
    const consistency=reconnectConsistency();
    const repair=snapshotRepair(()=>{void sync();});
    const handle=(e:any)=>{
      const d=e.data||{};
      if(e.type==='agent.deleted'){deleted.current();return;}
      if(e.type==='agent.stream'){engineConnected=!!d.connected;if(!d.connected){setLive('lost');consistency.invalidate();}else{setLive('syncing');void sync();}return;}
      if(e.type==='agent.state'){setPending(d.pending||[]);setPaused(d.paused||'');setBusy(!!d.busy);return;}
      if(e.type==='permission.asked'){setPending(p=>p.some(x=>x.id===d.id)?p:[...p,{id:d.id,action:d.action,resources:d.resources||[],note:d.note||'',input:d.input}]);return;}
      if(e.type==='permission.replied'){setPending(p=>p.filter(x=>x.id!==d.requestID));return;}
      if(e.type==='agent.approval.auto')setPending(p=>p.filter(x=>x.id!==d.requestID));
      if(e.type==='agent.paused'){setPaused(d.message||'The model kept failing.');setBusy(false);return;}
      if(e.type==='agent.undone'){repair.request(true);return;}
      if(e.type==='agent.mode')setInfo(i=>({...i,mode:d.mode}));
      if(e.type==='session.execution.started'){setBusy(true);setPaused('');}
      if(/^session\.execution\.(succeeded|failed|interrupted)$/.test(e.type)){setBusy(false);changed.current();repair.request(true);}
      if(e.type==='session.usage.updated'&&d.tokens)setUsage(d.tokens);
      setItems(list=>applyEvent(list,e));
    };
    const sync=async()=>{
      if(closed)return;if(syncing){again=true;return;}repair.begin();syncing=true;setLive('syncing');
      const request=consistency.begin();
      try{const [s,changes]=await Promise.all([api('/admin/agent/session?id='+encodeURIComponent(id)),api('/admin/agent/session/changes?id='+encodeURIComponent(id))]);if(closed)return;
        const snapshot=[...withChanges(fromHistory(s.messages),changes.turns||[]),...fromInbox(s.inbox||[])];
        const replay=consistency.install(request,snapshot,s.reconnect);if(!replay){again=connected;return;}
        setInfo(s.session);setItems(snapshot);setRequests(s.usage||null);setPending(s.pending||[]);setPaused(s.paused||'');setBusy(!!s.busy);setUsage(s.session.tokens);
        engineConnected=!!s.reconnect.connected;setLive(!connected||!engineConnected?'lost':replay.refresh||s.busy?'recovering':'live');
        for(const e of replay.events)handle(e);
        // A disconnected engine stream cannot be repaired by polling history. Its reconnect event resumes reconciliation.
        repair.complete(replay.refresh&&s.reconnect.connected);
      }catch(e:any){if(!closed){setError(e.message);setLive(connected&&engineConnected?'recovering':'lost');if(connected&&engineConnected)repair.failed();else repair.complete(false);}}
      finally{syncing=false;if(again&&!closed){again=false;void sync();}}
    };
    resync.current=()=>repair.request(true);
    (()=>{
      source=new EventSource(at('/admin/agent/events?id='+encodeURIComponent(id)));
      source.onopen=()=>{connected=true;consistency.invalidate();setLive('syncing');void sync();};
      source.onerror=()=>{connected=false;consistency.invalidate();setLive('lost');};
      source.onmessage=m=>{try{const e=JSON.parse(m.data);if(e.type==='agent.replay'){consistency.invalidate(true);void sync();return;}
        // Stream gaps must invalidate an in-flight snapshot immediately, not wait in its buffer.
        if(e.type==='agent.stream'){handle(e);return;}
        if(e.type==='agent.deleted'){deleted.current();return;}
        if(e.type==='agent.undone'){consistency.invalidate(true);void sync();return;}
        if(!/^session\.execution\.(succeeded|failed|interrupted)$/.test(e.type))repair.delta();const next=consistency.receive(e);if(next.refresh){setLive('recovering');repair.request();}if(next.event)handle(next.event);
      }catch{/* a malformed event is skipped */}};
    })();
    return ()=>{closed=true;repair.dispose();source?.close();};
  },[id]);
  // Follows the newest output while the reader is near the bottom; reading further up is left alone.
  useEffect(()=>{
    const el=thread.current,content=el?.firstElementChild;if(!el||!content)return;
    const scroll=()=>{follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<80;setAway(!follow.current);};
    const resize=new ResizeObserver(()=>{if(follow.current)el.scrollTop=el.scrollHeight;scroll();});
    el.addEventListener('scroll',scroll,{passive:true});resize.observe(el);resize.observe(content);
    return()=>{el.removeEventListener('scroll',scroll);resize.disconnect();};
  },[]);
  const latest=()=>{const el=thread.current;if(!el)return;follow.current=true;el.scrollTop=el.scrollHeight;setAway(false);};
  const send=async(delivery:'steer'|'queue'='steer')=>{const t=text.trim();if(!t&&!files.length&&!skills.length)return;const revision={...draftRevision.current};setSending(true);setError('');setNotice('');try{const r=await api('/admin/agent/session/prompt',{id,text:t,delivery,files,skills:skills.map(k=>k.id)});setText(current=>clearSubmitted(current,text,'',draftRevision.current.text,revision.text));setFiles(current=>clearSubmitted(current,files,[],draftRevision.current.files,revision.files));setSkills(current=>clearSubmitted(current,skills,[],draftRevision.current.skills,revision.skills));if(r.limited)setNotice(LIMITED);}catch(e:any){setError(e.message);}finally{setSending(false);}};
  const stop=async()=>{try{await api('/admin/agent/session/cancel',{id});}catch(e:any){setError(e.message);}};
  const {confirm,dialog}=useConfirm();
  const changeMode=async(mode:Mode)=>{
    if(mode==='full'&&!await confirm(FULL_WARNING,{title:'Enable Full access',confirm:'Enable Full access',icon:<ShieldAlert size={18}/>}))return;
    setError('');try{await api('/admin/agent/session/mode',{id,mode,confirmFull:mode==='full'});setInfo(i=>({...i,mode}));}catch(e:any){setError(e.message);}
  };
  const switchModel=async(model:string,effort:string)=>{setError('');try{await api('/admin/agent/session/model',{id,model,effort});setInfo(i=>({...i,model,effort}));if(paused){setPaused('');setNotice('Model changed. Send a message to carry on.');}}catch(e:any){setError(e.message);}};
  // Undo goes back to just before this turn's message: this turn and every later one are undone, and their messages leave the conversation.
  // Queued messages wait above the message box; everything else is the conversation.
  const transcript=useMemo(()=>items.filter(i=>!isQueued(i)),[items]);const queued=useMemo(()=>items.filter(isQueued),[items]);
  const blocked=useMemo(()=>undoBlocked(transcript),[transcript]);
  const undo=async(message:string)=>{
    const cards=transcript.filter((i):i is Extract<Item,{kind:'changes'}>=>i.kind==='changes');const from=cards.findIndex(c=>c.message===message);if(from<0)return;
    const files=[...new Set(cards.slice(from).flatMap(c=>c.files.map(f=>f.file)))];const later=cards.length-from-1;
    const ok=await confirm(<>Remove this turn's changes from {files.length===1?<code>{files[0]}</code>:`${files.length} files`}.{later>0?` This also undoes the ${later} later turn${later>1?'s':''} that changed files.`:''} The conversation from this message on is removed. Your non-overlapping edits are preserved. If any file cannot be safely merged, nothing is undone.</>,{title:'Undo this turn',confirm:'Undo',icon:<Undo2 size={18}/>});
    if(!ok)return;setError('');setNotice('');
    try{const r=await api('/admin/agent/session/undo',{id,message});setNotice(`Undone: ${r.files.length} file${r.files.length===1?'':'s'} restored.${r.merged?' Your non-overlapping edits were preserved.':''}`);}catch(e:any){setError(e.message);}
  };
  const [naming,setNaming]=useState<string|null>(null);const rename=async()=>{const title=(naming||'').trim();if(!title||title===info.title){setNaming(null);return;}try{await api('/admin/agent/session/rename',{id,title});setInfo(i=>({...i,title}));changed.current();}catch(e:any){setError(e.message);}setNaming(null);};
  const answer=async(p:Approval,decision:'once'|'session'|'project'|'deny')=>{
    if(decision==='project'&&!await confirm(<>Save this exact {p.action} request for this working folder? It will be allowed in future sessions without asking. It does not match broader command prefixes. Remove it under Project rules.</>,{title:'Save project rule',confirm:'Save and allow',icon:<ShieldCheck size={18}/>}))return;
    setPending(list=>list.filter(x=>x.id!==p.id));
    try{await api('/admin/agent/session/approve',{id,request:p.id,decision});}catch(e:any){setError(e.message);resync.current();}
  };
  const shown=useMemo(()=>blocks(transcript),[transcript]);const todos=useMemo(()=>latestTodos(transcript),[transcript]);
  // A queued message taken back, or sent now as steering; the screen follows at once, the engine confirms with its own event.
  const unqueue=async(inbox:string,how:'cancel'|'steer')=>{setError('');try{await api('/admin/agent/session/inbox/'+how,{id,inbox});setItems(list=>applyEvent(list,how==='cancel'?{type:'session.inbox.cancelled',data:{inboxID:inbox}}:{type:'session.inbox.delivery.changed',data:{inboxID:inbox,delivery:'steer'}}));}catch(e:any){setError(e.message);}};
  const turns=transcript.filter((i):i is Extract<Item,{kind:'changes'}>=>i.kind==='changes');
  const fileCount=new Set(turns.flatMap(t=>t.files.map(f=>f.file))).size;
  // When the current turn started, for the working time under the conversation.
  const [busySince,setBusySince]=useState(0);useEffect(()=>{setBusySince(busy?Date.now():0);},[busy]);
  const mode=(info.mode||'ask') as Mode;const tokens=usage?usage.input+usage.output+(usage.reasoning||0):0;
  const hint=mode==='plan'?'In Plan mode it reads and plans; it does not change files or run commands.':mode==='accept-edits'?'It changes files without asking and asks before running commands.':mode==='full'?'Full access: it runs commands and changes files without asking.':'It reads freely and asks before changing files or running commands.';
  return <>
    <header className="ag-head">
      <div className="ag-head-title">{naming!==null?<input dir="auto" className="agent-rename" aria-label="Session name" autoFocus value={naming} maxLength={120} onChange={e=>setNaming(e.target.value)} onBlur={rename} onKeyDown={e=>{if(e.key==='Enter')rename();if(e.key==='Escape')setNaming(null);}}/>
        :<h2 title={info.title}><span className="truncate" dir="auto">{info.title||'Session'}</span><button className="icon-button agent-rename-button" aria-label="Rename session" title="Rename" onClick={()=>setNaming(info.title||'')}><Pencil size={13}/></button></h2>}
        <span className="subtle truncate" title={folder}><Folder size={12}/>{folder}</span></div>
      <span className="toolbar-spacer"/>
      {tokens>0&&<span className="pg-stat" title="Tokens this session has used, as the engine counts them">{compact(tokens)} tokens</span>}
      {requests&&requests.requests>0&&<span className={`pg-stat${requests.errors?' warn':''}`} title={`Model requests this session made through Polygate, by route:\n${requests.routes.map(r=>`${r.route||'-'}: ${r.requests}`).join('\n')}`}>
        {requests.requests} request{requests.requests===1?'':'s'}{requests.errors?`, ${requests.errors} failed`:''}</span>}
      <button className={`ag-chip${rules?' open':''}`} aria-expanded={rules} onClick={()=>setRules(r=>!r)} title="Saved approvals for this folder"><ListChecks size={14}/>Project rules</button>
      <button type="button" className={`ag-chip${workspace&&workspaceTab==='changes'?' open':''}`} aria-expanded={workspace&&workspaceTab==='changes'} aria-controls="agent-workspace" onClick={()=>{setWorkspaceTab('changes');setWorkspace(w=>workspaceTab!=='changes'||!w);}} title="Recorded file changes and Git inspection"><Files size={14}/>Changes{fileCount>0?` (${fileCount})`:''}</button>
      <button type="button" className={`ag-chip${workspace&&workspaceTab==='plan'?' open':''}`} aria-expanded={workspace&&workspaceTab==='plan'} aria-controls="agent-workspace" onClick={()=>{setWorkspaceTab('plan');setWorkspace(true);}}><ListChecks size={14}/>Plan{todos.length?` (${todos.filter(t=>t.status==='completed').length}/${todos.length})`:''}</button>
       <span className={`agent-live ${live}`} role="status" title={live==='recovering'?'Some streamed text may already be in history. Waiting for complete output or a quiet snapshot to reconcile it.':undefined}>{live==='live'?'Live':live==='lost'?'Reconnecting…':live==='recovering'?'Reconciling output…':live==='syncing'?'Syncing history…':'Connecting…'}</span>
    </header>
    {rules&&<ProjectRules id={id} mode={mode}/>}
    <div className="ag-workspace-layout"><div className="ag-conversation">
    <div className="ag-thread-wrap"><div className="ag-thread" ref={thread} aria-live="polite"><div className="ag-column">
      {untrusted&&<FolderTrust folder={folder} report={untrusted} error={trustError} reload={reloadTrust}/>}
      {shown.length?shown.map(b=><Row key={b.key} block={b} folder={folder} busy={busy} blocked={b.kind==='changes'?blocked.get(b.message):undefined} onUndo={undo}/>):<p className="subtle agent-hint">Tell the agent what to do in this folder. {hint}</p>}
      {busy&&<Working since={busySince} waiting={pending.length>0}/>}
    </div></div>
      {away&&<button type="button" className="ag-jump" aria-label="Go to latest message" title="Go to latest message" onClick={latest}><ArrowDown size={18}/></button>}
    </div>
    <div className="ag-bottom"><div className="ag-column">
      {todos.length>0&&(busy||todos.some(t=>!['completed','cancelled'].includes(t.status)))&&<TodoCard todos={todos}/>}
      {pending.map(p=><ApprovalCard key={p.id} request={p} answer={answer}/>)}
      <AgentForms id={id}/>
      {paused&&<div className="agent-paused" role="status"><TriangleAlert size={17}/><div><strong>Paused.</strong> {plainError(paused)} Send a message to try again, or pick another model below.</div></div>}
      {notice&&!error&&<div className="agent-notice" role="status">{notice}</div>}
      {error&&<div className="pg-error agent-error">{error}</div>}
      {queued.length>0&&<QueuedMessages queued={queued} busy={busy} onSteer={k=>unqueue(k,'steer')} onRemove={k=>unqueue(k,'cancel')}/>}
      <Composer value={text} onChange={editText} files={files} onFiles={editFiles} skills={skills} onSkills={editSkills} folder={folder} onSend={()=>send('steer')} onQueue={()=>send('queue')} canSend={!untrusted} sending={sending} busy={busy} onStop={stop}
        placeholder={busy?'Enter queues it for after this turn, Ctrl+Enter steers the agent now':'Reply to the agent…'}
        left={<span className="ag-under-note" title={folder}><Folder size={14}/><span className="truncate">{noFolder?'No folder':folderName(folder)}</span></span>}
        right={<><ModeChip mode={mode} modes={modelData?.modes||{}} disabled={busy||pending.length>0} onPick={changeMode}/><ModelChip models={models} value={info.model} effort={info.effort} disabled={busy} onResync={onResync} onPick={switchModel}/></>}/>
    </div></div>
    </div>
    {workspace&&<AgentWorkspace id={id} turns={turns} todos={todos} initialTab={workspaceTab} busy={busy} blocked={blocked} onUndo={undo} onClose={()=>setWorkspace(false)} onInsert={template=>{editText(t=>t+(t?'\n\n':'')+template);setWorkspace(false);}}/>}
    </div>
    {dialog}
  </>;
}

// One piece of the conversation, drawn like a chat app: your messages in a box on the right, the agent's replies as plain text, and
// what it did as quiet one-line summaries that open to show each step.
function Row({block,folder,busy,blocked,onUndo}:{block:Block;folder:string;busy:boolean;blocked?:string;onUndo:(message:string)=>void}){
  if(block.kind==='changes')return <ChangesLine files={block.files} busy={busy} blocked={blocked} undo={()=>onUndo(block.message)}/>;
  if(block.kind==='user')return <div className="ag-message ag-message-user">{!!block.skills?.length&&<SkillChips skills={block.skills}/>}{!!block.files?.length&&<Attachments files={block.files}/>} {!!block.text&&<><div className="ag-msg-user"><pre dir="auto">{block.text}</pre></div><MessageCopy text={block.text} who="your message"/></>}</div>;
  if(block.kind==='text')return block.text?<div className="ag-message ag-msg-agent"><Markdown text={block.text}/><MessageCopy text={block.text} who="agent message"/></div>:null;
  if(block.kind==='reasoning')return <details className="ag-line ag-kind-think"><summary>{block.done?<><Brain size={14} className="ag-kind-icon"/>Thought</>:<><Loader2 size={13} className="spin ag-kind-icon"/>Thinking</>}<ChevronRight size={13} className="ag-line-chevron"/></summary><pre dir="auto" className="ag-thought">{block.text}</pre></details>;
  if(block.kind==='queued')return null;
  if(block.kind==='note')return <div className={`agent-note ${block.tone}`}>{block.text}</div>;
  return <Steps tools={block.tools} folder={folder}/>;
}
function MessageCopy({text,who}:{text:string;who:string}){
  const [state,setState]=useState<'idle'|'copied'|'error'>('idle');
  useEffect(()=>{if(state==='idle')return;const timer=setTimeout(()=>setState('idle'),2500);return()=>clearTimeout(timer);},[state]);
  const copy=async()=>{try{await navigator.clipboard.writeText(text);setState('copied');}catch{setState('error');}};
  const label=state==='copied'?'Copied':`Copy ${who}`;
  return <div className={`ag-message-actions${state!=='idle'?' active':''}`}>
    <button type="button" className="icon-button" aria-label={label} title={label} onClick={copy}>{state==='copied'?<Check size={14}/>:<Copy size={14}/>}</button>
    <span className={state==='error'?'red':'subtle'} role="status">{state==='copied'?'Copied':state==='error'?'Clipboard unavailable. Select and copy the message.':''}</span>
  </div>;
}
// Each kind of work has its own icon and colour (styles.css .ag-kind-*), so a long turn reads at a glance.
const KIND_ICONS:Record<StepKind,typeof Brain>={run:SquareTerminal,read:FileText,edit:Pencil,search:Search,web:Globe,agent:Hammer,todo:ListChecks,other:Wrench};
function Steps({tools,folder}:{tools:Tool[];folder:string}){
  const working=tools.some(t=>t.status==='running'||t.status==='preparing');
  const parts=stepsParts(tools);
  return <details className="ag-line"><summary>{working&&<Loader2 size={13} className="spin"/>}<span className="ag-kinds">{parts.map((p,i)=>{const Icon=KIND_ICONS[p.kind];return <span key={i} className={'ag-kind ag-kind-'+p.kind}><Icon size={14} className="ag-kind-icon"/>{p.text.charAt(0).toUpperCase()+p.text.slice(1)}</span>;})}{failedNote(tools)&&<span className="ag-kind-failed">{failedNote(tools).trim()}</span>}</span><ChevronRight size={13} className="ag-line-chevron"/></summary>
    <div className="ag-steps">{tools.map(t=><Step key={t.key} tool={t} folder={folder}/>)}</div>
  </details>;
}
function Step({tool:t,folder}:{tool:Tool;folder:string}){
  const subject=toolSubject(t.name,t.input,folder);
  const icon=t.status==='done'?<Check size={13} className="green"/>:t.status==='failed'?<X size={13} className="red"/>:<Loader2 size={13} className="spin"/>;
  return <details className={`agent-tool ${t.status} ag-kind-${stepKind(t.name)}`}><summary>{icon}<strong>{t.name}</strong>{subject&&<code className="truncate" title={subject}>{subject}</code>}</summary>
    {t.error&&<p className="agent-error-text">{t.error}</p>}
    {t.output?<pre>{t.output.length>6000?t.output.slice(0,6000)+'\n…':t.output}</pre>:!t.error&&<p className="subtle">{t.status==='done'?'No output.':'Waiting for the result…'}</p>}
  </details>;
}
// Messages waiting for the end of the turn, just above the message box: each can be sent now as steering, or taken back.
function QueuedMessages({queued,busy,onSteer,onRemove}:{queued:Extract<Item,{kind:'queued'}>[];busy:boolean;onSteer:(key:string)=>void;onRemove:(key:string)=>void}){
  return <section className="ag-queue" aria-label="Queued messages">
    <div className="ag-queue-head"><ListEnd size={14}/><strong>Queued</strong><span className="ag-queue-count">{queued.length}</span><small>{busy?'Sent when this turn ends. Ctrl+Enter steers instead.':'Sending now…'}</small></div>
    <ul>{queued.map(q=>{const label=q.text.trim()||[...(q.skills||[]).map(k=>k.name),...(q.files||[]).map(f=>f.name)].join(', ')||'Message';
      return <li key={q.key}><span className="ag-queue-text" dir="auto" title={q.text}>{label}</span>{!!q.files?.length&&q.text.trim()&&<span className="ag-queue-tag">{q.files.length} file{q.files.length===1?'':'s'}</span>}
        <button type="button" className="text-button ag-queue-steer" title="Send it to the agent now: it takes it in at its next step" aria-label={`Steer now: ${label}`} onClick={()=>onSteer(q.key)}><CornerDownRight size={13}/>Steer now</button>
        <button type="button" className="icon-button" aria-label={`Remove queued message: ${label}`} title="Remove from the queue" onClick={()=>onRemove(q.key)}><X size={14}/></button></li>;})}</ul>
  </section>;
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
    {t.status==='completed'?<CheckCircle2 size={15}/>:t.status==='in_progress'?<Loader2 size={15} className="spin"/>:<Circle size={15}/>}<span dir="auto">{t.content}</span></li>)}</ul>;
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

function ApprovalCard({request:p,answer}:{request:Approval;answer:(p:Approval,decision:'once'|'session'|'project'|'deny')=>void}){
  return <div className="agent-approval" role="alert">
    <div className="agent-approval-head"><ShieldCheck size={18}/><strong>{approvalTitle(p.action)}</strong></div>
    {p.resources.map(r=><code key={r} className="agent-approval-target">{r}</code>)}
    {p.action.startsWith('polygate_shared_')&&p.input!==undefined&&<pre className="agent-approval-target">{JSON.stringify(p.input,null,2)}</pre>}
    {p.note&&<p className="agent-approval-note">{p.note}</p>}
    <div className="agent-approval-actions">
      <Button variant="primary" onClick={()=>answer(p,'once')}>Allow once</Button>
      {!p.action.startsWith('polygate_shared_')&&<Button onClick={()=>answer(p,'session')}>Allow for this session</Button>}
      {['shell','edit','read','webfetch','websearch','external_directory','subagent'].includes(p.action)&&<Button onClick={()=>answer(p,'project')}>Save project rule</Button>}
      <Button onClick={()=>answer(p,'deny')}>Deny</Button>
    </div>
    <p className="subtle">{p.action.startsWith('polygate_shared_')?'MCP consent applies to this call only. Review the arguments above.':'Allow for this session: this exact request goes ahead without asking again until the session ends.'} Deny stops this turn, together with anything else the agent asked to do at the same time.</p>
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
