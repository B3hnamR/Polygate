import {useCallback,useEffect,useRef,useState} from 'react';
import {Bot,Brain,Check,Download,FileDiff,FolderOpen,Loader2,Pencil,Play,Plus,Send,ShieldCheck,Square,TriangleAlert,Undo2,X} from 'lucide-react';
import {api,at} from './api';
import {Badge,Button,Empty,Field,Progress,Select,compact,usePoll,when} from './ui';
import {MODES,modeLabel,fromHistory,applyEvent,approvalTitle,toolSubject,withChanges,type Approval,type Item,type Mode} from './agent-logic';
import {useConfirm} from './confirm';
// The Agent page (docs/agent/PLAN.md, Phase 2b): a coding agent working in a folder the user chooses, through Polygate's own models.
// Everything goes through the agent controller (backend/agent.ts); the page never talks to the engine itself. Desktop app only.

type Engine={state:string;installed:boolean;version:string;message:string;problems:string[];progress?:number;snapshots?:{ok:boolean;reason?:string};freeIdentity?:{presented:string;engine:string;usable:boolean}};
type AgentModel={id:string;name:string;provider:string;context:number;output:number;reasoning:boolean;efforts:string[];usable:boolean;reason?:string};
type Models={models:AgentModel[];modes:Record<string,string>};
type RouteUsage={requests:number;errors:number;input:number;output:number;last:number;routes:{route:string;requests:number}[]};
type SessionInfo={id:string;title:string;mode:Mode|'';model:string;effort:string;folder:string;created?:number;tokens?:{input:number;output:number;reasoning?:number;cache?:{read:number;write:number}}};
const cap=(s:string)=>s.charAt(0).toUpperCase()+s.slice(1);
const sameFolder=(a:string,b:string)=>a.replace(/\\/g,'/').replace(/\/$/,'').toLowerCase()===b.replace(/\\/g,'/').replace(/\/$/,'').toLowerCase();
// Remembered on this computer only: the last folder, recent folders, the open session per folder and the last model.
const stored=(key:string)=>{try{return localStorage.getItem(key)||'';}catch{return '';}};
const store=(key:string,value:string)=>{try{localStorage.setItem(key,value);}catch{/* storage can be off */}};
const storedList=(key:string):string[]=>{try{const v=JSON.parse(localStorage.getItem(key)||'[]');return Array.isArray(v)?v.filter(x=>typeof x==='string'):[];}catch{return [];}};

const ENGINE_LABEL:Record<string,string>={not_installed:'Not installed',installing:'Downloading',installed:'Off',starting:'Starting',restarting:'Restarting',running:'Running',stopping:'Stopping',failed:'Stopped with a problem'};
export function AgentPage(){
  const {data:engine,error,reload}=usePoll<Engine>('/admin/agent/engine',2000);
  const [busy,setBusy]=useState('');const [problem,setProblem]=useState('');
  const act=async(path:string,label:string)=>{setBusy(label);setProblem('');try{await api(path,{});}catch(e:any){setProblem(e.message);}finally{setBusy('');reload();}};
  if(!engine)return <section className="section-block agent-engine"><div className="agent-engine-body">{error?<div className="pg-error">{error}</div>:<p className="subtle"><Loader2 className="spin" size={15}/> Checking the agent engine…</p>}</div></section>;
  return <div className="agent-page">
    <EngineBar engine={engine} busy={busy} problem={problem} act={act}/>
    {engine.state==='running'&&<Workspace/>}
  </div>;
}

function EngineBar({engine,busy,problem,act}:{engine:Engine;busy:string;problem:string;act:(path:string,label:string)=>void}){
  const s=engine.state;const running=s==='running';const working=['installing','starting','restarting','stopping'].includes(s)||!!busy;
  const badge=running?'running':s==='failed'?'error':working?'buffered':'idle';
  return <section className={`section-block agent-engine${running?' running':''}`}><div className="agent-engine-body">
    <div className="agent-engine-head">
      <Bot size={20}/><div><strong>Agent engine</strong> <span className="subtle">OpenCode {engine.version}</span></div>
      <Badge state={badge}>{s==='installing'?`Downloading ${engine.progress??0}%`:ENGINE_LABEL[s]||s}</Badge>
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
    {problem&&<div className="pg-error">{problem}</div>}
  </div></section>;
}

function Workspace(){
  const [folder,setFolder]=useState(()=>stored('polygate-agent-folder'));
  const [recent,setRecent]=useState<string[]>(()=>storedList('polygate-agent-recent'));
  const [selected,setSelected]=useState(()=>folder?stored('polygate-agent-session:'+folder):'');const [fresh,setFresh]=useState('');
  const {data:models}=usePoll<Models>('/admin/agent/models',60000);
  const trustPath=folder?'/admin/agent/trust?folder='+encodeURIComponent(folder):'/admin/agent/models';
  const {data:trust,error:trustError,reload:reloadTrust}=usePoll<TrustReport>(trustPath,5000,!!folder);
  const trusted=!!folder&&!!trust&&sameFolder(trust.folder,folder)&&trust.trusted;
  const sessionsPath=folder?`/admin/agent/sessions?folder=${encodeURIComponent(folder)}`:'/admin/agent/models';
  const {data:list,error:listError,reload}=usePoll<{sessions:SessionInfo[]}>(sessionsPath,10000,!!folder);
  const pick=(f:string)=>{setFolder(f);store('polygate-agent-folder',f);const next=[f,...recent.filter(x=>x!==f)].slice(0,6);setRecent(next);store('polygate-agent-recent',JSON.stringify(next));setSelected(stored('polygate-agent-session:'+f));};
  const select=(id:string)=>{setSelected(id);store('polygate-agent-session:'+folder,id);};
  const sessions=folder&&list?list.sessions:[];
  return <div className="agent-layout">
    <aside className="section-block agent-side">
      <div className="agent-side-block">
        <h3>Working folder</h3>
        {folder?<p className="agent-folder mono" title={folder}>{folder}</p>:<p className="subtle">Choose the project folder the agent works in.</p>}
        <FolderPicker onPick={pick}/>
        {folder&&<FolderTrust folder={folder} report={trust&&sameFolder(trust.folder,folder)?trust:null} error={trustError} reload={reloadTrust}/>}
        {recent.filter(f=>f!==folder).length>0&&<div className="agent-recent">{recent.filter(f=>f!==folder).map(f=><button key={f} className="text-button truncate" title={f} onClick={()=>pick(f)}>{f}</button>)}</div>}
        {folder&&listError&&<div className="pg-error">{listError}</div>}
      </div>
      {folder&&!listError&&models&&trusted&&<NewSession folder={folder} data={models} onCreated={id=>{setFresh(id);select(id);reload();}}/>}
      {folder&&!listError&&<div className="agent-side-block"><h3>Sessions</h3>
        {sessions.length?<ul className="agent-sessions">{sessions.map(s=><li key={s.id}><button className={`agent-session-item${s.id===selected?' active':''}`} aria-current={s.id===selected?'true':undefined} onClick={()=>select(s.id)}>
          <span className="truncate">{s.title}</span><small>{when(s.created||0)}{s.mode?` · ${modeLabel(s.mode)}`:''}</small></button></li>)}</ul>:<p className="subtle">No sessions in this folder yet.</p>}
      </div>}
    </aside>
    <div className="agent-main">
      {folder&&selected&&(selected===fresh||sessions.some(s=>s.id===selected))?<SessionView key={selected} id={selected} folder={folder} models={models?.models||[]} onChanged={reload}/>
        :<Empty icon={Bot} title={folder?'No session open':'Choose a working folder'}>{folder?'Start a session, or open one from the list.':'The agent reads, edits and runs commands in the folder you choose, and asks first where its mode says so.'}</Empty>}
    </div>
  </div>;
}

type TrustReport={folder:string;fingerprint:string;trusted:boolean;complete:boolean;files:{path:string;behavior:'disabled'|'instructions';bytes:number}[];problems:string[]};
function FolderTrust({folder,report,error,reload}:{folder:string;report:TrustReport|null;error:string;reload:()=>void}){
  const [busy,setBusy]=useState(false);const [problem,setProblem]=useState('');const {confirm,dialog}=useConfirm();
  const allow=async()=>{
    if(!report||!await confirm(<>Allow the agent to work in <code>{folder}</code>? It may read project instructions. Approved commands run project code with your account's access. Project plugins, commands and permission overrides remain disabled; this consent does not enable them. This is not a sandbox.</>,{title:'Allow working folder',confirm:'Allow this folder'}))return;
    setBusy(true);setProblem('');try{await api('/admin/agent/trust/allow',{folder,fingerprint:report.fingerprint});reload();}catch(e:any){setProblem(e.message);reload();}finally{setBusy(false);}
  };
  const revoke=async()=>{
    if(!await confirm('Stop running turns in this folder and require consent again before another message? Saved project rules remain stored.',{title:'Revoke folder trust',confirm:'Revoke and stop'}))return;
    setBusy(true);try{await api('/admin/agent/trust/revoke',{folder});reload();}catch(e:any){setProblem(e.message);}finally{setBusy(false);}
  };
  return <div className="agent-folder-trust">
    <p className={report?.trusted?'subtle':'agent-warn'}><ShieldCheck size={14}/>{report?.trusted?'Working folder allowed':report?'Review this folder before running the agent':'Checking project customization…'}</p>
    {report&&<><details><summary>Project customization ({report.files.length})</summary><p className="subtle">Instructions may affect the agent. Repository plugins, commands and permission settings remain disabled.</p>
      {report.files.length?<ul>{report.files.map(f=><li key={f.path}><code>{f.path}</code><small>{f.behavior==='instructions'?'Project instructions':'Not loaded'}</small></li>)}</ul>:<p className="subtle">No customization was found in the checked project locations.</p>}
      {report.problems.map(p=><p className="agent-error-text" key={p}>{p}</p>)}</details>
      {report.trusted?<button className="text-button" disabled={busy} onClick={revoke}>Revoke folder trust</button>:<Button variant="primary" disabled={busy||!report.complete} onClick={allow}>{busy?'Working…':'Review and allow'}</Button>}</>}
    {(error||problem)&&<p className="pg-error">{problem||error}</p>}{dialog}
  </div>;
}

function FolderPicker({onPick}:{onPick:(folder:string)=>void}){
  const bridge=window.polygateDesktop;const [text,setText]=useState('');
  if(bridge?.pickFolder)return <Button onClick={async()=>{const f=await bridge.pickFolder!();if(f)onPick(f);}}><FolderOpen size={15}/>Choose folder…</Button>;
  // In a browser (not the desktop app) there is no folder dialog: the path is typed and checked by the gateway.
  return <form className="agent-folder-form" onSubmit={e=>{e.preventDefault();if(text.trim()){onPick(text.trim());setText('');}}}>
    <input aria-label="Working folder path" placeholder="C:\path\to\project" value={text} onChange={e=>setText(e.target.value)}/><Button type="submit">Use</Button>
  </form>;
}

function NewSession({folder,data,onCreated}:{folder:string;data:Models;onCreated:(id:string)=>void}){
  const usable=data.models.filter(m=>m.usable);const blocked=data.models.filter(m=>!m.usable);
  const [model,setModel]=useState(()=>stored('polygate-agent-model'));const current=usable.find(m=>m.id===model)||usable[0];
  const [mode,setMode]=useState<Mode>('ask');const [effort,setEffort]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const start=async()=>{
    if(!current)return;setBusy(true);setError('');
    try{const s=await api('/admin/agent/session/create',{folder,model:current.id,mode,effort:current.efforts.includes(effort)?effort:''});store('polygate-agent-model',current.id);onCreated(s.id);}
    catch(e:any){setError(e.message);}finally{setBusy(false);}
  };
  const small=current&&current.context>0&&current.context<32000;
  return <div className="agent-side-block"><h3>New session</h3>
    {usable.length?<>
      <Field label="Model" hint={current?(current.context?`${compact(current.context)} context${small?': small for longer tasks':''}`:'Context size unknown'):undefined}>
        <Select value={current?.id} onChange={setModel} aria-label="Model">{usable.map(m=><option key={m.id} value={m.id}>{`${m.name} · ${m.provider}`}</option>)}</Select>
      </Field>
      {current&&current.efforts.length>0&&<Field label="Effort"><Select value={effort} onChange={setEffort} aria-label="Reasoning effort"><option value="">Default</option>{current.efforts.map(x=><option key={x} value={x}>{cap(x)}</option>)}</Select></Field>}
      <Field label="Mode" hint={data.modes[mode]}><Select value={mode} onChange={v=>setMode(v as Mode)} aria-label="Mode">{MODES.filter(m=>m.id!=='full').map(m=><option key={m.id} value={m.id}>{m.label}</option>)}</Select></Field>
      <Button variant="primary" onClick={start} disabled={busy||!current}>{busy?<Loader2 className="spin" size={15}/>:<Plus size={15}/>}Start session</Button>
    </>:<p className="subtle">No model can run the agent yet: it needs one that can call tools, from a provider that is switched on.</p>}
    {blocked.length>0&&<p className="subtle agent-blocked" title={blocked[0].reason}>{blocked.length} OpenCode Free model{blocked.length>1?'s are':' is'} unavailable to the agent right now.</p>}
    {error&&<div className="pg-error">{error}</div>}
  </div>;
}

function SessionView({id,folder,models,onChanged}:{id:string;folder:string;models:AgentModel[];onChanged:()=>void}){
  const [info,setInfo]=useState<SessionInfo|null>(null);const [items,setItems]=useState<Item[]>([]);const [pending,setPending]=useState<Approval[]>([]);
  const [paused,setPaused]=useState('');const [busy,setBusy]=useState(false);const [usage,setUsage]=useState<SessionInfo['tokens']>();
  const [error,setError]=useState('');const [live,setLive]=useState<'connecting'|'live'|'lost'>('connecting');const [requests,setRequests]=useState<RouteUsage|null>(null);
  const [text,setText]=useState('');const [sending,setSending]=useState(false);
  const [fullUntil,setFullUntil]=useState(0);
  const thread=useRef<HTMLDivElement>(null);const changed=useRef(onChanged);changed.current=onChanged;
  const load=useCallback(async()=>{
    try{const [s,changes]=await Promise.all([api('/admin/agent/session?id='+encodeURIComponent(id)),api('/admin/agent/session/changes?id='+encodeURIComponent(id))]);setInfo(s.session);setFullUntil(s.fullUntil||0);setItems(withChanges(fromHistory(s.messages),changes.turns||[]));setRequests(s.usage||null);setPending(s.pending||[]);setPaused(s.paused||'');setBusy(!!s.busy);setUsage(s.session.tokens);setError('');}
    catch(e:any){setError(e.message);}
  },[id]);
  // History first, then the live stream. After a dropped connection the history is read again, so nothing missed meanwhile is lost.
  useEffect(()=>{
    let source:EventSource|undefined;let closed=false;let lost=false;
    const handle=(e:any)=>{
      const d=e.data||{};
      if(e.type==='agent.state'){setPending(d.pending||[]);setPaused(d.paused||'');setBusy(!!d.busy);return;}
      if(e.type==='permission.asked'){setPending(p=>p.some(x=>x.id===d.id)?p:[...p,{id:d.id,action:d.action,resources:d.resources||[],note:d.note||''}]);return;}
      if(e.type==='permission.replied'){setPending(p=>p.filter(x=>x.id!==d.requestID));return;}
      if(e.type==='agent.approval.auto')setPending(p=>p.filter(x=>x.id!==d.requestID));
      if(e.type==='agent.paused'){setPaused(d.message||'The model kept failing.');setBusy(false);return;}
      if(e.type==='agent.undone'){load();return;}
      if(e.type==='agent.mode'){setInfo(i=>i&&{...i,mode:d.mode});setFullUntil(d.fullUntil||0);}
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
  const send=async()=>{const t=text.trim();if(!t)return;setSending(true);setError('');setNotice('');try{await api('/admin/agent/session/prompt',{id,text:t});setText('');}catch(e:any){setError(e.message);}finally{setSending(false);}};
  const stop=async()=>{try{await api('/admin/agent/session/cancel',{id});}catch(e:any){setError(e.message);}};
  const changeMode=async(mode:Mode)=>{
    if(mode==='full'&&!await confirm(<>The agent will run commands and access files and the internet without ordinary approval prompts, with your account's access, including access to Polygate's data. This is not a sandbox. Full access ends after this turn, after 30 minutes, or when the app or engine restarts.</>,{title:'Enable Full access',confirm:'Enable Full access'}))return;
    try{const r=await api('/admin/agent/session/mode',{id,mode,confirmFull:mode==='full'});setInfo(i=>i&&{...i,mode});setFullUntil(r.fullUntil||0);}catch(e:any){setError(e.message);}
  };
  const {confirm,dialog}=useConfirm();const [notice,setNotice]=useState('');
  // Undo goes back to just before this turn's message: this turn and every later one are undone, and their messages leave the conversation.
  const undo=async(message:string)=>{
    const cards=items.filter((i):i is Extract<Item,{kind:'changes'}>=>i.kind==='changes');const from=cards.findIndex(c=>c.message===message);if(from<0)return;
    const files=[...new Set(cards.slice(from).flatMap(c=>c.files.map(f=>f.file)))];const later=cards.length-from-1;
    const ok=await confirm(<>Remove this turn's changes from {files.length===1?<code>{files[0]}</code>:`${files.length} files`}.{later>0?` This also undoes the ${later} later turn${later>1?'s':''} that changed files.`:''} The conversation from this message on is removed. Your non-overlapping edits are preserved. If any file cannot be safely merged, nothing is undone.</>,{title:'Undo this turn',confirm:'Undo'});
    if(!ok)return;setError('');setNotice('');
    try{const r=await api('/admin/agent/session/undo',{id,message});setNotice(`Undone: ${r.files.length} file${r.files.length===1?'':'s'} restored.${r.merged?' Your non-overlapping edits were preserved.':''}`);}catch(e:any){setError(e.message);}
  };
  const [nextModel,setNextModel]=useState('');const switchModel=async()=>{if(!nextModel)return;try{await api('/admin/agent/session/model',{id,model:nextModel});setInfo(i=>i&&{...i,model:nextModel,effort:''});setPaused('');setNotice('Model changed. Send a message to carry on.');}catch(e:any){setError(e.message);}};
  const [naming,setNaming]=useState<string|null>(null);const rename=async()=>{const title=(naming||'').trim();if(!title){setNaming(null);return;}try{await api('/admin/agent/session/rename',{id,title});setInfo(i=>i&&{...i,title});changed.current();}catch(e:any){setError(e.message);}setNaming(null);};
  const answer=async(p:Approval,decision:'once'|'session'|'project'|'deny')=>{
    if(decision==='project'&&!await confirm(<>Save this exact {p.action} request for this working folder? It will be allowed in future sessions without asking. It does not match broader command prefixes. Remove it under Project rules.</>,{title:'Save project rule',confirm:'Save and allow'}))return;
    setPending(list=>list.filter(x=>x.id!==p.id));
    try{await api('/admin/agent/session/approve',{id,request:p.id,decision});}catch(e:any){setError(e.message);load();}
  };
  const model=models.find(m=>m.id===info?.model);const tokens=usage?usage.input+usage.output+(usage.reasoning||0):0;
  return <section className="section-block agent-session">
    <header className="agent-session-head">
      <div className="agent-title">{naming!==null?<input className="agent-rename" aria-label="Session name" autoFocus value={naming} maxLength={120} onChange={e=>setNaming(e.target.value)} onBlur={rename} onKeyDown={e=>{if(e.key==='Enter')rename();if(e.key==='Escape')setNaming(null);}}/>
        :<h2 className="truncate" title={info?.title}>{info?.title||'Session'}<button className="icon-button agent-rename-button" aria-label="Rename session" title="Rename" onClick={()=>setNaming(info?.title||'')}><Pencil size={13}/></button></h2>}
        <span className="subtle truncate">{model?`${model.name} · ${model.provider}`:info?.model}{info?.effort?` · ${cap(info.effort)} effort`:''}</span></div>
      <span className="toolbar-spacer"/>
      {tokens>0&&<span className="pg-stat" title="Tokens this session has used, as the engine counts them">{compact(tokens)} tokens</span>}
      {requests&&requests.requests>0&&<span className={`pg-stat${requests.errors?' warn':''}`} title={`Model requests this session made through Polygate, by route:\n${requests.routes.map(r=>`${r.route||'—'}: ${r.requests}`).join('\n')}`}>
        {requests.requests} request{requests.requests===1?'':'s'}{requests.errors?`, ${requests.errors} failed`:''}{requests.routes[0]?` · ${requests.routes[0].route}`:''}</span>}
      <Select value={info?.mode||'ask'} onChange={v=>changeMode(v as Mode)} disabled={busy||pending.length>0} aria-label="Mode" className="agent-mode">{MODES.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}</Select>
      <span className={`agent-live ${live}`}>{live==='live'?'Live':live==='lost'?'Reconnecting…':'Connecting…'}</span>
    </header>
    {info?.mode==='full'&&<div className="agent-paused" role="status"><TriangleAlert size={17}/><div><strong>Full access.</strong> Commands run with your account's access without asking. Ends after this turn or at {new Date(fullUntil).toLocaleTimeString()}. No sandbox.</div></div>}
    <ProjectRules id={id} mode={info?.mode||'ask'}/>
    <div className="agent-thread" ref={thread} aria-live="polite">
      {items.length?items.map(i=><Row key={i.key} item={i} folder={folder} busy={busy} onUndo={undo}/>):<p className="subtle agent-hint">Tell the agent what to do in this folder. {info?.mode==='plan'?'In Plan mode it reads and plans; it does not change files or run commands.':info?.mode==='accept-edits'?'It changes files without asking and asks before running commands.':'It reads freely and asks before changing files or running commands.'}</p>}
      {busy&&!pending.length&&<div className="agent-working"><Loader2 className="spin" size={15}/>Working…</div>}
    </div>
    {pending.map(p=><ApprovalCard key={p.id} request={p} answer={answer}/>)}
    {paused&&<div className="agent-paused" role="status"><TriangleAlert size={17}/><div className="agent-paused-body"><div><strong>Paused.</strong> {paused} Send a message to try again, or carry on with another model.</div>
      {models.some(m=>m.usable&&m.id!==info?.model)&&<div className="agent-paused-switch"><Select value={nextModel} onChange={setNextModel} aria-label="Another model"><option value="">Choose another model…</option>{models.filter(m=>m.usable&&m.id!==info?.model).map(m=><option key={m.id} value={m.id}>{`${m.name} · ${m.provider}`}</option>)}</Select><Button onClick={switchModel} disabled={!nextModel}>Use this model</Button></div>}</div></div>}
    {notice&&!error&&<div className="agent-notice" role="status">{notice}</div>}
    {error&&<div className="pg-error agent-error">{error}</div>}
    <div className="agent-composer">
      <textarea aria-label="Message to the agent" placeholder={busy?'The agent is working. A message now is queued for when it is done.':'Ask the agent to do something in this folder…'} value={text} rows={3}
        onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();send();}}}/>
      <div className="agent-composer-actions">
        {busy&&<Button onClick={stop}><Square size={14}/>Stop</Button>}
        <Button variant="primary" onClick={send} disabled={sending||!text.trim()}>{sending?<Loader2 className="spin" size={15}/>:<Send size={15}/>}{busy?'Queue':'Send'}</Button>
      </div>
    </div>
    {dialog}
  </section>;
}

function Row({item,folder,busy,onUndo}:{item:Item;folder:string;busy:boolean;onUndo:(message:string)=>void}){
  if(item.kind==='changes')return <ChangesCard files={item.files} busy={busy} undo={()=>onUndo(item.message)}/>;
  if(item.kind==='user')return <div className="pg-msg user"><pre>{item.text}</pre></div>;
  if(item.kind==='text')return item.text?<div className="pg-msg assistant"><pre>{item.text}</pre></div>:null;
  if(item.kind==='reasoning')return <details className="pg-think"><summary><Brain size={14}/>{item.done?'Reasoning':'Thinking…'}</summary><pre>{item.text}</pre></details>;
  if(item.kind==='note')return <div className={`agent-note ${item.tone}`}>{item.text}</div>;
  const subject=toolSubject(item.name,item.input,folder);
  const icon=item.status==='done'?<Check size={14} className="green"/>:item.status==='failed'?<X size={14} className="red"/>:<Loader2 size={14} className="spin"/>;
  return <details className={`agent-tool ${item.status}`}><summary>{icon}<strong>{item.name}</strong>{subject&&<code className="truncate" title={subject}>{subject}</code>}</summary>
    {item.error&&<p className="agent-error-text">{item.error}</p>}
    {item.output?<pre>{item.output.length>6000?item.output.slice(0,6000)+'\n…':item.output}</pre>:!item.error&&<p className="subtle">{item.status==='done'?'No output.':'Waiting for the result…'}</p>}
  </details>;
}

const STATUS:Record<string,string>={added:'Added',deleted:'Deleted',modified:'Changed',renamed:'Renamed'};
// What one turn changed, file by file, with the patch the engine recorded (a file a command changed may have none).
function ChangesCard({files,busy,undo}:{files:Extract<Item,{kind:'changes'}>['files'];busy:boolean;undo:()=>void}){
  const add=files.reduce((s,f)=>s+f.additions,0),del=files.reduce((s,f)=>s+f.deletions,0);
  return <div className="agent-changes">
    <div className="agent-changes-head"><FileDiff size={15}/><strong>{files.length} file{files.length===1?'':'s'} changed</strong>{add>0&&<span className="green">+{add}</span>}{del>0&&<span className="red">−{del}</span>}<span className="toolbar-spacer"/>
      <button className="text-button" disabled={busy} onClick={undo}><Undo2 size={14}/>Undo this turn</button></div>
    {files.map(f=><details key={f.file} className="agent-change"><summary><span className={`agent-change-status ${f.status}`}>{STATUS[f.status]||f.status}</span><code className="truncate" title={f.file}>{f.file}</code>{f.additions>0&&<small className="green">+{f.additions}</small>}{f.deletions>0&&<small className="red">−{f.deletions}</small>}</summary>
      {f.patch?<Diff patch={f.patch}/>:<p className="subtle">No patch was recorded for this file (it was changed by a command).</p>}</details>)}
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
function ProjectRules({id,mode}:{id:string;mode:Mode|''}){
  const [open,setOpen]=useState(false);const [data,setData]=useState<{rules:SavedRule[];inspections:string[]}|null>(null);const [error,setError]=useState('');
  const load=async()=>{try{setData(await api('/admin/agent/rules?id='+encodeURIComponent(id)));setError('');}catch(e:any){setError(e.message);}};
  const remove=async(rule:string)=>{try{await api('/admin/agent/rules/remove',{id,rule});await load();}catch(e:any){setError(e.message);}};
  return <details className="agent-project-rules" open={open} onToggle={e=>{const next=e.currentTarget.open;setOpen(next);if(next)void load();}}><summary>Project rules{mode==='rules'?' and automatic inspections':''}</summary>
    <p className="subtle">Saved by Polygate for this working folder. Only the exact action and targets match; Plan still blocks commands and edits. Full access bypasses these rules for its current turn.</p>
    {error&&<p className="pg-error">{error}</p>}
    {data?.rules.length?<ul>{data.rules.map(r=><li key={r.id}><div><strong>{r.effect==='allow'?'Allow':'Deny'} {r.action}</strong>{r.resources.map((x,i)=><code key={i} className="agent-approval-target">{x}</code>)}</div><Button onClick={()=>remove(r.id)} aria-label={`Remove ${r.action} rule`}>Remove</Button></li>)}</ul>:<p className="subtle">No saved rules. Save one from an approval card.</p>}
    {mode==='rules'&&data&&<><p className="subtle">Only these exact hardened inspections are automatically approved. Ordinary git commands, scripts and unrecognized arguments still ask.</p>{data.inspections.map(x=><code className="agent-approval-target" key={x}>{x}</code>)}</>}
  </details>;
}
