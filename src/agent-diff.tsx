export function AgentDiff({patch}:{patch:string}){
  let old=0,next=0;
  const lines=patch.replace(/\r/g,'').split('\n').filter(l=>{
    const hunk=l.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if(hunk){old=Number(hunk[1]??1);next=Number(hunk[2]??1);return true;}
    if(old>0||next>0){if(l.startsWith('-'))old--;else if(l.startsWith('+'))next--;else if(l.startsWith(' ')){old--;next--;}return true;}
    return !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(l);
  });
  return <pre className="agent-diff">{lines.map((l,i)=><span key={i} className={l.startsWith('+')?'add':l.startsWith('-')?'del':l.startsWith('@@')?'hunk':''}>{l||' '}{'\n'}</span>)}</pre>;
}
