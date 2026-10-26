// Local service control. Never import this module into the HTTP server.
import { randomBytes, scryptSync } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
process.env.POLYGATE_READ_ONLY_STATE='1';
const { settings, persist, stateDir, db } = await import('./state');

const command=process.argv[2]||'settings';
async function run(){
  if(command==='password'){
    const supplied=process.argv.includes('--stdin')?(await Bun.stdin.text()).trim():'';
    const password=supplied||randomBytes(18).toString('base64url');
    if(password.length<12)throw new Error('Password must contain at least 12 characters');
    const salt=randomBytes(16).toString('hex');
    settings.admin={password:{salt,hash:scryptSync(password,salt,32).toString('hex')},epoch:(settings.admin?.epoch||0)+1};persist();
    writeFileSync(path.join(stateDir,'admin-password.txt'),password+'\n',{mode:0o600});
    console.log('Password reset. Saved to '+path.join(stateDir,'admin-password.txt'));return;
  }
  if(command==='settings'){
    const {publicSettings}=await import('./state');const out=publicSettings();
    console.log(JSON.stringify({...out,keys:out.keys.map(k=>({...k,value:'[redacted]'}))},null,2));return;
  }
  if(command==='request'){
    const endpoint=process.argv[3]||'/healthz';
    if(!/^\/(admin\/|healthz$|readyz$)/.test(endpoint))throw new Error('Only local management endpoints are allowed');
    const mode=settings.https?.mode||'off';const secure=mode!=='off'&&existsSync(path.join(stateDir,'tls',`${mode==='custom'?'custom':mode}-fullchain.pem`));
    const port=secure?(settings.https?.port||443):Number(process.env.POLYGATE_PORT||4317);
    const token=process.env.POLYGATE_ADMIN_TOKEN||readFileSync(path.join(stateDir,'admin-token'),'utf8').trim();
    const raw=await Bun.stdin.text();let body:unknown;if(raw.trim())body=JSON.parse(raw);
    const response=await fetch(`${secure?'https':'http'}://127.0.0.1:${port}${endpoint}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(45000),...(secure?{tls:{rejectUnauthorized:false}}:{})} as any);
    const text=await response.text();console.log(text);if(!response.ok)process.exitCode=1;return;
  }
  throw new Error('Unknown control command');
}
try{await run();}catch(e:any){console.error(e.message||String(e));process.exitCode=1;}finally{db.close();}
