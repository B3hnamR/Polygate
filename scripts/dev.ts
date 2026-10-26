import {spawn} from 'node:child_process';
const token='polygate-development-only';
const children=[spawn('bun',['backend/main.ts'],{stdio:'inherit',windowsHide:true,env:{...process.env,POLYGATE_DEV:'1',POLYGATE_ADMIN_TOKEN:token,POLYGATE_STATE:process.cwd()+'/.state'}}),spawn(process.execPath.includes('bun')?'bun':'node',['node_modules/vite/bin/vite.js'],{stdio:'inherit',windowsHide:true})];
console.log('Development UI: http://127.0.0.1:5173/#token='+token);
process.on('SIGINT',()=>{for(const c of children)c.kill();process.exit(0);});
