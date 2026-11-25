import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {createStudio} from '../src/runtime.js';
import {DramaWorkflow} from '../src/drama-workflow.js';
import {ArtifactEpisodes} from '../src/drama-artifact-episodes.js';
import {projectForRun} from '../src/drama-project-lifecycle.js';
import {DramaStore} from '../src/drama-store.js';
import {StudioStore} from '../src/store.js';
import {MemoryService} from '../src/memory.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'drama-lifecycle-'));
  let store = new StudioStore(directory);
  let drama = new DramaStore(store, 'writer');
  t.after(() => { store.close(); rmSync(directory, {recursive:true,force:true}); });
  return {
    directory, get store() {return store;}, get drama() {return drama;},
    reopen() { store.close(); store = new StudioStore(directory); drama = new DramaStore(store, 'writer'); },
  };
}

test('archive and restore preserve the canvas and revisions across restart, reject stale confirmations, and isolate owners', t => {
  const f = fixture(t);
  const shared = f.drama.saveAgent({name:'作者',selection:{provider:'studio-demo',model:'executor'}});
  const template = f.drama.saveTemplate({name:'画布',nodes:[{id:'a',title:'第一稿',agentId:shared.id,x:8,y:10}],edges:[]});
  const one = f.drama.createProject({name:'同名作品',templateId:template.id});
  const neighbor = f.drama.createProject({name:'同名作品',templateId:template.id});
  const other = new DramaStore(f.store, 'other');
  assert.throws(() => other.archiveProject(one.id), /作品不存在/);
  assert.throws(() => f.drama.beginProjectDeletion(one.id,'anything'), /仅可永久删除已归档/);
  const graph = f.drama.saveGraph(one.id,one.graphVersion,{nodes:[],edges:[]});
  const doc = f.drama.saveDocument(one.id,{name:'资料',content:'第一稿'});
  f.drama.saveDocument(one.id,{id:doc.id,name:'资料',content:'第二稿',expectedVersion:1});
  const old = f.drama.archiveProject(one.id);
  assert.ok(old.archivedAt);
  assert.equal(f.drama.archiveProject(one.id).archivedAt, old.archivedAt);
  f.reopen();
  assert.deepEqual(f.drama.listProjects().map(p=>p.id),[neighbor.id]);
  assert.deepEqual(f.drama.listProjects(true).map(p=>p.id),[one.id]);
  assert.throws(() => f.drama.saveDocument(one.id,{name:'旧标签页',content:'变更'}), /已归档/);
  assert.throws(() => f.drama.saveGraph(one.id,graph.version,{nodes:[],edges:[]}), /已归档/);
  assert.equal(f.drama.restoreProject(one.id).archivedAt, undefined);
  assert.equal(f.drama.graph(one.id).version,graph.version);
  assert.equal(f.drama.graph(one.id,1).nodes[0]?.agentId,shared.id);
  assert.equal(f.drama.document(one.id,doc.id,1).content,'第一稿');
  assert.equal(f.drama.document(one.id,doc.id).content,'第二稿');
  const current = f.drama.archiveProject(one.id);
  assert.notEqual(current.archivedAt,old.archivedAt);
  assert.throws(() => f.drama.beginProjectDeletion(one.id,old.archivedAt!), /重新确认/);
  assert.throws(() => f.drama.deleteProject(one.id,current.archivedAt!), /先确认/);
  assert.throws(() => new DramaStore(f.store,'other').beginProjectDeletion(one.id,current.archivedAt!), /作品不存在/);
});

function addHistory(f:ReturnType<typeof fixture>, project:string, prefix:string) {
  const runId=prefix+'-run', agentId=prefix+'-agent', createdAt=new Date().toISOString(), taskId=prefix+'-task', attemptId=prefix+'-attempt';
  f.store.saveRun({id:runId,title:prefix,mode:'auto',orchestratorId:agentId,status:'idle',createdAt,dramaProjectId:project});
  const sessionId=prefix+'-session';
  f.store.saveAgent({id:agentId,runId,sessionId,role:'orchestrator',parentId:null,createdBy:null,templateId:'editor',name:'作者',selection:{provider:'studio-demo',model:'planner'},systemPrompt:'一次执行',status:'idle',createdAt,templateVersion:1,memoryIdentityId:prefix+'-identity'});
  f.store.saveTask({id:taskId,runId,title:'执行',requestId:'once',prompt:'编辑',coordinatorId:agentId,status:'completed',createdAt,updatedAt:createdAt});
  f.store.saveAttempt({id:attemptId,taskId,workerId:agentId,number:1,status:'reported',createdAt});
  const delivery={id:prefix+'-delivery',runId,agentId,taskId,kind:'task' as const,text:'执行',state:'done' as const,failures:0,nextAt:0,createdAt};
  f.store.saveDelivery(delivery);
  f.store.message(runId,'user','此作品对话');
  f.store.activity(runId,'test','此作品事件');
  const mem = new MemoryService(f.store);
  const long=mem.write(agentId,{layer:'long',title:'作品方法',summary:'经验',content:'长期'});
  mem.publish(agentId,{id:long.id,expectedVersion:long.version});
  const medium=mem.write(agentId,{layer:'medium',taskId,title:'作品设定',summary:'人物',content:'中期'});
  const short=mem.write(agentId,{layer:'short',taskId,title:'进度',summary:'本轮',content:'短期'});
  const folder=join(f.directory,'sessions','--old-data--',sessionId);
  mkdirSync(folder,{recursive:true});
  writeFileSync(join(folder,'session.jsonl'),'owned native transcript');
  return {runId,agentId,sessionId,taskId,attemptId,delivery,folder,memories:[long,medium,short]};
}

test('purge removes only confirmed project history, native sessions, and originals even when uploaded bytes match', t => {
  const f=fixture(t);
  const shared=f.drama.saveAgent({name:'编剧',selection:{provider:'studio-demo',model:'executor'},publicNetwork:true,role:'worker'});
  const template=f.drama.saveTemplate({name:'共用画布',nodes:[],edges:[]});
  const skill=f.drama.saveSkill({name:'设置',summary:'方法',body:'共用指令'});
  const prepare=(name:string)=>{
    const p=f.drama.createProject({name,templateId:template.id});
    const h=addHistory(f,p.id,name);
    const doc=f.drama.saveDocument(p.id,{kind:'episode',episode:1,name:'分集',content:'第一稿',source:{name:'设定.txt',base64:Buffer.from('同一份原件').toString('base64')}});
    f.drama.addEpisodeComment(p.id,{documentId:doc.id,version:1,start:0,end:1,selectedText:'第',text:'修改'});
    f.store.db.prepare('INSERT INTO drama_network_audit VALUES(?,?,?,?,?,?,?,?,?,?)').run(name+'-audit',p.id,h.taskId,h.attemptId,shared.id,f.drama.networkGrant(shared.id)!.id,'search','allowed','[]',new Date().toISOString());
    return {p,h,doc};
  };
  const gone=prepare('first'), keep=prepare('second');
  f.store.saveDelivery({...gone.h.delivery,state:'pending'});
  assert.throws(()=>f.drama.archiveProject(gone.p.id),/请等待完成或先停止/);
  f.store.saveDelivery(gone.h.delivery);
  const archive=f.drama.archiveProject(gone.p.id);
  const token=archive.archivedAt!;
  const resources=f.drama.beginProjectDeletion(gone.p.id,token);
  assert.deepEqual(resources.attemptIds,[gone.h.attemptId]);
  assert.deepEqual(resources.sessionIds,[gone.h.sessionId]);
  assert.throws(()=>f.drama.restoreProject(gone.p.id),/继续删除/);
  f.reopen();
  assert.equal(f.drama.listProjects(true)[0]?.deleting,true);
  assert.deepEqual(f.drama.beginProjectDeletion(gone.p.id,token),resources);
  f.drama.deleteProject(gone.p.id,token);
  assert.deepEqual(f.drama.listProjects(true),[]);
  assert.deepEqual(f.drama.listProjects().map(p=>p.id),[keep.p.id]);
  assert.equal(f.store.run(gone.h.runId),undefined);
  assert.deepEqual(f.store.run(keep.h.runId)?.tasks.map(task=>task.id),[keep.h.taskId]);
  assert.deepEqual(f.store.activities().map(a=>a.runId),[keep.h.runId]);
  for (const table of ['drama_episode_comments','drama_network_audit','drama_document_versions','drama_graphs','messages','deliveries','attempts']) {
    assert.equal(f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,1,table);
  }
  for(const m of gone.h.memories) assert.equal(f.store.db.prepare('SELECT 1 FROM memory_revisions WHERE entry_id=?').get(m.id),undefined);
  for(const m of keep.h.memories) assert.ok(f.store.db.prepare('SELECT 1 FROM memory_revisions WHERE entry_id=?').get(m.id));
  assert.throws(()=>f.store.db.exec('DELETE FROM memory_revisions'),/immutable/);
  assert.throws(()=>f.store.db.exec('DELETE FROM drama_graphs'),/immutable/);
  assert.ok(!existsSync(gone.h.folder));
  assert.ok(existsSync(keep.h.folder));
  assert.ok(!existsSync(join(f.directory,'drama-blobs',gone.p.id)));
  assert.equal(f.drama.readDocumentSource(keep.p.id,keep.doc.id).bytes.toString(),'同一份原件');
  assert.equal(f.drama.template(template.id).id,template.id);
  assert.equal(f.drama.agent(shared.id).id,shared.id);
  assert.equal(f.drama.skill(skill.id).body,'共用指令');
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('partial file cleanup remains retryable after restart and never follows a symlink out of workbench storage',t=>{
  const f=fixture(t), project=f.drama.createProject({name:'重试'});
  const h=addHistory(f,project.id,'target');
  const doc=f.drama.saveDocument(project.id,{name:'资料',content:'原件',source:{name:'a',base64:'YQ=='}});
  const outside=join(f.directory,'other-storage');
  mkdirSync(outside);
  writeFileSync(join(outside,'keep'),'protected');
  // Invalid managed root after a storage move must not remove data from its symlink target.
  const sessions=join(f.directory,'sessions');
  rmSync(sessions,{recursive:true,force:true});
  symlinkSync(outside,sessions);
  const token=f.drama.archiveProject(project.id).archivedAt!;
  f.drama.beginProjectDeletion(project.id,token);
  assert.throws(()=>f.drama.deleteProject(project.id,token),/目录异常/);
  assert.ok(existsSync(join(outside,'keep')));
  f.reopen();
  assert.equal(f.drama.listProjects(true)[0]?.deleting,true);
  assert.equal(f.store.run(h.runId)?.id,h.runId);
  assert.ok(f.store.db.prepare('SELECT 1 FROM drama_documents WHERE id=?').get(doc.id));
  assert.throws(()=>f.drama.restoreProject(project.id),/继续删除/);
  rmSync(sessions);
  f.drama.beginProjectDeletion(project.id,token);
  f.drama.deleteProject(project.id,token);
  assert.equal(f.store.run(h.runId),undefined);
  assert.deepEqual(f.drama.listProjects(true),[]);
  assert.ok(existsSync(join(outside,'keep')));
});

test('manual approval and its waiting dependent survive archival; deleting the reviewed graph removes the artifact and handoff history',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'drama-archive-workflow-'));
  const studio=await createStudio({dataDir,drama:true,scheduler:{pollIntervalMs:15}});
  t.after(async()=>{await studio.close();rmSync(dataDir,{recursive:true,force:true});});
  const host=studio.drama!, store=host.store, drama=new DramaStore(store);
  const flow=new DramaWorkflow(drama,host,studio), episodes=new ArtifactEpisodes(store,drama,flow);
  const writer=drama.saveAgent({name:'作者',role:'worker',selection:{provider:'studio-demo',model:'executor'}});
  const project=drama.createProject({name:'审稿中归档'});
  const nodes=['source','next'].map(id=>({id,title:id,release:'manual',agentId:writer.id,x:0,y:4,instruction:'完成该稿'}));
  drama.saveGraph(project.id,project.graphVersion,{nodes,edges:[{from:'source',to:'next'}]});
  const run=flow.start(project.id,{nodeIds:['source'],includeDownstream:true,requestId:'launch'});
  assert.throws(()=>drama.archiveProject(project.id), /等待完成或先停止/);
  async function waitForReview(nodeId:string) {
    const until=Date.now()+8_000;
    while(Date.now()<until) {
      flow.refresh();
      const node=flow.list(project.id)[0]?.nodes.find(n=>n.nodeId===nodeId);
      const open=store.deliveries().some(d=>['running','pending'].includes(d.state));
      if(node?.status==='review' && !open) return node;
      await delay(20);
    }
    assert.fail('review not reached');
  }
  const source=await waitForReview('source');
  assert.equal(flow.list(project.id)[0]?.nodes.find(n=>n.nodeId==='next')?.status,'waiting');
  const token=drama.archiveProject(project.id).archivedAt!;
  const deliveries=store.deliveries().length;
  for(let i=0;i<3;i++){flow.refresh();await delay(20);}
  assert.equal(store.deliveries().length,deliveries);
  assert.throws(()=>flow.list(project.id),/已归档/);
  drama.restoreProject(project.id);
  const released=flow.review(project.id,source.id,{requestId:'approve',decision:'approve',artifactId:source.artifact!.id});
  const next=await waitForReview('next');
  assert.ok(next.handoff?.some(h=>h.artifactId===released.artifact!.id));
  episodes.associate(project.id,released.artifact!.id,{mode:'new',episode:1,requestId:'new-episode'});
  flow.export(project.id,released.artifact!.id,'docx');
  const finalToken=drama.archiveProject(project.id).archivedAt!;
  assert.notEqual(token,finalToken);
  drama.beginProjectDeletion(project.id,finalToken);
  drama.deleteProject(project.id,finalToken);
  assert.equal(store.db.prepare('SELECT 1 FROM drama_graph_runs WHERE id=?').get(run.id),undefined);
  for (const table of ['drama_exports','drama_artifact_episodes','drama_reviews','drama_drafts','drama_node_runs','drama_dispatch_sessions']) {
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,0,table);
  }
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('ambiguous legacy bindings and external video references cannot authorize removal of another workspace',t=>{
  const f=fixture(t), project=f.drama.createProject({name:'归档'}),other=f.drama.createProject({name:'其他'});
  const h=addHistory(f,project.id,'history');
  f.store.db.exec('CREATE TABLE drama_editor_sessions(run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL)');
  f.store.db.prepare('INSERT INTO drama_editor_sessions VALUES(?,?)').run(h.runId,other.id);
  assert.throws(()=>f.drama.archiveProject(project.id),/其他作品/);
  assert.throws(()=>projectForRun(f.store,h.runId),/多个作品绑定/);
  f.store.db.prepare('DELETE FROM drama_editor_sessions WHERE run_id=?').run(h.runId);
  assert.equal(projectForRun(f.store,h.runId),project.id);
  f.store.db.exec('CREATE TABLE video_jobs(id TEXT PRIMARY KEY, document TEXT NOT NULL)');
  f.store.db.prepare('INSERT INTO video_jobs VALUES(?,?)').run('video',JSON.stringify({runId:h.runId}));
  const token=f.drama.archiveProject(project.id).archivedAt!;
  assert.throws(()=>f.drama.beginProjectDeletion(project.id,token), /视频试点/);
  assert.equal(f.drama.listProjects(true)[0]?.deleting,undefined);
  assert.equal(f.drama.restoreProject(project.id).id,project.id);
});
