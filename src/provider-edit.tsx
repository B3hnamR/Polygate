import {useState} from 'react';
import {Server} from 'lucide-react';
import {Dialog} from './mcp';
import {Button,Field} from './ui';
import type {Provider} from '../backend/types';

const MASK='••••••••';
// Edits a provider that is not built in: its name, address, key and model list. The text before the slash in its model names (the id) is
// fixed once it exists, because chains and client settings refer to those names.
export function ProviderEditDialog({provider:p,onClose,onSave}:{provider:Provider;onClose:()=>void;onSave:(changes:{name:string;baseUrl:string;apiKey:string;models:string[]},reload:boolean)=>Promise<boolean>}){
  const [name,setName]=useState(p.name);const [baseUrl,setBaseUrl]=useState(p.baseUrl);const [apiKey,setApiKey]=useState(p.apiKey);const [models,setModels]=useState(p.models.join(', '));const [busy,setBusy]=useState(false);
  const opencode=p.kind==='opencode';
  const sameServer=(()=>{try{return new URL(baseUrl).origin===new URL(p.baseUrl).origin;}catch{return baseUrl===p.baseUrl;}})();
  // The saved key is never sent to another server: when the address moves, the key has to be typed again.
  const needKey=!!p.apiKey&&apiKey===MASK&&!sameServer;
  const valid=name.trim().length>0&&/^https?:\/\/\S+$/i.test(baseUrl.trim())&&!needKey;
  const list=models.split(',').map(x=>x.trim()).filter(Boolean);
  const save=async()=>{setBusy(true);try{if(await onSave({name:name.trim(),baseUrl:baseUrl.trim(),apiKey,models:list},baseUrl.trim()!==p.baseUrl||apiKey!==p.apiKey||list.join(',')!==p.models.join(',')))onClose();}finally{setBusy(false);}};
  return <Dialog title={`Edit ${p.name}`} icon={<Server size={18}/>} onClose={onClose} busy={busy} wide>
    <div className="form-grid">
      <Field label="Name"><input value={name} maxLength={80} onChange={e=>setName(e.target.value)}/></Field>
      <Field label="Model prefix" hint="Fixed: your chains and clients use these names. To change it, add the provider again."><input value={p.id} readOnly disabled/></Field>
    </div>
    <Field label="Base URL" hint="Include /v1 for compatible APIs. Use the server root for OpenCode."><input type="url" value={baseUrl} onChange={e=>setBaseUrl(e.target.value)}/></Field>
    <Field label={opencode?'Server password':'API key'} hint={needKey?'You changed the server address, so type the key again. The saved one is not sent to a new server.':p.apiKey?'A key is saved. Leave the dots to keep it, or type a new one.':'Optional.'}><input type="password" autoComplete="off" value={apiKey} onChange={e=>setApiKey(e.target.value)} onFocus={e=>{if(apiKey===MASK)e.currentTarget.select();}}/></Field>
    <Field label="Model IDs" hint="Comma-separated overrides. Leave empty to use the server's /models list."><input value={models} onChange={e=>setModels(e.target.value)} placeholder="Leave empty to use /models discovery"/></Field>
    <div className="dialog-actions"><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" disabled={busy||!valid} onClick={save}>Save changes</Button></div>
  </Dialog>;
}
