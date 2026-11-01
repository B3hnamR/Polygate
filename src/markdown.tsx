import {Fragment,type ReactNode} from 'react';
// A small Markdown reader for the agent's replies: paragraphs, headings, lists, fenced code, inline code, bold and italics. It builds React
// elements, never HTML, so nothing in a reply can add markup or scripts to the page. Anything it does not know stays as plain text.
const LIST=/^\s*([-*+]|\d+[.)])\s+/;const FENCE=/^\s*```/;const HEADING=/^(#{1,6})\s+(.*)$/;
export function Markdown({text}:{text:string}){
  const lines=text.replace(/\r/g,'').split('\n');const out:ReactNode[]=[];let i=0;
  while(i<lines.length){
    const line=lines[i];
    if(FENCE.test(line)){const body:string[]=[];i++;while(i<lines.length&&!FENCE.test(lines[i]))body.push(lines[i++]);i++;out.push(<pre key={out.length} className="md-code"><code>{body.join('\n')}</code></pre>);continue;}
    const h=line.match(HEADING);
    if(h){out.push(<p key={out.length} className={`md-h md-h${Math.min(h[1].length,3)}`}>{inline(h[2])}</p>);i++;continue;}
    if(LIST.test(line)){
      const ordered=/^\s*\d/.test(line);const entries:string[]=[];
      while(i<lines.length&&LIST.test(lines[i])){entries.push(lines[i].replace(LIST,''));i++;while(i<lines.length&&/^\s{2,}\S/.test(lines[i])&&!LIST.test(lines[i]))entries[entries.length-1]+=' '+lines[i++].trim();}
      const items=entries.map((t,k)=><li key={k}>{inline(t)}</li>);
      out.push(ordered?<ol key={out.length}>{items}</ol>:<ul key={out.length}>{items}</ul>);continue;
    }
    if(!line.trim()){i++;continue;}
    const para:string[]=[];
    while(i<lines.length&&lines[i].trim()&&!FENCE.test(lines[i])&&!HEADING.test(lines[i])&&!LIST.test(lines[i]))para.push(lines[i++]);
    out.push(<p key={out.length}>{para.map((t,k)=><Fragment key={k}>{k>0&&<br/>}{inline(t)}</Fragment>)}</p>);
  }
  return <div className="md">{out}</div>;
}
// `code`, **bold**, *italic* and _italic_ (not inside a word, so snake_case names stay as they are).
function inline(text:string):ReactNode[]{
  const out:ReactNode[]=[];const re=/`[^`]+`|\*\*[^*]+\*\*|(?<![\w*])\*[^*\s][^*]*\*(?![\w*])|(?<!\w)_[^_\s][^_]*_(?!\w)/g;let last=0;let m:RegExpExecArray|null;
  while((m=re.exec(text))){
    if(m.index>last)out.push(text.slice(last,m.index));
    const s=m[0];out.push(s[0]==='`'?<code key={m.index}>{s.slice(1,-1)}</code>:s.startsWith('**')?<strong key={m.index}>{s.slice(2,-2)}</strong>:<em key={m.index}>{s.slice(1,-1)}</em>);
    last=m.index+s.length;
  }
  if(last<text.length)out.push(text.slice(last));
  return out;
}
