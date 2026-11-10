import {Activity,Loader2,Square} from 'lucide-react';
import {useConfirm} from './confirm';
import {Button,Progress,Select,when,type Snapshot} from './ui';
import {ModelBar,stateCounts} from './overview-parts';
import type {Provider} from '../backend/types';

// One row per provider above the model list: how its models stand, a check of all of them, and how often the timer checks them.
const EVERY:[number,string][]=[[0,'Off'],[60,'Every hour'],[360,'Every 6 hours'],[1440,'Every day']];

export function ProviderChecks({data,act,pending}:{data:Snapshot;act:Function;pending:string}){
  const {confirm,dialog}=useConfirm();
  const rows=data.settings.providers.filter(p=>p.enabled&&data.models.some(m=>m.providerId===p.id));
  if(!rows.length)return null;
  const checkAll=async(p:Provider,total:number)=>{
    if(!await confirm(<>Check all {total} models of <strong>{p.name}</strong>? Each check is one small real request and counts toward this provider's limits. The run stops if the provider asks to slow down; a model that is only out of its own allowance is passed over.</>,{title:'Check all models',confirm:`Check ${total} models`,icon:<Activity size={18}/>}))return;
    act('check:'+p.id,'/admin/probe/provider',{id:p.id},'');
  };
  return <section className="section-block check-strip" aria-label="Check models by provider">{dialog}
    <div className="check-head"><h2>Check by provider</h2><span className="subtle">Each check counts toward the provider's limits. Automatic checks are off until you choose, take one model at a time, and wait 15 minutes if the provider asks to slow down.</span></div>
    {rows.map(p=>{
      const models=data.models.filter(m=>m.providerId===p.id);const counts=stateCounts(models);const run=data.checks?.[p.id];const can=models.filter(m=>m.cooldownUntil<=Date.now()).length;
      const last=Math.max(0,...models.map(m=>m.checkedAt||0));
      return <div className="check-row" key={p.id}>
        <div className="check-name"><strong>{p.name}</strong><small>{counts.available} available · {counts.unchecked} not checked{counts.cooldown?` · ${counts.cooldown} resting`:''}{counts.unavailable?` · ${counts.unavailable} unavailable`:''}</small></div>
        {run?.running?<div className="check-progress"><Progress value={run.total?run.done/run.total*100:0} label={`Checking ${p.name}`}/><small role="status">Checking {run.done} of {run.total}: {run.ok} answered, {run.failed} did not</small></div>
        :run?<div className="check-progress"><ModelBar counts={counts}/><small role="status" className={run.note?'amber':''}>{run.note||`Checked ${run.done}: ${run.ok} answered, ${run.failed} did not`}</small></div>
        :<div className="check-progress"><ModelBar counts={counts}/><small>{last?`Last check ${when(last)}`:'Not checked yet'}</small></div>}
        <label className="check-auto"><span>Automatic</span><Select aria-label={`How often to check ${p.name} automatically`} value={p.autoCheckMinutes??0} onChange={v=>act('autocheck:'+p.id,'/admin/providers',{...p,autoCheckMinutes:Number(v)},Number(v)?`${p.name} is checked ${EVERY.find(e=>e[0]===Number(v))?.[1].toLowerCase()}`:`Automatic checks for ${p.name} are off`)}>{EVERY.map(([v,l])=><option key={v} value={v}>{l}</option>)}</Select></label>
        {run?.running?<Button onClick={()=>act('stopcheck:'+p.id,'/admin/probe/provider',{id:p.id,stop:true},'')}><Square size={14}/>Stop</Button>
        :<Button disabled={!!pending||!can} title={can?undefined:'All of its models are resting'} onClick={()=>checkAll(p,can)}>{pending==='check:'+p.id?<Loader2 size={14} className="spin"/>:<Activity size={14}/>}Check all</Button>}
      </div>;
    })}
  </section>;
}
