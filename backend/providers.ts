import { createHash } from 'node:crypto';
import { stateDir, settings, models, saveModel, usagePenalties, redactError } from './state';
import { networkFetch, routeContext, routeForProvider, providerRoutes } from './transport';
import { GatewayError } from './queue';
import { serve } from './serve';
import { kiloCatalog, kiloChat } from './kilo';
import { logEvent } from './logbook';
import type { Provider, Model } from './types';
process.env.AUTO_UPDATE='0';
process.env.OPENCODE_BRIDGE_STATE_DIR=stateDir+'/bridge';
process.env.OPENCODE_CACHE_DIR=stateDir+'/bridge/cache';
process.env.ZEN_PROXY_CONFIG=stateDir+'/unused-protocol-settings.json';
const bridge=require('../vendor/bridge/server.js');
const proxy=require('../vendor/bridge/proxy.js');
proxy.netFetch=(url:any,init:any)=>networkFetch(url,init);
let bridgeUrl=''; let bridgeServer:ReturnType<typeof serve>|undefined; let discovery:Promise<void>|undefined;
export const identityState=()=>bridge.identity.getState();
export async function syncIdentity(){return await bridge.identity.refresh({force:true});}
export async function initBridge(){
  if(bridgeUrl)return;
  bridgeServer=serve((req,res)=>routeContext.run({routeId:String(req.headers['x-polygate-route']||settings.routeId),requestId:String(req.headers['x-polygate-request']||'')||undefined},()=>bridge.handleRequest(req,res)),0);
  bridgeUrl=`http://127.0.0.1:${bridgeServer.port}`;
}
export function stopBridge(){bridgeServer?.stop(true);}
export function codingScore(id:string){let score=50;if(/coder|code|deepseek|qwen|glm/i.test(id))score+=15;if(/reason|thinking/i.test(id))score+=8;if(/flash|mini|light/i.test(id))score-=4;const n=Number(id.match(/(\d+)b(?:\b|-)/i)?.[1]);if(n>=70)score+=10;return score;}
export function rankedModels(){const penalty=usagePenalties();return [...models.values()].filter(m=>settings.providers.some(p=>p.id===m.providerId&&p.enabled)).sort((a,b)=>{const ca=a.cooldownUntil>Date.now()?1:0,cb=b.cooldownUntil>Date.now()?1:0;return ca-cb||a.priority-b.priority||(b.score-(penalty.get(b.id)||0))-(a.score-(penalty.get(a.id)||0))||(a.latency||1e9)-(b.latency||1e9);});}
const ABSENT='Absent from latest provider catalog';
// Providers whose catalog could not be read on the last refresh, with the reason; a successful refresh clears the entry.
const catalogErrors=new Map<string,string>();
export const catalogProblems=()=>[...catalogErrors].map(([providerId,error])=>({providerId,error}));
export async function discover(){
  if(discovery)return discovery;
  discovery=(async()=>{await initBridge();const errors:string[]=[];
    for(const p of settings.providers.filter(p=>p.enabled)){
      try{
        let found:any[]=[];let authoritative=true;
        if(p.kind==='free'){await bridge.discoverModels();found=bridge.__getDiscoveryState().activeModels.map((x:any)=>typeof x==='string'?{id:x}:x);}
        else if(p.kind==='openai'){
          try{const r=await networkFetch(p.baseUrl.replace(/\/$/,'')+'/models',{headers:p.apiKey?{authorization:`Bearer ${p.apiKey}`}:{},signal:AbortSignal.timeout(15000)},catalogRoute(p));if(!r.ok)throw new Error(`Catalog HTTP ${r.status}`);const data:any=await r.json();const list=data.data||data.models;if(!Array.isArray(list))throw new Error('Catalog response has no model list');found=list;}
          catch(e){if(!p.models.length)throw e;authoritative=false;}
          const listed=new Set(found.map(x=>x?.id??x));found=[...found,...p.models.filter(id=>!listed.has(id)).map(id=>({id}))];
        }
        // A failed fetch leaves the catalog and the models already listed untouched (the error is reported below).
        else if(p.kind==='kilo')found=await kiloCatalog(p,catalogRoute(p));
        else found=p.models.map(id=>({id}));
        if(!found.length&&p.models.length)found=p.models.map(id=>({id}));
        if(!found.length)throw new Error(p.kind==='opencode'?'List this OpenCode server\'s provider/model IDs in Model IDs':'Provider returned an empty catalog; existing models were kept');
        const seen=new Set<string>();
        for(const x of found){const upstreamId=x.id||x;if(typeof upstreamId!=='string')continue;const id=p.id+'/'+upstreamId;seen.add(id);const prior=models.get(id);const facts=p.kind==='free'?bridge.identity.getModelFacts(upstreamId):null;
          // Whether it takes images is known only when the catalog lists its input kinds; otherwise it stays unknown (and never excludes the model).
          const inputs=x.modalities?.input??x.architecture?.input_modalities??x.input_modalities;const images=Array.isArray(inputs)?inputs.map(String).includes('image'):undefined;
          const info={name:x.name||upstreamId,context:x.context_length||facts?.context||0,output:facts?.maxOutput||x.maxOutput||0,reasoning:!!(facts?.reasoning||x.reasoning),tools:x.tool_call!==false,...(images!==undefined?{images}:{})};
          if(!prior){saveModel({id,upstreamId,providerId:p.id,...info,state:'unchecked',latency:0,score:codingScore(id),priority:p.kind==='kilo'?150:100,failCount:0,cooldownUntil:0,checkedAt:0,error:''});continue;}
          // Catalog facts refresh each pass; priority, score and measured health stay. A model that returns to the catalog is retried.
          const returned=prior.state==='unavailable'&&prior.error===ABSENT;
          saveModel({...prior,...info,context:info.context||prior.context,output:info.output||prior.output,reasoning:info.reasoning||prior.reasoning,...(returned?{state:'unchecked' as const,error:''}:{})});
        }
        if(authoritative)for(const m of models.values())if(m.providerId===p.id&&!seen.has(m.id)){m.state='unavailable';m.error=ABSENT;saveModel(m);}
        catalogErrors.delete(p.id);
      }catch(e){catalogErrors.set(p.id,redactError(String(e)).slice(0,240));errors.push(p.name+': '+String(e));logEvent('warn','models',`${p.name} catalog could not be read: ${String(e)}`,{provider:p.id});}
    }
    const listed=[...models.values()].filter(m=>m.state!=='unavailable'&&settings.providers.some(p=>p.id===m.providerId&&p.enabled)).length;
    logEvent('info','models',`Model catalog refreshed: ${listed} model(s) listed`,{providers:settings.providers.filter(p=>p.enabled).map(p=>p.name),errors:errors.length||undefined});
    if(errors.length)throw new GatewayError(errors.join('; '),502,'catalog_error');
  })().finally(()=>{discovery=undefined;});return discovery;
}
// The route a provider's model list is read through: the one its chat would use, or the first in its list when none can be used right now.
const catalogRoute=(p:Provider)=>{try{return routeForProvider(p,'').id;}catch{return providerRoutes(p)?.ids[0]||settings.routeId;}};
export async function providerChat(p:Provider,model:Model,body:any,signal:AbortSignal,routeId:string,session:string,requestId=''):Promise<Response>{
  if(p.kind==='free')return fetch(bridgeUrl+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json','x-polygate-route':routeId,'x-session-id':session,...(requestId?{'x-polygate-request':requestId}:{})},body:JSON.stringify({...body,model:model.upstreamId,stream:true}),signal});
  if(p.kind==='opencode')return routeContext.run({routeId,requestId:requestId||undefined},()=>realOpenCode(p,model,body,signal,routeId));
  if(p.kind==='kilo')return routeContext.run({routeId,requestId:requestId||undefined},()=>kiloChat(p,model,body,signal,routeId));
  return routeContext.run({routeId,requestId:requestId||undefined},()=>networkFetch(p.baseUrl.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',...(p.apiKey?{authorization:`Bearer ${p.apiKey}`}:{})},body:JSON.stringify({...body,model:model.upstreamId,stream:true}),signal},routeId));
}
async function realOpenCode(p:Provider,m:Model,body:any,signal:AbortSignal,routeId:string){
  const slash=m.upstreamId.indexOf('/');if(slash<0)throw new GatewayError('OpenCode server models must be provider/model IDs',400);
  const base=p.baseUrl.replace(/\/$/,'');const headers={'content-type':'application/json',...(p.apiKey?{authorization:`Basic ${Buffer.from('opencode:'+p.apiKey).toString('base64')}`}:{})};
  const r=await networkFetch(base+'/session',{method:'POST',headers,body:JSON.stringify({title:'Polygate request'}),signal},routeId);if(!r.ok)return r;const s:any=await r.json();const sessionUrl=base+`/session/${encodeURIComponent(s.id)}`;
  try{
    const payload={model:{providerID:m.upstreamId.slice(0,slash),modelID:m.upstreamId.slice(slash+1)},tools:{},parts:[{type:'text',text:body.messages.map((x:any)=>`${x.role}: ${typeof x.content==='string'?x.content:JSON.stringify(x.content)}`).join('\n\n')}]};
    const reply=await networkFetch(sessionUrl+'/message',{method:'POST',headers,body:JSON.stringify(payload),signal},routeId);if(!reply.ok)return reply;const data:any=await reply.json();
    const text=(data.parts||[]).filter((x:any)=>x.type==='text').map((x:any)=>x.text).join('');
    const chunks=[{id:'chatcmpl-'+crypto.randomUUID(),choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:data.info?.tokens?.input||0,completion_tokens:data.info?.tokens?.output||0}}];
    return new Response(chunks.map(x=>`data: ${JSON.stringify(x)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }finally{
    // Every request owns a throwaway session on the user's server; remove it without delaying or failing the reply.
    networkFetch(sessionUrl,{method:'DELETE',headers,signal:AbortSignal.timeout(5000)},routeId).then(x=>x.body?.cancel().catch(()=>{}),()=>{});
  }
}
export function sessionFor(key:string,messages:any[],headers:Record<string,any>){
  const supplied=headers['x-session-id']||headers['x-conversation-id']||headers['x-session-affinity'];
  // Agents share one leading system prompt across chats, so the first user turn is what identifies a conversation.
  const anchor=messages.find(m=>m?.role==='user')??messages[0];
  return 'polygate-'+createHash('sha256').update(key+'|'+(supplied||JSON.stringify(anchor))).digest('hex').slice(0,32);
}
