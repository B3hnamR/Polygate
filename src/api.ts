// The desktop app opens the dashboard with #token=…; it is exchanged once for a session cookie (App: /admin/session) and then dropped,
// so it is not kept in sessionStorage or resent with every request, and signing out really signs out.
let token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
sessionStorage.removeItem('polygate-token');   // written by earlier versions
if(location.hash.includes('token='))history.replaceState(null,'',location.pathname+location.search);
// Where this page is served from: "" at the root (the desktop app, a plain install) or "/polygate" when the server puts the dashboard there.
export const BASE = new URL('.', location.href).pathname.replace(/\/$/, '');
export const at = (path: string) => BASE + path;
export const hasToken=()=>!!token;
export const dropToken=()=>{token='';};
export class ApiError extends Error{constructor(message:string,public status:number){super(message);}}
const auth=():Record<string,string>=>token?{authorization:'Bearer '+token}:{};
export async function api(path:string,body?:unknown){
  const r=await fetch(at(path),{method:body===undefined?'GET':'POST',headers:{...auth(),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  // Error pages and empty bodies are not always JSON; keep the HTTP status as the message instead of a parse error.
  const text=await r.text();let data:any=undefined;let parsed=true;try{data=text?JSON.parse(text):{};}catch{parsed=false;}
  if(!r.ok){const e=data&&typeof data==='object'?data.error:undefined;throw new ApiError(typeof e==='string'?e:e?.message||`Request failed (${r.status})`,r.status);}
  // A 200 that is not a JSON object (a captive portal, a proxy's HTML page) used to become {} and blank the screen on the first field read.
  if(!parsed||!data||typeof data!=='object')throw new ApiError(`Unexpected response from the gateway (HTTP ${r.status})`,r.status);
  return data;
}
