import {ChevronRight} from 'lucide-react';
import {compact,gatewayState,time,type Snapshot} from './ui';
import {usedUp} from './daypass';
import type {Model,Provider} from '../backend/types';

// The Overview's summary. Every number comes from the request log (/admin/metrics) or the live state; nothing is estimated.
export type OverviewMetrics={uptimeSeconds:number;requests:number;successRate:number|null;errors:number;inputTokens:number;outputTokens:number;p50:number;
  hourly:{hour:number;requests:number;errors:number}[];byModel:{model:string;requests:number}[];
  byProvider:{provider:string;requests:number;errors:number;tokens:number;avgMs:number}[];byKey:{name:string;requests:number;tokens:number}[];
  previousRequests:number;failures:{message:string;status:number;count:number;lastAt:number;model:string}[]};
type Go=(page:any)=>void;

const seconds=(n:number)=>!n?'-':n<1000?`${Math.round(n)} ms`:n<60000?`${(n/1000).toFixed(n<10000?1:0)} s`:`${Math.floor(n/60000)} min ${Math.round(n%60000/1000)} s`;
const upFor=(s:number)=>s<3600?`${Math.max(1,Math.round(s/60))} min`:s<86400?`${Math.floor(s/3600)} h ${Math.floor(s%3600/60)} min`:`${Math.floor(s/86400)} d ${Math.floor(s%86400/3600)} h`;
const leftUntil=(t:number)=>{const m=Math.max(1,Math.round((t-Date.now())/60000));return m>=60?`${Math.floor(m/60)} h ${m%60} min`:`${m} min`;};
// The comparison is only made when the day before has requests to compare with.
const change=(now:number,before:number)=>{if(!before)return '';const d=Math.round((now-before)/before*100);return d===0?'same as the day before':`${d>0?'up':'down'} ${Math.abs(d)}% on the day before`;};
const localHour=(t:number)=>new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false});
// A relay's name carries its deployment name in brackets; the short form is enough in a summary.
export const shortName=(name:string)=>name.replace(/\s*\([^)]*\)\s*$/,'')||name;

export function DayTicket({data,metrics}:{data:Snapshot;metrics?:OverviewMetrics|null}){
  const gs=gatewayState(data);const m=metrics;
  const busiest=m?.hourly.reduce<{hour:number;requests:number}|null>((b,h)=>!b||h.requests>b.requests?h:b,null);
  const delta=m?change(m.requests,m.previousRequests):'';
  return <article className="pass day-pass" aria-label="Last 24 hours">
    <div className="pass-body">
      <h2 className="day-title">Last 24 hours</h2>
      <div className="day-figures">
        <div><strong>{m?m.requests.toLocaleString():'-'}</strong><span>requests{delta&&<small>{delta}</small>}</span></div>
        <div><strong>{m?.successRate==null?'-':`${Math.round(m.successRate)}%`}</strong><span>answered{m&&m.errors>0&&<small>{m.errors.toLocaleString()} failed</small>}</span></div>
        <div><strong>{m?compact(m.inputTokens+m.outputTokens):'-'}</strong><span>tokens{m&&m.inputTokens+m.outputTokens>0&&<small>{compact(m.inputTokens)} in, {compact(m.outputTokens)} out</small>}</span></div>
        <div><strong>{m?seconds(m.p50):'-'}</strong><span>typical answer</span></div>
      </div>
      {m&&(m.requests?<div className="pass-facts">{m.byModel[0]&&<span>Most used <b>{m.byModel[0].model}</b></span>}{m.byKey[0]&&<span>Busiest client <b>{m.byKey[0].name}</b></span>}{busiest&&busiest.requests>0&&<span>Busiest hour <b>{localHour(busiest.hour)}</b></span>}</div>:<p className="pass-where">No requests yet. Copy the address above into your client, or use Try a request.</p>)}
    </div>
    <div className="pass-stub">
      <div><span>Right now</span><strong className="pass-count">{data.queue.active}</strong><span>running, {data.queue.waiting} waiting</span></div>
      <div><span>Gateway</span><strong className="pass-state">{gs.label}</strong></div>
    </div>
  </article>;
}

// How many of a provider's models are in each state. Drawn in proportion, and always said in words next to it.
export const stateCounts=(models:Model[])=>({total:models.length,available:models.filter(m=>m.state==='available').length,unchecked:models.filter(m=>m.state==='unchecked').length,cooldown:models.filter(m=>m.state==='cooldown').length,unavailable:models.filter(m=>m.state==='unavailable').length});
export function ModelBar({counts}:{counts:ReturnType<typeof stateCounts>}){
  const part=(n:number,name:string)=>n?<i className={name} style={{flexGrow:n}}/>:null;
  return <span className="model-bar" title={`${counts.available} available, ${counts.unchecked} not checked, ${counts.cooldown} resting, ${counts.unavailable} unavailable`}>{part(counts.available,'ok')}{part(counts.unchecked,'unknown')}{part(counts.cooldown,'rest')}{part(counts.unavailable,'gone')}</span>;
}

export function ProviderHealth({data,metrics,go}:{data:Snapshot;metrics?:OverviewMetrics|null;go:Go}){
  const stats=(p:Provider)=>metrics?.byProvider.find(x=>x.provider===p.id);
  const rows=data.settings.providers.filter(p=>p.enabled||stats(p)).sort((a,b)=>Number(b.enabled)-Number(a.enabled)||(stats(b)?.requests||0)-(stats(a)?.requests||0));
  const open=(p:Provider)=>{try{localStorage.setItem('polygate-models-provider',p.id);}catch{/* storage can be disabled */}go('Models');};
  return <section className="section-block overview-card"><div className="section-top"><h2>Providers</h2><button className="text-button" onClick={()=>go('Providers')}>Manage <ChevronRight size={14}/></button></div>
    <div className="table-wrap"><table className="provider-health"><thead><tr><th>Provider</th><th>Models</th><th className="numeric">Requests</th><th className="numeric">Failed</th><th className="numeric">Typical</th></tr></thead>
      <tbody>{rows.map(p=>{const counts=stateCounts(data.models.filter(m=>m.providerId===p.id));const s=stats(p);return <tr key={p.id} className="clickable" tabIndex={0} title={`Open ${p.name} on the Models page`} onClick={()=>open(p)} onKeyDown={e=>{if(e.key==='Enter')open(p);}}>
        <td><strong>{p.name}</strong>{!p.enabled&&<small className="muted">Switched off</small>}</td>
        <td><div className="model-cell"><ModelBar counts={counts}/><small>{counts.total?`${counts.available} of ${counts.total} available`:'None listed'}{counts.unavailable?`, ${counts.unavailable} unavailable`:''}</small></div></td>
        <td className="numeric">{s?s.requests.toLocaleString():'0'}</td>
        <td className="numeric">{s?.errors?<span className="red">{s.errors.toLocaleString()}</span>:<span className="muted">0</span>}</td>
        <td className="numeric mono">{s?seconds(s.avgMs):'-'}</td></tr>;})}</tbody></table></div></section>;
}

// Where the fix for a failure usually is.
const fixFor=(message:string):[string,string]=>/queue|busy|deadline/i.test(message)?['Settings','Change limits']:/route|exit|relay|proxy|allowance|used up/i.test(message)?['Routing','Open Routing']:['Requests','See requests'];
export function Failures({metrics,go}:{metrics?:OverviewMetrics|null;go:Go}){
  const list=metrics?.failures||[];
  return <section className="section-block overview-card"><div className="section-top"><h2>What failed</h2><span className="subtle">Last 24 hours</span></div>
    {list.length?<ol className="failure-list">{list.map(f=>{const [page,label]=fixFor(f.message);return <li key={f.status+f.message}>
      <strong className="failure-count">{f.count.toLocaleString()}</strong>
      <div><p title={f.message}>{f.message}</p><small>HTTP {f.status} · last at {time(f.lastAt)}{f.model?` · ${f.model}`:''}</small></div>
      <button className="text-button" onClick={()=>go(page)}>{label}</button></li>;})}</ol>
    :<p className="overview-empty">{metrics?'Nothing failed. Requests your client cancelled are not counted.':'Loading…'}</p>}</section>;
}

export function ExitsSummary({data,go}:{data:Snapshot;go:Go}){
  const routes=data.settings.routes;const on=routes.filter(r=>r.enabled);const out=on.filter(r=>usedUp(r));const resting=on.filter(r=>!usedUp(r)&&(r.cooldownUntil||0)>Date.now());
  const current=routes.find(r=>r.id===data.settings.routeId);const soonest=out.map(r=>r.exhaustedUntil!).sort((a,b)=>a-b)[0];const next=data.backup?.find(b=>b.usable);
  const spreading=data.settings.rotate;
  return <section className="rail-section"><div className="section-top"><h2>Exits</h2><button className="text-button" onClick={()=>go('Routing')}>Manage <ChevronRight size={14}/></button></div>
    <p className="rail-lead">{spreading?<>Spreading over <b>{on.length-out.length-resting.length}</b> exits</>:current?<><b title={current.name}>{shortName(current.name)}</b> in use</>:'No exit selected'}</p>
    <dl className="health-list"><div><dt>Ready</dt><dd className="green">{on.length-out.length-resting.length} of {routes.length}</dd></div>
      {out.length>0&&<div><dt>Used up</dt><dd className="amber" title={out.map(r=>r.name).join(', ')}>{out.length}, next back in {leftUntil(soonest)}</dd></div>}
      {resting.length>0&&<div><dt>Resting</dt><dd className="amber">{resting.length}</dd></div>}
      {routes.length-on.length>0&&<div><dt>Switched off</dt><dd>{routes.length-on.length}</dd></div>}
      {!spreading&&next&&<div><dt>Next in line</dt><dd title={next.name}>{shortName(next.name)}</dd></div>}</dl></section>;
}

export function ClientsSummary({metrics,go}:{metrics?:OverviewMetrics|null;go:Go}){
  const list=metrics?.byKey||[];
  return <section className="rail-section"><div className="section-top"><h2>Clients</h2><button className="text-button" onClick={()=>go('Usage')}>Usage <ChevronRight size={14}/></button></div>
    {list.length?<dl className="health-list">{list.slice(0,5).map(k=><div key={k.name}><dt title={k.name}>{k.name}</dt><dd>{k.requests.toLocaleString()}<small className="muted rail-note">{compact(k.tokens)} tokens</small></dd></div>)}</dl>:<p className="overview-empty">No client has sent a request in the last 24 hours.</p>}</section>;
}

export function GatewayFacts({data,metrics}:{data:Snapshot;metrics?:OverviewMetrics|null}){
  const max=data.settings.maxConcurrent;const counts=stateCounts(data.models);
  return <section className="rail-section"><div className="section-top"><h2>Gateway</h2></div>
    <dl className="health-list"><div><dt>Version</dt><dd>{data.version}</dd></div>{metrics&&<div><dt>Running for</dt><dd>{upFor(metrics.uptimeSeconds)}</dd></div>}
      <div><dt>At once</dt><dd>{max?`${max} requests`:'No limit'}</dd></div>
      <div><dt>Models</dt><dd title={`${counts.available} available of ${counts.total} listed`}>{counts.available} of {counts.total} available</dd></div></dl></section>;
}
