import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Check,Cloud,Diamond,ExternalLink,Rocket,TriangleAlert,X} from 'lucide-react';
import {api} from './api';
import {Button,Field,Select} from './ui';
// One-click relay deployment. The platform's API token goes to the local gateway for this one call; the gateway deploys the bundled relay,
// stores a freshly generated access token as the relay's secret, and saves the relay as a route. Nothing here keeps the API token.
type Platform='vercel'|'netlify'|'cloudflare';
type Result={ok:boolean;id:string;name:string;url:string;platform:Platform;runtime:'bun'|'node-bun-ciphers'|'cloudflare-worker';region?:string;reachable:boolean;status:number;detail:string};
const VercelMark=({size=16}:{size?:number})=><svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 21.5 20h-19z" fill="currentColor"/></svg>;
type Spec={id:Platform;name:string;icon:ReactNode;color:string;intro:string;bullets:string[];steps:string[];tokenLabel:string;tokenHint:string;tokenUrl:string;tokenPlaceholder:string;nameLabel:string;namePlaceholder:string;verdict:{tone:'good'|'warn';text:string}};
const SPECS:Spec[]=[
  {id:'vercel',name:'Vercel',icon:<VercelMark/>,color:'#ffffff',intro:'Deploys a Vercel Function on the Bun runtime. Requests leave from Vercel’s network using Bun’s TLS handshake, which OpenCode Free accepts.',
    bullets:['Best choice for OpenCode: streams answers, runs on Bun, and Polygate can switch it to a fresh outbound address when one is used up','Hobby plan is free','Choose the region to choose the outbound address','Carries OpenCode Free and Kilo free models'],
    steps:['Open Account Settings → Tokens','Create a token (scope: your account, any expiry)','Paste it below'],
    tokenLabel:'API token',tokenHint:'Used for deploys you start from this window. Kept only if you tick Remember.',tokenUrl:'https://vercel.com/account/tokens',tokenPlaceholder:'vcp_…',nameLabel:'Project name',namePlaceholder:'polygate-relay',
    verdict:{tone:'good',text:'Recommended for OpenCode Free. Deploy one in a region near you, and a second in another region as a backup.'}},
  {id:'netlify',name:'Netlify',icon:<Diamond size={16}/>,color:'#2dd4bf',intro:'Deploys a Netlify Function on Node as a relay. It calls OpenCode with Bun’s TLS cipher list, which is the part of the handshake OpenCode Free checks. Requests leave from Netlify’s network.',
    bullets:['Not recommended for OpenCode: answers are buffered (nothing arrives until the whole answer is ready), a function is stopped after 30 seconds, and some networks block netlify.app','Good for light, short requests','Free plan: 125,000 invocations per month','Your relay URL ends in /.netlify/functions/relay','Carries OpenCode Free and Kilo free models'],
    steps:['Open User settings → Applications','Personal access tokens → New access token','Copy the token and paste it below'],
    tokenLabel:'API token',tokenHint:'Used once to deploy; not stored.',tokenUrl:'https://app.netlify.com/user/applications#personal-access-tokens',tokenPlaceholder:'nfp_…',nameLabel:'Site name',namePlaceholder:'polygate-relay',
    verdict:{tone:'warn',text:'Light use only. A deployed relay carried real chat requests in a test (a 2,200-character answer in 8.5 s), but answers are buffered and Netlify stops a function after 30 seconds, so a long answer or a long coding session fails. For OpenCode, deploy a Vercel relay instead.'}},
  {id:'cloudflare',name:'Cloudflare',icon:<Cloud size={16}/>,color:'#f6821f',intro:'Deploys a Cloudflare Worker as a relay for Kilo. Requests leave from Cloudflare’s network. OpenCode Free refuses a Worker’s TLS handshake, so this relay forwards to api.kilo.ai only and Polygate never sends OpenCode requests through it.',
    bullets:['Free plan: 100,000 requests per day','Streams responses','A new Worker needs up to a minute before every Cloudflare location serves it'],
    steps:['Open My Profile → API Tokens → Create Token','Use the “Edit Cloudflare Workers” template (or Workers Scripts: Edit on your account)','Copy the token, and your Account ID from Workers & Pages, and paste both below'],
    tokenLabel:'API token',tokenHint:'Used once to deploy; not stored.',tokenUrl:'https://dash.cloudflare.com/profile/api-tokens',tokenPlaceholder:'cfut_…',nameLabel:'Worker name',namePlaceholder:'polygate-relay',
    verdict:{tone:'warn',text:'Kilo only. Tested on 27 October 2026: a deployed Worker carried Kilo chat and streaming requests from a Cloudflare address. It needs the account to have a workers.dev address (Workers & Pages shows it).'}},
];
const REGIONS=[['fra1','Frankfurt (fra1)'],['iad1','Washington, D.C. (iad1)'],['sfo1','San Francisco (sfo1)'],['lhr1','London (lhr1)'],['cdg1','Paris (cdg1)'],['arn1','Stockholm (arn1)'],['dub1','Dublin (dub1)'],['cle1','Cleveland (cle1)'],['pdx1','Portland (pdx1)'],['yul1','Montréal (yul1)'],['gru1','São Paulo (gru1)'],['sin1','Singapore (sin1)'],['hnd1','Tokyo (hnd1)'],['kix1','Osaka (kix1)'],['icn1','Seoul (icn1)'],['hkg1','Hong Kong (hkg1)'],['bom1','Mumbai (bom1)'],['syd1','Sydney (syd1)'],['cpt1','Cape Town (cpt1)']];
type Row={region:string;status:'waiting'|'running'|'done'|'failed'|'skipped';result?:Result;error?:string};
const regionLabel=(v:string)=>REGIONS.find(([k])=>k===v)?.[1]||v;
export function RelayDeployBar({onDeployed,onNotice,existing=[],saved=false}:{onDeployed:()=>void;onNotice:(s:string)=>void;existing?:string[];saved?:boolean}){
  const [open,setOpen]=useState<Platform|null>(null);
  return <section className="section-block form-section relay-deploy"><div className="section-top"><div><h2>Deploy a relay</h2><p className="subtle">Pick a platform, paste its API token and Polygate deploys the relay and adds it as a route. The token is used for the deploy only and is not stored, except a Vercel token you ask Polygate to remember. OpenCode Free accepts a relay only if it sends Bun’s TLS cipher list: Vercel runs it on Bun (or Node), Netlify on Node.</p><p className="relay-advice"><strong>Advice:</strong> for OpenCode, Vercel is the best choice. Netlify is for light, short requests only, and Cloudflare carries Kilo only.</p></div></div>
    <div className="deploy-buttons">{SPECS.map(s=><button key={s.id} type="button" className="deploy-button" style={{'--brand':s.color} as any} onClick={()=>setOpen(s.id)}><span className="deploy-icon">{s.icon}</span>Deploy {s.name} Relay{s.id==='cloudflare'?<span className="deploy-tag">Kilo only</span>:s.id==='vercel'?<><span className="deploy-tag">Best for OpenCode</span><span className="deploy-tag">Works with Kilo</span></>:<><span className="deploy-tag light">Light use</span><span className="deploy-tag">Works with Kilo</span></>}</button>)}</div>
    {open&&<DeployDialog existing={existing} saved={saved} onForget={()=>void api('/admin/relays/token/forget',{}).then(onDeployed).catch(()=>{})} spec={SPECS.find(s=>s.id===open)!} onClose={()=>setOpen(null)} onDone={(r)=>{onDeployed();onNotice(`${r.platform} relay deployed${r.reachable?'':' (not answering yet)'}`);}}/>}
  </section>;
}
function DeployDialog({spec,onClose,onDone,existing,saved,onForget}:{spec:Spec;onClose:()=>void;onDone:(r:Result)=>void;existing:string[];saved:boolean;onForget:()=>void}){
  const [form,setForm]=useState({token:'',name:'',region:'fra1',runtime:'bun',accountId:''});
  // A remembered Vercel token is used from the gateway's encrypted settings; the dashboard never sees it again.
  const [remember,setRemember]=useState(false);const [another,setAnother]=useState(false);const usingSaved=spec.id==='vercel'&&saved&&!another;
  const [picked,setPicked]=useState<string[]>(['fra1']);const [batch,setBatch]=useState<Row[]|null>(null);const stop=useRef(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [result,setResult]=useState<Result|null>(null);
  const first=useRef<HTMLInputElement>(null);const box=useRef<HTMLDivElement>(null);const note=useRef<HTMLDivElement>(null);const closing=useRef(onClose);const [done,setDone]=useState<string[]>([]);const [plan,setPlan]=useState<any>(null);const [next,setNext]=useState('');
  useEffect(()=>{closing.current=onClose;});
  useEffect(()=>{const opener=document.activeElement as HTMLElement|null;first.current?.focus();return()=>opener?.focus();},[]);
  useEffect(()=>{if(result)note.current?.focus();},[result]);
  useEffect(()=>{const key=(e:KeyboardEvent)=>{
    if(e.key==='Escape'){if(!busy&&!e.defaultPrevented)closing.current();}
    else if(e.key==='Tab'&&box.current){const f=[...box.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled])')];const i=f.indexOf(document.activeElement as HTMLElement);if(!f.length)e.preventDefault();else if(e.shiftKey?i<=0:(i<0||i===f.length-1)){e.preventDefault();f[e.shiftKey?f.length-1:0].focus();}}
  };document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);},[busy]);
  // Regions that already have a relay: the ones deployed from this window and the Vercel relays already saved (their route names carry the region).
  const taken=new Set([...done,...existing]);const free=REGIONS.filter(([v])=>!taken.has(v));
  const chosen=spec.id==='vercel'?picked.filter(v=>!taken.has(v)):[];
  const haveToken=usingSaved||form.token.trim().length>7;
  const ready=haveToken&&(spec.id!=='cloudflare'||/^[a-fA-F0-9]{32}$/.test(form.accountId.trim()))&&(spec.id!=='vercel'||chosen.length>0);
  const credentials=()=>usingSaved?{useSaved:true}:{token:form.token.trim(),remember:spec.id==='vercel'&&remember};
  async function deploy(region=form.region,name=form.name.trim()){
    setBusy(true);setError('');
    try{const r:Result=await api('/admin/relays/deploy',{platform:spec.id,...credentials(),name,region,runtime:form.runtime,accountId:form.accountId.trim()});if(r.region)setDone(d=>[...d,r.region!]);setResult(r);setNext('');onDone(r);}
    catch(e:any){setError(e.message||'Deployment failed');}finally{setBusy(false);}
  }
  // Several regions, one after the other: each is its own Vercel project, so a failure in one does not undo the others.
  // Only a rejected token ends the run early; Stop ends it after the region that is being deployed.
  async function deployMany(){
    const regions=chosen;stop.current=false;setBusy(true);setError('');
    const rows:Row[]=regions.map(region=>({region,status:'waiting'}));setBatch([...rows]);
    const set=(i:number,patch:Partial<Row>)=>{rows[i]={...rows[i],...patch};setBatch([...rows]);};
    const base=form.name.trim();let rejected=false;
    for(let i=0;i<regions.length;i++){
      if(stop.current||rejected){set(i,{status:'skipped'});continue;}
      set(i,{status:'running'});
      try{const r:Result=await api('/admin/relays/deploy',{platform:'vercel',...credentials(),name:base?`${base}-${regions[i]}`:'',region:regions[i],runtime:form.runtime});setDone(d=>[...d,regions[i]]);set(i,{status:'done',result:r});onDone(r);}
      catch(e:any){const message=e.message||'Deployment failed';if(/check the token/i.test(message))rejected=true;set(i,{status:'failed',error:message});}
    }
    setBusy(false);
  }
  async function checkPlan(){setBusy(true);setError('');try{setPlan(await api('/admin/relays/inspect',{platform:'vercel',...(usingSaved?{useSaved:true}:{token:form.token.trim()})}));}catch(e:any){setError(e.message||'Could not read the account');}finally{setBusy(false);}}
  const toggle=(v:string)=>setPicked(p=>p.includes(v)?p.filter(x=>x!==v):[...p,v]);
  const planNote=plan?<div className={`dialog-note ${plan.plan==='hobby'||plan.plan==='pro'||plan.plan==='enterprise'?'info':'warn'}`}><Check size={16}/><p><strong>{String(plan.plan).charAt(0).toUpperCase()+String(plan.plan).slice(1)} plan</strong> ({plan.team}). {plan.limits?<>A project can run in {plan.limits.regionsPerProject>=99?'any number of':`up to ${plan.limits.regionsPerProject}`} function region{plan.limits.regionsPerProject===1?'':'s'}, so {plan.limits.regionsPerProject===1?'each region you add is its own project':'one project can cover several regions, but Polygate still deploys one region per project so it can choose between them'}. You have {plan.projectsMore?'100+':plan.projects} projects{plan.limits.projects?` of ${plan.limits.projects}`:''} and may create {plan.limits.deploymentsPerDay.toLocaleString()} deployments a day.</>:'Its limits are not known to Polygate; check the Vercel dashboard.'}</p></div>:null;
  const title=`Deploy ${spec.name} Relay`;
  return <div className="dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)onClose();}}>
    <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-label={title}>
      <header className="dialog-head"><span className="deploy-icon" style={{'--brand':spec.color} as any}>{spec.icon}</span><h2>{title}</h2><span className="toolbar-spacer"/><button type="button" className="icon-button" aria-label="Close" disabled={busy} onClick={onClose}><X size={16}/></button></header>
      {batch?<div className="dialog-body">
        <p className="subtle">{busy?'Deploying one region after another. Each one takes up to a minute or two; keep this window open.':`${batch.filter(r=>r.status==='done').length} of ${batch.length} relays deployed.`}</p>
        <ul className="batch-list" aria-live="polite">{batch.filter(r=>r.status!=='skipped').map(r=><li key={r.region} className={`batch-row ${r.status}`}>
          <div className="batch-head"><strong>{regionLabel(r.region)}</strong><span className="toolbar-spacer"/><span className="batch-state">{{waiting:'Waiting',running:'Deploying…',done:r.result?.reachable?'Deployed and answering':'Deployed, not answering yet',failed:'Failed',skipped:'Not deployed'}[r.status]}</span></div>
          {r.result&&<input readOnly aria-label={`Relay URL for ${r.region}`} value={r.result.url} onFocus={e=>e.currentTarget.select()}/>}
          {r.error&&<p className="batch-error">{r.error}</p>}</li>)}</ul>
        {batch.some(r=>r.status==='skipped')&&<p className="subtle">{batch.filter(r=>r.status==='skipped').length} more region{batch.filter(r=>r.status==='skipped').length===1?' was':'s were'} not deployed because the run ended early. Close this window and tick them again to retry.</p>}
        {busy&&<p className="subtle">Stop ends the run after the region that is being deployed now; relays already deployed stay.</p>}
        <div className="dialog-actions">{busy?<Button onClick={()=>{stop.current=true;}}>Stop after this one</Button>:<><Button variant="primary" onClick={onClose}>Done</Button></>}</div>
      </div>:result?<div className="dialog-body">
        <div ref={note} tabIndex={-1} className={`dialog-note ${result.reachable?'good':'warn'}`}>{result.reachable?<Check size={16}/>:<TriangleAlert size={16}/>}<p><strong>{result.reachable?'Relay deployed and answering.':'Relay deployed, not answering yet.'}</strong> {result.detail}</p></div>
        <Field label="Relay URL"><input readOnly value={result.url} onFocus={e=>e.currentTarget.select()}/></Field>
        <p className="subtle">It was added under Relays as a route with its generated access token. Select it on Routing to use it, or on a provider to send that provider through it.</p>
        {spec.verdict.text&&<div className={`dialog-note ${spec.verdict.tone}`}>{spec.verdict.tone==='good'?<Check size={16}/>:<TriangleAlert size={16}/>}<p>{spec.verdict.text}</p></div>}
        {spec.id==='vercel'&&<div className="more-regions">{planNote}<strong>Another region?</strong><p className="subtle">Each region sends from its own pool of addresses, and a relay that is used up in one region can hand over to the next. Deploy them one at a time: each is a separate Vercel project and counts toward your Vercel plan's limits, so nothing is deployed until you press the button.</p>
          {free.length?<div className="more-row"><Select value={next||free[0][0]} onChange={setNext}>{free.map(([v,l])=><option key={v} value={v}>{l}</option>)}</Select><Button disabled={busy} onClick={()=>void deploy(next||free[0][0],form.name.trim()?`${form.name.trim()}-${next||free[0][0]}`:'')}><Rocket size={14}/>{busy?'Deploying…':`Deploy ${next||free[0][0]}`}</Button></div>:<p className="subtle">Every listed region already has a relay.</p>}
          {error&&<div className="dialog-note error" role="alert"><TriangleAlert size={16}/><p>{error}</p></div>}</div>}
        <div className="dialog-actions"><Button variant="primary" disabled={busy} onClick={onClose}>Done</Button></div>
      </div>:<form className="dialog-body" onSubmit={e=>{e.preventDefault();if(!ready||busy)return;if(spec.id!=='vercel')void deploy();else if(chosen.length>1)void deployMany();else void deploy(chosen[0]);}} autoComplete="off">
        <div className="dialog-note info"><div><strong>What is a {spec.name} relay?</strong><p>{spec.intro}</p><ul>{spec.bullets.map(b=><li key={b}>{b}</li>)}</ul><strong>How to get the token</strong><ol>{spec.steps.map(x=><li key={x}>{x}</li>)}</ol></div></div>
        {spec.verdict.text&&<div className={`dialog-note ${spec.verdict.tone}`}>{spec.verdict.tone==='good'?<Check size={16}/>:<TriangleAlert size={16}/>}<p>{spec.verdict.text}</p></div>}
        {usingSaved?<div className="dialog-note good saved-token"><Check size={16}/><div><p><strong>Using your saved Vercel token.</strong> It is kept encrypted on this computer and is not shown again.</p><div className="token-row"><Button disabled={busy} onClick={()=>setAnother(true)}>Use another token</Button><Button disabled={busy} onClick={onForget}>Forget the saved token</Button></div></div></div>
        :<><Field label={spec.tokenLabel} hint={spec.tokenHint}><input ref={first} required type="password" autoComplete="new-password" value={form.token} onChange={e=>setForm({...form,token:e.target.value})} placeholder={spec.tokenPlaceholder} spellCheck={false}/></Field>
        {spec.id==='vercel'&&<div className="check-row"><input id="remember-token" type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)}/><label htmlFor="remember-token">Remember this token on this computer<small>Saved encrypted with your other settings, so the next deploy needs no pasting. You can forget it here at any time.</small></label></div>}
        {spec.id==='vercel'&&saved&&<div className="token-row"><Button disabled={busy} onClick={()=>setAnother(false)}>Use the saved token instead</Button></div>}</>}
        <div className="token-row"><a className="token-link" href={spec.tokenUrl} target="_blank" rel="noreferrer noopener">Get a token<ExternalLink size={12}/></a>{spec.id==='vercel'&&<Button disabled={busy||!haveToken} onClick={()=>void checkPlan()}>Check my plan</Button>}</div>{planNote}
        {spec.id==='cloudflare'&&<Field label="Account ID" hint="32 letters and digits. Shown in the Cloudflare dashboard under Workers & Pages."><input required value={form.accountId} onChange={e=>setForm({...form,accountId:e.target.value})} placeholder="0123456789abcdef0123456789abcdef" spellCheck={false} autoComplete="off"/></Field>}
        <Field label={spec.nameLabel} hint="Lowercase letters, numbers and hyphens. Leave empty for a generated name."><input value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder={spec.namePlaceholder} spellCheck={false}/></Field>
        {spec.id==='vercel'&&<div className="field"><span>Regions</span>
          <div className="region-tools"><Button disabled={busy} onClick={()=>setPicked(free.map(([v])=>v))}>Select all</Button><Button disabled={busy} onClick={()=>setPicked([])}>Clear</Button><span className="subtle">{chosen.length} selected</span></div>
          <div className="region-grid" role="group" aria-label="Regions">{REGIONS.map(([v,l])=>{const has=taken.has(v);return <label key={v} className={has?'taken':''}><input type="checkbox" disabled={has} checked={!has&&picked.includes(v)} onChange={()=>toggle(v)}/>{l}{has&&<small>already has a relay</small>}</label>;})}</div>
          <small>Each region sends from its own pool of addresses. Tick one to deploy it, or several to deploy them one after another. Every region is a separate Vercel project and counts toward your plan’s limits{chosen.length>1?`, so ${chosen.length} projects will be created`:''}.</small></div>}
        {spec.id==='vercel'&&<Field label="Runtime" hint="Bun is the default and stays accepted if OpenCode's check changes. Node sends Bun's TLS cipher list itself and works the same today; use it if Vercel's Bun runtime gives you trouble."><Select value={form.runtime} onChange={v=>setForm({...form,runtime:v})}><option value="bun">Bun (recommended)</option><option value="node">Node</option></Select></Field>}
        {error&&<div className="dialog-note error" role="alert"><TriangleAlert size={16}/><p>{error}</p></div>}
        <div className="dialog-actions"><Button variant="primary" type="submit" disabled={!ready||busy}><Rocket size={14}/>{busy?'Deploying…':chosen.length>1?`Deploy ${chosen.length} relays`:'Deploy'}</Button><Button disabled={busy} onClick={onClose}>Cancel</Button></div>
      </form>}
    </div>
  </div>;
}
