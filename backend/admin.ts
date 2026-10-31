import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { settings, publicSettings, persist, models, logs, stats, saveModel, removeModels, requestDetail, recentFailureDetails, recentBaselineDetails } from './state';
import { json, readJson, queue, probeModel, readiness } from './gateway';
import { discover, identityState, syncIdentity, rankedModels } from './providers';
import { startScan, startImport, stopEngine, removeProxies, proxyLists, fetchList } from './proxy-engine';
import { PROXY_SOURCES } from './proxy-sources';
import { testRoute, describeRoutes, backupChain, providerRoutes } from './transport';
import { warpStatus, warpConnect, warpDisconnect, warpInstall, warpRotate, setWarpSettings, checkHelperPath } from './warp';
import { poolStatus, testPool, stopPoolTest, poolConfig, poolEntries, attachPool, setPoolRole, apiUrl } from './pool';
import { createKey, updateKey } from './keys';
import { KILO_ID, KILO_BASE } from './kilo';
import { deployRelay, inspectVercel, removeFromPlatform } from './relay-deploy';
import { relayReport } from './metrics';
import { metrics, usage } from './metrics';
import { createBackup, restoreBackup } from './backup';
import { notices, markAllRead, clearNotices, testWebhook } from './notifications';
import { httpsStatus, httpsApply, httpsDisable, httpsRenew } from './https';
import { serverConfig, requirePassword } from './auth';
import { previewRouting } from './plan';
import { GatewayError } from './queue';
import { cleanChain, MAX_CHAINS } from './chains';
import { version } from './version';
import { checkForUpdates } from './updates';
import { queryEvents, exportEvents, clearEvents, parseLogQuery, logEvent } from './logbook';
import { mcpConfig, mcpState, serverStatus, cleanServer, parseImport, slug, testServer, saveServers, settle, reconnect, callTool, canManageLocal, syncMcp } from './mcp';
// The MCP page: hub settings, servers, their tools, connection tests and trying a tool.
async function mcpAdmin(req:IncomingMessage,res:ServerResponse,pathname:string){
  const method=req.method;const cfg=mcpConfig();const local=canManageLocal(req);
  const find=(id:unknown)=>{const s=cfg.servers.find(x=>x.id===id);if(!s)throw new GatewayError('No such MCP server',404);return s;};
  if(pathname==='/admin/mcp'&&method==='GET')return json(res,200,mcpState(req));
  if(method!=='POST')throw new GatewayError('Endpoint not found',404);
  const b=await readJson(req);
  if(pathname==='/admin/mcp/settings'){
    if(b.enabled!==undefined)cfg.enabled=!!b.enabled;if(b.builtin!==undefined)cfg.builtin=!!b.builtin;
    if(Array.isArray(b.builtinKeys)){const keys=b.builtinKeys.map(String).filter((id:string)=>settings.keys.some(k=>k.id===id));cfg.builtinKeys=keys.length?keys:undefined;}
    persist();syncMcp();return json(res,200,mcpState(req));
  }
  if(pathname==='/admin/mcp/servers'){
    const saved=b.id?find(b.id):undefined;const next=cleanServer(b,saved,local);
    saveServers(saved?cfg.servers.map(s=>s.id===saved.id?next:s):[...cfg.servers,next]);await settle(next.id);return json(res,200,serverStatus(next));
  }
  if(pathname==='/admin/mcp/servers/delete'){const s=find(b.id);saveServers(cfg.servers.filter(x=>x.id!==s.id));return json(res,200,{ok:true});}
  if(pathname==='/admin/mcp/servers/toggle'){const s=find(b.id);const next={...s,enabled:!!b.enabled};saveServers(cfg.servers.map(x=>x.id===s.id?next:x));await settle(next.id);return json(res,200,serverStatus(next));}
  if(pathname==='/admin/mcp/servers/tools'){const s=find(b.id);const next=cleanServer({disabledTools:Array.isArray(b.disabledTools)?b.disabledTools:[]},s,local);saveServers(cfg.servers.map(x=>x.id===s.id?next:x));return json(res,200,serverStatus(next));}
  if(pathname==='/admin/mcp/servers/reconnect')return json(res,200,await reconnect(String(b.id||'')));
  if(pathname==='/admin/mcp/test'){const saved=b.id?find(b.id):undefined;const draft=cleanServer({...b,name:b.name||saved?.name||'test'},saved,local);return json(res,200,await testServer(draft));}
  if(pathname==='/admin/mcp/call'){
    const scope=b.server==='polygate'?'polygate':find(b.server).name;
    return json(res,200,await callTool(String(b.tool||''),b.arguments,undefined,scope,'dashboard'));
  }
  if(pathname==='/admin/mcp/import'){
    const added:any[]=[];const skipped:{name:string;reason:string}[]=[];const servers=[...cfg.servers];
    for(const item of parseImport(b.config)){
      const name=slug(item.name,servers.map(s=>s.name));
      if(item.invalid){skipped.push({name:item.name,reason:item.invalid});continue;}
      try{const next=cleanServer({...item,name},undefined,local);servers.push(next);added.push(next.name);}
      catch(e:any){skipped.push({name:item.name,reason:e.message});}
    }
    if(added.length)saveServers(servers);
    return json(res,200,{added,skipped});
  }
  throw new GatewayError('Endpoint not found',404);
}
import type { Deployed, Provider, ProviderRoutes, Route, Settings } from './types';
const mask='••••••••';
function bounded(v:any,lo:number,hi:number){const n=typeof v==='number'||(typeof v==='string'&&v.trim()!=='')?Number(v):NaN;if(!Number.isFinite(n)||n<lo||n>hi)throw new GatewayError(`Expected a number between ${lo} and ${hi}`,400);return Math.floor(n);}
// A saved secret shown as dots must not follow an edited address to another server: whoever changes the host has to type the secret again.
const sameServer=(a:string,b:string)=>{try{return new URL(a).origin===new URL(b).origin;}catch{return a===b;}};
function url(v:any,schemes=['http:','https:']){let u:URL;try{u=new URL(String(v));}catch{throw new GatewayError('Enter a complete URL including its protocol',400);}if(!schemes.includes(u.protocol))throw new GatewayError('Unsupported URL protocol',400);return u.toString().replace(/\/$/,'');}
// The routes a provider may use, from what a client sent: `routes` ({ids, spread, backups}), null for "follow the route in use", or the single routeId older
// clients send. Nothing sent keeps what the provider has. A relay reaches public HTTPS hosts; a provider on a local address is reached directly whichever route it has.
function chosenRoutes(b: any, old?: Provider): ProviderRoutes | undefined {
  let raw: any;
  if (b.routes === null) raw = null;
  else if (b.routes !== undefined) raw = b.routes;
  else if (typeof b.routeId === 'string') raw = b.routeId ? { ids: [b.routeId], backups: !old?.routes } : null; // a provider pinned the old way keeps the backup exits of OpenCode Free
  else return old?.routes;
  if (raw === null || (Array.isArray(raw.ids) && !raw.ids.length)) return undefined;
  if (typeof raw !== 'object' || !Array.isArray(raw.ids)) throw new GatewayError('Choose the routes as a list of route ids', 400);
  const ids = [...new Set<string>(raw.ids.map(String))]; if (ids.length > 50) throw new GatewayError('At most 50 routes', 400);
  for (const id of ids) {
    const route = settings.routes.find(r => r.id === id);
    if (!route) throw new GatewayError('Provider route does not exist', 400);
    if (route.only && route.only !== b.kind && !(route.only === 'kilo' && b.kind === 'openai')) throw new GatewayError('This relay cannot carry that provider: OpenCode refuses a Cloudflare Worker. Choose a Vercel or Netlify relay, Direct, a proxy or WARP.', 400);
  }
  return { ids, spread: raw.spread === true, backups: b.kind === 'free' && raw.backups === true };
}
// Providers for which this route is the last enabled one in their list: switching it off or deleting it would leave them nowhere to go.
const soleRouteOf = (routeId: string) => settings.providers.filter(p => { const set = providerRoutes(p); return !!set && set.ids.includes(routeId) && !set.ids.some(id => id !== routeId && settings.routes.some(r => r.id === id && r.enabled)); });
// The text before the slash in every model of a provider ("test1/gpt-4"). The user picks it; without one it comes from the provider's name.
const PREFIX_RESERVED = new Set(['opencode', 'kilo', 'free', 'auto', 'chain']);
function providerPrefix(b: any): string {
  const typed = String(b.idPrefix ?? '').trim().toLowerCase();
  if (typed) {
    if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(typed)) throw new GatewayError('The model prefix can use lowercase letters, numbers and dashes, up to 30 characters.', 400);
    if (PREFIX_RESERVED.has(typed) || settings.providers.some(x => x.id === typed)) throw new GatewayError(`The prefix "${typed}" is already used. Choose another.`, 400);
    return typed;
  }
  const base = String(b.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  if (base && !PREFIX_RESERVED.has(base) && !settings.providers.some(x => x.id === base)) return base;
  return (base || 'p') + '-' + randomBytes(3).toString('hex');
}
export async function admin(req:IncomingMessage,res:ServerResponse,pathname:string){
  const method=req.method;
  if(pathname==='/admin/updates'&&method==='GET')return json(res,200,await checkForUpdates());
  if(pathname==='/admin/updates/check'&&method==='POST'){await readJson(req);return json(res,200,await checkForUpdates(true));}
  if(pathname==='/admin/state'&&method==='GET')return json(res,200,{settings:publicSettings(),models:rankedModels(),logs:logs(),stats:stats(),queue:{active:queue.active,waiting:queue.waiting.length},identity:identityState(),ready:readiness(),notices:notices().unread,server:{platform:process.platform,mode:serverConfig().desktop?'desktop':'server'},version,runtime:Bun.version,routeInfo:describeRoutes(),backup:backupChain()});
  if(pathname==='/admin/metrics'&&method==='GET')return json(res,200,metrics());
  // Settings backup: one passphrase-protected file that can be restored on any computer (see backup.ts). The file is sent to the dashboard to be saved; nothing is written on disk here.
  if(pathname==='/admin/backup/export'&&method==='POST'){const b=await readJson(req);requirePassword(req,b.password);const out=createBackup(b.passphrase);logEvent('info','backup',`Settings backup exported (${out.providers} providers, ${out.routes} routes, ${out.keys} keys)`);return json(res,200,out);}
  if(pathname==='/admin/backup/restore'&&method==='POST'){const b=await readJson(req,16*1024*1024);requirePassword(req,b.password);const out=restoreBackup(b.content,b.passphrase,canManageLocal(req));logEvent('warn','backup',`Settings restored from a backup (${out.providers} providers, ${out.routes} routes, ${out.keys} keys); the previous settings were kept as ${out.kept}`);syncMcp();return json(res,200,{ok:true,...out});}
  if(pathname==='/admin/usage'&&method==='GET')return json(res,200,usage(Number(new URL(req.url||'/','http://x').searchParams.get('days'))));
  if(pathname==='/admin/mcp'||pathname.startsWith('/admin/mcp/'))return mcpAdmin(req,res,pathname);
  if(pathname==='/admin/events'&&method==='GET')return json(res,200,queryEvents(parseLogQuery(new URL(req.url||'/','http://x').searchParams)));
  if(pathname==='/admin/events/export'&&method==='GET'){
    const params=new URL(req.url||'/','http://x').searchParams;const format=params.get('format')==='json'?'json':'txt';
    const stamp=new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
    res.writeHead(200,{'content-type':format==='json'?'application/x-ndjson; charset=utf-8':'text/plain; charset=utf-8','content-disposition':`attachment; filename="polygate-logs-${stamp}.${format==='json'?'ndjson':'log'}"`,'cache-control':'no-store'});
    res.end(exportEvents(parseLogQuery(params),format));return;
  }
  if(pathname==='/admin/events/clear'&&method==='POST'){await readJson(req);clearEvents();return json(res,200,{ok:true});}
  // Request-shape records (no prompt or completion content) for working out why a request was refused.
  if(pathname==='/admin/request'&&method==='GET'){const id=new URL(req.url||'','http://x').searchParams.get('id')||'';const row=requestDetail(id);if(!row)throw new GatewayError('Request not found',404);return json(res,200,row);}
  if(pathname==='/admin/diagnostics'&&method==='GET'){const q=new URL(req.url||'','http://x').searchParams;return json(res,200,{failures:recentFailureDetails(Math.max(1,Math.min(100,Math.floor(Number(q.get('failures')))||20))),baseline:recentBaselineDetails(Math.max(1,Math.min(20,Math.floor(Number(q.get('baseline')))||5)))});}
  if(pathname==='/admin/settings'&&method==='POST'){
    const b=await readJson(req);const next:Partial<Settings>={};
    for(const key of ['enabled','fallback','rotate','autoProbe','failover','allowDirect','cooldowns','trimTools','exhaustedFailover','relayRecheck','catalogDirect','spreadDirect'] as const)if(key in b){if(typeof b[key]!=='boolean')throw new GatewayError('Expected a boolean',400);next[key]=b[key];}
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
  // Fallback chains: a named, ordered list of models that a client asks for like any model.
  if(pathname==='/admin/chains/save'&&method==='POST'){
    const b=await readJson(req);const existing=b.id?settings.chains?.find(c=>c.id===b.id):undefined;
    if(b.id&&!existing)throw new GatewayError('Chain not found',404);
    if(!existing&&(settings.chains?.length||0)>=MAX_CHAINS)throw new GatewayError(`Up to ${MAX_CHAINS} chains are supported.`,400,'invalid_chain');
    const chain=cleanChain(b,existing);settings.chains=existing?settings.chains!.map(c=>c.id===chain.id?chain:c):[...(settings.chains||[]),chain];
    persist();return json(res,200,{ok:true,chain});
  }
  if(pathname==='/admin/chains/delete'&&method==='POST'){const b=await readJson(req);if(!settings.chains?.some(c=>c.id===b.id))throw new GatewayError('Chain not found',404);settings.chains=settings.chains.filter(c=>c.id!==b.id);persist();return json(res,200,{ok:true});}
  // Preview routing: which models a request would try, in order, and why each was skipped, without sending anything. It reads the current settings
  // and the health Polygate already knows; it does not prove the provider will accept the next real request.
  if(pathname==='/admin/route-preview'&&method==='POST'){
    const b=await readJson(req);const key=b.keyId?settings.keys.find(k=>k.id===String(b.keyId)):undefined;
    if(b.keyId&&!key)throw new GatewayError('That client key does not exist',404);
    const tokens=Number(b.tokens);const needs={tools:b.tools===true,images:b.images===true,tokens:Number.isFinite(tokens)&&tokens>0?Math.min(Math.round(tokens),5_000_000):0};
    return json(res,200,previewRouting(String(b.model||'auto'),key,needs));
  }
  if(pathname==='/admin/discover'&&method==='POST'){await discover();return json(res,200,{ok:true,count:models.size});}
  if(pathname==='/admin/identity/refresh'&&method==='POST')return json(res,200,await syncIdentity());
  if(pathname==='/admin/probe'&&method==='POST'){const b=await readJson(req);return json(res,200,await probeModel(String(b.id)));}
  if(pathname==='/admin/model'&&method==='POST'){const b=await readJson(req);const m=models.get(b.id);if(!m)throw new GatewayError('Model not found',404);const priority=b.priority!==undefined?bounded(b.priority,0,1000):m.priority;const score=b.score!==undefined?bounded(b.score,0,100):m.score;m.priority=priority;m.score=score;saveModel(m);return json(res,200,{ok:true});}
  if(pathname==='/admin/providers'&&method==='POST'){
    const b=await readJson(req);const old=settings.providers.find(p=>p.id===b.id);
    if(!['free','openai','opencode','kilo'].includes(b.kind))throw new GatewayError('Unknown provider type',400);
    if(old&&b.kind!==old.kind)throw new GatewayError("A provider's type cannot be changed. Add a new provider instead.",400);
    const routes=chosenRoutes(b,old);
    if(b.kind==='kilo'&&!old&&settings.providers.some(x=>x.kind==='kilo'))throw new GatewayError('Only one Kilo provider is supported',400);
    const p:Provider={id:old?.id||(b.kind==='kilo'?KILO_ID:providerPrefix(b)),name:String(b.name||(b.kind==='kilo'?'Kilo Free':'New provider')).slice(0,80),kind:b.kind,enabled:b.enabled!==false,baseUrl:b.kind==='free'?'':b.kind==='kilo'&&!b.baseUrl?KILO_BASE:url(b.baseUrl),apiKey:b.apiKey===mask?(old?.apiKey||''):String(b.apiKey||''),models:Array.isArray(b.models)?b.models.filter((x:any)=>typeof x==='string'&&x.length<200).slice(0,500):[],routeId:routes?.ids[0]||'',...(routes?{routes}:{})};
    if(p.kind==='free'&&settings.providers.some(x=>x.kind==='free'&&x.id!==p.id))throw new GatewayError('Only one adaptive Free provider is supported',400);
    if(old&&b.apiKey===mask&&old.apiKey&&p.baseUrl&&old.baseUrl&&!sameServer(p.baseUrl,old.baseUrl))throw new GatewayError('You changed the server address. Enter the API key again so the saved key is not sent to the new server.',400);
    if(old){if(!routes)delete old.routes;Object.assign(old,p);}else settings.providers.push(p);persist();return json(res,200,{ok:true,id:p.id});
  }
  if(pathname==='/admin/providers/delete'&&method==='POST'){const b=await readJson(req);if(b.id==='opencode'||b.id===KILO_ID)throw new GatewayError('Disable the built-in provider instead of deleting it',400);settings.providers=settings.providers.filter(p=>p.id!==b.id);removeModels(String(b.id));persist();return json(res,200,{ok:true});}
  if(pathname==='/admin/routes'&&method==='POST'){
    const b=await readJson(req);if(!['proxy','relay','warp'].includes(b.kind))throw new GatewayError('Choose proxy, relay, or WARP',400);
    const old=settings.routes.find(r=>r.id===b.id);if(old&&(old.id==='direct'||old.id==='proxy-pool'||old.managed))throw new GatewayError('This route is managed by Polygate and cannot be edited',409);
    const route:Route={id:old?.id||'r-'+randomBytes(4).toString('hex'),name:String(b.name||'New route').slice(0,80),kind:b.kind,url:b.kind==='warp'?(b.url?url(b.url,['http:','https:','socks5:']):`socks5://127.0.0.1:${settings.warpProxyPort}`):url(b.url,b.kind==='proxy'?['http:','https:','socks4:','socks5:']:['https:','http:']),token:b.token===mask?old?.token:String(b.token||''),enabled:b.enabled!==false,models:Array.isArray(b.models)?b.models.map(String).slice(0,100):[],buffered:!!b.buffered};
    // A relay holds an access token that every request sends; over plain http it would cross the network readable, so http is only for a relay on this computer.
    if(route.kind==='relay'&&route.url.startsWith('http:')&&!['127.0.0.1','localhost','[::1]'].includes(new URL(route.url).hostname))throw new GatewayError('A relay must use https://, because its access token is sent with every request. Plain http:// is only allowed for a relay on this computer.',400);
    if(old&&b.token===mask&&old.token&&!sameServer(route.url,old.url))throw new GatewayError('You changed the address. Enter the access token again so the saved token is not sent to the new server.',400);
    if(old&&!route.enabled&&old.enabled){if(old.id===settings.routeId)throw new GatewayError('Select another route before disabling this one',409);const only=soleRouteOf(old.id);if(only.length)throw new GatewayError(`Select another route before disabling this one: it is the only route chosen for ${only.map(p=>p.name).join(', ')}. Add another route to that provider first.`,409);}
    if(old)Object.assign(old,route);else settings.routes.push(route);persist();return json(res,200,{ok:true,id:route.id});
  }
  if(pathname==='/admin/routes/toggle'&&method==='POST'){
    const b=await readJson(req);const route=settings.routes.find(r=>r.id===b.id);if(!route)throw new GatewayError('Route not found',404);
    if(typeof b.enabled!=='boolean')throw new GatewayError('Expected a boolean',400);
    if(!b.enabled&&route.id===settings.routeId)throw new GatewayError('Select another route before disabling this one',409);
    if(!b.enabled){const only=soleRouteOf(route.id);if(only.length)throw new GatewayError(`Select another route before disabling this one: it is the only route chosen for ${only.map(p=>p.name).join(', ')}. Add another route to that provider first.`,409);}
    // Direct can be switched off so requests never leave from this network's own address, but only while another route is on to carry them.
    if(!b.enabled&&route.id==='direct'&&!settings.routes.some(r=>r.id!=='direct'&&r.enabled))throw new GatewayError('Turn on another route first (a proxy, a relay or WARP): with Direct off, requests need somewhere else to go',409);
    route.enabled=b.enabled;if(b.enabled){route.cooldownUntil=0;route.failures=0;route.opened=0;}persist();return json(res,200,{ok:true});
  }
  // A route the breaker paused after failures (a dropped connection) is tried again at once instead of waiting out the pause.
  if(pathname==='/admin/routes/resume'&&method==='POST'){
    const b=await readJson(req);const route=settings.routes.find(r=>r.id===b.id);if(!route)throw new GatewayError('Route not found',404);
    route.cooldownUntil=0;route.failures=0;route.opened=0;persist();logEvent('info','routes',`${route.name} was resumed by hand`,{route:route.id});return json(res,200,{ok:true});
  }
  // Deleting a route is refused while a provider or the main selection depends on it; the checks are shared with removing a relay from its platform.
  const assertRouteDeletable=(id:string)=>{const route=settings.routes.find(r=>r.id===id);if(id==='direct'||id===settings.routeId)throw new GatewayError('Select another route before deleting this one',409);{const only=soleRouteOf(id);if(only.length)throw new GatewayError(`Select another route before deleting this one: it is the only route chosen for ${only.map(p=>p.name).join(', ')}.`,409);}if(route?.managed&&route.id==='warp')throw new GatewayError('The WARP route is managed by Polygate. Disable WARP in its panel instead.',409);};
  const deleteRoute=(id:string)=>{settings.routes=settings.routes.filter(r=>r.id!==id);for(const p of settings.providers)if(p.routes?.ids.includes(id)){p.routes={...p.routes,ids:p.routes.ids.filter(i=>i!==id)};p.routeId=p.routes.ids[0]||'';}persist();};
  if(pathname==='/admin/routes/delete'&&method==='POST'){const b=await readJson(req);assertRouteDeletable(String(b.id));deleteRoute(String(b.id));return json(res,200,{ok:true});}
  if(pathname==='/admin/routes/test'&&method==='POST'){const b=await readJson(req);return json(res,200,await testRoute(b.id,b.providerId?String(b.providerId):undefined));}
  // Platform tokens: a token the user chose to remember (b.useSaved) is read from the encrypted settings here and never sent to the dashboard.
  // Without that choice a token is used for the one call and dropped.
  const labels={netlify:'Netlify',cloudflare:'Cloudflare',vercel:'Vercel'} as const;
  const platformOf=(raw:unknown)=>{if(raw!=='vercel'&&raw!=='netlify'&&raw!=='cloudflare')throw new GatewayError('Choose Vercel, Netlify or Cloudflare',400);return raw;};
  const deployToken=(b:any)=>{if(b.useSaved!==true)return String(b.token||'');const platform=platformOf(b.platform);const saved=settings.deployTokens?.[platform];if(!saved)throw new GatewayError(`No ${labels[platform]} token is saved. Paste a token to continue.`,400);return saved;};
  const deployAccount=(b:any)=>String(b.accountId||'').trim()||(b.useSaved===true?settings.deployAccounts?.cloudflare||'':'');
  const remember=(platform:'vercel'|'netlify'|'cloudflare',token:string,account?:string)=>{settings.deployTokens={...settings.deployTokens,[platform]:token.trim()};if(platform==='cloudflare'&&account)settings.deployAccounts={...settings.deployAccounts,cloudflare:account.trim().toLowerCase()};};
  // What a deployed relay is called on its platform: stored when Polygate deployed it, or read from the route's name ("Vercel relay fra1 (polygate-relay-fra1-a2d9)") for relays deployed by earlier versions.
  const deployedOf=(route:Route):Deployed|undefined=>{
    if(route.kind!=='relay')return undefined;if(route.deployed)return route.deployed;
    const m=/^(Vercel|Netlify|Cloudflare) relay(?: ([a-z]{3}\d))? \(([a-z0-9][a-z0-9-]*)\)$/.exec(route.name);if(!m)return undefined;
    return {platform:m[1].toLowerCase() as Deployed['platform'],name:m[3],...(m[2]?{region:m[2]}:{})};
  };
  const relayRoute=(id:unknown)=>{const route=settings.routes.find(r=>r.id===id);if(!route||route.kind!=='relay')throw new GatewayError('Relay not found',404);return route;};
  // Reads the plan of a Vercel account (Hobby allows one function region per project; Pro up to five) before anything is deployed.
  if(pathname==='/admin/relays/inspect'&&method==='POST'){const b=await readJson(req);if(b.platform!=='vercel')throw new GatewayError('Only Vercel accounts can be inspected',400);return json(res,200,await inspectVercel(deployToken(b),b.teamId?String(b.teamId):undefined));}
  if(pathname==='/admin/relays/token/forget'&&method==='POST'){const b=await readJson(req);if(b.platform){const p=platformOf(b.platform);if(settings.deployTokens)delete settings.deployTokens[p];if(p==='cloudflare')delete settings.deployAccounts;}else{delete settings.deployTokens;delete settings.deployAccounts;}if(settings.deployTokens&&!Object.keys(settings.deployTokens).length)delete settings.deployTokens;persist();return json(res,200,{ok:true});}
  // One-click relay: deploys the bundled template with the platform's API token, then saves the relay as a route (with what the platform calls it, for updating or removing it later).
  if(pathname==='/admin/relays/deploy'&&method==='POST'){
    const b=await readJson(req);const platform=platformOf(b.platform);const token=deployToken(b);const accountId=deployAccount(b);
    const r=await deployRelay({platform,token,name:b.name?String(b.name):undefined,region:b.region?String(b.region):undefined,runtime:b.runtime==='node'?'node':undefined,teamId:b.teamId?String(b.teamId):undefined,accountId:accountId||undefined});
    const deployed:Deployed={platform,name:r.name,...(r.region?{region:r.region}:{}),...(r.siteId?{siteId:r.siteId}:{}),...(r.account?{account:r.account}:{}),...(platform==='vercel'&&b.teamId?{team:String(b.teamId)}:{}),...(platform==='vercel'?{runtime:b.runtime==='node'?'node' as const:'bun' as const}:{})};
    const route:Route={id:'r-'+randomBytes(4).toString('hex'),name:`${labels[platform]} relay${r.region?' '+r.region:''} (${r.name})`.slice(0,80),kind:'relay',url:r.url,token:r.accessToken,enabled:true,models:[],...(r.buffered?{buffered:true}:{}),...(r.only?{only:r.only}:{}),deployed};
    settings.routes.push(route);if(b.remember===true&&b.useSaved!==true)remember(platform,token,r.account);persist();
    return json(res,200,{ok:true,id:route.id,name:r.name,url:r.url,platform:r.platform,runtime:r.runtime,region:r.region,only:r.only,reachable:r.reachable,status:r.status,detail:r.detail});
  }
  // Deploys the current relay code again under the same name, address and access token, so a relay deployed by an older version gets what newer versions changed.
  if(pathname==='/admin/relays/update'&&method==='POST'){
    const b=await readJson(req);const route=relayRoute(b.id);const d=deployedOf(route);
    if(!d)throw new GatewayError('Polygate did not deploy this relay, so it cannot update it. Deploy a new one instead.',400);
    if(!route.token)throw new GatewayError('This relay has no access token saved, so it cannot be updated',400);
    const body={...b,platform:d.platform};const token=deployToken(body);const accountId=deployAccount(body)||d.account||'';
    const r=await deployRelay({platform:d.platform,token,name:d.name,region:d.region,runtime:d.runtime,teamId:d.team,accountId:accountId||undefined,update:{access:route.token,siteId:d.siteId}});
    route.url=r.url;if(r.buffered)route.buffered=true;else delete route.buffered;route.deployed={...d,name:r.name,...(r.siteId?{siteId:r.siteId}:{}),...(r.account?{account:r.account}:{})};if(r.reachable)route.status='healthy';
    if(b.remember===true&&b.useSaved!==true)remember(d.platform,token,r.account);persist();
    logEvent('info','relays',`${route.name} updated to the current relay code${r.reachable?'':' (not answering yet)'}`);
    return json(res,200,{ok:true,id:route.id,url:r.url,reachable:r.reachable,status:r.status,detail:r.detail});
  }
  // Removes the relay's project, site or Worker from its platform, then the route here. Nothing is removed from the platform while the route cannot be deleted.
  if(pathname==='/admin/relays/remove'&&method==='POST'){
    const b=await readJson(req);const route=relayRoute(b.id);const d=deployedOf(route);
    if(!d)throw new GatewayError('Polygate did not deploy this relay, so there is nothing for it to remove on a platform. Delete the route instead.',400);
    assertRouteDeletable(route.id);
    const body={...b,platform:d.platform};const token=deployToken(body);const accountId=deployAccount(body)||d.account;
    await removeFromPlatform({platform:d.platform,token,name:d.name,siteId:d.siteId,accountId,teamId:d.team});
    if(b.remember===true&&b.useSaved!==true)remember(d.platform,token,accountId);
    deleteRoute(route.id);logEvent('info','relays',`${route.name} removed from ${labels[d.platform]} and from Polygate`);
    return json(res,200,{ok:true});
  }
  // How each relay has done: what came back through it, per day, for the last 7 or 30 days.
  if(pathname==='/admin/relays/report'&&method==='GET'){const days=new URL(req.url||'/','http://x').searchParams.get('days')==='30'?30:7;return json(res,200,relayReport(days));}
  // --- Cloudflare WARP ---
  // The dashboard shows the helper field read-only when this session may not change it (see checkHelperPath).
  const local=canManageLocal(req);
  const warpOut=async(p:Promise<object>)=>({...await p,canSetHelper:local});
  if(pathname==='/admin/warp/status'&&method==='GET')return json(res,200,await warpOut(warpStatus()));
  if(pathname==='/admin/warp/connect'&&method==='POST')return json(res,200,await warpOut(warpConnect()));
  if(pathname==='/admin/warp/disconnect'&&method==='POST')return json(res,200,await warpOut(warpDisconnect()));
  if(pathname==='/admin/warp/install'&&method==='POST')return json(res,200,await warpOut(warpInstall()));
  if(pathname==='/admin/warp/rotate'&&method==='POST')return json(res,200,await warpOut(warpRotate()));
  if(pathname==='/admin/warp/settings'&&method==='POST'){const b=await readJson(req);const patch:any={};for(const k of ['engine','autoStart','pool','rotateMinutes','helperPath','endpoint','split'])if(k in b)patch[k]=b[k];const port='port' in b?bounded(b.port,1024,65535):undefined;checkHelperPath(b.helperPath,local);await setWarpSettings(patch,port);return json(res,200,await warpOut(warpStatus()));}
  // --- scoped client keys ---
  if(pathname==='/admin/keys'&&method==='POST'){const b=await readJson(req);return json(res,200,{ok:true,key:createKey(b)});}
  if(pathname==='/admin/keys/update'&&method==='POST'){const b=await readJson(req);return json(res,200,{ok:true,key:updateKey(String(b.id),b)});}
  if(pathname==='/admin/keys/delete'&&method==='POST'){const b=await readJson(req);if(!settings.keys.some(k=>k.id===b.id))throw new GatewayError('Key not found',404);if(settings.keys.length<=1)throw new GatewayError('Keep at least one API key',409);settings.keys=settings.keys.filter(k=>k.id!==b.id);
    // A deleted key leaves the MCP lists it was in. A server or the built-in tools that only that key could use are switched off rather than opened to every key.
    const gone=(list?:string[])=>{const next=list?.filter(id=>id!==b.id);return {next:next?.length?next:undefined,emptied:!!list?.length&&!next?.length};};
    const cfg=mcpConfig();const own=gone(cfg.builtinKeys);cfg.builtinKeys=own.next;if(own.emptied)cfg.builtin=false;
    for(const s of cfg.servers){const r=gone(s.keys);s.keys=r.next;if(r.emptied)s.enabled=false;}
    persist();syncMcp();return json(res,200,{ok:true});}
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
  if(pathname==='/admin/proxies/import'&&method==='POST'){const b=await readJson(req);const text=String(b.text||'');if(!text.trim())throw new GatewayError('Paste at least one proxy address or list link',400);const hint=['http','https','socks4','socks5'].includes(b.proto)?b.proto:'all';return json(res,200,startImport(text,engineOptions(b.find===false?undefined:()=>{void testPool({deep:true,api:true,attach:{select:b.select===true}}).catch(()=>{});}),hint));}
  // The list links "Find working proxies" downloads: the built-in public ones (on or off) and the user's own.
  if(pathname==='/admin/proxies/sources'&&method==='GET'){const c=proxyLists();return json(res,200,{builtin:c.builtin!==false,builtinCount:PROXY_SOURCES.length,sources:c.sources});}
  if(pathname==='/admin/proxies/sources'&&method==='POST'){
    const b=await readJson(req);const c=proxyLists();
    if(b.builtin!==undefined)c.builtin=!!b.builtin;
    if(Array.isArray(b.sources)){
      if(b.sources.length>200)throw new GatewayError('At most 200 list links',400);
      const seen=new Set<string>();
      c.sources=b.sources.map((x:any)=>{
        const link=url(x?.url);if(seen.has(link))throw new GatewayError(`${link} is listed twice`,400);seen.add(link);
        const proto=['http','https','socks4','socks5','all'].includes(x?.proto)?x.proto:'all';const prior=c.sources.find(s=>s.id===x?.id||s.url===link);
        return {id:prior?.id||randomBytes(6).toString('hex'),url:link,proto,enabled:x?.enabled!==false,label:String(x?.label||'').trim().slice(0,60)||undefined,...(prior&&prior.url===link&&prior.proto===proto?{lastAt:prior.lastAt,lastCount:prior.lastCount,lastError:prior.lastError}:{})};
      });
    }
    persist();return json(res,200,{builtin:c.builtin!==false,builtinCount:PROXY_SOURCES.length,sources:c.sources});
  }
  // Downloads one link now and says what is in it, without checking or saving anything.
  if(pathname==='/admin/proxies/sources/test'&&method==='POST'){const b=await readJson(req);const link=url(b.url);const proto=['http','https','socks4','socks5'].includes(b.proto)?b.proto:'all';const r=await fetchList(link,proto);const by:Record<string,number>={};for(const c of r.found)by[c.proto]=(by[c.proto]||0)+1;return json(res,200,{count:r.found.length,byProtocol:by,error:r.error,sample:r.found.slice(0,5).map(c=>c.url)});}
  if(pathname==='/admin/proxies/stop'&&method==='POST'){stopEngine();stopPoolTest();return json(res,200,{ok:true});}
  if(pathname==='/admin/proxies/remove'&&method==='POST'){const b=await readJson(req);if(b.all===true)removeProxies();else if(Array.isArray(b.urls))removeProxies(b.urls.map(String).slice(0,5000));else throw new GatewayError('Say which proxies to remove',400);await poolEntries(true);return json(res,200,{ok:true});}
  // Model-test the proxies already saved: OpenCode API check, speed gate, model test, then the working ones go into the pool.
  if(pathname==='/admin/pool/find'&&method==='POST'){const b=await readJson(req);return json(res,200,await testPool({deep:true,api:true,attach:{select:b.select===true}}));}
  // --- HTTPS ---
  // The desktop app is pinned to a loopback HTTP listener; HTTPS would bind every interface on 443/80 at the next start.
  if(pathname.startsWith('/admin/https')&&serverConfig().desktop)throw new GatewayError('HTTPS is configured on a server install, not in the desktop app',404);
  if(pathname==='/admin/https'&&method==='GET')return json(res,200,await httpsStatus());
  if(pathname==='/admin/https/apply'&&method==='POST'){const b=await readJson(req);return json(res,200,await httpsApply(b));}
  if(pathname==='/admin/https/renew'&&method==='POST')return json(res,200,await httpsRenew());
  if(pathname==='/admin/https/disable'&&method==='POST')return json(res,200,await httpsDisable());
  throw new GatewayError('Admin endpoint not found',404);
}

