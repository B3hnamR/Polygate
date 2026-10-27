import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { settings, models, stateDir, equal, redactError } from './state';
import { admin } from './admin';
import { GatewayError } from './queue';
import { inference, clientKey, readJson, json, probeModel, queue, readiness } from './gateway';
import { initBridge, discover, stopBridge } from './providers';
import { KILO_ID } from './kilo';
import { serve } from './serve';
import { serverConfig, hostAllowed, clientIp, isHttps, loginGate, ensureAdminPassword, verifyPassword, createSession, sessionValid, sessionCookie, readSession, changePassword, signOutEverywhere, passwordManagedByEnv } from './auth';
import { startWarp, stopWarp } from './warp';
import { startNotifier } from './notifications';
import { startPoolMaintenance } from './pool';
import { startExitRecheck } from './transport';
import { prometheus } from './metrics';
import { httpsRuntime, startHttps, stopHttps } from './https';
import { flushKeys, modelAllowed } from './keys';
import { version } from './version';
import { closeSocksBridges } from './socks-bridge';
import { logEvent, captureConsole, adminAction } from './logbook';
import { handleMcp, syncMcp, stopMcp } from './mcp';
const mimeTypes:Record<string,string>={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.png':'image/png','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.map':'application/json','.txt':'text/plain'};
export async function startGateway(port=Number(process.env.POLYGATE_PORT||4317),host=serverConfig().host){
  const token=process.env.POLYGATE_ADMIN_TOKEN||randomBytes(32).toString('hex');
  if(!process.env.POLYGATE_ADMIN_TOKEN)writeFileSync(path.join(stateDir,'admin-token'),token,{mode:0o600});
  const password=ensureAdminPassword(token);
  await initBridge();
  // The admin token (root-only file on a server) is what the local manager signs in with; dashboard sessions use the password.
  const authed=(req:IncomingMessage)=>{const bearer=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');if(!!bearer&&equal(bearer,token)){(req as any).polygateManager=true;return true;}return sessionValid(readSession(req));};
  const handler=async(req:IncomingMessage,res:any)=>{
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');
    try{
      const hostHeader=String(req.headers.host||'');if(!hostAllowed(hostHeader))throw new GatewayError('Unrecognized Host header. Set POLYGATE_ALLOWED_HOSTS to this hostname.',403);
      const url=new URL(req.url||'/','http://'+hostHeader);let p=url.pathname;
      // With a dashboard path (POLYGATE_DASHBOARD_PATH=/polygate) everything under it is the same app, so "/polygate/admin/..." and "/polygate/v1/..."
      // behave like "/admin/..." and "/v1/...". The bare root only forwards to it; the pages and assets are not served there. The API, the health
      // checks and the local management commands keep answering at the root as well, so existing clients and monitoring do not break.
      const dashboard=serverConfig().dashboardPath;
      if(dashboard){
        if(p===dashboard){res.writeHead(301,{location:dashboard+'/'+url.search});return res.end();}
        if(p.startsWith(dashboard+'/'))p=p.slice(dashboard.length);
        else if(p==='/'&&req.method==='GET'){res.writeHead(302,{location:dashboard+'/'+url.search});return res.end();}
        else if(req.method==='GET'&&!/^\/(v1\/|admin\/|mcp(\/|$)|health$|healthz$|readyz$|metrics$)/.test(p))throw new GatewayError('Endpoint not found',404);
      }
      // The MCP hub: client API keys, like the model API, and callable from browser-based MCP clients.
      if(p==='/mcp'||p.startsWith('/mcp/'))return await handleMcp(req,res,p);
      // The OpenAI/Anthropic surface is protected by API keys and must be callable from browser clients; everything else is same-origin only.
      if(p.startsWith('/v1/')){res.setHeader('access-control-allow-origin','*');res.setHeader('access-control-allow-headers','authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-session-id');res.setHeader('access-control-allow-methods','GET, POST, OPTIONS');res.setHeader('access-control-expose-headers','x-polygate-model, x-polygate-route, retry-after');res.setHeader('access-control-max-age','600');if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}}
      else if(req.headers.origin){let originHost='';try{originHost=new URL(String(req.headers.origin)).host;}catch{/* malformed origin is refused below */}
        if(originHost!==hostHeader&&!(process.env.POLYGATE_DEV==='1'&&req.headers.origin==='http://127.0.0.1:5173'))throw new GatewayError('Cross-origin request refused',403);}
      if(isHttps(req))res.setHeader('strict-transport-security','max-age=31536000');
      if(p==='/health'||p==='/healthz')return json(res,200,{ok:true,app:'Polygate',version,enabled:settings.enabled,uptime:Math.round(process.uptime())});
      if(p==='/readyz'){const r=readiness();return json(res,r.ready?200:503,{status:r.ready?'ready':'not_ready',...r});}
      if(p==='/metrics'&&req.method==='GET'){if(!authed(req))throw new GatewayError('Sign in required',401,'authentication_error');res.writeHead(200,{'content-type':'text/plain; version=0.0.4; charset=utf-8','cache-control':'no-store'});res.end(prometheus());return;}
      if(p==='/admin/whoami'&&req.method==='GET')return json(res,200,{authenticated:authed(req),mode:serverConfig().desktop?'desktop':'server',passwordManagedByEnv:passwordManagedByEnv()});
      if(p==='/admin/login'&&req.method==='POST'){
        if(!String(req.headers['content-type']||'').startsWith('application/json'))throw new GatewayError('JSON content type required',415);
        const ip=clientIp(req);const wait=loginGate.retryAfter(ip);if(wait){logEvent('warn','auth',`Sign-in blocked for ${ip} after too many attempts`);res.setHeader('retry-after',String(wait));throw new GatewayError(`Too many sign-in attempts. Try again in ${Math.ceil(wait/60)} minute(s).`,429,'rate_limited');}
        // The attempt is counted before the body is read: parallel slow-body requests used to all pass the check above before any failed.
        loginGate.fail(ip);
        const b=await readJson(req,4096);if(!verifyPassword(String(b.password||''),token)){logEvent('warn','auth',`Wrong dashboard password from ${ip}`);throw new GatewayError('Incorrect password',401,'authentication_error');}
        loginGate.clear(ip);logEvent('info','auth',`Signed in to the dashboard from ${ip}`);res.setHeader('set-cookie',sessionCookie(createSession(),isHttps(req)));return json(res,200,{ok:true});
      }
      if(p==='/admin/logout'&&req.method==='POST'){logEvent('info','auth',`Signed out from ${clientIp(req)}`);res.setHeader('set-cookie',sessionCookie('',isHttps(req),0));return json(res,200,{ok:true});}
      if(p.startsWith('/admin/')){
        if(!authed(req))throw new GatewayError('Sign in required',401,'authentication_error');
        if(req.method==='POST'&&!String(req.headers['content-type']||'').startsWith('application/json'))throw new GatewayError('JSON content type required',415);
        if(p==='/admin/session'&&req.method==='POST'){res.setHeader('set-cookie',sessionCookie(createSession(),isHttps(req)));return json(res,200,{ok:true});}
        // Every change made from the dashboard or the manager is logged once it has gone through, or with the reason it was refused.
        const action=req.method==='POST'?adminAction(p):undefined;
        try{
          if(p==='/admin/password'&&req.method==='POST'){const b=await readJson(req);changePassword(String(b.current||''),String(b.next||''),token);res.setHeader('set-cookie',sessionCookie(createSession(),isHttps(req)));json(res,200,{ok:true});}
          else if(p==='/admin/signout-all'&&req.method==='POST'){signOutEverywhere();res.setHeader('set-cookie',sessionCookie('',isHttps(req),0));json(res,200,{ok:true});}
          else if(p==='/admin/shutdown'&&req.method==='POST'){json(res,200,{ok:true});setTimeout(()=>close().then(()=>process.exit(0)),100);}
          else await admin(req,res,p);
          if(action)logEvent('info',action[0],action[1]);return;
        }catch(e:any){if(action)logEvent('warn',action[0],`${action[2]} failed: ${redactError(e?.message||String(e))}`);throw e;}
      }
      if(p==='/v1/models'&&req.method==='GET'){const k=clientKey(req);return json(res,200,{object:'list',data:[{id:'auto',object:'model',owned_by:'polygate'},...[...models.values()].filter(m=>settings.providers.some(x=>x.id===m.providerId&&x.enabled)&&m.state!=='unavailable'&&modelAllowed(k,m.id)).map(m=>({id:m.id,object:'model',owned_by:m.providerId}))]});}
      if(req.method==='POST'&&['/v1/chat/completions','/v1/responses','/v1/messages'].includes(p))return await inference(req,res,p.endsWith('/responses')?'responses':p.endsWith('/messages')?'anthropic':'chat');
      if(p==='/v1/messages/count_tokens'&&req.method==='POST'){clientKey(req);const b=await readJson(req);return json(res,200,{input_tokens:Math.ceil(JSON.stringify(b).length/4),estimated:true});}
      if(req.method==='GET'&&!p.startsWith('/v1/')){
        const root=process.env.POLYGATE_UI_DIST||path.resolve('dist');let decoded:string;try{decoded=decodeURIComponent(p);}catch{throw new GatewayError('Invalid asset path',400);}
        const target=path.resolve(root,'.'+decoded);if(!target.startsWith(path.resolve(root)+path.sep)&&target!==path.resolve(root))throw new GatewayError('Invalid asset path',400);
        const file=p!=='/'&&existsSync(target)&&statSync(target).isFile()?target:path.join(root,'index.html');if(!existsSync(file))return json(res,503,{error:{message:'UI is not built. Run bun run build:ui.'}});
        const mime=mimeTypes[path.extname(file).toLowerCase()]||'text/html';res.writeHead(200,{'content-type':mime,'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'"});res.end(readFileSync(file));return;
      }
      throw new GatewayError('Endpoint not found',404);
    }catch(e:any){
      // Requests turned away before they reach a model (wrong API key, unknown model, gateway paused, bad body) are logged here.
      if(String(req.url||'').includes('/v1/'))logEvent((e.status||500)>=500?'error':'warn','requests',`${e.status||500} ${req.method} ${String(req.url||'').split('?')[0]} · ${redactError(e.message||String(e),300)}`,{ip:clientIp(req),status:e.status||500,type:e.type});
      if(!res.headersSent&&e.retryAfter&&!res.getHeader('retry-after'))res.setHeader('retry-after',String(e.retryAfter));if(!res.headersSent)json(res,e.status||500,{error:{type:e.type||'gateway_error',message:redactError(e.message||String(e))}});else res.end();}
  };
  // HTTPS (when configured) applies from the first request: the same handler is bound with a certificate, on the configured port.
  // The desktop app never serves HTTPS: a saved HTTPS setting (from a server install's state, or set through the API) is ignored there.
  const desktop=serverConfig().desktop;
  const secure:ReturnType<typeof httpsRuntime>=desktop?{}:httpsRuntime();
  const recoveryOnly=!desktop&&!!settings.https&&settings.https.mode!=='off'&&!secure.tls;
  const firstHost=secure.tls?'0.0.0.0':recoveryOnly?'127.0.0.1':host;
  // The desktop app asks for the port it used last time, so clients keep working; if another program holds it now, any free port will do.
  let server:ReturnType<typeof serve>;
  try{server=serve(handler,secure.port||port,firstHost,secure.tls);}
  catch(e){if(!desktop||!port)throw e;console.error(`[gateway] Port ${port} is not available (${redactError(String((e as any)?.message||e))}); using a free port instead.`);server=serve(handler,0,firstHost,secure.tls);}
  if(recoveryOnly)console.error('[https] Configured certificate is unavailable; HTTP recovery is loopback-only until issuance succeeds.');
  let actual=server.port as number;
  let current:{port:number;host:string;tls?:{cert:string;key:string}}={port:actual,host:firstHost,tls:secure.tls};
  // Swaps the listener (new certificate, new port, HTTPS on or off). The new socket is up before the old one stops accepting, so requests are not refused.
  // Where the port cannot be shared (same port, no reusePort), the old socket closes first; if the new bind then fails too, the previous
  // listener is bound again, so a failed swap never leaves the panel unreachable until a restart.
  const rebind=async(o:{port:number;host:string;tls?:{cert:string;key:string}})=>{
    let next;
    try{next=serve(handler,o.port,o.host,o.tls,true);}
    catch{
      server.stop();
      try{next=serve(handler,o.port,o.host,o.tls);}
      catch(e){
        try{server=serve(handler,current.port,current.host,current.tls);actual=server.port as number;}
        catch(restore){console.error('[https] Could not restore the previous listener:',redactError(String(restore)));}
        throw e;
      }
      server=next;actual=next.port as number;current={...o,port:actual};return actual;
    }
    const old=server;server=next;actual=next.port as number;current={...o,port:actual};old.stop();return actual;
  };
  const close=async()=>{logEvent('info','gateway','Polygate is stopping');stopMcp();flushKeys();server.stop(true);stopHttps();stopBridge();closeSocksBridges();await stopWarp();};
  if(process.env.POLYGATE_NO_DISCOVERY!=='1')discover().catch(e=>console.error('[catalog]',redactError(String(e))));
  startWarp().catch(e=>console.error('[warp]',redactError(String(e))));
  syncMcp();
  const stopPool=startPoolMaintenance();
  if(!desktop)startHttps(rebind,{port:secure.tls?port:actual,host}).catch(e=>console.error('[https]',redactError(String(e))));
  const stopNotifier=startNotifier();
  const stopRecheck=startExitRecheck();
  // Models whose probe never reached a verdict (full queue, no route) keep an old checkedAt, so attempts are tracked separately.
  let last=Date.now();let probing=false;const attempted=new Map<string,number>();const timer=setInterval(()=>{
    if(Date.now()-last>=settings.refreshMinutes*60000){last=Date.now();discover().catch(()=>{});}
    if(settings.autoProbe&&settings.enabled&&!probing&&queue.active===0){const due=Date.now()-settings.refreshMinutes*60000;const candidate=[...models.values()].find(m=>m.state!=='unavailable'&&m.providerId!==KILO_ID&&m.cooldownUntil<=Date.now()&&Math.max(m.checkedAt,attempted.get(m.id)||0)<due&&settings.providers.some(p=>p.id===m.providerId&&p.enabled));if(candidate){probing=true;attempted.set(candidate.id,Date.now());probeModel(candidate.id).catch(()=>{}).finally(()=>{probing=false;});}}
  },60000);timer.unref();
  if(password.generated)console.log(JSON.stringify({polygateDashboardPassword:{file:password.file}}));
  logEvent('info','gateway',`Polygate ${version} started on ${secure.tls?'https':'http'}://${firstHost.includes(':')?`[${firstHost}]`:firstHost}:${actual}`,{version,runtime:Bun.version,platform:process.platform,mode:desktop?'desktop':'server',state:stateDir});
  console.log(JSON.stringify({polygateReady:true,port:actual,host,https:!!secure.tls}));
  return {get server(){return server;},get port(){return actual;},token,close:async()=>{clearInterval(timer);stopNotifier();stopRecheck();stopPool();await close();}};
}
if(import.meta.main){
  // A forgotten promise (a cancelled body, a background check) must not end a gateway that is serving other requests: log it instead.
  process.on('unhandledRejection',e=>console.error('[gateway] Unhandled rejection:',redactError(String((e as any)?.stack||e))));
  captureConsole();
  const app=await startGateway();for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>app.close().then(()=>process.exit(0)));
}
