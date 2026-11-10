import {useEffect,useMemo,useState} from 'react';
import {AlertCircle,Check,ChevronDown,Copy,Loader2,Plus,RefreshCw,Search,Trash2,Upload,X} from 'lucide-react';
import {api} from './api';
import {useConfirm} from './confirm';
import {Button} from './ui';
// The Z.ai (ZCode) accounts, in the provider's row on the Providers page (backend/zai.ts): import a copied account, choose the one in use, see
// its plan and quota, copy it for sharing, refresh, switch off or remove. A minimal version of AutoZCoder's Accounts tab.
// One short row per account (in use first) so a long list stays readable; the full quota, dates and the less common actions open per account.

type Quota={remaining:number;total:number;used:number;resetsAt:number};
export type ZaiAccountView={id:string;email:string;name:string;enabled:boolean;addedAt:number;checkedAt:number;expiresAt:number;plans:{name:string;status:string;endsAt:number}[];quotas:Record<string,Quota>;problem:string;exhausted:Record<string,number>;blocked:Record<string,{at:number;message:string}>;active:boolean};
type List={active:string;accounts:ZaiAccountView[]};
const units=(n:number)=>n>=1e9?(n/1e9).toFixed(1).replace(/\.0$/,'')+'B':n>=1e6?(n/1e6).toFixed(1).replace(/\.0$/,'')+'M':n>=1e3?(n/1e3).toFixed(1).replace(/\.0$/,'')+'K':String(Math.round(n));
const when=(ms:number)=>{const d=new Date(ms);return d.toDateString()===new Date().toDateString()?d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):d.toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});};
export const accountLabel=(a:ZaiAccountView)=>a.name||a.email||a.id.slice(0,8);
const MODELS=['GLM-5.3','GLM-5.3-Flash'];
const SHOWN=6;
// "GLM-5.3" → "5.3", "GLM-5.3-Flash" → "Flash": enough to tell them apart in a row.
const shortModel=(m:string)=>m.replace(/^GLM-[\d.]+-/,'').replace(/^GLM-/,'');
const shortPlan=(name:string)=>name.replace(/^ZCode\s+/i,'');
const activePlan=(a:ZaiAccountView)=>a.plans.find(p=>p.status==='active');
// One line per model: what is left, or why it cannot be used now.
export function quotaLine(a:ZaiAccountView,model:string,q?:Quota){
  if(a.blocked[model])return `${model}: blocked by Z.ai`;
  if(a.exhausted[model])return `${model}: no quota until ${when(a.exhausted[model])}`;
  if(!q)return `${model}: not in this plan`;
  return `${model}: ${units(q.remaining)} of ${units(q.total)} left${q.resetsAt?` · resets ${when(q.resetsAt)}`:''}`;
}
// The row's status: the one thing that stops it being used, if any.
function status(a:ZaiAccountView){
  if(a.problem)return {text:'Problem',tone:'amber'};
  if(!a.enabled)return {text:'Off',tone:'muted'};
  if(Object.keys(a.blocked).length)return {text:'Blocked',tone:'amber'};
  return null;
}
function Meter({a,model}:{a:ZaiAccountView;model:string}){
  const q=a.quotas[model],label=shortModel(model),title=quotaLine(a,model,q);
  if(a.blocked[model])return <span className="zai-meter amber" title={title}><b>{label}</b><span>blocked</span></span>;
  if(a.exhausted[model])return <span className="zai-meter amber" title={title}><b>{label}</b><span>empty</span></span>;
  if(!q)return <span className="zai-meter none" title={title}><b>{label}</b><span>-</span></span>;
  const left=q.total>0?Math.max(0,Math.min(1,q.remaining/q.total)):0;
  return <span className={'zai-meter'+(left<.15?' amber':'')} title={title}><b>{label}</b><i aria-hidden><i style={{width:`${Math.round(left*100)}%`}}/></i><span className="zai-num">{units(q.remaining)}</span></span>;
}

export function ZaiAccounts({enabled,onImported}:{enabled:boolean;onImported:()=>void}){
  const [list,setList]=useState<List|null>(null),[text,setText]=useState(''),[busy,setBusy]=useState(''),[error,setError]=useState(''),[note,setNote]=useState('');
  const [open,setOpen]=useState(''),[adding,setAdding]=useState(false),[query,setQuery]=useState(''),[all,setAll]=useState(false);
  const {confirm,dialog}=useConfirm();
  const run=async(name:string,f:()=>Promise<any>,done='')=>{setBusy(name);setError('');setNote('');try{const r=await f();if(r?.accounts)setList(r);if(done)setNote(done);return r;}catch(e:any){setError(e.message);}finally{setBusy('');}};
  useEffect(()=>{void run('load',()=>api('/admin/zai'));},[]);
  const doImport=async()=>{const r=await run('import',()=>api('/admin/zai/import',{text}));if(r){setText('');setAdding(false);setNote(r.updated?'Account updated with the pasted copy.':'Account checked with Z.ai and added.');onImported();}};
  const share=async(a:ZaiAccountView)=>{
    if(!await confirm(<>Copy <strong>{accountLabel(a)}</strong> for sharing? The copy holds the account's current token: anyone who has it can use this account's quota until the token stops working. Share it only with people you trust. It does not add quota, and it cannot renew the token.</>,{title:'Copy account for sharing',confirm:'Copy to clipboard',icon:<Copy size={18}/>}))return;
    await run('share:'+a.id,async()=>{const bundle=await api('/admin/zai/export',{id:a.id});await navigator.clipboard.writeText(JSON.stringify(bundle));},`Copied ${accountLabel(a)}. It imports into AutoZCoder or another Polygate.`);
  };
  const remove=async(a:ZaiAccountView)=>{if(await confirm(<>Remove <strong>{accountLabel(a)}</strong> from Polygate? Its token is deleted from this computer. Copy it for sharing first if you want to import it again later.</>,{title:'Remove Z.ai account',confirm:'Remove'}))await run('remove:'+a.id,()=>api('/admin/zai/remove',{id:a.id}),'Account removed.');};
  const update=(a:ZaiAccountView,change:Record<string,unknown>,done='')=>run('update:'+a.id,()=>api('/admin/zai/account',{id:a.id,...change}),done);
  const accounts=list?.accounts||[];
  // In use first, then the ones switched on; otherwise the order they were added.
  const sorted=useMemo(()=>accounts.map((a,i)=>({a,i})).sort((x,y)=>(+y.a.active-+x.a.active)||(+y.a.enabled-+x.a.enabled)||x.i-y.i).map(x=>x.a),[accounts]);
  const q=query.trim().toLowerCase();
  const matches=q?sorted.filter(a=>[a.name,a.email,activePlan(a)?.name||''].some(s=>s.toLowerCase().includes(q))):sorted;
  const shown=all||q?matches:matches.slice(0,SHOWN);
  const showImport=adding||(!!list&&!accounts.length);
  return <div className="zai-accounts">
    {!enabled&&accounts.length>0&&<p className="subtle">Switch Z.ai on to use these accounts.</p>}
    {!list&&!error&&<p className="subtle"><Loader2 size={13} className="spin"/> Loading accounts…</p>}
    {list&&!accounts.length&&<p className="subtle">No accounts yet. Paste one below: AutoZCoder's “Copy account for sharing” text, or a ZCode JWT token.</p>}
    {accounts.length>0&&<div className="zai-toolbar">
      <span className="zai-count">Accounts <b>{accounts.length}</b></span>
      {accounts.length>SHOWN&&<label className="zai-search"><Search size={13} aria-hidden/><input type="search" aria-label="Find an account" placeholder="Find by name, email or plan" value={query} onChange={e=>setQuery(e.target.value)}/></label>}
      {!adding&&<button type="button" className="text-button zai-add" onClick={()=>setAdding(true)}><Plus size={14}/>Add account</button>}
    </div>}
    {accounts.length>0&&<ul className="zai-account-list" aria-label="Z.ai accounts">{shown.map(a=>{
      const plan=activePlan(a),st=status(a),isOpen=open===a.id,label=accountLabel(a);
      const models=[...new Set([...MODELS,...Object.keys(a.quotas)])];
      return <li key={a.id} className={[a.active&&'active',!a.enabled&&'off',isOpen&&'open'].filter(Boolean).join(' ')||undefined}>
        <div className="zai-row">
          <label className="zai-account-pick" title={a.enabled?'Use this account':'Switch it on first'}><input type="radio" name="zai-active" checked={a.active} disabled={!a.enabled||!!busy} onChange={()=>update(a,{active:true},`${label} is now in use.`)}/><span className="sr-only">Use {label}</span></label>
          <button type="button" className="zai-row-main" aria-expanded={isOpen} aria-label={`Details of ${label}`} onClick={()=>setOpen(isOpen?'':a.id)}>
            <span className="zai-row-name"><strong dir="auto">{label}</strong>{a.active&&<span className="inline-label">In use</span>}{st&&<span className={'inline-label '+st.tone}>{st.text}</span>}</span>
            <small className="zai-row-plan">{plan?shortPlan(plan.name||'Plan'):'No active plan'}</small>
            <span className="zai-meters">{models.map(m=><Meter key={m} a={a} model={m}/>)}</span>
          </button>
          <button type="button" className="icon-button" aria-label={`Refresh quota of ${label}`} title="Refresh quota" disabled={!!busy} onClick={()=>run('refresh:'+a.id,()=>api('/admin/zai/refresh',{id:a.id}),'Quota refreshed.')}>{busy==='refresh:'+a.id?<Loader2 size={15} className="spin"/>:<RefreshCw size={15}/>}</button>
          <button type="button" className="icon-button zai-chevron" aria-hidden tabIndex={-1} onClick={()=>setOpen(isOpen?'':a.id)}><ChevronDown size={15}/></button>
        </div>
        {isOpen&&<div className="zai-details">
          <small className="muted">{[a.email&&a.name?a.email:'',plan?`${plan.name||'Plan'}${plan.endsAt?` · ends ${when(plan.endsAt)}`:''}`:'No active plan reported',a.checkedAt?`checked ${when(a.checkedAt)}`:'',a.expiresAt?`token expires ${when(a.expiresAt)}`:''].filter(Boolean).join(' · ')}</small>
          <ul className="zai-quota">{models.map(m=><li key={m} className={a.blocked[m]||a.exhausted[m]?'amber':undefined}>{quotaLine(a,m,a.quotas[m])}{a.blocked[m]&&<button type="button" className="text-button" disabled={!!busy} onClick={()=>update(a,{clearBlock:m},`Block on ${m} cleared.`)}>Clear block</button>}</li>)}</ul>
          {a.problem&&<p className="zai-problem"><AlertCircle size={14}/>{a.problem} Import a fresh copy of this account.</p>}
          <div className="zai-detail-actions">
            <label className="zai-switch"><input type="checkbox" role="switch" checked={a.enabled} disabled={!!busy} aria-label={`${label} switched on`} onChange={e=>update(a,{enabled:e.target.checked})}/>{a.enabled?'On':'Off'}</label>
            <button type="button" className="text-button" aria-label={`Copy ${label} for sharing`} disabled={!!busy} onClick={()=>share(a)}><Copy size={14}/>Copy for sharing</button>
            <button type="button" className="text-button danger" aria-label={`Remove ${label}`} disabled={!!busy} onClick={()=>remove(a)}><Trash2 size={14}/>Remove</button>
          </div>
        </div>}
      </li>;})}</ul>}
    {q&&!matches.length&&<p className="subtle">No account matches “{query}”.</p>}
    {!q&&!all&&matches.length>SHOWN&&<button type="button" className="text-button zai-more" onClick={()=>setAll(true)}>Show {matches.length-SHOWN} more</button>}
    {!q&&all&&matches.length>SHOWN&&<button type="button" className="text-button zai-more" onClick={()=>setAll(false)}>Show fewer</button>}
    {accounts.length>0&&!accounts.some(a=>a.active)&&<p className="zai-problem"><AlertCircle size={14}/>No account is in use. Choose one with the circle on its left.</p>}
    {showImport&&<div className="zai-import-panel">
      <div className="zai-import">
        <textarea aria-label="Z.ai account to import" rows={3} spellCheck={false} autoComplete="off" value={text} onChange={e=>setText(e.target.value)} placeholder="Paste a copied account ({&quot;format&quot;:&quot;autozcoder-account&quot;,…}) or a JWT token" autoFocus={adding}/>
        <div className="zai-import-buttons">
          <Button disabled={!text.trim()||!!busy} onClick={doImport}>{busy==='import'?<Loader2 size={14} className="spin"/>:<Upload size={14}/>}Check and import</Button>
          {accounts.length>0&&<button type="button" className="text-button" onClick={()=>{setAdding(false);setText('');}}><X size={14}/>Cancel</button>}
        </div>
      </div>
      <p className="subtle">Polygate checks the account with Z.ai before saving it. Tokens stay in the encrypted settings vault, and are included in encrypted Polygate backups. One account is used at a time: when its quota runs out, Polygate says so instead of switching accounts by itself.</p>
    </div>}
    {note&&!error&&<p className="green" role="status"><Check size={13}/> {note}</p>}{error&&<p className="pg-error" role="alert">{error}</p>}{!list&&error&&<Button disabled={!!busy} onClick={()=>void run('load',()=>api('/admin/zai'))}>Try again</Button>}{dialog}
  </div>;
}
