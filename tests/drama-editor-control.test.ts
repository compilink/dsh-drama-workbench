import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { startEditorModelFixture } from './fixtures/editor-model.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createStudio } from '../src/runtime.js';
import { TaskEngine } from '../src/task-engine.js';
import { startServer } from '../src/server.js';
import { DramaStore } from '../src/drama-store.js';
import { DramaWorkflow } from '../src/drama-workflow.js';
import { editorControls } from '../src/drama-editor-control.js';
import type { DeliveryView, Studio } from '../src/types.js';

async function waitFor(ready:()=>boolean|Promise<boolean>) {
  const end=Date.now()+12000;
  while(Date.now()<end){if(await ready())return;await delay(25);}
  assert.fail('Timed out waiting for the persisted action');
}
function open(studio:Studio) {
  const host=studio.drama!,drama=new DramaStore(host.store),workflow=new DramaWorkflow(drama,host,studio);
  return {host,drama,workflow,control:editorControls(host.store)!};
}
function incoming(runId:string,agentId:string,id:string):DeliveryView {
  return {runId,agentId,id,kind:'message',text:'用户指令',state:'running',failures:0,nextAt:0,createdAt:new Date().toISOString()};
}
test('human confirmation versions a template merge, keeps concurrent user branches and rejects foreign session or project operations',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'drama-editor-cas-'));let studio=await createStudio({dataDir,drama:true});
  try {
    const {drama,workflow,control,host}=open(studio);
    const worker=drama.saveAgent({name:'编辑',role:'worker',selection:{provider:'studio-demo',model:'executor'}});
    const coordinator=drama.saveAgent({name:'作品总编',role:'orchestrator',selection:{provider:'studio-demo',model:'planner'}});
    const project=drama.createProject({name:'草案'}),other=drama.createProject({name:'其他'});
    const session=workflow.newEditor(project.id,{requestId:'new',agentId:coordinator.id});
    const run=host.store.run(session.sessionId!)!,actor=host.store.agent(run.orchestratorId)!,delivery=incoming(run.id,actor.id,'template');
    const node=(id:string,title:string)=>({id,title,agentId:worker.id,x:0,y:0});
    const base=drama.saveGraph(project.id,1,{nodes:[node('chapter','保留用户工作')],edges:[]});
    const template=drama.saveTemplate({name:'分集',nodes:[node('chapter','编写大纲'),node('polish','润色')],edges:[{from:'chapter',to:'polish'}]});
    const input={operation:'propose',templateId:template.id,templateVersion:template.version,graphVersion:base.version};
    const propose=(cmd=delivery,v=input)=>{control.execute(actor,cmd,v);return control.receipts(project.id,run.id).at(-1)!;};
    const first=propose();
    assert.equal(propose().id,first.id);
    assert.equal(control.receipts(project.id,run.id).length,1);
    const draft=control.proposal(project.id,first.id);
    assert.equal(draft.nodes.find(n=>n.id==='chapter')?.title,'保留用户工作');
    assert.deepEqual(draft.edges,[{from:'chapter-2',to:'polish'}]);
    assert.equal(drama.graph(project.id).version,base.version);
    assert.throws(()=>control.proposal(other.id,first.id),/当前作品/);
    const edited=drama.saveGraph(project.id,base.version,{nodes:[...base.nodes,node('mine','手工分支')],edges:[]});
    assert.throws(()=>control.confirm(project.id,first.id,{action:'save'}),/保留草案/);
    assert.equal(control.proposal(project.id,first.id).state,'proposed');
    const fresh={...input,graphVersion:edited.version};
    const second=propose({...delivery,id:'new-command'},fresh);
    const corrected=control.proposal(project.id,second.id);
    corrected.nodes.find(n=>n.id==='polish')!.instruction='手工修订润色要求';
    const confirmation={action:'save',nodes:corrected.nodes,edges:corrected.edges};
    assert.equal(control.confirm(project.id,second.id,confirmation).graphVersion,edited.version+1);
    assert.equal(control.confirm(project.id,second.id,confirmation).graphVersion,edited.version+1);
    assert.equal(drama.graph(project.id).nodes.find(n=>n.id==='polish')?.instruction,'手工修订润色要求');
    assert.equal(drama.graph(project.id).nodes.find(n=>n.id==='mine')?.title,'手工分支');
    assert.throws(()=>control.execute({...actor,id:'unknown'},delivery,{operation:'inspect'}),/只有作品总编/);
    assert.throws(()=>control.execute(actor,{...delivery,kind:'result'},{operation:'inspect'}),/只有作品总编/);
    assert.throws(()=>control.execute(actor,delivery,{operation:'propose',graphVersion:edited.version+1,addEdges:[{from:'polish',to:'chapter-2'}]}),/形成环/);
    assert.equal(control.receipts(project.id,run.id).at(-1)?.state,'failed');
    await studio.close();studio=await createStudio({dataDir,drama:true});
    const restored=open(studio);
    assert.equal(restored.control.receipts(project.id,run.id).find(x=>x.id===second.id)?.state,'saved');
    assert.equal(restored.control.proposal(project.id,first.id).state,'proposed');
  }finally{await studio.close();await rm(dataDir,{recursive:true,force:true});}
});

test('start is replay-safe, stop reaches one run and its waiting descendants while a separate branch completes',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'drama-editor-stop-'));
  const studio=await createStudio({dataDir,drama:true,demoDelayMs:180,scheduler:{pollIntervalMs:15}});
  try{
    const {drama,workflow,control,host}=open(studio);
    const worker=drama.saveAgent({name:'编辑',role:'worker',selection:{provider:'studio-demo',model:'executor'}});
    const chief=drama.saveAgent({name:'总编',role:'orchestrator',selection:{provider:'studio-demo',model:'planner'}});
    const project=drama.createProject({name:'并行'}),other=drama.createProject({name:'外部作品'});
    const session=workflow.newEditor(project.id,{requestId:'editor',agentId:chief.id});
    const run=host.store.run(session.sessionId!)!,actor=host.store.agent(run.orchestratorId)!,d=incoming(run.id,actor.id,'start');
    const graph=drama.saveGraph(project.id,1,{nodes:['one','two','other'].map(id=>({id,title:id,agentId:worker.id,release:'auto',x:0,y:0})),edges:[{from:'one',to:'two'}]});
    const op={operation:'start',graphVersion:graph.version,nodeIds:['one'],includeDownstream:true};
    control.execute(actor,d,op); control.execute(actor,d,op);
    const first=control.receipts(project.id,run.id)[0]!,firstRun=first.runId!;
    assert.equal(workflow.list(project.id).length,1);
    const dispatchRun=host.store.runs().find(r=>r.dramaProjectId===project.id&&r.id!==run.id)!;
    assert.equal(control.projectFor(host.store.agent(dispatchRun.orchestratorId)!),undefined);
    control.execute(actor,{...d,id:'separate'},{operation:'start',graphVersion:graph.version,nodeIds:['other']});
    assert.throws(()=>workflow.stopPlan(other.id,firstRun),/作品中没有/);
    control.execute(actor,{...d,id:'stop'},{operation:'stop',runId:firstRun});
    await waitFor(()=>{
      workflow.refresh(project.id);
      const plans=workflow.list(project.id);
      return !!plans.find(r=>r.id===firstRun)?.stoppedAt&&plans.some(r=>r.id!==firstRun&&r.nodes[0]!.status==='released');
    });
    const stopped=workflow.list(project.id).find(r=>r.id===firstRun)!;
    assert.ok(stopped.nodes.every(n=>n.status==='cancelled'));
    assert.equal(stopped.nodes.find(n=>n.nodeId==='two')?.taskId,undefined);
    assert.equal(control.receipts(project.id,run.id).at(-1)?.state,'stopped');
    const status=control.execute(actor,{...d,id:'inspect'},{operation:'inspect',runId:firstRun});
    assert.match(JSON.stringify(status),/编辑/);
  }finally{await studio.close();await rm(dataDir,{recursive:true,force:true});}
});

test('run inspection reports blocked descendants, exact owners and paged failure reasons without disclosing another branch',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'drama-child-status-'));
  const studio=await createStudio({dataDir,drama:true});
  try {
    const {host,drama,workflow,control}=open(studio),store=host.store;
    const selection={provider:'studio-demo',model:'planner'};
    const worker=drama.saveAgent({name:'编剧',role:'worker',selection});
    const manager=drama.saveAgent({name:'主编',role:'manager',selection,delegateIds:[worker.id]});
    const chief=drama.saveAgent({name:'作品总编',role:'orchestrator',selection,delegateIds:[manager.id,worker.id]});
    const engine=new TaskEngine(store,{assignment:id=>({agent:drama.agent(id),skills:[]})});
    const project=drama.createProject({name:'拆分'}),session=workflow.newEditor(project.id,{agentId:chief.id,requestId:'editor'});
    drama.saveGraph(project.id,1,{nodes:['section','separate'].map(id=>({id,title:id,agentId:chief.id,x:0,y:0})),edges:[]});
    const plan=workflow.start(project.id,{nodeIds:['section','separate'],requestId:'start'});
    for(const node of plan.nodes) {
      const root=store.task(node.taskId!)!;
      const begin=(id:string)=>engine.beginDelivery(store.deliveries(root.runId).find(d=>d.taskId===id&&d.state==='pending')!.id)!;
      begin(root.id);
      const [book,...workers]=engine.split(root.assignedAgentId!,root.id,[{agentId:manager.id,prompt:'审稿'},...Array.from({length:4},(_,i)=>({agentId:worker.id,prompt:'撰写 '+i}))]);
      const member=store.task(book!)!.assignedAgentId!;
      begin(book!);const [reviewed]=engine.split(member,book!,[{agentId:worker.id,prompt:'提交可审稿'}]);
      const pending=begin(reviewed!);engine.report(pending.agentId,{taskId:reviewed!,attemptId:pending.attemptId!,text:'待主编验收'});
      for(const child of workers){const job=begin(child);engine.failDelivery(job.id,node.nodeId+'：'+'超时'.repeat(170),1,0);}
    }
    const editorRun=store.run(session.sessionId!)!,actor=store.agent(editorRun.orchestratorId)!,message=incoming(editorRun.id,actor.id,'inspect');
    type Issue={agent:string;status:string;reason:string};
    type Page={items:Issue[];total:number;offset:number};
    const normal=control.execute(actor,message,{operation:'inspect',runId:plan.id}).observed as {nodes:{items:{nodeId:string;childIssues:Page}[]}};
    const issues=normal.nodes.items.find(n=>n.nodeId==='section')!.childIssues;
    assert.equal(issues.total,5);assert.equal(issues.items.length,3);
    assert.ok(issues.items.some(i=>i.agent==='主编'&&i.status==='review'&&i.reason==='等待负责人验收'));
    const detail=control.execute(actor,message,{operation:'inspect',runId:plan.id,nodeId:'section',offset:3}).observed as {childIssues:Page};
    assert.equal(detail.childIssues.total,5);assert.equal(detail.childIssues.items.length,2);
    assert.ok(detail.childIssues.items.every(i=>i.status==='failed'&&i.agent==='编剧'&&i.reason.startsWith('section：')&&i.reason.length<=240));
  } finally {await studio.close();await rm(dataDir,{recursive:true,force:true});}
});

test('a stop intent survives process loss before task cancellation and never dispatches a waiting downstream on restart',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'drama-editor-stop-recovery-'));
  let studio=await createStudio({dataDir,drama:true,demoDelayMs:500,scheduler:{pollIntervalMs:15}});
  try {
    const host=studio.drama!,drama=new DramaStore(host.store);
    let attempted=false;
    const workflow=new DramaWorkflow(drama,host,{...studio,cancelTask:async()=>{attempted=true;return new Promise<void>(()=>{});}});
    const worker=drama.saveAgent({name:'写手',role:'worker',selection:{provider:'studio-demo',model:'executor'}});
    const chief=drama.saveAgent({name:'总编',role:'orchestrator',selection:{provider:'studio-demo',model:'planner'}});
    const project=drama.createProject({name:'停止恢复'});
    drama.bindEditor(project.id,chief.id);
    drama.saveGraph(project.id,1,{nodes:['a','b'].map(id=>({id,title:id,agentId:worker.id,x:0,y:0,release:'auto'})),edges:[{from:'a',to:'b'}]});
    const first=workflow.start(project.id,{requestId:'begin',nodeIds:['a'],includeDownstream:true});
    const stop=workflow.stopPlan(project.id,first.id);
    assert.ok(attempted&&stop.stopRequestedAt&&!stop.stoppedAt);
    await studio.close();
    studio=await createStudio({dataDir,drama:true,demoDelayMs:500,scheduler:{pollIntervalMs:15}});
    const restored=open(studio);
    await waitFor(()=>{restored.workflow.refresh(project.id);return !!restored.workflow.list(project.id)[0]?.stoppedAt;});
    const plan=restored.workflow.list(project.id)[0]!;
    assert.equal(plan.stopRequestedAt,stop.stopRequestedAt);
    assert.deepEqual(plan.nodes.map(n=>n.status),['cancelled','cancelled']);
    assert.equal(plan.nodes[1]!.taskId,undefined);
  }finally{await studio.close();await rm(dataDir,{recursive:true,force:true});}
});

test('ordinary HTTP editor messages inspect, propose, start and stop through the native tool protocol with real receipts',async()=>{
  const root=await mkdtemp(join(tmpdir(),'drama-editor-wire-'));
  const model=await startEditorModelFixture(root);
  try{
    const server=await startServer({dataDir:join(root,'data'),dshHome:model.home,drama:true,port:0,scheduler:{pollIntervalMs:15}});
    try{
      const {csrfToken}=await fetch(server.url+'/api/bootstrap').then(r=>r.json());
      const api=server.url+'/api/drama';
      const post=async(path:string,value:unknown)=>{
        const response=await fetch(api+path,{method:'POST',headers:{'content-type':'application/json','x-studio-csrf':csrfToken},body:JSON.stringify(value)});
        const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;
      };
      const a=await post('/agents',{role:'orchestrator',name:'在线总编',selection:{provider:'fixture',model:'fixture'}});
      const project=await post('/projects',{name:'同一作品'});
      const route='/projects/'+project.id+'/editor';
      const editor=()=>fetch(api+route).then(r=>r.json());
      const send=async(text:string,action:Record<string,unknown>,requestId:string)=>{
        const reply='本次操作回执 '+requestId;
        model.respond(action,reply);
        await post(route,{mode:'message',text,requestId,agentId:a.id});
        await waitFor(async()=>(await editor()).messages.some((m:{text:string})=>m.text?.includes(reply)));
        const state=await editor();
        assert.equal(state.receipts.at(-1).operation,action.operation);
        return state.receipts.at(-1);
      };
      const worker=await post('/agents',{role:'worker',name:'编辑',selection:{provider:'fixture',model:'fixture'}});
      const template=await post('/templates',{name:'分集模板',nodes:[{id:'outline',title:'分集大纲',agentId:worker.id,inputRule:'至少 1 个文件',x:0,y:0}],edges:[]});
      await send('查看当前作品模板和 Agent',{operation:'inspect'},'natural');
      const proposal=await send('用分集模板搭画布，润色交给编辑',{operation:'propose',graphVersion:1,templateId:template.id,templateVersion:1,upsertNodes:[{id:'polish',title:'润色',agentId:worker.id}],addEdges:[{from:'outline',to:'polish'}]},'draft');
      const draft=await fetch(api+route+'/proposals/'+proposal.id).then(r=>r.json());
      assert.equal(draft.nodes.length,2);
      const confirmed=await post(route+'/proposals/'+proposal.id,{action:'save',nodes:draft.nodes,edges:draft.edges});
      const started=await send('执行分集大纲和下游润色',{operation:'start',graphVersion:confirmed.graphVersion,nodeIds:['outline'],includeDownstream:true},'start');
      await send('这轮卡在哪里',{operation:'inspect',runId:started.runId},'monitor');
      const stopped=await send('停止刚才那一轮',{operation:'stop',runId:started.runId},'stop');
      assert.equal(stopped.state,'stopped');
      const suggestion={role:'manager',name:'史料主编',systemPrompt:'核对时代细节并分工。'};
      const idea=await send('缺一位负责时代考证的主编，请先建议配置',{operation:'suggest_agent',suggestion},'suggest');
      const agentPath=route+'/agent-proposals/'+idea.id;
      const suggestedAgent=await fetch(api+agentPath).then(r=>r.json());
      assert.equal(suggestedAgent.name,suggestion.name);
      assert.equal((await fetch(api+'/agents').then(r=>r.json())).length,2);
      assert.equal((await fetch(api+route+'/proposals/'+idea.id)).status,404);
      const agent={...suggestion,systemPrompt:'只检查史料出处和年代。',selection:{provider:'fixture',model:'fixture'},delegateIds:[worker.id],publicNetwork:false};
      const unknown=await fetch(api+agentPath,{method:'POST',headers:{'content-type':'application/json','x-studio-csrf':csrfToken},body:JSON.stringify({action:'save',agent:{...agent,selection:{provider:'fixture',model:'unknown'}}})});
      assert.equal(unknown.status,400);
      assert.equal((await fetch(api+'/agents').then(r=>r.json())).length,2);
      const saved=await post(agentPath,{action:'save',agent});
      assert.equal((await post(agentPath,{action:'save',agent})).agentId,saved.agentId);
      const agents=await fetch(api+'/agents').then(r=>r.json());
      assert.equal(agents.length,3);
      assert.deepEqual(agents.find((a:{id:string})=>a.id===saved.agentId).delegateIds,[worker.id]);
      assert.deepEqual(agents.find((v:{id:string})=>v.id===a.id).delegateIds,[]);
      assert.ok(model.offered);assert.ok(model.calls>=12);
      assert.deepEqual([...model.replyBudgets], [4096], 'creative requests use the configured model output capacity');
    }finally{await server.close();}
  }finally{await model.close();await rm(root,{recursive:true,force:true});}
});
