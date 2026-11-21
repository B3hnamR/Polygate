import {useRef,useState} from 'react';
import {AlertCircle,Check,ClipboardPaste,FileUp,FlaskConical,Info,Loader2,Pencil,Power,RefreshCw,Route as RouteIcon,ShieldCheck,Trash2,X} from 'lucide-react';
import {api} from './api';
import {Badge,Button,Field,Select,Toggle,usePoll} from './ui';
import {useConfirm} from './confirm';
import {Dialog} from './mcp';
import type {Notice} from './panels';

// The WireGuard route (backend/wireguard.ts): every imported .conf file is a WireGuard or AmneziaWG tunnel of its own, run by the bundled
// wireproxy-awg, and together they are one route that takes turns or stays on one config, with the same options as Psiphon and Surfshark.
type Config={id:string;name:string;enabled:boolean;addedAt:number;endpoint:string;address:string;mtu:number;amnezia:boolean;peers:number;
  state:'stopped'|'starting'|'ready'|'failed';port:number;exitIp:string;since:number;usedUpUntil:number;kiloUntil:number;checking:''|'opencode'|'kilo'|'other';error:string};
type WireguardInfo={installed:boolean;problem:string;platform:string;busy:string;lastError:string;running:boolean;live:number;
  config:{enabled:boolean;autoStart:boolean;mode:'spread'|'single';pinned:string;skip:boolean;renew:boolean};
  configs:Config[];spent:number;route:{exists:boolean;enabled:boolean;inUse:boolean}};
type ImportResult={added:{id:string;name:string;renamedFrom?:string;amnezia:boolean;endpoint:string}[];failed:{name:string;error:string}[];summary:string};
const stateLabel:Record<Config['state'],[string,string]>={ready:['healthy','Connected'],starting:['neutral','Connecting'],failed:['error','Failed'],stopped:['neutral','Not running']};
const utc=(t:number)=>new Date(t).toISOString().slice(11,16)+' UTC';
const MAX_BYTES=256*1024;

export function WireguardPanel({notice,onChanged}:{notice:Notice;onChanged:()=>void}){
  const {data:s,reload,error}=usePoll<WireguardInfo>('/admin/wireguard/status',3000);
  const [busy,setBusy]=useState('');const [dropping,setDropping]=useState(false);const [pasting,setPasting]=useState(false);
  const [pasteName,setPasteName]=useState('');const [pasteText,setPasteText]=useState('');const [report,setReport]=useState<ImportResult|null>(null);
  const [editing,setEditing]=useState<{id:string;name:string;text:string}|null>(null);
  const picker=useRef<HTMLInputElement>(null);const {confirm,dialog}=useConfirm();
  async function run(name:string,path:string,body:unknown={},done=''){
    setBusy(name);
    try{const r:any=await api(path,body);if(done)notice(done);await reload();onChanged();return r;}
    catch(e){notice(String((e as Error)?.message||e),'error');await reload();return undefined;}
    finally{setBusy('');}
  }
  async function sendImport(files:{name:string;text:string}[]){
    setBusy('import');setReport(null);
    try{const r=await api('/admin/wireguard/import',{files}) as ImportResult;setReport(r);notice(r.summary,r.added.length?'ok':'error');await reload();onChanged();return r.added.length>0;}
    catch(e){notice(String((e as Error)?.message||e),'error');return false;}
    finally{setBusy('');}
  }
  async function importFiles(list:File[]){
    if(!list.length)return;
    const files:{name:string;text:string}[]=[];const tooBig:string[]=[];
    for(const f of list){if(f.size>MAX_BYTES){tooBig.push(f.name);continue;}files.push({name:f.name,text:await f.text()});}
    if(tooBig.length)notice(`${tooBig.join(', ')}: larger than 256 KiB, so not imported`,'error');
    if(files.length)await sendImport(files);
  }
  async function importPaste(){
    const text=pasteText.trim();if(!text)return;
    if(await sendImport([{name:pasteName.trim()||'Pasted WireGuard config',text}])){setPasting(false);setPasteName('');setPasteText('');}
  }
  async function openEdit(c:Config){
    setBusy('edit-'+c.id);
    try{const r:any=await api('/admin/wireguard/config/text',{id:c.id});setEditing({id:c.id,name:c.name,text:r.text});}
    catch(e){notice(String((e as Error)?.message||e),'error');}
    finally{setBusy('');}
  }
  async function saveEdit(){
    if(!editing)return;
    setBusy('save');
    try{await api('/admin/wireguard/config',{id:editing.id,name:editing.name,text:editing.text});notice(`${editing.name.trim()||'WireGuard config'} saved`);setEditing(null);await reload();onChanged();}
    catch(e){notice(String((e as Error)?.message||e),'error');}
    finally{setBusy('');}
  }
  async function remove(c:Config){
    if(await confirm(<>Delete <strong>{c.name}</strong>? Its .conf file is removed with it, and requests can no longer go through it.</>,{title:'Delete WireGuard config',confirm:'Delete config'}))await run('remove-'+c.id,'/admin/wireguard/config/remove',{id:c.id},`${c.name} removed`);
  }
  if(!s)return <section className="section-block form-section psiphon-panel"><div className="section-top"><div className="section-title"><ShieldCheck size={19}/><h2>WireGuard</h2></div></div>
    {error?<div className="error-banner" role="alert"><AlertCircle size={16}/><span>{error}</span><Button onClick={()=>void reload()}>Try again</Button></div>:<div className="loading"><Loader2 className="spin"/> Checking WireGuard…</div>}</section>;
  const c=s.config;const working=!!busy||!!s.busy;const enabled=s.configs.filter(x=>x.enabled);
  const down=enabled.filter(x=>x.state==='stopped'||x.state==='failed').length;
  const starting=enabled.filter(x=>x.state==='starting').length;
  const [tone,label]=!s.installed?['neutral','Not available']:!c.enabled?['neutral','Off']:s.live?['healthy',`${s.live} of ${enabled.length} connected`]:starting?['cooldown','Connecting']:s.running?['error','Not connected']:['neutral','Not running'];
  const connectLabel=!s.running?'Connect':down?`Restart ${down} stopped config${down>1?'s':''}`:s.live<enabled.length?'Connecting':'Connected';
  const nameOf=(id:string)=>s.configs.find(x=>x.id===id)?.name||id;
  const connect=()=>run('connect','/admin/wireguard/connect',{},'WireGuard is connecting');
  return <section className="section-block form-section psiphon-panel wireguard-panel">
    {dialog}
    <div className="section-top"><div className="section-title"><ShieldCheck size={19}/><h2>WireGuard</h2></div><Badge state={tone}>{label}</Badge></div>
    <p className="muted">Send model traffic through your own WireGuard or AmneziaWG configs. Import the <b>.conf</b> files your provider gave you: Polygate runs one client for each file, and together they are the route <b>WireGuard</b>, taking turns or staying on one. The client keeps the tunnel to itself: no network adapter, route or DNS changes on this computer, and only the gateway's own requests use it.</p>
    {!s.installed&&<div className="error-banner" role="alert"><AlertCircle size={16}/><span>{s.problem}</span></div>}

    <div className={`wg-import${dropping?' dropping':''}`} onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();setDropping(true);}}} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setDropping(false);}} onDrop={e=>{e.preventDefault();setDropping(false);void importFiles(Array.from(e.dataTransfer.files));}}>
      <FileUp size={24}/>
      <div><strong>Import WireGuard configs</strong><small>Drop one or more .conf files here, or choose them. Each file becomes an exit of its own; duplicate names get -2, -3. AmneziaWG fields are kept exactly as written.</small></div>
      <div className="token-row">
        <Button disabled={working} onClick={()=>picker.current?.click()}>{busy==='import'?<Loader2 size={15} className="spin"/>:<FileUp size={15}/>}Choose files</Button>
        <Button disabled={working} onClick={()=>setPasting(!pasting)}>{pasting?<X size={15}/>:<ClipboardPaste size={15}/>}{pasting?'Cancel paste':'Paste a config'}</Button>
      </div>
      <input ref={picker} hidden type="file" multiple accept=".conf" aria-label="Choose WireGuard .conf files" onChange={e=>{void importFiles(Array.from(e.target.files||[]));e.target.value='';}}/>
    </div>

    {pasting&&<form className="wg-paste" autoComplete="off" onSubmit={e=>{e.preventDefault();if(pasteText.trim()&&!working)void importPaste();}}>
      <Field label="Name (optional)"><input value={pasteName} onChange={e=>setPasteName(e.target.value)} placeholder="For example: home router" maxLength={60}/></Field>
      <Field label="Configuration" hint="Paste the whole [Interface] and [Peer] sections. The file is stored only in the encrypted settings."><textarea className="mono" rows={9} value={pasteText} onChange={e=>setPasteText(e.target.value)} placeholder="[Interface]&#10;PrivateKey = …&#10;Address = 10.0.0.2/32&#10;&#10;[Peer]&#10;PublicKey = …&#10;Endpoint = vpn.example.com:51820&#10;AllowedIPs = 0.0.0.0/0, ::/0" spellCheck={false}/></Field>
      <div className="form-actions"><Button disabled={working} onClick={()=>{setPasting(false);setPasteName('');setPasteText('');}}>Cancel</Button><Button variant="primary" type="submit" disabled={working||!pasteText.trim()}>{busy==='import'?<Loader2 size={15} className="spin"/>:<ClipboardPaste size={15}/>}Import config</Button></div>
    </form>}

    {report&&<div className="wg-report" role="status">
      <p><strong>{report.summary}</strong></p>
      {report.added.length>0&&<ul>{report.added.map(a=><li key={a.id}><Check size={14}/><span><b>{a.name}</b>{a.renamedFrom?<small> (renamed from {a.renamedFrom})</small>:null} · <span className="mono">{a.endpoint}</span>{a.amnezia?' · AmneziaWG':''}</span></li>)}</ul>}
      {report.failed.length>0&&<ul className="wg-failed">{report.failed.map((f,i)=><li key={f.name+i}><AlertCircle size={14}/><span><b>{f.name}</b> · {f.error}</span></li>)}</ul>}
      <Button onClick={()=>setReport(null)}>Dismiss</Button>
    </div>}

    <div className="button-row">
      <Button variant="primary" disabled={working||!s.installed||!c.enabled||!enabled.length||(s.running&&!down)} onClick={()=>void connect()}>{busy==='connect'?<Loader2 size={15} className="spin"/>:<Power size={15}/>}{connectLabel}</Button>
      <Button disabled={working||!s.running} onClick={()=>run('disconnect','/admin/wireguard/disconnect',{},'WireGuard disconnected')}>Disconnect</Button>
      {s.route.exists&&s.route.enabled&&!s.route.inUse&&<Button disabled={working} onClick={()=>run('use','/admin/settings',{routeId:'wireguard'},'WireGuard is now the route in use')}><RouteIcon size={15}/>Make it the route in use</Button>}
      {s.route.inUse&&<span className="psi-inuse"><RouteIcon size={15}/>Route in use</span>}
    </div>
    {s.lastError&&!working&&<div className="error-banner" role="alert"><AlertCircle size={16}/><span>{s.lastError}</span></div>}

    {s.configs.length>0?<div className="psi-rows">{s.configs.map(cfg=>{const pinned=c.mode==='single'&&c.pinned===cfg.id;
      const [t,l]=cfg.state!=='ready'?stateLabel[cfg.state]:cfg.checking?['neutral',`Checking with ${cfg.checking==='kilo'?'Kilo':'OpenCode'}`]:cfg.usedUpUntil?['cooldown',`Used up until ${utc(cfg.usedUpUntil)}`]:stateLabel[cfg.state];
      return <div key={cfg.id} className={`psi-row${pinned?' pinned':''}`}>
        <div className="psi-name"><strong>{cfg.name}{pinned?' · the one in use':''}</strong><small className="mono">{cfg.endpoint||'No endpoint'}{cfg.amnezia?' · AmneziaWG':''}</small><small>{cfg.address||'No address'} · MTU {cfg.mtu}{cfg.enabled?'':' · off'}</small></div>
        <div className="psi-exit"><span className="mono">{cfg.exitIp||'-'}</span><small>{cfg.error||(cfg.state==='ready'&&!cfg.exitIp?'Finding the exit address…':cfg.state==='starting'?'Connecting through WireGuard…':cfg.state==='ready'?`Connected ${cfg.since?'since '+new Date(cfg.since).toLocaleTimeString():''}`:'')}{cfg.kiloUntil?<> · Kilo limit until {utc(cfg.kiloUntil)}</>:null}</small></div>
        <Badge state={t}>{l}</Badge>
        <div className="psi-actions">
          {c.mode==='single'&&!pinned&&<Button disabled={working||!cfg.enabled||cfg.state!=='ready'} onClick={()=>run('pin-'+cfg.id,'/admin/wireguard/settings',{pinned:cfg.id},`WireGuard stays on ${cfg.name}`)}>Stay on this</Button>}
          <Button disabled={working||cfg.state==='stopped'||!cfg.enabled} title="Reconnect this config; its server may hand out another exit address" onClick={()=>run('renew-'+cfg.id,'/admin/wireguard/renew',{id:cfg.id},`${cfg.name} is reconnecting`)}>{busy==='renew-'+cfg.id?<Loader2 size={15} className="spin"/>:<RefreshCw size={15}/>}New address</Button>
          <Button disabled={working||cfg.state!=='ready'} title="Send a small OpenCode Free request through exactly this config" onClick={async()=>{const r=await run('test-'+cfg.id,'/admin/routes/test',{id:'wireguard:'+cfg.id});if(r?.summary)notice(r.summary,r.ok?'ok':'error');}}>{busy==='test-'+cfg.id?<Loader2 size={15} className="spin"/>:<FlaskConical size={15}/>}Test</Button>
          <Button disabled={working} title="Rename this config or edit its file" onClick={()=>void openEdit(cfg)}>{busy==='edit-'+cfg.id?<Loader2 size={15} className="spin"/>:<Pencil size={15}/>}Edit</Button>
          <Button disabled={working} onClick={()=>run('toggle-'+cfg.id,'/admin/wireguard/config/toggle',{id:cfg.id,enabled:!cfg.enabled},`${cfg.name} is ${cfg.enabled?'off':'on'}`)}>{cfg.enabled?'Turn off':'Turn on'}</Button>
          <button className="icon-button danger" aria-label={'Delete WireGuard config '+cfg.name} disabled={working} onClick={()=>void remove(cfg)}><Trash2 size={15}/></button>
        </div>
      </div>;})}</div>
      :<p className="subtle">No config imported yet. Drop a .conf file above, or paste one.</p>}

    {s.configs.length>0&&<>
      <div className="psi-mode" role="radiogroup" aria-label="How WireGuard picks a config">
        <label className={c.mode==='spread'?'on':''}><input type="radio" name="wg-mode" checked={c.mode==='spread'} onChange={()=>void run('mode','/admin/wireguard/settings',{mode:'spread'},'WireGuard takes turns over its configs')}/><span><strong>Take turns</strong><small>Each request uses the next connected config (round robin).</small></span></label>
        <label className={c.mode==='single'?'on':''}><input type="radio" name="wg-mode" checked={c.mode==='single'} onChange={()=>void run('mode','/admin/wireguard/settings',{mode:'single',pinned:c.pinned||enabled[0]?.id||''},'WireGuard stays on one config')}/><span><strong>Stay on one config</strong><small>Every request uses the same tunnel until you choose another.</small></span></label>
      </div>
      {c.mode==='single'&&enabled.length>0&&<div className="psi-pin"><span>Config in use</span><Select aria-label="Config in use" value={c.pinned||enabled[0].id} onChange={v=>void run('pin','/admin/wireguard/settings',{pinned:v},`WireGuard stays on ${nameOf(v)}`)}>{enabled.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</Select></div>}

      <Toggle checked={c.skip} onChange={skip=>void run('skip','/admin/wireguard/settings',{skip},skip?'A used-up exit is skipped':'A used-up exit returns its error')} label="Skip a used-up exit" detail={c.mode==='single'?'With one config, a used-up exit hands the request to your backup exits (Routing policy).':'When OpenCode says an exit has used up its free allowance, the request goes on through the next config.'}/>
      <Toggle checked={c.renew} onChange={renew=>void run('renew','/admin/wireguard/settings',{renew},renew?'Used-up configs reconnect and are checked first':'Used-up configs keep their connection')} label="Get a new address when one is used up, and check it" detail="When OpenCode Free or Kilo says an exit is used up, that config reconnects. Most providers hand out a fresh exit address on a new connection; a config that always gets the same one keeps being skipped. Polygate sends one small request to that same provider through it, and puts it back in turn for that provider once it answers. At most three reconnects an hour per config."/>
      <Toggle checked={c.autoStart} onChange={autoStart=>void run('auto','/admin/wireguard/settings',{autoStart},autoStart?'WireGuard connects when Polygate starts':'WireGuard waits for Connect')} label="Connect when Polygate starts" detail="Brings the enabled configs up after a restart or reboot. While WireGuard is the route in use it always reconnects, so requests are not left without their route."/>
      <Toggle checked={c.enabled} onChange={enabled=>void run('enabled','/admin/wireguard/settings',{enabled},enabled?'WireGuard is on':'WireGuard is off')} label="WireGuard enabled" detail="Turn it off to stop every config and take the WireGuard route out of use."/>
    </>}
    <p className="muted fine-print"><Info size={14}/> Runs your own configs with wireproxy-awg 1.0.18 (ISC licence), which supports plain WireGuard and AmneziaWG 1.0–3.1 ({s.platform}). Imported files are kept in the encrypted settings, are part of your backup, and are written to a temporary file only while a config starts. Polygate is not affiliated with the networks these files connect to.{s.spent?` ${s.spent} exit${s.spent>1?'s are':' is'} marked used up today.`:''}</p>

    {editing&&<Dialog title="Edit WireGuard config" icon={<ShieldCheck size={18}/>} onClose={()=>setEditing(null)} busy={busy==='save'} wide>
      <form className="dialog-form" autoComplete="off" onSubmit={e=>{e.preventDefault();if(busy!=='save'&&editing.name.trim()&&editing.text.trim())void saveEdit();}}>
        <Field label="Name"><input value={editing.name} onChange={e=>setEditing({...editing,name:e.target.value})} maxLength={60} autoFocus/></Field>
        <Field label="Configuration" hint="Checked with the bundled client before it is saved. A running config reconnects with the new file."><textarea className="mono" rows={16} value={editing.text} onChange={e=>setEditing({...editing,text:e.target.value})} spellCheck={false}/></Field>
        <div className="dialog-actions"><Button onClick={()=>setEditing(null)}>Cancel</Button><Button variant="primary" type="submit" disabled={busy==='save'||!editing.name.trim()||!editing.text.trim()}>{busy==='save'?<Loader2 size={15} className="spin"/>:<Check size={15}/>}Save config</Button></div>
      </form>
    </Dialog>}
  </section>;
}
