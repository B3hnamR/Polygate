import {useEffect,useRef,useState} from 'react';
import {Bot,CheckCircle2,Circle,Copy,FileText,GitBranch,ListChecks,Loader2,Play,RefreshCw,Square,Terminal,Undo2,X} from 'lucide-react';
import {api} from './api';
import {AgentDiff} from './agent-diff';
import {useConfirm} from './confirm';
import {Button,usePoll,when} from './ui';
import type {Item,Todo} from './agent-logic';
import {AgentProject} from './agent-project';
import {AgentChildren} from './agent-children';

type Turn=Extract<Item,{kind:'changes'}>;
type GitFile={file:string;from?:string;index:string;worktree:string};
type GitState={repository:boolean;branch?:string;files?:GitFile[];commits?:{hash:string;subject:string}[];at?:number};
type GitPatch={repository:boolean;file?:string;staged?:string;worktree?:string;truncated?:boolean};
export function AgentWorkspace({id,turns,todos=[],initialTab='changes',busy,blocked,onUndo,onClose,onInsert}:{id:string;turns:Turn[];todos?:Todo[];initialTab?:'changes'|'plan';busy:boolean;blocked:Map<string,string>;onUndo:(message:string)=>void;onClose:()=>void;onInsert:(text:string)=>void}){
  const [tab,setTab]=useState<'changes'|'git'|'terminal'|'plan'|'project'|'children'>(initialTab),[git,setGit]=useState<GitState|null>(null),[patch,setPatch]=useState<GitPatch|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  useEffect(()=>setTab(initialTab),[initialTab]);
  const consent=useRef(false),serial=useRef(0);const {confirm,dialog}=useConfirm();
  useEffect(()=>()=>{serial.current++;},[]);
  const inspect=async(file?:string)=>{
    if(!consent.current){if(!await confirm('Inspect this working folder with Git? Status and diff can run repository-configured clean filters with your account access. External diff, text conversion, hooks and file-monitor helpers are disabled. This view does not stage, commit, reset or change files.',{title:'Inspect Git working tree',confirm:'Inspect Git',icon:<GitBranch size={18}/>}))return;consent.current=true;}
    const seq=++serial.current;setLoading(true);setError('');
    try{const result=await api('/admin/agent/session/git',{id,confirm:true,...(file!==undefined?{file}:{})});if(seq!==serial.current)return;if(file!==undefined)setPatch(result);else{setGit(result);setPatch(null);}}
    catch(e:any){if(seq===serial.current)setError(e.message);}finally{if(seq===serial.current)setLoading(false);}
  };
  const count=new Set(turns.flatMap(t=>t.files.map(f=>f.file))).size;
  return <aside className="ag-workspace" id="agent-workspace" aria-label="Task changes and Git">
    <header><strong>Task workspace</strong><button type="button" className="icon-button" aria-label="Close task workspace" onClick={onClose}><X size={16}/></button></header>
    <div className="ag-workspace-tabs" role="group" aria-label="Workspace view"><button type="button" aria-pressed={tab==='changes'} onClick={()=>setTab('changes')}>Agent changes{count?` (${count})`:''}</button><button type="button" aria-pressed={tab==='plan'} onClick={()=>setTab('plan')}><ListChecks size={13}/>Plan</button><button type="button" aria-pressed={tab==='git'} onClick={()=>setTab('git')}><GitBranch size={13}/>Git</button><button type="button" aria-pressed={tab==='terminal'} onClick={()=>setTab('terminal')}><Terminal size={13}/>Terminal</button><button type="button" aria-label="Project instructions, commands & skills" aria-pressed={tab==='project'} onClick={()=>setTab('project')}><FileText size={13}/>Project</button></div>
    <div className="ag-workspace-tabs ag-workspace-subtabs"><button type="button" aria-pressed={tab==='children'} onClick={()=>setTab('children')}><Bot size={13}/>Subagents</button></div>
    <div className="ag-workspace-content">
      {tab==='changes'?<>
        <p className="subtle">Recorded changes for this session, newest turn first. Patches show what was recorded at the end of a turn, not the current file contents.</p>
        <p className="subtle">Shell-made changes in non-Git folders may not be recorded. Undo needs folder backups enabled before the turn.</p>
        {!turns.length&&<p className="ag-workspace-empty">No file changes recorded yet.</p>}
        {[...turns].reverse().map(t=><section className="ag-workspace-turn" key={t.message}>
          <div className="ag-workspace-turn-head"><strong>{t.files.length} file{t.files.length===1?'':'s'}</strong><span className="subtle">Turn {turns.indexOf(t)+1}</span></div>
          {t.files.map(f=><details className="agent-change" key={f.file}><summary><span className="agent-change-status">{f.status}</span><code title={f.file}>{f.file}</code><small className="green">+{f.additions}</small><small className="red">−{f.deletions}</small></summary>{f.patch?<AgentDiff patch={f.patch}/>:<p className="subtle">No patch was recorded. Without a backup or engine diff, only the file name is available.</p>}</details>)}
          {blocked.get(t.message)?<p className="ag-workspace-undo-reason">{blocked.get(t.message)}</p>:<Button disabled={busy} onClick={()=>onUndo(t.message)}><Undo2 size={13}/>Undo this turn and later changes</Button>}
        </section>)}
      </>:tab==='children'?<AgentChildren id={id}/>:tab==='project'?<AgentProject id={id} busy={busy} onInsert={onInsert}/>:tab==='plan'?<AgentPlan todos={todos} busy={busy}/>:tab==='terminal'?<AgentTerminal id={id} busy={busy}/>:<>
        <p className="subtle">The working folder’s Git state, including your changes and changes from other sessions. This is not limited to Agent edits.</p>
        <Button disabled={loading} onClick={()=>inspect()}>{loading?<Loader2 size={14} className="spin"/>:<RefreshCw size={14}/>} {git?'Refresh Git':'Inspect Git'}</Button>
        {git&&!git.repository&&<p className="ag-workspace-empty">This folder is not in a Git repository. No repository was created.</p>}
        {git?.repository&&<>
          <p className="ag-git-branch"><GitBranch size={14}/>{git.branch||'Git repository'}</p>
          <p className="subtle">Snapshot from {when(git.at||0)}. Refresh after changes; no commands run automatically.</p>
          {!git.files?.length&&<p className="ag-workspace-empty">Working folder is clean.</p>}
          <ul className="ag-git-files" aria-label="Git changed files">{git.files?.map(f=><li key={f.file}><button type="button" disabled={loading} onClick={()=>{setPatch(null);inspect(f.file);}} title={`${f.from?f.from+' → ':''}${f.file}`}><code className="ag-git-status" title="Index / working tree">{f.index}{f.worktree}</code><span>{f.file}</span></button></li>)}</ul>
          {patch&&<section className="ag-git-patch"><h4>{patch.file}</h4>{patch.staged&&<><h5>Staged</h5><AgentDiff patch={patch.staged}/></>}{patch.worktree&&<><h5>Working Tree</h5><AgentDiff patch={patch.worktree}/></>}{!patch.staged&&!patch.worktree&&<p className="subtle">No tracked diff. Untracked files are listed but their contents are not opened here.</p>}{patch.truncated&&<p className="amber">Large patch truncated to 200,000 characters per section.</p>}</section>}
          {!!git.commits?.length&&<details className="ag-git-history"><summary>Recent commits</summary><ol>{git.commits.map(c=><li key={c.hash}><code>{c.hash}</code><span>{c.subject}</span></li>)}</ol></details>}
        </>}
        {error&&<p className="pg-error" role="alert">{error}</p>}
      </>}
    </div>{dialog}
  </aside>;
}

type TerminalState={command:string;output:string;running:boolean;started:number;ended?:number;exitCode?:number|null;truncated:boolean};
function AgentPlan({todos,busy}:{todos:Todo[];busy:boolean}){
  const done=todos.filter(t=>t.status==='completed').length,cancelled=todos.filter(t=>t.status==='cancelled').length,total=todos.length-cancelled;
  return <section className="ag-plan" aria-label="Session plan">
    <h3>Working plan</h3><p className="subtle">The Agent’s latest task list or explicit Markdown checklist, restored from this conversation. Status is reported by the Agent, not independently verified. This does not change permission modes or approve work.</p>
    {!todos.length?<p className="ag-workspace-empty">No task list recorded yet. Ask the Agent to make a checklist for a multi-step request.</p>:<>
      <p className="ag-plan-count" role="status">{done} of {total} steps completed{cancelled?` · ${cancelled} cancelled`:''}</p>
      <progress max={total||1} value={done} aria-label="Plan completion"/>
      <ol className="ag-plan-steps">{todos.map((t,i)=><li key={i} className={t.status}>{t.status==='completed'?<CheckCircle2 size={17}/>:t.status==='in_progress'&&busy?<Loader2 size={17} className="spin"/>:t.status==='cancelled'?<X size={17}/>:<Circle size={17}/>}<div><span dir="auto">{t.content}</span><small>{t.status==='completed'?'Completed':t.status==='cancelled'?'Cancelled':t.status==='in_progress'?(busy?'In progress':'Last marked in progress'):'Pending'}</small></div></li>)}</ol>
    </>}
  </section>;
}
function AgentTerminal({id,busy}:{id:string;busy:boolean}){
  const {data,error:pollError,reload}=usePoll<{terminal:TerminalState|null}>('/admin/agent/session/terminal?id='+encodeURIComponent(id),1000);
  const [command,setCommand]=useState(''),[error,setError]=useState(''),[acting,setActing]=useState(false),[copied,setCopied]=useState(false);const {confirm,dialog}=useConfirm();const terminal=data?.terminal;
  const act=async(action:string)=>{setActing(true);setError('');try{await api('/admin/agent/session/terminal/'+action,{id,...(action==='run'?{command,confirm:true}:{})});reload();}catch(e:any){setError(e.message);}finally{setActing(false);}};
  const run=async()=>{if(!command.trim()||!await confirm(<>Run this command in this session’s working folder?<pre className="agent-approval-target">{command}</pre>It runs with your account access, independently of the Agent mode, and can modify files or access the network. No sandbox. Terminal changes are not recorded as Agent turns and cannot be undone with Agent Undo.</>,{title:'Run terminal command',confirm:'Run command',icon:<Terminal size={18}/>}))return;await act('run');};
  const copy=async()=>{try{await navigator.clipboard.writeText(terminal?.output||'');setCopied(true);setTimeout(()=>setCopied(false),2000);}catch{setError('Clipboard unavailable. Select and copy the output.');}};
  return <section className="ag-terminal"><p className="subtle">Command output, not an interactive TTY. No password prompts or full-screen apps. Closing this panel does not stop a running command. App exit, engine Stop, and folder trust revocation stop it.</p>
    <label>Command<textarea dir="ltr" aria-label="Terminal command" value={command} maxLength={20000} rows={3} onChange={e=>setCommand(e.target.value)} placeholder="Get-Location" disabled={acting}/></label>
    <div className="button-row"><Button variant="primary" disabled={acting||busy||!data||!!terminal?.running||!command.trim()} onClick={run}><Play size={13}/>Run</Button><Button disabled={acting||!terminal?.running} onClick={()=>act('stop')}><Square size={13}/>Stop</Button><Button disabled={acting||!terminal||terminal.running} onClick={()=>act('clear')}>Clear</Button><Button disabled={!terminal?.output} onClick={copy}><Copy size={13}/>{copied?'Copied':'Copy output'}</Button></div>
    {busy&&<p className="subtle">Wait for the Agent to finish, or stop it before running a terminal command.</p>}
    {terminal&&<><p className="ag-terminal-state" role="status">{terminal.running?<><Loader2 size={13} className="spin"/>Running</>:<>Exited {terminal.exitCode??'without a code'}</>}</p><code className="ag-terminal-command">{terminal.command}</code><pre className="ag-terminal-output" dir="ltr" aria-label="Terminal output">{terminal.output||'Waiting for output…'}</pre>{terminal.truncated&&<p className="amber">Showing the last 200,000 characters.</p>}</>}
    {(error||pollError)&&<p className="pg-error" role="alert">{error||pollError}</p>}{dialog}
  </section>;
}
