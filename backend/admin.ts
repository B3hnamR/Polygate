import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { settings, publicSettings, persist, models, logs, stats, saveModel, removeModels, requestDetail, recentFailureDetails, recentBaselineDetails } from './state';
import { json, readJson, queue, probeModel, readiness } from './gateway';
import { discover, identityState, syncIdentity, rankedModels } from './providers';
import { startScan, startImport, stopEngine, removeProxies } from './proxy-engine';
import { testRoute, describeRoutes, backupChain } from './transport';
import { warpStatus, warpConnect, warpDisconnect, warpInstall, warpRotate, setWarpSettings, ensureRoute as ensureWarpRoute } from './warp';
import { poolStatus, testPool, stopPoolTest, poolConfig, poolEntries, attachPool, setPoolRole, apiUrl } from './pool';
import { createKey, updateKey } from './keys';
import { deployRelay, inspectVercel } from './relay-deploy';
import { metrics } from './metrics';
import { notices, markAllRead, clearNotices, testWebhook } from './notifications';
import { httpsStatus, httpsApply, httpsDisable, httpsRenew } from './https';
import { serverConfig } from './auth';
import { GatewayError } from './queue';
import type { Provider, Route, Settings } from './types';
const mask='••••••••';
function bounded(v:any,lo:number,hi:number){const n=typeof v==='number'||(typeof v==='string'&&v.trim()!=='')?Number(v):NaN;if(!Number.isFinite(n)||n<lo||n>hi)throw new GatewayError(`Expected a number between ${lo} and ${hi}`,400);return Math.floor(n);}
function url(v:any,schemes=['http:','https:']){let u:URL;try{u=new URL(String(v));}catch{throw new GatewayError('Enter a complete URL including its protocol',400);}if(!schemes.includes(u.protocol))throw new GatewayError('Unsupported URL protocol',400);return u.toString().replace(/\/$/,'');}
export async function admin(req:IncomingMessage,res:ServerResponse,pathname:string){
  const method=req.method;
  if(pathname==='/admin/state'&&method==='GET')return json(res,200,{settings:publicSettings(),models:rankedModels(),logs:logs(),stats:stats(),queue:{active:queue.active,waiting:queue.waiting.length},identity:identityState(),ready:readiness(),notices:notices().unread,server:{platform:process.platform,mode:serverConfig().desktop?'desktop':'server'},version:'0.1.0',runtime:Bun.version,routeInfo:describeRoutes(),backup:backupChain()});
  if(pathname==='/admin/metrics'&&method==='GET')return json(res,200,metrics());
  // Request-shape records (no prompt or completion content) for working out why a request was refused.
  if(pathname==='/admin/request'&&method==='GET'){const id=new URL(req.url||'','http://x').searchParams.get('id')||'';const row=requestDetail(id);if(!row)throw new GatewayError('Request not found',404);return json(res,200,row);}
  if(pathname==='/admin/diagnostics'&&method==='GET'){const q=new URL(req.url||'','http://x').searchParams;return json(res,200,{failures:recentFailureDetails(Math.min(100,Number(q.get('failures'))||20)),baseline:recentBaselineDetails(Math.min(20,Number(q.get('baseline'))||5))});}
  if(pathname==='/admin/settings'&&method==='POST'){
    const b=await readJson(req);const next:Partial<Settings>={};
    for(const key of ['enabled','fallback','rotate','autoProbe','failover','allowDirect','cooldowns','exhaustedFailover','catalogDirect'] as const)if(key in b){if(typeof b[key]!=='boolean')throw new GatewayError('Expected a boolean',400);next[key]=b[key];}
    for(const [key,lo,hi] of [['maxConcurrent',1,64],['maxQueue',0,512],['timeoutMs',1000,600000],['retries',0,2],['refreshMinutes',5,1440],['warpProxyPort',1024,65535],['queueWaitMs',0,120000],['relayRotations',0,10]] as const)if(key in b)(next as any)[key]=bounded(b[key],lo,hi);
    if(b.strategy){if(!['single','round_robin','random','fastest'].includes(b.strategy))throw new GatewayError('Unknown selection strategy',400);next.strategy=b.strategy;}
    if(b.routeId!==undefined){if(!settings.routes.some(r=>r.id===b.routeId&&r.enabled))throw new GatewayError('Select an enabled route',400);next.routeId=b.routeId;
      // Remember where requests went, so making the pool "standby only" can give the route back.
      if(b.routeId==='proxy-pool'&&settings.routeId!=='proxy-pool')next.previousRouteId=settings.routeId;}
    // Everything is validated before anything is applied, so a rejected request never half-applies.
    // Turning cooldowns off also releases models that are cooling down now, so the change takes effect immediately.
    if(next.cooldowns===false)for(const m of models.values())if(m.cooldownUntil||m.state==='cooldown'){m.cooldownUntil=0;m.failCount=0;if(m.state==='cooldown')m.state='unchecked';saveModel(m);}
    Object.assign(settings,next);queue.max=settings.maxConcurrent;queue.capacity=settings.maxQueue;queue.drain();
    persist();return json(res,200,{ok:true});
  }
  if(pathname==='/admin/discover'&&method==='POST'){await discover();return json(res,200,{ok:true,count:models.size});}
  if(pathname==='/admin/identity/refresh'&&method==='POST')return json(res,200,await syncIdentity());
  if(pathname==='/admin/probe'&&method==='POST'){const b=await readJson(req);return json(res,200,await probeModel(String(b.id)));}
  if(pathname==='/admin/model'&&method==='POST'){const b=await readJson(req);const m=models.get(b.id);if(!m)throw new GatewayError('Model not found',404);const priority=b.priority!==undefined?bounded(b.priority,0,1000):m.priority;const score=b.score!==undefined?bounded(b.score,0,100):m.score;m.priority=priority;m.score=score;saveModel(m);return json(res,200,{ok:true});}
  if(pathname==='/admin/providers'&&method==='POST'){
    const b=await readJson(req);const old=settings.providers.find(p=>p.id===b.id);
    if(!['free','openai','opencode'].includes(b.kind))throw new GatewayError('Unknown provider type',400);
    if(b.routeId&&!settings.routes.some(r=>r.id===b.routeId))throw new GatewayError('Provider route does not exist',400);
    const p:Provider={id:old?.id||'p-'+randomBytes(4).toString('hex'),name:String(b.name||'New provider').slice(0,80),kind:b.kind,enabled:b.enabled!==false,baseUrl:b.kind==='free'?'':url(b.baseUrl),apiKey:b.apiKey===mask?(old?.apiKey||''):String(b.apiKey||''),models:Array.isArray(b.models)?b.models.filter((x:any)=>typeof x==='string'&&x.length<200).slice(0,500):[],routeId:String(b.routeId||'')};
    if(p.kind==='free'&&settings.providers.some(x=>x.kind==='free'&&x.id!==p.id))throw new GatewayError('Only one adaptive Free provider is supported',400);
    if(old)Object.assign(old,p);else settings.providers.push(p);persist();return json(res,200,{ok:true,id:p.id});
  }
  if(pathname==='/admin/providers/delete'&&method==='POST'){const b=await readJson(req);if(b.id==='opencode')throw new GatewayError('Disable the built-in provider instead of deleting it',400);settings.providers=settings.providers.filter(p=>p.id!==b.id);removeModels(String(b.id));persist();return json(res,200,{ok:true});}
  if(pathname==='/admin/routes'&&method==='POST'){
    const b=await readJson(req);if(!['proxy','relay','warp'].includes(b.kind))throw new GatewayError('Choose proxy, relay, or WARP',400);
    const old=settings.routes.find(r=>r.id===b.id);if(old&&(old.id==='direct'||old.id==='proxy-pool'||old.managed))throw new GatewayError('This route is managed by Polygate and cannot be edited',409);
    const route:Route={id:old?.id||'r-'+randomBytes(4).toString('hex'),name:String(b.name||'New route').slice(0,80),kind:b.kind,url:b.kind==='warp'?(b.url?url(b.url,['http:','https:','socks5:']):`socks5://127.0.0.1:${settings.warpProxyPort}`):url(b.url,b.kind==='proxy'?['http:','https:','socks4:','socks5:']:['https:','http:']),token:b.token===mask?old?.token:String(b.token||''),enabled:b.enabled!==false,models:Array.isArray(b.models)?b.models.map(String).slice(0,100):[],buffered:!!b.buffered};
    if(old)Object.assign(old,route);else settings.routes.push(route);persist();return json(res,200,{ok:true,id:route.id});
  }
  if(pathname==='/admin/routes/toggle'&&method==='POST'){
    const b=await readJson(req);const route=settings.routes.find(r=>r.id===b.id);if(!route)throw new GatewayError('Route not found',404);
    if(typeof b.enabled!=='boolean')throw new GatewayError('Expected a boolean',400);
    if(!b.enabled&&(route.id==='direct'||route.id===settings.routeId||settings.providers.some(p=>p.routeId===route.id)))throw new GatewayError('Select another route before disabling this one',409);
    route.enabled=b.enabled;if(b.enabled){route.cooldownUntil=0;route.failures=0;route.opened=0;}persist();return json(res,200,{ok:true});
  }
  if(pathname==='/admin/routes/delete'&&method==='POST'){const b=await readJson(req);const route=settings.routes.find(r=>r.id===b.id);if(b.id==='direct'||b.id===settings.routeId||settings.providers.some(p=>p.routeId===b.id))throw new GatewayError('Select another route before deleting this one',409);if(route?.managed&&route.id==='warp')throw new GatewayError('The WARP route is managed by Polygate. Disable WARP in its panel instead.',409);settings.routes=settings.routes.filter(r=>r.id!==b.id);persist();return json(res,200,{ok:true});}
  if(pathname==='/admin/routes/test'&&method==='POST'){const b=await readJson(req);return json(res,200,await testRoute(b.id));}
  // Reads the plan of a Vercel account (Hobby allows one function region per project; Pro up to five) before anything is deployed. The token is not kept.
  if(pathname==='/admin/relays/inspect'&&method==='POST'){const b=await readJson(req);if(b.platform!=='vercel')throw new GatewayError('Only Vercel accounts can be inspected',400);return json(res,200,await inspectVercel(String(b.token||''),b.teamId?String(b.teamId):undefined));}
  // One-click relay: deploys the bundled template with the platform's API token (used for this call only, never saved), then saves the relay as a route.
  if(pathname==='/admin/relays/deploy'&&method==='POST'){
    const b=await readJson(req);const r=await deployRelay({platform:b.platform,token:String(b.token||''),name:b.name?String(b.name):undefined,region:b.region?String(b.region):undefined,runtime:b.runtime==='node'?'node':undefined,teamId:b.teamId?String(b.teamId):undefined});
    const route:Route={id:'r-'+randomBytes(4).toString('hex'),name:`${r.platform==='netlify'?'Netlify':'Vercel'} relay${r.region?' '+r.region:''} (${r.name})`.slice(0,80),kind:'relay',url:r.url,token:r.accessToken,enabled:true,models:[],...(r.buffered?{buffered:true}:{})};
    settings.routes.push(route);persist();
    return json(res,200,{ok:true,id:route.id,name:r.name,url:r.url,platform:r.platform,runtime:r.runtime,region:r.region,reachable:r.reachable,status:r.status,detail:r.detail});
  }
  // --- Cloudflare WARP ---
  if(pathname==='/admin/warp/status'&&method==='GET')return json(res,200,await warpStatus());
  if(pathname==='/admin/warp/connect'&&method==='POST')return json(res,200,await warpConnect());
  if(pathname==='/admin/warp/disconnect'&&method==='POST')return json(res,200,await warpDisconnect());
  if(pathname==='/admin/warp/install'&&method==='POST')return json(res,200,await warpInstall());
  if(pathname==='/admin/warp/rotate'&&method==='POST')return json(res,200,await warpRotate());
  if(pathname==='/admin/warp/settings'&&method==='POST'){const b=await readJson(req);const patch:any={};for(const k of ['engine','autoStart','pool','rotateMinutes','wireproxyPath'])if(k in b)patch[k]=b[k];if('port' in b)settings.warpProxyPort=bounded(b.port,1024,65535);await setWarpSettings(patch);return json(res,200,await warpStatus());}
  // --- scoped client keys ---
  if(pathname==='/admin/keys'&&method==='POST'){const b=await readJson(req);return json(res,200,{ok:true,key:createKey(b)});}
  if(pathname==='/admin/keys/update'&&method==='POST'){const b=await readJson(req);return json(res,200,{ok:true,key:updateKey(String(b.id),b)});}
  if(pathname==='/admin/keys/delete'&&method==='POST'){const b=await readJson(req);if(!settings.keys.some(k=>k.id===b.id))throw new GatewayError('Key not found',404);if(settings.keys.length<=1)throw new GatewayError('Keep at least one API key',409);settings.keys=settings.keys.filter(k=>k.id!==b.id);persist();return json(res,200,{ok:true});}
  if(pathname==='/admin/logs/clear'&&method==='POST'){const {db}=await import('./state');db.exec('DELETE FROM requests');return json(res,200,{ok:true});}
  // --- notifications ---
  if(pathname==='/admin/notifications'&&method==='GET')return json(res,200,notices());
  if(pathname==='/admin/notifications/read'&&method==='POST'){markAllRead();return json(res,200,{ok:true});}
  if(pathname==='/admin/notifications/clear'&&method==='POST'){clearNotices();return json(res,200,{ok:true});}
  if(pathname==='/admin/notify/settings'&&method==='POST'){
    const b=await readJson(req);const current=settings.notify?.webhookUrl||'';
    const webhookUrl=b.webhookUrl===mask?current:String(b.webhookUrl||'').trim();if(webhookUrl)url(webhookUrl,['https:','http:']);
    const minLevel=['info','success','warning','error'].includes(b.minLevel)?b.minLevel:settings.notify?.minLevel||'warning';
    settings.notify={webhookUrl:webhookUrl||undefined,minLevel};persist();return json(res,200,{ok:true});
  }
  if(pathname==='/admin/notify/test'&&method==='POST'){await testWebhook();return json(res,200,{ok:true});}
  // --- proxy pool (model-aware) ---
  if(pathname==='/admin/pool'&&method==='GET'){const q=new URL(req.url||'','http://x').searchParams;return json(res,200,await poolStatus({tab:q.get('tab')||undefined,q:q.get('q')||undefined,proto:q.get('proto')||undefined,sort:q.get('sort')||undefined,page:Number(q.get('page'))||1,pageSize:Number(q.get('pageSize'))||50}));}
  if(pathname==='/admin/pool/test'&&method==='POST'){const b=await readJson(req);return json(res,200,await testPool({deep:typeof b.deep==='boolean'?b.deep:undefined,urls:Array.isArray(b.urls)?b.urls.map(String).slice(0,1000):undefined}));}
  if(pathname==='/admin/pool/stop'&&method==='POST'){stopPoolTest();return json(res,200,{ok:true});}
  if(pathname==='/admin/pool/settings'&&method==='POST'){
    const b=await readJson(req);const cur=poolConfig();const next={...cur};
    if(b.mode!==undefined){if(!['ready','selected'].includes(b.mode))throw new GatewayError('Unknown pool mode',400);next.mode=b.mode;}
    if(b.deepTest!==undefined){if(typeof b.deepTest!=='boolean')throw new GatewayError('Expected a boolean',400);next.deepTest=b.deepTest;}
    if(b.recheckMinutes!==undefined)next.recheckMinutes=bounded(b.recheckMinutes,5,1440);
    if(b.maxTested!==undefined)next.maxTested=bounded(b.maxTested,1,500);
    if(b.concurrency!==undefined)next.concurrency=bounded(b.concurrency,1,32);
    if(b.retries!==undefined)next.retries=bounded(b.retries,1,8);
    if(b.standby!==undefined){if(typeof b.standby!=='boolean')throw new GatewayError('Expected a boolean',400);next.standby=b.standby;}
    if(b.standbyTarget!==undefined)next.standbyTarget=bounded(b.standbyTarget,1,20);
    if(b.standbyFreshMinutes!==undefined)next.standbyFreshMinutes=bounded(b.standbyFreshMinutes,5,240);
    if(b.keepWarm!==undefined){if(typeof b.keepWarm!=='boolean')throw new GatewayError('Expected a boolean',400);next.keepWarm=b.keepWarm;}
    if(b.apiCheck!==undefined){if(typeof b.apiCheck!=='boolean')throw new GatewayError('Expected a boolean',400);next.apiCheck=b.apiCheck;}
    if(b.apiMaxLatencyMs!==undefined)next.apiMaxLatencyMs=bounded(b.apiMaxLatencyMs,200,30000);
    if(b.apiTimeoutSec!==undefined)next.apiTimeoutSec=bounded(b.apiTimeoutSec,2,30);
    if(b.apiRecheckMinutes!==undefined)next.apiRecheckMinutes=bounded(b.apiRecheckMinutes,5,1440);
    settings.pool=next;persist();return json(res,200,{ok:true});
  }
  // Attach proxies from the verified pool as one rotating route: all model-ready ones, or an explicit selection.
  if(pathname==='/admin/proxy/attach'&&method==='POST'){
    const b=await readJson(req);const urls:string[]=Array.isArray(b.urls)?b.urls.map(String):b.url?[String(b.url)]:[];
    return json(res,200,{ok:true,...await attachPool({urls,select:b.select!==false})});
  }
  // Switches the existing pool route between active (every request) and standby (only when the active exit is used up).
  if(pathname==='/admin/pool/role'&&method==='POST'){const b=await readJson(req);if(typeof b.select!=='boolean')throw new GatewayError('Expected select to be true or false',400);if(!settings.routes.some(r=>r.id==='proxy-pool'&&r.enabled))throw new GatewayError('Attach the pool first',400);setPoolRole(b.select);persist();return json(res,200,{ok:true,routeId:settings.routeId});}
  // Finding proxies: download the public lists (or read a pasted one), keep the ones that load the OpenCode API fast enough, then (find) model-test them.
  const engineOptions=(after?:()=>void)=>{const c=poolConfig();return {api:apiUrl(),timeoutSec:c.apiTimeoutSec!,gateMs:c.apiMaxLatencyMs!,after};};
  if(pathname==='/admin/proxies/scan'&&method==='POST'){const b=await readJson(req);return json(res,200,startScan(engineOptions(b.find===false?undefined:()=>{void testPool({deep:true,api:true,attach:{select:b.select===true}}).catch(()=>{});})));}
  if(pathname==='/admin/proxies/import'&&method==='POST'){const b=await readJson(req);const text=String(b.text||'');if(!text.trim())throw new GatewayError('Paste at least one proxy address',400);return json(res,200,startImport(text,engineOptions(b.find===false?undefined:()=>{void testPool({deep:true,api:true,attach:{select:b.select===true}}).catch(()=>{});})));}
  if(pathname==='/admin/proxies/stop'&&method==='POST'){stopEngine();stopPoolTest();return json(res,200,{ok:true});}
  if(pathname==='/admin/proxies/remove'&&method==='POST'){const b=await readJson(req);if(b.all===true)removeProxies();else if(Array.isArray(b.urls))removeProxies(b.urls.map(String).slice(0,5000));else throw new GatewayError('Say which proxies to remove',400);await poolEntries(true);return json(res,200,{ok:true});}
  // Model-test the proxies already saved: OpenCode API check, speed gate, model test, then the working ones go into the pool.
  if(pathname==='/admin/pool/find'&&method==='POST'){const b=await readJson(req);return json(res,200,await testPool({deep:true,api:true,attach:{select:b.select===true}}));}
  // --- HTTPS ---
  if(pathname==='/admin/https'&&method==='GET')return json(res,200,await httpsStatus());
  if(pathname==='/admin/https/apply'&&method==='POST'){const b=await readJson(req);return json(res,200,await httpsApply(b));}
  if(pathname==='/admin/https/renew'&&method==='POST')return json(res,200,await httpsRenew());
  if(pathname==='/admin/https/disable'&&method==='POST')return json(res,200,await httpsDisable());
  throw new GatewayError('Admin endpoint not found',404);
}

