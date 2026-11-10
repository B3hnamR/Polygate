import {models,settings} from './state';
import {AUTO_STEPS,modelFor} from './chains';
import {modelAllowed} from './keys';
import {autoOrder} from './plan';

// Catalog metadata only. Actual choice/failover remains in the gateway and never changes a session's chain pin.
export function agentChains(){
  const key=settings.keys.find(k=>k.agent);
  const candidates=[...models.values()].filter(m=>m.tools&&m.state!=='unavailable'&&settings.providers.some(p=>p.id===m.providerId&&p.enabled)&&(!key||modelAllowed(key,m.id)));
  return (settings.chains||[]).filter(c=>c.enabled).map(c=>{
    const members=[...new Set(c.models.flatMap(step=>AUTO_STEPS.includes(step)?autoOrder(step,candidates):[modelFor(step)].filter((m):m is NonNullable<typeof m>=>!!m&&candidates.includes(m))))];
    const limit=(field:'context'|'output',fallback:number)=>members.length?Math.min(...members.map(m=>m[field]>0?m[field]:fallback)):fallback;
    // Output: the smallest limit a member is known to have; none known leaves it to the engine configuration's own default.
    const known=members.map(m=>m.output).filter(n=>n>0);
    return {id:c.name,name:c.name,provider:'Model chains',context:limit('context',32000),output:known.length?Math.min(...known):0,reasoning:false,efforts:[] as string[],usable:members.length>0,reason:members.length?'':'No enabled, permitted tool-capable models are available in this chain.',members:c.models,description:c.description||'',free:members.some(m=>settings.providers.find(p=>p.id===m.providerId)?.kind==='free')};
  });
}
