/** Domain acceptance checks against real SQLite transactions and persisted task records. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StudioStore} from '../src/store.js';
import {TaskEngine} from '../src/task-engine.js';
import {MemoryService} from '../src/memory.js';
import type {StoredAgent} from '../src/store.js';

async function fixture() {
  const path=await mkdtemp(join(tmpdir(),'studio-engine-'));
  const store=new StudioStore(path);
  for (const role of ['orchestrator','manager','worker'] as const) store.saveTemplate({id:role,name:role,role,systemPrompt:role,selection:{provider:'studio-demo',model:role},version:1,memoryIdentityId:`template-${role}`});
  store.saveRun({id:'run',title:'test',mode:'auto',orchestratorId:'o',status:'idle',createdAt:new Date().toISOString()});
  const root: StoredAgent={id:'o',sessionId:'session-o',runId:'run',parentId:null,createdBy:null,templateId:'orchestrator',templateVersion:1,memoryIdentityId:'identity-o',name:'O',role:'orchestrator',selection:{provider:'studio-demo',model:'planner'},systemPrompt:'O',status:'idle',createdAt:new Date().toISOString()};
  store.saveAgent(root);
  let notices=0;
  const engine=new TaskEngine(store,{onChange:()=>notices++});
  return {store,engine,notices:()=>notices,close:async()=>{store.close();await rm(path,{recursive:true,force:true});}};
}

test('rolled-back task admission leaves neither a task, user message nor queued delivery', async()=>{
  const f=await fixture();
  try {
    assert.throws(()=>f.store.atomic(()=>{f.engine.createTask('run',{prompt:'never committed',requestId:'r'});throw new Error('rollback');}),/rollback/);
    assert.equal(f.store.tasks().length,0);assert.equal(f.store.deliveries().length,0);assert.equal(f.store.run('run')!.messages.length,0);assert.equal(f.notices(),0);
    const task=f.engine.createTask('run',{prompt:'committed',requestId:'r'});
    assert.equal(f.store.deliveries()[0]!.taskId,task.id);assert.equal(f.notices(),1);
  } finally {await f.close();}
});

test('execution ownership rejects cross-group delegation and stale reports after retry',async()=>{
  const f=await fixture();
  try {
    const task=f.engine.createTask('run',{prompt:'test',requestId:'a'});
    const manager=f.engine.delegate('o',{taskId:task.id,role:'manager',prompt:task.prompt});
    const other=f.engine.createTask('run',{prompt:'other',requestId:'b'});
    const outsider=f.engine.delegate('o',{taskId:other.id,role:'worker',prompt:other.prompt});
    assert.throws(()=>f.engine.delegate(manager.agentId,{taskId:task.id,role:'worker',prompt:task.prompt,agentId:outsider.agentId}),/outside/);
    assert.throws(()=>f.engine.delegate(manager.agentId,{taskId:other.id,role:'worker',prompt:'steal'}),/coordinator/);
    assert.throws(()=>f.engine.delegate(manager.agentId,{taskId:task.id,role:'manager',prompt:'promote'}),/Role cannot/);
    const work=f.engine.delegate(manager.agentId,{taskId:task.id,role:'worker',prompt:'refined execution instruction'});
    const delivery=f.store.deliveries().find(d=>d.attemptId===work.attemptId)!;
    f.engine.beginDelivery(delivery.id);f.engine.failDelivery(delivery.id,'failed',1,10);
    const retried=f.engine.retryTask('run',task.id);
    assert.notEqual(retried.latestAttemptId,work.attemptId);
    assert.equal(f.store.attempt(work.attemptId!)!.status,'failed');
    assert.equal(f.store.deliveries().find(d=>d.kind==='task'&&d.attemptId===retried.latestAttemptId)!.text,'refined execution instruction');
    assert.throws(()=>f.engine.report(work.agentId,{taskId:task.id,attemptId:work.attemptId!,text:'late result'}),/current Worker attempt/);
    assert.equal(f.store.task(task.id)!.status,'queued');
    assert.throws(()=>f.engine.accept(outsider.agentId,{taskId:task.id,text:'fake acceptance'}),/coordinator/);
  } finally {await f.close();}
});

test('native delivery errors after committed delegation, report or acceptance cannot roll back business progress',async()=>{
  const f=await fixture();
  try {
    const task=f.engine.createTask('run',{prompt:'test',requestId:'a'});
    const rootDelivery=f.store.deliveries().find(d=>d.agentId==='o')!;
    f.engine.beginDelivery(rootDelivery.id);
    const manager=f.engine.delegate('o',{taskId:task.id,role:'manager',prompt:'manage'});
    const managerDelivery=f.store.deliveries().find(d=>d.agentId===manager.agentId)!;
    f.engine.beginDelivery(managerDelivery.id);
    const work=f.engine.delegate(manager.agentId,{taskId:task.id,role:'worker',prompt:'execute'});
    const workerDelivery=f.store.deliveries().find(d=>d.attemptId===work.attemptId)!;
    f.engine.beginDelivery(workerDelivery.id);
    f.engine.failDelivery(rootDelivery.id,'root flush failed after delegation',1,10);
    f.engine.failDelivery(managerDelivery.id,'manager flush failed after delegation',1,10);
    assert.equal(f.store.task(task.id)!.status,'running');
    assert.equal(f.store.attempt(work.attemptId!)!.status,'running');
    assert.equal(f.store.delivery(rootDelivery.id)!.state,'done');
    assert.equal(f.store.delivery(managerDelivery.id)!.state,'done');
    assert.throws(()=>f.engine.retryTask('run',task.id),/Only failed or blocked/);
    f.engine.report(work.agentId,{taskId:task.id,attemptId:work.attemptId!,text:'actual result'});
    const review=f.store.deliveries().find(d=>d.kind==='review')!;
    f.engine.beginDelivery(review.id);f.engine.accept(manager.agentId,{taskId:task.id,text:'verified'});
    f.engine.failDelivery(workerDelivery.id,'worker flush failed after acceptance',1,10);
    f.engine.failDelivery(review.id,'review flush failed after acceptance',1,10);
    assert.equal(f.store.task(task.id)!.status,'completed');
    assert.equal(f.store.attempt(work.attemptId!)!.status,'reported');
    assert.equal(f.store.delivery(workerDelivery.id)!.state,'done');
    assert.equal(f.store.delivery(review.id)!.state,'done');
    assert.equal(f.store.delivery(review.id)!.error,'review flush failed after acceptance');
    assert.equal(f.store.attempts(task.id).length,1);
  } finally {await f.close();}
});

test('a committed report survives recovery without repeating the Worker or losing coordinator review',async()=>{
  const f=await fixture();
  try {
    const task=f.engine.createTask('run',{prompt:'test',requestId:'a'});
    const work=f.engine.delegate('o',{taskId:task.id,role:'worker',prompt:task.prompt});
    const delivery=f.store.deliveries().find(d=>d.attemptId===work.attemptId)!;
    f.engine.beginDelivery(delivery.id);
    f.engine.report(work.agentId,{taskId:task.id,attemptId:work.attemptId!,text:'actual result',evidence:['probe']});
    f.engine.report(work.agentId,{taskId:task.id,attemptId:work.attemptId!,text:'actual result',evidence:['probe']});
    f.engine.recover();
    assert.equal(f.store.attempts(task.id).length,1);assert.equal(f.store.delivery(delivery.id)!.state,'done');
    const reviews=f.store.deliveries().filter(d=>d.kind==='review');assert.equal(reviews.length,1);
    f.engine.beginDelivery(reviews[0]!.id);f.engine.failDelivery(reviews[0]!.id,'reviewer unavailable',1,10);
    f.engine.retryTask('run',task.id);
    assert.equal(f.store.attempts(task.id).length,1,'review retry never repeats completed Worker execution');
    assert.equal(f.store.task(task.id)!.status,'review');
    const retriedReview=f.store.deliveries().find(d=>d.kind==='review'&&d.state==='pending')!;
    f.engine.beginDelivery(retriedReview.id);f.engine.accept('o',{taskId:task.id,text:'verified'});
    f.engine.accept('o',{taskId:task.id,text:'verified'});
    assert.equal(f.store.deliveries().filter(d=>d.kind==='result').length,1);
    const result=f.store.deliveries().find(d=>d.kind==='result')!;
    f.engine.beginDelivery(result.id);f.engine.failDelivery(result.id,'temporary notification failure',3,10);
    assert.equal(f.store.task(task.id)!.status,'completed','notification failure cannot undo accepted work');
    assert.equal(f.store.delivery(result.id)!.state,'pending','accepted result still retries delivery');
  } finally {await f.close();}
});

test('schema one migrates transactionally without changing legacy chat or inventing task completion',async()=>{
  const path=await mkdtemp(join(tmpdir(),'studio-migration-'));
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(join(path,'studio.sqlite'));
  db.exec(`CREATE TABLE templates(id TEXT PRIMARY KEY,document TEXT NOT NULL);
    CREATE TABLE runs(id TEXT PRIMARY KEY,document TEXT NOT NULL);
    CREATE TABLE agents(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),role TEXT NOT NULL,parent_id TEXT,document TEXT NOT NULL);
    CREATE TABLE messages(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),document TEXT NOT NULL);
    CREATE TABLE activity(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),document TEXT NOT NULL);
    CREATE TABLE runtime_owner(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,nonce TEXT NOT NULL);
    PRAGMA user_version=1;`);
  const legacy={id:'legacy',title:'Phase one conversation',mode:'direct',orchestratorId:'old-o',status:'idle',createdAt:'2026-10-13T00:00:00Z'};
  db.prepare('INSERT INTO runs VALUES(?,?)').run(legacy.id,JSON.stringify(legacy));
  const message={id:'m',role:'user',text:'retain historical content',createdAt:legacy.createdAt};
  db.prepare('INSERT INTO messages VALUES(?,?,?)').run(message.id,legacy.id,JSON.stringify(message));
  db.prepare('INSERT INTO runtime_owner VALUES(1,?,?)').run(process.pid,'live-old-runtime');
  assert.throws(()=>new StudioStore(path),/already owned/);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version,1,'a competing runtime must not migrate a live data directory');
  db.exec('DELETE FROM runtime_owner');db.close();
  const store=new StudioStore(path);
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version,3);
    const migrated=store.run('legacy')!;
    assert.equal(migrated.title,legacy.title);assert.deepEqual(migrated.messages,[message]);
    assert.deepEqual(migrated.tasks,[]);assert.deepEqual(migrated.attempts,[]);
    assert.equal(store.deliveries().length,0);
  } finally {store.close();await rm(path,{recursive:true,force:true});}
});

test('explicit historical child reuse preserves only long-term identity in fresh Sessions and rejects cross-group sources',async()=>{
  const f=await fixture();
  try {
    const oldTask=f.engine.createTask('run',{prompt:'old',requestId:'old'});
    const oldManager=f.engine.delegate('o',{taskId:oldTask.id,role:'manager',prompt:'old manager'});
    const oldWorker=f.engine.delegate(oldManager.agentId,{taskId:oldTask.id,role:'worker',prompt:'old worker'});
    const memories=new MemoryService(f.store);
    const long=memories.write(oldWorker.agentId,{layer:'long',title:'Method',summary:'Reusable method',content:'Persistent private method'});
    const medium=memories.write(oldWorker.agentId,{layer:'medium',title:'Old task',summary:'Task facts',content:'Must stay in old Run',taskId:oldTask.id});
    f.store.saveRun({id:'next',title:'new',mode:'auto',orchestratorId:'next-o',status:'idle',createdAt:new Date().toISOString(),memorySourceRunId:'run'});
    f.store.saveAgent({...f.store.agent('o')!,id:'next-o',runId:'next',sessionId:'new-root-session',memorySourceAgentId:'o'});
    const task=f.engine.createTask('next',{prompt:'new',requestId:'new'});
    assert.deepEqual(f.engine.memorySources('next-o').map(a=>a.agentId),[oldManager.agentId]);
    assert.throws(()=>f.engine.delegate('next-o',{taskId:task.id,role:'worker',prompt:'cross group',memorySourceAgentId:oldWorker.agentId}),/authorized historical child/);
    const manager=f.engine.delegate('next-o',{taskId:task.id,role:'manager',prompt:'new manager',memorySourceAgentId:oldManager.agentId});
    const worker=f.engine.delegate(manager.agentId,{taskId:task.id,role:'worker',prompt:'new worker',memorySourceAgentId:oldWorker.agentId});
    assert.notEqual(worker.agentId,oldWorker.agentId);
    assert.notEqual(f.store.agent(worker.agentId)!.sessionId,f.store.agent(oldWorker.agentId)!.sessionId);
    assert.equal(f.store.agent(worker.agentId)!.memoryIdentityId,f.store.agent(oldWorker.agentId)!.memoryIdentityId);
    assert.equal(memories.read(worker.agentId,{id:long.id}).content,'Persistent private method');
    assert.throws(()=>memories.read(worker.agentId,{id:medium.id}),/unavailable/);
    const another=f.engine.createTask('next',{prompt:'another',requestId:'another'});
    f.engine.delegate('next-o',{taskId:another.id,role:'manager',prompt:'manage another',agentId:manager.agentId});
    assert.throws(()=>f.engine.delegate(manager.agentId,{taskId:another.id,role:'worker',prompt:'duplicate identity',memorySourceAgentId:oldWorker.agentId}),/authorized historical child/);
    const fresh=f.engine.delegate(manager.agentId,{taskId:another.id,role:'worker',prompt:'new identity'});
    assert.notEqual(f.store.agent(fresh.agentId)!.memoryIdentityId,f.store.agent(worker.agentId)!.memoryIdentityId);
    assert.throws(()=>memories.read(fresh.agentId,{id:long.id}),/unavailable/);
    f.store.saveRun({id:'unselected',title:'no source',mode:'auto',orchestratorId:'third-o',status:'idle',createdAt:new Date().toISOString()});
    f.store.saveAgent({...f.store.agent('o')!,id:'third-o',runId:'unselected',sessionId:'third-root'});
    const noSource=f.engine.createTask('unselected',{prompt:'no source',requestId:'no-source'});
    assert.throws(()=>f.engine.delegate('third-o',{taskId:noSource.id,role:'manager',prompt:'unselected',memorySourceAgentId:oldManager.agentId}),/authorized historical child/);
  } finally {await f.close();}
});
