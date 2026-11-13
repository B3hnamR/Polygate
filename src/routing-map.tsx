import {useEffect,useMemo,useRef,useState,type KeyboardEvent as ReactKeyboardEvent,type PointerEvent as ReactPointerEvent,type ReactNode} from 'react';
import {ArrowDown,ArrowUp,Check,ChevronRight,CloudUpload,FlaskConical,Maximize,Minus,Pause,Play,Plus,Rows3,ScrollText,Trash2,Unlink,X} from 'lucide-react';
import {useConfirm} from './confirm';
import {Badge,Button,Field,Select,Toggle,compact,ms,time,usePoll,type Snapshot} from './ui';
import {Stamp,usedUp} from './daypass';
import {shortName,stateCounts} from './overview-parts';
import {platformOf} from './relay-manage';
import {ZAI_EXITS,providerRouteText,routeRefusal,routesOf,usedByText} from './provider-routes';
import {ExitPolicy} from './routing-policy';
import type {Provider,ProviderRoutes,Route} from '../backend/types';

// A second view of the Routing page: providers and exits as tickets joined by lines. Nothing here has settings of its own. A line is a provider's
// route list (provider.routes), the "Route in use" node is settings.routeId with its spreading and failover switches, and pausing a node is the same
// switch as on the list view, so both views always show the same thing. Only the node positions belong to the map; they are kept on this device.

type Props={data:Snapshot;act:Function;pending:string;notice:(message:string,kind?:'ok'|'error')=>void;go:(page:any)=>void;onTest:(r:Route)=>void;onManage:(r:Route,mode:'update'|'remove')=>void;onDelete:(r:Route)=>void;onAddRoute:()=>void;onShowList:()=>void};
type MapMetrics={byProvider:{provider:string;requests:number}[];byRoute:{route:string;requests:number}[];byLink:{provider:string;route:string;requests:number}[];requests:number};
type Point={x:number;y:number};
type LineState='live'|'standby'|'paused'|'blocked'|'off';
type Line={id:string;from:string;to:string;state:LineState;why:string;order?:number;requests:number;kind:'in'|'follow'|'link'|'out'|'locked'|'backup';provider?:Provider;route?:Route};
type Picked={type:'node'|'line';id:string}|null;
// A line being dragged. from: where it starts. replace: the node an existing line ended on, when its end was picked up. reverse: dragged from an exit back to a provider.
type Wire={from:string;at:Point;replace?:string;reverse?:boolean};
const ZAI_NOT_SHARED='Z.ai does not follow the shared route. It keeps its own exit: Direct or a proxy of your own.';

const NODE_W=236,NODE_H=116,ROW_GAP=18,COLS={requests:0,providers:292,gate:584,routes:876};
const LAYOUT_KEY='polygate-map-layout';
const providerNode=(id:string)=>'p:'+id,routeNode=(id:string)=>'r:'+id;
const readLayout=():Record<string,Point>=>{try{return JSON.parse(localStorage.getItem(LAYOUT_KEY)||'{}')||{};}catch{return {};}};
const writeLayout=(l:Record<string,Point>)=>{try{localStorage.setItem(LAYOUT_KEY,JSON.stringify(l));}catch{/* storage can be disabled; the layout then lasts until the page closes */}};
const kindName=(r:Route)=>r.id==='proxy-pool'?'Proxy pool':r.kind==='direct'?'Direct':r.kind==='warp'?'WARP':r.kind==='relay'?(r.deployed?.platform?`Relay · ${r.deployed.platform[0].toUpperCase()+r.deployed.platform.slice(1)}`:'Relay'):'Proxy';
const providerKind=(p:Provider)=>p.kind==='free'?'Built in · OpenCode Free':p.kind==='kilo'?'Built in · Kilo':p.kind==='zai'?'Built in · Z.ai':p.kind==='opencode'?'OpenCode server':'OpenAI compatible';
const resting=(r:Route)=>(r.cooldownUntil||0)>Date.now();

function defaults(providers:Provider[],routes:Route[]){
  const tall=(n:number)=>n*NODE_H+Math.max(0,n-1)*ROW_GAP;const height=Math.max(tall(providers.length),tall(routes.length),NODE_H);const mid=(height-NODE_H)/2;
  const place:Record<string,Point>={requests:{x:COLS.requests,y:mid},gate:{x:COLS.gate,y:mid}};
  const column=(ids:string[],x:number)=>{const top=(height-tall(ids.length))/2;ids.forEach((id,i)=>{place[id]={x,y:top+i*(NODE_H+ROW_GAP)};});};
  column(providers.map(p=>providerNode(p.id)),COLS.providers);column(routes.map(r=>routeNode(r.id)),COLS.routes);
  return place;
}
// One provider's line to one exit: what it does right now and why, in the same terms as the list view.
function linkState(p:Provider,r:Route,paused:boolean):{state:LineState;why:string}{
  if(paused)return {state:'paused',why:'Paused: it keeps its place and is not used'};
  if(!p.enabled)return {state:'off',why:`${p.name} is switched off`};
  if(!r.enabled)return {state:'off',why:`${r.name} is switched off`};
  if(p.kind==='free'&&usedUp(r))return {state:'blocked',why:`Used up until ${time(r.exhaustedUntil!)}`};
  if(resting(r))return {state:'blocked',why:`Resting until ${time(r.cooldownUntil!)}`};
  return {state:'live',why:'Requests can use this line'};
}
const bezier=(a:Point,b:Point)=>{const dx=Math.max(70,Math.abs(b.x-a.x)*.46);return {c1:{x:a.x+dx,y:a.y},c2:{x:b.x-dx,y:b.y}};};
const pathOf=(a:Point,b:Point)=>{const {c1,c2}=bezier(a,b);return `M${a.x} ${a.y} C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`;};
const along=(a:Point,b:Point,t:number)=>{const {c1,c2}=bezier(a,b);const u=1-t;const at=(p:'x'|'y')=>u*u*u*a[p]+3*u*u*t*c1[p]+3*u*t*t*c2[p]+t*t*t*b[p];return {x:at('x'),y:at('y')};};
// The line's weight is its traffic in the last 24 hours, on a log scale so one busy line does not make the rest invisible.
const weight=(n:number)=>1.5+Math.min(3,Math.log10(n+1)*.8);

export function RoutingMap({data,act,pending,notice,go,onTest,onManage,onDelete,onAddRoute,onShowList}:Props){
  const s=data.settings;const {confirm,dialog}=useConfirm();const {data:metrics}=usePoll<MapMetrics>('/admin/metrics',10000);
  const [layout,setLayout]=useState<Record<string,Point>>(readLayout);const [view,setView]=useState({x:30,y:50,k:1});const [picked,setPicked]=useState<Picked>(null);const [wire,setWire]=useState<Wire|null>(null);const [setup,setSetup]=useState(false);
  const canvas=useRef<HTMLDivElement>(null);const viewRef=useRef(view);viewRef.current=view;const moved=useRef(false);
  const place=useMemo(()=>({...defaults(s.providers,s.routes),...layout}),[s.providers,s.routes,layout]);
  const nodeIds=useMemo(()=>['requests','gate',...s.providers.map(p=>providerNode(p.id)),...s.routes.map(r=>routeNode(r.id))],[s.providers,s.routes]);

  const countFor=(p:Provider)=>metrics?.byProvider.find(x=>x.provider===p.id)?.requests||0;
  const routeCount=(r:Route)=>metrics?.byRoute.find(x=>x.route===r.name)?.requests||0;
  const linkCount=(p:Provider,r:Route)=>metrics?.byLink?.find(x=>x.provider===p.id&&x.route===r.name)?.requests||0;
  const followers=s.providers.filter(p=>p.kind!=='zai'&&!routesOf(p));
  // The route in use, and why it cannot take requests right now (empty when it can).
  const inUse=s.routes.find(r=>r.id===s.routeId);
  const inUseOut=!inUse?'':!inUse.enabled?'is switched off':usedUp(inUse)?'is used up':resting(inUse)?'is resting after errors':'';
  const standInName=!s.rotate&&inUseOut&&s.exhaustedFailover!==false?(data.backup||[]).find(b=>b.usable)?.name:undefined;
  // The gateway's own list of the exits a spread takes turns over, so the map and the requests cannot disagree.
  const spread=s.rotate?(data.spread?s.routes.filter(r=>data.spread!.includes(r.id)):s.routes.filter(r=>r.enabled&&(r.kind!=='direct'||s.spreadDirect===true))):[];

  const lines=useMemo<Line[]>(()=>{
    const out:Line[]=[];
    for(const p of s.providers){
      out.push({id:'in:'+p.id,kind:'in',from:'requests',to:providerNode(p.id),provider:p,requests:countFor(p),state:!s.enabled||!p.enabled?'paused':'live',why:!s.enabled?'The gateway is paused':!p.enabled?`${p.name} is switched off`:'Requests can use this provider'});
      if(p.kind==='zai'){const zset=routesOf(p);const r=s.routes.find(x=>x.id===(zset?.ids[0]||'direct'));if(r)out.push({id:'locked:'+p.id,kind:'locked',from:providerNode(p.id),to:routeNode(r.id),provider:p,route:r,requests:linkCount(p,r),...(zset?linkState(p,r,!!zset.paused?.includes(r.id)):{state:p.enabled?'live' as const:'off' as const,why:p.enabled?'Z.ai uses Direct unless you give it a proxy of your own':`${p.name} is switched off`})});continue;}
      const set=routesOf(p);
      if(!set){out.push({id:'follow:'+p.id,kind:'follow',from:providerNode(p.id),to:'gate',provider:p,requests:countFor(p),state:p.enabled?'live':'off',why:p.enabled?'Follows the route in use':`${p.name} is switched off`});continue;}
      const active=set.ids.filter(id=>!set.paused?.includes(id));
      set.ids.forEach(id=>{const r=s.routes.find(x=>x.id===id);if(!r)return;const st=linkState(p,r,!!set.paused?.includes(id));const n=active.indexOf(id);
        out.push({id:`link:${p.id}:${id}`,kind:'link',from:providerNode(p.id),to:routeNode(id),provider:p,route:r,order:!set.spread&&active.length>1&&n>=0?n+1:undefined,requests:linkCount(p,r),...st});});
    }
    const exits=s.rotate?spread:s.routes.filter(r=>r.id===s.routeId);
    for(const r of exits)out.push({id:'out:'+r.id,kind:'out',from:'gate',to:routeNode(r.id),route:r,requests:followers.reduce((t,p)=>t+linkCount(p,r),0),...(!r.enabled?{state:'off' as const,why:`${r.name} is switched off`}:usedUp(r)?{state:'blocked' as const,why:`Used up until ${time(r.exhaustedUntil!)}. Requests move to the next exit in line.`}:resting(r)?{state:'blocked' as const,why:`Resting until ${time(r.cooldownUntil!)}`}:{state:'live' as const,why:s.rotate?'Part of the spread':'The route in use'})});
    // The exits next in line behind the route in use (the gateway's own list, as on the Routing policy), so a request that moved on to a backup
    // is drawn going there. While the route in use cannot take requests, the first usable backup is the one carrying them: it is drawn open.
    if(!s.rotate&&inUse){
      const chain=(data.backup||[]).filter(b=>{const r=s.routes.find(x=>x.id===b.id);return r&&r.enabled&&(r.kind!=='direct'||s.allowDirect===true);});
      const standIn=inUseOut?chain.find(b=>b.usable)?.id:undefined;
      chain.forEach((b,i)=>{const r=s.routes.find(x=>x.id===b.id)!;
        out.push({id:'backup:'+r.id,kind:'backup',from:'gate',to:routeNode(r.id),route:r,order:i+1,requests:followers.reduce((t,p)=>t+linkCount(p,r),0),
          ...(r.id===standIn?{state:'live' as const,why:`Taking the requests now: ${shortName(inUse.name)} ${inUseOut}`}
            :b.usable?{state:'standby' as const,why:`Backup ${i+1}: used when the exits before it cannot take a request`}
            :{state:'blocked' as const,why:`Backup ${i+1}, ${b.why}`})});});
    }
    return out;
  },[s,metrics,data.backup]);

  // ---- changing the settings; every change goes through the same endpoints as the list view
  const saveRoutes=(p:Provider,routes:ProviderRoutes|null,success:string)=>act('map:'+p.id,'/admin/providers',{...p,routes},success);
  const connect=(p:Provider,r:Route)=>{
    const why=routeRefusal(p,r);if(why){notice(why,'error');return;}
    const set=routesOf(p);if(set?.ids.includes(r.id))return;
    if(p.kind==='zai'){saveRoutes(p,r.id==='direct'?null:{ids:[r.id]},`${p.name} now uses ${shortName(r.name)}`);return;}
    saveRoutes(p,{ids:[...(set?.ids||[]),r.id],spread:set?.spread,backups:set?.backups,paused:set?.paused},`${p.name} can now use ${shortName(r.name)}`);
  };
  const disconnect=(p:Provider,id:string)=>{
    const set=routesOf(p);if(!set)return;const ids=set.ids.filter(x=>x!==id);
    if(!ids.length){void follow(p);return;}
    saveRoutes(p,{...set,ids,paused:set.paused?.filter(x=>x!==id)},'Line removed');
  };
  // A line's end moved to another exit: it keeps its place in the order, and stays paused if it was.
  const moveLine=(p:Provider,from:string,r:Route)=>{
    const why=routeRefusal(p,r);if(why){notice(why,'error');return;}
    const set=routesOf(p);if(!set||set.ids.includes(r.id))return;
    saveRoutes(p,{...set,ids:set.ids.map(x=>x===from?r.id:x),paused:set.paused?.map(x=>x===from?r.id:x)},`${p.name} now uses ${shortName(r.name)}`);
  };
  const togglePause=(p:Provider,id:string)=>{
    const set=routesOf(p);if(!set)return;const on=!!set.paused?.includes(id);
    saveRoutes(p,{...set,paused:on?set.paused!.filter(x=>x!==id):[...(set.paused||[]),id]},on?'Line resumed':'Line paused');
  };
  const move=(p:Provider,id:string,by:number)=>{const set=routesOf(p);if(!set)return;const ids=set.ids.slice();const i=ids.indexOf(id);const j=i+by;if(j<0||j>=ids.length)return;[ids[i],ids[j]]=[ids[j],ids[i]];saveRoutes(p,{...set,ids},'Order changed');};
  const follow=async(p:Provider)=>{
    const set=routesOf(p);if(!set)return;
    if(await confirm(<><strong>{p.name}</strong> will use the route in use, with its spreading and failover, instead of its {set.ids.length===1?'own line':`${set.ids.length} own lines`}.</>,{title:'Follow the route in use',confirm:'Follow it',icon:<Unlink size={18}/>}))saveRoutes(p,null,`${p.name} now follows the route in use`);
  };
  const toggleProvider=(p:Provider)=>act('provider','/admin/providers',{...p,enabled:!p.enabled},p.enabled?`${p.name} paused`:`${p.name} resumed`).then((ok:boolean)=>{if(ok&&!p.enabled&&p.kind==='zai')void act('discover','/admin/discover',{},'Model catalog refreshed');});
  const toggleRoute=(r:Route)=>act('toggle:'+r.id,'/admin/routes/toggle',{id:r.id,enabled:!r.enabled},r.enabled?`${shortName(r.name)} paused`:`${shortName(r.name)} resumed`);
  const toggleGateway=()=>act('pause','/admin/settings',{enabled:!s.enabled},s.enabled?'Gateway paused':'Gateway resumed');
  const useExit=(r:Route)=>act('route','/admin/settings',{routeId:r.id},`${shortName(r.name)} is now the route in use`);

  // ---- what a dragged line may join
  const joined=(p:Provider,r:Route)=>p.kind==='zai'?(routesOf(p)?.ids[0]||'direct')===r.id:!!routesOf(p)?.ids.includes(r.id);
  const wireProblem=(w:Wire,to:string):string=>{
    if(w.replace===to)return 'Same place';
    if(w.reverse){
      const p=s.providers.find(x=>providerNode(x.id)===to);if(!p)return 'Join it to a provider';
      if(w.from==='gate')return p.kind==='zai'?ZAI_NOT_SHARED:routesOf(p)?'':`${p.name} already follows the route in use`;
      const r=s.routes.find(x=>routeNode(x.id)===w.from)!;
      return joined(p,r)?'Already joined':routeRefusal(p,r);
    }
    if(w.from==='gate'){const r=s.routes.find(x=>routeNode(x.id)===to);if(!r)return 'Join it to an exit';if(s.rotate)return 'Spreading is on, so requests use every exit. Turn spreading off to pick one.';return r.enabled?'':`${r.name} is switched off`;}
    const p=s.providers.find(x=>providerNode(x.id)===w.from);if(!p)return 'Start from a provider';
    if(to==='gate')return p.kind==='zai'?ZAI_NOT_SHARED:routesOf(p)?'':`${p.name} already follows the route in use`;
    const r=s.routes.find(x=>routeNode(x.id)===to);if(!r)return 'Join it to an exit';
    if(joined(p,r))return 'Already joined';
    return routeRefusal(p,r);
  };
  const drop=(w:Wire,to:string)=>{
    const problem=wireProblem(w,to);
    if(problem){if(problem!=='Already joined'&&problem!=='Same place')notice(problem,'error');return;}
    if(w.reverse){const p=s.providers.find(x=>providerNode(x.id)===to)!;if(w.from==='gate')void follow(p);else connect(p,s.routes.find(x=>routeNode(x.id)===w.from)!);return;}
    if(w.from==='gate'){useExit(s.routes.find(x=>routeNode(x.id)===to)!);return;}
    const p=s.providers.find(x=>providerNode(x.id)===w.from)!;
    if(to==='gate'){void follow(p);return;}
    const r=s.routes.find(x=>routeNode(x.id)===to)!;
    if(w.replace?.startsWith('r:')&&p.kind!=='zai'){moveLine(p,s.routes.find(x=>routeNode(x.id)===w.replace)!.id,r);return;}
    connect(p,r);
  };

  // ---- pointer handling
  const world=(e:{clientX:number;clientY:number}):Point=>{const box=canvas.current!.getBoundingClientRect();const v=viewRef.current;return {x:(e.clientX-box.left-v.x)/v.k,y:(e.clientY-box.top-v.y)/v.k};};
  const fit=(where=place)=>{
    const el=canvas.current;if(!el||!el.clientWidth)return;
    const pts=nodeIds.map(id=>where[id]).filter(Boolean);if(!pts.length)return;
    const minX=Math.min(...pts.map(p=>p.x)),maxX=Math.max(...pts.map(p=>p.x))+NODE_W,minY=Math.min(...pts.map(p=>p.y)),maxY=Math.max(...pts.map(p=>p.y))+NODE_H;
    // Room for the bar above and the legend below, and for the column names over the top row.
    const side=34,top=92,bottom=56;const k=Math.max(.5,Math.min(1,(el.clientWidth-side*2)/(maxX-minX),(el.clientHeight-top-bottom)/(maxY-minY)));
    setView({k,x:Math.max(side,(el.clientWidth-(maxX-minX)*k)/2)-minX*k,y:Math.max(top,top+(el.clientHeight-top-bottom-(maxY-minY)*k)/2)-minY*k});
  };
  useEffect(()=>{fit();},[]);// eslint-disable-line react-hooks/exhaustive-deps -- fits once when the map opens; after that the view is the user's
  const zoomAt=(k:number,cx:number,cy:number)=>setView(v=>{const next=Math.max(.35,Math.min(1.6,k));const r=next/v.k;return {k:next,x:cx-(cx-v.x)*r,y:cy-(cy-v.y)*r};});
  const zoomBy=(factor:number)=>{const el=canvas.current;if(el)zoomAt(viewRef.current.k*factor,el.clientWidth/2,el.clientHeight/2);};
  useEffect(()=>{
    const el=canvas.current;if(!el)return;
    const wheel=(e:WheelEvent)=>{e.preventDefault();if(e.ctrlKey||e.metaKey){const box=el.getBoundingClientRect();zoomAt(viewRef.current.k*(e.deltaY<0?1.1:.9),e.clientX-box.left,e.clientY-box.top);}else setView(v=>({...v,x:v.x-e.deltaX,y:v.y-e.deltaY}));};
    el.addEventListener('wheel',wheel,{passive:false});return ()=>el.removeEventListener('wheel',wheel);
  },[]);
  const startPan=(e:ReactPointerEvent<HTMLDivElement>)=>{
    if(e.button!==0||(e.target as Element).closest('.map-node,.map-tools,.map-line-tools,.map-hit,.map-order,.map-end'))return;
    const start={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y};let dragged=false;const el=e.currentTarget;el.setPointerCapture(e.pointerId);
    const onMove=(ev:PointerEvent)=>{if(Math.abs(ev.clientX-start.x)+Math.abs(ev.clientY-start.y)>3)dragged=true;setView(v=>({...v,x:start.vx+ev.clientX-start.x,y:start.vy+ev.clientY-start.y}));};
    const onUp=()=>{el.removeEventListener('pointermove',onMove);el.removeEventListener('pointerup',onUp);if(!dragged){setPicked(null);setSetup(false);}};
    el.addEventListener('pointermove',onMove);el.addEventListener('pointerup',onUp);
  };
  const startDrag=(e:ReactPointerEvent<HTMLElement>,id:string)=>{
    if(e.button!==0||(e.target as Element).closest('.map-pause,.map-port'))return;
    const startAt=world(e);const from=place[id];moved.current=false;const el=e.currentTarget;el.setPointerCapture(e.pointerId);
    let last=from;
    const onMove=(ev:PointerEvent)=>{const at=world(ev);if(Math.abs(at.x-startAt.x)+Math.abs(at.y-startAt.y)<4&&!moved.current)return;moved.current=true;last={x:Math.round(from.x+at.x-startAt.x),y:Math.round(from.y+at.y-startAt.y)};setLayout(l=>({...l,[id]:last}));};
    const onUp=()=>{el.removeEventListener('pointermove',onMove);el.removeEventListener('pointerup',onUp);if(moved.current){setLayout(l=>{writeLayout(l);return l;});setTimeout(()=>{moved.current=false;},60);}};
    el.addEventListener('pointermove',onMove);el.addEventListener('pointerup',onUp);
  };
  // Dropped on empty canvas, nothing changes. A line's end pressed and let go without moving just selects the line.
  const startWire=(e:ReactPointerEvent<Element>,from:string,opts:{replace?:string;reverse?:boolean;line?:string}={})=>{
    e.preventDefault();e.stopPropagation();const {line,...shape}=opts;const start={x:e.clientX,y:e.clientY};let dragged=false;setWire({from,at:world(e),...shape});
    const onMove=(ev:PointerEvent)=>{if(Math.abs(ev.clientX-start.x)+Math.abs(ev.clientY-start.y)>3)dragged=true;setWire({from,at:world(ev),...shape});};
    const onUp=(ev:PointerEvent)=>{window.removeEventListener('pointermove',onMove);window.removeEventListener('pointerup',onUp);setWire(null);if(!dragged&&line){setPicked({type:'line',id:line});return;}const to=document.elementFromPoint(ev.clientX,ev.clientY)?.closest('[data-node]')?.getAttribute('data-node');if(to&&to!==from)drop({from,at:world(ev),...shape},to);};
    window.addEventListener('pointermove',onMove);window.addEventListener('pointerup',onUp);
  };
  const tidy=()=>{const fresh=defaults(s.providers,s.routes);setLayout({});writeLayout({});fit(fresh);};
  const pickNode=(id:string)=>{if(moved.current){moved.current=false;return;}setPicked({type:'node',id});};
  const nodeKeys=(e:ReactKeyboardEvent<HTMLElement>,id:string)=>{const d={ArrowLeft:[-16,0],ArrowRight:[16,0],ArrowUp:[0,-16],ArrowDown:[0,16]}[e.key];if(!d||!e.altKey)return;e.preventDefault();const at=place[id];setLayout(l=>{const n={...l,[id]:{x:at.x+d[0],y:at.y+d[1]}};writeLayout(n);return n;});};
  const pickedLine=picked?.type==='line'?lines.find(l=>l.id===picked.id):undefined;
  const canvasKeys=(e:ReactKeyboardEvent<HTMLDivElement>)=>{if(e.key==='Escape')setPicked(null);if((e.key==='Delete'||e.key==='Backspace')&&pickedLine?.kind==='link'&&!(e.target as Element).closest('input,select,textarea')){disconnect(pickedLine.provider!,pickedLine.route!.id);setPicked(null);}};

  const outOf=(id:string)=>({x:place[id].x+NODE_W,y:place[id].y+NODE_H/2});
  const inOf=(id:string)=>({x:place[id].x,y:place[id].y+NODE_H/2});
  const pickedNode=picked?.type==='node'?picked.id:'';
  const touches=(l:Line)=>!!pickedNode&&(l.from===pickedNode||l.to===pickedNode);

  const nodeClass=(id:string,extra='')=>{const problem=wire&&wire.from!==id?wireProblem(wire,id):null;const can=problem===null||problem==='Same place'?'':problem?'no-drop':'can-drop';return `map-node ${extra} ${pickedNode===id?'picked':''} ${can}`;};
  const shell=(id:string,label:string,extra:string,inner:ReactNode,opts:{pause?:{paused:boolean;name:string;run:()=>void;title?:string};hasIn?:boolean;inDrag?:string;out?:string|false;outWhy?:string}={})=><div key={id} className={nodeClass(id,extra)} data-node={id} role="group" aria-label={label} style={{transform:`translate(${place[id].x}px,${place[id].y}px)`,width:NODE_W,height:NODE_H}} onPointerDown={e=>startDrag(e,id)}>
    <button type="button" className="map-face" aria-pressed={pickedNode===id} onClick={()=>pickNode(id)} onKeyDown={e=>nodeKeys(e,id)}>{inner}</button>
    {opts.pause&&<button type="button" className="map-pause" aria-label={`${opts.pause.paused?'Resume':'Pause'} ${opts.pause.name}`} title={opts.pause.title||`${opts.pause.paused?'Resume':'Pause'} ${opts.pause.name}`} onClick={opts.pause.run}>{opts.pause.paused?<Play size={14}/>:<Pause size={14}/>}</button>}
    {opts.hasIn&&(opts.inDrag?<span className="map-port in grab" title={opts.inDrag} onPointerDown={e=>startWire(e,id,{reverse:true})}/>:<span className="map-port in" aria-hidden="true"/>)}
    {opts.out!==undefined&&(opts.out===false?<span className="map-port out still" title={opts.outWhy} onPointerDown={e=>{if(opts.outWhy){e.stopPropagation();notice(opts.outWhy,'error');}}}/>:<span className="map-port out" title={opts.out} onPointerDown={e=>startWire(e,id)}/>)}
  </div>;

  const gateName=s.rotate?`Spreading over ${spread.length} exit${spread.length===1?'':'s'}`:shortName(s.routes.find(r=>r.id===s.routeId)?.name||'No exit selected');

  return <>{dialog}<div className={`map-shell ${picked||setup?'with-panel':''}`}>
    <div className={`map-canvas ${wire?'wiring':''}`} ref={canvas} tabIndex={-1} onPointerDown={startPan} onKeyDown={canvasKeys} aria-label="Routing map">
      <div className="map-world" style={{transform:`translate(${view.x}px,${view.y}px) scale(${view.k})`}}>
        <svg className="map-lines" aria-hidden={false} width="1" height="1">
          {lines.map(l=>{if(!place[l.from]||!place[l.to])return null;const a=outOf(l.from),b=inOf(l.to);const d=pathOf(a,b);const on=picked?.id===l.id||touches(l);const badge=l.order?along(a,b,.6):null;const movable=l.kind==='link'||l.kind==='follow'||l.kind==='locked'||(l.kind==='out'&&!s.rotate);const end=along(a,b,.82);return <g key={l.id} className={`map-line ${l.state} ${on?'on':''} ${wire?.replace===l.to&&wire.from===l.from?'moving':''}`}>
            <path className="map-stroke" d={d} style={{strokeWidth:weight(l.requests)+(on?1:0)}}/>
            <path className="map-hit" d={d} role="button" tabIndex={0} aria-label={lineLabel(l)} onClick={()=>setPicked({type:'line',id:l.id})} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setPicked({type:'line',id:l.id});}}}><title>{lineLabel(l)}</title></path>
            {badge&&<g className="map-order" transform={`translate(${badge.x} ${badge.y})`}><circle r="10"/><text textAnchor="middle" dy="4">{l.order}</text></g>}
            {movable&&<g className="map-end" onPointerDown={e=>startWire(e,l.from,{replace:l.to,line:l.id})}><title>Drag to move the end of this line</title><circle className="map-end-grip" cx={end.x} cy={end.y} r="12"/><circle className="map-end-dot" cx={end.x} cy={end.y} r="6"/></g>}
          </g>;})}
          {wire&&<path className="map-wire" d={wire.reverse?pathOf(wire.at,inOf(wire.from)):pathOf(outOf(wire.from),wire.at)}/>}
        </svg>
        <span className="map-col-label" style={{left:COLS.requests}}>Incoming</span><span className="map-col-label" style={{left:COLS.providers}}>Providers</span><span className="map-col-label" style={{left:COLS.gate}}>Shared route</span><span className="map-col-label" style={{left:COLS.routes}}>Exits</span>
        {shell('requests','Incoming requests',s.enabled?'':'is-paused',<><span className="map-kind">Incoming{metrics?` · ${compact(metrics.requests)} in 24 h`:''}</span><strong className="map-name">Requests</strong><span className="map-meta"><b>{data.queue.active}</b> running · <b>{data.queue.waiting}</b> waiting</span></>,{out:false,pause:{paused:!s.enabled,name:'the gateway',run:toggleGateway}})}
        {shell('gate','Route in use','gate',<><span className="map-kind">Route in use</span><strong className="map-name" title={gateName}>{gateName}</strong><span className="map-meta">{standInName?<span className="amber">Requests go to {shortName(standInName)}</span>:followers.length?`${followers.length} provider${followers.length===1?'':'s'} follow${followers.length===1?'s':''} it`:'No provider follows it'}</span></>,{hasIn:true,inDrag:'Drag to a provider to make it follow the route in use',out:s.rotate?false:'Drag to an exit to make it the route in use',outWhy:s.rotate?'Spreading is on, so requests use every exit. Turn spreading off to pick one.':undefined})}
        {s.providers.map(p=>{const c=stateCounts(data.models.filter(m=>m.providerId===p.id));const id=providerNode(p.id);return shell(id,`Provider ${p.name}`,p.enabled?'':'is-paused',<><span className="map-kind">{providerKind(p)}</span><strong className="map-name" title={p.name}>{p.name}</strong><span className="map-meta">{c.available} of {c.total} models · {compact(countFor(p))} in 24 h</span></>,{hasIn:true,out:p.kind==='zai'?'Drag to Direct or a proxy of your own':'Drag to an exit to join them, or to Route in use to follow it',pause:{paused:!p.enabled,name:p.name,run:()=>toggleProvider(p)}});})}
        {s.routes.map(r=>{const info=data.routeInfo?.[r.id];const out=usedUp(r);const id=routeNode(r.id);const chosen=!s.rotate&&s.routeId===r.id;return shell(id,`Exit ${r.name}`,`${r.enabled?'':'is-paused'} ${out?'used':''} ${chosen?'chosen':''}`,<><span className="map-kind">{kindName(r)}{chosen?' · in use':''}</span><strong className="map-name" title={r.name}>{shortName(r.name)}</strong><span className="map-meta">{out?`${compact(routeCount(r))} in 24 h`:<><i className={`map-tone ${info?.tone||'neutral'}`}/>{r.enabled?(info?.label||r.status||'Not tested').slice(0,26):'Paused'} · {compact(routeCount(r))}</>}</span>{out&&<Stamp until={r.exhaustedUntil!} refused={r.status?.startsWith('Refused')}/>}</>,{hasIn:true,inDrag:'Drag to a provider to join them',pause:{paused:!r.enabled,name:r.name,run:()=>toggleRoute(r),title:r.enabled?`Pause ${r.name}`:`Resume ${r.name}`}});})}
        {pickedLine&&place[pickedLine.from]&&place[pickedLine.to]&&pickedLine.kind==='link'&&(()=>{const m=along(outOf(pickedLine.from),inOf(pickedLine.to),.5);const paused=pickedLine.state==='paused';return <div className="map-line-tools" style={{left:m.x,top:m.y,transform:`translate(-50%,-50%) scale(${1/view.k})`}}><button type="button" className="icon-button" aria-label={paused?'Resume this line':'Pause this line'} title={paused?'Resume':'Pause'} onClick={()=>togglePause(pickedLine.provider!,pickedLine.route!.id)}>{paused?<Play size={15}/>:<Pause size={15}/>}</button><button type="button" className="icon-button danger" aria-label="Remove this line" title="Remove" onClick={()=>{disconnect(pickedLine.provider!,pickedLine.route!.id);setPicked(null);}}><X size={15}/></button></div>;})()}
      </div>
      <div className="map-bar"><div className="map-tools"><button type="button" className="icon-button" aria-label="Zoom out" title="Zoom out (Ctrl and scroll)" onClick={()=>zoomBy(.85)}><Minus size={16}/></button><span className="map-zoom">{Math.round(view.k*100)}%</span><button type="button" className="icon-button" aria-label="Zoom in" title="Zoom in (Ctrl and scroll)" onClick={()=>zoomBy(1.18)}><Plus size={16}/></button><button type="button" className="icon-button" aria-label="Fit the map to the window" title="Fit to window" onClick={()=>fit()}><Maximize size={15}/></button><button type="button" className="icon-button" aria-label="Tidy up: put every node back in its column" title="Tidy up: put every node back in its column" onClick={tidy}><Rows3 size={15}/></button></div>
        <div className="map-tools"><Button onClick={()=>{setPicked(null);setSetup(v=>!v||!!picked);}}><ScrollText size={15}/>Your setup</Button><Button onClick={()=>go('Providers')}><Plus size={15}/>Provider</Button><Button variant="primary" onClick={onAddRoute}><Plus size={15}/>Exit</Button></div></div>
      <ul className="map-legend" aria-label="What the lines mean"><li><svg width="26" height="6" aria-hidden="true"><line x1="0" y1="3" x2="26" y2="3" className="live"/></svg>Open, thicker with more traffic</li><li><svg width="26" height="6" aria-hidden="true"><line x1="0" y1="3" x2="26" y2="3" className="standby"/></svg>Backup, waits its turn</li><li><svg width="26" height="6" aria-hidden="true"><line x1="0" y1="3" x2="26" y2="3" className="paused"/></svg>Paused or off</li><li><svg width="26" height="6" aria-hidden="true"><line x1="0" y1="3" x2="26" y2="3" className="blocked"/></svg>Used up or resting</li></ul>
    </div>
    {(picked||setup)&&<aside className="map-panel" aria-label="Details">
      {picked?.type==='line'&&pickedLine?<LinePanel line={pickedLine} s={s} act={act} toggleProvider={toggleProvider} togglePause={togglePause} disconnect={disconnect} follow={follow} moveLine={moveLine} useExit={useExit} connect={connect} pickNode={id=>setPicked({type:'node',id})} onClose={()=>setPicked(null)}/>
      :pickedNode==='requests'?<Section title="Requests" kind="Incoming" onClose={()=>setPicked(null)}><Toggle checked={s.enabled} onChange={toggleGateway} label={s.enabled?'Gateway running':'Gateway paused'} detail="When paused, every client gets a clear error and nothing is sent anywhere."/><p className="map-fact">Each provider's line from here is its on and off switch. Pausing a line pauses that provider.</p><p className="map-fact">What happens when a model fails is set on the Models page. <button type="button" className="text-button" onClick={()=>go('Models')}>Open it</button></p></Section>
      :pickedNode==='gate'?<GatePanel data={data} act={act} followers={followers} useExit={useExit} pickNode={id=>setPicked({type:'node',id})} onClose={()=>setPicked(null)}/>
      :pickedNode.startsWith('p:')&&s.providers.find(p=>providerNode(p.id)===pickedNode)?<ProviderPanel p={s.providers.find(p=>providerNode(p.id)===pickedNode)!} data={data} go={go} count={countFor} toggleProvider={toggleProvider} saveRoutes={saveRoutes} connect={connect} disconnect={disconnect} togglePause={togglePause} move={move} follow={follow} pickNode={id=>setPicked({type:'node',id})} onClose={()=>setPicked(null)}/>
      :pickedNode.startsWith('r:')&&s.routes.find(r=>routeNode(r.id)===pickedNode)?<RoutePanel r={s.routes.find(r=>routeNode(r.id)===pickedNode)!} data={data} pending={pending} go={go} count={routeCount} act={act} toggleRoute={toggleRoute} useExit={useExit} connect={connect} onTest={onTest} onManage={onManage} onDelete={onDelete} onShowList={onShowList} pickNode={id=>setPicked({type:'node',id})} onClose={()=>setPicked(null)}/>
      :<SetupSummary data={data} pickNode={id=>setPicked({type:'node',id})} onClose={()=>setSetup(false)}/>}
    </aside>}
  </div></>;
}

const lineLabel=(l:Line)=>{const end=l.route?shortName(l.route.name):'';const start=l.provider?.name||'';
  return (l.kind==='in'?`Requests to ${start}`:l.kind==='follow'?`${start} follows the route in use`:l.kind==='out'?`Route in use to ${end}`:l.kind==='backup'?`Backup ${l.order}: ${end}`:`${start} to ${end}`)+`. ${l.why}.${l.requests?` ${l.requests.toLocaleString()} requests in 24 hours.`:''}`.replace('..','.');};

function Section({title,kind,onClose,children}:{title:string;kind:string;onClose?:()=>void;children:ReactNode}){
  return <div className="map-section"><header><div><small>{kind}</small><h2 title={title}>{title}</h2></div>{onClose&&<button type="button" className="icon-button" aria-label="Close details" onClick={onClose}><X size={16}/></button>}</header>{children}</div>;
}
function Fact({label,children}:{label:string;children:ReactNode}){return <div><dt>{label}</dt><dd>{children}</dd></div>;}

// Nothing picked: the whole setup in words, one provider a line, and how to use the map.
function SetupSummary({data,pickNode,onClose}:{data:Snapshot;pickNode:(id:string)=>void;onClose:()=>void}){
  const s=data.settings;const current=s.routes.find(r=>r.id===s.routeId);
  return <Section title="Your setup" kind="In words" onClose={onClose}>
    <ul className="map-setup">{s.providers.map(p=><li key={p.id} className={p.enabled?'':'off'}><button type="button" className="text-button" onClick={()=>pickNode(providerNode(p.id))}>{p.name}</button><span>{!p.enabled?'Paused':p.kind==='zai'&&!routesOf(p)?'Direct connection':shortRouteText(p,data)}</span></li>)}</ul>
    <p className="map-fact"><b>Route in use:</b> {s.rotate?'requests take turns over your exits.':current?shortName(current.name)+'.':'none selected.'} <button type="button" className="text-button" onClick={()=>pickNode('gate')}>Change</button></p>
    <h3 className="subhead">Using the map</h3>
    <ul className="map-howto"><li>Drag from a provider's right dot to an exit, or from an exit's left dot to a provider, to join them. The provider then uses only the exits it is joined to.</li><li>Drag the small dot near a line's end to move that end to another exit, or to Route in use to follow the shared route again.</li><li>Click a line to pause or remove it. Click a node for its settings.</li><li>The pause button on a node is the same switch as on the list view.</li></ul>
  </Section>;
}
const shortRouteText=(p:Provider,data:Snapshot)=>{const set=routesOf(p);if(!set)return 'Follows the route in use';const paused=set.paused||[];const active=set.ids.filter(id=>!paused.includes(id));if(!active.length)return 'Every line paused';const first=shortName(data.settings.routes.find(r=>r.id===active[0])?.name||'a deleted exit');return active.length===1?`Only ${first}`:`${active.length} exits, ${set.spread?'taking turns':`${first} first`}`;};

function LinePanel({line:l,s,toggleProvider,togglePause,disconnect,follow,moveLine,useExit,connect,pickNode,onClose}:{line:Line;s:Snapshot['settings'];act:Function;toggleProvider:(p:Provider)=>void;togglePause:(p:Provider,id:string)=>void;disconnect:(p:Provider,id:string)=>void;follow:(p:Provider)=>void;moveLine:(p:Provider,from:string,r:Route)=>void;useExit:(r:Route)=>void;connect:(p:Provider,r:Route)=>void;pickNode:(id:string)=>void;onClose:()=>void}){
  const p=l.provider,r=l.route;const set=p&&routesOf(p);
  const targets=l.kind==='locked'?s.routes.filter(x=>x.id!==r!.id&&!routeRefusal(p!,x)):l.kind==='link'?s.routes.filter(x=>!set?.ids.includes(x.id)&&!routeRefusal(p!,x)):l.kind==='out'&&!s.rotate?s.routes.filter(x=>x.enabled&&x.id!==r!.id):[];
  return <Section title={l.kind==='in'?`Requests to ${p!.name}`:l.kind==='follow'?`${p!.name} to Route in use`:l.kind==='out'?`Route in use to ${shortName(r!.name)}`:l.kind==='backup'?`Backup ${l.order}: ${shortName(r!.name)}`:`${p!.name} to ${shortName(r!.name)}`} kind="Line" onClose={onClose}>
    <dl className="map-facts"><Fact label="Now"><LineBadge state={l.state}/></Fact><Fact label="Why">{l.why}</Fact><Fact label="In 24 h">{l.requests.toLocaleString()} requests</Fact>{l.order&&l.kind!=='backup'&&<Fact label="Order">{l.order} of {set?.ids.filter(id=>!set.paused?.includes(id)).length}</Fact>}</dl>
    {targets.length>0&&<Field label="Move the end to"><Select aria-label="Move the end of this line to another exit" value="" onChange={v=>{const to=s.routes.find(x=>x.id===v);if(!to)return;if(l.kind==='locked')connect(p!,to);else if(l.kind==='link')moveLine(p!,r!.id,to);else useExit(to);onClose();}}><option value="">Choose an exit…</option>{targets.map(x=>{return <option key={x.id} value={x.id}>{shortName(x.name)}{x.enabled?'':' (off)'}</option>;})}</Select></Field>}
    {l.kind==='link'&&<div className="map-actions"><Button onClick={()=>togglePause(p!,r!.id)}>{l.state==='paused'?<Play size={15}/>:<Pause size={15}/>}{l.state==='paused'?'Resume line':'Pause line'}</Button><Button onClick={()=>{disconnect(p!,r!.id);onClose();}}><Unlink size={15}/>Remove line</Button></div>}
    {l.kind==='in'&&<div className="map-actions"><Button onClick={()=>toggleProvider(p!)}>{p!.enabled?<Pause size={15}/>:<Play size={15}/>}{p!.enabled?`Pause ${p!.name}`:`Resume ${p!.name}`}</Button></div>}
    {l.kind==='follow'&&<p className="map-fact">To pin {p!.name} to certain exits, drag from its right dot to an exit. This line then goes away.</p>}
    {l.kind==='out'&&<p className="map-fact">{s.rotate?'Spreading is on, so every exit that is on takes part.':'To change it, drag from the right dot of Route in use to another exit.'}</p>}
    {l.kind==='locked'&&<p className="map-fact">{ZAI_EXITS}</p>}
    {l.kind==='backup'&&<><p className="map-fact">Backups follow "Move on when an exit is used up" and "Move on when an exit can't connect" on the route in use. Providers with their own lines do not use them unless allowed.</p><div className="map-actions"><Button onClick={()=>{useExit(r!);onClose();}}>Make it the route in use</Button><Button onClick={()=>pickNode('gate')}>Routing policy</Button></div></>}
    {l.kind==='link'&&set&&set.ids.length===1&&<div className="map-actions"><Button onClick={()=>{follow(p!);onClose();}}>Follow the route in use instead</Button></div>}
    <div className="map-actions quiet">{p&&<button type="button" className="text-button" onClick={()=>pickNode(providerNode(p.id))}>{p.name} <ChevronRight size={14}/></button>}{r&&<button type="button" className="text-button" onClick={()=>pickNode(routeNode(r.id))}>{shortName(r.name)} <ChevronRight size={14}/></button>}</div>
  </Section>;
}
const LineBadge=({state}:{state:LineState})=><Badge state={state==='live'?'healthy':state==='blocked'?'cooldown':'neutral'}>{state==='live'?'Open':state==='standby'?'Standing by':state==='blocked'?'Waiting':state==='paused'?'Paused':'Off'}</Badge>;

function ProviderPanel({p,data,go,count,toggleProvider,saveRoutes,connect,disconnect,togglePause,move,follow,pickNode,onClose}:{p:Provider;data:Snapshot;go:(page:any)=>void;count:(p:Provider)=>number;toggleProvider:(p:Provider)=>void;saveRoutes:(p:Provider,routes:ProviderRoutes|null,success:string)=>unknown;connect:(p:Provider,r:Route)=>void;disconnect:(p:Provider,id:string)=>void;togglePause:(p:Provider,id:string)=>void;move:(p:Provider,id:string,by:number)=>void;follow:(p:Provider)=>void;pickNode:(id:string)=>void;onClose:()=>void}){
  const routes=data.settings.routes;const set=routesOf(p);const c=stateCounts(data.models.filter(m=>m.providerId===p.id));
  const open=routes.filter(r=>!set?.ids.includes(r.id)&&!routeRefusal(p,r));
  const models=()=>{try{localStorage.setItem('polygate-models-provider',p.id);}catch{/* storage can be disabled */}go('Models');};
  return <Section title={p.name} kind={providerKind(p)} onClose={onClose}>
    <Toggle checked={p.enabled} onChange={()=>toggleProvider(p)} label={p.enabled?'Running':'Paused'} detail="The same switch as on the Providers page." name={p.name}/>
    <dl className="map-facts"><Fact label="Models"><button type="button" className="text-button" onClick={models}>{c.available} of {c.total} available <ChevronRight size={14}/></button></Fact><Fact label="In 24 h">{count(p).toLocaleString()} requests</Fact></dl>
    {p.kind==='zai'?<><Field label="Exit"><Select aria-label="Exit for Z.ai" value={set?.ids[0]||'direct'} onChange={v=>{const r=routes.find(x=>x.id===v);if(r)connect(p,r);}}>{routes.filter(r=>!routeRefusal(p,r)).map(r=><option key={r.id} value={r.id}>{shortName(r.name)}{r.enabled?'':' (off)'}</option>)}</Select></Field><p className="map-fact">{ZAI_EXITS}</p></>:<>
      <h3 className="subhead">Lines</h3>
      {set?<ol className="map-links">{set.ids.map((id,i)=>{const r=routes.find(x=>x.id===id);if(!r)return null;const paused=!!set.paused?.includes(id);const st=linkState(p,r,paused);return <li key={id} className={st.state}>
        <span className="map-link-n">{set.spread?'':i+1}</span>
        <button type="button" className="text-button map-link-name" title={r.name} onClick={()=>pickNode(routeNode(id))}>{shortName(r.name)}<small>{st.why}</small></button>
        <span className="map-link-actions">{!set.spread&&set.ids.length>1&&<><button type="button" className="icon-button" aria-label={`Move ${r.name} up`} disabled={i===0} onClick={()=>move(p,id,-1)}><ArrowUp size={14}/></button><button type="button" className="icon-button" aria-label={`Move ${r.name} down`} disabled={i===set.ids.length-1} onClick={()=>move(p,id,1)}><ArrowDown size={14}/></button></>}
        <button type="button" className="icon-button" aria-label={`${paused?'Resume':'Pause'} line to ${r.name}`} title={paused?'Resume':'Pause'} onClick={()=>togglePause(p,id)}>{paused?<Play size={14}/>:<Pause size={14}/>}</button>
        <button type="button" className="icon-button danger" aria-label={`Remove line to ${r.name}`} title="Remove" onClick={()=>disconnect(p,id)}><X size={14}/></button></span>
      </li>;})}</ol>:<p className="map-fact">Follows the route in use, with its spreading and failover. <button type="button" className="text-button" onClick={()=>pickNode('gate')}>See it</button></p>}
      {open.length>0&&<Field label="Join an exit"><Select aria-label={`Join ${p.name} to an exit`} value="" onChange={v=>{const r=routes.find(x=>x.id===v);if(r)connect(p,r);}}><option value="">Choose an exit…</option>{open.map(r=><option key={r.id} value={r.id}>{shortName(r.name)}{r.enabled?'':' (off)'}</option>)}</Select></Field>}
      {set&&set.ids.length>1&&<Toggle checked={!!set.spread} onChange={spread=>saveRoutes(p,{...set,spread},spread?'Requests take turns over its exits':'Exits are used in order')} label="Take turns over its exits" detail="Off: the first one, and the next only when a connection fails."/>}
      {set&&(p.kind==='free'||p.kind==='kilo')&&<Toggle checked={!!set.backups} onChange={backups=>saveRoutes(p,{...set,backups},backups?'Backup exits allowed':'Backup exits not used')} label="Use backup exits when these are used up" detail="OpenCode Free and Kilo. Off: a used-up exit here fails the request. The backup exits are the ones under Route in use."/>}
      {set&&<div className="map-actions"><Button onClick={()=>follow(p)}><Unlink size={15}/>Follow the route in use</Button></div>}
    </>}
    <p className="map-sentence">Route: {providerRouteText(p,data)}</p>
  </Section>;
}

function RoutePanel({r,data,pending,go,count,toggleRoute,useExit,connect,act,onTest,onManage,onDelete,onShowList,pickNode,onClose}:{r:Route;data:Snapshot;pending:string;go:(page:any)=>void;count:(r:Route)=>number;toggleRoute:(r:Route)=>void;useExit:(r:Route)=>void;connect:(p:Provider,r:Route)=>void;act:Function;onTest:(r:Route)=>void;onManage:(r:Route,mode:'update'|'remove')=>void;onDelete:(r:Route)=>void;onShowList:()=>void;pickNode:(id:string)=>void;onClose:()=>void}){
  const s=data.settings;const info=data.routeInfo?.[r.id];const chosen=s.routeId===r.id;const out=usedUp(r);const uses=usedByText(r,data);
  const open=s.providers.filter(p=>!routesOf(p)?.ids.includes(r.id)&&!routeRefusal(p,r)&&!(p.kind==='zai'&&!routesOf(p)&&r.id==='direct'));
  return <Section title={shortName(r.name)} kind={kindName(r)} onClose={onClose}>
    <Toggle checked={r.enabled} onChange={()=>toggleRoute(r)} label={r.enabled?'Running':'Paused'} detail={r.id==='direct'?'Off means requests never leave from your own address. Needs another exit to be on.':'The same switch as Disable on the list view.'} name={r.name}/>
    <dl className="map-facts"><Fact label="Now"><Badge state={info?.tone||'neutral'}>{info?.label||r.status||'Not tested'}</Badge></Fact>{info?.detail&&<Fact label="Detail">{info.detail}</Fact>}{r.latency?<Fact label="Last answer">{ms(r.latency)}</Fact>:null}<Fact label="In 24 h">{count(r).toLocaleString()} requests</Fact><Fact label="Used by">{uses?uses.replace(/^Used by /,''):'No provider'}</Fact></dl>
    <div className="map-actions">
      {chosen?<span className="in-use"><Check size={14}/>In use</span>:<Button disabled={!!pending} onClick={()=>useExit(r)}>Use this exit</Button>}
      <Button disabled={!!pending} onClick={()=>onTest(r)}><FlaskConical size={14}/>Test</Button>
      {resting(r)&&<Button disabled={!!pending} onClick={()=>act('resume:'+r.id,'/admin/routes/resume',{id:r.id},'Route resumed')}><Play size={14}/>Resume now</Button>}
      {platformOf(r)&&<Button disabled={!!pending} title="Deploy the current relay code to this relay again; its address and access token stay the same" onClick={()=>onManage(r,'update')}><CloudUpload size={14}/>Update</Button>}
      {r.id!=='direct'&&r.id!=='warp'&&<Button onClick={()=>onDelete(r)}><Trash2 size={14}/>Delete</Button>}
    </div>
    {out&&<p className="map-fact">Used up until {time(r.exhaustedUntil!)}. This applies to OpenCode Free only; other providers can still use it.</p>}
    {open.length>0&&<Field label="Join a provider"><Select aria-label={`Join a provider to ${r.name}`} value="" onChange={v=>{const p=s.providers.find(x=>x.id===v);if(p)connect(p,r);}}><option value="">Choose a provider…</option>{open.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>}
    {r.kind==='warp'&&<p className="map-fact">WARP connects and disconnects from the list view. <button type="button" className="text-button" onClick={onShowList}>Open it</button></p>}
    {r.id==='proxy-pool'&&<p className="map-fact">Its proxies are managed on the Proxies page. <button type="button" className="text-button" onClick={()=>go('Proxies')}>Open it</button></p>}
    <div className="map-actions quiet"><button type="button" className="text-button" onClick={()=>pickNode('gate')}>Route in use <ChevronRight size={14}/></button></div>
  </Section>;
}

function GatePanel({data,act,followers,useExit,pickNode,onClose}:{data:Snapshot;act:Function;followers:Provider[];useExit:(r:Route)=>void;pickNode:(id:string)=>void;onClose:()=>void}){
  const s=data.settings;
  return <Section title="Route in use" kind="Shared by the providers that follow it" onClose={onClose}>
    {!s.rotate&&<Field label="Exit in use"><Select aria-label="Exit in use" value={s.routeId} onChange={v=>{const r=s.routes.find(x=>x.id===v);if(r)useExit(r);}}>{s.routes.filter(r=>r.enabled||r.id===s.routeId).map(r=><option key={r.id} value={r.id}>{shortName(r.name)}</option>)}</Select></Field>}
    <p className="map-fact">{followers.length?<>Followed by {followers.map((p,i)=><span key={p.id}>{i>0&&', '}<button type="button" className="text-button" onClick={()=>pickNode(providerNode(p.id))}>{p.name}</button></span>)}.</>:'No provider follows it right now.'}</p>
    <ExitPolicy data={data} act={act} compact/>
  </Section>;
}
