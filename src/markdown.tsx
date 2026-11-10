import {Fragment,useEffect,useState,type ReactNode} from 'react';
import {Check,Copy,FileText} from 'lucide-react';
// A small Markdown reader for replies, including tables, links and quotes. It builds React
// elements, never HTML, so nothing in a reply can add markup or scripts to the page. Anything it does not know stays as plain text.
const LIST=/^\s*([-*+]|\d+[.)])\s+/;const FENCE=/^\s*```/;const HEADING=/^(#{1,6})\s+(.*)$/;
const cells=(line:string)=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split(/(?<!\\)\|/).map(c=>c.trim().replace(/\\\|/g,'|'));
const tableRule=(line:string)=>line.includes('|')&&cells(line).every(c=>/^:?-+:?$/.test(c));
export function Markdown({text}:{text:string}){
  const lines=text.replace(/\r/g,'').replace(/(\[[^\]\n]+\])\s*\n\s*(\(file:\/\/\/)/gi,'$1$2').split('\n');const out:ReactNode[]=[];let i=0;
  while(i<lines.length){
    const line=lines[i];
    if(line.includes('|')&&i+1<lines.length&&tableRule(lines[i+1])){
      const headers=cells(line),align=cells(lines[i+1]).map(c=>c.startsWith(':')&&c.endsWith(':')?'center':c.endsWith(':')?'right':'start');const rows:string[][]=[];i+=2;
      while(i<lines.length&&lines[i].trim()&&lines[i].includes('|'))rows.push(cells(lines[i++]));
      out.push(<div className="md-table-wrap" key={out.length} tabIndex={0} role="region" aria-label="Message table"><table><thead><tr>{headers.map((c,k)=><th dir="auto" key={k} style={{textAlign:align[k] as any}}>{inline(c)}</th>)}</tr></thead><tbody>{rows.map((r,n)=><tr key={n}>{headers.map((_,k)=><td dir="auto" key={k} style={{textAlign:align[k] as any}}>{inline(r[k]||'')}</td>)}</tr>)}</tbody></table></div>);continue;
    }
    if(/^\s*>/.test(line)){const quote:string[]=[];while(i<lines.length&&/^\s*>/.test(lines[i]))quote.push(lines[i++].replace(/^\s*>\s?/,''));out.push(<blockquote dir="auto" key={out.length}><Markdown text={quote.join('\n')}/></blockquote>);continue;}
    if(FENCE.test(line)){const body:string[]=[];const language=line.replace(FENCE,'').trim();i++;while(i<lines.length&&!FENCE.test(lines[i]))body.push(lines[i++]);i++;out.push(<CodeBlock key={out.length} text={body.join('\n')} language={language}/>);continue;}
    const h=line.match(HEADING);
    if(h){out.push(<p dir="auto" key={out.length} className={`md-h md-h${Math.min(h[1].length,3)}`}>{inline(h[2])}</p>);i++;continue;}
    if(LIST.test(line)){
      const ordered=/^\s*\d/.test(line);const entries:string[]=[];
      while(i<lines.length&&LIST.test(lines[i])){entries.push(lines[i].replace(LIST,''));i++;while(i<lines.length&&/^\s{2,}\S/.test(lines[i])&&!LIST.test(lines[i]))entries[entries.length-1]+=' '+lines[i++].trim();}
      const items=entries.map((t,k)=><li dir="auto" key={k}>{inline(t)}</li>);
      out.push(ordered?<ol dir="auto" key={out.length}>{items}</ol>:<ul dir="auto" key={out.length}>{items}</ul>);continue;
    }
    if(!line.trim()){i++;continue;}
    const para:string[]=[];
    while(i<lines.length&&lines[i].trim()&&!FENCE.test(lines[i])&&!HEADING.test(lines[i])&&!LIST.test(lines[i])&&!/^\s*>/.test(lines[i])&&!(lines[i].includes('|')&&i+1<lines.length&&tableRule(lines[i+1])))para.push(lines[i++]);
    out.push(<p dir="auto" key={out.length}>{para.map((t,k)=><Fragment key={k}>{k>0&&<br/>}{inline(t)}</Fragment>)}</p>);
  }
  return <div className="md">{out}</div>;
}
function CodeBlock({text,language}:{text:string;language:string}){
  const [state,setState]=useState<'idle'|'copied'|'error'>('idle');
  useEffect(()=>{if(state==='idle')return;const timer=setTimeout(()=>setState('idle'),2500);return()=>clearTimeout(timer);},[state]);
  const copy=async()=>{try{await navigator.clipboard.writeText(text);setState('copied');}catch{setState('error');}};
  return <div className="md-code-block"><div className="md-code-head"><span>{language||'Text'}</span><button type="button" aria-label={state==='copied'?'Code copied':'Copy code'} title="Copy code" onClick={copy}>{state==='copied'?<Check size={14}/>:<Copy size={14}/>}<span>{state==='copied'?'Copied':'Copy'}</span></button></div>
    <pre dir="ltr" className="md-code"><code>{text}</code></pre>{state==='error'&&<p className="red md-copy-error" role="status">Clipboard unavailable. Select and copy the text.</p>}<span className="md-copy-status" role="status">{state==='copied'?'Code copied':''}</span>
  </div>;
}
// `code`, **bold**, *italic* and _italic_ (not inside a word, so snake_case names stay as they are).
function inline(text:string):ReactNode[]{
  const out:ReactNode[]=[];const re=/(?<!!)\[[^\]\n]+\]\(file:\/\/\/[^\s<>]+\)|`[^`]+`|(?<!!)\[[^\]\n]+\]\(https?:\/\/[^\s<>]+\)|\*\*[^*]+\*\*|(?<![\w*])\*[^*\s][^*]*\*(?![\w*])|(?<!\w)_[^_\s][^_]*_(?!\w)/g;let last=0;let m:RegExpExecArray|null;
  while((m=re.exec(text))){
    if(m.index>last)out.push(text.slice(last,m.index));
    const s=m[0];const local=s.match(/^\[([^\]]+)\]\((file:\/\/\/[^\s<>]+)\)$/i);
    if(local){try{const url=new URL(local[2]);if(url.hostname||url.username||url.password)throw Error('Remote file');const p=decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i,'$1');if(/[\x00-\x1f]/.test(p))throw Error('Invalid path');out.push(<LocalFile key={m.index} label={local[1].replace(/^`|`$/g,'')} path={p}/>);last=m.index+s.length;continue;}catch{/* invalid file references remain text */}}
    const link=s.match(/^\[([^\]]+)\]\((https?:\/\/[^\s<>]+)\)$/);let safe=false;if(link)try{const u=new URL(link[2]);safe=['http:','https:'].includes(u.protocol)&&!u.username&&!u.password;}catch{/* show invalid links as text */}
    if(local){out.push(s);last=m.index+s.length;continue;}
    out.push(link?safe?<a href={link[2]} target="_blank" rel="noopener noreferrer" key={m.index}>{inline(link[1])}</a>:s:s[0]==='`'?<code dir="ltr" key={m.index}>{s.slice(1,-1)}</code>:s.startsWith('**')?<strong key={m.index}>{inline(s.slice(2,-2))}</strong>:<em key={m.index}>{inline(s.slice(1,-1))}</em>);
    last=m.index+s.length;
  }
  if(last<text.length)out.push(text.slice(last));
  return out;
}
function LocalFile({label,path}:{label:string;path:string}){
  const [status,setStatus]=useState('');useEffect(()=>{if(!status)return;const t=setTimeout(()=>setStatus(''),2500);return()=>clearTimeout(t);},[status]);
  return <span className="md-local-file" title={path}><FileText size={13}/><span dir="auto">{label}</span><button type="button" aria-label={`Copy path for ${label}`} title="Copy file path" onClick={async()=>{try{await navigator.clipboard.writeText(path);setStatus('Copied');}catch{setStatus('Copy unavailable');}}}>{status||<Copy size={13}/>}</button><span className="md-copy-status" role="status">{status}</span></span>;
}
