// Local service control. Never import this module into the HTTP server.
import { randomBytes, scryptSync } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
process.env.POLYGATE_READ_ONLY_STATE='1';
const { settings, persist, stateDir, db } = await import('./state');

const command=process.argv[2]||'settings';
// Calls the running gateway on this machine: over HTTPS on its own port once a certificate is active, else over plain HTTP on the loopback port.
async function call(endpoint:string,body?:unknown){
  if(!/^\/(admin\/|healthz$|readyz$)/.test(endpoint))throw new Error('Only local management endpoints are allowed');
  // The gateway serves HTTPS only when it can read both the certificate and its key, so both must exist here too; otherwise it is on plain HTTP.
  const mode=settings.https?.mode||'off';const pair=(f:string)=>existsSync(path.join(stateDir,'tls',`${mode==='custom'?'custom':mode}-${f}.pem`));const secure=mode!=='off'&&pair('fullchain')&&pair('privkey');
  const port=secure?(settings.https?.port||443):Number(process.env.POLYGATE_PORT||4317);
  const token=process.env.POLYGATE_ADMIN_TOKEN||readFileSync(path.join(stateDir,'admin-token'),'utf8').trim();
  const response=await fetch(`${secure?'https':'http'}://127.0.0.1:${port}${endpoint}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(45000),...(secure?{tls:{rejectUnauthorized:false}}:{})} as any);
  return {ok:response.ok,status:response.status,text:await response.text()};
}
async function run(){
  if(command==='password'){
    const supplied=process.argv.includes('--stdin')?(await Bun.stdin.text()).trim():'';
    // With POLYGATE_ADMIN_PASSWORD set, that value is the password and a saved one is never used, so a reset here would report a password that cannot sign in.
    if(process.env.POLYGATE_ADMIN_PASSWORD)throw new Error('The dashboard password is set by POLYGATE_ADMIN_PASSWORD; change it there and restart Polygate.');
    const password=supplied||randomBytes(18).toString('base64url');
    if(password.length<12)throw new Error('Password must contain at least 12 characters');
    // A running gateway holds the settings in memory and would write its old password back, so it is asked to change it; only a stopped one is edited on disk.
    let running=false;
    try{const r=await call('/admin/reset-password',{password});if(!r.ok)throw new Error(`The running gateway refused the reset (${r.status}): ${r.text.slice(0,200)}`);running=true;}catch(e:any){if(/refused the reset/.test(String(e.message)))throw e;}
    if(!running){const salt=randomBytes(16).toString('hex');settings.admin={password:{salt,hash:scryptSync(password,salt,32).toString('hex')},epoch:(settings.admin?.epoch||0)+1};persist();}
    writeFileSync(path.join(stateDir,'admin-password.txt'),password+'\n',{mode:0o600});
    console.log('Password reset. Saved to '+path.join(stateDir,'admin-password.txt'));return;
  }
  if(command==='settings'){
    const {publicSettings}=await import('./state');const out=publicSettings();
    console.log(JSON.stringify({...out,keys:out.keys.map(k=>({...k,value:'[redacted]'}))},null,2));return;
  }
  if(command==='request'){
    const raw=await Bun.stdin.text();let body:unknown;if(raw.trim())body=JSON.parse(raw);
    const r=await call(process.argv[3]||'/healthz',body);console.log(r.text);if(!r.ok)process.exitCode=1;return;
  }
  // https <domain|ip|custom> <name|address|certificate file> [e-mail|key file]: builds the request here so the shell never has to put names or PEM text into JSON.
  if(command==='https-apply'){
    const [mode,value='',extra='']=process.argv.slice(3);
    if(!['domain','ip','custom'].includes(mode))throw new Error('Usage: https-apply domain|ip|custom VALUE [EMAIL|KEYFILE]');
    const body:Record<string,unknown>={mode,port:Number(process.env.POLYGATE_HTTPS_PORT||443),httpPort:Number(process.env.POLYGATE_HTTP_PORT||80),staging:process.env.POLYGATE_HTTPS_STAGING==='1'};
    if(mode==='custom'){
      // "-" means the certificate chain and the private key arrive on stdin, one after the other (the root-run polygate command reads the files, because this program runs as the service user and cannot).
      const text=value==='-'?await Bun.stdin.text():readFileSync(value,'utf8')+'\n'+readFileSync(extra,'utf8');
      const key=text.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/);
      if(!key)throw new Error('No private key was found next to the certificate');
      body.keyPem=key[0];body.certPem=text.replace(key[0],'').trim();
    }
    else{if(extra)body.email=extra;if(mode==='domain')body.domain=value;else if(value)body.ip=value;}
    const r=await call('/admin/https/apply',body);console.log(r.text);if(!r.ok)process.exitCode=1;return;
  }
  // mcp list | add-local NAME [--env KEY=VALUE]… COMMAND [ARGS…] | remove NAME | on NAME | off NAME
  // Local programs are added here (or in the Windows app), never from the web dashboard: this runs as root's request with the admin token.
  if(command==='mcp'){
    const [action='list',...rest]=process.argv.slice(3);
    const state=async()=>{const r=await call('/admin/mcp');if(!r.ok)throw new Error(r.text);return JSON.parse(r.text);};
    const byName=async(name:string)=>{const s=(await state()).servers.find((x:any)=>x.name===name);if(!s)throw new Error(`No MCP server named "${name}". See: polygate mcp list`);return s;};
    const done=(r:{ok:boolean;text:string})=>{if(!r.ok)throw new Error((()=>{try{return JSON.parse(r.text).error.message;}catch{return r.text;}})());return JSON.parse(r.text);};
    if(action==='list'){
      const s=await state();console.log(`MCP hub: ${s.enabled?'on':'off'} · Polygate's own tools: ${s.builtin?'on':'off'} · clients connect to /mcp with a client API key`);
      if(!s.servers.length)console.log('  No servers yet. Add remote ones on the dashboard\'s MCP page, local programs with: polygate mcp add-local');
      for(const x of s.servers)console.log(`  ${x.name.padEnd(24)} ${(x.transport==='stdio'?'local':x.transport).padEnd(6)} ${x.status.state.padEnd(10)} ${String(x.status.tools.length).padStart(3)} tool(s)  ${x.transport==='stdio'?[x.command,...(x.args||[])].join(' '):x.url}${x.status.error?`\n${' '.repeat(28)}${x.status.error}`:''}`);
      return;
    }
    if(action==='add-local'){
      const env:Record<string,string>={};let i=0;const name=rest[i++]||'';
      while(rest[i]==='--env'){const pair=rest[i+1]||'';const eq=pair.indexOf('=');if(eq<1)throw new Error('--env needs KEY=VALUE');env[pair.slice(0,eq)]=pair.slice(eq+1);i+=2;}
      if(rest[i]==='--')i++;const [program,...args]=rest.slice(i);
      if(!name||!program)throw new Error('Usage: polygate mcp add-local NAME [--env KEY=VALUE]... COMMAND [ARGS...]   for example: polygate mcp add-local files npx -y @modelcontextprotocol/server-filesystem /srv/share');
      const s=done(await call('/admin/mcp/servers',{name,transport:'stdio',command:program,args,env:Object.keys(env).length?env:undefined}));
      console.log(`Added "${s.name}": ${s.status.state==='ready'?`connected, ${s.status.tools.length} tool(s)`:s.status.state==='error'?`could not start yet: ${s.status.error}`:'starting (the first start may download it)'}`);return;
    }
    if(action==='remove'){const s=await byName(rest[0]||'');done(await call('/admin/mcp/servers/delete',{id:s.id}));console.log(`Removed "${s.name}"`);return;}
    if(action==='on'||action==='off'){const s=await byName(rest[0]||'');const r=done(await call('/admin/mcp/servers/toggle',{id:s.id,enabled:action==='on'}));console.log(`"${r.name}" is ${action==='on'?`on (${r.status.state})`:'off'}`);return;}
    throw new Error('Usage: polygate mcp list | add-local NAME [--env KEY=VALUE]... COMMAND [ARGS...] | remove NAME | on NAME | off NAME');
  }
  // doctor: a plain-words health report for whoever runs the server.
  if(command==='doctor'){
    const lines:string[]=[];let bad=0;
    const note=(good:boolean|null,text:string)=>{lines.push(`  ${good===null?'-':good?'ok':'!!'}  ${text}`);if(good===false)bad++;};
    try{
      const health=await call('/healthz');const h=JSON.parse(health.text);
      note(health.ok&&h.ok,health.ok?`Gateway answers (version ${h.version}, up ${Math.round(h.uptime/60)} min)`:`Gateway answered HTTP ${health.status}`);
      const hs=JSON.parse((await call('/admin/https')).text);
      if(hs.mode==='off')note(null,'HTTPS is off (the dashboard is local only or behind your own web server)');
      else if(hs.active)note(hs.daysLeft>5,`HTTPS is active at ${hs.url} (${hs.mode}, certificate valid ${hs.daysLeft} more day(s), issued by ${hs.issuer||'unknown'})`);
      else note(false,`HTTPS is set to ${hs.mode} but no valid certificate is active${hs.lastError?': '+hs.lastError:''}`);
      if(hs.mode!=='off'&&hs.mode!=='custom')note(hs.challengeServer,hs.challengeServer?`Port ${hs.httpPort} is open for certificate checks and the redirect`:`Port ${hs.httpPort} is not being served, so certificates cannot renew`);
      const ready=JSON.parse((await call('/readyz')).text);
      note(!!ready.ready,ready.ready?`Ready: ${ready.models} model(s), ${ready.routes} route(s)`:`Not ready: ${ready.state==='paused'?'the gateway is paused':(ready.issues||[]).map((i:any)=>i.message).join(' ')||'it is still starting'} (${ready.models} model(s), ${ready.routes} route(s)).`);
    }catch(e:any){note(false,`Could not reach the gateway on this machine (${String(e.message||e).slice(0,120)}). Is the service running? Try: polygate status`);}
    console.log(lines.join('\n'));if(bad)process.exitCode=1;return;
  }
  throw new Error('Unknown control command');
}
try{await run();}catch(e:any){console.error(e.message||String(e));process.exitCode=1;}finally{db.close();}
