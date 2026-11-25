import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {Context} from '@deepseek-ai/cordis';
import type {Agent} from '@deepseek-ai/dsh-agent';
import {CallId} from '@deepseek-ai/dsh-llm';
import {createStudio,mountStudio} from '../src/runtime.js';
import {DramaStore} from '../src/drama-store.js';
import {DramaWorkflow} from '../src/drama-workflow.js';
import {StudioStore} from '../src/store.js';
import {TaskEngine} from '../src/task-engine.js';
import type {Role} from '../src/types.js';

async function until<T>(read:()=>T,ok:(value:T)=>boolean) {
  const end=Date.now()+10_000;
  let value=read();
  while(!ok(value)&&Date.now()<end) {await delay(10);value=read();}
  assert.ok(ok(value),JSON.stringify(value));return value;
}
function roles(drama:DramaStore) {
  const add=(name:string,role:Role,model:string,delegateIds:string[]=[])=>drama.saveAgent({
    name,role,selection:{provider:'studio-demo',model},systemPrompt:name+'的工作职责',delegateIds,
  });
  const a=add('编辑甲','worker','executor'),b=add('编辑乙','worker','executor');
  const m1=add('主编甲','manager','coordinator',[a.id]),m2=add('主编乙','manager','planner',[b.id]);
  const o=add('总编','orchestrator','planner',[m1.id,m2.id]);
  return {a,b,m1,m2,o};
}

test('phase one binds an explicit editor and resolves only the visible named versioned configurations',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'named-roles-')),studio=await createStudio({dataDir:dir,drama:true});
  t.after(async()=>{await studio.close();await rm(dir,{recursive:true,force:true});});
  const host=studio.drama!,drama=new DramaStore(host.store),flow=new DramaWorkflow(drama,host,studio);
  const {a,m1,m2,o}=roles(drama);
  assert.deepEqual(drama.agent(o.id).delegateIds,[m1.id,m2.id]);
  assert.throws(()=>drama.saveAgent({...a,expectedVersion:a.version,delegateIds:[m1.id]}),/不能委派/);
  const first=drama.createProject({name:'一位负责人'});
  assert.equal(first.editorAgentId,o.id);
  const another=drama.saveAgent({name:'另一位总编',role:'orchestrator',selection:o.selection});
  const project=drama.createProject({name:'多位负责人'});
  assert.equal(project.editorAgentId,undefined);
  assert.throws(()=>flow.newEditor(project.id,{requestId:'ambiguous'}),/选择负责总编/);
  drama.bindEditor(project.id,another.id);
  assert.equal(flow.newEditor(project.id,{requestId:'chosen'}).agent,another.name);
  const retired=drama.saveAgent({...m2,expectedVersion:m2.version,retired:true});
  assert.ok(drama.listAgents(true).some(x=>x.id===retired.id&&x.retired));
  assert.ok(!drama.listAgents().some(x=>x.id===retired.id));
  assert.equal(drama.agent(m2.id,1).retired,false);
});

test('named orchestrator splits a node between two named managers; both Worker sessions run before human release',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'drama-role-fanout-')),studio=await createStudio({dataDir:dir,drama:true,demoDelayMs:360});
  t.after(async()=>{await studio.close();await rm(dir,{recursive:true,force:true});});
  const host=studio.drama!,drama=new DramaStore(host.store),flow=new DramaWorkflow(drama,host,studio);
  const {a,b,m1,m2,o}=roles(drama);
  const project=drama.createProject({name:'两个专属编辑组'});
  const node=(id:string,agentId:string)=>({id,agentId,title:id,x:1,y:1,release:'manual'});
  drama.saveGraph(project.id,1,{nodes:[node('planning',o.id),node('downstream',a.id)],edges:[{from:'planning',to:'downstream'}]});
  const run=flow.start(project.id,{nodeIds:['planning'],includeDownstream:true,requestId:'run'});
  const current=()=>{flow.refresh(project.id);return flow.list(project.id).find(x=>x.id===run.id)!.nodes;};
  const nodes=await until(current,ns=>ns[0].childTasks.filter(c=>c.role==='worker'&&c.status==='running').length===2);
  assert.equal(nodes[0].childTasks.length,4);
  const [ma,mb]=[m1,m2].map(m=>nodes[0].childTasks.find(c=>c.agentId===m.id)!);
  assert.equal(ma.role,'manager');assert.equal(mb.role,'manager');
  assert.notEqual(host.store.agent(ma.assignedAgentId!)!.selection.model,host.store.agent(mb.assignedAgentId!)!.selection.model);
  assert.equal(nodes[0].childTasks.find(c=>c.agentId===a.id)?.parentTaskId,ma.id);
  assert.equal(nodes[0].childTasks.find(c=>c.agentId===b.id)?.parentTaskId,mb.id);
  const complete=await until(current,ns=>ns[0].status==='review');
  assert.equal(complete[1].status,'waiting');assert.ok(complete[0].childTasks.every(c=>c.status==='completed'));
  assert.match(complete[0].artifact!.content,/离线协调验收/);
  flow.review(project.id,complete[0].id,{decision:'approve',requestId:'gate',artifactId:complete[0].artifact!.id});
  assert.equal(current()[1].handoff?.[0].artifactId,complete[0].artifact!.id);
  assert.equal(flow.editor(project.id).sessionId,undefined);
  const history=await flow.history(project.id,complete[0].id,0);
  assert.ok(history.events.some(e=>e.kind==='调用 studio_split'&&e.agent===o.name));
  assert.ok(history.events.some(e=>e.kind==='工具结果 studio_probe'&&e.agent===a.name));
  assert.equal(history.drafts[0].id,complete[0].artifact!.id);
  assert.equal(history.reviews.length,1);
  const chat=await flow.editorMessage(project.id,{requestId:'another',mode:'task',text:'为这项工作分头准备'});
  const rootTask=chat.tasks[0]!;
  const done=await until(()=>host.store.task(rootTask.id)!,v=>v.status==='completed');
  assert.equal(done.childTaskIds?.length,2);
  assert.deepEqual(new Set(done.childTaskIds!.map(id=>host.store.task(id)!.drama!.agentId)),new Set([m2.id,m1.id]));
});

test('interrupted parallel work resumes one child, preserves sibling results, and supports local retry and revision',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'drama-child-recover-'));
  let store=new StudioStore(dir);
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const drama=new DramaStore(store),{a,b,m1,m2,o}=roles(drama);
  const makeEngine=()=>new TaskEngine(store,{assignment:id=>({agent:new DramaStore(store).agent(id),skills:[]})});
  let engine=makeEngine();
  store.saveRun({id:'run',orchestratorId:'boss',title:'故障恢复',dramaProjectId:'p',createdAt:'now',mode:'auto',status:'idle'});
  store.saveAgent({id:'boss',runId:'run',sessionId:'boss-session',parentId:null,createdBy:null,templateId:o.id,templateVersion:1,
    role:'orchestrator',systemPrompt:o.systemPrompt,selection:o.selection,name:o.name,status:'dormant',createdAt:'now',
    memoryIdentityId:'boss-mem',delegateIds:[m1.id,m2.id]});
  const root=engine.createDramaTask({runId:'run',projectId:'p',nodeRunId:'node',requestId:'node',worker:o,prompt:'汇总'});
  const begin=(id:string)=>{const d=store.deliveries('run').find(d=>d.taskId===id&&d.state==='pending')!;assert.ok(d);engine.beginDelivery(d.id);return d;};
  const rootTurn=begin(root.id);
  assert.throws(()=>engine.split('boss',root.id,[{agentId:a.id,prompt:'越级分派'}]),/允许的委派/);
  const [left,right]=engine.split('boss',root.id,[{agentId:m1.id,prompt:'A'},{agentId:m2.id,prompt:'B'}]);
  assert.equal(store.delivery(rootTurn.id)!.state,'done');
  const managerOf=(id:string)=>store.task(id)!.assignedAgentId!;
  const lTurn=begin(left),rTurn=begin(right);
  assert.throws(()=>engine.split(managerOf(left),left,[{agentId:b.id,prompt:'他组任务'}]),/允许的委派/);
  const [lw]=engine.split(lTurn.agentId,left,[{agentId:a.id,prompt:'A 的稿件'}]);
  const [rw]=engine.split(rTurn.agentId,right,[{agentId:b.id,prompt:'B 的稿件'}]);
  const finishWorker=(id:string,text:string)=>{
    const turn=begin(id);engine.report(turn.agentId,{taskId:id,attemptId:turn.attemptId!,text});
    engine.finishDelivery(turn.id);
  };
  finishWorker(lw,'A 已核定');
  begin(left);engine.decide(managerOf(left),left,'submit','A 已验收，保留');
  engine.pauseDramaTask('run',rw);
  engine.pauseDramaTask('run',root.id);
  assert.throws(()=>engine.resumeDramaTask('run',right),/恢复已暂停的上级/);
  engine.resumeDramaTask('run',root.id);
  assert.equal(store.task(rw)!.status,'paused','a parent resume preserves an independent child hold');
  engine.resumeDramaTask('run',rw);
  const lost=begin(rw);store.close();store=new StudioStore(dir);engine=makeEngine();engine.recover();
  assert.equal(store.attempt(lost.attemptId!)!.status,'interrupted');
  const retried=begin(rw);engine.failDelivery(retried.id,'模拟 Worker 重试耗尽',1,0);
  assert.equal(store.task(rw)!.status,'failed');
  assert.equal(store.task(left)!.status,'completed');
  engine.pauseDramaTask('run',root.id);
  assert.throws(()=>engine.retryTask('run',rw),/恢复上级/);
  assert.equal(store.task(rw)?.status,'failed');
  engine.resumeDramaTask('run',root.id);
  engine.retryTask('run',rw);finishWorker(rw,'B 的初稿');
  begin(right);engine.decide(managerOf(right),right,'revise','改好末段',rw);
  assert.equal(store.task(right)!.status,'running');
  const revision=store.deliveries('run').find(d=>d.taskId===rw&&d.state==='pending')!;
  assert.match(revision.text,/B 的初稿/);assert.match(revision.text,/改好末段/);
  finishWorker(rw,'B 的二稿');begin(right);engine.decide(managerOf(right),right,'submit','B 已验收');
  assert.deepEqual(store.attempts(rw).map(a=>a.status),['interrupted','failed','reported','reported']);
  assert.deepEqual(store.attempts(rw).slice(-2).map(a=>a.summary),['B 的初稿','B 的二稿']);
  assert.equal(store.attempts(lw).length,1);
  begin(root.id);engine.decide('boss',root.id,'submit','A + B 的最终稿');
  assert.equal(store.task(root.id)!.result,'A + B 的最终稿');
  assert.equal(store.tasks('run').length,5);

  const other=engine.createTask('run',{requestId:'other',prompt:'独立任务'});
  const cancel=engine.createTask('run',{requestId:'cancel',prompt:'停止此任务'});
  begin(cancel.id);const [group]=engine.split('boss',cancel.id,[{agentId:m1.id,prompt:'独立组'}]);begin(group);
  const [member]=engine.split(managerOf(group),group,[{agentId:a.id,prompt:'独立执行'}]);begin(member);
  engine.cancelTask('run',cancel.id);
  assert.ok([cancel.id,group,member].every(id=>store.task(id)?.status==='cancelled'));
  assert.equal(store.task(other.id)?.status,'queued');
});

test('project editor and Manager read pinned Skills; a freely delegated Worker receives only its own live network grant',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'drama-delegate-tools-'));
  const ctx=new Context(),agents=new Map<string,Agent>(),gates=new Map<string,()=>void>();
  ctx.on('agent/created',({agent})=>agent.ctx.on('agent/request',async(_event,next)=>{
    const request=await next();
    if(!agents.has(agent.id)) {agents.set(agent.id,agent);await new Promise<void>(resolve=>gates.set(agent.id,resolve));}
    return request;
  }));
  let source:DramaStore;
  const requests:string[]=[];
  const studio=await mountStudio(ctx,{dataDir:dir,drama:true,dramaNetwork:async input=>{
    if(!source.networkAllowed(input.agentId,input.grantId)) throw new Error('公开网络授权已撤销');
    requests.push(input.agentId);return {sources:[]};
  }});
  t.after(async()=>{for(const done of gates.values()) done();await studio.close();await rm(dir,{recursive:true,force:true});});
  const host=studio.drama!;source=new DramaStore(host.store);
  const workflow=new DramaWorkflow(source,host,studio),skill=source.saveSkill({name:'组内方法',summary:'先查摘要',body:'版本一的核验方法'});
  const add=(role:Role,children:string[]=[])=>source.saveAgent({name:role,role,systemPrompt:'验证职责',skillIds:[skill.id],delegateIds:children,
    selection:{provider:'studio-demo',model:'executor'},publicNetwork:role==='worker'});
  const worker=add('worker'),manager=add('manager',[worker.id]),boss=add('orchestrator',[manager.id]);
  const project=source.createProject({name:'自由任务权限',editorAgentId:boss.id});
  const editor=await workflow.editorMessage(project.id,{requestId:'task',mode:'task',text:'委派调研'});
  const call=(agent:Agent,name:string,args:Record<string,unknown>)=>ctx.tools.execute({agent,name,callId:CallId(crypto.randomUUID()),signal:new AbortController().signal,arguments:args});
  for(const config of [boss,manager,worker]) {
    const member=await until(()=>host.store.agents(editor.sessionId!).find(a=>a.templateId===config.id&&agents.has(a.sessionId)),v=>!!v);
    const live=agents.get(member!.sessionId)!;
    const task=host.store.tasks(editor.sessionId!).find(t=>t.assignedAgentId===member!.id)!;
    const scope=member!.role==='worker'?{taskId:task.id,attemptId:task.latestAttemptId}:{taskId:task.id};
    const directory=await call(live,'drama_skill_list',scope);
    assert.notEqual(directory.isError,true);
    assert.doesNotMatch(JSON.stringify(directory.content),/版本一的核验方法/);
    const read=await call(live,'drama_skill_read',{...scope,skillId:skill.id,version:1});
    assert.notEqual(read.isError,true);
    assert.match(JSON.stringify(read.content),/版本一的核验方法/);
    const network=await call(live,'studio_web_search',{...scope,value:'民俗'});
    if(config.role==='worker') {
      assert.notEqual(network.isError,true);
      source.saveAgent({...worker,publicNetwork:false,expectedVersion:worker.version});
      assert.equal((await call(live,'studio_web_search',{...scope,value:'民俗'})).isError,true);
    } else assert.equal(network.isError,true);
    gates.get(member!.sessionId)!();
  }
  assert.deepEqual(requests,[worker.id]);
  await until(()=>host.store.task(editor.tasks[0].id)!,v=>v.status==='completed');
});

test('admitted graph nodes never acquire a later or replacement network grant while waiting for handoff',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'drama-admission-grants-'));
  const studio=await createStudio({dataDir:dir,drama:true});
  t.after(async()=>{await studio.close();await rm(dir,{recursive:true,force:true});});
  const host=studio.drama!,drama=new DramaStore(host.store),flow=new DramaWorkflow(drama,host,studio);
  const named=(name:string,network:boolean)=>drama.saveAgent({name,selection:{provider:'studio-demo',model:'executor'},publicNetwork:network});
  const gate=named('人工关口',false),late=named('后来开启',false),replaced=named('撤销后重开',true),stable=named('原授权',true),legacy=named('旧版等待项',true);
  const project=drama.createProject({name:'网络快照'});
  const configs=[gate,late,replaced,stable,legacy];
  const nodes=configs.map((agent,i)=>({id:'n'+i,title:agent.name,agentId:agent.id,x:i,y:0,release:'manual'}));
  drama.saveGraph(project.id,1,{nodes,edges:nodes.slice(1).map(n=>({from:'n0',to:n.id}))});
  const run=flow.start(project.id,{requestId:'before-change',nodeIds:['n0'],includeDownstream:true});
  const stableGrant=drama.networkGrant(stable.id)!.id;
  const original=drama.networkGrant(replaced.id)!.id;
  assert.equal(run.nodes[1].admittedNetworkGrantId,null);
  assert.equal(run.nodes[2].admittedNetworkGrantId,original);
  // Emulate a waiting row persisted by the earlier schema; it carries no authorization evidence.
  host.store.db.prepare("UPDATE drama_node_runs SET document=json_remove(document,'$.admittedNetworkGrantId') WHERE id=?").run(run.nodes[4].id);
  drama.saveAgent({...late,expectedVersion:late.version,publicNetwork:true});
  const revoked=drama.saveAgent({...replaced,expectedVersion:replaced.version,publicNetwork:false});
  drama.saveAgent({...revoked,expectedVersion:revoked.version,publicNetwork:true});
  assert.notEqual(drama.networkGrant(replaced.id)?.id,original);
  const seq=()=>{flow.refresh(project.id);return flow.list(project.id).find(r=>r.id===run.id)!.nodes;};
  const initial=await until(seq,r=>r[0].status==='review');
  flow.review(project.id,initial[0].id,{decision:'approve',requestId:'approve',artifactId:initial[0].artifact!.id});
  const granted=(index:number)=>host.store.task(seq()[index].taskId!)!.drama?.publicNetworkGrantId;
  assert.equal(granted(1),undefined);
  assert.equal(granted(2),undefined);
  assert.equal(granted(3),stableGrant);
  assert.equal(granted(4),undefined);
  const after=flow.start(project.id,{nodeIds:['n1','n2'],requestId:'after-change'});
  assert.equal(after.nodes[0].admittedNetworkGrantId,drama.networkGrant(late.id)?.id);
  assert.equal(after.nodes[1].admittedNetworkGrantId,drama.networkGrant(replaced.id)?.id);
});
