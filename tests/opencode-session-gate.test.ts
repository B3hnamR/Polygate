import {test,expect,spyOn} from 'bun:test';

import {createServer} from 'node:http';
const bridge=require('../vendor/bridge/server.js');

test('session ids meet the v2 gate length (30 chars)',()=>{
  for(let i=0;i<50;i++){
    const id=bridge.identity.createSessionId(true);
    expect(id.startsWith('ses_')).toBe(true);
    expect(id.length).toBe(30);
  }
  expect(bridge.identity.getRecipe().sessionLength).toBe(26);
});

test('a transient 429 is retried once and the success reaches the client',async()=>{
  const proxy=require('../vendor/bridge/proxy.js');
  const ensure=spyOn(bridge.identity,'ensureFresh').mockImplementation(()=>{});
  const verdict=spyOn(bridge.identity,'getCatalogVerdict').mockReturnValue('free');
  let calls=0;
  const ok=()=>{
    const a=JSON.stringify({choices:[{index:0,delta:{content:'OK'},finish_reason:null}]});
    const b=JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}});
    const nl=String.fromCharCode(10,10);
    return new Response('data: '+a+nl+'data: '+b+nl+'data',{headers:{'content-type':'text/event-stream'}});
  };
  const upstream=spyOn(proxy,'netFetch').mockImplementation(async()=>{
    calls++;
    if(calls===1){
      const e=JSON.stringify({error:{type:'FreeUsageLimitError',message:'Free usage limit reached.'}});
      return new Response(e,{status:429,headers:{'retry-after':'7331'}});
    }
    return ok();
  });
  const server=createServer(bridge.handleRequest);
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{
    const port=(server.address() as any).port;
    const body=JSON.stringify({model:'beam-free',messages:[{role:'user',content:'hi'}],stream:true});
    const url='http://127.0.0.1:'+port+'/v1/chat/completions';
    const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body});
    expect(r.status).toBe(200);
    expect(calls).toBe(2);
  }finally{
    server.closeAllConnections();
    await new Promise<void>(r=>server.close(()=>r()));
    ensure.mockRestore();verdict.mockRestore();upstream.mockRestore();
  }
});
