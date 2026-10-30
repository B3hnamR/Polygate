import {useEffect,useState,type ReactNode} from 'react';
import {Check,RefreshCw,Trash2,TriangleAlert,X} from 'lucide-react';
import {api} from './api';
import {Button,Field,usePoll,compact} from './ui';
import type {Route,Settings} from '../backend/types';
// Looking after relays Polygate deployed: update one to the current relay code, remove one from its platform, and see how each has done lately.
// A platform token is used for the one call; a token the user chose to remember stays in the gateway and is never sent back to this page.
type Platform='vercel'|'netlify'|'cloudflare';
const LABEL:Record<Platform,string>={vercel:'Vercel',netlify:'Netlify',cloudflare:'Cloudflare'};
const KIND:Record<Platform,string>={vercel:'project',netlify:'site',cloudflare:'Worker'};
// Mirrors the gateway: a relay Polygate deployed carries what its platform calls it; older ones are recognised by their name.
const NAMED=/^(Vercel|Netlify|Cloudflare) relay(?: [a-z]{3}\d)? \(([a-z0-9][a-z0-9-]*)\)$/;
export function platformOf(route:Route):Platform|null{
  if(route.kind!=='relay')return null;if(route.deployed)return route.deployed.platform;
  const m=NAMED.exec(route.name);return m?m[1].toLowerCase() as Platform:null;
}
// What the platform calls it: shown before anything is changed or deleted there, so it is clear which project is meant.
const platformName=(route:Route)=>route.deployed?.name||NAMED.exec(route.name)?.[2]||'';
function Shell({title,onClose,busy,children}:{title:string;onClose:()=>void;busy:boolean;children:ReactNode}){
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!busy&&!e.defaultPrevented)onClose();};document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);},[busy,onClose]);
  return <div className="dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)onClose();}}><div className="dialog" role="dialog" aria-modal="true" aria-label={title}><header className="dialog-head"><h2>{title}</h2><span className="toolbar-spacer"/><button type="button" className="icon-button" aria-label="Close" disabled={busy} onClick={onClose}><X size={16}/></button></header>{children}</div></div>;
}
// The token part of both dialogs: the saved token when there is one, otherwise a field with a Remember box (and the Account ID for Cloudflare).
function useToken(platform:Platform,settings:Settings){
  const saved=!!settings.deployTokens?.[platform];const savedAccount=!!settings.deployAccounts?.cloudflare;
  const [token,setToken]=useState('');const [account,setAccount]=useState('');const [remember,setRemember]=useState(false);const [another,setAnother]=useState(false);
  const usingSaved=saved&&!another;const needsAccount=platform==='cloudflare'&&!(usingSaved&&savedAccount);
  const ready=(usingSaved||token.trim().length>7)&&(!needsAccount||/^[a-fA-F0-9]{32}$/.test(account.trim()));
  const credentials=()=>usingSaved?{useSaved:true,...(needsAccount?{accountId:account.trim()}:{})}:{token:token.trim(),remember,...(platform==='cloudflare'?{accountId:account.trim()}:{})};
  const fields=<>
    {usingSaved?<div className="dialog-note good saved-token"><Check size={16}/><div><p><strong>Using your saved {LABEL[platform]} token.</strong> It is kept encrypted on this computer and is not shown again.</p><div className="token-row"><Button onClick={()=>setAnother(true)}>Use another token</Button></div></div></div>
    :<><Field label={`${LABEL[platform]} API token`} hint="The token of the account the relay was deployed to."><input autoFocus type="password" autoComplete="new-password" value={token} onChange={e=>setToken(e.target.value)} spellCheck={false}/></Field>
      <div className="check-row"><input id={`remember-${platform}`} type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)}/><label htmlFor={`remember-${platform}`}>Remember this token on this computer<small>Saved encrypted with your other settings.</small></label></div>
      {saved&&<div className="token-row"><Button onClick={()=>setAnother(false)}>Use the saved token instead</Button></div>}</>}
    {needsAccount&&<Field label="Account ID" hint="32 letters and digits. Shown in the Cloudflare dashboard under Workers & Pages."><input value={account} onChange={e=>setAccount(e.target.value)} placeholder="0123456789abcdef0123456789abcdef" spellCheck={false} autoComplete="off"/></Field>}
  </>;
  return {fields,ready,credentials};
}
export function RelayUpdateDialog({route,settings,onClose,onDone,notice}:{route:Route;settings:Settings;onClose:()=>void;onDone:()=>void;notice:(s:string)=>void}){
  const platform=platformOf(route)!;const t=useToken(platform,settings);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  async function run(){setBusy(true);setError('');try{const r=await api('/admin/relays/update',{id:route.id,...t.credentials()});notice(r.reachable?`${route.name} updated`:`${route.name} updated, not answering yet`);onDone();onClose();}catch(e:any){setError(e.message||'The update failed');}finally{setBusy(false);}}
  return <Shell title="Update relay" onClose={onClose} busy={busy}><form className="dialog-body" autoComplete="off" onSubmit={e=>{e.preventDefault();if(t.ready&&!busy)void run();}}>
    <p className="subtle">Deploys the current relay code to the {KIND[platform]} <strong>{platformName(route)}</strong> on {LABEL[platform]} again. Its address and access token stay the same, so nothing else needs changing. Use this after a Polygate update that changes the relay.</p>
    {t.fields}
    {error&&<div className="dialog-note error" role="alert"><TriangleAlert size={16}/><p>{error}</p></div>}
    <div className="dialog-actions"><Button variant="primary" type="submit" disabled={!t.ready||busy}><RefreshCw size={14}/>{busy?'Updating…':'Update relay'}</Button><Button disabled={busy} onClick={onClose}>Cancel</Button></div>
  </form></Shell>;
}
export function RelayRemoveDialog({route,settings,onClose,onDone,notice}:{route:Route;settings:Settings;onClose:()=>void;onDone:()=>void;notice:(s:string)=>void}){
  const platform=platformOf(route)!;const t=useToken(platform,settings);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [both,setBoth]=useState(true);
  async function run(){
    setBusy(true);setError('');
    try{if(both)await api('/admin/relays/remove',{id:route.id,...t.credentials()});else await api('/admin/routes/delete',{id:route.id});notice(both?`${route.name} removed from ${LABEL[platform]} and from Polygate`:'Route removed');onDone();onClose();}
    catch(e:any){setError(e.message||'Could not remove the relay');}finally{setBusy(false);}
  }
  return <Shell title="Delete relay" onClose={onClose} busy={busy}><form className="dialog-body" autoComplete="off" onSubmit={e=>{e.preventDefault();if((!both||t.ready)&&!busy)void run();}}>
    <p className="subtle">Delete <strong>{route.name}</strong>? Requests can no longer use it.</p>
    <div className="check-row"><input id="remove-both" type="checkbox" checked={both} onChange={e=>setBoth(e.target.checked)}/><label htmlFor="remove-both">Also delete the {KIND[platform]} <strong>{platformName(route)}</strong> from {LABEL[platform]}<small>This deletes that whole {KIND[platform]}, so check the name is the relay's own. Otherwise it keeps running on your {LABEL[platform]} account and counts toward its limits.</small></label></div>
    {both&&t.fields}
    {error&&<div className="dialog-note error" role="alert"><TriangleAlert size={16}/><p>{error}</p></div>}
    <div className="dialog-actions"><Button variant="primary" type="submit" disabled={(both&&!t.ready)||busy}><Trash2 size={14}/>{busy?'Deleting…':'Delete relay'}</Button><Button disabled={busy} onClick={onClose}>Cancel</Button></div>
  </form></Shell>;
}
type Report={days:number;relays:{id:string;name:string;region:string;platform:string;enabled:boolean;ok:number;refused:number;usedUp:number;redirected:number;failed:number;activeDays:number;tone:'good'|'warn'|'bad'|'neutral';advice:string}[]};
// One row per relay: what came back through it lately. A relay that has never worked is flagged, with a button to remove it and deploy another region.
export function RelayResults({onRemove,routes}:{onRemove:(r:Route)=>void;routes:Route[]}){
  const [days,setDays]=useState(7);const {data}=usePoll<Report>(`/admin/relays/report?days=${days}`,15000);
  if(!data||!data.relays.length)return null;
  return <section className="section-block relay-results"><div className="section-top"><div><h2>How your relays have done</h2><p className="subtle">What came back through each relay. <em>Refused</em> means OpenCode Free would not serve chat from that address, <em>redirected</em> that the site sent the request elsewhere, <em>failed</em> that the relay could not be reached.</p></div>
    <div className="usage-range" role="group" aria-label="Range">{[7,30].map(n=><Button key={n} variant={n===days?'primary':''} onClick={()=>setDays(n)}>{n} days</Button>)}</div></div>
    <div className="table-wrap"><table><thead><tr><th>Relay</th><th>Region</th><th className="numeric">Worked</th><th className="numeric">Refused</th><th className="numeric">Redirected</th><th className="numeric">Failed</th><th className="numeric">Used up</th></tr></thead>
      <tbody>{data.relays.map(r=>{const route=routes.find(x=>x.id===r.id);return <tr key={r.id}><td className="relay-main"><div className="relay-cell"><strong className="truncate" title={r.name}>{r.name}</strong><span className={`verdict ${r.tone}`}>{r.advice}{r.tone==='bad'&&route&&platformOf(route)&&<> <Button onClick={()=>onRemove(route)}>Remove…</Button></>}</span></div></td><td>{r.region||'—'}</td><td className="numeric">{compact(r.ok)}</td><td className="numeric">{r.refused?<span className="amber">{r.refused}</span>:0}</td><td className="numeric">{r.redirected?<span className="amber">{r.redirected}</span>:0}</td><td className="numeric">{r.failed?<span className="red">{r.failed}</span>:0}</td><td className="numeric">{r.usedUp}</td></tr>;})}</tbody></table></div></section>;
}
