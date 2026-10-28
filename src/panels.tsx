import {useState,useEffect,useRef,type FormEvent} from 'react';
import {AlertCircle,Bell,Check,CheckCircle2,ChevronLeft,ChevronRight,Cloud,Copy,ExternalLink,Gauge,Globe,Info,KeyRound,Loader2,Lock,LogOut,Play,Plus,Power,RefreshCw,Search,Shield,ShieldCheck,Square,Trash2,X,Zap} from 'lucide-react';
import {api,at} from './api';
import {ProxyLists} from './proxy-lists';
import {Logo,Badge,Button,Empty,Field,Toggle,Select,Progress,usePoll,tabKeys,ms,time,when,compact,type Snapshot} from './ui';
export type Notice=(message:string,kind?:'ok'|'error')=>void;
const errorOf=(e:unknown)=>String((e as Error)?.message||e);
// ---------- sign in ----------
export function Login({onDone}:{onDone:()=>void}){
  const [password,setPassword]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  async function submit(e:FormEvent){e.preventDefault();setBusy(true);setError('');
    try{const r=await fetch(at('/admin/login'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error?.message||'Sign in failed');setPassword('');onDone();}
    catch(err){setError(errorOf(err));}finally{setBusy(false);}}
  return <div className="login-screen"><form className="login-card" onSubmit={submit}>
    <div className="brand-mark"><Logo size={52}/></div><h1>Sign in to Polygate</h1><p className="muted">Enter the dashboard password for this server.</p>
    <Field label="Password"><input type="password" autoFocus autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/></Field>
    {error&&<div className="error-banner" role="alert"><AlertCircle size={16}/><span>{error}</span></div>}
    <Button type="submit" variant="primary" disabled={!password||busy}>{busy?<Loader2 size={15} className="spin"/>:<Lock size={15}/>} Sign in</Button>
    <small className="muted">Lost the password? On the server run <code>polygate password</code>.</small>
  </form></div>;
}
// ---------- notifications ----------
type Notice1={id:string;title:string;message:string;type:'info'|'success'|'warning'|'error';time:number;read:boolean};
export function NotificationsMenu({unread,onChange}:{unread:number;onChange:()=>void}){
  const [open,setOpen]=useState(false);const {data,reload}=usePoll<{items:Notice1[];unread:number}>('/admin/notifications',5000,open);const box=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(!open)return;const close=(e:MouseEvent)=>{if(box.current&&!box.current.contains(e.target as Node))setOpen(false);};const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){setOpen(false);box.current?.querySelector<HTMLButtonElement>('.bell')?.focus();}};document.addEventListener('mousedown',close);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('mousedown',close);document.removeEventListener('keydown',escape);};},[open]);
  const run=async(path:string)=>{try{await api(path,{});await reload();onChange();}catch{/* the list refreshes on the next poll */}};
  return <div className="notify" ref={box}><button className="icon-button bell" aria-label={`Notifications${unread?`, ${unread} unread`:''}`} aria-expanded={open} onClick={()=>setOpen(!open)}><Bell size={17}/>{unread>0&&<span className="bell-count">{unread>9?'9+':unread}</span>}</button>
    {open&&<div className="notify-menu" role="dialog" aria-label="Notifications"><div className="notify-head"><strong>Notifications</strong><span className="toolbar-spacer"/><button className="text-button" onClick={()=>run('/admin/notifications/read')}>Mark all read</button><button className="text-button" onClick={()=>run('/admin/notifications/clear')}>Clear</button></div>
      {data?.items.length?<ul>{data.items.map(n=><li key={n.id} className={`${n.type} ${n.read?'':'unread'}`}><i/><div><strong>{n.title}</strong><p>{n.message}</p><small>{when(n.time)}</small></div></li>)}</ul>:<p className="notify-empty">Nothing yet. Route, model and WARP changes show up here.</p>}</div>}</div>;
}
// ---------- Cloudflare WARP ----------
type WarpInfo={engine:string;state:string;busy:boolean;port:number;helper:{path:string;installed:boolean;kind:string};egress:null|{ip:string;colo:string;warp:string;loc?:string};tunnels:{port:number;egressIp:string;endpoint:string;since:number;cooling:boolean}[];progress:{percent:number;stage:string;message:string};lastError:string;autoStart:boolean;pool:number;rotateMinutes:number;platform:string;canRotate:boolean;config:{helperPath:string;endpoint:string};install:{kind:string;automatic:boolean;note:string}};
const warpLabel:Record<string,[string,string]>={connected:['healthy','Connected'],connecting:['cooldown','Connecting…'],disconnected:['neutral','Disconnected'],not_installed:['cooldown','Not installed'],not_registered:['cooldown','Not registered'],error:['error','Needs attention'],disabled:['neutral','Turned off']};
export function WarpPanel({notice,onChanged}:{notice:Notice;onChanged:()=>void}){
  const {data:s,reload}=usePoll<WarpInfo>('/admin/warp/status',3000);
  const [form,setForm]=useState({engine:'embedded',port:40000,pool:2,rotateMinutes:0,autoStart:false,helperPath:'',endpoint:''});const [dirty,setDirty]=useState(false);const [busy,setBusy]=useState('');
  useEffect(()=>{if(s&&!dirty)setForm({engine:s.engine,port:s.port,pool:s.pool,rotateMinutes:s.rotateMinutes,autoStart:s.autoStart,helperPath:s.config.helperPath,endpoint:s.config.endpoint});},[s,dirty]);
  const edit=(patch:Partial<typeof form>)=>{setDirty(true);setForm(f=>({...f,...patch}));};
  async function run(name:string,path:string,body:unknown={},done=''){setBusy(name);try{await api(path,body);if(done)notice(done);await reload();onChanged();return true;}catch(e){notice(errorOf(e),'error');await reload();return false;}finally{setBusy('');}}
  const [tone,label]=warpLabel[s?.state||'disconnected']||['neutral',s?.state||''];const working=!!busy||!!s?.busy;const connected=s?.state==='connected';
  const needsInstall=!!s&&s.engine==='embedded'&&!s.helper.installed;
  return <section className="section-block form-section warp-panel">
    <div className="section-top"><div className="section-title"><Cloud size={19}/><h2>Cloudflare WARP</h2></div>{s&&<Badge state={tone}>{label}</Badge>}</div>
    <p className="muted">Send model traffic through Cloudflare WARP. Polygate runs its own MASQUE tunnel over HTTP/2, so it works on networks that block WireGuard and UDP. Only the gateway's own requests use it — never the rest of this machine.</p>
    {!s?<div className="loading"><Loader2 className="spin"/> Checking WARP…</div>:<>
      <div className="warp-stats"><div><span>Exit IP</span><strong className="mono">{s.egress?.ip||'—'}</strong></div><div><span>Data center</span><strong>{s.egress?.colo||'—'}</strong></div><div><span>Local proxy</span><strong className="mono">127.0.0.1:{s.port}</strong></div></div>
      {s.tunnels.length>0&&<div className="chip-row">{s.tunnels.map(t=><span key={t.port} className={`chip ${t.cooling?'warn':'ok'}`} title={t.endpoint}>:{t.port} · {t.egressIp||'starting'}{t.cooling?' · cooling':''}</span>)}</div>}
      {working&&<div className="progress-block"><Progress value={s.progress.percent||8} label="WARP setup progress"/><small>{s.progress.message}</small></div>}
      {s.lastError&&!connected&&!working&&<div className="error-banner" role="alert"><AlertCircle size={16}/><span>{s.lastError}</span></div>}
      <div className="button-row">
        <Button variant="primary" disabled={working||s.engine==='disabled'||needsInstall} onClick={()=>run('connect','/admin/warp/connect',{},'WARP is connected')}>{busy==='connect'?<Loader2 size={15} className="spin"/>:<Power size={15}/>}{connected?'Reconnect':'Set up & connect'}</Button>
        <Button disabled={working||!connected} onClick={()=>run('disconnect','/admin/warp/disconnect',{},'WARP disconnected')}>Disconnect</Button>
        {needsInstall&&<Button variant="primary" disabled={working} onClick={()=>run('install','/admin/warp/install',{},'Helper found')}>{busy==='install'?<Loader2 size={15} className="spin"/>:<Search size={15}/>}Locate helper</Button>}
        {s.canRotate&&<Button disabled={working||!connected} title="Request a fresh WARP identity and exit IP" onClick={()=>run('rotate','/admin/warp/rotate',{},'WARP identity rotated')}><RefreshCw size={15}/>New identity</Button>}
        <Button disabled={working} onClick={async()=>{setBusy('detect');await reload();setBusy('');}}><Search size={15}/>Detect</Button>
      </div>
      {needsInstall&&<p className="muted">{s.install.note}</p>}
      <p className="muted fine-print"><Info size={14}/> Cloudflare's WARP exit addresses are shared, so a service can still rate-limit them. The tunnel can be healthy while that particular exit is refused.</p>
      <details className="disclosure"><summary>Settings</summary>
        <div className="form-grid">
          <Field label="SOCKS port" hint="Where the helper's local proxy listens."><input type="number" min={1024} max={65535} value={form.port} onChange={e=>edit({port:+e.target.value})}/></Field>
          <Field label="Parallel tunnels" hint="Each tunnel has its own WARP identity (1–4)."><input type="number" min={1} max={4} value={form.pool} onChange={e=>edit({pool:+e.target.value})}/></Field>
          <Field label="Rotate identity every (minutes)" hint="0 keeps the same identity until you ask for a new one."><input type="number" min={0} value={form.rotateMinutes} onChange={e=>edit({rotateMinutes:+e.target.value})}/></Field>
          <Field label="MASQUE endpoint (optional)" hint="Leave empty to try Cloudflare's HTTP/2 endpoints automatically. Override only if your network needs a specific address."><input value={form.endpoint} placeholder="162.159.198.183" onChange={e=>edit({endpoint:e.target.value})}/></Field>
          <Field label="Helper path (optional)" hint={s.helper.path?`Using ${s.helper.path}`:'Bundled with Polygate. Set only to use another build.'}><input value={form.helperPath} placeholder="Auto (bundled)" onChange={e=>edit({helperPath:e.target.value})}/></Field>
        </div>
        <Toggle checked={form.engine!=='disabled'} onChange={v=>edit({engine:v?'embedded':'disabled'})} label="WARP enabled" detail="Turn it off to stop using WARP altogether."/>
        <Toggle checked={form.autoStart} onChange={v=>edit({autoStart:v})} label="Connect when Polygate starts" detail="Brings WARP up automatically after a restart or reboot."/>
        <div className="form-actions"><Button variant="primary" disabled={!dirty||working} onClick={async()=>{if(await run('save','/admin/warp/settings',form,'WARP settings saved'))setDirty(false);}}>Save WARP settings</Button></div>
      </details></>}
  </section>;
}
// ---------- proxy pool ----------
type PoolRow={url:string;proto:string;host:string;port:number;latencyMs?:number;exitIp?:string;stage:string;health:{status:string;latency:number;checkedAt:number;deep:boolean;error:string;coolUntil:number;exhaustedUntil?:number;api?:{ok:boolean;latency:number;at:number}}};
type PoolConfig={mode:string;deepTest:boolean;recheckMinutes:number;maxTested:number;concurrency:number;retries:number;standby?:boolean;standbyTarget?:number;apiMaxLatencyMs?:number;apiTimeoutSec?:number;keepWarm?:boolean};
type FindJob={running:boolean;kind:string;phase:string;total:number;done:number;passed:number;message:string;finishedAt:number};
type PoolInfo={entries:PoolRow[];total:number;page:number;pages:number;pageSize:number;counts:Record<string,number>;job:{running:boolean;phase:string;total:number;done:number;ready:number;failed:number;message:string;finishedAt:number;deep:boolean};list:FindJob;config:PoolConfig;ready:number;standby?:{clean:number;ready:number;exhausted:number;target:number;enabled:boolean;testing:boolean;warm?:number};route:{attached:boolean;active:boolean;previous:string};api:{running:boolean;at:number;checked:number;passed:number;message:string;gate:number;url:string}};
const healthLabel:Record<string,[string,string]>={ready:['available','Model-ready'],reachable:['neutral','Reaches API'],limited:['cooldown','Rate limited'],exhausted:['cooldown','Used up today'],blocked:['error','Refused'],unreachable:['error','Failed'],bad:['error','Server error'],untested:['neutral','Not tested']};
const poolTabs:[string,string][]=[['all','All'],['ready','Model-ready'],['api','Passed API check'],['exhausted','Used up today'],['failed','Failed'],['untested','Not tested']];
const apiCell=(h:PoolRow['health'],gate:number)=>!h.api?<span className="muted">—</span>:!h.api.ok?<span className="bad-text">No reply</span>:<span className={h.api.latency>gate?'bad-text mono':'mono'} title={h.api.latency>gate?`Slower than the ${gate} ms limit`:'Loaded the OpenCode API'}>{h.api.latency} ms</span>;
type BackupStep={id:string;name:string;usable:boolean;why:string};
export function PoolPanel({notice,action,refresh,go,backup}:{notice:Notice;action:Function;refresh:()=>void;go:(page:any)=>void;backup:BackupStep[]}){
  const [tab,setTab]=useState('all');const [query,setQuery]=useState('');const [q,setQ]=useState('');const [proto,setProto]=useState('');const [page,setPage]=useState(1);const [pageSize,setPageSize]=useState(25);
  useEffect(()=>{const t=setTimeout(()=>{setQ(query);setPage(1);},300);return()=>clearTimeout(t);},[query]);
  const params=new URLSearchParams({tab,sort:'best',page:String(page),pageSize:String(pageSize)});if(q)params.set('q',q);if(proto)params.set('proto',proto);
  const {data,reload,error}=usePoll<PoolInfo>('/admin/pool?'+params,3500);
  const [picked,setPicked]=useState<Set<string>>(new Set());const [busy,setBusy]=useState('');const [pendingMain,setPendingMain]=useState(false);
  const [adding,setAdding]=useState(false);
  const [cfg,setCfg]=useState<PoolConfig|null>(null);useEffect(()=>{if(data&&!cfg)setCfg(data.config);},[data,cfg]);
  const rows=data?.entries||[];const counts=data?.counts;
  const toggle=(url:string)=>setPicked(s=>{const n=new Set(s);n.has(url)?n.delete(url):n.add(url);return n;});
  async function call(name:string,path:string,body:unknown={},ok=''){setBusy(name);try{await api(path,body);if(ok)notice(ok);await reload();return true;}catch(e){notice(errorOf(e),'error');return false;}finally{setBusy('');}}
  async function use(urls:string[]|null,select=true){setBusy('attach');try{await action('proxy','/admin/proxy/attach',{...(urls?{urls}:{}),select},!select?'Pool attached as standby. Your current route is unchanged.':urls?`Gateway now rotates ${urls.length} selected prox${urls.length===1?'y':'ies'}`:'Gateway now rotates every model-ready proxy');setPicked(new Set());await reload();refresh();}catch{/* action() already showed the reason */}finally{setBusy('');}}
  // One truth with the Routing page: whether the pool is the active route comes from the gateway, not from this page.
  const route=data?.route;const asMain=route?.attached?route.active:pendingMain;
  async function setRole(select:boolean){setPendingMain(select);if(!route?.attached)return;setBusy('role');try{await api('/admin/pool/role',{select});notice(select?'The pool is now used for every request':`Standby only. Requests go back to ${route.previous}.`);await reload();refresh();}catch(e){notice(errorOf(e),'error');}finally{setBusy('');}}
  const job=data?.job;const list=data?.list;const working=!!job?.running||!!list?.running;const gate=data?.api.gate||2500;
  const strip=(running:boolean,label:string,message:string,done:number,total:number,finished:boolean)=>(running||finished)?<div className="scan-strip pool-job"><span>{running?<Loader2 size={15} className="spin"/>:<CheckCircle2 size={15}/>} {label}</span><span className="grow">{message}</span>{running&&total>0&&<><span>{done.toLocaleString()}/{total.toLocaleString()}</span><Progress value={Math.round(done/total*100)} label={`${label} progress`}/></>}</div>:null;
  const phaseName:Record<string,string>={api:'OpenCode API check',quick:'Reachability',deep:'Model test'};
  const strips=<>{list&&strip(list.running,list.phase==='download'?'Downloading lists':'Checking proxies',list.message,list.done,list.total,!!list.finishedAt)}{job&&strip(job.running,job.running?(phaseName[job.phase]||'Testing'):'Last model test',job.message,job.done,job.total,!!job.finishedAt)}</>;
  const standbyStrip=data?.standby&&<div className="scan-strip pool-job"><span>{data.standby.testing?<Loader2 size={15} className="spin"/>:data.standby.clean>=data.standby.target?<CheckCircle2 size={15}/>:<AlertCircle size={15}/>} Standby</span><span className="grow">{data.standby.enabled?`${data.standby.clean} of ${data.standby.target} clean exits ready (passed a real model request recently)${data.standby.warm?` · ${data.standby.warm} connection${data.standby.warm>1?'s':''} warm`:''}${data.standby.exhausted>0?` · ${data.standby.exhausted} used up until 00:00 UTC`:''}`:'Off. Turn it on in the settings below to keep verified proxies ready for when an exit is used up.'}</span></div>;
  const steps:[string,string,number|string][]=[['1','Reach the OpenCode API',data?.api.checked?`${data.api.passed} of ${data.api.checked}`:'—'],['2',`Fast enough (under ${gate} ms)`,data?.api.checked?String(data.api.passed):'—'],['3','Pass a real model request',counts?String(counts.ready+counts.exhausted):'—'],['4','Working ones go into the pool',counts?String(counts.ready):'—']];
  return <section className="section-block pool-panel simple-pool">
    <div className="section-top"><div><h2>Find working proxies</h2><p className="subtle">One button downloads public proxy lists, keeps the ones that reach the OpenCode API fast, sends one small model request through those, and puts the ones that work into the pool. You can also paste your own list.</p></div></div>
    <div className="simple-body">
    <ol className="funnel-steps">{steps.map(([n,label,value])=><li key={n}><span className="step-n">{n}</span><span className="step-label">{label}</span><strong className="mono">{value}</strong></li>)}</ol>
    {strips}{standbyStrip}
    <div className="pool-choice" role="radiogroup" aria-label="How the pool is used"><label><input type="radio" name="pool-use" checked={!asMain} disabled={busy==='role'} onChange={()=>setRole(false)}/><span>Use them only when my own IP is used up <small className="muted">Recommended. Your current route stays the active one.</small></span></label><label><input type="radio" name="pool-use" checked={asMain} disabled={busy==='role'} onChange={()=>setRole(true)}/><span>Use them for every request <small className="muted">The pool becomes the active route.</small></span></label></div>
    <p className="route-status subtle">{!route?.attached?'The pool is not attached yet. It is attached as soon as a run finds working proxies.':asMain?'Right now the pool is the active route.':`Right now the pool is standby only; the active route is ${route.previous}.`} {backup.length>0&&<>Backup order: {backup.filter(x=>x.usable).map(x=>x.name).join(' → ')||'none ready'}. </>}<button className="link-button" onClick={()=>go('Routing')}>Open Routing</button></p>
    <div className="form-actions left">{working?<Button onClick={()=>call('stop','/admin/proxies/stop',{})}><Square size={14}/>Stop</Button>:<Button variant="primary" disabled={!!busy} onClick={()=>call('find','/admin/proxies/scan',{select:asMain},'Looking for working proxies')}><Zap size={15}/>Find working proxies</Button>}
      <Button disabled={!!busy} aria-expanded={adding} onClick={()=>setAdding(!adding)}><Plus size={15}/>My proxies and lists</Button>
      <Button disabled={working||!!busy||!counts?.all} title="Runs the API check and the model test again on the proxies already saved." onClick={()=>call('retest','/admin/pool/find',{select:asMain},'Re-testing the saved proxies')}><RefreshCw size={15}/>Re-test saved</Button>
      <span className="subtle">{counts?<><strong>{counts.ready}</strong> working in the pool · {counts.all.toLocaleString()} saved proxies. {working?'Runs in the background; you can leave this page.':''}</>:'Loading…'}</span></div>
    {adding&&<ProxyLists select={asMain} disabled={working} notice={notice} onStarted={()=>{setAdding(false);void reload();}}/>}
    {counts&&counts.ready>0&&<p className="subtle fine-print"><Info size={14}/> Working proxies are re-verified in the background. When your own IP has used up its daily allowance, requests move to one of them automatically.</p>}
    </div>
    <div className="section-toolbar"><div className="search"><Search size={16}/><input aria-label="Filter proxies" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Filter by address or protocol…"/></div>
      <Select aria-label="Protocol" value={proto} onChange={v=>{setProto(v);setPage(1);}}><option value="">Any protocol</option><option value="http">HTTP</option><option value="socks5">SOCKS5</option><option value="socks4">SOCKS4</option></Select><span className="toolbar-spacer"/>
      <Button disabled={!picked.size||busy==='attach'} onClick={()=>use([...picked])}>Use selected ({picked.size})</Button>
      <Button disabled={!picked.size||!!busy} onClick={async()=>{if(confirm(`Remove ${picked.size} selected prox${picked.size===1?'y':'ies'}?`)&&await call('remove','/admin/proxies/remove',{urls:[...picked]},'Removed'))setPicked(new Set());}}><Trash2 size={14}/>Remove selected</Button>
      <Button disabled={!counts?.all||!!busy||working} onClick={()=>{if(confirm('Remove all saved proxies?'))void call('clear','/admin/proxies/remove',{all:true},'All saved proxies removed');}}>Remove all</Button></div>
    <div className="pool-tabs" role="tablist" aria-label="Proxy status" onKeyDown={tabKeys}>{poolTabs.map(([id,label])=><button key={id} role="tab" aria-selected={tab===id} tabIndex={tab===id?0:-1} className={tab===id?'on':''} onClick={()=>{setTab(id);setPage(1);}}>{label}<span className="count">{(counts?.[id]??0).toLocaleString()}</span></button>)}</div>
    {rows.length?<div className="table-wrap"><table><thead><tr><th style={{width:34}}><input type="checkbox" aria-label="Select all proxies on this page" checked={rows.length>0&&rows.every(r=>picked.has(r.url))} onChange={e=>setPicked(s=>{const n=new Set(s);for(const r of rows)e.target.checked?n.add(r.url):n.delete(r.url);return n;})}/></th><th>Proxy</th><th>Protocol</th><th className="numeric">1 · OpenCode API</th><th>2 · Model test</th><th/></tr></thead>
      <tbody>{rows.map(p=>{const [tone,label]=healthLabel[p.stage==='api'?'reachable':p.health.status]||healthLabel.untested;const resting=p.health.coolUntil>Date.now()&&p.health.status!=='exhausted';return <tr key={p.url} className={picked.has(p.url)?'selected-row':''}><td><input type="checkbox" aria-label={`Select ${p.host}:${p.port}`} checked={picked.has(p.url)} onChange={()=>toggle(p.url)}/></td><td className="mono">{p.host}:{p.port}</td><td><span className="protocol">{p.proto}</span></td><td className="numeric">{apiCell(p.health,gate)}</td>
        <td title={p.health.error||''}><Badge state={tone}>{label}{resting?' · resting':''}</Badge>{p.health.checkedAt>0&&<small className="muted">{p.health.deep?'Model request':'Reachability'} · {when(p.health.checkedAt)}</small>}</td>
        <td><Button disabled={busy==='attach'} onClick={()=>use([p.url])}>Use only this</Button></td></tr>;})}</tbody></table></div>
      :<Empty icon={Globe} title={error?'Pool unavailable':counts?.all?'Nothing matches these filters':'No saved proxies yet'}>{error||(counts?.all?'Try another tab or clear the filters.':'Press Find working proxies, or add your own list.')}</Empty>}
    {data&&data.total>0&&<div className="pager" role="navigation" aria-label="Pages"><span className="subtle">{((data.page-1)*data.pageSize+1).toLocaleString()}–{Math.min(data.page*data.pageSize,data.total).toLocaleString()} of {data.total.toLocaleString()}</span><span className="toolbar-spacer"/>
      <label className="subtle">Per page <Select aria-label="Rows per page" value={pageSize} onChange={v=>{setPageSize(+v);setPage(1);}}>{[25,50,100,200].map(n=><option key={n} value={n}>{n}</option>)}</Select></label>
      <Button disabled={data.page<=1} onClick={()=>setPage(data.page-1)}><ChevronLeft size={14}/>Prev</Button><span className="mono">Page {data.page} / {data.pages}</span><Button disabled={data.page>=data.pages} onClick={()=>setPage(data.page+1)}>Next<ChevronRight size={14}/></Button></div>}
    <div className="table-footnote"><AlertCircle size={14}/> Stage 1 loads the OpenCode API through every proxy (no model request). Only proxies faster than {gate} ms go on to stage 2, which sends one small real model request each (the free tier counts it).</div>
    {cfg&&<details className="disclosure pool-settings"><summary>Settings</summary>
      <div className="form-grid">
      <Field label="Speed limit for the API check (ms)" hint="Slower proxies are not kept or model-tested."><input type="number" min={200} max={30000} value={cfg.apiMaxLatencyMs??2500} onChange={e=>setCfg({...cfg,apiMaxLatencyMs:+e.target.value})}/></Field>
      <Field label="API check timeout (seconds)"><input type="number" min={2} max={30} value={cfg.apiTimeoutSec??8} onChange={e=>setCfg({...cfg,apiTimeoutSec:+e.target.value})}/></Field>
      <Field label="Re-test every (minutes)" hint="The pool is re-tested in the background while its route exists."><input type="number" min={5} max={1440} value={cfg.recheckMinutes} onChange={e=>setCfg({...cfg,recheckMinutes:+e.target.value})}/></Field>
      <Field label="Proxies to model-test" hint="Fastest API answers first, up to this many per run."><input type="number" min={1} max={500} value={cfg.maxTested} onChange={e=>setCfg({...cfg,maxTested:+e.target.value})}/></Field>
      <Field label="Tests in parallel"><input type="number" min={1} max={32} value={cfg.concurrency} onChange={e=>setCfg({...cfg,concurrency:+e.target.value})}/></Field>
      <Field label="Switch proxy up to (tries per request)" hint="When a proxy is refused or unreachable the request moves to the next one."><input type="number" min={1} max={8} value={cfg.retries} onChange={e=>setCfg({...cfg,retries:+e.target.value})}/></Field></div>
      <Toggle checked={cfg.deepTest} onChange={v=>setCfg({...cfg,deepTest:v})} label="Send a real model request when testing" detail="Proves a proxy works for models, not just for opening a connection."/>
      <Toggle checked={cfg.keepWarm!==false} onChange={v=>setCfg({...cfg,keepWarm:v})} label="Keep proxy connections warm" detail="Every 20 seconds, reads the model catalog (no allowance used) through the three proxies most likely to be used next, so the first chat request after a pause skips the time a slow proxy needs to connect, and a proxy that stops answering is taken out before a real request finds it dead."/>
      <Toggle checked={cfg.standby!==false} onChange={v=>setCfg({...cfg,standby:v})} label="Keep clean proxies on standby" detail="In the background, runs the same funnel on a few proxies at a time to find exits that still have Free allowance. When your exit is used up, requests move to one of these immediately."/>
      <div className="form-grid"><Field label="Clean exits to keep ready" hint="Different exit addresses only: proxies sharing an address share one allowance."><input type="number" min={1} max={20} value={cfg.standbyTarget??5} onChange={e=>setCfg({...cfg,standbyTarget:+e.target.value})}/></Field></div>
      <div className="form-actions"><Button variant="primary" onClick={()=>call('cfg','/admin/pool/settings',cfg,'Pool settings saved')}>Save settings</Button></div></details>}
  </section>;
}
// ---------- scoped API keys ----------
type KeyInfo=Snapshot['settings']['keys'][number];
type Draft={name:string;limit:string;rpm:string;tpm:string;budget:string;expires:string;models:string};
const toDraft=(k?:KeyInfo):Draft=>({name:k?.name||'',limit:String(k?.limit??4),rpm:k?.rpm?String(k.rpm):'',tpm:k?.tpm?String(k.tpm):'',budget:k?.budget?String(k.budget):'',expires:k?.expiresAt?new Date(k.expiresAt).toISOString().slice(0,10):'',models:(k?.models||[]).join(', ')});
const draftBody=(d:Draft)=>({name:d.name,limit:d.limit||4,rpm:d.rpm||0,tpm:d.tpm||0,budget:d.budget||0,expiresAt:d.expires?new Date(d.expires+'T23:59:59').getTime():0,models:d.models.split(',').map(x=>x.trim()).filter(Boolean)});
function KeyForm({initial,models,onSave,onCancel,saving,submit}:{initial?:KeyInfo;models:string[];onSave:(d:Draft)=>void;onCancel:()=>void;saving:boolean;submit:string}){
  const [d,setD]=useState(toDraft(initial));const set=(p:Partial<Draft>)=>setD(x=>({...x,...p}));const listId='key-models-'+(initial?.id||'new');
  return <form className="key-form" onSubmit={e=>{e.preventDefault();onSave(d);}}>
    <div className="form-grid three"><Field label="Name"><input required value={d.name} onChange={e=>set({name:e.target.value})} placeholder="Coding client"/></Field><Field label="Concurrent requests"><input type="number" min={1} max={64} value={d.limit} onChange={e=>set({limit:e.target.value})}/></Field><Field label="Expires" hint="Empty = never"><input type="date" value={d.expires} onChange={e=>set({expires:e.target.value})}/></Field>
      <Field label="Requests / minute" hint="Empty = unlimited"><input type="number" min={1} value={d.rpm} onChange={e=>set({rpm:e.target.value})}/></Field><Field label="Tokens / minute"><input type="number" min={1} value={d.tpm} onChange={e=>set({tpm:e.target.value})}/></Field><Field label="Total token budget"><input type="number" min={1} value={d.budget} onChange={e=>set({budget:e.target.value})}/></Field></div>
    <Field label="Allowed models" hint="Comma-separated model IDs. Empty allows every model (and auto)."><input list={listId} value={d.models} onChange={e=>set({models:e.target.value})} placeholder="opencode/big-pickle, opencode/glm-5.3-flash-free"/></Field><datalist id={listId}>{models.map(m=><option key={m} value={m}/>)}</datalist>
    <div className="form-actions"><Button onClick={onCancel}>Cancel</Button><Button type="submit" variant="primary" disabled={saving||!d.name.trim()}>{submit}</Button></div></form>;
}
export function KeysPanel({data,copy,notice,refresh}:{data:Snapshot;copy:(s:string)=>void;notice:Notice;refresh:()=>void}){
  const [editing,setEditing]=useState<string|null>(null);const [adding,setAdding]=useState(false);const [busy,setBusy]=useState(false);const [shown,setShown]=useState<string|null>(null);
  const modelIds=data.models.map(m=>m.id);
  async function send(path:string,body:unknown,ok:string){setBusy(true);try{const r=await api(path,body);notice(ok);refresh();return r;}catch(e){notice(errorOf(e),'error');}finally{setBusy(false);}}
  const limits=(k:KeyInfo)=>[`${k.limit} concurrent`,k.rpm?`${compact(k.rpm)}/min`:'',k.tpm?`${compact(k.tpm)} tokens/min`:'',k.expiresAt?`expires ${new Date(k.expiresAt).toLocaleDateString()}`:'',k.models?.length?`${k.models.length} model${k.models.length===1?'':'s'}`:''].filter(Boolean);
  return <section className="section-block form-section"><div className="section-top"><h2>Client API keys</h2><span className="subtle">Give each client its own key, limits and expiry</span></div>
    <div className="key-cards">{data.settings.keys.map(k=>{const spent=k.budget?Math.min(100,Math.round((k.used||0)/k.budget*100)):0;const expired=!!k.expiresAt&&k.expiresAt<Date.now();return <div key={k.id} className={`key-card ${k.enabled&&!expired?'':'off'}`}>
      <div className="key-head"><KeyRound size={18}/><div className="grow"><strong>{k.name}</strong><small>{limits(k).join(' · ')}</small></div>{!k.enabled&&<Badge state="neutral">Disabled</Badge>}{expired&&<Badge state="error">Expired</Badge>}
        <code>{shown===k.id?k.value:k.value.slice(0,10)+'••••••••'}</code>
        <button className="icon-button" aria-label={shown===k.id?'Hide key':'Show key'} onClick={()=>setShown(shown===k.id?null:k.id)}>{shown===k.id?<X size={14}/>:<Search size={14}/>}</button>
        <Button onClick={()=>copy(k.value)}><Copy size={14}/>Copy</Button><Button onClick={()=>setEditing(editing===k.id?null:k.id)}>{editing===k.id?'Close':'Edit'}</Button></div>
      <div className="key-usage"><span><strong>{compact(k.requests||0)}</strong> requests</span><span><strong>{compact(k.used||0)}</strong> tokens{k.budget?` of ${compact(k.budget)}`:''}</span><span>last used {when(k.lastUsed||0)}</span>{k.budget?<Progress value={spent} label={`${k.name} budget used`}/>:null}</div>
      {editing===k.id&&<>
        <KeyForm initial={k} models={modelIds} saving={busy} submit="Save changes" onCancel={()=>setEditing(null)} onSave={async d=>{if(await send('/admin/keys/update',{id:k.id,...draftBody(d)},'Key saved'))setEditing(null);}}/>
        <div className="key-tools"><Toggle checked={k.enabled} onChange={v=>send('/admin/keys/update',{id:k.id,enabled:v},v?'Key enabled':'Key disabled')} label="Key enabled"/>
          <Button onClick={()=>send('/admin/keys/update',{id:k.id,resetUsage:true},'Usage reset')}>Reset usage</Button><Button onClick={()=>{if(confirm('Create a new secret for this key? Clients using the old one stop working.'))void send('/admin/keys/update',{id:k.id,regenerate:true},'New secret created');}}><RefreshCw size={14}/>New secret</Button>
          <Button disabled={data.settings.keys.length===1} onClick={()=>{if(confirm(`Delete key "${k.name}"?`))void send('/admin/keys/delete',{id:k.id},'Key deleted');}}><Trash2 size={14}/>Delete</Button></div></>}
    </div>;})}</div>
    {adding?<><h3 className="subhead">New key</h3><KeyForm models={modelIds} saving={busy} submit="Create key" onCancel={()=>setAdding(false)} onSave={async d=>{if(await send('/admin/keys',draftBody(d),'API key created'))setAdding(false);}}/></>:<div className="form-actions left"><Button onClick={()=>setAdding(true)}><Plus size={15}/>New key</Button></div>}
  </section>;
}
// ---------- dashboard security + notifications settings ----------
export function SecurityPanel({serverMode,notice,onSignedOut}:{serverMode:boolean;notice:Notice;onSignedOut:()=>void}){
  const [form,setForm]=useState({current:'',next:'',again:''});const [busy,setBusy]=useState(false);const [managed,setManaged]=useState(false);
  useEffect(()=>{api('/admin/whoami').then(j=>setManaged(!!j.passwordManagedByEnv)).catch(()=>{});},[]);
  if(!serverMode)return null;
  async function change(e:FormEvent){e.preventDefault();if(form.next!==form.again)return notice('The new passwords do not match','error');setBusy(true);try{await api('/admin/password',{current:form.current,next:form.next});notice('Password changed');setForm({current:'',next:'',again:''});}catch(err){notice(errorOf(err),'error');}finally{setBusy(false);}}
  return <section className="section-block form-section"><div className="section-title"><Lock size={19}/><h2>Dashboard security</h2></div>
    {managed?<p className="muted">The dashboard password is set by the <code>POLYGATE_ADMIN_PASSWORD</code> environment variable. Change it there and restart the service.</p>
      :<form onSubmit={change}><div className="form-grid three"><Field label="Current password"><input type="password" autoComplete="current-password" value={form.current} onChange={e=>setForm({...form,current:e.target.value})}/></Field><Field label="New password" hint="At least 12 characters."><input type="password" autoComplete="new-password" minLength={12} value={form.next} onChange={e=>setForm({...form,next:e.target.value})}/></Field><Field label="Repeat new password"><input type="password" autoComplete="new-password" value={form.again} onChange={e=>setForm({...form,again:e.target.value})}/></Field></div>
        <div className="form-actions"><Button type="submit" variant="primary" disabled={busy||!form.current||form.next.length<12}>Change password</Button></div></form>}
    <div className="form-actions left"><Button onClick={async()=>{try{await api('/admin/signout-all',{});onSignedOut();}catch(e){notice(errorOf(e),'error');}}}><LogOut size={14}/>Sign out everywhere</Button></div></section>;
}
export function NotifySettings({data,notice,refresh}:{data:Snapshot;notice:Notice;refresh:()=>void}){
  const [url,setUrl]=useState(data.settings.notify?.webhookUrl||'');const [level,setLevel]=useState(data.settings.notify?.minLevel||'warning');const [busy,setBusy]=useState(false);
  async function save(test=false){setBusy(true);try{await api('/admin/notify/settings',{webhookUrl:url,minLevel:level});if(test){await api('/admin/notify/test',{});notice('Test notification sent');}else notice('Notification settings saved');refresh();}catch(e){notice(errorOf(e),'error');}finally{setBusy(false);}}
  return <section className="section-block form-section"><div className="section-title"><Bell size={19}/><h2>Alerts</h2></div><p className="muted">Notices appear in the bell menu. Add a Discord, Slack or generic webhook to be told when routes, models or WARP go down.</p>
    <div className="form-grid"><Field label="Webhook URL" hint="Discord, Slack, or any endpoint that accepts JSON."><input type="url" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://discord.com/api/webhooks/…"/></Field><Field label="Send alerts from level"><Select value={level} onChange={v=>setLevel(v as typeof level)}><option value="info">Everything</option><option value="success">Recoveries and up</option><option value="warning">Warnings and errors</option><option value="error">Errors only</option></Select></Field></div>
    <div className="form-actions"><Button disabled={busy||!url} onClick={()=>save(true)}>Save &amp; send test</Button><Button variant="primary" disabled={busy} onClick={()=>save(false)}>Save</Button></div></section>;
}
// ---------- HTTPS ----------
type HttpsInfo={mode:string;domain:string;ip:string;email:string;port:number;httpPort:number;redirect:boolean;staging:boolean;active:boolean;issuedAt:number;expiresAt:number;daysLeft:number;issuer:string;lastError:string;publicIp:string;url:string;httpUrl?:string;job:{running:boolean;steps:{t:number;msg:string;level:string}[];error:string;url:string;finishedAt:number}};
export function HttpsPanel({serverMode,notice}:{serverMode:boolean;notice:Notice}){
  const {data:s,reload,error}=usePoll<HttpsInfo>('/admin/https',2500,serverMode);const [form,setForm]=useState({mode:'ip',domain:'',ip:'',email:'',port:443,httpPort:80,redirect:true,staging:false,certPem:'',keyPem:''});const [dirty,setDirty]=useState(false);const [busy,setBusy]=useState(false);
  const [handoffUrl,setHandoffUrl]=useState('');
  useEffect(()=>{if(s&&!dirty)setForm(f=>({...f,mode:s.mode==='off'?'ip':s.mode,domain:s.domain,ip:s.ip,email:s.email,port:s.port,httpPort:s.httpPort,redirect:s.redirect,staging:s.staging}));},[s,dirty]);
  if(!serverMode)return null;
  const edit=(p:Partial<typeof form>)=>{setDirty(true);setForm(f=>({...f,...p}));};
  async function apply(){setBusy(true);try{const result=await api('/admin/https/apply',form);setHandoffUrl(result.url||'');setForm(f=>({...f,certPem:'',keyPem:''}));notice('Certificate setup started. Continue at the new address once it is ready.');setDirty(false);await reload();}catch(e){notice(errorOf(e),'error');}finally{setBusy(false);}}
  async function call(path:string,ok:string){setBusy(true);try{const result=await api(path,{});if(path.endsWith('/disable')&&result.httpUrl){try{const u=new URL(result.httpUrl);if(['0.0.0.0','127.0.0.1','[::]','[::1]','localhost'].includes(u.hostname))u.hostname=location.hostname;setHandoffUrl(u.toString());}catch{/* an unparsable address (for example ':::4317') is not offered as a link */}}notice(ok);await reload();}catch(e){notice(errorOf(e),'error');}finally{setBusy(false);}}
  const running=!!s?.job.running;const here=location.origin+'/';const moved=!!s?.url&&s.active&&s.url!==here&&!!s.job.url;
  return <section className="section-block form-section https-panel"><div className="section-top"><div className="section-title"><ShieldCheck size={19}/><h2>HTTPS</h2></div>{s&&<Badge state={s.active?'healthy':'neutral'}>{s.active?`Active · ${s.daysLeft} day${s.daysLeft===1?'':'s'} left`:'Off'}</Badge>}</div>
    <p className="muted">Serve the dashboard and the API over HTTPS directly from Polygate — no reverse proxy. Use your own domain, or just this server's IP address.</p>
    {error&&!s&&<div className="error-banner" role="alert"><AlertCircle size={16}/><span>{error}</span></div>}
    {s?.active&&<div className="https-status"><div><span>Address</span><strong className="mono">{s.url}</strong></div><div><span>Certificate</span><strong>{s.mode==='custom'?'Your certificate':s.mode==='ip'?"Let's Encrypt (IP, ~6 days, renews itself)":"Let's Encrypt (renews itself)"}</strong></div><div><span>Issuer</span><strong>{s.issuer||'—'}</strong></div><div><span>Expires</span><strong>{new Date(s.expiresAt).toLocaleString()}</strong></div></div>}
    {s?.lastError&&!running&&<div className="error-banner" role="alert"><AlertCircle size={16}/><span>{s.lastError}</span></div>}
    <div className="seg" role="tablist" aria-label="HTTPS method" onKeyDown={tabKeys}>{([['ip','Server IP address'],['domain','My domain'],['custom','Own certificate']] as const).map(([v,l])=><button key={v} role="tab" aria-selected={form.mode===v} tabIndex={form.mode===v?0:-1} className={form.mode===v?'on':''} onClick={()=>edit({mode:v})}>{l}</button>)}</div>
    {form.mode==='ip'&&<div className="form-grid"><Field label="Public IP address" hint={s?.publicIp?`Detected: ${s.publicIp}. Leave empty to use it.`:'Leave empty to detect it.'}><input value={form.ip} onChange={e=>edit({ip:e.target.value})} placeholder={s?.publicIp||'203.0.113.10'}/></Field><p className="muted note-text">Let's Encrypt issues short-lived (about 6 days) certificates for IP addresses and Polygate renews them automatically. Browsers trust them like any other certificate. Port 80 must be reachable from the internet.</p></div>}
    {form.mode==='domain'&&<div className="form-grid"><Field label="Domain" hint={`Its A record must point to ${s?.publicIp||'this server'} before you continue.`}><input value={form.domain} onChange={e=>edit({domain:e.target.value})} placeholder="panel.example.com"/></Field><Field label="E-mail (optional)" hint="Let's Encrypt sends expiry warnings here."><input type="email" value={form.email} onChange={e=>edit({email:e.target.value})}/></Field></div>}
    {form.mode==='custom'&&<><Field label="Certificate chain (PEM)"><textarea rows={5} value={form.certPem} onChange={e=>edit({certPem:e.target.value})} placeholder="-----BEGIN CERTIFICATE-----"/></Field><Field label="Private key (PEM)"><textarea rows={4} value={form.keyPem} onChange={e=>edit({keyPem:e.target.value})} placeholder="-----BEGIN PRIVATE KEY-----"/></Field></>}
    <details className="disclosure"><summary>Ports &amp; advanced</summary><div className="form-grid"><Field label="HTTPS port" hint="Where the dashboard and API listen."><input type="number" min={1} max={65535} value={form.port} onChange={e=>edit({port:+e.target.value})}/></Field><Field label="HTTP port for validation" hint="Let's Encrypt connects to port 80. Change this only if you forward 80 to another port."><input type="number" min={1} max={65535} value={form.httpPort} onChange={e=>edit({httpPort:+e.target.value})}/></Field></div>
      <Toggle checked={form.redirect} onChange={v=>edit({redirect:v})} label="Redirect HTTP to HTTPS" detail="Visitors on the HTTP port are sent to the secure address."/><Toggle checked={form.staging} onChange={v=>edit({staging:v})} label="Use the Let's Encrypt test server" detail="For trying the setup without hitting production rate limits. Browsers will not trust these certificates."/></details>
    {(running||s?.job.steps.length)?<ol className="steps">{s!.job.steps.map((st,i)=><li key={i} className={st.level}><i/>{st.msg}</li>)}{running&&<li className="info"><Loader2 size={13} className="spin"/>Working…</li>}</ol>:null}
    {(moved||handoffUrl)&&<div className="install-box"><strong>New dashboard address</strong><p className="muted">Changing HTTPS can disconnect this page from the old listener. When setup completes, continue at the new address and sign in again.</p><a className="button primary" href={s?.job.url||handoffUrl}><ExternalLink size={14}/>Open {s?.job.url||handoffUrl}</a></div>}
    <div className="form-actions"><Button disabled={busy||running||!s?.active||s.mode==='custom'} onClick={()=>call('/admin/https/renew','Renewing the certificate…')}><RefreshCw size={14}/>Renew now</Button><Button disabled={busy||running||!s?.active} onClick={()=>{if(confirm('Turn HTTPS off? The dashboard returns to plain HTTP.'))void call('/admin/https/disable','HTTPS turned off');}}>Turn off</Button>
      <Button variant="primary" disabled={busy||running||(form.mode==='domain'&&!form.domain)||(form.mode==='custom'&&(!form.certPem||!form.keyPem))} onClick={apply}>{running?<Loader2 size={15} className="spin"/>:<Shield size={15}/>}{s?.active?'Replace certificate':'Get certificate & enable HTTPS'}</Button></div>
  </section>;
}
// ---------- performance ----------
type Metrics={rpm:number;tpm:number;p50:number;p95:number;p99:number;avgMs:number;successRate:number|null;tokensPerSecond:number;requests:number;errors:number;hourly:{hour:number;requests:number;errors:number;tokens:number}[];byModel:{model:string;requests:number;errors:number;tokens:number;avgMs:number}[];byRoute:{route:string;requests:number;errors:number;avgMs:number}[]};
export function MetricsPanel(){
  const {data:m}=usePoll<Metrics>('/admin/metrics',10000);if(!m)return null;
  const hours=Array.from({length:24},(_,i)=>{const h=Math.floor(Date.now()/3600000)-23+i;return m.hourly.find(x=>x.hour===h*3600000)||{hour:h*3600000,requests:0,errors:0,tokens:0};});const peak=Math.max(1,...hours.map(h=>h.requests));
  return <section className="section-block metrics-panel"><div className="section-top"><div className="section-title"><Gauge size={19}/><h2>Performance</h2></div><span className="subtle">Last 24 hours</span></div>
    <div className="metric-line"><div><span>Requests / min</span><strong>{m.rpm}</strong></div><div><span>Tokens / min</span><strong>{compact(m.tpm)}</strong></div><div><span>Median latency</span><strong>{ms(m.p50)}</strong></div><div><span>95th percentile</span><strong>{ms(m.p95)}</strong></div><div><span>Output speed</span><strong>{m.tokensPerSecond?`${m.tokensPerSecond} tok/s`:'—'}</strong></div></div>
    <div className="hour-bars" aria-label="Requests per hour">{hours.map(h=><div key={h.hour} title={`${new Date(h.hour).getHours()}:00 · ${h.requests} requests, ${h.errors} failed`}><i className={h.errors?'bad':''} style={{height:Math.max(4,h.requests/peak*100)+'%'}}/></div>)}</div>
    <div className="metric-tables"><div><h3>Busiest models</h3>{m.byModel.length?<table><tbody>{m.byModel.slice(0,6).map(r=><tr key={r.model}><td className="truncate" title={r.model}>{r.model}</td><td className="numeric">{r.requests}</td><td className="numeric mono">{ms(r.avgMs)}</td><td className="numeric">{r.errors?<span className="red">{r.errors} failed</span>:<span className="muted">ok</span>}</td></tr>)}</tbody></table>:<p className="muted">No traffic yet.</p>}</div>
      <div><h3>Routes used</h3>{m.byRoute.length?<table><tbody>{m.byRoute.slice(0,6).map(r=><tr key={r.route}><td className="truncate">{r.route}</td><td className="numeric">{r.requests}</td><td className="numeric mono">{ms(r.avgMs)}</td><td className="numeric">{r.errors?<span className="red">{r.errors} failed</span>:<span className="muted">ok</span>}</td></tr>)}</tbody></table>:<p className="muted">No traffic yet.</p>}</div></div></section>;
}
export {Check,Trash2,Plus,Zap,CheckCircle2,Shield,time};

// ---------- request shape ----------
const kv=(o:Record<string,any>|undefined)=>Object.entries(o||{}).filter(([,v])=>v!==undefined&&v!==null&&v!=='');
function Facts({title,items}:{title:string;items:[string,any][]}){return <div className="detail-facts"><h3>{title}</h3>{items.length?<dl>{items.map(([k,v])=><div key={k}><dt>{k}</dt><dd className="mono">{typeof v==='object'?JSON.stringify(v):String(v)}</dd></div>)}</dl>:<p className="subtle">Nothing recorded.</p>}</div>;}
const bodyFacts=(b:any):[string,any][]=>b?[['size',b.bytes?`${b.bytes.toLocaleString()} bytes`:''],['model',b.model],['stream',b.stream],['max tokens',b.maxTokens],['reasoning effort',b.reasoningEffort],['tool choice',b.toolChoice],['messages',b.messages],['roles',b.roles],['system prompt',b.systemChars!==undefined?`${b.systemChars.toLocaleString()} chars`:''],['tools',b.tools?`${b.tools} (${(b.toolSchemaBytes||0).toLocaleString()} bytes of schema)`:0],['body fields',(b.keys||[]).join(', ')],['<env> blocks',b.env?`${b.env.blocks} total, ${b.env.blocksWithWorkingDirectory} with a working directory`:''],['"Working directory:" anywhere in system prompt',b.env?.workingDirectoryAnywhereInSystem]].filter(([,v])=>v!==''&&v!==undefined&&v!==null) as [string,any][]:[];
const headerFacts=(h:any):[string,any][]=>h?[['authorization',h.auth],['header names',(h.names||[]).join(', ')],...kv(h.values),...kv(h.identity)] as [string,any][]:[];
export function RequestDetail({id,onClose}:{id:string;onClose:()=>void}){
  const [row,setRow]=useState<any>(null);const [error,setError]=useState('');const [copied,setCopied]=useState(false);
  useEffect(()=>{let live=true;setRow(null);setError('');api('/admin/request?id='+encodeURIComponent(id)).then(d=>{if(live)setRow(d);}).catch(e=>{if(live)setError(errorOf(e));});return()=>{live=false;};},[id]);
  const d=row?.detail;const attempt=d?.attempts?.[0];
  async function copy(){try{await navigator.clipboard.writeText(JSON.stringify(row,null,2));setCopied(true);setTimeout(()=>setCopied(false),1500);}catch{}}
  return <section className="section-block form-section request-detail"><div className="section-top"><h2>Request shape</h2><span className="toolbar-spacer"/>{row&&<Button onClick={copy}>{copied?<Check size={14}/>:<Copy size={14}/>}{copied?'Copied':'Copy JSON'}</Button>}<Button onClick={onClose}><X size={14}/>Close</Button></div>
    {error&&<p className="field-error">{error}</p>}{!row&&!error&&<p className="subtle">Loading…</p>}
    {row&&!d&&<p className="subtle">No shape was recorded for this request. Requests rejected before reaching a provider are not recorded.</p>}
    {d&&<>
      <div className="detail-grid">
        <Facts title="Outcome" items={[['status',row.status],['model',row.model],['protocol',row.protocol],['duration',ms(row.ms)],['upstream answer',attempt?.response?.status??attempt?.error??'none'],['model cooldowns',d.cooldownsEnabled?'on':'off'],['error',row.error?row.error.slice(0,300):'']].filter(([,v])=>v!=='') as [string,any][]}/>
        <Facts title="Network path" items={[['route',`${d.route?.name||'—'} (${d.route?.kind||'?'})`],...(d.egress?[['egress ip',d.egress.ip],['datacenter',d.egress.colo],['country',d.egress.loc],['WARP as the CDN sees it',d.egress.warp],['http',d.egress.http]] as [string,any][]:[['egress','not looked up (only done after a failure)']] as [string,any][])]}/>
      </div>
      <div className="detail-grid">
        <Facts title="What your client sent" items={[...bodyFacts(d.client?.body),...headerFacts(d.client?.headers)]}/>
        <Facts title={`What reached the provider${attempt?.url?' · '+attempt.url:''}`} items={attempt?[...bodyFacts(attempt.body),...headerFacts(attempt.headers)]:[]}/>
      </div>
      {attempt?.response&&<Facts title="Provider response headers" items={[['header names',(attempt.response.headers?.names||[]).join(', ')],...kv(attempt.response.headers?.values)] as [string,any][]}/>}
      {(d.attempts?.length||0)>1&&<p className="subtle">{d.attempts.length} attempts were made; Copy JSON includes all of them.</p>}
    </>}
  </section>;
}
