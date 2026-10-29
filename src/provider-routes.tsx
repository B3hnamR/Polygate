import {useState} from 'react';
import {ArrowDown,ArrowUp,Network} from 'lucide-react';
import {Dialog} from './mcp';
import {Badge,Button,type Snapshot} from './ui';
import {usedUp} from './daypass';
import type {Provider,ProviderRoutes,Route} from '../backend/types';

// What a provider is allowed to use. No list means it follows the route in use; the old single route reads as a list of one, as the gateway reads it.
export const routesOf=(p:Provider):ProviderRoutes|undefined=>p.routes?.ids?.length?p.routes:p.routeId?{ids:[p.routeId],backups:p.kind==='free'}:undefined;
const takesRelay=(p:Provider)=>p.kind==='free'||p.kind==='kilo';
const names=(ids:string[],routes:Route[])=>ids.map(id=>routes.find(r=>r.id===id)?.name||'a deleted route');

// The line under a provider on the Providers page.
export function providerRouteText(p:Provider,data:Snapshot){
  const set=routesOf(p);const routes=data.settings.routes;
  if(!set){const now=routes.find(r=>r.id===data.settings.routeId);return `Follows the route in use${now?` (${now.name})`:''}`;}
  const list=names(set.ids,routes);
  if(list.length===1)return `Only ${list[0]}`;
  return `Only ${list.join(set.spread?', ':', then ')}${set.spread?' (spread over them)':' (in order)'}`;
}

// The line on a route's ticket on the Routing page: which providers are allowed to use it.
export function usedByText(r:Route,data:Snapshot){
  const using=data.settings.providers.filter(p=>p.enabled).flatMap(p=>{const set=routesOf(p);return set?(set.ids.includes(r.id)?[p.name+(set.ids.length===1?' (only)':'')]:[]):(data.settings.routeId===r.id?[p.name]:[]);});
  return using.length?`Used by ${using.join(', ')}`:'';
}

export function ProviderRoutesDialog({provider:p,data,onClose,onSave}:{provider:Provider;data:Snapshot;onClose:()=>void;onSave:(routes:ProviderRoutes|null)=>Promise<boolean>}){
  const start=routesOf(p);const all=data.settings.routes;
  const [mode,setMode]=useState<'follow'|'only'>(start?'only':'follow');
  const [ids,setIds]=useState<string[]>(start?.ids.filter(id=>all.some(r=>r.id===id))||[]);
  const [spread,setSpread]=useState(!!start?.spread);const [backups,setBackups]=useState(!!start?.backups);
  const [busy,setBusy]=useState(false);
  const refuse=(r:Route)=>r.kind==='relay'&&!takesRelay(p)?'Relays only carry OpenCode and Kilo traffic':'';
  const move=(i:number,by:number)=>setIds(l=>{const n=l.slice();const j=i+by;if(j<0||j>=n.length)return l;[n[i],n[j]]=[n[j],n[i]];return n;});
  const toggle=(id:string,on:boolean)=>setIds(l=>on?[...l,id]:l.filter(x=>x!==id));
  const row=(r:Route,i:number)=>{
    const chosen=ids.includes(r.id);const why=refuse(r);const info=data.routeInfo?.[r.id];const out=usedUp(r)&&(p.kind==='free');
    return <div key={r.id} className={`route-pick ${chosen?'on':''}`}>
      <label><input type="checkbox" checked={chosen} disabled={!!why} onChange={e=>toggle(r.id,e.target.checked)}/><span><strong>{r.name}</strong><small>{why||(!r.enabled?'Switched off. It must be on for requests to use it.':r.id==='proxy-pool'&&!takesRelay(p)?'Public proxies. Your key and prompts go through them.':r.kind==='direct'?'Your own network connection':r.kind==='warp'?'Cloudflare WARP on this computer':r.kind==='relay'?'Edge relay':'Proxy')}</small></span></label>
      {!why&&(out?<Badge state="cooldown">Used up</Badge>:info?<Badge state={info.tone as any}>{info.label}</Badge>:null)}
      {chosen&&ids.length>1&&<span className="route-order"><button type="button" className="icon-button" aria-label={`Move ${r.name} up`} disabled={i===0} onClick={()=>move(i,-1)}><ArrowUp size={15}/></button><button type="button" className="icon-button" aria-label={`Move ${r.name} down`} disabled={i===ids.length-1} onClick={()=>move(i,1)}><ArrowDown size={15}/></button></span>}
    </div>;
  };
  const chosenRows=ids.map(id=>all.find(r=>r.id===id)).filter((r):r is Route=>!!r);
  const rest=all.filter(r=>!ids.includes(r.id));
  const summary=mode==='follow'?`${p.name} uses whichever route is in use, and the failover and rotation switches on the Routing page apply to it.`
    :!ids.length?'Choose at least one route.'
    :ids.length===1?`${p.name} only ever leaves through ${chosenRows[0].name}. If that cannot take a request, the request fails with the reason instead of going anywhere else.`
    :spread?`${p.name} takes turns over ${chosenRows.map(r=>r.name).join(', ')}, and never leaves through any other route.`
    :`${p.name} uses ${chosenRows[0].name}; if that fails it moves to ${chosenRows.slice(1).map(r=>r.name).join(', then ')}. It never leaves through any other route.`;
  const save=async()=>{setBusy(true);try{if(await onSave(mode==='follow'?null:{ids,spread:ids.length>1&&spread,backups:p.kind==='free'&&backups}))onClose();}finally{setBusy(false);}};
  return <Dialog title={`Routes for ${p.name}`} icon={<Network size={18}/>} onClose={onClose} busy={busy} wide>
    <div className="route-mode" role="radiogroup" aria-label="Which routes">
      <label><input type="radio" name="route-mode" checked={mode==='follow'} onChange={()=>setMode('follow')}/><span><strong>Follow the route in use</strong><small>Whatever you select on the Routing page, with its failover and rotation.</small></span></label>
      <label><input type="radio" name="route-mode" checked={mode==='only'} onChange={()=>setMode('only')}/><span><strong>Only these routes</strong><small>Strict. This provider never leaves through a route you did not tick.</small></span></label>
    </div>
    {mode==='only'&&<>
      <div className="route-picks">{chosenRows.map((r,i)=>row(r,i))}{rest.map(r=>row(r,-1))}</div>
      {ids.length>1&&<div className="route-mode" role="radiogroup" aria-label="How to use them">
        <label><input type="radio" name="route-spread" checked={!spread} onChange={()=>setSpread(false)}/><span><strong>In order</strong><small>The first one, and the next only when a connection fails.</small></span></label>
        <label><input type="radio" name="route-spread" checked={spread} onChange={()=>setSpread(true)}/><span><strong>Spread requests</strong><small>Take turns over all of them.</small></span></label>
      </div>}
      {p.kind==='free'&&<label className="route-check"><input type="checkbox" checked={backups} onChange={e=>setBackups(e.target.checked)}/><span><strong>Also use the backup exits when all of these are used up</strong><small>OpenCode Free only. The backup exits are the ones listed under Next in line on the Routing page.</small></span></label>}
    </>}
    <p className="route-summary">{summary}</p>
    <div className="dialog-actions"><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" disabled={busy||(mode==='only'&&!ids.length)} onClick={save}>Save routes</Button></div>
  </Dialog>;
}
