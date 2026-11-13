import {useMemo,useState} from 'react';
import {ArrowRight,ChevronRight,Globe,Network,Search,Server,Terminal,X} from 'lucide-react';
// The Guide: every part of Polygate in plain words, searchable. Each entry names the page it lives on, and Open goes there.
type Entry={title:string;page?:string;text:string;words?:string};
type Section={name:string;entries:Entry[]};
const SECTIONS:Section[]=[
  {name:'Getting started',entries:[
    {title:'What Polygate does',text:'Your coding tools send requests to one local address. Polygate picks a model and a provider, sends the request through the network exit you chose, and passes the answer back in the format your tool expects.',words:'gateway overview how it works'},
    {title:'Connect your client',page:'Overview',text:'Copy the Base URL and an API key from the top of Overview. OpenAI clients use /v1/chat/completions or /v1/responses; Anthropic clients use /v1/messages with the key as x-api-key. The model list is at /v1/models.',words:'base url api key endpoint openai anthropic claude code kilo cline cursor opencode setup'},
    {title:'The checklist',page:'Overview',text:'When something stops requests or hurts some of them (no route can take requests, an exit used up, WARP down, a catalog that cannot be read), Overview lists it with what it means and a button that fixes it when a retry is enough.',words:'needs attention problems readiness recovery'},
    {title:'Pause the gateway',text:'Pause gateway in the top right stops new model requests until you resume. The dashboard keeps working.',words:'stop disable resume'},
    {title:'Compact view (Windows app)',text:'A small window to keep beside your work (Ctrl+Shift+M): gateway state, the route in use, recent requests and the last 24 hours. It can stay on top of other windows.',words:'mini window tray always on top'},
    {title:'Notifications',text:'The bell collects notices: an exit used up or switched, a model resting, WARP down, updates. Alerts in Settings can also send them to a webhook.',words:'bell notices'},
  ]},
  {name:'Models',entries:[
    {title:'The model catalog',page:'Models',text:'Every model from your providers, with its availability, capabilities, latency and priority. Refresh catalog reads the providers again. Lower priority numbers are tried first.',words:'list refresh priority capabilities availability'},
    {title:'Choosing a model: auto and exact names',text:'auto takes the best usable model and can fall back to another; auto:smart prefers reasoning and larger models; auto:fast prefers the quickest. An exact name like opencode/deepseek-v4.1-flash-free uses that model only.',words:'auto smart fast model id select'},
    {title:'Checking models',page:'Models',text:'Check sends one small request to a model. Check by provider runs over all of a provider\'s models, optionally on a timer, and stops when the provider asks to slow down. A model with a temporary refusal stays "unchecked" with its reason shown.',words:'probe check availability unchecked cooldown unavailable'},
    {title:'When a model fails',page:'Models',text:'Pause a model after errors rests a model that keeps failing. Retry with fewer tools: when OpenCode refuses a request because of the client\'s extra tools, Polygate retries with the standard tools and remembers that list. Fall back when the model is "auto" tries the next model.',words:'cooldown pause tools trim fallback refused'},
    {title:'Chains',page:'Chains',text:'Your own model name, for example my-coding, that tries a list of models in your order. A busy or refusing model falls through to the next one. Clients ask for the chain like any model.',words:'fallback list order custom model name'},
    {title:'Tool calls repaired on the way',text:'Some models (DeepSeek among them) misname a tool\'s arguments, such as path instead of filePath. Polygate fixes the names against the tool\'s own definition before your client sees the call, and logs each repair.',words:'invalid tool call arguments deepseek repair schema'},
  ]},
  {name:'Providers',entries:[
    {title:'OpenCode Free',page:'Providers',text:'Built in. OpenCode gives each network address a daily allowance. When an exit is used up, Polygate moves to another exit and says when the limit resets. Its identity (the OpenCode version and tools it presents) is learned from OpenCode\'s sources.',words:'opencode free daily allowance limit 429'},
    {title:'Kilo Free',page:'Providers',text:'Built in, every model Kilo marks free, no account needed. Kilo limits anonymous use per address: that exit is set aside for Kilo and requests move on; when no exit is left, Kilo models rest 30 minutes. An optional Kilo key can be saved on its row.',words:'kilo free anonymous limit key'},
    {title:'Z.ai (ZCode)',page:'Providers',text:'Import your Z.ai coding-plan accounts and choose the active one. Each model has its own quota and reset time. Polygate does not switch accounts by itself.',words:'zai glm zcode account quota'},
    {title:'Your own providers',page:'Providers',text:'Add any OpenAI-compatible API (base URL with /v1 and usually a key) or a real OpenCode server. Each provider can have its own route, and its models appear under the prefix you choose.',words:'openai compatible custom endpoint add provider opencode server'},
    {title:'Provider routes',page:'Providers',text:'Change on a provider row picks which exits that provider uses, in order, or lets it follow the route in use.',words:'route per provider exit'},
  ]},
  {name:'Routing',entries:[
    {title:'Routing: the exit in use',page:'Routing',text:'Every exit in one list or map: Direct, proxies, the proxy pool, relays, WARP and Psiphon. Use this exit makes one the route in use; Test sends a real request through it; Disable takes it out of use.',words:'route exit network list map direct use this exit'},
    {title:'Routing policy',page:'Routing',text:'Spread requests over my exits sends each request through the next healthy exit. Move on when an exit is used up and Move on when an exit can\'t connect choose what happens on failure; Next in line shows the order. Your own address decides when Direct may be used.',words:'spread rotate failover backup next in line used up direct own address policy'},
    {title:'A used-up exit',page:'Routing',text:'OpenCode answers 429 with a countdown. Polygate confirms it with a small request through the same exit (DeepSeek 4.1 Flash first, then GLM 5.3 Flash, MiniMax M3.1 Flash, then others), marks the exit until the reset, and moves the request to the next exit. Requests keep working; only the exit is set aside.',words:'429 exhausted allowance used up check canary'},
    {title:'A refused request',page:'Routing',text:'When OpenCode refuses a request but the small check through the same exit passes, the request is retried with fewer tools and then through other exits, without marking the exit. If every exit refuses, the error says so.',words:'refused request limit access error confirmed clean'},
    {title:'Proxies and the proxy pool',page:'Proxies',text:'Find working proxies downloads public lists (or your own lists and proxies under My proxies and lists), tests them with real model requests and keeps the working ones. The pool can be the route in use or a standby used only when your own exit is used up.',words:'proxy pool socks http public list scan standby'},
    {title:'Relays',page:'Relays',text:'Deploy a small forwarding function to your own Vercel, Netlify or Cloudflare account in one click, or add any compatible relay. Vercel streams and carries OpenCode best; Netlify answers in one piece; a Cloudflare Worker carries Kilo and your own providers, not OpenCode.',words:'relay vercel netlify cloudflare worker deploy token'},
    {title:'Cloudflare WARP',page:'WARP',text:'A built-in MASQUE tunnel over HTTP/2 with a local SOCKS port; nothing on the machine changes. Set up & connect, New identity for another exit address, engine, port, parallel tunnels and rotation under Settings.',words:'warp cloudflare masque tunnel identity usque'},
    {title:'Psiphon',page:'Psiphon',text:'Tick regions and press Connect: Polygate runs Psiphon\'s client once per region, together one route named Psiphon. Take turns (round robin) or stay on one region. A used-up exit is skipped for that provider only, gets a new address and is checked before it comes back (at most three an hour per region). Test checks every region.',words:'psiphon region round robin new address renew used up'},
    {title:'Which region a request used',page:'Logs',text:'Request lines say the region, for example "via Psiphon NL", and Logs → Psiphon shows when a request moved from one region to another and why.',words:'psiphon region log moved'},
  ]},
  {name:'MCP',entries:[
    {title:'One MCP address',page:'MCP',text:'Add MCP servers once; every AI client gets all their tools from /mcp with its Polygate key. Remote servers are reached through the route you choose; their headers and keys are stored encrypted.',words:'mcp tools server hub streamable http sse'},
    {title:'Local MCP programs',page:'MCP',text:'npx or uvx programs can be added in the Windows app. On a server they are added only from the server itself (sudo polygate mcp add-local), never from the web dashboard.',words:'npx uvx local program'},
  ]},
  {name:'Agent (Windows app)',entries:[
    {title:'The Agent',page:'Agent',text:'A coding agent that works in a folder you choose, through your own models. Sessions are kept per folder, each with its model and mode. It runs on OpenCode\'s engine (2.3.0), downloaded and checked by Polygate on first use.',words:'agent coding sessions folder engine opencode'},
    {title:'Permission modes',page:'Agent',text:'Ask for approval asks before it writes or runs commands; Accept edits writes files without asking; Plan only reads and plans; Rules-based approvals follows the rules you saved for the folder; Full access works without asking and needs a confirmation. Polygate\'s own folders stay closed in every mode.',words:'ask for approval accept edits plan rules full access permissions approve'},
    {title:'Undo',page:'Agent',text:'Each turn lists the files it changed; Undo puts them back and keeps your own edits made in the meantime. Folder backups for Undo are off until you turn them on in the Agent settings.',words:'undo revert backup changes'},
    {title:'OpenCode Free in the Agent',page:'Agent',text:'OpenCode Free models can be used only while the Agent engine and the gateway present the same OpenCode version. A model that cannot be used says why in the model list.',words:'blocked compatibility version engine pinned'},
  ]},
  {name:'Watching it work',entries:[
    {title:'Playground',page:'Playground',text:'Send real requests through the gateway: conversations, two models side by side, streaming, JSON, a sample tool, reasoning, saved prompts and quick tests.',words:'test try request compare prompt'},
    {title:'Requests',page:'Requests',text:'Every request with its status, timing, route and tokens. Select one to see its shape: sizes, header names and the provider\'s answer. Prompts, answers and credentials are never recorded.',words:'activity history status errors request shape'},
    {title:'Usage',page:'Usage',text:'Requests and tokens per day for up to a year, the busiest day, and where they went by model, route or client key. Daily values opens the numbers behind the chart.',words:'usage tokens daily statistics chart'},
    {title:'Logs',page:'Logs',text:'Everything the gateway did, searchable, filtered by level, source and time, and exportable as text or JSON.',words:'logs events search export debug'},
  ]},
  {name:'Settings',entries:[
    {title:'Gateway limits',page:'Settings',text:'Concurrent requests, queue capacity and wait, the request deadline, transient retries and how often catalogs refresh.',words:'limits concurrency queue timeout deadline retries'},
    {title:'Client keys',page:'Settings',text:'Keys for your tools (pg_…). Each can have a token budget, a per-minute limit, an expiry and a list of allowed models. A request that cannot fit is refused, not cut short.',words:'api keys budget limit expiry allowed models'},
    {title:'Adaptive provider (Refresh identity)',page:'Settings',text:'Reads OpenCode\'s current sources again: the version and tool definitions Polygate presents to OpenCode Free. Requests keep the last valid recipe when the sources cannot be reached.',words:'identity refresh opencode version recipe'},
    {title:'Dashboard security and HTTPS',page:'Settings',text:'The dashboard password (on servers), and built-in HTTPS with a domain, the server\'s IP address or your own certificate.',words:'password https certificate tls domain lets encrypt'},
    {title:'Alerts',page:'Settings',text:'Send notices to a Discord, Slack or any JSON webhook, from the level you choose. Save & send test sends one test notice right away.',words:'webhook discord slack alerts notify'},
    {title:'Backup and restore',page:'Settings',text:'One file, protected by your passphrase, with providers and keys, routes and relay tokens, client keys, chains, MCP servers, Psiphon settings and preferences. The dashboard password, HTTPS certificates, WARP registration and request history are not included. Restore keeps a copy of the current settings and needs a restart.',words:'backup restore export import passphrase migrate'},
    {title:'Updates',page:'Settings',text:'The Windows app downloads the new version, checks its SHA-256 and restarts itself (Update & restart). On Linux run sudo polygate update.',words:'update upgrade version release'},
  ]},
  {name:'When something goes wrong',entries:[
    {title:'"Daily allowance used up" (OpenCode)',page:'Routing',text:'That network address has used OpenCode\'s daily allowance. Add another exit (Psiphon, WARP, a proxy or a relay) and keep Move on when an exit is used up switched on.',words:'429 used up allowance limit'},
    {title:'"Refused this request" though a small check passed',page:'Models',text:'Often caused by the extra tools a coding client sends. Keep Retry with fewer tools on; Polygate also tries other exits before giving up.',words:'refused 429 tools'},
    {title:'"Maximum context length" from a model',text:'The conversation is longer than the model can take. Run compaction in your client or start a new session; Polygate passes the provider\'s answer through.',words:'context length tokens too long compaction'},
    {title:'"Expected \'id\' to be a string" or "invalid tool call"',text:'A tool call arrived out of order or with wrong argument names. Both are repaired by Polygate now; if you still see it, check Logs → Requests for the model and the route.',words:'invalid tool call id string ai sdk'},
    {title:'Kilo stopped answering from this address',page:'Providers',text:'Kilo\'s anonymous limit. Requests move to another exit; with none left, Kilo models rest 30 minutes.',words:'kilo limit promotion'},
    {title:'WARP could not start a tunnel',page:'WARP',text:'"Your network reset the connection" means the network blocks Cloudflare\'s MASQUE servers; "did not answer in time" means it is slow or filtered. Try Psiphon or a relay instead.',words:'warp error reset masque'},
  ]},
];
const norm=(s:string)=>s.toLowerCase();
export function Guide({go}:{go:(page:any)=>void}){
  const [q,setQ]=useState('');
  const words=norm(q).split(/\s+/).filter(Boolean);
  const shown=useMemo(()=>SECTIONS.map(s=>({...s,entries:s.entries.filter(e=>{const hay=norm(`${s.name} ${e.title} ${e.text} ${e.words||''} ${e.page||''}`);return words.every(w=>hay.includes(w));})})).filter(s=>s.entries.length),[q]);
  const total=shown.reduce((n,s)=>n+s.entries.length,0);
  return <div className="guide">
    <section className="section-block form-section"><h2>One gateway. Separate responsibilities.</h2><p>Polygate translates a client request, admits it within your limits, picks a provider and model, and sends it through the exit you chose. When an exit is used up or refuses, it moves on by itself.</p>
      <div className="guide-flow"><span><Terminal size={20}/>Coding client</span><ArrowRight size={17}/><span><Network size={20}/>Polygate</span><ArrowRight size={17}/><span><Globe size={20}/>Network exit</span><ArrowRight size={17}/><span><Server size={20}/>Model provider</span></div></section>
    <div className="guide-search"><Search size={17}/><input type="search" aria-label="Search the guide" placeholder="Search the guide: psiphon, used up, backup, tool call…" value={q} onChange={e=>setQ(e.target.value)}/>{q&&<button className="icon-button" aria-label="Clear search" onClick={()=>setQ('')}><X size={15}/></button>}<span className="subtle" role="status">{q?`${total} ${total===1?'match':'matches'}`:`${SECTIONS.reduce((n,s)=>n+s.entries.length,0)} topics`}</span></div>
    {shown.length?shown.map(s=><section key={s.name} className="section-block guide-section"><h2>{s.name}</h2>
      {s.entries.map(e=><article key={e.title} className="guide-entry"><div><h3>{e.title}</h3><p>{e.text}</p></div>{e.page&&<button type="button" className="text-button" onClick={()=>{go(e.page);window.scrollTo(0,0);}}>Open {e.page}<ChevronRight size={14}/></button>}</article>)}
    </section>):<section className="section-block form-section"><p className="muted">Nothing in the guide matches “{q}”. Try a shorter word, or search Logs for what happened.</p></section>}
    <section className="section-block form-section"><h2>Built from inspected code</h2><p>Adaptive bridge: azrinaldi. Protocol adapters: 12errh. Proxy source lists: B3hnamR’s ProxyHive. Relay compatibility follows the supplied 9Router and AutoZCoder code. WARP uses a helper built from usque (MIT); Psiphon is Psiphon Inc.’s official client (GPL-3.0). Exact provenance is in the project’s <code>THIRD_PARTY_NOTICES.md</code>.</p></section>
  </div>;
}
