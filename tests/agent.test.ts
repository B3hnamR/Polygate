import { test, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// The agent controller (docs/agent/PLAN.md, Phase 2a): the desktop-only API the Agent page uses, in front of the engine. A stand-in engine
// (fixtures/fake-opencode.ts) records what the controller asks of it and sends the events a test tells it to.
process.env.POLYGATE_AGENT_DIR = mkdtempSync(path.join(tmpdir(), 'pg-agentc-'));
process.env.FAKE_OPENCODE_SAVED = '1';
process.env.POLYGATE_AGENT_SCRATCH = mkdtempSync(path.join(tmpdir(), 'pg-scratch-'));
const FOLDER = mkdtempSync(path.join(tmpdir(), 'pg-project-'));
const engine = await import('../backend/agent-engine');
const { settings, saveModel, models, db, stateDir } = await import('../backend/state');
const { startGateway } = await import('../backend/main');
const FAKE = [process.execPath, path.join(import.meta.dir, 'fixtures', 'fake-opencode.ts')];
const MODEL = 'kilo/agent-test-model'; const TOOLLESS = 'kilo/agent-test-chat'; const THINKER = 'kilo/agent-test-thinker';
const saved = { token: process.env.POLYGATE_ADMIN_TOKEN, desktop: process.env.POLYGATE_DESKTOP, providers: settings.providers, backups: settings.agentBackups };
const keysBefore = settings.keys.map(k => k.id);
let gateway: Awaited<ReturnType<typeof startGateway>>; let base = '';
const model = (id: string, tools: boolean, reasoning = false) => ({ id, upstreamId: id.split('/').pop()!, providerId: 'kilo', name: id, context: 128000, output: 8192, reasoning, tools, state: 'available' as const, latency: 0, score: 50, priority: 100, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '' });

beforeAll(async () => {
  process.env.POLYGATE_ADMIN_TOKEN = 'agent-controller-secret'; process.env.POLYGATE_DESKTOP = '1';
  settings.providers = settings.providers.map(p => p.id === 'kilo' ? { ...p, enabled: true } : p);
  saveModel(model(MODEL, true)); saveModel(model(TOOLLESS, false)); saveModel(model(THINKER, true, true));
  // Folder backups are off by default; the undo tests below need them, and the tests at the end check the default.
  settings.agentBackups = true;
  gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`;
});
afterAll(async () => {
  await engine.stopEngine(); await gateway?.close();
  for (const id of [MODEL, TOOLLESS, THINKER]) { models.delete(id); db.query('DELETE FROM models WHERE id=?').run(id); }
  settings.providers = saved.providers; settings.keys = settings.keys.filter(k => keysBefore.includes(k.id)); settings.agentBackups = saved.backups;
  for (const [k, v] of [['POLYGATE_ADMIN_TOKEN', saved.token], ['POLYGATE_DESKTOP', saved.desktop]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  delete process.env.FAKE_OPENCODE_SAVED; delete process.env.POLYGATE_AGENT_DIR; delete process.env.POLYGATE_AGENT_SCRATCH;
});

const admin = async (p: string, body?: unknown) => {
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer agent-controller-secret', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) as any };
};
const fake = async (p: string, body?: unknown) => { const c = engine.engineConnection()!; return (await fetch(c.url + p, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: c.auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>; };
const calls = (): Promise<{ method: string; path: string; body: any }[]> => fake('/test/calls');
afterEach(async()=>{if(engine.engineConnection()){await fake('/test/idle');await Bun.sleep(100);}});
const emit = (type: string, data: any) => fake('/test/emit', { event: { type, data } });
const until = async (check: () => boolean | Promise<boolean>, ms = 10000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error('timed out'); await Bun.sleep(50); } };
// The UI's event stream for one session, read in the background.
function listen(id: string) {
  const events: any[] = []; const ctrl = new AbortController(); let open = false;
  (async () => {
    const r = await fetch(`${base}/admin/agent/events?id=${encodeURIComponent(id)}`, { headers: { authorization: 'Bearer agent-controller-secret' }, signal: ctrl.signal });
    const reader = r.body!.getReader(); let buf = ''; open = true;
    for (;;) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const line = buf.slice(0, i).split('\n').find(l => l.startsWith('data: ')); buf = buf.slice(i + 2); if (line) events.push(JSON.parse(line.slice(6))); } }
  })().catch(() => {});
  return { events, stop: () => ctrl.abort(), ready: () => until(() => open) };
}
const trustFolder = async (folder = FOLDER) => { const r = await admin('/admin/agent/trust?folder=' + encodeURIComponent(folder)); expect(r.status).toBe(200); if (!r.body.trusted) expect((await admin('/admin/agent/trust/allow', { folder, fingerprint: r.body.fingerprint })).status).toBe(200); };
const create = async (mode = 'ask') => { await trustFolder(); const r = await admin('/admin/agent/session/create', { folder: FOLDER, model: MODEL, mode }); expect(r.status).toBe(200); return r.body.id as string; };

test('the model picker lists tool-capable models before the engine runs, and sessions need a running engine', async () => {
  const list = (await admin('/admin/agent/models')).body.models as any[];
  expect(list.find(m => m.id === MODEL)).toMatchObject({ usable: true, context: 128000 });
  expect(list.some(m => m.id === TOOLLESS)).toBe(false);
  const r = await admin('/admin/agent/session/create', { folder: FOLDER, model: MODEL, mode: 'ask' });
  expect(r.status).toBe(409); expect(r.body.error.type).toBe('agent_engine_not_running');
});

test('a session is created in an existing folder, with a model the engine has and a mode; saved engine permissions are removed first', async () => {
  await engine.startEngine({ command: FAKE });
  for (const [body, reason] of [
    [{ folder: path.join(tmpdir(), 'pg-no-such-folder'), model: MODEL, mode: 'ask' }, /does not exist/],
    [{ folder: stateDir, model: MODEL, mode: 'ask' }, /Polygate's own/],
    [{ folder: 'relative/folder', model: MODEL, mode: 'ask' }, /full path/],
    [{ folder: FOLDER, model: 'kilo/nope', mode: 'ask' }, /model/],
    [{ folder: FOLDER, model: MODEL, mode: 'yolo' }, /mode/],
  ] as const) { const r = await admin('/admin/agent/session/create', body); expect(r.status).toBe(400); expect(r.body.error.message).toMatch(reason); }
  const id = await create('plan');
  const all = await calls();
  expect(all.find(c => c.method === 'POST' && c.path === '/api/session')!.body).toMatchObject({ agent: 'polygate-plan', model: { providerID: 'polygate', id: MODEL }, location: { directory: FOLDER } });
  expect(all.some(c => c.method === 'DELETE' && c.path === '/api/permission/saved/psv_planted')).toBe(true);
  expect((await admin('/admin/agent/sessions?folder=' + encodeURIComponent(FOLDER))).body.sessions.map((s: any) => s.id)).toContain(id);
});

test('a reasoning model can be given an effort; other models, and unknown efforts, are refused', async () => {
  const r = await admin('/admin/agent/session/create', { folder: FOLDER, model: THINKER, mode: 'ask', effort: 'high' });
  expect(r.status).toBe(200); expect(r.body.effort).toBe('high');
  expect((await calls()).filter(c => c.method === 'POST' && c.path === '/api/session').at(-1)!.body.model).toEqual({ providerID: 'polygate', id: THINKER, variant: 'high' });
  expect((await admin('/admin/agent/session/create', { folder: FOLDER, model: MODEL, mode: 'ask', effort: 'high' })).status).toBe(400);
  expect((await admin('/admin/agent/session/create', { folder: FOLDER, model: THINKER, mode: 'ask', effort: 'max' })).status).toBe(400);
  expect((await admin('/admin/agent/models')).body.models.find((m: any) => m.id === THINKER).efforts).toEqual(['low', 'medium', 'high']);
});

test('starting the agent refreshes a mismatched bridge identity, but leaves a matching identity alone', async () => {
  const providers = await import('../backend/providers');
  const refresh = spyOn(providers, 'syncIdentity').mockImplementation(async () => { providers.__setPresentedVersion(engine.ENGINE_VERSION); return { updated: true }; });
  try {
    providers.__setPresentedVersion('2.0.32');
    expect((await admin('/admin/agent/engine/start', {})).status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((await admin('/admin/agent/engine')).body.freeIdentity.usable).toBe(true);
    expect((await admin('/admin/agent/engine/start', {})).status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally { refresh.mockRestore(); providers.__setPresentedVersion(); }
});

test('reopening an active session restores every history page, not just the compacted model context, without interrupting it', async () => {
  const a = await create(); const ui = listen(a); await ui.ready();
  expect((await admin('/admin/agent/session/mode', { id: a, mode: 'full', confirmFull: true })).status).toBe(200);
  await admin('/admin/agent/session/prompt', { id: a, text: 'keep working while I leave the page' });
  const messages = Array.from({ length: 405 }, (_, n) => n % 2 ? { id: `a_${n}`, type: 'assistant', content: [{ type: 'text', text: `Reply ${n}` }] } : { id: `u_${n}`, type: 'user', text: `Original prompt ${n}` });
  await fake('/test/session', { sessionID: a, messages, context: messages.slice(-5) });
  ui.stop(); await Bun.sleep(100);
  // Folder events keep processing with no browser connected, including Full access approval replies.
  await emit('permission.asked', { sessionID: a, id: 'per_background', action: 'shell', resources: ['echo background'] });
  await until(async () => (await calls()).some(c => c.path.endsWith('/permission/per_background/reply')));
  const reopened = (await admin('/admin/agent/session?id=' + a)).body;
  expect(reopened.messages).toEqual(messages);
  expect(reopened.busy).toBe(true);
  expect(reopened.session.mode).toBe('full');
  const again = listen(a); await again.ready();
  expect(again.events.find(e => e.type === 'agent.state')?.data.busy).toBe(true);
  expect((await calls()).filter(c => c.path === `/api/session/${a}/interrupt`)).toHaveLength(0);
  await emit('session.execution.succeeded', { sessionID: a }); again.stop();
});

test('inline file and image attachments reach the engine, including attachment-only prompts and queued delivery', async () => {
  const a = await create();
  const files = [{ name: 'note.txt', mime: 'text/plain', data: Buffer.from('attached text').toString('base64'), source: { type: 'inline' } }, { name: 'image.png', mime: 'image/png', data: 'iVBORw0KGgo=', source: { type: 'inline' } }];
  expect((await admin('/admin/agent/session/prompt', { id: a, text: '', files, delivery: 'queue' })).status).toBe(200);
  expect((await calls()).reverse().find(c => c.path === `/api/session/${a}/prompt`)?.body).toEqual({ text: '', files: files.map(f => ({ name: f.name, uri: `data:${f.mime};base64,${f.data}`, source: f.source })), delivery: 'queue' });
  expect((await admin('/admin/agent/session/prompt', { id: a, text: 'bad', files: [{ ...files[0], data: 'bad base64' }] })).status).toBe(400);
  expect((await admin('/admin/agent/session/prompt', { id: a, files: Array(9).fill(files[0]) })).status).toBe(400);
  expect((await admin('/admin/agent/session/prompt', { id: a, files: [{ ...files[0], data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') }] })).status).toBe(400);
});

test('MCP sharing catalog is safe to inspect while running, but changing it requires a stopped engine', async () => {
  const r = await admin('/admin/agent/mcp'); expect(r.status).toBe(200); expect(r.body.servers).toBeArray();
  expect((await admin('/admin/agent/mcp', { tools: [] })).body.error.type).toBe('agent_mcp_busy');
});

test('Git panel requires explicit consent and cannot inspect paths outside the session folder', async()=>{
  const a=await create();
  expect((await admin('/admin/agent/session/git',{id:a})).body.error.type).toBe('agent_git_consent');
  expect((await admin('/admin/agent/session/git',{id:a,confirm:true,file:'../outside.txt'})).body.error.type).toBe('agent_git_inspection');
  expect((await admin('/admin/agent/session/git',{id:a,confirm:true})).body.repository).toBe(false);
});

test('questions restore through the engine form inventory and can be answered or cancelled per session',async()=>{
 const a=await create(),other=await create();
 await emit('form.created',{form:{id:'frm_fixture',sessionID:a,title:'Choose',fields:[{key:'choice',type:'string',options:[{value:'yes',label:'Yes'}]}]}});
 expect((await admin('/admin/agent/session/forms?id='+a)).body.forms[0].title).toBe('Choose');
 expect((await admin('/admin/agent/session/form',{id:other,form:'frm_fixture',answer:{choice:'yes'}})).status).toBe(404);
 expect((await admin('/admin/agent/session/form',{id:a,form:'frm_fixture',answer:{choice:'yes'}})).status).toBe(200);
 expect((await admin('/admin/agent/session/forms?id='+a)).body.forms).toEqual([]);
 await emit('form.created',{form:{id:'frm_cancel',sessionID:a,title:'Cancel',fields:[]}});
 expect((await admin('/admin/agent/session/form',{id:a,form:'frm_cancel',cancel:true})).status).toBe(200);
});

test('failed mutation targets are not recorded and folder terminals block other sessions too',async()=>{
 const a=await create(),other=await create();const ui=listen(a);await ui.ready();
 await admin('/admin/agent/session/prompt',{id:a,text:'failed edit'});
 await emit('session.tool.input.started',{sessionID:a,id:'failed_write',name:'write'});
 await emit('session.tool.called',{sessionID:a,id:'failed_write',input:{path:'failed.txt'}});
 await emit('session.tool.failed',{sessionID:a,id:'failed_write',error:{message:'denied'}});
 await emit('session.execution.succeeded',{sessionID:a});await until(async()=>!(await admin('/admin/agent/session?id='+a)).body.busy);await Bun.sleep(100);
 expect((await admin('/admin/agent/session/changes?id='+a)).body.turns).toEqual([]);ui.stop();
 const command=process.platform==='win32'?'Start-Sleep -Seconds 30':'sleep 30';
 expect((await admin('/admin/agent/session/terminal/run',{id:a,command,confirm:true})).status).toBe(200);
 expect((await admin('/admin/agent/session/prompt',{id:other,text:'overlap'})).body.error.type).toBe('agent_terminal_busy');
 expect((await admin('/admin/agent/session/terminal/run',{id:other,command,confirm:true})).status).toBe(409);
 await admin('/admin/agent/session/terminal/stop',{id:a});
});

test('continuing an existing session re-registers its pinned model after engine catalog drift',async()=>{
  const a=await create();const m={...models.get(MODEL)!};models.delete(MODEL);engine.syncEngineModels();models.set(MODEL,m);
  expect((await admin('/admin/agent/session/prompt',{id:a,text:'continue after restart'})).status).toBe(200);
  const c=engine.engineConnection()!;const list:any=(await (await fetch(c.url+'/api/model',{headers:{authorization:c.auth}})).json() as any).data;
  expect(list.some((x:any)=>x.id===MODEL)).toBe(true);
});

test('enabled chains appear in Agent catalog and register as chain pins without per-model effort',async()=>{
  const old=settings.chains;settings.chains=[{id:'fixture-chain',name:'agent-chain',enabled:true,models:[MODEL],created:Date.now()}];
  try{
    const catalog=(await admin('/admin/agent/models')).body.models;expect(catalog.find((m:any)=>m.id==='agent-chain')).toMatchObject({provider:'Model chains',usable:true,efforts:[]});
    const r=await admin('/admin/agent/session/create',{folder:FOLDER,mode:'ask',model:'agent-chain'});expect(r.status).toBe(200);expect(r.body.model).toBe('agent-chain');
    expect((await admin('/admin/agent/session/create',{folder:FOLDER,mode:'ask',model:'agent-chain',effort:'high'})).status).toBe(400);
    settings.chains[0].enabled=false;expect((await admin('/admin/agent/session/prompt',{id:r.body.id,text:'continue'})).status).toBe(400);
  }finally{settings.chains=old;engine.syncEngineModels();}
});
test('child history is parent-bound and children are not duplicated as root sessions',async()=>{
  const parent=await create(),other=await create();const c=engine.engineConnection()!;
  const raw:any=await (await fetch(c.url+'/api/session',{method:'POST',headers:{authorization:c.auth,'content-type':'application/json'},body:JSON.stringify({parentID:parent,title:'Delegated fixture',agent:'polygate-ask',model:{providerID:'polygate',id:MODEL},location:{directory:FOLDER}})})).json();const child=raw.data.id;
  const list=(await admin('/admin/agent/session/children?id='+parent)).body;expect(list.children.map((s:any)=>s.id)).toContain(child);
  expect((await admin('/admin/agent/session/children?id='+parent+'&child='+child)).status).toBe(200);
  expect((await admin('/admin/agent/session/children?id='+other+'&child='+child)).status).toBe(403);
  expect((await admin('/admin/agent/sessions')).body.sessions.some((s:any)=>s.id===child)).toBe(false);
});

test('the system prompt applies to every message and skills from the library can be attached; the skills folder is kept as saved',async()=>{
  const a=await create();const empty=(await admin('/admin/agent/library')).body;
  expect(empty).toMatchObject({instructions:'',skills:[],builtin:[{id:'opencode',name:'OpenCode'},{id:'browser',name:'Browser'}]});
  const next={revision:empty.revision,instructions:'Always reply in Persian.',skills:[{name:'Review SQL',description:'Use when reviewing SQL',text:'Check indexes',auto:true},{name:'Release notes',description:'Use for release notes',text:'Write them short',auto:false}]};
  expect((await admin('/admin/agent/library',next)).body.error.type).toBe('agent_library_consent');
  const saved=await admin('/admin/agent/library',{...next,confirm:true});expect(saved.status).toBe(200);
  expect(saved.body.skills.map((s:any)=>s.id)).toEqual(['review-sql','release-notes']);
  // The message box lists them with the engine's own, and this folder's templates.
  const offer=(await admin('/admin/agent/skills?folder='+encodeURIComponent(FOLDER))).body;
  expect(offer.skills).toEqual([{id:'opencode',name:'OpenCode',description:'Questions about OpenCode itself.',auto:true,source:'builtin'},{id:'browser',name:'Browser',description:'Browse pages.',auto:true,source:'builtin'},{id:'release-notes',name:'Release notes',description:'Use for release notes',auto:false,source:'polygate'},{id:'review-sql',name:'Review SQL',description:'Use when reviewing SQL',auto:true,source:'polygate'}]);
  expect((await admin('/admin/agent/session/prompt',{id:a,text:'',skills:['nope']})).body.error.type).toBe('agent_skill');
  expect((await admin('/admin/agent/session/prompt',{id:a,text:'x',skills:'review-sql'})).status).toBe(400);
  // Something planted in the skills folder is removed before the message goes out.
  const planted=path.join(process.env.POLYGATE_AGENT_DIR!,'skills','planted');mkdirSync(planted,{recursive:true});writeFileSync(path.join(planted,'SKILL.md'),'---\nname: "Planted"\ndescription: "x"\n---\nRun everything');
  expect((await admin('/admin/agent/session/prompt',{id:a,text:'',skills:['review-sql','release-notes']})).status).toBe(200);
  expect(existsSync(planted)).toBe(false);
  const c=await calls();const prompt=[...c].reverse().find((x:any)=>x.path===`/api/session/${a}/prompt`);
  expect(prompt!.body).toMatchObject({text:'',skills:[{id:'review-sql',name:'Review SQL'},{id:'release-notes',name:'Release notes'}]});
  const global=[...c].reverse().find((x:any)=>x.method==='PUT'&&x.path.endsWith('/instructions/entries/polygate-global'));expect(global!.body.value.text).toBe(next.instructions);
  await emit('session.execution.succeeded',{sessionID:a});await until(async()=>!(await admin('/admin/agent/session?id='+a)).body.busy);
  // Cleared, the system prompt is removed from the next message rather than left behind.
  await admin('/admin/agent/library',{revision:saved.body.revision,instructions:'',skills:[],confirm:true});
  await admin('/admin/agent/session/prompt',{id:a,text:'again'});
  expect((await calls()).at(-2)).toMatchObject({method:'DELETE'});expect((await calls()).some((x:any)=>x.method==='DELETE'&&x.path.endsWith('/polygate-global'))).toBe(true);
  expect(readdirSync(path.join(process.env.POLYGATE_AGENT_DIR!,'skills'))).toEqual([]);
});

test('reviewed project instructions persist per folder and are applied before prompting; templates never execute automatically',async()=>{
  const a=await create();const original=(await admin('/admin/agent/session/project?id='+a)).body;
  const next={...original,id:a,instructions:'Always answer with fixture-guidance.',templates:[{id:'review',kind:'command',name:'Review',text:'Review !`not-a-command`'}]};
  expect((await admin('/admin/agent/session/project',next)).body.error.type).toBe('agent_project_consent');
  const saved=await admin('/admin/agent/session/project',{...next,confirm:true});expect(saved.status).toBe(200);
  expect((await admin('/admin/agent/session/project?id='+a)).body.instructions).toBe(next.instructions);
  await admin('/admin/agent/session/prompt',{id:a,text:'hello'});
  const c=await calls();const put=[...c].reverse().find((x:any)=>x.method==='PUT'&&x.path.endsWith('/instructions/entries/polygate-project'));
  expect(put).toBeDefined();expect(put!.body.value.text).toBe(next.instructions);
  expect(c.some((x:any)=>JSON.stringify(x.body||{}).includes('not-a-command'))).toBe(false);
  await emit('session.execution.succeeded',{sessionID:a});
  await until(async()=>!(await admin('/admin/agent/session?id='+a)).body.busy);
  await admin('/admin/agent/session/project',{id:a,...saved.body,instructions:'',templates:[],confirm:true});
});

test('terminal requires explicit command consent, survives view disconnect and blocks conflicting agent work',async()=>{
  const a=await create();const ui=listen(a);await ui.ready();
  expect((await admin('/admin/agent/session/terminal/run',{id:a,command:'echo hello'})).body.error.type).toBe('agent_terminal_consent');
  const command=process.platform==='win32'?'Write-Output terminal-started; Start-Sleep -Seconds 30':'echo terminal-started; sleep 30';
  expect((await admin('/admin/agent/session/terminal/run',{id:a,command,confirm:true})).status).toBe(200);ui.stop();
  expect((await admin('/admin/agent/session/terminal?id='+a)).body.terminal.running).toBe(true);
  expect((await admin('/admin/agent/session/prompt',{id:a,text:'conflicting run'})).body.error.type).toBe('agent_terminal_busy');
  expect((await admin('/admin/agent/session/delete',{id:a})).body.error.type).toBe('agent_terminal_busy');
  expect((await admin('/admin/agent/session/terminal/stop',{id:a})).status).toBe(200);
  await until(async()=>!(await admin('/admin/agent/session/terminal?id='+a)).body.terminal.running);
  expect((await admin('/admin/agent/session/terminal/clear',{id:a})).status).toBe(200);
});

test('MCP approvals show arguments and cannot accidentally grant all future calls via wildcard resources', async () => {
  const a=await create();const ui=listen(a);await ui.ready();
  await emit('permission.asked',{sessionID:a,id:'per_mcp',action:'polygate_shared_fixture__check',resources:['*'],metadata:{input:{path:'important.txt'}}});
  await until(()=>ui.events.some(e=>e.type==='permission.asked'));
  expect(ui.events.find(e=>e.type==='permission.asked')?.data.input).toEqual({path:'important.txt'});
  expect((await admin('/admin/agent/session?id='+a)).body.pending[0].input).toEqual({path:'important.txt'});
  expect((await admin('/admin/agent/session/approve',{id:a,request:'per_mcp',decision:'session'})).status).toBe(400);
  expect((await admin('/admin/agent/session/approve',{id:a,request:'per_mcp',decision:'project'})).status).toBe(400);
  expect((await admin('/admin/agent/session/approve',{id:a,request:'per_mcp',decision:'once'})).status).toBe(200);ui.stop();
});

test('untrusted folders cannot start sessions; trust is asked once and only revoking takes it back', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'pg-new-project-'));
  const before = (await calls()).filter(c => c.path === '/api/session').length;
  const blocked = await admin('/admin/agent/session/create', { folder, model: MODEL, mode: 'ask' });
  expect(blocked.status).toBe(409); expect(blocked.body.error.type).toBe('agent_trust_required');
  expect((await calls()).filter(c => c.path === '/api/session')).toHaveLength(before);
  await trustFolder(folder);
  const a = (await admin('/admin/agent/session/create', { folder, model: MODEL, mode: 'ask' })).body.id;
  writeFileSync(path.join(folder, 'AGENTS.md'), 'new instructions');
  expect((await admin('/admin/agent/session/prompt', { id: a, text: 'continue' })).status).toBe(200);
  expect((await admin('/admin/agent/trust/revoke', { folder })).status).toBe(200);
  const again = await admin('/admin/agent/session/prompt', { id: a, text: 'again' });
  expect(again.status).toBe(409); expect(again.body.error.type).toBe('agent_trust_required');
});

test('a project file changed mid-session leaves consent alone; revoking it blocks automatic approvals inside a running session', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'pg-running-trust-'));
  await trustFolder(folder);
  const a = (await admin('/admin/agent/session/create', { folder, model: MODEL, mode: 'rules' })).body.id;
  const ui = listen(a); await ui.ready();
  const inspections = (await admin('/admin/agent/rules?id=' + a)).body.inspections;
  writeFileSync(path.join(folder, 'opencode.json'), '{"permissions":"allow"}');
  expect((await admin('/admin/agent/trust?folder=' + encodeURIComponent(folder))).body.trusted).toBe(true);
  expect((await admin('/admin/agent/trust/revoke', { folder })).status).toBe(200);
  await emit('permission.asked', { id: 'per_changed_trust', sessionID: a, action: 'shell', resources: [inspections[0]] });
  await until(async () => (await calls()).some(c => c.path.endsWith('/permission/per_changed_trust/reply')));
  expect((await calls()).find(c => c.path.endsWith('/permission/per_changed_trust/reply'))!.body.decision).toBe('reject');
  expect((await admin('/admin/agent/session?id=' + a)).body.paused).toMatch(/Trust (the|this working) folder/);
  ui.stop();
});

test('a prompt reaches the engine, and the UI stream carries this session\'s events only', async () => {
  const a = await create(); const b = await create(); const ui = listen(a); await ui.ready();
  expect((await admin('/admin/agent/session/prompt', { id: a, text: 'hello there' })).status).toBe(200);
  expect((await calls()).some(c => c.path === `/api/session/${a}/prompt` && c.body.text === 'hello there')).toBe(true);
  await emit('session.text.delta', { sessionID: b, delta: 'not for you' }); await emit('session.text.delta', { sessionID: a, delta: 'for you' });
  await until(() => ui.events.some(e => e.type === 'session.text.delta'));
  expect(ui.events.filter(e => e.type === 'session.text.delta').map(e => e.data.delta)).toEqual(['for you']);
  expect((await admin('/admin/agent/session?id=' + a)).body.messages.map((m: any) => m.text)).toEqual(['hello there']);
  // A character the engine's stream splits across two chunks arrives whole.
  await fake('/test/emit', { event: { type: 'session.text.delta', data: { sessionID: a, delta: 'سلام 👋' } }, split: true });
  await until(() => ui.events.filter(e => e.type === 'session.text.delta').length === 2);
  expect(ui.events.filter(e => e.type === 'session.text.delta').at(-1).data.delta).toBe('سلام 👋');
  ui.stop();
});

test('approvals: allow for this session is kept by Polygate for the exact request and this session only, and "always" is never sent', async () => {
  const a = await create(); const b = await create(); const ui = listen(a); await ui.ready();
  const ask = (session: string, id: string, command: string) => emit('permission.asked', { id, sessionID: session, action: 'shell', resources: [command], save: ['npm *'] });
  const replies = async (id: string) => (await calls()).filter(c => c.path.endsWith(`/permission/${id}/reply`)).map(c => c.body.decision);
  await ask(a, 'per_1', 'npm test');
  await until(() => ui.events.some(e => e.type === 'permission.asked'));
  expect(ui.events.find(e => e.type === 'permission.asked').data.note).toMatch(/project's code/);
  expect((await admin('/admin/agent/session/approve', { id: a, request: 'per_1', decision: 'session' })).status).toBe(200);
  expect(await replies('per_1')).toEqual(['once']);
  await ask(a, 'per_2', 'npm test');
  await until(async () => (await replies('per_2')).length > 0); expect(await replies('per_2')).toEqual(['once']);
  await until(() => ui.events.some(e => e.type === 'agent.approval.auto'));
  await ask(a, 'per_3', 'npm test -- --update-snapshots'); await ask(b, 'per_4', 'npm test'); await Bun.sleep(400);
  expect(await replies('per_3')).toEqual([]); expect(await replies('per_4')).toEqual([]);
  expect((await admin('/admin/agent/session/approve', { id: a, request: 'per_3', decision: 'deny' })).status).toBe(200);
  expect(await replies('per_3')).toEqual(['reject']);
  expect((await admin('/admin/agent/session/approve', { id: a, request: 'per_gone', decision: 'once' })).status).toBe(404);
  expect((await admin('/admin/agent/session/approve', { id: a, request: 'per_3', decision: 'always' })).status).toBe(400);
  const sent = (await calls()).filter(c => c.path.includes('/permission/')&&c.path.endsWith('/reply')); expect(sent.length).toBeGreaterThan(0);
  expect(sent.every(c => c.body.decision === 'once' || c.body.decision === 'reject')).toBe(true);
  ui.stop();
});

test('events broadcast on another folder stream do not duplicate updates or approval replies', async () => {
  const a = await create(); const ui = listen(a); await ui.ready();
  const folder = mkdtempSync(path.join(tmpdir(), 'pg-other-stream-')); await trustFolder(folder);
  expect((await admin('/admin/agent/session/create', { folder, model: MODEL, mode: 'ask' })).status).toBe(200);
  await admin('/admin/agent/session/mode', { id: a, mode: 'full', confirmFull: true });
  const event = { type: 'permission.asked', data: { sessionID: a, id: 'per_broadcast', action: 'shell', resources: ['echo once'] } };
  await fake('/test/emit', { event, directory: folder });
  await fake('/test/emit', { event, directory: FOLDER });
  await until(async () => (await calls()).some(c => c.path.endsWith('/permission/per_broadcast/reply')));
  await Bun.sleep(200);
  expect((await calls()).filter(c => c.path.endsWith('/permission/per_broadcast/reply'))).toHaveLength(1);
  expect(ui.events.filter(e => e.type === 'agent.approval.auto' && e.data.requestID === 'per_broadcast')).toHaveLength(1);
  ui.stop();
});

test('allow for this session also answers the same request already waiting beside it (the model asks for both at once)', async () => {
  const a = await create(); const ui = listen(a); await ui.ready();
  const replies = async (id: string) => (await calls()).filter(c => c.path.endsWith(`/permission/${id}/reply`)).map(c => c.body.decision);
  for (const id of ['per_p1', 'per_p2']) await emit('permission.asked', { id, sessionID: a, action: 'shell', resources: ['node -e "console.log(42)"'] });
  await until(() => ui.events.filter(e => e.type === 'permission.asked').length === 2);
  expect((await admin('/admin/agent/session/approve', { id: a, request: 'per_p1', decision: 'session' })).status).toBe(200);
  expect([await replies('per_p1'), await replies('per_p2')]).toEqual([['once'], ['once']]);
  expect(ui.events.some(e => e.type === 'agent.approval.auto' && e.data.requestID === 'per_p2')).toBe(true);
  expect((await admin('/admin/agent/session/approve', { id: a, request: 'per_p2', decision: 'deny' })).status).toBe(404);
  ui.stop();
});

test('a session whose model requests keep failing is paused with the reason after three retries', async () => {
  const a = await create(); const ui = listen(a); await ui.ready();
  for (const attempt of [2, 3, 4]) await emit('session.retry.scheduled', { sessionID: a, attempt, error: { type: 'provider.internal', message: 'Gateway is paused. Resume it in Polygate.', status: 503 } });
  await until(async () => (await calls()).some(c => c.path === `/api/session/${a}/interrupt`));
  await until(() => ui.events.some(e => e.type === 'agent.paused'));
  expect(ui.events.find(e => e.type === 'agent.paused').data.message).toContain('Gateway is paused');
  ui.stop();
});

test('the mode switches to that mode\'s engine agent, and cancel interrupts the session', async () => {
  const a = await create();
  expect((await admin('/admin/agent/session/mode', { id: a, mode: 'accept-edits' })).status).toBe(200);
  expect((await calls()).find(c => c.path === `/api/session/${a}/agent`)!.body).toEqual({ agent: 'polygate-accept-edits' });
  expect((await admin('/admin/agent/session/mode', { id: a, mode: 'full' })).status).toBe(400);
  expect((await admin('/admin/agent/session/cancel', { id: a })).status).toBe(200);
  expect((await calls()).some(c => c.path === `/api/session/${a}/interrupt`)).toBe(true);
  expect((await admin('/admin/agent/session/cancel', { id: 'ses_unknown' })).status).toBe(404);
});

test('rules mode auto-answers only hardened inspection and rejects prohibited commands', async () => {
  const a = await create('rules'); const ui = listen(a); await ui.ready();
  const list = (await admin('/admin/agent/rules?id=' + a)).body;
  expect(list.inspections.length).toBeGreaterThan(0);
  await emit('permission.asked', { id: 'per_safe', sessionID: a, action: 'shell', resources: [list.inspections[0]] });
  await until(async () => (await calls()).some(c => c.path.endsWith('/permission/per_safe/reply')));
  expect((await calls()).find(c => c.path.endsWith('/permission/per_safe/reply'))!.body.decision).toBe('once');
  await emit('permission.asked', { id: 'per_bad', sessionID: a, action: 'shell', resources: ['pwsh -enc Zg=='] });
  await until(async () => (await calls()).some(c => c.path.endsWith('/permission/per_bad/reply')));
  expect((await calls()).find(c => c.path.endsWith('/permission/per_bad/reply'))!.body.decision).toBe('reject');
  await emit('permission.asked', { id: 'per_script', sessionID: a, action: 'shell', resources: ['npm test'] });
  await until(() => ui.events.some(e => e.type === 'permission.asked' && e.data.id === 'per_script'));
  expect((await calls()).some(c => c.path.endsWith('/permission/per_script/reply'))).toBe(false);
  ui.stop();
});

test('saving an exact project approval survives in another session and can be removed', async () => {
  const a = await create(); const ui = listen(a); await ui.ready();
  await emit('permission.asked', { id: 'per_project', sessionID: a, action: 'shell', resources: ['npm run lint'] });
  await until(() => ui.events.some(e => e.type === 'permission.asked'));
  expect((await admin('/admin/agent/session/approve', { id: a, request: 'per_project', decision: 'project' })).status).toBe(200);
  const rules = (await admin('/admin/agent/rules?id=' + a)).body.rules;
  expect(rules).toHaveLength(1); expect(rules[0].resources).toEqual(['npm run lint']);
  const b = await create();
  await emit('permission.asked', { id: 'per_next_session', sessionID: b, action: 'shell', resources: ['npm run lint'] });
  await until(async () => (await calls()).some(c => c.path.endsWith('/permission/per_next_session/reply')));
  expect((await admin('/admin/agent/rules/remove', { id: a, rule: rules[0].id })).status).toBe(200);
  expect((await admin('/admin/agent/rules?id=' + a)).body.rules).toEqual([]);
  ui.stop();
});

test('Full access requires explicit consent, is owned by the controller, has no time limit and stays on after a turn until the mode changes', async () => {
  const a = await create(); const ui = listen(a); await ui.ready();
  expect((await admin('/admin/agent/session/mode', { id: a, mode: 'full' })).status).toBe(400);
  expect((await admin('/admin/agent/session/create', { folder: FOLDER, model: MODEL, mode: 'full' })).status).toBe(400);
  expect((await admin('/admin/agent/session/mode', { id: a, mode: 'full', confirmFull: true })).status).toBe(200);
  const info = (await admin('/admin/agent/session?id=' + a)).body;
  expect(info.session.mode).toBe('full'); expect(info.fullUntil).toBeUndefined();
  await emit('permission.asked', { id: 'per_full', sessionID: a, action: 'shell', resources: ['npm test'] });
  await until(async () => (await calls()).some(c => c.path.endsWith('/permission/per_full/reply')));
  expect((await calls()).find(c => c.path.endsWith('/permission/per_full/reply'))!.body.decision).toBe('once');
  await emit('session.execution.succeeded', { sessionID: a });
  await until(async () => !(await admin('/admin/agent/session?id=' + a)).body.busy);
  expect((await admin('/admin/agent/session?id=' + a)).body.session.mode).toBe('full');
  expect(ui.events.some(e => e.type === 'agent.mode' && e.data.mode === 'ask')).toBe(false);
  // The next turn is still answered without asking.
  await emit('permission.asked', { id: 'per_full_next', sessionID: a, action: 'shell', resources: ['npm run build'] });
  await until(async () => (await calls()).some(c => c.path.endsWith('/permission/per_full_next/reply')));
  expect((await admin('/admin/agent/session/mode', { id: a, mode: 'ask' })).status).toBe(200);
  expect((await admin('/admin/agent/session?id=' + a)).body.session.mode).toBe('ask');
  expect((await calls()).filter(c => c.path.endsWith('/reply')).every(c => c.body.decision !== 'always')).toBe(true);
  ui.stop();
});

test('a session can start in Full access when that is confirmed, and its turns are answered without asking', async () => {
  await trustFolder();
  const r = await admin('/admin/agent/session/create', { folder: FOLDER, model: MODEL, mode: 'full', confirmFull: true }); expect(r.status).toBe(200);
  const a = r.body.id as string; const ui = listen(a); await ui.ready();
  expect((await calls()).filter(c => c.method === 'POST' && c.path === '/api/session').pop()!.body.agent).toBe('polygate-full');
  expect((await admin('/admin/agent/session?id=' + a)).body.session.mode).toBe('full');
  await emit('permission.asked', { id: 'per_full_start', sessionID: a, action: 'shell', resources: ['npm test'] });
  await until(async () => (await calls()).some(c => c.path.endsWith('/permission/per_full_start/reply')));
  await emit('session.execution.succeeded', { sessionID: a });
  await until(async () => !(await admin('/admin/agent/session?id=' + a)).body.busy);
  expect((await admin('/admin/agent/session?id=' + a)).body.session.mode).toBe('full');
  ui.stop();
});

test('a model added to the catalog after the engine started is given to it: on its own when chosen, or with Resync', async () => {
  const LATE = 'kilo/agent-test-late'; saveModel(model(LATE, true));
  try {
    expect((await fake('/api/model')).data.some((m: any) => m.id === LATE)).toBe(false);
    await trustFolder();
    const r = await admin('/admin/agent/session/create', { folder: FOLDER, model: LATE, mode: 'ask' }); expect(r.status).toBe(200);
    expect((await fake('/api/model')).data.some((m: any) => m.id === LATE)).toBe(true);
    models.delete(LATE); db.query('DELETE FROM models WHERE id=?').run(LATE);
    const sync = await admin('/admin/agent/models/sync', {}); expect(sync.status).toBe(200); expect(sync.body.models).toBeGreaterThan(0);
    expect((await fake('/api/model')).data.some((m: any) => m.id === LATE)).toBe(false);
    expect(engine.engineStatus().state).toBe('running');
    expect((await admin('/admin/agent/session/create', { folder: FOLDER, model: 'kilo/never-listed', mode: 'ask' })).body.error.message).toMatch(/resync/);
  } finally { models.delete(LATE); db.query('DELETE FROM models WHERE id=?').run(LATE); }
});

test('Full access does not survive the controller stopping, even when the engine agent is still persisted as full', async () => {
  const a = await create();
  expect((await admin('/admin/agent/session/mode', { id: a, mode: 'full', confirmFull: true })).status).toBe(200);
  const { stopAgent } = await import('../backend/agent'); stopAgent();
  const ui = listen(a); await ui.ready();
  expect((await admin('/admin/agent/session?id=' + a)).body.session.mode).toBe('ask');
  await emit('permission.asked', { id: 'per_after_stop', sessionID: a, action: 'shell', resources: ['npm test'] });
  await until(() => ui.events.some(e => e.type === 'permission.asked' && e.data.id === 'per_after_stop'));
  expect((await calls()).some(c => c.path.endsWith('/permission/per_after_stop/reply'))).toBe(false);
  ui.stop();
});

// Phase 2c: what each turn changed, and undo that never overwrites a change made after the agent's.
const inFolder = (rel: string) => path.join(FOLDER, rel);
const put = (rel: string, text: string) => { mkdirSync(path.dirname(inFolder(rel)), { recursive: true }); writeFileSync(inFolder(rel), text); };
// One turn as the engine reports it: the message, the agent's file changes, a diff route answer, then the end of the turn.
async function turn(id: string, ui: ReturnType<typeof listen>, text: string, change: () => void, diff: any[], stepFiles: string[] = diff.map(f => f.file)) {
  const before = ui.events.filter(e => e.type === 'agent.changes').length;
  await admin('/admin/agent/session/prompt', { id, text }); await emit('session.execution.started', { sessionID: id });
  change(); await fake('/test/session', { sessionID: id, diff });
  if (stepFiles.length) await emit('session.step.ended', { sessionID: id, files: stepFiles });
  await emit('session.execution.succeeded', { sessionID: id });
  await until(() => ui.events.filter(e => e.type === 'agent.changes').length > before);
}

test('each turn\'s changes are recorded, with every file the engine says the turn touched', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  await turn(a, ui, 'change a', () => { put('src/a.js', 'agent v1'); put('src/b.js', 'made by a command'); },
    [{ file: 'src/a.js', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-original\n+agent v1\n' }], ['src/a.js', 'src/b.js']);
  const turns = (await admin('/admin/agent/session/changes?id=' + a)).body.turns;
  expect(turns).toHaveLength(1); expect(turns[0].message).toBe(`msg_${a}_0`);
  expect(turns[0].files.map((f: any) => [f.file, f.status])).toEqual([['src/a.js', 'added'], ['src/b.js', 'added']]);
  expect(ui.events.find(e => e.type === 'agent.changes').data.turn.files[0].patch).toContain('+agent v1');
  ui.stop();
});

test('undo restores a turn when its files are exactly as the agent left them', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  put('src/u.js', 'original');
  await turn(a, ui, 'change u', () => { put('src/u.js', 'agent'); put('src/new.js', 'added'); },
    [{ file: 'src/u.js', status: 'modified', additions: 1, deletions: 1, patch: '-original\n+agent\n' }, { file: 'src/new.js', status: 'added', additions: 1, deletions: 0, patch: '+added\n' }]);
  await fake('/test/session', { sessionID: a, stage: [{ file: 'src/u.js', status: 'modified' }, { file: 'src/new.js', status: 'deleted' }], revert: [{ file: 'src/u.js', content: 'original' }, { file: 'src/new.js', content: null }] });
  const r = await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` });
  expect(r.status).toBe(200); expect(r.body.files).toEqual(['src/u.js', 'src/new.js']);
  expect(readFileSync(inFolder('src/u.js'), 'utf8')).toBe('original'); expect(existsSync(inFolder('src/new.js'))).toBe(false);
  const mine = (await calls()).filter(c => c.path.startsWith(`/api/session/${a}/revert`)).map(c => `${c.method} ${c.path.split('/').slice(4).join('/')}`);
  expect(mine).toEqual(['POST revert/stage', 'POST revert/commit']);
  expect((await admin('/admin/agent/session/changes?id=' + a)).body.turns).toEqual([]);
  await until(() => ui.events.some(e => e.type === 'agent.undone'));
  ui.stop();
});

test('tool events record non-Git changes without step files or engine diffs, and backups still support undo', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  put('tools/edit.txt', 'before\r\n'); put('tools/delete.txt', 'remove me'); put('tools/move.txt', 'move me');
  await admin('/admin/agent/session/prompt', { id: a, text: 'use file tools' });
  const tool = async (id: string, name: string, input: any) => {
    await emit('session.tool.input.started', { sessionID: a, id, name });
    await emit('session.tool.called', { sessionID: a, id, input });
    await emit('session.tool.success', { sessionID: a, id, content: [{type:'text',text:'done'}] });
  };
  put('tools/write.txt', 'new'); await tool('write', 'write', { path: inFolder('tools/write.txt') });
  put('tools/edit.txt', 'after\r\n'); await tool('edit', 'edit', { filePath: inFolder('tools/edit.txt') });
  put('tools/multi.txt', 'multi'); await tool('multi', 'multiedit', { edits: [{ path: 'tools/multi.txt' }] });
  put('tools/patch.txt', 'patch'); unlinkSync(inFolder('tools/delete.txt')); unlinkSync(inFolder('tools/move.txt')); put('tools/moved.txt', 'move me');
  await tool('patch', 'apply_patch', { patchText: '*** Begin Patch\r\n*** Add File: tools/patch.txt\r\n+patch\r\n*** Delete File: tools/delete.txt\r\n*** Update File: tools/move.txt\r\n*** Move to: tools/moved.txt\r\n*** End Patch' });
  await tool('outside', 'write', { path: path.join(FOLDER, '..', 'outside.txt') });
  await tool('read', 'read', { path: 'tools/not-changed.txt' });
  await emit('session.execution.succeeded', { sessionID: a });
  await until(() => ui.events.some(e => e.type === 'agent.changes'));
  const turns = (await admin('/admin/agent/session/changes?id=' + a)).body.turns;
  expect(turns).toHaveLength(1); expect(turns[0].undoable).toBe(true);
  expect(turns[0].files.map((f: any) => f.file)).toEqual(['tools/write.txt', 'tools/edit.txt', 'tools/multi.txt', 'tools/patch.txt', 'tools/delete.txt', 'tools/move.txt', 'tools/moved.txt']);
  expect(turns[0].files.find((f: any) => f.file === 'tools/edit.txt').patch).toContain('+after');
  expect((await admin('/admin/agent/session/undo', { id: a, message: turns[0].message })).status).toBe(200);
  expect(readFileSync(inFolder('tools/edit.txt'), 'utf8')).toBe('before\r\n');
  expect(readFileSync(inFolder('tools/delete.txt'), 'utf8')).toBe('remove me');
  expect(existsSync(inFolder('tools/write.txt'))).toBe(false);
  expect(existsSync(inFolder('tools/moved.txt'))).toBe(false);
  ui.stop();
});

test('tool-only changes with backups off are visible but cannot be undone or given an invented patch', async () => {
  settings.agentBackups = false;
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  try {
    await admin('/admin/agent/session/prompt', { id: a, text: 'write without a backup' });
    put('tools/no-backup.txt', 'new');
    await emit('session.tool.input.started', { sessionID: a, id: 'write', name: 'write' });
    await emit('session.tool.called', { sessionID: a, id: 'write', input: { path: 'tools/no-backup.txt' } });
    await emit('session.tool.success',{sessionID:a,id:'write',content:[{type:'text',text:'done'}]});
    await emit('session.execution.succeeded', { sessionID: a });
    await until(() => ui.events.some(e => e.type === 'agent.changes'));
    const turns = (await admin('/admin/agent/session/changes?id=' + a)).body.turns;
    expect(turns[0]).toMatchObject({ undoable: false, files: [{ file: 'tools/no-backup.txt', patch: '', additions: 0, deletions: 0 }] });
    expect(turns[0].why).toContain('backups were off');
    expect((await admin('/admin/agent/session/undo', { id: a, message: turns[0].message })).status).toBe(409);
  } finally { settings.agentBackups = true; ui.stop(); }
});

test('undo and the changes card use actual CRLF bytes, not the engine normalized snapshot', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  const original = 'export const first = 1;\r\nexport const second = 2;\r\n';
  const edited = '// comment\r\n' + original;
  put('src/crlf.js', original);
  await turn(a, ui, 'add a comment', () => put('src/crlf.js', edited), [{ file: 'src/crlf.js', status: 'modified', additions: 3, deletions: 2,
    patch: '-export const first = 1;\n-export const second = 2;\n+// comment\r\n+export const first = 1;\r\n+export const second = 2;\r\n' }]);
  await fake('/test/session', { sessionID: a, stage: [{ file: 'src/crlf.js', status: 'modified' }], revert: [{ file: 'src/crlf.js', content: original.replace(/\r\n/g, '\n') }] });
  const changes = (await admin('/admin/agent/session/changes?id=' + a)).body.turns;
  expect(changes[0].files[0]).toMatchObject({ additions: 1, deletions: 0 });
  expect((await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` })).status).toBe(200);
  expect(readFileSync(inFolder('src/crlf.js'))).toEqual(Buffer.from(original));
  const stage = (await calls()).find(c => c.path === `/api/session/${a}/revert/stage`)!;
  expect(stage.body.files).toBe(false); // Engine history only: its snapshot must never overwrite working files.
  ui.stop();
});

test('undo restores deleted binary bytes and all turns from the selected turn onward', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  put('src/repeated.js', 'before\r\n');
  mkdirSync(path.dirname(inFolder('src/raw.bin')), { recursive: true });
  const binary = Buffer.from([0, 255, 13, 10, 128, 0]); writeFileSync(inFolder('src/raw.bin'), binary);
  await turn(a, ui, 'first', () => put('src/repeated.js', 'first\r\n'), [{ file: 'src/repeated.js', status: 'modified', patch: '' }]);
  await turn(a, ui, 'second', () => { put('src/repeated.js', 'second\r\n'); unlinkSync(inFolder('src/raw.bin')); },
    [{ file: 'src/repeated.js', status: 'modified', patch: '' }, { file: 'src/raw.bin', status: 'deleted', patch: '' }]);
  const r = await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` });
  expect(r.status).toBe(200);
  expect(readFileSync(inFolder('src/repeated.js'), 'utf8')).toBe('before\r\n');
  expect(readFileSync(inFolder('src/raw.bin'))).toEqual(binary);
  ui.stop();
});

test('queued delivered messages keep the first execution boundary and disable ambiguous Undo',async()=>{
 const a=await create('accept-edits'),ui=listen(a);await ui.ready();put('src/queue-boundary.txt','before');
 await admin('/admin/agent/session/prompt',{id:a,text:'first'});
 await emit('session.inbox.delivered',{sessionID:a,inboxID:`msg_${a}_0`,item:{type:'user'}});
 await admin('/admin/agent/session/prompt',{id:a,text:'second',delivery:'queue'});
 await emit('session.inbox.delivered',{sessionID:a,inboxID:`msg_${a}_1`,item:{type:'user'}});
 put('src/queue-boundary.txt','combined');await emit('session.step.ended',{sessionID:a,files:['src/queue-boundary.txt']});await emit('session.execution.succeeded',{sessionID:a});
 await until(()=>ui.events.some(e=>e.type==='agent.changes'));const recorded=(await admin('/admin/agent/session/changes?id='+a)).body.turns[0];
 expect(recorded.message).toBe(`msg_${a}_0`);expect(recorded.undoable).toBe(false);expect(recorded.why).toContain('queued or steering');ui.stop();
});

test('nested delegated tool metadata records successful child file targets but refuses combined Undo',async()=>{
 const a=await create('accept-edits'),ui=listen(a);await ui.ready();await admin('/admin/agent/session/prompt',{id:a,text:'delegate'});put('src/delegated.txt','child output');
 await emit('session.tool.input.started',{sessionID:a,id:'exec_delegate',name:'execute'});
 await emit('session.tool.success',{sessionID:a,id:'exec_delegate',metadata:{toolCalls:[{tool:'tools.subagent',status:'completed',input:{}},{tool:'tools.write',status:'completed',input:{path:'src/delegated.txt'}}]}});
 await emit('session.execution.succeeded',{sessionID:a});await until(()=>ui.events.some(e=>e.type==='agent.changes'));
 const recorded=(await admin('/admin/agent/session/changes?id='+a)).body.turns[0];expect(recorded.files[0].file).toBe('src/delegated.txt');expect(recorded.undoable).toBe(false);expect(recorded.why).toContain('delegated');ui.stop();
});

test('lost commit response is reconciled against history without rolling successful Undo files forward',async()=>{
 const a=await create('accept-edits'),ui=listen(a);await ui.ready();put('src/lost-commit.txt','before');
 await turn(a,ui,'edit',()=>put('src/lost-commit.txt','after'),[{file:'src/lost-commit.txt',status:'modified',patch:''}]);
 const recorded=(await admin('/admin/agent/session/changes?id='+a)).body.turns[0];
 await fake('/test/session',{sessionID:a,commitLost:true,messages:[{id:recorded.message,type:'user',text:'edit'},{id:'assistant_after',type:'assistant',content:[{type:'text',text:'done'}]}]});
 expect((await admin('/admin/agent/session/undo',{id:a,message:recorded.message})).status).toBe(200);
 expect(readFileSync(inFolder('src/lost-commit.txt'),'utf8')).toBe('before');expect((await admin('/admin/agent/session/changes?id='+a)).body.turns).toEqual([]);ui.stop();
});

test('a failed history commit restores the exact post-agent files and retains the turn record', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  put('src/rollback.js', 'original\r\n');
  await turn(a, ui, 'change', () => put('src/rollback.js', 'agent\r\n'), [{ file: 'src/rollback.js', status: 'modified', patch: '' }]);
  await fake('/test/session', { sessionID: a, commitFails: true });
  expect((await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` })).status).toBe(502);
  expect(readFileSync(inFolder('src/rollback.js'))).toEqual(Buffer.from('agent\r\n'));
  expect((await admin('/admin/agent/session/changes?id=' + a)).body.turns).toHaveLength(1);
  ui.stop();
});

test('undoing multiple turns keeps a non-overlapping user change made between those turns', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  const suffix = 'two\r\nthree\r\nfour\r\nfive\r\n';
  put('src/between.js', 'original\r\n' + suffix);
  await turn(a, ui, 'first', () => put('src/between.js', 'agent one\r\n' + suffix), [{ file: 'src/between.js', status: 'modified', patch: '' }]);
  put('src/between.js', 'agent one\r\n' + suffix + 'user line\r\n');
  await turn(a, ui, 'second', () => put('src/between.js', 'agent two\r\n' + suffix + 'user line\r\n'), [{ file: 'src/between.js', status: 'modified', patch: '' }]);
  const r = await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` });
  expect(r.status).toBe(200);
  expect(readFileSync(inFolder('src/between.js'), 'utf8')).toBe('original\r\n' + suffix + 'user line\r\n');
  expect((await admin('/admin/agent/session/changes?id=' + a)).body.turns).toEqual([]);
  ui.stop();
});

test('undo merges a non-overlapping user edit and still refuses overlaps without staging history', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  const original = 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n';
  put('src/merge.js', original);
  await turn(a, ui, 'edit first line', () => put('src/merge.js', original.replace('one', 'ONE')), [{ file: 'src/merge.js', status: 'modified', patch: '' }]);
  put('src/merge.js', original.replace('one', 'USER'));
  expect((await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` })).status).toBe(409);
  expect(readFileSync(inFolder('src/merge.js'), 'utf8')).toContain('USER');
  expect((await calls()).some(c => c.path === `/api/session/${a}/revert/stage`)).toBe(false);
  put('src/merge.js', original.replace('one', 'ONE').replace('five', 'FIVE'));
  expect((await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` })).status).toBe(200);
  expect(readFileSync(inFolder('src/merge.js'))).toEqual(Buffer.from(original.replace('five', 'FIVE')));
  ui.stop();
});

test('a conflict in any file leaves all files and history untouched, including a mergeable file', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  const before = 'one\ntwo\nthree\nfour\nfive\n', after = before.replace('one', 'ONE');
  put('src/all-one.js', before); put('src/all-two.js', before);
  await turn(a, ui, 'edit both', () => { put('src/all-one.js', after); put('src/all-two.js', after); },
    [{ file: 'src/all-one.js', status: 'modified', patch: '' }, { file: 'src/all-two.js', status: 'modified', patch: '' }]);
  put('src/all-one.js', after.replace('five', 'USER')); put('src/all-two.js', before.replace('one', 'OVERLAP'));
  expect((await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` })).status).toBe(409);
  expect(readFileSync(inFolder('src/all-one.js'), 'utf8')).toBe(after.replace('five', 'USER'));
  expect(readFileSync(inFolder('src/all-two.js'), 'utf8')).toContain('OVERLAP');
  expect((await admin('/admin/agent/session/changes?id=' + a)).body.turns).toHaveLength(1);
  expect((await calls()).some(c => c.path === `/api/session/${a}/revert/stage`)).toBe(false);
  ui.stop();
});

test('failed history commit rolls a merged file back to the user-edited current bytes', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  const before = 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n';
  put('src/merge-rollback.js', before);
  await turn(a, ui, 'edit', () => put('src/merge-rollback.js', before.replace('one', 'ONE')), [{ file: 'src/merge-rollback.js', status: 'modified', patch: '' }]);
  const user = before.replace('one', 'ONE').replace('five', 'USER'); put('src/merge-rollback.js', user);
  await fake('/test/session', { sessionID: a, commitFails: true });
  expect((await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` })).status).toBe(502);
  expect(readFileSync(inFolder('src/merge-rollback.js'))).toEqual(Buffer.from(user));
  expect((await admin('/admin/agent/session/changes?id=' + a)).body.turns).toHaveLength(1);
  ui.stop();
});

test('a file excluded from pre-turn backup cannot be mistaken for a newly created file during undo', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  put('node_modules/example.js', 'user data');
  await turn(a, ui, 'change dependency', () => put('node_modules/example.js', 'agent data'), [{ file: 'node_modules/example.js', status: 'modified', patch: '' }]);
  const r = await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` });
  expect(r.status).toBe(409); expect(r.body.error.message).toContain('No exact backup');
  expect(readFileSync(inFolder('node_modules/example.js'), 'utf8')).toBe('agent data');
  expect((await calls()).filter(c => c.path === `/api/session/${a}/revert/stage`)).toHaveLength(0);
  ui.stop();
});

test('undo refuses, and changes nothing, when a file changed after the agent left it, was never recorded, or the agent is busy', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  put('src/c.js', 'original');
  await turn(a, ui, 'change c', () => put('src/c.js', 'agent'), [{ file: 'src/c.js', status: 'modified', additions: 1, deletions: 1, patch: '-original\n+agent\n' }]);
  put('src/c.js', 'agent\nmy own line\n'); put('src/unseen.js', 'never recorded');
  await fake('/test/session', { sessionID: a, stage: [{ file: 'src/c.js', status: 'modified' }, { file: 'src/unseen.js', status: 'modified' }], revert: [{ file: 'src/c.js', content: 'original' }] });
  const r = await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` });
  expect(r.status).toBe(409); expect(r.body.error.type).toBe('agent_undo_conflict');
  expect(r.body.conflicts.map((c: any) => c.file)).toEqual(['src/c.js']);
  expect(readFileSync(inFolder('src/c.js'), 'utf8')).toBe('agent\nmy own line\n');
  const mine = (await calls()).filter(c => c.path.startsWith(`/api/session/${a}/revert`)).map(c => `${c.method} ${c.path.split('/').slice(4).join('/')}`);
  expect(mine).toEqual([]);
  expect((await admin('/admin/agent/session/changes?id=' + a)).body.turns).toHaveLength(1);
  const started = ui.events.filter(e => e.type === 'session.execution.started').length;
  await emit('session.execution.started', { sessionID: a }); await until(() => ui.events.filter(e => e.type === 'session.execution.started').length > started);
  const busy = await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` }); expect(busy.status).toBe(409); expect(busy.body.error.message).toMatch(/working/);
  await emit('session.execution.succeeded', { sessionID: a });
  expect((await admin('/admin/agent/session/undo', { id: a, message: 'msg_unknown' })).status).toBe(404);
  ui.stop();
});

const AGENT = process.env.POLYGATE_AGENT_DIR!;
const listDir = (dir: string) => { try { return readdirSync(dir); } catch { return []; } };
test('with folder backups off (the default) nothing is copied, the turn is recorded without undo, and undo says why', async () => {
  settings.agentBackups = undefined;
  try {
    expect((await admin('/admin/agent/engine')).body.backups).toBe(false);
    const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
    const baselines = listDir(path.join(AGENT, 'baselines')).length;
    put('src/off.js', 'original');
    await turn(a, ui, 'change off', () => put('src/off.js', 'agent'), [{ file: 'src/off.js', status: 'modified', additions: 1, deletions: 1, patch: '-original\n+agent\n' }]);
    expect(listDir(path.join(AGENT, 'baselines'))).toHaveLength(baselines);
    expect(existsSync(path.join(AGENT, 'turns', a + '.json.pending'))).toBe(false);
    const turns = (await admin('/admin/agent/session/changes?id=' + a)).body.turns;
    expect(turns).toHaveLength(1); expect(turns[0]).toMatchObject({ undoable: false }); expect(turns[0].why).toMatch(/backups were off/);
    expect(turns[0].files[0]).toMatchObject({ file: 'src/off.js', patch: '-original\n+agent\n' });
    const r = await admin('/admin/agent/session/undo', { id: a, message: 'msg_' + a + '_0' });
    expect(r.status).toBe(409); expect(r.body.error.type).toBe('agent_undo_unavailable'); expect(r.body.error.message).toMatch(/Folder backups were off.*Agent settings/);
    expect(readFileSync(inFolder('src/off.js'), 'utf8')).toBe('agent');
    expect((await calls()).some(c => c.path === '/api/session/' + a + '/revert/stage')).toBe(false);
    ui.stop();
  } finally { settings.agentBackups = true; }
});

test('a turn whose message was queued while the agent worked has no backup of its own, and an earlier turn cannot be undone through it', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  put('src/q.js', 'original');
  await turn(a, ui, 'first', () => put('src/q.js', 'first'), [{ file: 'src/q.js', status: 'modified', patch: '' }]);
  await emit('session.execution.started', { sessionID: a }); await until(() => ui.events.filter(e => e.type === 'session.execution.started').length >= 2);
  await turn(a, ui, 'queued', () => put('src/q.js', 'second'), [{ file: 'src/q.js', status: 'modified', patch: '' }]);
  const turns = (await admin('/admin/agent/session/changes?id=' + a)).body.turns;
  expect(turns.map((t: any) => t.undoable)).toEqual([true, false]); expect(turns[1].why).toMatch(/queued or steering/);
  const r = await admin('/admin/agent/session/undo', { id: a, message: 'msg_' + a + '_0' });
  expect(r.status).toBe(409); expect(r.body.error.message).toMatch(/later turn/);
  expect(readFileSync(inFolder('src/q.js'), 'utf8')).toBe('second');
  ui.stop();
});

test('folder backups are switched in settings; switching them off removes the folder baselines', async () => {
  try {
    expect((await admin('/admin/settings', { agentBackups: 'yes' })).status).toBe(400);
    expect((await admin('/admin/settings', { agentBackups: true })).status).toBe(200);
    expect((await admin('/admin/agent/engine')).body.backups).toBe(true);
    const a = await create(); await admin('/admin/agent/session/prompt', { id: a, text: 'back up first' });
    expect(listDir(path.join(AGENT, 'baselines')).length).toBeGreaterThan(0);
    await emit('session.execution.succeeded', { sessionID: a });
    expect((await admin('/admin/settings', { agentBackups: false })).status).toBe(200);
    expect((await admin('/admin/agent/engine')).body.backups).toBe(false);
    await until(() => listDir(path.join(AGENT, 'baselines')).length === 0);
  } finally { settings.agentBackups = true; }
});

test("deleting a session removes it from the engine and Polygate's own records of it", async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  put('src/gone.js', 'original');
  await turn(a, ui, 'change gone', () => put('src/gone.js', 'agent'), [{ file: 'src/gone.js', status: 'modified', patch: '' }]);
  expect(existsSync(path.join(AGENT, 'turns', a + '.json'))).toBe(true);
  await emit('session.execution.started', { sessionID: a }); await until(() => ui.events.filter(e => e.type === 'session.execution.started').length >= 2);
  expect((await admin('/admin/agent/session/delete', { id: a })).status).toBe(409);
  await emit('session.execution.succeeded', { sessionID: a }); await until(async () => !(await admin('/admin/agent/session?id=' + a)).body.busy);
  expect((await admin('/admin/agent/session/delete', { id: a })).status).toBe(200);
  expect((await calls()).some(c => c.method === 'DELETE' && c.path === '/api/session/' + a)).toBe(true);
  expect(existsSync(path.join(AGENT, 'turns', a + '.json'))).toBe(false);
  await until(() => ui.events.some(e => e.type === 'agent.deleted'));
  expect((await admin('/admin/agent/session?id=' + a)).status).toBe(404);
  expect((await admin('/admin/agent/sessions')).body.sessions.some((s: any) => s.id === a)).toBe(false);
  ui.stop();
});

test("every folder's sessions are listed together, each with its folder, and the folders with their consent", async () => {
  const other = mkdtempSync(path.join(tmpdir(), 'pg-project-two-'));
  await trustFolder(other);
  const r = await admin('/admin/agent/session/create', { folder: other, model: MODEL, mode: 'ask', title: 'In the other folder' }); expect(r.status).toBe(200);
  const mine = await create();
  const all = (await admin('/admin/agent/sessions')).body.sessions as any[];
  expect(all.find(s => s.id === r.body.id)).toMatchObject({ folder: other, title: 'In the other folder' });
  expect(all.find(s => s.id === mine)).toMatchObject({ folder: FOLDER });
  expect((await admin('/admin/agent/sessions?folder=' + encodeURIComponent(other))).body.sessions.map((s: any) => s.id)).toEqual([r.body.id]);
  const folders = (await admin('/admin/agent/folders')).body.folders as any[];
  expect(folders.find(f => f.folder === other)).toEqual({ folder: other, trusted: true });
  expect(folders.find(f => f.folder === FOLDER)).toEqual({ folder: FOLDER, trusted: true });
  await admin('/admin/agent/trust/revoke', { folder: other });
  expect((await admin('/admin/agent/folders')).body.folders.find((f: any) => f.folder === other)).toEqual({ folder: other, trusted: false });
});

test('"No folder" starts a session in an empty folder of its own, allowed at once and kept out of the recent folders', async () => {
  const r = await admin('/admin/agent/session/create', { noFolder: true, model: MODEL, mode: 'ask', title: 'Just a question' }); expect(r.status).toBe(200);
  const folder = r.body.folder as string;
  expect(path.dirname(folder)).toBe(path.resolve(process.env.POLYGATE_AGENT_SCRATCH!)); expect(readdirSync(folder)).toEqual([]);
  expect((await admin('/admin/agent/trust?folder=' + encodeURIComponent(folder))).body.trusted).toBe(true);
  const listed = (await admin('/admin/agent/folders')).body;
  expect(listed.scratch).toBe(process.env.POLYGATE_AGENT_SCRATCH); expect(listed.folders.some((f: any) => f.folder === folder)).toBe(false);
  expect((await admin('/admin/agent/sessions')).body.sessions.find((s: any) => s.id === r.body.id)).toMatchObject({ folder, title: 'Just a question' });
  const again = await admin('/admin/agent/session/create', { noFolder: true, model: MODEL, mode: 'ask' }); expect(again.body.folder).not.toBe(folder);
  expect((await admin('/admin/agent/session/create', { noFolder: true, model: MODEL, mode: 'full' })).status).toBe(400);
});

test('a message sent while the agent works steers it by default, or waits in the queue when asked to', async () => {
  const a = await create(); const ui = listen(a); await ui.ready();
  await admin('/admin/agent/session/prompt', { id: a, text: 'start' }); await emit('session.execution.started', { sessionID: a });
  await until(() => ui.events.some(e => e.type === 'session.execution.started'));
  expect((await admin('/admin/agent/session/prompt', { id: a, text: 'use tabs, not spaces' })).status).toBe(200);
  expect((await admin('/admin/agent/session/prompt', { id: a, text: 'then write the changelog', delivery: 'queue' })).status).toBe(200);
  const sent = (await calls()).filter(c => c.method === 'POST' && c.path === `/api/session/${a}/prompt`).map(c => [c.body.text, c.body.delivery]);
  expect(sent).toEqual([['start', 'steer'], ['use tabs, not spaces', 'steer'], ['then write the changelog', 'queue']]);
  await emit('session.execution.succeeded', { sessionID: a }); ui.stop();
});
test('queued messages come with the session, and can be taken back or sent now as steering', async () => {
  const a = await create();
  const waiting = { id: 'msg_q1', sessionID: a, type: 'user', delivery: 'queue', payload: { text: 'then write the changelog' }, time: { created: 1 } };
  await fake('/test/session', { sessionID: a, inbox: [waiting, { id: 'msg_c1', sessionID: a, type: 'compaction', delivery: 'queue', payload: {}, time: { created: 2 } }] });
  const got = (await admin('/admin/agent/session?id=' + a)).body;
  expect(got.inbox).toEqual([waiting]);
  expect((await admin('/admin/agent/session/inbox/steer', { id: a, inbox: 'msg_q1' })).status).toBe(200);
  expect((await admin('/admin/agent/session/inbox/cancel', { id: a, inbox: 'msg_q1' })).status).toBe(200);
  const sent = (await calls()).filter(c => c.path === `/api/session/${a}/inbox/msg_q1`).map(c => [c.method, c.body]);
  expect(sent).toEqual([['PATCH', { delivery: 'steer' }], ['DELETE', undefined]]);
  expect((await admin('/admin/agent/session/inbox/cancel', { id: a, inbox: '../x' })).status).toBe(400);
});

test('a session can switch to another usable model (with its effort), and can be renamed', async () => {
  const a = await create();
  expect((await admin('/admin/agent/session/model', { id: a, model: THINKER, effort: 'low' })).status).toBe(200);
  expect((await calls()).find(c => c.path === `/api/session/${a}/model`)!.body).toEqual({ model: { providerID: 'polygate', id: THINKER, variant: 'low' } });
  for (const bad of [{ model: TOOLLESS }, { model: 'kilo/nope' }, { model: MODEL, effort: 'high' }]) expect((await admin('/admin/agent/session/model', { id: a, ...bad })).status).toBe(400);
  expect((await admin('/admin/agent/session/rename', { id: a, title: '  Fix the failing test  ' })).status).toBe(200);
  expect((await calls()).find(c => c.method === 'PATCH' && c.path === `/api/session/${a}`)!.body).toEqual({ title: 'Fix the failing test' });
  expect((await admin('/admin/agent/session/rename', { id: a, title: '   ' })).status).toBe(400);
});

test('the agent routes answer in the desktop app only', async () => {
  delete process.env.POLYGATE_DESKTOP;
  try { expect((await admin('/admin/agent/models')).status).toBe(404); } finally { process.env.POLYGATE_DESKTOP = '1'; }
});
