import {useState} from 'react';
import {Bot,ChevronRight,Loader2,RefreshCw} from 'lucide-react';
import {usePoll,Button} from './ui';
import {fromHistory,blocks,stepsSummary,type Item} from './agent-logic';
import {Markdown} from './markdown';
import {api} from './api';
import {AgentForms} from './agent-forms';

type Child={id:string;title:string;model:string;outcome?:string;busy:boolean;pending:number};
export function AgentChildren({id,depth=0}:{id:string;depth?:number}){
  const {data,error,reload}=usePoll<{children:Child[];more:boolean}>('/admin/agent/session/children?id='+encodeURIComponent(id),3000);
  return <section className="ag-children"><p className="subtle">Delegated work linked to this session. Viewing does not start, resume or interrupt an agent. Each child keeps its own permission checks; pending requests can be allowed once or denied below.</p>
    <Button onClick={reload}><RefreshCw size={13}/>Refresh</Button>
    {error&&<p className="pg-error" role="alert">{error}</p>}{!data&&!error&&<p className="subtle">Loading subagents…</p>}
    {data&&!data.children.length&&<p className="ag-workspace-empty">No delegated sessions yet. A child appears when the Agent uses its subagent tool.</p>}
    {data?.children.map(c=><ChildRow key={c.id} child={c} parent={id} depth={depth}/>)}{data?.more&&<p className="subtle">Showing the first 100 child sessions.</p>}
  </section>;
}
function ChildRow({child,parent,depth}:{child:Child;parent:string;depth:number}){
  const [open,setOpen]=useState(false);
  return <section className="ag-child"><button type="button" className="ag-child-toggle" aria-expanded={open} onClick={()=>setOpen(o=>!o)}><ChevronRight size={14} className={open?'open':''}/>{child.busy?<Loader2 size={14} className="spin"/>:<Bot size={14}/>}<span>{child.title||'Subagent'}<small>{child.pending?'Approval needed':child.busy?'Working':child.outcome==='succeeded'?'Completed':child.outcome==='failed'?'Failed':child.outcome==='interrupted'?'Stopped':'Idle'}</small></span></button>
    {open&&<ChildDetail child={child} parent={parent} depth={depth}/>}
  </section>;
}
function ChildDetail({child,parent,depth}:{child:Child;parent:string;depth:number}){
  const {data,error,reload}=usePoll<{messages:any[];pending:any[];busy:boolean}>('/admin/agent/session/children?id='+encodeURIComponent(parent)+'&child='+encodeURIComponent(child.id),2000);
  const [approvalError,setApprovalError]=useState(''),[answering,setAnswering]=useState(false);
  const answer=async(request:string,decision:'once'|'deny')=>{setAnswering(true);setApprovalError('');try{await api('/admin/agent/session/approve',{id:child.id,request,decision});reload();}catch(e:any){setApprovalError(e.message);}finally{setAnswering(false);}};
  const items:Item[]=fromHistory(data?.messages||[]);
  const last=[...items].reverse().find(i=>i.kind==='text');
  const tools=items.filter((i):i is Extract<Item,{kind:'tool'}>=>i.kind==='tool');
  return <div className="ag-child-detail"><p className="subtle">{child.model||'Inherited model'}</p>{error&&<p className="pg-error">{error}</p>}
    <AgentForms id={child.id}/>
    {data?.pending.map(p=><section className="agent-approval" key={p.id}><strong>Child approval: {p.action}</strong>{p.resources.map((r:string)=><pre key={r}>{r}</pre>)}{p.input!==undefined&&<pre>{JSON.stringify(p.input,null,2)}</pre>}<p>{p.note||'This action runs with the child session’s working-folder access.'}</p><div className="button-row"><Button disabled={answering} onClick={()=>answer(p.id,'once')}>Allow once</Button><Button disabled={answering} onClick={()=>answer(p.id,'deny')}>Deny</Button></div></section>)}{approvalError&&<p className="pg-error" role="alert">{approvalError}</p>}
    <details><summary>Task and tool activity ({tools.length})</summary>{blocks(items).map((b,i)=>b.kind==='user'?<pre dir="auto" key={i}>{b.text}</pre>:b.kind==='steps'?<details key={i}><summary>{stepsSummary(b.tools)}</summary>{b.tools.map(t=><details key={t.key}><summary>{t.name} · {t.status}</summary><pre>{JSON.stringify(t.input,null,2)}</pre>{t.output&&<pre>{t.output}</pre>}{t.error&&<p className="red">{t.error}</p>}</details>)}</details>:null)}</details>
    {last?.kind==='text'?<div className="ag-child-result"><h4>{data?.busy?'Latest response':'Result'}</h4><Markdown text={last.text}/></div>:<p className="subtle">No response recorded yet.</p>}
    {depth<3&&<details><summary>Nested subagents</summary><AgentChildren id={child.id} depth={depth+1}/></details>}
  </div>;
}
