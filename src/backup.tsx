import {useEffect,useRef,useState} from 'react';
import {Download,TriangleAlert,Upload} from 'lucide-react';
import {api} from './api';
import {ApplyTag,Button,Field} from './ui';
// Settings backup: one file, protected by a passphrase, that restores on any computer. The file is made by the gateway and saved by this page;
// the passphrase is sent for that one call and is not kept.
export function BackupPanel({notice,refresh,needsPassword=false}:{notice:(s:string)=>void;refresh:()=>void;needsPassword?:boolean}){
  // On a server the dashboard password is asked for again: a backup holds every stored secret.
  const [dashPass,setDashPass]=useState('');const confirmation=needsPassword?{password:dashPass}:{};
  const [pass,setPass]=useState('');const [again,setAgain]=useState('');const [busy,setBusy]=useState('');const [error,setError]=useState('');
  const [done,setDone]=useState('');const [file,setFile]=useState<{name:string;text:string;generation:number}|null>(null);const [restorePass,setRestorePass]=useState('');const [sure,setSure]=useState(false);const input=useRef<HTMLInputElement>(null);
  const [loading,setLoading]=useState(false);const generation=useRef(0),acting=useRef(false),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;};},[]);
  async function selectFile(f?:File){
    const request=++generation.current;setFile(null);setSure(false);setRestorePass('');setError('');setLoading(false);
    if(!f)return;
    if(f.size>16*1024*1024){setError('That file is too large to be a Polygate backup');return;}
    setLoading(true);
    try{const text=await f.text();if(request===generation.current)setFile({name:f.name,text,generation:request});}
    catch(e:any){if(request===generation.current)setError(e?.message||'Could not read the backup file');}
    finally{if(request===generation.current)setLoading(false);}
  }
  async function save(){
    if(acting.current||!canSave)return;acting.current=true;setBusy('export');setError('');
    try{const out=await api('/admin/backup/export',{passphrase:pass,...confirmation});const url=URL.createObjectURL(new Blob([out.content],{type:'application/octet-stream'}));const a=document.createElement('a');a.href=url;a.download=out.filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);if(mounted.current){setPass('');setAgain('');}notice(`Backup saved as ${out.filename}`);}
    catch(e:any){if(mounted.current)setError(e.message||'Could not make the backup');}finally{acting.current=false;if(mounted.current)setBusy('');}
  }
  async function restore(){
    if(!file||file.generation!==generation.current||loading||!sure||!restorePass||(needsPassword&&!dashPass)||acting.current)return;
    const request=generation.current;acting.current=true;setBusy('restore');setError('');
    try{const out=await api('/admin/backup/restore',{content:file.text,passphrase:restorePass,...confirmation});if(mounted.current){if(request===generation.current){setFile(null);setRestorePass('');setSure(false);if(input.current)input.current.value='';}setDone(`Settings restored (${out.providers} providers, ${out.routes} routes, ${out.keys} keys). Restart Polygate now so every part uses them.`);}notice(`Settings restored (${out.providers} providers, ${out.routes} routes, ${out.keys} keys). Restart Polygate so every part uses them.`);refresh();}
    catch(e:any){if(mounted.current&&request===generation.current)setError(e.message||'Could not restore the backup');}finally{acting.current=false;if(mounted.current)setBusy('');}
  }
  const canSave=pass.length>=8&&pass===again&&(!needsPassword||!!dashPass);
  return <section className="section-block form-section backup-panel"><h2>Backup and restore</h2>
    <p className="muted">Saves your providers and their keys, routes and relay tokens, client keys, chains, MCP servers, Psiphon and Surfshark settings, imported WireGuard configs and preferences in one file. The file is protected by a passphrase you choose, so it can be restored on another computer or after a reinstall. The dashboard password, HTTPS certificates, WARP registration and request history are not included. Keep the file and the passphrase somewhere safe: anyone who has both can use your keys.</p>
    {needsPassword&&<Field label="Dashboard password" hint="Asked again because a backup holds every key and token Polygate stores."><input type="password" autoComplete="current-password" value={dashPass} onChange={e=>setDashPass(e.target.value)}/></Field>}
    <div className="backup-grid">
      <form onSubmit={e=>{e.preventDefault();if(canSave&&!busy)void save();}} autoComplete="off"><h3>Make a backup</h3>
        <Field label="Passphrase" hint="At least 8 characters. There is no way to recover a backup if you forget it."><input type="password" autoComplete="new-password" disabled={busy==='export'} value={pass} onChange={e=>setPass(e.target.value)}/></Field>
        <Field label="Passphrase again"><input type="password" autoComplete="new-password" disabled={busy==='export'} value={again} onChange={e=>setAgain(e.target.value)}/></Field>
        {again&&pass!==again&&<p className="red">The two passphrases are different.</p>}
        <div className="dialog-actions"><Button variant="primary" type="submit" disabled={!canSave||!!busy}><Download size={14}/>{busy==='export'?'Saving…':'Save backup file'}</Button></div></form>
      <form onSubmit={e=>{e.preventDefault();if(file&&sure&&restorePass&&!busy)void restore();}} autoComplete="off">{done&&<div className="dialog-note" role="status"><TriangleAlert size={16}/><p>{done}</p></div>}<h3>Restore from a backup <ApplyTag when="restart"/></h3>
        <Field label="Backup file"><input ref={input} type="file" accept=".pgbackup,application/json" onChange={e=>{void selectFile(e.target.files?.[0]);}}/></Field>
        {loading&&<p role="status" className="subtle">Reading backup file…</p>}
        <Field label="Passphrase"><input type="password" autoComplete="new-password" disabled={busy==='restore'} value={restorePass} onChange={e=>setRestorePass(e.target.value)}/></Field>
        <div className="check-row"><input id="restore-sure" type="checkbox" checked={sure} disabled={!file||loading||busy==='restore'} onChange={e=>setSure(e.target.checked)}/><label htmlFor="restore-sure">Replace my current settings with this backup<small>A copy of the current settings is kept in the data folder first. The dashboard password stays as it is. <strong>Polygate must be restarted afterwards</strong> (Windows app: Exit from the tray icon and open it again; on a server: <code>sudo polygate restart</code>) for every part to use the restored settings.</small></label></div>
        <div className="dialog-actions"><Button variant="primary" type="submit" disabled={loading||!file||!sure||!restorePass||(needsPassword&&!dashPass)||!!busy}><Upload size={14}/>{busy==='restore'?'Restoring…':'Restore'}</Button></div></form>
    </div>
    {error&&<div className="dialog-note error" role="alert"><TriangleAlert size={16}/><p>{error}</p></div>}
  </section>;
}
