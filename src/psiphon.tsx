import {useEffect,useState} from 'react';
import {AlertCircle,Info,Loader2,Power,RefreshCw,Route as RouteIcon,ShieldHalf} from 'lucide-react';
import {api} from './api';
import {Badge,Button,Select,Toggle,usePoll} from './ui';
import type {Notice} from './panels';

// The Psiphon route (backend/psiphon.ts): one client per chosen region, together one route that takes turns or stays on one region.
type Region={region:string;state:'stopped'|'starting'|'ready'|'reconnecting'|'failed';port:number;exitIp:string;location:string;since:number;usedUpUntil:number;kiloUntil:number;checking:''|'opencode'|'kilo'|'other';error:string};
type PsiphonInfo={installed:boolean;problem:string;platform:string;busy:string;lastError:string;running:boolean;live:number;
  config:{enabled:boolean;autoStart:boolean;regions:string[];mode:'spread'|'single';pinned:string;skip:boolean;renew:boolean};
  available:string[];updatedAt:number;regions:Region[];spent:number;route:{exists:boolean;enabled:boolean;inUse:boolean}};
const NAMES:Record<string,string>={AT:'Austria',BE:'Belgium',BG:'Bulgaria',CA:'Canada',CH:'Switzerland',CZ:'Czechia',DE:'Germany',DK:'Denmark',EE:'Estonia',ES:'Spain',FI:'Finland',FR:'France',GB:'United Kingdom',HU:'Hungary',IE:'Ireland',IN:'India',IT:'Italy',JP:'Japan',LT:'Lithuania',LV:'Latvia',NL:'Netherlands',NO:'Norway',PL:'Poland',PT:'Portugal',RO:'Romania',RS:'Serbia',SE:'Sweden',SG:'Singapore',SK:'Slovakia',US:'United States'};
const nameOf=(r:string)=>NAMES[r]||r;
const stateLabel:Record<Region['state'],[string,string]>={ready:['healthy','Connected'],starting:['neutral','Connecting'],reconnecting:['cooldown','Reconnecting'],failed:['error','Failed'],stopped:['neutral','Not running']};
const utc=(t:number)=>new Date(t).toISOString().slice(11,16)+' UTC';
const ago=(t:number)=>{const m=Math.round((Date.now()-t)/60000);return m<1?'just now':m<60?`${m} min ago`:m<1440?`${Math.round(m/60)} h ago`:`${Math.round(m/1440)} d ago`;};

export function PsiphonPanel({notice,onChanged}:{notice:Notice;onChanged:()=>void}){
  const {data:s,reload,error}=usePoll<PsiphonInfo>('/admin/psiphon/status',3000);
  const [picked,setPicked]=useState<string[]>([]);const [dirty,setDirty]=useState(false);const [busy,setBusy]=useState('');
  useEffect(()=>{if(s&&!dirty)setPicked(s.config.regions);},[s,dirty]);
  async function run(name:string,path:string,body:unknown={},done=''){setBusy(name);try{await api(path,body);if(done)notice(done);await reload();onChanged();return true;}catch(e){notice(String((e as Error)?.message||e),'error');await reload();return false;}finally{setBusy('');}}
  const save=(patch:Partial<PsiphonInfo['config']>,done='Psiphon settings saved')=>run('save','/admin/psiphon/settings',patch,done);
  if(!s)return <section className="section-block form-section psiphon-panel"><div className="section-top"><div className="section-title"><ShieldHalf size={19}/><h2>Psiphon</h2></div></div>
    {error?<div className="error-banner" role="alert"><AlertCircle size={16}/><span>{error}</span><Button onClick={()=>void reload()}>Try again</Button></div>:<div className="loading"><Loader2 className="spin"/> Checking Psiphon…</div>}</section>;
  const c=s.config;const working=!!busy||!!s.busy;const regionsChanged=dirty&&JSON.stringify([...picked].sort())!==JSON.stringify([...c.regions].sort());
  const [tone,label]=!s.installed?['neutral','Not available']:!c.enabled?['neutral','Off']:s.live?['healthy',`${s.live} of ${c.regions.length} connected`]:s.running?['cooldown','Connecting']:['neutral','Not running'];
  // Connect starts what is not running: everything at first, later only regions that stopped after repeated failures.
  const down=s.regions.filter(r=>r.state==='stopped'||r.state==='failed').length;const connectLabel=!s.running?'Connect':down?`Restart ${down} stopped region${down>1?'s':''}`:'Connected';
  const toggleRegion=(r:string)=>{setDirty(true);setPicked(p=>p.includes(r)?p.filter(x=>x!==r):[...p,r]);};
  const applyRegions=async()=>{if(await save({regions:picked},picked.length?`Psiphon regions: ${picked.join(', ')}`:'No Psiphon region chosen'))setDirty(false);};
  return <section className="section-block form-section psiphon-panel">
    <div className="section-top"><div className="section-title"><ShieldHalf size={19}/><h2>Psiphon</h2></div><Badge state={tone}>{label}</Badge></div>
    <p className="muted">Send model traffic through Psiphon's network. Polygate runs Psiphon's own client once for each region you choose, and they work together as one route named <b>Psiphon</b>. Only the gateway's own requests use it, never the rest of this computer.</p>
    {!s.installed?<div className="error-banner" role="alert"><AlertCircle size={16}/><span>{s.problem}</span></div>:<>
      <div className="psi-head">
        <div><strong>Regions</strong><small>{s.updatedAt?`Servers updated ${ago(s.updatedAt)}`:'Servers from the bundled list'} · {s.available.length} regions offered</small></div>
        <Button disabled={working} onClick={()=>run('update','/admin/psiphon/update',{},'Psiphon servers updated')} title="Connects once without a region; Psiphon's handshake brings its current servers and regions">{busy==='update'||s.busy==='updating nodes'?<Loader2 size={15} className="spin"/>:<RefreshCw size={15}/>}Update servers</Button>
      </div>
      <div className="psi-regions" role="group" aria-label="Psiphon regions">{s.available.map(r=><label key={r} className={picked.includes(r)?'on':''}><input type="checkbox" checked={picked.includes(r)} onChange={()=>toggleRegion(r)}/><span className="mono">{r}</span><small>{nameOf(r)}</small></label>)}</div>
      {regionsChanged&&<div className="psi-apply"><span>{picked.length?`${picked.length} region${picked.length>1?'s':''} chosen.`:'Choose at least one region.'}{s.running?' Running regions follow at once.':''}</span><Button variant="primary" disabled={working||!picked.length} onClick={()=>void applyRegions()}>Save regions</Button><Button disabled={working} onClick={()=>{setDirty(false);setPicked(c.regions);}}>Undo</Button></div>}

      <div className="button-row">
        <Button variant="primary" disabled={working||!c.enabled||!c.regions.length||regionsChanged||(s.running&&!down)} onClick={()=>run('connect','/admin/psiphon/connect',{},'Psiphon is connecting')}>{busy==='connect'?<Loader2 size={15} className="spin"/>:<Power size={15}/>}{connectLabel}</Button>
        <Button disabled={working||!s.running} onClick={()=>run('disconnect','/admin/psiphon/disconnect',{},'Psiphon disconnected')}>Disconnect</Button>
        {s.route.exists&&s.route.enabled&&!s.route.inUse&&<Button disabled={working} onClick={()=>run('use','/admin/settings',{routeId:'psiphon',rotate:false},'Psiphon is now the route in use')}><RouteIcon size={15}/>Make it the route in use</Button>}
        {s.route.inUse&&<span className="psi-inuse"><RouteIcon size={15}/>Route in use</span>}
      </div>
      {s.lastError&&!working&&<div className="error-banner" role="alert"><AlertCircle size={16}/><span>{s.lastError}</span></div>}

      {s.regions.length>0&&<div className="psi-rows">{s.regions.map(r=>{const [t,l]=r.state!=='ready'?stateLabel[r.state]:r.checking?['neutral',`Checking with ${r.checking==='kilo'?'Kilo':'OpenCode'}`]:r.usedUpUntil?['cooldown',`Used up until ${utc(r.usedUpUntil)}`]:stateLabel[r.state];const pinned=c.mode==='single'&&c.pinned===r.region;return <div key={r.region} className={`psi-row${pinned?' pinned':''}`}>
        <div className="psi-name"><strong className="mono">{r.region}</strong><small>{nameOf(r.region)}{pinned?' · the one in use':''}</small></div>
        <div className="psi-exit"><span className="mono">{r.exitIp||'-'}</span><small>{r.error||(r.location?`Exit in ${nameOf(r.location)}`:r.state==='ready'?'Finding the exit address…':'')}{r.kiloUntil?<> · Kilo limit until {utc(r.kiloUntil)}</>:null}</small></div>
        <Badge state={t}>{l}</Badge>
        <div className="psi-actions">
          {c.mode==='single'&&!pinned&&<Button disabled={working} onClick={()=>save({pinned:r.region},`Psiphon stays on ${r.region}`)}>Stay on this</Button>}
          <Button disabled={working||r.state==='stopped'} title="Reconnect this region, usually to another exit address" onClick={()=>run('renew-'+r.region,'/admin/psiphon/renew',{region:r.region},`${r.region} is getting a new address`)}>{busy==='renew-'+r.region?<Loader2 size={15} className="spin"/>:<RefreshCw size={15}/>}New address</Button>
        </div>
      </div>;})}</div>}

      <div className="psi-mode" role="radiogroup" aria-label="How Psiphon picks a region">
        <label className={c.mode==='spread'?'on':''}><input type="radio" name="psi-mode" checked={c.mode==='spread'} onChange={()=>void save({mode:'spread'},'Psiphon takes turns over its regions')}/><span><strong>Take turns</strong><small>Each request uses the next connected region (round robin).</small></span></label>
        <label className={c.mode==='single'?'on':''}><input type="radio" name="psi-mode" checked={c.mode==='single'} onChange={()=>void save({mode:'single',pinned:c.pinned||c.regions[0]||''},'Psiphon stays on one region')}/><span><strong>Stay on one region</strong><small>Every request uses the same connection until you choose another.</small></span></label>
      </div>
      {c.mode==='single'&&c.regions.length>0&&<div className="psi-pin"><span>Region in use</span><Select aria-label="Region in use" value={c.pinned||c.regions[0]} onChange={v=>void save({pinned:v},`Psiphon stays on ${v}`)}>{c.regions.map(r=><option key={r} value={r}>{r} · {nameOf(r)}</option>)}</Select></div>}

      <Toggle checked={c.skip} onChange={skip=>void save({skip},skip?'A used-up exit is skipped':'A used-up exit returns its error')} label="Skip a used-up exit" detail={c.mode==='single'?'With one region, a used-up exit hands the request to your backup exits (Routing policy).':'When OpenCode says an exit has used up its free allowance, the request goes on through the next region.'}/>
      <Toggle checked={c.renew} onChange={renew=>void save({renew},renew?'Used-up regions get a new address and are checked first':'Used-up regions keep their address')} label="Get a new address when one is used up, and check it" detail="When OpenCode Free or Kilo says a region's exit is used up, the region reconnects for a new address. Polygate sends one small request to that same provider through it, and puts the region back in turn for that provider only once it answers. Other providers keep using the region meanwhile. At most three new addresses an hour per region."/>
      <Toggle checked={c.autoStart} onChange={autoStart=>void save({autoStart},autoStart?'Psiphon connects when Polygate starts':'Psiphon waits for Connect')} label="Connect when Polygate starts" detail="Brings the chosen regions up after a restart or reboot. While Psiphon is the route in use it always reconnects, so requests are not left without their route."/>
      <Toggle checked={c.enabled} onChange={enabled=>void save({enabled},enabled?'Psiphon is on':'Psiphon is off')} label="Psiphon enabled" detail="Turn it off to stop every region and take the Psiphon route out of use."/>
      <p className="muted fine-print"><Info size={14}/> Psiphon's exit addresses are shared with its other users, so OpenCode can already count one as used up.{s.spent?` ${s.spent} exit${s.spent>1?'s are':' is'} marked used up today.`:''} Psiphon's client is GPL-3.0 software from Psiphon Inc. ({s.platform}).</p>
    </>}
  </section>;
}
