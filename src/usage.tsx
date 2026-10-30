import {useState} from 'react';
import {Button,usePoll,compact,ms} from './ui';
// Usage over time. The request log keeps a week; the daily summary behind this page keeps 400 days (days are UTC days).
type Group={name:string;requests:number;errors:number;tokens:number;avgMs:number;daily:number[]};
type Usage={days:number;daily:{day:number;requests:number;errors:number;input:number;output:number}[];models:Group[];routes:Group[];totals:{requests:number;errors:number;input:number;output:number;activeDays:number;busiestDay:number;busiestRequests:number}};
const RANGES=[[7,'7 days'],[30,'30 days'],[90,'90 days'],[365,'1 year']] as const;
const date=(t:number,long=false)=>new Date(t).toLocaleDateString([],long?{weekday:'short',day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}:{day:'numeric',month:'short',timeZone:'UTC'});
const Spark=({values}:{values:number[]})=>{const peak=Math.max(1,...values);const w=96,h=22;const step=values.length>1?w/(values.length-1):w;
  return <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true"><polyline fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" points={values.map((v,i)=>`${(i*step).toFixed(1)},${(h-2-(v/peak)*(h-4)).toFixed(1)}`).join(' ')}/></svg>;};
export function UsagePage(){
  const [days,setDays]=useState<number>(30);const [by,setBy]=useState<'models'|'routes'>('models');const [metric,setMetric]=useState<'requests'|'tokens'>('requests');
  const {data,error}=usePoll<Usage>(`/admin/usage?days=${days}`,30000);
  if(!data)return <section className="section-block"><p className="muted" style={{padding:'18px'}}>{error||'Loading…'}</p></section>;
  const value=(d:Usage['daily'][number])=>metric==='requests'?d.requests:d.input+d.output;const peak=Math.max(1,...data.daily.map(value));const t=data.totals;
  const rows=data[by];const top=Math.max(1,...rows.map(r=>r.requests));
  return <div className="usage-page">
    <section className="section-block"><div className="section-top"><div><h2>Usage over time</h2><p className="subtle">One bar per day. Days are counted in UTC, and the summary is kept for 400 days even though the request log keeps only a week.</p></div>
      <div className="usage-controls"><div className="usage-range" role="group" aria-label="Range">{RANGES.map(([n,l])=><Button key={n} variant={n===days?'primary':''} onClick={()=>setDays(n)}>{l}</Button>)}</div></div></div>
      <div className="metric-line"><div><span>Requests</span><strong>{compact(t.requests)}</strong></div><div><span>Failed</span><strong>{compact(t.errors)}</strong></div><div><span>Tokens</span><strong>{compact(t.input+t.output)}</strong></div><div><span>Active days</span><strong>{t.activeDays} of {data.days}</strong></div><div><span>Busiest day</span><strong>{t.busiestDay?date(t.busiestDay):'—'}</strong><small>{t.busiestDay?`${t.busiestRequests} requests`:''}</small></div></div>
      <div className="usage-chart-head"><div className="usage-range" role="group" aria-label="Chart shows">{(['requests','tokens'] as const).map(m=><Button key={m} variant={m===metric?'primary':''} onClick={()=>setMetric(m)}>{m==='requests'?'Requests':'Tokens'}</Button>)}</div><span className="subtle">Tallest day: {compact(peak===1&&!t.requests?0:peak)} {metric}</span></div>
      {t.requests?<><div className="hour-bars usage-bars" style={{gap:data.days>=180?0:data.days>=60?1:2}} role="img" aria-label={`${metric} per day over the last ${data.days} days`}>{data.daily.map(d=><div key={d.day} title={`${date(d.day,true)} · ${d.requests} requests, ${d.errors} failed, ${compact(d.input+d.output)} tokens`}><i className={d.errors&&d.errors*2>=d.requests?'bad':''} style={{height:value(d)?Math.max(3,value(d)/peak*100)+'%':'0'}}/></div>)}</div>
        <div className="usage-axis"><span>{date(data.daily[0].day)}</span><span>{date(data.daily[Math.floor(data.daily.length/2)].day)}</span><span>{date(data.daily[data.daily.length-1].day)}</span></div></>
      :<p className="muted" style={{padding:'6px 21px 20px'}}>No requests in this range yet.</p>}
    </section>
    <section className="section-block"><div className="section-top"><div><h2>Where it went</h2><p className="subtle">The ten busiest in this range. The line is that one's requests per day.</p></div>
      <div className="usage-range" role="group" aria-label="Group by">{(['models','routes'] as const).map(g=><Button key={g} variant={g===by?'primary':''} onClick={()=>setBy(g)}>{g==='models'?'Models':'Routes'}</Button>)}</div></div>
      {rows.length?<div className="table-wrap"><table><thead><tr><th>{by==='models'?'Model':'Route'}</th><th className="numeric">Requests</th><th>Share</th><th className="numeric">Tokens</th><th className="numeric">Failed</th><th className="numeric">Average</th><th>Per day</th></tr></thead>
        <tbody>{rows.map(r=><tr key={r.name}><td className="truncate" title={r.name}>{r.name}</td><td className="numeric">{r.requests.toLocaleString()}</td><td><span className="share-bar"><i style={{width:Math.max(2,r.requests/top*100)+'%'}}/></span></td><td className="numeric">{compact(r.tokens)}</td><td className="numeric">{r.errors?<span className="red">{r.errors}</span>:<span className="muted">0</span>}</td><td className="numeric mono">{ms(r.avgMs)}</td><td className="usage-spark"><Spark values={r.daily}/></td></tr>)}</tbody></table></div>
      :<p className="muted" style={{padding:'6px 21px 20px'}}>Nothing to show yet.</p>}
    </section>
  </div>;
}
