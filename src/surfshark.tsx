import {useEffect,useMemo,useState} from 'react';
import {AlertCircle,Check,Info,KeyRound,Loader2,Power,RefreshCw,Route as RouteIcon,Search,ShieldCheck,X} from 'lucide-react';
import {api,isCancelled} from './api';
import {Badge,Button,Field,Select,Toggle,usePoll,useCancel} from './ui';
import type {Notice} from './panels';

// The Surfshark route (backend/surfshark.ts): the account's WireGuard key pair, Surfshark's server list, and one client per chosen location,
// together one route that takes turns or stays on one location, with the same options as Psiphon.
type Region={region:string;country:string;location:string;state:'stopped'|'starting'|'ready'|'reconnecting'|'failed';port:number;exitIp:string;since:number;usedUpUntil:number;kiloUntil:number;checking:''|'opencode'|'kilo'|'other';error:string};
type Server={id:string;country:string;countryCode:string;location:string;load?:number};
type SurfsharkInfo={installed:boolean;problem:string;platform:string;busy:string;lastError:string;running:boolean;live:number;keys:{saved:boolean;publicKey:string};
  config:{enabled:boolean;autoStart:boolean;regions:string[];mode:'spread'|'single';pinned:string;skip:boolean;renew:boolean};
  servers:Server[];updatedAt:number;regions:Region[];spent:number;route:{exists:boolean;enabled:boolean;inUse:boolean}};
const stateLabel:Record<Region['state'],[string,string]>={ready:['healthy','Connected'],starting:['neutral','Connecting'],reconnecting:['cooldown','Reconnecting'],failed:['error','Failed'],stopped:['neutral','Not running']};
const utc=(t:number)=>new Date(t).toISOString().slice(11,16)+' UTC';
const ago=(t:number)=>{const m=Math.round((Date.now()-t)/60000);return m<1?'just now':m<60?`${m} min ago`:m<1440?`${Math.round(m/60)} h ago`:`${Math.round(m/1440)} d ago`;};
const place=(s:{country:string;location:string})=>s.location&&s.location!==s.country?`${s.country} · ${s.location}`:s.country;

// The key pair: pasted once, saved in the encrypted settings. Afterwards the page only shows that one is saved, and its public key.
function Keys({s,notice,reload}:{s:SurfsharkInfo;notice:Notice;reload:()=>void}){
  const [editing,setEditing]=useState(false);const [pub,setPub]=useState('');const [priv,setPriv]=useState('');const [busy,setBusy]=useState(false);
  const open=!s.keys.saved||editing;
  async function save(){setBusy(true);try{await api('/admin/surfshark/keys',{publicKey:pub.trim(),privateKey:priv.trim()});setPub('');setPriv('');setEditing(false);notice('Surfshark key pair saved');reload();}catch(e){notice(String((e as Error)?.message||e),'error');}finally{setBusy(false);}}
  async function remove(){setBusy(true);try{await api('/admin/surfshark/keys/remove',{});notice('Surfshark key pair removed');reload();}catch(e){notice(String((e as Error)?.message||e),'error');}finally{setBusy(false);}}
  return <div className="ss-keys">
    <div className="psi-head"><div><strong><KeyRound size={15}/> Your WireGuard key pair</strong><small>{s.keys.saved?'Saved, encrypted with your other settings. The private key is never shown again.':'Needed once. Polygate makes every location\'s connection from it.'}</small></div>
      {s.keys.saved&&!editing&&<div className="token-row"><Button disabled={busy} onClick={()=>setEditing(true)}>Replace</Button><Button disabled={busy} onClick={()=>void remove()}>Remove</Button></div>}</div>
    {s.keys.saved&&!editing&&<p className="ss-saved"><Check size={15}/> Public key <span className="mono">{s.keys.publicKey}</span></p>}
    {open&&<form className="ss-key-form" autoComplete="off" onSubmit={e=>{e.preventDefault();if(priv.trim()&&!busy)void save();}}>
      <p className="subtle">In your Surfshark account open <b>VPN → Manual setup → Desktop or mobile → WireGuard</b>, and on the <b>Credentials</b> tab choose <b>Generate a new key pair</b>. Copy both keys here. Downloading location files is not needed.</p>
      <div className="form-grid"><Field label="Public key"><input value={pub} onChange={e=>setPub(e.target.value)} placeholder="44 characters ending in =" spellCheck={false} autoComplete="off"/></Field>
        <Field label="Private key" hint="Checked against the public key before it is saved."><input type="password" value={priv} onChange={e=>setPriv(e.target.value)} placeholder="44 characters ending in =" spellCheck={false} autoComplete="new-password"/></Field></div>
      <div className="form-actions">{editing&&<Button disabled={busy} onClick={()=>{setEditing(false);setPub('');setPriv('');}}>Cancel</Button>}<Button variant="primary" type="submit" disabled={busy||!priv.trim()}>{busy?<Loader2 size={15} className="spin"/>:<KeyRound size={15}/>}Save key pair</Button></div>
    </form>}
  </div>;
}

export function SurfsharkPanel({notice,onChanged}:{notice:Notice;onChanged:()=>void}){
  const {data:s,reload,error}=usePoll<SurfsharkInfo>('/admin/surfshark/status',3000);
  const [picked,setPicked]=useState<string[]>([]);const [dirty,setDirty]=useState(false);const [busy,setBusy]=useState('');const [query,setQuery]=useState('');
  useEffect(()=>{if(s&&!dirty)setPicked(s.config.regions);},[s,dirty]);
  // Updating servers can be cancelled; only that action holds the cancel, so a setting saved meanwhile never stops it.
  const {start,cancel}=useCancel(false);
  async function run(name:string,path:string,body:unknown={},done=''){setBusy(name);try{await api(path,body,name==='update'?start():undefined);if(done)notice(done);await reload();onChanged();return true;}catch(e){if(isCancelled(e))notice(name==='update'?'Server update cancelled; the current list is kept':'Cancelled');else notice(String((e as Error)?.message||e),'error');await reload();return false;}finally{setBusy('');}}
  const save=(patch:Partial<SurfsharkInfo['config']>,done='Surfshark settings saved')=>run('save','/admin/surfshark/settings',patch,done);
  // Every location, filtered by the search; and how many each country has, so a country with several shows the city on its card.
  const shown=useMemo(()=>{const q=query.trim().toLowerCase();return (s?.servers||[]).filter(v=>!q||`${v.country} ${v.location} ${v.id} ${v.countryCode}`.toLowerCase().includes(q));},[s?.servers,query]);
  const perCountry=useMemo(()=>{const m=new Map<string,number>();for(const v of s?.servers||[])m.set(v.country,(m.get(v.country)||0)+1);return m;},[s?.servers]);
  if(!s)return <section className="section-block form-section psiphon-panel"><div className="section-top"><div className="section-title"><ShieldCheck size={19}/><h2>Surfshark</h2></div></div>
    {error?<div className="error-banner" role="alert"><AlertCircle size={16}/><span>{error}</span><Button onClick={()=>void reload()}>Try again</Button></div>:<div className="loading"><Loader2 className="spin"/> Checking Surfshark…</div>}</section>;
  const c=s.config;const working=!!busy||!!s.busy;const regionsChanged=dirty&&JSON.stringify([...picked].sort())!==JSON.stringify([...c.regions].sort());
  const [tone,label]=!s.installed?['neutral','Not available']:!s.keys.saved?['neutral','Key pair needed']:!c.enabled?['neutral','Off']:s.live?['healthy',`${s.live} of ${c.regions.length} connected`]:s.running?['cooldown','Connecting']:['neutral','Not running'];
  const down=s.regions.filter(r=>r.state==='stopped'||r.state==='failed').length;const connectLabel=!s.running?'Connect':down?`Restart ${down} stopped location${down>1?'s':''}`:'Connected';
  const toggle=(id:string)=>{setDirty(true);setPicked(p=>p.includes(id)?p.filter(x=>x!==id):[...p,id]);};
  const retired=picked.filter(id=>!s.servers.some(server=>server.id===id));
  const applyRegions=async()=>{if(await save({regions:picked},picked.length?`Surfshark locations: ${picked.length} chosen`:'No Surfshark location chosen'))setDirty(false);};
  const nameOf=(id:string)=>{const v=s.servers.find(x=>x.id===id);return v?place(v):id;};
  return <section className="section-block form-section psiphon-panel surfshark-panel">
    <div className="section-top"><div className="section-title"><ShieldCheck size={19}/><h2>Surfshark</h2></div><Badge state={tone}>{label}</Badge></div>
    <p className="muted">Send model traffic through your Surfshark account. Polygate runs a WireGuard client once for each location you choose, and they work together as one route named <b>Surfshark</b>. The client keeps the tunnel to itself: no network adapter, route or DNS changes on this computer, and only the gateway's own requests use it. It also works over another VPN or proxy already running here.</p>
    {!s.installed?<div className="error-banner" role="alert"><AlertCircle size={16}/><span>{s.problem}</span></div>:<>
      <Keys s={s} notice={notice} reload={()=>void reload()}/>
      {s.keys.saved&&<>
      <div className="psi-head">
        <div><strong>Locations</strong><small>{s.servers.length?`${s.servers.length} locations in ${new Set(s.servers.map(v=>v.countryCode)).size} countries · list updated ${ago(s.updatedAt)}`:'Load Surfshark\'s locations first.'}</small></div>
        <div className="token-row"><Button disabled={working} onClick={()=>run('update','/admin/surfshark/update',{},'Surfshark servers updated')} title="Reads Surfshark's public list of servers: each location's address and WireGuard key">{busy==='update'||s.busy==='updating servers'?<Loader2 size={15} className="spin"/>:<RefreshCw size={15}/>}Update servers</Button>{busy==='update'&&<Button onClick={cancel}><X size={15}/>Cancel</Button>}</div>
      </div>
      {s.servers.length>0&&<>
        {retired.length>0&&<div className="psi-apply" role="status"><span>No longer in Surfshark's server list: {retired.join(', ')}. Remove these and choose an available location before saving.</span><Button disabled={working} onClick={()=>{setDirty(true);setPicked(p=>p.filter(id=>!retired.includes(id)));}}>Remove unavailable locations</Button></div>}
        <div className="guide-search ss-search"><Search size={16}/><input type="search" aria-label="Search Surfshark locations" placeholder="Search a country or city…" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button className="icon-button" aria-label="Clear search" onClick={()=>setQuery('')}><X size={15}/></button>}<span className="subtle">{picked.length} chosen</span></div>
        {/* One flowing grid of every location, alphabetical: the country on top, the city and how busy it is below (a country with one
            location used to take a whole row of its own, which made a long single column). */}
        <div className="psi-regions ss-locations" role="group" aria-label="Surfshark locations">{shown.map(v=>{const many=(perCountry.get(v.country)||0)>1;return <label key={v.id} className={picked.includes(v.id)?'on':''} title={`${place(v)} (${v.id})`}><input type="checkbox" checked={picked.includes(v.id)} onChange={()=>toggle(v.id)}/><span>{v.country}</span><small>{many?v.location||v.id:v.location&&v.location!==v.country?v.location:v.countryCode}{typeof v.load==='number'?` · ${v.load}%`:''}</small></label>;})}</div>
        {!shown.length&&<p className="subtle">No location matches “{query}”.</p>}
        {regionsChanged&&<div className="psi-apply"><span>{picked.length?`${picked.length} location${picked.length>1?'s':''} chosen.`:'Choose at least one location.'}{s.running?' Running locations follow at once.':''}</span><Button variant="primary" disabled={working||!picked.length} onClick={()=>void applyRegions()}>Save locations</Button><Button disabled={working} onClick={()=>{setDirty(false);setPicked(c.regions);}}>Undo</Button></div>}
      </>}

      <div className="button-row">
        <Button variant="primary" disabled={working||!c.enabled||!c.regions.length||regionsChanged||(s.running&&!down)} onClick={()=>run('connect','/admin/surfshark/connect',{},'Surfshark is connecting')}>{busy==='connect'?<Loader2 size={15} className="spin"/>:<Power size={15}/>}{connectLabel}</Button>
        <Button disabled={working||!s.running} onClick={()=>run('disconnect','/admin/surfshark/disconnect',{},'Surfshark disconnected')}>Disconnect</Button>
        {s.route.exists&&s.route.enabled&&!s.route.inUse&&<Button disabled={working} onClick={()=>run('use','/admin/settings',{routeId:'surfshark',rotate:false},'Surfshark is now the route in use')}><RouteIcon size={15}/>Make it the route in use</Button>}
        {s.route.inUse&&<span className="psi-inuse"><RouteIcon size={15}/>Route in use</span>}
      </div>
      {s.lastError&&!working&&<div className="error-banner" role="alert"><AlertCircle size={16}/><span>{s.lastError}</span></div>}

      {s.regions.length>0&&<div className="psi-rows">{s.regions.map(r=>{const [t,l]=r.state!=='ready'?stateLabel[r.state]:r.checking?['neutral',`Checking with ${r.checking==='kilo'?'Kilo':'OpenCode'}`]:r.usedUpUntil?['cooldown',`Used up until ${utc(r.usedUpUntil)}`]:stateLabel[r.state];const pinned=c.mode==='single'&&c.pinned===r.region;return <div key={r.region} className={`psi-row${pinned?' pinned':''}`}>
        <div className="psi-name"><strong>{place(r)}</strong><small className="mono">{r.region}{pinned?' · the one in use':''}</small></div>
        <div className="psi-exit"><span className="mono">{r.exitIp||'-'}</span><small>{r.error||(r.state==='ready'&&!r.exitIp?'Finding the exit address…':r.state==='starting'?'Connecting through WireGuard…':'')}{r.kiloUntil?<> · Kilo limit until {utc(r.kiloUntil)}</>:null}</small></div>
        <Badge state={t}>{l}</Badge>
        <div className="psi-actions">
          {c.mode==='single'&&!pinned&&<Button disabled={working} onClick={()=>save({pinned:r.region},`Surfshark stays on ${nameOf(r.region)}`)}>Stay on this</Button>}
          <Button disabled={working||r.state==='stopped'} title="Reconnect this location; it may land on another server with another exit address" onClick={()=>run('renew-'+r.region,'/admin/surfshark/renew',{region:r.region},`${nameOf(r.region)} is reconnecting`)}>{busy==='renew-'+r.region?<Loader2 size={15} className="spin"/>:<RefreshCw size={15}/>}New address</Button>
        </div>
      </div>;})}</div>}

      <div className="psi-mode" role="radiogroup" aria-label="How Surfshark picks a location">
        <label className={c.mode==='spread'?'on':''}><input type="radio" name="ss-mode" checked={c.mode==='spread'} onChange={()=>void save({mode:'spread'},'Surfshark takes turns over its locations')}/><span><strong>Take turns</strong><small>Each request uses the next connected location (round robin).</small></span></label>
        <label className={c.mode==='single'?'on':''}><input type="radio" name="ss-mode" checked={c.mode==='single'} onChange={()=>void save({mode:'single',pinned:c.pinned||c.regions[0]||''},'Surfshark stays on one location')}/><span><strong>Stay on one location</strong><small>Every request uses the same connection until you choose another.</small></span></label>
      </div>
      {c.mode==='single'&&c.regions.length>0&&<div className="psi-pin"><span>Location in use</span><Select aria-label="Location in use" value={c.pinned||c.regions[0]} onChange={v=>void save({pinned:v},`Surfshark stays on ${nameOf(v)}`)}>{c.regions.map(r=><option key={r} value={r}>{nameOf(r)}</option>)}</Select></div>}

      <Toggle checked={c.skip} onChange={skip=>void save({skip},skip?'A used-up exit is skipped':'A used-up exit returns its error')} label="Skip a used-up exit" detail={c.mode==='single'?'With one location, a used-up exit hands the request to your backup exits (Routing policy).':'When OpenCode says an exit has used up its free allowance, the request goes on through the next location.'}/>
      <Toggle checked={c.renew} onChange={renew=>void save({renew},renew?'Used-up locations reconnect and are checked first':'Used-up locations keep their connection')} label="Get a new address when one is used up, and check it" detail="When OpenCode Free or Kilo says a location's exit is used up, the location reconnects, which can land on another Surfshark server with another address. Polygate sends one small request to that same provider through it, and puts the location back in turn for that provider only once it answers. At most three reconnects an hour per location."/>
      <Toggle checked={c.autoStart} onChange={autoStart=>void save({autoStart},autoStart?'Surfshark connects when Polygate starts':'Surfshark waits for Connect')} label="Connect when Polygate starts" detail="Brings the chosen locations up after a restart or reboot. While Surfshark is the route in use it always reconnects, so requests are not left without their route."/>
      <Toggle checked={c.enabled} onChange={enabled=>void save({enabled},enabled?'Surfshark is on':'Surfshark is off')} label="Surfshark enabled" detail="Turn it off to stop every location and take the Surfshark route out of use."/>
      </>}
      <p className="muted fine-print"><Info size={14}/> Uses your own Surfshark subscription through the WireGuard manual setup Surfshark offers its customers. Surfshark's addresses are shared with its other users, so OpenCode can already count one as used up.{s.spent?` ${s.spent} exit${s.spent>1?'s are':' is'} marked used up today.`:''} The WireGuard client is wireproxy (ISC licence) ({s.platform}). Polygate is not affiliated with Surfshark.</p>
    </>}
  </section>;
}
