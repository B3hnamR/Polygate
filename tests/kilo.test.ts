import { test, expect, beforeAll, afterAll } from 'bun:test';
import { preserveTestState } from './setup';
const restore = preserveTestState();
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN='test-admin-secret';
const {startGateway}=await import('../backend/main');
const {settings,models,removeModels,initialSettings,withBuiltIns}=await import('../backend/state');
const {freeCatalog}=await import('../backend/kilo');
const {__resetKiloLimits}=await import('../backend/transport');
const {discover}=await import('../backend/providers');
let gateway:Awaited<ReturnType<typeof startGateway>>,base='';
let addressLimited=false;const sent:{model:string;auth:string|null;max:any}[]=[];
// A stand-in for api.kilo.ai that answers the way the live service was observed to.
const catalog=[
  {id:'kilo-auto/free',name:'Auto Free',isFree:true,context_length:256000,top_provider:{max_completion_tokens:65536},supported_parameters:['tools','reasoning']},
  {id:'vendor/busy:free',name:'Busy',isFree:true,context_length:64000,supported_parameters:['tools']},
  {id:'vendor/gone:free',name:'Gone',isFree:true,context_length:64000,supported_parameters:['tools']},
  {id:'vendor/big:free',name:'Big',isFree:true,context_length:64000,supported_parameters:['tools']},
  {id:'nvidia/nemotron-content-safety:free',name:'Safety',isFree:true,context_length:128000,supported_parameters:[]},
  {id:'vendor/paid-model',name:'Paid',isFree:false,context_length:64000,supported_parameters:['tools']},
  {id:'google/lyria-audio',name:'Audio',isFree:false,pricing:{prompt:'0',completion:'0'}},
];
const sse=(text:string)=>new Response('data: '+JSON.stringify({id:'c1',choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
// On 127.0.0.2, not 127.0.0.1: a loopback address skips the network routes, so switching exits could not be seen.
const kilo=Bun.serve({port:0,hostname:'127.0.0.2',async fetch(req){
  const path=new URL(req.url).pathname;
  if(path.endsWith('/models'))return Response.json({data:catalog});
  const body=await req.json() as any;sent.push({model:body.model,auth:req.headers.get('authorization'),max:body.max_tokens});
  if(addressLimited)return Response.json({error:{code:'PROMOTION_MODEL_LIMIT_REACHED',message:'Sign up for free to continue and explore 500 other models.'},error_type:'rate_limit_exceeded'},{status:429,headers:{'x-should-retry':'false'}});
  if(body.model==='vendor/busy:free')return Response.json({error:{message:'vendor/busy:free is temporarily rate-limited upstream',code:429}},{status:429});
  if(body.model==='vendor/gone:free')return Response.json({error:{code:'PAID_MODEL_AUTH_REQUIRED',message:'You need to sign in to use this model.'},error_type:'paid_model_auth_required'},{status:401});
  if(body.model==='vendor/big:free'&&body.max_tokens>4096)return Response.json({error:{message:'max_tokens too large'}},{status:400});
  return sse('hello from '+body.model);
}});
const admin=(p:string,body:any)=>fetch(base+p,{method:'POST',headers:{authorization:'Bearer test-admin-secret','content-type':'application/json'},body:JSON.stringify(body)});
const chat=(model:string,extra:any={})=>fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+settings.keys[0].value,'content-type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'hi'}],stream:false,...extra})});
beforeAll(async()=>{
  settings.warp={engine:'disabled',autoStart:false,pool:1,rotateMinutes:0,helperPath:'',endpoint:''};
  settings.providers=[];removeModels('kilo');settings.cooldowns=true;settings.fallback=true;
  models.clear(); settings.enabled=true; settings.rotate=false; settings.routeId='direct'; settings.chains=[];
  settings.routes=[{id:'direct',name:'Fixture direct',kind:'direct',url:'',enabled:true,models:[]}];
  gateway=await startGateway(0);base=`http://127.0.0.1:${gateway.port}`;
});
afterAll(async()=>{
  try{await gateway?.close();}
  finally{kilo.stop(true);addressLimited=false;__resetKiloLimits();restore();} // Restore shared pool/key/activity state only after shutting down the file's gateway.
});
const seedKilo = async () => {
  addressLimited=false;removeModels('kilo');__resetKiloLimits();
  settings.providers=[{id:'kilo',name:'Kilo Free',kind:'kilo',enabled:true,baseUrl:`http://127.0.0.2:${kilo.port}`,apiKey:'',models:[],routeId:'direct'}];
  await discover();
};

test('Kilo is a built-in provider: in fresh settings, added to older ones, and never deleted',async()=>{
  expect(initialSettings().providers.map(p=>[p.id,p.kind,p.enabled])).toEqual([['opencode','free',true],['kilo','kilo',true],['zai','zai',false]]);
  const older={...initialSettings(),providers:[initialSettings().providers[0]]};
  expect(withBuiltIns(older).providers.map(p=>p.id)).toEqual(['opencode','kilo','zai']);
  const custom={...older,providers:[...older.providers,{id:'mine',name:'Mine',kind:'openai' as const,enabled:true,baseUrl:'http://x/v1',apiKey:'k',models:[],routeId:''}]};
  expect(withBuiltIns(custom).providers.map(p=>p.id)).toEqual(['opencode','kilo','zai','mine']);
  // Built-ins first (OpenCode, Kilo, Z.ai) whatever order they were saved in; the user's own keep theirs.
  const mixed={...older,providers:[custom.providers[1],{...custom.providers[1],id:'other',name:'Other'},initialSettings().providers[2],initialSettings().providers[1],older.providers[0]]};
  expect(withBuiltIns(mixed).providers.map(p=>p.id)).toEqual(['opencode','kilo','zai','mine','other']);
  const ordered=withBuiltIns(custom);expect(withBuiltIns(ordered)).toBe(ordered);
  const kept=withBuiltIns({...initialSettings(),providers:[{...initialSettings().providers[1],enabled:false,apiKey:'saved'}]});
  expect(kept.providers.map(p=>p.id)).toEqual(['kilo','zai']);expect(kept.providers[0]).toMatchObject({enabled:false,apiKey:'saved'});
});
test('the catalog keeps free chat models only',()=>{
  expect(freeCatalog(catalog).map(x=>x.id)).toEqual(['kilo-auto/free','vendor/busy:free','vendor/gone:free','vendor/big:free']);
  const auto=freeCatalog(catalog)[0];expect(auto).toMatchObject({context_length:256000,maxOutput:65536,reasoning:true,tool_call:true});
});
test('adding Kilo through the dashboard API lists its free models behind OpenCode in auto',async()=>{
  const added=await admin('/admin/providers',{kind:'kilo',name:'',baseUrl:`http://127.0.0.2:${kilo.port}`,routeId:'direct'});
  expect(added.status).toBe(200);expect((await added.json() as any).id).toBe('kilo');
  expect((await admin('/admin/providers',{kind:'kilo',baseUrl:'http://127.0.0.1:1'})).status).toBe(400);
  expect((await admin('/admin/discover',{})).status).toBe(200);
  const ids=[...models.values()].filter(m=>m.providerId==='kilo').map(m=>m.id).sort();
  expect(ids).toEqual(['kilo/kilo-auto/free','kilo/vendor/big:free','kilo/vendor/busy:free','kilo/vendor/gone:free']);
  const m=models.get('kilo/kilo-auto/free')!;expect(m).toMatchObject({priority:150,reasoning:true,tools:true,output:65536,state:'unchecked'});
  expect(settings.providers[0]).toMatchObject({name:'Kilo Free',kind:'kilo'});
});
test('the built-in providers cannot be deleted',async()=>{
  await seedKilo();
  expect((await admin('/admin/providers/delete',{id:'kilo'})).status).toBe(400);
  expect((await admin('/admin/providers/delete',{id:'opencode'})).status).toBe(400);
  expect(settings.providers.some(p=>p.id==='kilo')).toBe(true);
});
test('requests carry no Authorization header unless a key was saved',async()=>{
  await seedKilo();
  sent.length=0;const r=await chat('kilo/kilo-auto/free');expect(r.status).toBe(200);
  expect((await r.json() as any).choices[0].message.content).toBe('hello from kilo-auto/free');
  expect(sent.at(-1)!.auth).toBeNull();
  settings.providers[0].apiKey='kilo-key';await chat('kilo/kilo-auto/free');expect(sent.at(-1)!.auth).toBe('Bearer kilo-key');settings.providers[0].apiKey='';
});
test('a model Kilo no longer serves (401 paid-model) is retired as unavailable, not read as a blocked exit',async()=>{
  await seedKilo();
  const r=await chat('kilo/vendor/gone:free');expect(r.status).toBe(404);
  expect(models.get('kilo/vendor/gone:free')!.state).toBe('unavailable');
});
test('one busy model pauses briefly while the others keep working',async()=>{
  await seedKilo();
  const r=await chat('kilo/vendor/busy:free');expect(r.status).toBe(429);
  const m=models.get('kilo/vendor/busy:free')!;expect(m.state).toBe('cooldown');expect(m.cooldownUntil-Date.now()).toBeLessThanOrEqual(2*60000+1000);expect(m.cooldownUntil-Date.now()).toBeGreaterThan(60000);
  expect(models.get('kilo/kilo-auto/free')!.state).not.toBe('cooldown');expect((await chat('kilo/kilo-auto/free')).status).toBe(200);
});
test('a too-large output ceiling is retried once with a smaller one',async()=>{
  await seedKilo();
  sent.length=0;const r=await chat('kilo/vendor/big:free',{max_tokens:32000});expect(r.status).toBe(200);
  expect(sent.map(s=>s.max)).toEqual([32000,4096]);
  sent.length=0;expect((await chat('kilo/vendor/big:free',{max_tokens:100})).status).toBe(200);expect(sent).toHaveLength(1);
});
test('the address-wide limit pauses every Kilo model together and the next request is not sent',async()=>{
  await seedKilo();
  addressLimited=true;sent.length=0;
  const r=await chat('kilo/kilo-auto/free');expect(r.status).toBe(429);expect(Number(r.headers.get('retry-after'))).toBe(1800);
  expect(((await r.json()) as any).error.message).toContain('limits anonymous use per network address');
  expect(sent).toHaveLength(1);
  const rest=[...models.values()].filter(m=>m.providerId==='kilo'&&m.state!=='unavailable');
  expect(rest.length).toBeGreaterThan(1);for(const m of rest){expect(m.state).toBe('cooldown');expect(m.cooldownUntil-Date.now()).toBeGreaterThan(29*60000);}
  const again=await chat('kilo/vendor/big:free');expect(again.status).toBe(429);expect(sent).toHaveLength(1);
  const auto=await chat('auto');expect(auto.status).toBe(503);expect(sent).toHaveLength(1);
});
// An HTTP proxy stand-in for another exit: whatever it is asked to fetch, it answers from its own (clean) address.
const exitProxy=(text:string)=>Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>sse(text)});
test('the address-wide limit moves Kilo to another exit; no model is paused while an exit is left',async()=>{
  await seedKilo();settings.providers[0].routeId='';settings.exhaustedFailover=true;
  const proxy=exitProxy('via the other exit');
  settings.routes.push({id:'kx-proxy',name:'Fixture proxy',kind:'proxy',url:`http://127.0.0.1:${proxy.port}`,enabled:true,models:[]} as any);
  try{
    addressLimited=true;sent.length=0;
    const r=await chat('kilo/kilo-auto/free');expect(r.status).toBe(200);
    expect(((await r.json()) as any).choices[0].message.content).toBe('via the other exit');expect(sent).toHaveLength(1);
    expect([...models.values()].filter(m=>m.providerId==='kilo').some(m=>m.state==='cooldown')).toBe(false);
    // The limited exit is set aside for Kilo, so the next Kilo request goes straight to the other exit.
    const again=await chat('kilo/vendor/big:free');expect(again.status).toBe(200);expect(sent).toHaveLength(1);
    expect(((await again.json()) as any).choices[0].message.content).toBe('via the other exit');
  }finally{proxy.stop(true);settings.routes=settings.routes.filter(x=>x.id!=='kx-proxy');settings.providers[0].routeId='direct';addressLimited=false;__resetKiloLimits();}
});
test('a Kilo provider with its own list moves to the next exit in that list',async()=>{
  await seedKilo();settings.exhaustedFailover=true;
  const proxy=exitProxy('via the listed exit');
  settings.routes.push({id:'kx-proxy2',name:'Fixture proxy 2',kind:'proxy',url:`http://127.0.0.1:${proxy.port}`,enabled:true,models:[]} as any);
  settings.providers[0].routes={ids:['direct','kx-proxy2']};
  try{
    addressLimited=true;sent.length=0;
    const r=await chat('kilo/kilo-auto/free');expect(r.status).toBe(200);expect(((await r.json()) as any).choices[0].message.content).toBe('via the listed exit');
    expect(sent).toHaveLength(1);
  }finally{proxy.stop(true);settings.routes=settings.routes.filter(x=>x.id!=='kx-proxy2');delete settings.providers[0].routes;addressLimited=false;__resetKiloLimits();}
});
test('Kilo models are checked in the background only when the user chooses it for Kilo',async()=>{
   await seedKilo();
  const {autoCheckMinutes}=await import('../backend/model-checks');
  const kilo=settings.providers[0];expect(kilo.kind).toBe('kilo');const had=settings.autoProbe;
  try{
    settings.autoProbe=true;expect(autoCheckMinutes(kilo)).toBe(0); // the old all-providers switch never covered it
    expect(autoCheckMinutes({...kilo,autoCheckMinutes:360})).toBe(360);
  }finally{settings.autoProbe=had;}
});

test('A relay that carries one provider only is never chosen for another provider\'s request', async () => {
  const { failoverRoutes, exhaustedAlternative, routeFor } = await import('../backend/transport');
  const saved = { routes: settings.routes, rotate: settings.rotate, allowDirect: settings.allowDirect, strategy: settings.strategy };
  const direct = { id: 'direct', name: 'Direct', kind: 'direct' as const, url: '', enabled: true, models: [] };
  const only = { id: 'r-only', name: 'Kilo-only relay', kind: 'relay' as const, url: 'https://a.example/', token: 't', enabled: true, models: [], only: 'kilo' as const };
  const open = { id: 'r-open', name: 'Open relay', kind: 'relay' as const, url: 'https://b.example/', token: 't', enabled: true, models: [] };
  try {
    settings.routes = [direct, only, open]; settings.rotate = false;
    expect(failoverRoutes(direct, 'kilo').map(r => r.id)).toEqual(['r-only', 'r-open']);
    expect(failoverRoutes(direct, 'free').map(r => r.id)).toEqual(['r-open']);
    expect(failoverRoutes(direct).map(r => r.id)).toEqual(['r-open']);
    expect(exhaustedAlternative(direct)?.id).toBe('r-open');
    settings.routes = [direct, only]; expect(exhaustedAlternative(direct)).toBeUndefined();
    settings.rotate = true; settings.strategy = 'round_robin'; settings.routes = [direct, only, open];
    for (let i = 0; i < 6; i++) expect(routeFor('x', '', 'free').id).toBe('r-open');
    expect(new Set(Array.from({ length: 6 }, () => routeFor('x', '', 'kilo').id))).toEqual(new Set(['r-only', 'r-open']));
    settings.routes = [direct, only]; expect(() => routeFor('x', '', 'free')).toThrow('unavailable');
  } finally { Object.assign(settings, saved); }
});
