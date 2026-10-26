import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Check,Diamond,ExternalLink,Rocket,TriangleAlert,X} from 'lucide-react';
import {api} from './api';
import {Button,Field,Select} from './ui';
// One-click relay deployment. The platform's API token goes to the local gateway for this one call; the gateway deploys the bundled relay,
// stores a freshly generated access token as the relay's secret, and saves the relay as a route. Nothing here keeps the API token.
type Platform='vercel'|'netlify';
type Result={ok:boolean;id:string;name:string;url:string;platform:Platform;runtime:'bun'|'node-bun-ciphers';region?:string;reachable:boolean;status:number;detail:string};
const VercelMark=({size=16}:{size?:number})=><svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 21.5 20h-19z" fill="currentColor"/></svg>;
type Spec={id:Platform;name:string;icon:ReactNode;color:string;intro:string;bullets:string[];steps:string[];tokenLabel:string;tokenHint:string;tokenUrl:string;tokenPlaceholder:string;nameLabel:string;namePlaceholder:string;verdict:{tone:'good'|'warn';text:string}};
const SPECS:Spec[]=[
  {id:'vercel',name:'Vercel',icon:<VercelMark/>,color:'#ffffff',intro:'Deploys a Vercel Function on the Bun runtime. Requests leave from Vercel’s network using Bun’s TLS handshake, which OpenCode Free accepts.',
    bullets:['Hobby plan is free','Streams responses','Choose the region to choose the outbound address'],
    steps:['Open Account Settings → Tokens','Create a token (scope: your account, any expiry)','Paste it below'],
    tokenLabel:'API token',tokenHint:'Used only for deploys you start from this window; never stored.',tokenUrl:'https://vercel.com/account/tokens',tokenPlaceholder:'vcp_…',nameLabel:'Project name',namePlaceholder:'polygate-relay',
    verdict:{tone:'good',text:''}},
  {id:'netlify',name:'Netlify',icon:<Diamond size={16}/>,color:'#2dd4bf',intro:'Deploys a Netlify Function on Node as a relay. It calls OpenCode with Bun’s TLS cipher list, which is the part of the handshake OpenCode Free checks. Requests leave from Netlify’s network.',
    bullets:['Free plan: 125,000 invocations per month','Answers are buffered, not streamed; a function is stopped after 30 seconds','Your relay URL ends in /.netlify/functions/relay'],
    steps:['Open User settings → Applications','Personal access tokens → New access token','Copy the token and paste it below'],
    tokenLabel:'API token',tokenHint:'Used once to deploy; not stored.',tokenUrl:'https://app.netlify.com/user/applications#personal-access-tokens',tokenPlaceholder:'nfp_…',nameLabel:'Site name',namePlaceholder:'polygate-relay',
    verdict:{tone:'good',text:'Tested on Netlify on 26 October 2026: a deployed relay carried real chat requests (a 2,200-character answer in 8.5 s). Answers are buffered and Netlify stops a function after 30 seconds, so a very long answer fails.'}},
];
const REGIONS=[['fra1','Frankfurt (fra1)'],['iad1','Washington, D.C. (iad1)'],['sfo1','San Francisco (sfo1)'],['lhr1','London (lhr1)'],['cdg1','Paris (cdg1)'],['arn1','Stockholm (arn1)'],['dub1','Dublin (dub1)'],['cle1','Cleveland (cle1)'],['pdx1','Portland (pdx1)'],['yul1','Montréal (yul1)'],['gru1','São Paulo (gru1)'],['sin1','Singapore (sin1)'],['hnd1','Tokyo (hnd1)'],['kix1','Osaka (kix1)'],['icn1','Seoul (icn1)'],['hkg1','Hong Kong (hkg1)'],['bom1','Mumbai (bom1)'],['syd1','Sydney (syd1)'],['cpt1','Cape Town (cpt1)']];
export function RelayDeployBar({onDeployed,onNotice,existing=[]}:{onDeployed:()=>void;onNotice:(s:string)=>void;existing?:string[]}){
  const [open,setOpen]=useState<Platform|null>(null);
  return <section className="section-block form-section relay-deploy"><div className="section-top"><div><h2>Deploy a relay</h2><p className="subtle">Pick a platform, paste its API token and Polygate deploys the relay and adds it as a route. The token is used for this one call and is not stored. OpenCode Free accepts a relay only if it sends Bun’s TLS cipher list: Vercel runs it on Bun (or Node), Netlify on Node.</p></div></div>
    <div className="deploy-buttons">{SPECS.map(s=><button key={s.id} type="button" className="deploy-button" style={{'--brand':s.color} as any} onClick={()=>setOpen(s.id)}><span className="deploy-icon">{s.icon}</span>Deploy {s.name} Relay{s.verdict.tone==='good'&&<span className="deploy-tag">Works with OpenCode Free</span>}</button>)}</div>
    {open&&<DeployDialog existing={existing} spec={SPECS.find(s=>s.id===open)!} onClose={()=>setOpen(null)} onDone={(r)=>{onDeployed();onNotice(`${r.platform} relay deployed${r.reachable?'':' (not answering yet)'}`);}}/>}
  </section>;
}
function DeployDialog({spec,onClose,onDone,existing}:{spec:Spec;onClose:()=>void;onDone:(r:Result)=>void;existing:string[]}){
  const [form,setForm]=useState({token:'',name:'',region:'fra1',runtime:'bun'});const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [result,setResult]=useState<Result|null>(null);
  const first=useRef<HTMLInputElement>(null);const box=useRef<HTMLDivElement>(null);const note=useRef<HTMLDivElement>(null);const closing=useRef(onClose);const [done,setDone]=useState<string[]>([]);const [plan,setPlan]=useState<any>(null);const [next,setNext]=useState('');
  useEffect(()=>{closing.current=onClose;});
  useEffect(()=>{const opener=document.activeElement as HTMLElement|null;first.current?.focus();return()=>opener?.focus();},[]);
  useEffect(()=>{if(result)note.current?.focus();},[result]);
  useEffect(()=>{const key=(e:KeyboardEvent)=>{
    if(e.key==='Escape'){if(!busy&&!e.defaultPrevented)closing.current();}
    else if(e.key==='Tab'&&box.current){const f=[...box.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled])')];const i=f.indexOf(document.activeElement as HTMLElement);if(!f.length)e.preventDefault();else if(e.shiftKey?i<=0:(i<0||i===f.length-1)){e.preventDefault();f[e.shiftKey?f.length-1:0].focus();}}
  };document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);},[busy]);
  const ready=form.token.trim().length>7;
  // Regions that already have a relay: the ones deployed from this window and the Vercel relays already saved (their route names carry the region).
  const taken=new Set([...done,...existing]);const free=REGIONS.filter(([v])=>!taken.has(v));
  async function deploy(region=form.region,name=form.name.trim()){
    setBusy(true);setError('');
    try{const r:Result=await api('/admin/relays/deploy',{platform:spec.id,token:form.token.trim(),name,region,runtime:form.runtime});if(r.region)setDone(d=>[...d,r.region!]);setResult(r);setNext('');onDone(r);}
    catch(e:any){setError(e.message||'Deployment failed');}finally{setBusy(false);}
  }
  async function checkPlan(){setBusy(true);setError('');try{setPlan(await api('/admin/relays/inspect',{platform:'vercel',token:form.token.trim()}));}catch(e:any){setError(e.message||'Could not read the account');}finally{setBusy(false);}}
  const planNote=plan?<div className={`dialog-note ${plan.plan==='hobby'||plan.plan==='pro'||plan.plan==='enterprise'?'info':'warn'}`}><Check size={16}/><p><strong>{String(plan.plan).charAt(0).toUpperCase()+String(plan.plan).slice(1)} plan</strong> ({plan.team}). {plan.limits?<>A project can run in {plan.limits.regionsPerProject>=99?'any number of':`up to ${plan.limits.regionsPerProject}`} function region{plan.limits.regionsPerProject===1?'':'s'}, so {plan.limits.regionsPerProject===1?'each region you add is its own project':'one project can cover several regions, but Polygate still deploys one region per project so it can choose between them'}. You have {plan.projectsMore?'100+':plan.projects} projects{plan.limits.projects?` of ${plan.limits.projects}`:''} and may create {plan.limits.deploymentsPerDay.toLocaleString()} deployments a day.</>:'Its limits are not known to Polygate; check the Vercel dashboard.'}</p></div>:null;
  const title=`Deploy ${spec.name} Relay`;
  return <div className="dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)onClose();}}>
    <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-label={title}>
      <header className="dialog-head"><span className="deploy-icon" style={{'--brand':spec.color} as any}>{spec.icon}</span><h2>{title}</h2><span className="toolbar-spacer"/><button type="button" className="icon-button" aria-label="Close" disabled={busy} onClick={onClose}><X size={16}/></button></header>
      {result?<div className="dialog-body">
        <div ref={note} tabIndex={-1} className={`dialog-note ${result.reachable?'good':'warn'}`}>{result.reachable?<Check size={16}/>:<TriangleAlert size={16}/>}<p><strong>{result.reachable?'Relay deployed and answering.':'Relay deployed, not answering yet.'}</strong> {result.detail}</p></div>
        <Field label="Relay URL"><input readOnly value={result.url} onFocus={e=>e.currentTarget.select()}/></Field>
        <p className="subtle">It was added under Relays as a route with its generated access token. Select it on Routing to use it, or on a provider to send that provider through it.</p>
        {spec.verdict.text&&<div className={`dialog-note ${spec.verdict.tone}`}>{spec.verdict.tone==='good'?<Check size={16}/>:<TriangleAlert size={16}/>}<p>{spec.verdict.text}</p></div>}
        {spec.id==='vercel'&&<div className="more-regions">{planNote}<strong>Another region?</strong><p className="subtle">Each region sends from its own pool of addresses, and a relay that is used up in one region can hand over to the next. Deploy them one at a time: each is a separate Vercel project and counts toward your Vercel plan's limits, so nothing is deployed until you press the button.</p>
          {free.length?<div className="more-row"><Select value={next||free[0][0]} onChange={setNext}>{free.map(([v,l])=><option key={v} value={v}>{l}</option>)}</Select><Button disabled={busy} onClick={()=>void deploy(next||free[0][0],form.name.trim()?`${form.name.trim()}-${next||free[0][0]}`:'')}><Rocket size={14}/>{busy?'Deploying…':`Deploy ${next||free[0][0]}`}</Button></div>:<p className="subtle">Every listed region already has a relay.</p>}
          {error&&<div className="dialog-note error" role="alert"><TriangleAlert size={16}/><p>{error}</p></div>}</div>}
        <div className="dialog-actions"><Button variant="primary" disabled={busy} onClick={onClose}>Done</Button></div>
      </div>:<form className="dialog-body" onSubmit={e=>{e.preventDefault();if(ready&&!busy)void deploy();}} autoComplete="off">
        <div className="dialog-note info"><div><strong>What is a {spec.name} relay?</strong><p>{spec.intro}</p><ul>{spec.bullets.map(b=><li key={b}>{b}</li>)}</ul><strong>How to get the token</strong><ol>{spec.steps.map(x=><li key={x}>{x}</li>)}</ol></div></div>
        {spec.verdict.text&&<div className={`dialog-note ${spec.verdict.tone}`}>{spec.verdict.tone==='good'?<Check size={16}/>:<TriangleAlert size={16}/>}<p>{spec.verdict.text}</p></div>}
        <Field label={spec.tokenLabel} hint={spec.tokenHint}><input ref={first} required type="password" autoComplete="new-password" value={form.token} onChange={e=>setForm({...form,token:e.target.value})} placeholder={spec.tokenPlaceholder} spellCheck={false}/></Field>
        <div className="token-row"><a className="token-link" href={spec.tokenUrl} target="_blank" rel="noreferrer noopener">Get a token<ExternalLink size={12}/></a>{spec.id==='vercel'&&<Button disabled={busy||form.token.trim().length<8} onClick={()=>void checkPlan()}>Check my plan</Button>}</div>{planNote}
        <Field label={spec.nameLabel} hint="Lowercase letters, numbers and hyphens. Leave empty for a generated name."><input value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder={spec.namePlaceholder} spellCheck={false}/></Field>
        {spec.id==='vercel'&&<Field label="Region" hint="Decides which address the relay sends from. Deploy another one for a different address."><Select value={form.region} onChange={v=>setForm({...form,region:v})}>{REGIONS.map(([v,l])=><option key={v} value={v}>{l}</option>)}</Select></Field>}
        {spec.id==='vercel'&&<Field label="Runtime" hint="Bun is the default and stays accepted if OpenCode's check changes. Node sends Bun's TLS cipher list itself and works the same today; use it if Vercel's Bun runtime gives you trouble."><Select value={form.runtime} onChange={v=>setForm({...form,runtime:v})}><option value="bun">Bun (recommended)</option><option value="node">Node</option></Select></Field>}
        {error&&<div className="dialog-note error" role="alert"><TriangleAlert size={16}/><p>{error}</p></div>}
        <div className="dialog-actions"><Button variant="primary" type="submit" disabled={!ready||busy}><Rocket size={14}/>{busy?'Deploying…':'Deploy'}</Button><Button disabled={busy} onClick={onClose}>Cancel</Button></div>
      </form>}
    </div>
  </div>;
}
