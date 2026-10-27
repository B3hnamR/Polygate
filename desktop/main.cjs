const {app,BrowserWindow,dialog,shell,Menu,ipcMain,net}=require('electron');
const {createPortableUpdater,portableTarget}=require('./updater.cjs');
const {spawn,spawnSync}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const {randomBytes}=require('node:crypto');
// The window and taskbar icon: the packaged app ships it in resources, a source checkout reads it from assets.
const iconPath=app.isPackaged?path.join(process.resourcesPath,'icon.png'):path.join(__dirname,'..','assets','icon.png');
let child,win,port,quitting=false,reaped=false;const token=randomBytes(32).toString('hex');
const killTree=()=>{
  if(reaped||!child||child.exitCode!==null||child.signalCode)return;reaped=true;
  if(process.platform==='win32'&&child.pid){const r=spawnSync(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/pid',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:5000});if(r.error||r.status)child.kill();}
  else child.kill();
};
if(!app.requestSingleInstanceLock())app.quit();
else{
app.on('second-instance',()=>{if(win&&!win.isDestroyed()){if(win.isMinimized())win.restore();win.show();win.focus();}});
app.whenReady().then(async()=>{
  if(process.env.POLYGATE_USER_DATA)app.setPath('userData',process.env.POLYGATE_USER_DATA);
  Menu.setApplicationMenu(null);app.setAppUserModelId('dev.polygate.desktop');
  const root=app.isPackaged?process.resourcesPath:path.resolve(__dirname,'..');
  const exe=app.isPackaged?path.join(root,'bin','bun.exe'):(process.env.BUN_EXE||path.join(process.env.USERPROFILE,'.bun','bin','bun.exe'));
  const entry=app.isPackaged?path.join(root,'gateway.js'):path.join(root,'backend','main.ts');
  const logDir=app.getPath('userData');fs.mkdirSync(logDir,{recursive:true});const log=fs.openSync(path.join(logDir,'gateway.log'),'a');
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^POLYGATE_(HOST|ALLOWED_HOSTS|TRUST_PROXY|COOKIE_SECURE|DEV|ADMIN_PASSWORD|PUBLIC_IP|ACME_INSECURE|ACME_DIRECTORY)$/i.test(k)));
  child=spawn(exe,[entry],{cwd:root,windowsHide:true,env:{...env,POLYGATE_DESKTOP:'1',POLYGATE_HOST:'127.0.0.1',POLYGATE_PORT:'0',POLYGATE_ADMIN_TOKEN:token,POLYGATE_STATE:path.join(logDir,'state'),POLYGATE_UI_DIST:app.isPackaged?path.join(root,'ui'):path.join(root,'dist')},stdio:['ignore','pipe',log]});
  try{
    port=await new Promise((resolve,reject)=>{let buffer='';const timeout=setTimeout(()=>reject(new Error('Gateway startup timed out. See gateway.log in '+logDir)),25000);child.once('error',e=>{clearTimeout(timeout);reject(e);});child.stdout.on('data',chunk=>{fs.writeSync(log,chunk);buffer+=chunk.toString();let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const x=JSON.parse(line);if(x.polygateReady){clearTimeout(timeout);resolve(x.port);}}catch{}}});child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Gateway exited before startup (code '+code+'). See '+logDir));});});
    win=new BrowserWindow({width:1430,height:970,minWidth:880,minHeight:650,title:'Polygate',icon:iconPath,backgroundColor:'#14171c',show:false,autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
    const resultPath=path.join(logDir,'update-result.json');
    const updater=createPortableUpdater({version:app.getVersion(),target:portableTarget(process.env.PORTABLE_EXECUTABLE_FILE,app.isPackaged),tempDir:app.getPath('temp'),resultPath,fetcher:(...args)=>net.fetch(...args),onState:state=>{if(win&&!win.isDestroyed())win.webContents.send('polygate:updates:changed',state);},onReady:()=>setTimeout(()=>app.quit(),500)});
    // IPC is available only to this window's own top-level dashboard, never another frame or remote page.
    const updateAction=fn=>async event=>{if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||new URL(event.senderFrame.url).origin!==`http://127.0.0.1:${port}`)throw new Error('Update action is not allowed from this page');return fn();};
    ipcMain.handle('polygate:updates:state',updateAction(()=>updater.getState()));
    ipcMain.handle('polygate:updates:check',updateAction(()=>updater.check(true)));
    ipcMain.handle('polygate:updates:install',updateAction(()=>updater.install()));
    win.webContents.setWindowOpenHandler(({url})=>{if(/^https:\/\//.test(url))shell.openExternal(url);return {action:'deny'};});
    const ses=win.webContents.session,ok=p=>p==='clipboard-sanitized-write';ses.setPermissionRequestHandler((_,p,cb)=>cb(ok(p)));ses.setPermissionCheckHandler((_,p)=>ok(p));
    const pin=e=>{let o;try{o=new URL(e.url).origin;}catch{}if(o!==`http://127.0.0.1:${port}`)e.preventDefault();};
    win.webContents.on('will-navigate',pin);win.webContents.on('will-redirect',pin);
    const home=`http://127.0.0.1:${port}/#token=${token}`;let gone=0;
    win.webContents.on('render-process-gone',(_,d)=>{fs.writeSync(log,`[desktop] renderer gone: ${d.reason} (${d.exitCode})\n`);if(quitting||d.reason==='clean-exit')return;if(gone++){dialog.showErrorBox('Polygate window crashed',`The window crashed twice. Reopen Polygate. Details are in ${path.join(logDir,'gateway.log')}.`);app.quit();}else win.loadURL(home);});
    await win.loadURL(home);if(process.env.POLYGATE_DESKTOP_SMOKE!=='1')win.show();
    if(fs.existsSync(resultPath)){try{const result=JSON.parse(fs.readFileSync(resultPath,'utf8'));fs.unlinkSync(resultPath);if(!result.ok)dialog.showErrorBox('Update could not finish',String(result.error||'Your previous app was kept. Download the latest release to try again.'));}catch{/* An interrupted result file must not prevent startup. */}}
    if(process.env.POLYGATE_DESKTOP_SMOKE==='1'){
      // The dashboard exchanges the launch token for a session cookie and then forgets it; the smoke check uses that cookie, like the UI.
      const authenticated=await win.webContents.executeJavaScript(`(async()=>{for(let i=0;i<50;i++){const w=await fetch('/admin/whoami').then(r=>r.json());if(w.authenticated)return (await fetch('/admin/state')).ok;await new Promise(r=>setTimeout(r,100));}return false;})()`);
      const identity=await win.webContents.executeJavaScript(`fetch('/admin/whoami').then(r=>r.json())`);
      const updateState=await win.webContents.executeJavaScript(`window.polygateUpdates.getState()`);
      fs.writeFileSync(path.join(logDir,'desktop-smoke.json'),JSON.stringify({ok:authenticated&&identity.authenticated&&identity.mode==='desktop'&&updateState.kind==='windows',mode:identity.mode,title:win.getTitle(),url:new URL(win.webContents.getURL()).pathname,updates:{bridge:true,kind:updateState.kind,canInstall:updateState.canInstall,currentVersion:updateState.currentVersion}}));setTimeout(()=>app.quit(),1000);
    }
    child.on('exit',code=>{if(!quitting){dialog.showErrorBox('Polygate gateway stopped',`The gateway exited (${code}). Reopen Polygate. Details are in ${path.join(logDir,'gateway.log')}.`);app.quit();}});
  }catch(e){dialog.showErrorBox('Could not start Polygate',String(e.message||e));app.quit();}
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{
  if(quitting||!child)return;event.preventDefault();quitting=true;
  const force=setTimeout(()=>{killTree();app.exit(0);},12000);
  (async()=>{try{if(!port){killTree();return;}await fetch(`http://127.0.0.1:${port}/admin/shutdown`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{}'});if(child.exitCode===null&&!child.signalCode)await new Promise(r=>{child.once('exit',r);setTimeout(r,10000);});}catch{}finally{clearTimeout(force);killTree();app.exit(0);}})();
});
}
