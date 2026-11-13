import {Clock3,Globe} from 'lucide-react';
import type {ReactNode} from 'react';
import {Button,Field,Select,Toggle,type Snapshot} from './ui';
import {usedUp} from './daypass';
import {routesOf} from './provider-routes';
import type {Provider} from '../backend/types';

// The routing switches, shown in the list view and in the map's panel: the same component, so both views always show the same settings.
// `act` is the page's action helper: it shows the success text or the error, refreshes, and resolves to whether it worked.
type Act=(name:string,path:string,body?:unknown,success?:string)=>Promise<boolean>;
type Props={data:Snapshot;act:Function;go?:(page:any)=>void;compact?:boolean};
type Own='never'|'selected'|'last'|'spread';
const STRATEGY:Record<string,string>={round_robin:'taking turns',random:'at random',fastest:'by fastest answer'};

// Which of the four ways this computer's own address (the Direct route) may be used. Stored as the Direct route's switch plus two settings.
export function ownAddress(s:Snapshot['settings']):Own{
  const direct=s.routes.find(r=>r.kind==='direct');
  if(!direct?.enabled)return 'never';
  if(s.rotate&&s.spreadDirect===true)return 'spread';
  return s.allowDirect===true?'last':'selected';
}

function Group({title,area,children,more}:{title:string;area:string;children:ReactNode;more?:ReactNode}){
  return <section className={`policy-group ${area}`}><h3 className="policy-head">{title}</h3>{children}{more&&<details className="policy-more"><summary>How this works</summary><div>{more}</div></details>}</section>;
}

export function ExitPolicy({data,act:run,go,compact=false}:Props){const act=run as Act;
  const s=data.settings;const own=ownAddress(s);
  const direct=s.routes.find(r=>r.kind==='direct');
  const hasPool=s.routes.some(r=>r.id==='proxy-pool');const relays=s.routes.filter(r=>r.kind==='relay');
  const current=s.routes.find(r=>r.id===s.routeId);const spread=data.spread||[];
  const ready=(data.backup||[]).filter(b=>b.usable);
  // OpenCode Free and Kilo providers with a strict route list of their own: that list wins over this policy, so without the backup exits a used-up
  // exit in it fails the request instead of moving on. Said here, next to the switch it overrides, with the one-click way out.
  const pinned=s.providers.filter(p=>p.enabled&&(p.kind==='free'||p.kind==='kilo')).flatMap(p=>{const set=routesOf(p);return set&&!set.backups?[{p,set}]:[];});
  const letMoveOn=(p:Provider,set:NonNullable<ReturnType<typeof routesOf>>)=>act('provider','/admin/providers',{...p,routes:{...set,backups:true}},`${p.name} now moves on to the backup exits when its own routes are used up`);
  const recheck=relays.filter(r=>r.recheckedAt&&usedUp(r)).sort((a,b)=>b.recheckedAt!-a.recheckedAt!)[0];
  const setOwn=async(v:Own)=>{
    if(v===own)return;
    if(v==='never'){await act('own','/admin/routes/toggle',{id:'direct',enabled:false},'Requests never leave from your own address');return;}
    if(direct&&!direct.enabled&&!await act('own','/admin/routes/toggle',{id:'direct',enabled:true},''))return;
    await act('own','/admin/settings',{allowDirect:v!=='selected',spreadDirect:v==='spread'},v==='selected'?'Your own address is used only when it is the exit in use':v==='last'?'Your own address is the last resort':'Your own address is part of the spread');
  };
  const choices:{v:Own;label:string;detail:string}[]=[
    {v:'never',label:'Never',detail:'Nothing leaves from this computer\'s address, not even a model list. Needs another exit to be on.'},
    {v:'selected',label:'Only when it is the exit in use',detail:'Not used as a backup or in the spread. The default.'},
    {v:'last',label:'As the last resort',detail:'Used when every other exit is used up or cannot connect.'},
    ...(s.rotate?[{v:'spread' as Own,label:'In the spread',detail:'Takes its turn like any other exit, and stays the last resort.'}]:[]),
  ];
  return <div className={`policy exit-policy${compact?' compact':''}`}>
    {!compact&&<dl className="policy-summary" aria-label="Routing in short">
      <div><dt>Exit</dt><dd>{s.rotate?<>Taking turns over <b>{spread.length} exit{spread.length===1?'':'s'}</b>, {STRATEGY[s.strategy]||STRATEGY.round_robin}</>:current?<b>{current.name}</b>:'None selected'}</dd></div>
      <div><dt>Used up</dt><dd>{s.exhaustedFailover===false?'The request fails with the reset time':ready.length?<>Moves on to {ready.slice(0,3).map((b,i)=><span key={b.id}>{i>0&&' → '}<b>{b.name}</b></span>)}{ready.length>3&&` and ${ready.length-3} more`}</>:<span className="amber">No backup exit is ready</span>}{s.exhaustedFailover!==false&&pinned.length>0&&<span className="amber"> · not for {pinned.map(x=>x.p.name).join(', ')} (own route list)</span>}</dd></div>
      <div><dt>Can't connect</dt><dd>{s.failover===false?'The request fails':s.rotate?'Tries the next exit in the turn':'Tries the next healthy exit'}</dd></div>
      <div><dt>Your address</dt><dd>{choices.find(c=>c.v===own)?.label||'Only when it is the exit in use'}</dd></div>
    </dl>}

    <Group title="Which exit a request takes" area="g-which" more={<p>With spreading off, every request uses the exit marked <b>In use</b>. With it on, each request takes the next healthy exit, so each address's daily allowance lasts longer. Exits that are used up or failing are skipped, and a route's model list still applies.</p>}>
      <Toggle checked={s.rotate} onChange={rotate=>act('rotation','/admin/settings',{rotate},rotate?'Requests now take turns over your exits':'Requests now use the exit in use')} label="Spread requests over my exits" detail="Each request takes the next healthy exit instead of always the one in use."/>
      {(s.rotate||hasPool)&&<Field label={s.rotate?'How to pick the next exit':'How the proxy pool picks a proxy'} hint={s.rotate&&hasPool?'The proxy pool picks between its proxies the same way.':s.rotate?undefined:'Spreading is off, so this only applies inside the proxy pool.'}><Select aria-label={s.rotate?'How to pick the next exit':'How the proxy pool picks a proxy'} value={s.strategy==='single'?'round_robin':s.strategy} onChange={v=>act('strategy','/admin/settings',{strategy:v},'Saved')}><option value="round_robin">Take turns (round robin)</option><option value="random">Random</option><option value="fastest">Fastest answer (mostly stays on one)</option></Select></Field>}
    </Group>

    <Group title="When an exit can't take a request" area="g-fail" more={<><p><b>Used up</b> means the provider's limit for the exit's address is reached: OpenCode Free's daily allowance, or Kilo's free limit. The limit belongs to the address, not to the model, so the model is never paused for it; the exit is set aside (for that provider only) and the request goes on through the next one. A limit without a retry time is confirmed with a small check through the same exit first.</p><p><b>Can't connect</b> means the connection itself failed. That exit rests for 30 seconds, then longer, up to 5 minutes.</p></>}>
      <Toggle checked={s.exhaustedFailover!==false} onChange={exhaustedFailover=>act('exhausted','/admin/settings',{exhaustedFailover},exhaustedFailover?'Used-up exits now hand over to the next one':'A used-up exit now returns its error')} label="Move on when an exit is used up" detail="For OpenCode and Kilo. The model keeps working; only the exit is set aside until its limit resets."/>
      {s.exhaustedFailover!==false&&pinned.map(({p,set})=><div key={p.id} className="policy-warn" role="note"><p><b>{p.name}</b> has its own route list ({set.ids.map(id=>s.routes.find(r=>r.id===id)?.name||'a deleted route').join(', ')}), which this switch does not override. When {set.ids.length>1?'those are':'that is'} used up, its requests fail instead of moving on.</p><Button onClick={()=>letMoveOn(p,set)}>Let it move on to the backup exits</Button></div>)}
      {s.exhaustedFailover!==false&&<div className="policy-chain"><span className="policy-chain-label">Next in line</span>{data.backup?.length?<ol className="backup-list">{data.backup.map((b,i)=><li key={b.id} className={b.usable?'':'skipped'}><span className="step-n">{i+1}</span><strong>{b.name}</strong><small>{b.usable?b.why:`skipped · ${b.why}`}</small></li>)}</ol>:<p className="subtle">No other exit is on. Add a relay, a proxy or WARP.</p>}{hasPool&&go&&<Button onClick={()=>go('Proxies')}><Globe size={14}/>Manage proxy pool</Button>}</div>}
      <Toggle checked={s.failover!==false} onChange={failover=>act('failover','/admin/settings',{failover},failover?'Unreachable exits now hand over to the next one':'An unreachable exit now returns its error')} label="Move on when an exit can't connect" detail="Tries WARP first, then your other exits."/>
      {relays.length>0&&<><Toggle checked={s.relayRecheck!==false} onChange={relayRecheck=>act('recheck','/admin/settings',{relayRecheck},relayRecheck?'Used-up relays are asked again':'Used-up relays wait for the 10-minute check')} label="Ask a used-up relay again soon" detail="A relay can come back on a new address. Checked twice a few seconds apart instead of waiting 10 minutes."/>
        {recheck&&<p className="proof"><Clock3 size={15}/>Last asked again: <b>{recheck.name}</b> at {new Date(recheck.recheckedAt!).toISOString().slice(11,16)} UTC, still used up</p>}</>}
    </Group>

    <Group title="Your own address (Direct)" area="g-own" more={<p>Direct sends requests from this computer's own internet address. Which choice is right depends on whether that address may be seen by the providers: <b>Never</b> keeps it out completely.</p>}>
      <div className="policy-choices" role="radiogroup" aria-label="When to use your own address">{choices.map(c=><label key={c.v} className={own===c.v?'on':''}><input type="radio" name={`own-address${compact?'-map':''}`} checked={own===c.v} onChange={()=>void setOwn(c.v)}/><span><strong>{c.label}</strong><small>{c.detail}</small></span></label>)}</div>
      {!s.rotate&&s.spreadDirect===true&&own!=='never'&&<p className="subtle">Turn spreading on to make it part of the spread again.</p>}
      {hasPool&&<Toggle checked={s.catalogDirect!==false&&own!=='never'} onChange={catalogDirect=>{if(own==='never')return;void act('catalog','/admin/settings',{catalogDirect},catalogDirect?'Model lists skip the proxy pool':'Model lists use the proxy pool');}} label="Read model lists without the proxy pool" detail={own==='never'?'Not available while your own address is never used.':'While the pool is the exit in use, model lists and version checks leave from your own address. Only chat uses up the allowance.'}/>}
    </Group>
  </div>;
}

export function ModelPolicy({data,act:run}:Props){const act=run as Act;const s=data.settings;return <div className="policy model-policy">
      <Toggle checked={s.cooldowns===true} onChange={cooldowns=>act('cooldowns','/admin/settings',{cooldowns},cooldowns?'Model cooldowns enabled':'Model cooldowns disabled')} label="Pause a model after errors" detail="Off by default. When on, a failing model is skipped for 15 minutes, then 1 hour, then 6 hours. A used-up exit never pauses a model. Keep it off while testing a new client."/>
      <Toggle checked={s.trimTools!==false} onChange={trimTools=>act('trimtools','/admin/settings',{trimTools},trimTools?'Refused requests are retried with fewer tools':'Refused requests are not retried')} label="Retry with fewer tools when a request is refused" detail="OpenCode Free sometimes refuses a request only because of its tool list. When the exit is fine, Polygate asks once more with the standard tools and remembers it."/>
      <Toggle checked={s.fallback} onChange={fallback=>act('fallback','/admin/settings',{fallback},fallback?'Auto now falls back to other models':'Auto now tries one model')} label="Fall back when the model is “auto”" detail="Try up to three available models before the answer starts. A model you name yourself is never swapped."/>
  </div>;}
