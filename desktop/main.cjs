const {app,BrowserWindow,dialog,shell,Menu,Tray,nativeImage,ipcMain,net,screen}=require('electron');
const {createPortableUpdater,portableTarget}=require('./updater.cjs');
const {COMPACT,FULL_MIN,placeCompact,placeFull,defaultFull}=require('./window-mode.cjs');
const {spawn,spawnSync}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const {randomBytes}=require('node:crypto');
// The window and taskbar icon: the packaged app ships it in resources, a source checkout reads it from assets.
const iconPath=app.isPackaged?path.join(process.resourcesPath,'icon.png'):path.join(__dirname,'..','assets','icon.png');
// The tray takes the .ico on Windows, which holds sharp small sizes.
const trayIconPath=process.platform!=='win32'?iconPath:app.isPackaged?path.join(process.resourcesPath,'icon.ico'):path.join(__dirname,'..','assets','icon.ico');
// The documented gateway port; a desktop launch falls back to a free one when another program already holds it.
const DEFAULT_PORT=4317;
let child,win,tray,port,quitting=false,reaped=false;const token=randomBytes(32).toString('hex');
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
  const logDir=app.getPath('userData');fs.mkdirSync(logDir,{recursive:true});const logFile=path.join(logDir,'gateway.log');
  // The gateway's output is appended for as long as the app is installed; past 5 MB the old part is set aside (one previous file is kept).
  try{if(fs.statSync(logFile).size>5*1024*1024)fs.renameSync(logFile,logFile+'.1');}catch{/* no log yet, or it is in use: keep appending */}
  const log=fs.openSync(logFile,'a');
  // Desktop preferences: the API port (clients are set up with it, so it must not change between launches) and what closing the window does.
  const prefsFile=path.join(logDir,'desktop.json');let prefs={};
  try{const saved=JSON.parse(fs.readFileSync(prefsFile,'utf8'));if(saved&&typeof saved==='object')prefs=saved;}catch{/* first launch or an unreadable file: use the defaults */}
  const savePrefs=next=>{prefs={...prefs,...next};try{fs.writeFileSync(prefsFile,JSON.stringify(prefs));}catch(e){fs.writeSync(log,`[desktop] could not save preferences: ${e.message}\n`);}};
  const savedPort=Number(prefs.port);const preferred=Number.isInteger(savedPort)&&savedPort>=1024&&savedPort<=65535?savedPort:DEFAULT_PORT;
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^POLYGATE_(HOST|ALLOWED_HOSTS|TRUST_PROXY|COOKIE_SECURE|DEV|ADMIN_PASSWORD|PUBLIC_IP|ACME_INSECURE|ACME_DIRECTORY)$/i.test(k)));
  child=spawn(exe,[entry],{cwd:root,windowsHide:true,env:{...env,POLYGATE_DESKTOP:'1',POLYGATE_HOST:'127.0.0.1',POLYGATE_PORT:String(preferred),POLYGATE_ADMIN_TOKEN:token,POLYGATE_STATE:path.join(logDir,'state'),POLYGATE_UI_DIST:app.isPackaged?path.join(root,'ui'):path.join(root,'dist')},stdio:['ignore','pipe',log]});
  try{
    port=await new Promise((resolve,reject)=>{let buffer='';const timeout=setTimeout(()=>reject(new Error('Gateway startup timed out. See gateway.log in '+logDir)),25000);child.once('error',e=>{clearTimeout(timeout);reject(e);});child.stdout.on('data',chunk=>{fs.writeSync(log,chunk);buffer+=chunk.toString();let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const x=JSON.parse(line);if(x.polygateReady){clearTimeout(timeout);resolve(x.port);}}catch{}}});child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Gateway exited before startup (code '+code+'). See '+logDir));});});
    // When the saved port was taken, the gateway picked another; that one is kept from now on.
    savePrefs({port});
    const first=defaultFull(screen.getPrimaryDisplay().workArea);
    win=new BrowserWindow({x:first.x,y:first.y,width:first.width,height:first.height,minWidth:Math.min(FULL_MIN.width,first.width),minHeight:Math.min(FULL_MIN.height,first.height),title:'Polygate',icon:iconPath,backgroundColor:'#14171c',show:false,autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
    const resultPath=path.join(logDir,'update-result.json');
    const updater=createPortableUpdater({version:app.getVersion(),target:portableTarget(process.env.PORTABLE_EXECUTABLE_FILE,app.isPackaged),tempDir:app.getPath('temp'),resultPath,fetcher:(...args)=>net.fetch(...args),onState:state=>{if(win&&!win.isDestroyed())win.webContents.send('polygate:updates:changed',state);},onReady:()=>setTimeout(()=>app.quit(),500)});
    // IPC is available only to this window's own top-level dashboard, never another frame or remote page.
    const fromDashboard=fn=>async(event,...args)=>{if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||new URL(event.senderFrame.url).origin!==`http://127.0.0.1:${port}`)throw new Error('This action is not allowed from this page');return fn(...args);};
    ipcMain.handle('polygate:updates:state',fromDashboard(()=>updater.getState()));
    ipcMain.handle('polygate:updates:check',fromDashboard(()=>updater.check(true)));
    ipcMain.handle('polygate:updates:install',fromDashboard(()=>updater.install()));
    const desktopPrefs=()=>({closeToTray:prefs.closeToTray!==false});
    ipcMain.handle('polygate:desktop:prefs',fromDashboard(desktopPrefs));
    ipcMain.handle('polygate:desktop:close-to-tray',fromDashboard(value=>{if(typeof value!=='boolean')throw new Error('Expected true or false');savePrefs({closeToTray:value});return desktopPrefs();}));
    // Closing the window keeps the gateway serving clients from the tray, unless that is turned off in Settings; the tray's Exit stops it.
    const showWindow=()=>{if(win.isDestroyed())return;if(win.isMinimized())win.restore();win.show();win.focus();};
    // Compact view: a small portrait window to keep beside other work. It remembers where it was, and where the full window was.
    let compact=prefs.compact===true,pinned=prefs.pinned!==false;
    const viewState=()=>({compact,pinned});
    const areas=()=>screen.getAllDisplays().map(d=>d.workArea);
    const sendView=()=>{if(!win.isDestroyed())win.webContents.send('polygate:desktop:view',viewState());};
    const refreshTray=()=>{if(tray&&!tray.isDestroyed())tray.setContextMenu(Menu.buildFromTemplate([{label:'Open Polygate',click:showWindow},{label:'Compact view',type:'checkbox',checked:compact,click:()=>{setCompact(!compact);showWindow();}},{type:'separator'},{label:'Exit',click:()=>app.quit()}]));};
    // Where the window is now is remembered for the view it is in; a maximized full window is remembered as maximized, with its normal size.
    const rememberBounds=()=>{if(win.isDestroyed()||win.isMinimized()||!win.isVisible())return;if(compact)savePrefs({compactBounds:win.getBounds()});else if(!win.isFullScreen())savePrefs({fullMaximized:win.isMaximized(),fullBounds:win.getNormalBounds()});};
    let remember;const rememberSoon=()=>{clearTimeout(remember);remember=setTimeout(rememberBounds,600);};
    const placeWindow=()=>{
      if(compact){if(win.isMaximized())win.unmaximize();win.setMinimumSize(COMPACT.minWidth,COMPACT.minHeight);win.setBounds(placeCompact(prefs.compactBounds,areas(),screen.getPrimaryDisplay().workArea));win.setAlwaysOnTop(pinned,'floating');}
      else{win.setAlwaysOnTop(false);const wa=screen.getPrimaryDisplay().workArea;win.setMinimumSize(Math.min(FULL_MIN.width,wa.width),Math.min(FULL_MIN.height,wa.height));const b=placeFull(prefs.fullBounds,areas());win.setBounds(b||defaultFull(wa));if(prefs.fullMaximized)win.maximize();}
    };
    const setCompact=value=>{if(value===compact)return viewState();rememberBounds();compact=value;savePrefs({compact});placeWindow();refreshTray();sendView();return viewState();};
    const setPinned=value=>{pinned=value;savePrefs({pinned});if(compact)win.setAlwaysOnTop(pinned,'floating');sendView();return viewState();};
    const initView=()=>{if(compact)placeWindow();else{const b=placeFull(prefs.fullBounds,areas());if(b)win.setBounds(b);if(prefs.fullMaximized)win.maximize();}};
    // The page is told which view it is in whenever the window comes back, so a change made while it was hidden in the tray cannot leave it showing the other layout.
    win.on('show',sendView);win.on('restore',sendView);
    win.on('resized',rememberSoon);win.on('moved',rememberSoon);win.on('maximize',rememberSoon);win.on('unmaximize',rememberSoon);
    // Ctrl+Shift+M switches between the two views from inside the window.
    win.webContents.on('before-input-event',(e,input)=>{if(input.type==='keyDown'&&input.control&&input.shift&&!input.alt&&!input.meta&&String(input.key).toLowerCase()==='m'){e.preventDefault();setCompact(!compact);}});
    ipcMain.handle('polygate:desktop:view',fromDashboard(()=>viewState()));
    ipcMain.handle('polygate:desktop:set-compact',fromDashboard(value=>{if(typeof value!=='boolean')throw new Error('Expected true or false');return setCompact(value);}));
    ipcMain.handle('polygate:desktop:set-pinned',fromDashboard(value=>{if(typeof value!=='boolean')throw new Error('Expected true or false');return setPinned(value);}));
    tray=new Tray(nativeImage.createFromPath(trayIconPath));tray.setToolTip(`Polygate · 127.0.0.1:${port}`);
    refreshTray();
    tray.on('click',showWindow);
    win.on('close',e=>{
      rememberBounds();
      if(quitting||prefs.closeToTray===false)return;e.preventDefault();win.hide();
      if(!prefs.trayHintShown&&process.platform==='win32'){tray.displayBalloon({iconType:'info',title:'Polygate is still running',content:'Your clients keep working. Open or exit Polygate from this tray icon.'});savePrefs({trayHintShown:true});}
    });
    win.webContents.setWindowOpenHandler(({url})=>{if(/^https:\/\//.test(url))shell.openExternal(url);return {action:'deny'};});
    const ses=win.webContents.session,ok=p=>p==='clipboard-sanitized-write';ses.setPermissionRequestHandler((_,p,cb)=>cb(ok(p)));ses.setPermissionCheckHandler((_,p)=>ok(p));
    const pin=e=>{let o;try{o=new URL(e.url).origin;}catch{}if(o!==`http://127.0.0.1:${port}`)e.preventDefault();};
    win.webContents.on('will-navigate',pin);win.webContents.on('will-redirect',pin);
    const home=`http://127.0.0.1:${port}/#token=${token}`;let lastGone=0;
    win.webContents.on('render-process-gone',(_,d)=>{fs.writeSync(log,`[desktop] renderer gone: ${d.reason} (${d.exitCode})\n`);if(quitting||d.reason==='clean-exit')return;const soon=lastGone&&Date.now()-lastGone<120000;lastGone=Date.now();if(soon){dialog.showErrorBox('Polygate window crashed',`The window crashed twice in a row. Reopen Polygate. Details are in ${path.join(logDir,'gateway.log')}.`);app.quit();}else win.loadURL(home);});
    initView();
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
  if(quitting||!child)return;event.preventDefault();quitting=true;tray?.destroy();
  const force=setTimeout(()=>{killTree();app.exit(0);},12000);
  (async()=>{try{if(!port){killTree();return;}await fetch(`http://127.0.0.1:${port}/admin/shutdown`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{}'});if(child.exitCode===null&&!child.signalCode)await new Promise(r=>{child.once('exit',r);setTimeout(r,10000);});}catch{}finally{clearTimeout(force);killTree();app.exit(0);}})();
});
}
