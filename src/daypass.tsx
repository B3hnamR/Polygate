import type {CSSProperties} from 'react';
import {ms,time,type Snapshot} from './ui';
import type {Route} from '../backend/types';

// The "day pass" pieces of the dashboard: every exit is shown as a ticket, and a used-up exit carries a stamp with the time it is valid again.
export type Metrics={hourly:{hour:number;requests:number;errors:number}[];byRoute:{route:string;requests:number;errors:number;avgMs:number}[]};
const utc=(t:number)=>new Date(t).toISOString().slice(11,16)+' UTC';
const left=(until:number)=>{const m=Math.max(1,Math.round((until-Date.now())/60000));return m>=60?`${Math.floor(m/60)} h ${m%60} m`:`${m} min`;};
export const usedUp=(r?:Route)=>!!r?.exhaustedUntil&&r.exhaustedUntil>Date.now();
const sentence=(t:string)=>t?t[0].toUpperCase()+t.slice(1):t;
const host=(url:string)=>{try{return new URL(url).host;}catch{return url;}};
export const exitWhere=(r:Route)=>r.kind==='direct'?'Your own network connection':r.kind==='warp'?'Cloudflare WARP on this computer':r.id==='proxy-pool'?'Verified proxies, swapped as they wear out':host(r.url);
const kind=(r:Route)=>r.id==='proxy-pool'?'Proxy pool':r.kind==='direct'?'Direct':r.kind==='warp'?'WARP':r.kind==='relay'?'Relay':'Proxy';
const count=(m:Metrics|null|undefined,r:Route)=>m?.byRoute.find(x=>x.route===r.name)?.requests??0;
// One day of allowance is drawn as the full bar, so the bar's length is the time left until the exit is valid again.
const Timebar=({until}:{until:number})=><span className="timebar" title={`Valid again at ${utc(until)}`}><i style={{width:Math.min(100,Math.max(3,(until-Date.now())/864000))+'%'}}/></span>;

export function Stamp({until,refused}:{until:number;refused?:boolean}){
  return <div className="stamp" role="img" aria-label={refused?`Refused by the Free tier until ${utc(until)}`:`Used up, valid again at ${utc(until)}`}>{refused?'REFUSED':'USED UP'}<small>VALID AGAIN {utc(until)}</small></div>;
}

export function ExitPass({data,metrics,onManage}:{data:Snapshot;metrics?:Metrics|null;onManage:()=>void}){
  const r=data.settings.routes.find(x=>x.id===data.settings.routeId);
  if(!r)return <section className="pass pass-missing"><div className="pass-body"><h2 className="pass-name">No exit selected</h2><p className="pass-where">Requests have nowhere to go. Pick an exit on Routing.</p><button className="button primary" onClick={onManage}>Open Routing</button></div></section>;
  const info=data.routeInfo?.[r.id];const s=data.stats||{};const total=Number(s.total)||0;const last=data.logs[0];
  const hours=Array.from({length:24},(_,i)=>{const h=(Math.floor(Date.now()/3600000)-23+i)*3600000;return metrics?.hourly.find(x=>x.hour===h)||{hour:h,requests:0,errors:0};});
  const peak=Math.max(1,...hours.map(h=>h.requests));
  return <article className={`pass ${usedUp(r)?'is-used':''}`} aria-label={`Active exit: ${r.name}`}>
    <div className="pass-body">
      <h2 className="pass-name">{r.name}</h2>
      <p className="pass-where">{kind(r)} · {exitWhere(r)}</p>
      <div className="punches" role="img" aria-label="Requests per hour over the last 24 hours">{hours.map((h,i)=>{const size=h.requests?Math.round(40+60*h.requests/peak):0;return <i key={h.hour} className={i===23?'now':''} title={`${new Date(h.hour).getHours().toString().padStart(2,'0')}:00 · ${h.requests} requests${h.errors?`, ${h.errors} failed`:''}`}>{size?<b className={h.errors?'bad':''} style={{width:size+'%',height:size+'%'}}/>:null}</i>;})}</div>
      <div className="punch-hours" aria-hidden="true">{hours.map((h,i)=><span key={h.hour}>{i%6===0?new Date(h.hour).getHours().toString().padStart(2,'0'):''}</span>)}</div>
      <div className="pass-facts"><span>Last answer <b>{last?time(last.time):'—'}</b></span><span>Average <b>{ms(s.latency)}</b></span><span>Answered <b>{total?`${Math.round((s.success||0)/total*100)}%`:'—'}</b></span></div>
    </div>
    <div className="pass-stub">
      <div><strong className="pass-count">{count(metrics,r).toLocaleString()}</strong><span>requests in 24 h</span></div>
      <div><span>{info?.label||'Not tested'}</span><strong className="pass-state">{info?.detail||(r.latency?ms(r.latency):'—')}</strong></div>
    </div>
    {usedUp(r)&&<Stamp until={r.exhaustedUntil!} refused={r.status?.startsWith('Refused')}/>}
  </article>;
}

export function NextInLine({data}:{data:Snapshot}){
  const list=data.backup||[];let n=0;
  return <section className="next-line"><h2>Next in line</h2>
    {data.settings.exhaustedFailover===false?<p className="subtle">Switching exits is off, so a used-up exit returns its error with the reset time.</p>:
    list.length?<ol>{list.map(b=>{const r=data.settings.routes.find(x=>x.id===b.id);const out=usedUp(r);const off=!b.usable&&!out;return <li key={b.id} className={out?'out':off?'off':''}>
      <span className="line-n">{b.usable?++n:'–'}</span><strong>{b.name}</strong>
      <span className={`line-state ${b.usable?'green':out?'stamp-ink':'muted'}`}>{b.usable?'Ready':out?`Back in ${left(r!.exhaustedUntil!)}`:'Skipped'}</span>
      <small>{b.usable?b.why:out?`Valid again at ${utc(r!.exhaustedUntil!)}`:sentence(b.why)}</small>
      {out&&<Timebar until={r!.exhaustedUntil!}/>}
    </li>;})}</ol>:<p className="subtle">No backup exit yet. Add a relay, WARP or the proxy pool on Routing.</p>}
  </section>;
}

export function ExitTickets({data,metrics,onManage}:{data:Snapshot;metrics?:Metrics|null;onManage:()=>void}){
  const others=data.settings.routes.filter(r=>r.id!==data.settings.routeId);
  if(!others.length)return null;
  return <section className="exit-tickets"><div className="section-top"><h2>Other exits</h2><button className="text-button" onClick={onManage}>Manage routes</button></div>
    <div className="tickets">{others.map((r,i)=>{const info=data.routeInfo?.[r.id];const out=usedUp(r);return <div key={r.id} className={`ticket ${out?'used':''} ${!r.enabled?'off':''}`} style={{'--stock':`var(--stock-${i%3+1})`} as CSSProperties}>
      <strong className="ticket-name">{r.name}</strong>
      <span className="ticket-where">{!r.enabled?'Switched off':info?.label||kind(r)}{info?.detail&&r.enabled&&!out?` · ${info.detail}`:''}</span>
      <span className="ticket-count">{count(metrics,r).toLocaleString()}<small>in 24 h</small></span>
      {out&&<Stamp until={r.exhaustedUntil!} refused={r.status?.startsWith('Refused')}/>}
    </div>;})}</div></section>;
}
