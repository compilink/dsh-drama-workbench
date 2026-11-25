import assert from 'node:assert/strict';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, sep} from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {startServer} from '../src/server.js';

async function client(url: string) {
  const {csrfToken} = await fetch(url+'/api/bootstrap').then(r => r.json()) as {csrfToken: string};
  return async (path: string, method = 'GET', input?: unknown, status = 200) => {
    const response = await fetch(url+path, {method, headers: {'x-studio-csrf': csrfToken, 'content-type': 'application/json'}, body: JSON.stringify(input)});
    const result = await response.json();
    assert.equal(response.status, status, method+' '+path+' '+JSON.stringify(result));
    return result;
  };
}

test('archiving a work closes its editing entry points and deletion flushes its open editor session', async () => {
  const dataDir = await mkdtemp(join(tmpdir(),'drama-archive-web-'));
  const app = await startServer({dataDir,drama:true,port:0,videoInputRoot:dataDir});
  try {
    const call = await client(app.url);
    const library = '/api/drama/projects';
    const editor = await call('/api/drama/agents','POST',{role:'orchestrator',name:'项目总编',selection:{provider:'studio-demo',model:'planner'}},201);
    const work = await call(library,'POST',{name:'远行',editorAgentId:editor.id},201);
    const other = await call(library,'POST',{name:'原野'},201);
    const path = library+'/'+work.id;
    const paper = await call(path+'/documents','POST',{name:'人物',content:'从异乡返回。'},201);
    const turn = await call(path+'/editor','POST',{mode:'message',text:'记下开场。',requestId:'intro'},202);
    const host = app.studio.drama!;
    const root = host.store.run(turn.sessionId)!;
    const native = host.store.agent(root.orchestratorId)!.sessionId;
    for (let index=0; index<200 && host.store.deliveries(root.id)[0]?.state !== 'done'; index++) await delay(20);
    assert.equal(host.store.deliveries(root.id)[0]?.state, 'done');
    const transcript = async () => (await readdir(join(dataDir,'sessions'),{recursive:true})).filter(path => path.split(sep).includes(native));
    assert.ok((await transcript()).length);
    await call(path,'DELETE',{},400);
    await call(path,'DELETE',{archivedAt:'invalid'},409);
    // Earlier editor sessions record their project only in the workbench binding tables.
    host.store.db.prepare("UPDATE runs SET document=json_remove(document,'$.dramaProjectId') WHERE id=?").run(root.id);
    const first = await call(path+'/archive','POST',{});
    assert.deepEqual((await call(library)).map((p: {id:string})=>p.id), [other.id]);
    assert.deepEqual((await call(library+'?archived=1')).map((p: {id:string})=>p.id), [work.id]);
    await call(path,'GET',undefined,409);
    await call(path+'/documents','POST',{name:'过期标签页',content:'旧表单'},409);
    await call(path+'/editor','POST',{mode:'message',text:'再次执行',requestId:'late'},409);
    await call(path+'/node-runs/missing/history','GET',undefined,409);
    await call('/api/runs','POST',{prompt:'非法跨作品复用',mode:'auto',reuseMemoryFromRunId:root.id},400);
    await call('/api/runs/'+root.id+'/messages','POST',{text:'不可旁路'},409);
    await call('/api/runs/'+root.id+'/tasks','POST',{requestId:'late',prompt:'旧页重试'},409);
    await call('/api/video','POST',{runId:root.id,brief:'预告'},409);
    await call(path+'/restore','POST',{});
    assert.equal((await call(path+'/documents/'+paper.id)).content, '从异乡返回。');
    assert.equal((await call(path+'/editor')).sessionId, root.id);
    const archived = await call(path+'/archive','POST',{});
    await call(path,'DELETE',{archivedAt:first.archivedAt},409);
    await call(path,'DELETE',{archivedAt:archived.archivedAt});
    assert.equal(host.store.run(root.id), undefined);
    assert.deepEqual(await transcript(), []);
    assert.deepEqual(await call(library+'?archived=1'), []);
    await call(path+'/restore','POST',{},404);
    assert.equal((await call(library+'/'+other.id)).project.name, '原野');
    assert.equal((await call('/api/drama/agents'))[0].id, editor.id);
  } finally {
    await app.close();
    await rm(dataDir,{recursive:true,force:true});
  }
});

test('an input check in flight blocks archiving and a stored human handoff survives archive and restore', async () => {
  const dataDir = await mkdtemp(join(tmpdir(),'drama-archive-check-'));
  const app = await startServer({dataDir,drama:true,port:0});
  let resume!: () => void;
  const gate = new Promise<void>(resolve => {resume = resolve;});
  app.studio.drama!.checkRule = async () => {await gate;return {status:'passed',reason:'满足'};};
  try {
    const call = await client(app.url);
    const agent = await call('/api/drama/agents','POST',{role:'worker',name:'编剧',selection:{provider:'studio-demo',model:'executor'}},201);
    const work = await call('/api/drama/projects','POST',{name:'岸边'},201);
    const path = '/api/drama/projects/'+work.id;
    const material = await call(path+'/documents','POST',{name:'人物设定',content:'主角是一名摄影师。'},201);
    const node = (id:string) => ({id,title:id,agentId:agent.id,x:0,y:0,release:'manual'});
    await call(path+'/graph','PUT',{expectedVersion:work.graphVersion,nodes:[{...node('draft'),inputRule:'主角身份与设定一致'},node('edit')],edges:[{from:'draft',to:'edit'}]});
    const run = await call(path+'/runs','POST',{requestId:'launch',nodeIds:['draft'],includeDownstream:true,overrides:{draft:{documents:[{id:material.id,version:material.version}]}}},201);
    assert.equal(run.nodes[0].inputCheck.status, 'pending');
    await call(path+'/archive','POST',{},409);
    resume();
    let nodes = run.nodes;
    for (let index=0; index<200 && nodes[0].status!=='review'; index++) {
      await delay(30);
      nodes = (await call(path+'/runs'))[0].nodes;
    }
    assert.equal(nodes[0].status,'review');
    assert.equal(nodes[1].status,'waiting');
    await call(path+'/archive','POST',{});
    const decision = {decision:'approve',artifactId:nodes[0].artifact.id,requestId:'review'};
    const review = path+'/node-runs/'+nodes[0].id+'/review';
    await call(review,'POST',decision,409);
    await call(path+'/restore','POST',{});
    assert.equal((await call(path+'/runs'))[0].nodes[1].taskId,undefined);
    await call(review,'POST',decision);
    const downstream = (await call(path+'/runs'))[0].nodes[1];
    assert.equal(downstream.handoff[0].artifactId,decision.artifactId);
  } finally {
    resume();
    await app.close();
    await rm(dataDir,{recursive:true,force:true});
  }
});

test('deletion preserves an archived work when its former Docker workspaces are unavailable', async () => {
  const dataDir = await mkdtemp(join(tmpdir(),'drama-archive-volumes-'));
  const app = await startServer({dataDir,drama:true,port:0});
  try {
    const call = await client(app.url);
    const library = '/api/drama/projects';
    const work = await call(library,'POST',{name:'灯火'},201);
    const path = library+'/'+work.id;
    const host = app.studio.drama!;
    const run = host.createRun({projectId:work.id,title:'制作资料'});
    host.store.activity(run.id,'container-file-write','已保存文件',run.orchestratorId);
    const archive = await call(path+'/archive','POST',{});
    const conflict = await call(path,'DELETE',{archivedAt:archive.archivedAt},409);
    assert.match(conflict.error,/Docker/);
    assert.equal((await call(library+'?archived=1'))[0].deleting,undefined);
    await call(path+'/restore','POST',{});
    assert.equal(host.store.run(run.id)!.title,'制作资料');
  } finally {
    await app.close();
    await rm(dataDir,{recursive:true,force:true});
  }
});
