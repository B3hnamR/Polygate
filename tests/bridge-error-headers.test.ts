import {test,expect,spyOn} from 'bun:test';
import {createServer} from 'node:http';
const bridge=require('../vendor/bridge/server.js');
test('bridge preserves upstream retry/runtime diagnostics without leaking cookies, secrets or framing headers',()=>{
  const headers=new Headers({'retry-after':'7331','x-relay-runtime':'node-bun-ciphers 26.13.0','x-relay-egress':'203.0.113.1','x-relay-instance':'fixture','cf-ray':'ray-example','x-vercel-id':'fra1::example','x-opencode-log-id':'provider-id','set-cookie':'private=secret','authorization':'Bearer secret','x-api-key':'secret','content-length':'999','content-type':'text/plain','location':'https://other.example'});
  expect(bridge.upstreamDiagnosticHeaders(new Response('error',{status:429,headers}))).toEqual({'retry-after':'7331','x-relay-runtime':'node-bun-ciphers 26.13.0','x-relay-egress':'203.0.113.1','x-relay-instance':'fixture','cf-ray':'ray-example','x-vercel-id':'fra1::example','x-opencode-log-id':'provider-id'});
  expect(bridge.upstreamDiagnosticHeaders({headers:new Headers()})).toEqual({});
});
test('actual bridge HTTP error response retains relay runtime and provider retry headers, never cookies',async()=>{
  const proxy=require('../vendor/bridge/proxy.js');
  const ensure=spyOn(bridge.identity,'ensureFresh').mockImplementation(()=>{});
  const verdict=spyOn(bridge.identity,'getCatalogVerdict').mockReturnValue('free');
  const upstream=spyOn(proxy,'netFetch').mockImplementation(async()=>new Response(JSON.stringify({error:{type:'FreeUsageLimitError',message:'Free usage limit reached.',log_id:'fixture-upstream'}}),{status:429,headers:{'retry-after':'7331','x-relay-runtime':'node-bun-ciphers 26.13.0','x-relay-egress':'203.0.113.1','x-relay-instance':'fixture','x-opencode-log-id':'fixture-upstream','cf-ray':'fixture-ray','set-cookie':'must-not-leak=secret','content-type':'application/json'}}));
  const server=createServer(bridge.handleRequest);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const r=await fetch(`http://127.0.0.1:${(server.address() as any).port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'beam-free',messages:[{role:'user',content:'test'}],stream:true})});
    // A 429 is retried once with a fresh session (measured 2026-11-09: transient
    // 429s answer 200 on retry), so a provider that keeps answering 429 is
    // fetched twice before the error is returned to the client.
    expect(r.status).toBe(429);expect(r.headers.get('retry-after')).toBe('7331');expect(r.headers.get('x-relay-runtime')).toBe('node-bun-ciphers 26.13.0');expect(r.headers.get('x-relay-egress')).toBe('203.0.113.1');expect(r.headers.get('cf-ray')).toBe('fixture-ray');expect(r.headers.get('set-cookie')).toBeNull();expect((await r.json() as any).error.type).toBe('FreeUsageLimitError');expect(upstream).toHaveBeenCalledTimes(2);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));ensure.mockRestore();verdict.mockRestore();upstream.mockRestore();}
});
