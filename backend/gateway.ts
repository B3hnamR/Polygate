import type { IncomingMessage, ServerResponse } from 'node:http';
import { settings, models, record, saveModel, redactError } from './state';
import { authenticate, modelAllowed, recordUsage } from './keys';
import { AdmissionQueue, GatewayError } from './queue';
import { toChat, fromChat, collect, stream, observeSse, lfBody, type Protocol } from './protocols';
import { rankedModels, providerChat, sessionFor } from './providers';
import { routeForProvider, routeAfter, exhaustedRouteAfter, providerPicksAgain, providerSwitches, networkFetch } from './transport';
import { exhaustionOf, takeExhaustion, takeRefused, resetTime, type Exhaustion } from './exhaustion';
import { notify } from './notifications';
import { logEvent } from './logbook';
import { KILO_ID, KILO_LIMIT_PAUSE_MS, KILO_MODEL_PAUSE_MS, isAddressLimit, pauseKilo } from './kilo';
import { explainError, pausedModel } from './explain';
import { describeBody, describeHeaders, takeAttempts, egressInfo } from './diagnostics';
import { chainFor, modelFor, AUTO_STEPS } from './chains';
import { coreOnly, knownTrim, learnTrim, forgetTrim } from './tooltrim';
import { autoOrder, needsOf, pickFrom, type Needs } from './plan';
import { checklist } from './checklist';
import type { Model, ApiKey, Chain } from './types';
export const queue=new AdmissionQueue(settings.maxConcurrent,settings.maxQueue);
export async function readJson(req:IncomingMessage,limit=8*1024*1024){let size=0;const chunks:Buffer[]=[];for await(const c of req){size+=c.length;if(size>limit)throw new GatewayError(limit>=1024*1024?`Request exceeds ${limit/1024/1024} MiB`:`Request exceeds ${Math.round(limit/1024)} KiB`,413,'request_too_large');chunks.push(Buffer.from(c));}try{const b=JSON.parse(Buffer.concat(chunks).toString()||'{}');if(!b||typeof b!=='object'||Array.isArray(b))throw new Error();return b;}catch{throw new GatewayError('Request body must be a JSON object',400,'invalid_json');}}
export function json(res:ServerResponse,status:number,data:any){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));}
export const clientKey=(req:IncomingMessage)=>authenticate(req,false);
const providerEnabled=(m:Model)=>settings.providers.some(p=>p.id===m.providerId&&p.enabled);
// A chain is the user's own order: its steps that are ready right now, each tried when the one before it fails. The "fallback" setting
// does not shorten it, because the user listed these on purpose.
function chainModels(chain:Chain,ranked:Model[],key:ApiKey|undefined,needs:Needs,skipped:string[]){
  if(!chain.enabled)throw new GatewayError(`The chain "${chain.name}" is switched off in Polygate.`,404,'model_not_found');
  const out:Model[]=[];
  for(const step of chain.models){
    if(AUTO_STEPS.includes(step)){for(const m of pickFrom(autoOrder(step,ranked),3,key,needs,skipped))if(!out.includes(m))out.push(m);continue;}
    const m=modelFor(step);if(m&&ranked.includes(m)&&!out.includes(m))out.push(m);
  }
  if(out.length)return out;
  const resting=chain.models.map(modelFor).filter((m):m is Model=>!!m&&m.state!=='unavailable'&&m.cooldownUntil>Date.now());
  if(resting.length){const soon=Math.min(...resting.map(m=>m.cooldownUntil));throw new GatewayError(`Every model in the chain "${chain.name}" is resting. The first is back at ${resetTime(soon)}.`,429,'model_paused',Math.max(1,Math.ceil((soon-Date.now())/1000)));}
  throw new GatewayError(`None of the models in the chain "${chain.name}" can answer: they are unavailable, switched off, or not allowed for this API key.`,503,'models_unavailable');
}
// `needs` is what the request asks of a model; models that are listed as unable to do it are passed over for auto and for the auto steps of a chain,
// and each one passed over is added to `skipped` with its reason. A model named on purpose (a chain step, an exact model) is never swapped out.
function chosenModels(requested:string,key:ApiKey|undefined,needs:Needs,skipped:string[]){
  const all=rankedModels();const ranked=all.filter(m=>m.state!=='unavailable'&&m.cooldownUntil<=Date.now()&&(!key?.models?.length||modelAllowed(key,m.id)));
  const chain=chainFor(requested);if(chain)return chainModels(chain,ranked,key,needs,skipped);
  if(requested==='auto'||requested==='auto:smart'||requested==='auto:fast'){
    const eligible=autoOrder(requested,ranked);
    if(!eligible.length)throw new GatewayError('No models are ready. Refresh the catalog or wait for cooldowns.',503,'models_unavailable');return pickFrom(eligible,settings.fallback?3:1,key,needs,skipped);
  }
  const exact=models.get(requested)||all.find(m=>m.upstreamId===requested);if(!exact)throw new GatewayError('Unknown model. Use a model from /v1/models.',404,'model_not_found');
  if(!providerEnabled(exact))throw new GatewayError('Model belongs to a disabled or removed provider. Enable it in Providers.',404,'model_not_found');
  if(key&&!modelAllowed(key,exact.id))throw new GatewayError('This API key is not allowed to use that model',403,'permission_error');
  if(exact.cooldownUntil>Date.now()){const p=pausedModel(exact.id,exact.cooldownUntil,settings.cooldowns===true);throw new GatewayError(p.message,429,'model_paused',p.retryAfter);}return [exact];
}
// Logs a model's change of health (not every check): now usable, resting until a time, or gone from its provider.
function logModelChange(m:Model,before:{state:string;cooldownUntil:number},status:number){
  if(m.state===before.state&&m.cooldownUntil<=before.cooldownUntil)return;
  const until=m.cooldownUntil>Date.now()?new Date(m.cooldownUntil).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'';
  const text=m.state==='available'?'is available':m.state==='cooldown'?`is resting until ${until} (HTTP ${status})`:m.state==='unavailable'?`is unavailable (HTTP ${status})`:`will be checked again (HTTP ${status})`;
  logEvent(m.state==='available'?'info':m.state==='unavailable'?'error':'warn','models',`${m.id} ${text}`,{model:m.id,provider:m.providerId,from:before.state,to:m.state,status,cooldownUntil:m.cooldownUntil||undefined,error:m.error||undefined});
}
export function classifyModel(m:Model,status:number,message:string,latency:number,retryAfter=0){const before={state:m.state,cooldownUntil:m.cooldownUntil};m.checkedAt=Date.now();m.latency=latency;m.error=status<400?'':redactError(message);const wait=Number.isFinite(retryAfter)?retryAfter:0;
  if(status<400){m.state='available';m.failCount=0;m.cooldownUntil=0;}
  else if(settings.cooldowns!==true&&(status===429||status>=500||/quota|capacity|rate.?limit/i.test(message)||status===403)){m.state='unchecked';m.cooldownUntil=0;}
  else if(status===429||/quota|capacity|rate.?limit/i.test(message)){m.state='cooldown';m.failCount++;m.cooldownUntil=Date.now()+Math.max(wait, m.failCount<=1?(m.providerId===KILO_ID?KILO_MODEL_PAUSE_MS:15*60000):m.failCount<=3?3600000:21600000);}
  else if(status===404||status===410){m.state='unavailable';}
  else if(status>=500||status===403){m.state='cooldown';m.failCount++;m.cooldownUntil=Date.now()+60000;}
  saveModel(m);logModelChange(m,before,status);
}
export async function inference(req:IncomingMessage,res:ServerResponse,protocol:Protocol){
  const k=authenticate(req,true);if(!settings.enabled)throw new GatewayError('Gateway is paused. Resume it in Polygate.',503,'gateway_paused');
  const requestId=crypto.randomUUID();const body=await readJson(req);let chat=toChat(body,protocol);const askedChat=chat;
  // Shape of what the client sent (sizes, counts, header names; no content), kept with the request for later diagnosis.
  const clientShape={headers:describeHeaders(Object.entries(req.headers).map(([k,v])=>[k,String(v)] as [string,string])),body:describeBody(body,Number(req.headers['content-length'])||JSON.stringify(body).length)};const needs=needsOf(chat);const skipped:string[]=[];const candidates=chosenModels(chat.model,k,needs,skipped);const chain=chainFor(chat.model);const hops:string[]=[...skipped];const controller=new AbortController();(req as any).signal=controller.signal;
  const timer=setTimeout(()=>controller.abort(new GatewayError('Gateway request deadline exceeded',504,'timeout')),settings.timeoutMs);
  // The deadline covers the wait for the first byte. Once an answer is streaming, only silence counts, so a long answer that is still arriving is
  // not cut off; a stream that never stops is ended after an hour.
  let idle:ReturnType<typeof setTimeout>|undefined,ceiling:ReturnType<typeof setTimeout>|undefined;
  const armIdle=()=>{clearTimeout(idle);idle=setTimeout(()=>controller.abort(new GatewayError('The upstream stopped sending data',504,'timeout')),settings.timeoutMs);};
  const streaming=()=>{clearTimeout(timer);armIdle();ceiling||=setTimeout(()=>controller.abort(new GatewayError('Gateway request deadline exceeded',504,'timeout')),3600000);};
  const cancel=()=>{if(!res.writableEnded)controller.abort(new GatewayError('Client disconnected',499,'client_closed_request'));};res.on('close',cancel);
  let release:(()=>void)|undefined;let used=candidates[0];let route='';const start=Date.now();let status=500;let message='';let input=0,output=0;
  let retryAfter='';let fault=false;let tried=false;let t0=start;let exhausted:Exhaustion|undefined;let confirmedClean=false;let switches=0;let upstreamMessage='';let trimmed:string[]=[];let trimmedFor='';let trimRetried=false;
  // The first provider whose exit was used up: kept while later providers (not on that allowance) are tried, and reported if none of them answers.
  let spent:{ex:Exhaustion;message:string;status:number;used:typeof used;route:string}|undefined;
  try{
    release=await queue.acquire(k.id,k.limit,controller.signal,settings.queueWaitMs||0);
    let upstream:Response|undefined;
    const limited=new Set<string>();
    for(const m of candidates){if(limited.has(m.providerId))continue;
      // A trimmed tool list was chosen for the provider that refused the full one; the next candidate starts from what the client sent.
      if(trimmed.length){chat=askedChat;trimmed=[];}
      used=m;const p=settings.providers.find(p=>p.id===m.providerId&&p.enabled);if(!p)continue;
      // A provider whose chosen routes cannot take the request right now is skipped like one that failed, so the next provider is still tried.
      let r:ReturnType<typeof routeForProvider>;
      try{r=routeForProvider(p,m.id);route=r.name;}catch(e){if(e instanceof GatewayError&&e.type==='route_unavailable'&&!controller.signal.aborted&&m!==candidates[candidates.length-1]){status=e.status;message=e.message;fault=false;continue;}throw e;}
      // Rotating through a proxy pool needs more tries than a single-route retry budget.
      let attempts=settings.retries;if(r.id==='proxy-pool')attempts=Math.max(attempts,settings.pool?.retries??3);
      for(let attempt=0;attempt<=attempts;attempt++){
        if(attempt>0&&providerPicksAgain(p)){r=routeForProvider(p,m.id);route=r.name;}
        tried=true;t0=Date.now();retryAfter=''; // a wait asked for by an earlier failed attempt does not belong to this one
        // A tool list OpenCode refused earlier goes out already trimmed.
        if(!trimmed.length&&settings.trimTools!==false&&knownTrim(p.id,chat)){const t=coreOnly(chat);if(t){trimmedFor=p.id;trimmed=t.dropped;chat=t.chat;}}
        try{
          upstream=await providerChat(p,m,chat,controller.signal,r.id,sessionFor(k.id,chat.messages,req.headers),requestId);status=upstream.status;
          if(upstream.ok)break;
          fault=true;message=(await upstream.text()).slice(0,4000);const after=upstream.headers.get('retry-after');retryAfter=after||'';const parsed=after?(Number(after)*1000||Date.parse(after)-Date.now()):0;
          // Kilo's anonymous limit covers every Kilo model at once: they all rest together and the rest of this request skips them.
          if(p.kind==='kilo'&&isAddressLimit(status,message)){const until=pauseKilo(p.id,message);limited.add(p.id);fault=false;retryAfter=String(Math.ceil(KILO_LIMIT_PAUSE_MS/1000));
            const plain=`Kilo's free tier limits anonymous use per network address and has stopped answering from this one. Polygate rests all Kilo models until ${resetTime(until)} and then tries again. Kilo says a free account continues service: save its API key in the Kilo provider.`;
            notify('Kilo free limit reached',plain,'warning','kilo-limit',3600000);message=plain;break;}
          // The network layer confirmed this exit still has allowance, so the countdown in the answer belongs to a refused request, not to the model.
          const refused=takeRefused(requestId);if(refused)confirmedClean=true;
          // The exit is fine, so the refusal belongs to this request. When it carries tools OpenCode may object to, ask again with the standard ones only.
          if(refused&&settings.trimTools!==false&&!trimmed.length){const t=coreOnly(chat);if(t){learnTrim(p.id,chat);trimmedFor=p.id;trimmed=t.dropped;trimRetried=true;chat=t.chat;confirmedClean=false;attempts++;continue;}}const retryMs=!refused&&Number.isFinite(parsed)?Math.max(0,Math.min(parsed,86400000)):0;
          // The daily Free allowance follows the exit address, not the model: move to a clean exit, and never pause the model for it.
          const ex=takeExhaustion(requestId)||(refused?undefined:exhaustionOf(status,after,message));
          if(ex){
            exhausted=ex;notify(ex.refused?'Network exit refused':'Network exit used up',ex.refused?`${r.name} was refused by the Free tier; it is skipped until ${resetTime(ex.until)}.`:`${r.name} has used its daily Free allowance (resets ${resetTime(ex.until)}).`,'warning','exhausted|'+r.id,3600000);
            const alt=switches<3?exhaustedRouteAfter(p,r):undefined;
            if(alt){switches++;notify('Switched network exit',`Requests moved from ${r.name} to ${alt.name}.`,'info','switched|'+alt.id,600000);r=alt;route=r.name;attempts++;exhausted=undefined;continue;}
            break;
          }
          const blocked=status===403||status===401||/abuse|unusual activity|ip.block/i.test(message);const final=status<500||attempt===attempts;
          // A refusal through the proxy pool blames that proxy (already rotated out), not the model, and is retried on the next one.
          if(blocked&&r.id==='proxy-pool'&&attempt<attempts)continue;
          if(blocked||final)classifyModel(m,status,message,Date.now()-t0,retryMs);
          // A chain moves past a model that refuses it (blocked, or no longer offered) to the next step; the last step's refusal is the answer.
          if(blocked){if(chain&&m!==candidates[candidates.length-1]&&!controller.signal.aborted)break;throw new GatewayError(message,status,'upstream_error');}
          if(final)break;
          if(settings.failover!==false&&providerSwitches(p)){const alt=routeAfter(p,r);if(alt){r=alt;route=r.name;}}
        }catch(e){
          // A route that is switched off or not connected is skipped like a failed connection when failover is on.
          if(e instanceof GatewayError&&e.type==='route_unavailable'&&settings.failover!==false&&providerSwitches(p)&&attempt<attempts&&!controller.signal.aborted){const alt=routeAfter(p,r);if(alt){r=alt;route=r.name;continue;}}
          if(e instanceof GatewayError&&e.type==='route_unavailable'&&!controller.signal.aborted&&m!==candidates[candidates.length-1]){status=e.status;message=e.message;upstream=undefined;break;}
          if(e instanceof GatewayError||controller.signal.aborted)throw e;if(attempt===attempts){status=502;message=redactError(String(e));upstream=undefined;break;}
          if(settings.failover!==false&&providerSwitches(p)){const alt=routeAfter(p,r);if(alt){r=alt;route=r.name;}}}
      }
      if(!upstream?.ok&&chain)hops.push(`${m.id} (${status})`);
      if(upstream?.ok)break;
      if(exhausted){
        // The daily allowance follows the exit, so every model of this provider is skipped. A provider that is not on it (Kilo, your own) can still answer.
        limited.add(p.id);const later=candidates.slice(candidates.indexOf(m)+1).some(c=>!limited.has(c.providerId)&&settings.providers.some(q=>q.id===c.providerId&&q.enabled&&q.kind!=='free'));
        if(!later)break;
        spent??={ex:exhausted,message,status,used,route};exhausted=undefined;upstream=undefined;continue;
      }
      if(status!==429&&status<500&&!(chain&&[401,403,404,410].includes(status))&&!(candidates.length>1&&[404,410].includes(status)))break; // "auto" also moves on from a model the provider says is gone
    }
    if(!tried)throw new GatewayError('No enabled provider can serve this request',503,'models_unavailable');
    // A later attempt or candidate answered, so the failures before it are not recorded against this request or its model.
    if(upstream?.ok){fault=false;message='';}
    // Nothing answered after an exit was found used up: the used-up message, with its reset time, is the one the client reads.
    else if(spent){exhausted=spent.ex;message=spent.message;status=spent.status;used=spent.used;route=spent.route;}
    // A trimmed list that is refused too was not the cause: forget it, so the next request starts from the full list again.
    if(trimmed.length&&!upstream?.ok)forgetTrim(trimmedFor,askedChat);
    if(!upstream?.ok&&exhausted){fault=false;throw new GatewayError(message,429,'egress_exhausted');}
    if(!upstream?.ok)throw new GatewayError(message||'No provider responded successfully',status||502,'upstream_error');
    if(trimmed.length){res.setHeader('x-polygate-tools-trimmed',String(trimmed.length));if(trimRetried)logEvent('info','requests',`OpenCode Free refused this request while the exit was fine; it was accepted without ${trimmed.length} of the client's tools (${trimmed.slice(0,6).join(', ')}${trimmed.length>6?', …':''}). Polygate leaves them out of this tool list from now on. Turn this off with "Retry with fewer tools" under Routing.`,{model:used.id,route});}
    res.setHeader('x-polygate-model',used.id);if(chain)res.setHeader('x-polygate-chain',chain.name);if(hops.length)res.setHeader('x-polygate-skipped',encodeURIComponent(hops.join(', ')));res.setHeader('x-polygate-route',encodeURIComponent(route));
    // The answer is complete at [DONE], or when every choice that started has finished: with n > 1 one choice finishing is not the end.
    // `asked` is the number of answers requested (n): with fewer finished, a stream that ends without [DONE] is cut short.
    const asked=Math.max(1,Math.min(16,Math.floor(Number(askedChat.n))||1));
    let ended=false;let done=false;let firstAt=0;const writing=new Set<number>();const finished=new Set<number>();
    const observer=observeSse(raw=>{
      if(raw==='[DONE]'){done=true;ended=true;return;}
      try{const d=JSON.parse(raw);for(const c of d.choices||[]){const i=Number.isInteger(c?.index)?c.index:0;if(c?.finish_reason){writing.delete(i);finished.add(i);}else writing.add(i);}ended=done||(finished.size>=asked&&writing.size===0);if(d.usage){input=d.usage.prompt_tokens||0;output=d.usage.completion_tokens||0;}if(d.error){status=502;fault=true;message=d.error.message||'Upstream stream error';}}catch{}
    },()=>{firstAt=Date.now();streaming();},()=>{if(firstAt)armIdle();});
    // pipeTo rather than pipeThrough: an abort in the middle of the stream rejects the pipe, and that is handled here instead of surfacing as an unhandled rejection.
    lfBody(upstream).body!.pipeTo(observer.writable).catch(()=>{});const observed=observer.readable;
    const wrapped=new Response(observed,{headers:upstream.headers,status:upstream.status});
    if(body.stream){
      status=200;await stream(req,res,wrapped,protocol,used.id,asked);
      if(!controller.signal.aborted&&!ended){status=502;fault=true;message='Upstream stream ended before a terminal event';}
    }else{
      const data=await collect(wrapped);input=data.usage?.prompt_tokens||0;output=data.usage?.completion_tokens||0;
      // The upstream stream ended without a finish or [DONE]: the answer is cut short, so the client gets an error instead of a partial 200.
      if(!controller.signal.aborted&&!ended)throw new GatewayError('Upstream stream ended before a terminal event',502,'upstream_error');
      status=200;json(res,200,fromChat(data,protocol,used.id));
    }
    if(controller.signal.aborted){const reason:any=controller.signal.reason;status=reason instanceof GatewayError?reason.status:499;message=reason?.message||'Request cancelled';fault=false;}
    else classifyModel(used,status,message,firstAt?firstAt-t0:Date.now()-t0);
  }catch(e:any){
    const aborted=controller.signal.aborted;const reason:any=controller.signal.reason;const gateway=aborted&&reason instanceof GatewayError?reason:undefined;
    status=aborted?(gateway?.status??499):(e.status||502);message=redactError(aborted?(reason?.message||e.message||'Request cancelled'):(e.message||String(e)));
    // What the client reads is a plain sentence with the reset time and next steps; the provider's own answer stays in the request record.
    upstreamMessage=message;let nice=aborted?undefined:explainError({status,type:gateway?.type||e.type,message,model:used.id,route,switches,exhausted,confirmedClean,cooldownsEnabled:settings.cooldowns===true,requestBytes:Number(clientShape.body?.bytes)||undefined,messages:Number(clientShape.body?.messages)||undefined});
    if(nice)message=nice.message;
    if(!res.headersSent){const wait=nice?.retryAfter||e.retryAfter;if(retryAfter&&!nice?.retryAfter)res.setHeader('Retry-After',retryAfter);else if(wait)res.setHeader('Retry-After',String(wait));const type=gateway?.type||e.type;const body={type:nice?.code||type||(protocol==='anthropic'?'api_error':'gateway_error'),message,...(nice?{code:nice.code,...nice.extra}:{})};json(res,status,protocol==='anthropic'?{type:'error',error:body}:{error:body});}else if(!res.writableEnded)res.end();
  }
  finally{clearTimeout(timer);clearTimeout(idle);clearTimeout(ceiling);res.removeListener('close',cancel);release?.();if(input+output>0)recordUsage(k.id,input+output);
    let detail:string|undefined;
    if(tried){try{
      const ro=settings.routes.find(x=>x.name===route);const failed=(fault||!!exhausted)&&status>=400;
      detail=JSON.stringify({v:1,model:used.id,protocol,status,route:{name:route,id:ro?.id||'',kind:ro?.kind||''},cooldownsEnabled:settings.cooldowns===true,client:clientShape,upstreamMessage:upstreamMessage||undefined,attempts:takeAttempts(requestId),egress:failed&&ro?await egressInfo(ro.id,networkFetch):undefined,exhausted:exhausted?{until:exhausted.until,seconds:exhausted.seconds}:undefined});
    }catch{/* diagnostics never affect the request */}}
    const ms=Date.now()-start;record({id:requestId,time:Date.now(),model:used.id,provider:used.providerId,protocol,route,status,ms,input,output,error:message,keyId:k.id,fault:fault&&tried,detail});
    logEvent(status<400||status===499?'info':status>=500?'error':'warn','requests',`${status} ${chain?chain.name+' → ':''}${used.id}${route?` via ${route}`:''} · ${ms<1000?ms+' ms':(ms/1000).toFixed(1)+' s'}${hops.length?` · skipped ${hops.join(', ')}`:''}${status===499?' · cancelled by the client':status>=400&&message?` · ${message.slice(0,300)}`:''}`,{requestId,protocol,model:used.id,provider:used.providerId,route,status,...(chain?{chain:chain.name,skipped:hops.length?hops:undefined}:{}),durationMs:ms,inputTokens:input,outputTokens:output,key:k.name||k.id,stream:!!body.stream,...(status>=400?{error:message,upstream:upstreamMessage&&upstreamMessage!==message?upstreamMessage:undefined}:{})});}
}
// What could stop a client request right now, and where to fix it. `page` is the dashboard page that has the remedy.
export type ReadyIssue = { code: string; message: string; page: 'Providers' | 'Models' | 'Settings' | 'Routing' };
// Ready means a client request could succeed right now: not paused, a usable model, a usable client key and a route that would really be chosen
// (the same selection real requests use, asked without moving the rotation). Paused, Starting, Ready and Needs attention are the four states.
// `checklist` is everything worth fixing; `issues` are the ones among them that stop requests.
export function readiness(){
  const now=Date.now();const providers=settings.providers.filter(p=>p.enabled);
  // `known` models are listed and not gone; `usable` ones can also be asked right now (not resting).
  const known=[...models.values()].filter(m=>m.state!=='unavailable'&&providers.some(p=>p.id===m.providerId));
  const usable=known.filter(m=>m.cooldownUntil<=now);
  const routes=settings.routes.filter(r=>r.enabled&&(!r.cooldownUntil||r.cooldownUntil<now)).length;
  const starting=process.uptime()<30&&!known.length;
  const items=checklist({providers,known,usable,starting});
  const issues:ReadyIssue[]=items.filter(i=>i.severity==='blocking').map(i=>({code:i.id,message:i.detail,page:i.page}));
  const state:'paused'|'starting'|'ready'|'attention'=!settings.enabled?'paused':starting&&!issues.length?'starting':issues.length?'attention':'ready';
  return {ready:state==='ready',state,issues,checklist:items,enabled:settings.enabled,models:usable.length,routes,queue:{active:queue.active,waiting:queue.waiting.length}};
}
export async function probeModel(id:string){
  const m=models.get(id);if(!m)throw new GatewayError('Model not found',404);if(m.cooldownUntil>Date.now())throw new GatewayError('Model is cooling down; probing is deferred until its retry time.',429);
  const p=settings.providers.find(p=>p.id===m.providerId&&p.enabled);if(!p)throw new GatewayError('Provider is disabled',400);
  const route=routeForProvider(p,id);const start=Date.now();const c=new AbortController();let timedOut=false;const timer=setTimeout(()=>{timedOut=true;c.abort();},30000);let release:(()=>void)|undefined;
  try{
    release=await queue.acquire('availability-probe',1,c.signal);
    const r=await providerChat(p,m,{messages:[{role:'user',content:'Reply with OK.'}],max_tokens:16,stream:true},c.signal,route.id,'probe-'+crypto.randomUUID());
    let error='';if(r.ok)await collect(r);else error=await r.text();
    classifyModel(m,r.status,error,Date.now()-start);return m;
  }catch(e){
    // A full queue or cancelled wait says nothing about the model; only failures after admission are its verdict.
    if(release&&!(e instanceof GatewayError))classifyModel(m,timedOut?504:502,String(e),Date.now()-start);
    throw e;
  }finally{clearTimeout(timer);release?.();}
}
