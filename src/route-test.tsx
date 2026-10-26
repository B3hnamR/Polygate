import {useEffect,useRef,useState} from 'react';
import {Check,TriangleAlert,X,Zap} from 'lucide-react';
import {api} from './api';
import {Button} from './ui';
import type {Provider,Route} from '../backend/types';
// Testing a route means sending something through it, and what is sent depends on the provider: OpenCode Free and Kilo answer different
// questions and have different limits. The dialog lets the user pick which provider the test goes through.
type Result={ok:boolean;status:number;latency?:number;chat:string;summary:string;provider?:string};
const nameOf=(p:Provider)=>p.kind==='free'?'OpenCode Free':p.kind==='kilo'?'Kilo Free':p.name;
const detail=(p:Provider)=>p.kind==='free'?'Checks its model list, then sends one chat request and reads the daily allowance.'
  :p.kind==='kilo'?'Reads its model list, then sends one small chat request. That request counts against Kilo’s free allowance.'
  :p.kind==='opencode'?'Sends one small chat request to that OpenCode server.':'Reads its model list, then sends one small chat request.';
const carries=(route:Route,p:Provider)=>!route.only||route.only===p.kind;
export function RouteTestDialog({route,providers,onClose,onDone}:{route:Route;providers:Provider[];onClose:()=>void;onDone:()=>void}){
  const enabled=providers.filter(p=>p.enabled);
  const usable=enabled.filter(p=>carries(route,p));
  const [chosen,setChosen]=useState((usable.find(p=>p.kind==='free')||usable[0])?.id||'');
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [result,setResult]=useState<Result|null>(null);
  const box=useRef<HTMLDivElement>(null);const first=useRef<HTMLInputElement>(null);const closing=useRef(onClose);
  useEffect(()=>{closing.current=onClose;});
  useEffect(()=>{const opener=document.activeElement as HTMLElement|null;first.current?.focus();return()=>opener?.focus();},[]);
  useEffect(()=>{const key=(e:KeyboardEvent)=>{
    if(e.key==='Escape'){if(!busy&&!e.defaultPrevented)closing.current();}
    else if(e.key==='Tab'&&box.current){const f=[...box.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled])')];const i=f.indexOf(document.activeElement as HTMLElement);if(!f.length)e.preventDefault();else if(e.shiftKey?i<=0:(i<0||i===f.length-1)){e.preventDefault();f[e.shiftKey?f.length-1:0].focus();}}
  };document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);},[busy]);
  async function run(){
    setBusy(true);setError('');setResult(null);
    try{setResult(await api('/admin/routes/test',{id:route.id,providerId:chosen}));onDone();}
    catch(e:any){setError(e.message||'The test failed');onDone();}finally{setBusy(false);}
  }
  const good=result?.chat==='ok';
  return <div className="dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)onClose();}}>
    <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-label={`Test ${route.name}`}>
      <header className="dialog-head"><Zap size={16}/><h2>Test {route.name}</h2><span className="toolbar-spacer"/><button type="button" className="icon-button" aria-label="Close" disabled={busy} onClick={onClose}><X size={16}/></button></header>
      <div className="dialog-body">
        <p className="subtle">Pick the provider to send through this route. Each provider has its own limits, so a route can pass for one and fail for another.</p>
        {route.only&&<div className="dialog-note info"><Check size={16}/><p>This relay carries {route.only==='kilo'?'Kilo':route.only} only, so other providers cannot be tested through it.</p></div>}
        <fieldset className="field" style={{border:0,padding:0,margin:'0 0 14px'}} disabled={busy}>
          {enabled.length?enabled.map(p=>{const ok=carries(route,p);return <label key={p.id} className="toggle-row" style={{opacity:ok?1:.5,cursor:ok?'pointer':'not-allowed',margin:'0 0 6px',padding:'10px 0'}}>
            <span><strong>{nameOf(p)}</strong><small>{ok?detail(p):`This relay carries ${route.only==='kilo'?'Kilo':route.only} only.`}</small></span>
            <input ref={p.id===chosen?first:undefined} type="radio" name="test-provider" disabled={!ok} checked={chosen===p.id} onChange={()=>setChosen(p.id)} aria-label={nameOf(p)}/></label>;}):<p className="subtle">No provider is enabled. Enable one on the Providers page.</p>}
        </fieldset>
        {result&&<div className={`dialog-note ${good?'good':'warn'}`} role="status">{good?<Check size={16}/>:<TriangleAlert size={16}/>}<p>{result.summary}{result.latency!==undefined&&<> <span className="subtle">({result.latency} ms to reach it)</span></>}</p></div>}
        {error&&<div className="dialog-note error" role="alert"><TriangleAlert size={16}/><p>{error}</p></div>}
        <div className="dialog-actions"><Button variant="primary" disabled={busy||!chosen} onClick={()=>void run()}><Zap size={14}/>{busy?'Testing…':result||error?'Test again':'Run test'}</Button><Button disabled={busy} onClick={onClose}>Close</Button></div>
      </div>
    </div>
  </div>;
}
