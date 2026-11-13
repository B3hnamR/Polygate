import {useState} from 'react';
import {ArrowDown,ArrowUp,Network,Pause,Play} from 'lucide-react';
import {Dialog} from './mcp';
import {Badge,Button,Select,type Snapshot} from './ui';
import {usedUp} from './daypass';
import type {Provider,ProviderRoutes,Route} from '../backend/types';

// What a provider is allowed to use. No list means it follows the route in use; the old single route reads as a list of one, as the gateway reads it.
export const routesOf=(p:Provider):ProviderRoutes|undefined=>p.routes?.ids?.length?p.routes:p.routeId?{ids:[p.routeId],backups:p.kind==='free'}:undefined;
const takesRelay=(p:Provider)=>p.kind==='free'||p.kind==='kilo';
const names=(ids:string[],routes:Route[])=>ids.map(id=>routes.find(r=>r.id===id)?.name||'a deleted route');

// A relay marked `only` (the Cloudflare Worker) is refused by OpenCode, so it does not carry OpenCode providers.
export const ZAI_EXITS='Z.ai keeps one steady address, so it can use Direct or a proxy of your own, not a relay, the proxy pool or WARP.';
export const steadyExit=(r:Route)=>r.kind==='direct'||(r.kind==='proxy'&&r.id!=='proxy-pool'&&!r.poolUrls?.length);
export const routeRefusal=(p:Provider,r:Route)=>p.kind==='zai'?(steadyExit(r)?'':ZAI_EXITS):r.only&&r.only!==p.kind&&!(r.only==='kilo'&&p.kind==='openai')?'This relay cannot carry OpenCode':'';

// The line under a provider on the Providers page.
export function providerRouteText(p:Provider,data:Snapshot){
  const set=routesOf(p);const routes=data.settings.routes;
  if(p.kind==='zai'&&!set)return 'Direct connection';
  if(!set){const now=routes.find(r=>r.id===data.settings.routeId);return `Follows the route in use${now?` (${now.name})`:''}`;}
  const paused=set.paused||[];const active=set.ids.filter(id=>!paused.includes(id));
  if(!active.length)return 'Every route is paused';
  const list=names(active,routes);const note=paused.length?` (${paused.length} paused)`:'';
  if(list.length===1)return `Only ${list[0]}${note}`;
  return `Only ${list.join(set.spread?', ':', then ')}${set.spread?' (spread over them)':' (in order)'}${note}`;
}

// The line on a route's ticket on the Routing page: which providers are allowed to use it.
export function usedByText(r:Route,data:Snapshot){
  const using=data.settings.providers.filter(p=>p.enabled).flatMap(p=>{const set=routesOf(p);if(p.kind==='zai'){const id=set?.ids[0]||'direct';return id===r.id&&!set?.paused?.includes(id)?[p.name]:[];}return set?(set.ids.includes(r.id)&&!set.paused?.includes(r.id)?[p.name+(set.ids.length===1?' (only)':'')]:[]):(data.settings.routeId===r.id?[p.name]:[]);});
  return using.length?`Used by ${using.join(', ')}`:'';
}

// Z.ai's route: one exit from a short list, so a dropdown says all of it.
export function ZaiRoutePick({p,data,act}:{p:Provider;data:Snapshot;act:Function}){
  const choices=data.settings.routes.filter(r=>steadyExit(r));const now=routesOf(p)?.ids[0]||'direct';
  return <div className="provider-route zai-route"><span>Route:</span><Select aria-label="Route for Z.ai" value={now} onChange={v=>act('provider','/admin/providers',{...p,routes:v==='direct'?null:{ids:[v]}},v==='direct'?'Z.ai now uses Direct':'Z.ai now uses that proxy')}>{choices.map(r=><option key={r.id} value={r.id}>{r.name}{r.enabled?'':' (off)'}</option>)}</Select><small className="muted">{choices.length>1?'A proxy sees your Z.ai token and prompts.':'Add a proxy of your own on Routing to choose it here.'} Relays, the proxy pool and WARP change address, so they are not offered.</small></div>;
}

export function ProviderRoutesDialog({provider:p,data,onClose,onSave}:{provider:Provider;data:Snapshot;onClose:()=>void;onSave:(routes:ProviderRoutes|null)=>Promise<boolean>}){
  const start=routesOf(p);const all=data.settings.routes;
  const [mode,setMode]=useState<'follow'|'only'>(start?'only':'follow');
  const [ids,setIds]=useState<string[]>(start?.ids.filter(id=>all.some(r=>r.id===id))||[]);
  // A new list for OpenCode Free or Kilo starts with the backup exits allowed, so a used-up exit hands over, as it does without a list.
  const [spread,setSpread]=useState(!!start?.spread);const [backups,setBackups]=useState(start?!!start.backups:takesRelay(p));
  const [busy,setBusy]=useState(false);
  // A relay reaches any public HTTPS host; the Cloudflare Worker (marked only) is refused by OpenCode, so it does not carry OpenCode providers.
  const refuse=(r:Route)=>routeRefusal(p,r);
  const [paused,setPaused]=useState<string[]>(start?.paused||[]);
  const move=(i:number,by:number)=>setIds(l=>{const n=l.slice();const j=i+by;if(j<0||j>=n.length)return l;[n[i],n[j]]=[n[j],n[i]];return n;});
  const toggle=(id:string,on:boolean)=>setIds(l=>on?[...l,id]:l.filter(x=>x!==id));
  const row=(r:Route,i:number)=>{
    const chosen=ids.includes(r.id);const why=refuse(r);const info=data.routeInfo?.[r.id];const out=usedUp(r)&&(p.kind==='free');
    return <div key={r.id} className={`route-pick ${chosen?'on':''}`}>
      <label><input type="checkbox" checked={chosen} disabled={!!why} onChange={e=>toggle(r.id,e.target.checked)}/><span><strong>{r.name}</strong><small>{why||(!r.enabled?'Switched off. It must be on for requests to use it.':r.id==='proxy-pool'&&!takesRelay(p)?'Public proxies. Your key and prompts go through them.':r.kind==='direct'?'Your own network connection':r.kind==='warp'?'Cloudflare WARP on this computer':r.kind==='relay'?'Edge relay':'Proxy')}</small></span></label>
      {!why&&(chosen&&paused.includes(r.id)?<Badge state="neutral">Paused</Badge>:out?<Badge state="cooldown">Used up</Badge>:info?<Badge state={info.tone as any}>{info.label}</Badge>:null)}
      {chosen&&<button type="button" className="icon-button" aria-label={`${paused.includes(r.id)?'Resume':'Pause'} ${r.name}`} title={paused.includes(r.id)?'Resume this route':'Pause this route: it keeps its place but is not used'} onClick={()=>setPaused(l=>l.includes(r.id)?l.filter(x=>x!==r.id):[...l,r.id])}>{paused.includes(r.id)?<Play size={15}/>:<Pause size={15}/>}</button>}
      {chosen&&ids.length>1&&<span className="route-order"><button type="button" className="icon-button" aria-label={`Move ${r.name} up`} disabled={i===0} onClick={()=>move(i,-1)}><ArrowUp size={15}/></button><button type="button" className="icon-button" aria-label={`Move ${r.name} down`} disabled={i===ids.length-1} onClick={()=>move(i,1)}><ArrowDown size={15}/></button></span>}
    </div>;
  };
  const chosenRows=ids.map(id=>all.find(r=>r.id===id)).filter((r):r is Route=>!!r);
  const rest=all.filter(r=>!ids.includes(r.id));
  const summary=mode==='follow'?`${p.name} uses whichever route is in use, and the failover and rotation switches on the Routing page apply to it.`
    :!ids.length?'Choose at least one route.'
    :ids.length===1?`${p.name} only ever leaves through ${chosenRows[0].name}${takesRelay(p)&&backups?', and the backup exits once it is used up':''}. If ${takesRelay(p)&&backups?'none of them':'that'} can take a request, the request fails with the reason instead of going anywhere else.`
    :spread?`${p.name} takes turns over ${chosenRows.map(r=>r.name).join(', ')}, and never leaves through any other route.`
    :`${p.name} uses ${chosenRows[0].name}; if that fails it moves to ${chosenRows.slice(1).map(r=>r.name).join(', then ')}. It never leaves through any other route.`;
  const save=async()=>{setBusy(true);try{if(await onSave(mode==='follow'?null:{ids,spread:ids.length>1&&spread,backups:takesRelay(p)&&backups,paused:paused.filter(id=>ids.includes(id))}))onClose();}finally{setBusy(false);}};
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
      {takesRelay(p)&&<label className="route-check"><input type="checkbox" checked={backups} onChange={e=>setBackups(e.target.checked)}/><span><strong>Also use the backup exits when all of these are used up</strong><small>OpenCode Free and Kilo. Without it, a used-up exit here fails the request. The backup exits are the ones listed under Next in line on the Routing page.</small></span></label>}
    </>}
    <p className="route-summary">{summary}</p>
    <div className="dialog-actions"><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" disabled={busy||(mode==='only'&&!ids.length)} onClick={save}>Save routes</Button></div>
  </Dialog>;
}
