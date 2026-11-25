import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {createStudio} from '../src/runtime.js';
import {DramaStore} from '../src/drama-store.js';
import {DramaWorkflow} from '../src/drama-workflow.js';

async function until<T>(read:()=>T,ready:(value:T)=>boolean):Promise<T> {
  const stop=Date.now()+6000;
  let found=read();
  while(!ready(found)&&Date.now()<stop) {await delay(25);found=read();}
  assert.ok(ready(found), JSON.stringify(found));
  return found;
}

test('an immutable approved draft releases a waiting merge, and the graph and handoff survive restart', async () => {
  const dataDir=await mkdtemp(join(tmpdir(),'drama-workflow-'));
  let studio=await createStudio({dataDir,drama:true,scheduler:{pollIntervalMs:15}});
  try {
    const host=studio.drama!;
    const drama=new DramaStore(host.store),workflow=new DramaWorkflow(drama,host,studio);
    const agent=drama.saveAgent({name:'编剧',selection:{provider:'studio-demo',model:'executor'},role:'worker'});
    const project=drama.createProject({name:'双支交接'});
    const other=drama.createProject({name:'独立作品'});
    const node=(id:string,release:'auto'|'manual')=>({id,title:id,agentId:agent.id,instruction:'完成 '+id,release,x:10,y:10});
    const graph=drama.saveGraph(project.id,project.graphVersion,{nodes:[node('research','manual'),node('characters','auto'),{...node('draft','manual'),inputRule:'至少 2 个文件'}],edges:[{from:'research',to:'draft'},{from:'characters',to:'draft'}]});
    assert.equal(graph.version,project.graphVersion+1);
    const command={nodeIds:['research','characters'],includeDownstream:true,requestId:'launch'};
    const run=workflow.start(project.id,command);
    const fetched:string[]=[];
    const getTasks=host.store.tasks.bind(host.store);
    host.store.tasks=(scope)=>{if(scope) fetched.push(scope);return getTasks(scope);};
    try {workflow.list(project.id);} finally {host.store.tasks=getTasks;}
    assert.equal(fetched.length,1,'two worker nodes sharing a dispatch run read its task list once');
    assert.equal(workflow.start(project.id,command).id,run.id);
    assert.throws(()=>workflow.start(project.id,{...command,nodeIds:['draft']}),/提交 ID/);
    const select=(nodeId:string)=>workflow.list(project.id)[0]!.nodes.find(node=>node.nodeId===nodeId)!;
    const note=await until(()=>{
      workflow.refresh(project.id);
      return select('research');
    }, item=>item.status==='review');
    assert.equal(select('draft').status,'waiting');
    assert.ok(!select('draft').taskId);
    assert.throws(()=>workflow.review(other.id,note.id,{decision:'approve',artifactId:note.artifact!.id,requestId:'wrong-scope'}),/Unknown node execution/);
    const approved=workflow.review(project.id,note.id,{decision:'edit',artifactId:note.artifact!.id,content:'汇合须读本次修改的稿件 & 验证',requestId:'edit'});
    assert.notEqual(approved.artifact!.id,note.artifact!.id);
    assert.equal(approved.status,'review');
    assert.throws(()=>workflow.review(project.id,note.id,{decision:'approve',artifactId:note.artifact!.id,requestId:'stale'}),/版本/);
    assert.equal(workflow.review(project.id,note.id,{decision:'approve',artifactId:approved.artifact!.id,requestId:'accept'}).status,'released');
    assert.equal(workflow.review(project.id,note.id,{decision:'approve',artifactId:approved.artifact!.id,requestId:'accept'}).status,'released');
    const merged=await until(()=>{workflow.refresh(project.id);return select('draft');}, item=>item.status==='review');
    assert.equal(merged.handoff?.find(item=>item.nodeId==='research')?.artifactId,approved.artifact!.id);
    const markdown=workflow.export(project.id,approved.artifact!.id,'md');
    assert.match(markdown.bytes.toString(),/汇合须读本次修改/);
    const word=workflow.export(project.id,approved.artifact!.id,'docx');
    assert.equal(word.bytes.readUInt32LE(),0x04034b50);
    assert.ok(word.bytes.includes(Buffer.from('汇合须读本次修改的稿件 &amp; 验证')));
    assert.throws(()=>workflow.export(other.id,approved.artifact!.id,'docx'), /Unknown artifact/);

    await studio.close();
    studio=await createStudio({dataDir,drama:true,scheduler:{pollIntervalMs:15}});
    const restored=new DramaWorkflow(new DramaStore(studio.drama!.store),studio.drama!,studio);
    assert.equal(restored.list(project.id)[0]?.nodes.find(node=>node.nodeId==='draft')?.handoff?.[0]?.artifactId,approved.artifact!.id);
    assert.equal(restored.export(project.id,approved.artifact!.id,'docx').hash,word.hash);
    const rerun=restored.start(project.id,{nodeIds:['research'],includeDownstream:true,requestId:'rerun'});
    assert.notEqual(rerun.id,run.id);
    assert.equal(rerun.nodes.find(node=>node.nodeId==='draft')?.status,'waiting');
    assert.equal(restored.list(project.id)[0]?.nodes.find(node=>node.nodeId==='draft')?.artifact?.id,merged.artifact?.id);
  } finally {await studio.close();await rm(dataDir,{recursive:true,force:true});}
});

test('malformed or unknown configured checks prevent dispatch without losing attached document versions', async () => {
  const dataDir=await mkdtemp(join(tmpdir(),'drama-checks-'));
  const studio=await createStudio({dataDir,drama:true});
  try {
    const host=studio.drama!;
    const drama=new DramaStore(host.store),workflow=new DramaWorkflow(drama,host,studio);
    const agent=drama.saveAgent({name:'编剧',selection:{provider:'studio-demo',model:'executor'}});
    const project=drama.createProject({name:'校验'});
    const document=drama.saveDocument(project.id,{name:'设定',content:'旧版本'});
    drama.saveDocument(project.id,{id:document.id,expectedVersion:document.version,name:'设定',content:'新版本'});
    drama.saveGraph(project.id,project.graphVersion,{nodes:[{id:'stage',title:'剧本',agentId:agent.id,x:1,y:1,inputRule:'必须包含「新版本」'}],edges:[]});
    workflow.saveNodeInputs(project.id,'stage',{documents:[{id:document.id,version:document.version}]});
    const run=workflow.start(project.id,{nodeIds:['stage'],requestId:'start'});
    assert.equal(run.nodes[0]?.status,'waiting');
    assert.match(run.nodes[0]?.reason??'',/检查未通过/);
    assert.equal(run.nodes[0]?.taskId,undefined);
    assert.equal(workflow.nodeInputs(project.id,'stage').documents?.[0]?.version,document.version);
  } finally {await studio.close();await rm(dataDir,{recursive:true,force:true});}
});

test('an admitted restart survives unsuccessful cancellation and never admits a duplicate replacement', async () => {
  const dataDir=await mkdtemp(join(tmpdir(),'drama-durable-restart-'));
  let studio=await createStudio({dataDir,drama:true,demoDelayMs:500,scheduler:{pollIntervalMs:15}});
  try {
    const host=studio.drama!;
    const drama=new DramaStore(host.store);
    const interrupted={...studio,cancelTask:async()=>{throw new Error('simulated crash boundary');}};
    const workflow=new DramaWorkflow(drama,host,interrupted);
    const worker=drama.saveAgent({name:'编剧',selection:{provider:'studio-demo',model:'executor'}});
    const project=drama.createProject({name:'后台续跑'});
    drama.saveGraph(project.id,project.graphVersion,{nodes:[{id:'draft',title:'正文',agentId:worker.id,x:0,y:0}],edges:[]});
    const original=workflow.start(project.id,{nodeIds:['draft'],requestId:'first'});
    const id=original.nodes[0]!.id;
    const restart={action:'restart' as const,requestId:'one-restart'};
    await assert.rejects(workflow.action(project.id,id,restart),/未确认旧任务已停止/);
    const pending=workflow.list(project.id).find(plan=>plan.id!==original.id)!;
    assert.equal(pending.nodes[0]!.status,'waiting');
    assert.equal(pending.nodes[0]!.taskId,undefined);
    await studio.close();

    studio=await createStudio({dataDir,drama:true,scheduler:{pollIntervalMs:15}});
    const resumedHost=studio.drama!;
    const restored=new DramaWorkflow(new DramaStore(resumedHost.store),resumedHost,studio);
    const cancelled=await until(()=>{
      restored.refresh(project.id);
      return restored.list(project.id).find(plan=>plan.id===original.id)!.nodes[0]!;
    },node=>node.status==='cancelled');
    assert.equal(cancelled.taskId,original.nodes[0]!.taskId);
    const replacement=await restored.action(project.id,id,restart);
    assert.ok('nodes' in replacement);
    assert.equal(replacement.id,pending.id);
    assert.equal((await restored.action(project.id,id,{...restart,requestId:'duplicate-click'})).id,pending.id);
    assert.equal(restored.list(project.id).length,2);
    const current=await until(()=>{
      restored.refresh(project.id);
      return restored.list(project.id).find(plan=>plan.id===pending.id)!.nodes[0]!;
    },node=>node.status==='review');
    assert.notEqual(current.taskId,original.nodes[0]!.taskId);
  } finally {await studio.close();await rm(dataDir,{recursive:true,force:true});}
});

test('a graph launched first does not bind the visible editor conversation to its background Agent', async () => {
  const dataDir=await mkdtemp(join(tmpdir(),'drama-editor-choice-'));
  const studio=await createStudio({dataDir,drama:true,scheduler:{pollIntervalMs:15}});
  try {
    const host=studio.drama!;
    const drama=new DramaStore(host.store);
    const workflow=new DramaWorkflow(drama,host,studio);
    const worker=drama.saveAgent({name:'编剧',selection:{provider:'studio-demo',model:'executor'}});
    const editor=drama.saveAgent({name:'指定总编',role:'orchestrator',selection:{provider:'studio-demo',model:'planner'}});
    const project=drama.createProject({name:'总编对话'});
    drama.saveGraph(project.id,project.graphVersion,{nodes:[{id:'draft',title:'正文',agentId:worker.id,x:0,y:0}],edges:[]});
    workflow.start(project.id,{nodeIds:['draft'],requestId:'graph-first'});
    assert.equal(workflow.editor(project.id).agent,undefined);
    const message={text:'请查看制作进展',mode:'message' as const,requestId:'editor-message',agentId:editor.id};
    const conversation=await workflow.editorMessage(project.id,message);
    assert.equal(conversation.agent,'指定总编');
    assert.deepEqual(conversation.tasks,[]);
    const duplicate=await workflow.editorMessage(project.id,message);
    assert.equal(duplicate.messages.filter(item=>item.role==='user').length,1);
    assert.equal(host.store.runs().filter(run=>run.dramaProjectId===project.id).length,2);
  } finally {await studio.close();await rm(dataDir,{recursive:true,force:true});}
});

test('semantic checks gate execution and approval separately, and persist status for the exact revision', async () => {
  const dataDir=await mkdtemp(join(tmpdir(),'drama-semantic-'));
  const studio=await createStudio({dataDir,drama:true,scheduler:{pollIntervalMs:15}});
  try {
    const host=studio.drama!;
    const drama=new DramaStore(host.store);
    const checks:string[]=[];
    const workflow=new DramaWorkflow(drama,{...host,checkRule:async ({rule,content})=>{
      checks.push(rule);
      if(rule==='主角身份与设定一致') return {status:'passed',reason:'设定明确'};
      if(rule==='改编范围充分') return {status:'failed',reason:'缺少人物线'};
      return content==='修订后的正文'?{status:'passed',reason:'证据充分'}:{status:'unknown',reason:'没有证据'};
    }},studio);
    const skill=drama.saveSkill({name:'校对指引',summary:'场次校对',body:'核对事实'});
    const worker=drama.saveAgent({name:'编剧',selection:{provider:'studio-demo',model:'executor'},skillIds:[skill.id]});
    const project=drama.createProject({name:'语义校验'});
    const doc=drama.saveDocument(project.id,{name:'设定',content:'主角是一名摄影师。'});
    const node=(id:string,inputRule:string,outputRule:string)=>({id,title:id,agentId:worker.id,inputRule,outputRule,x:0,y:0});
    drama.saveGraph(project.id,project.graphVersion,{nodes:[node('draft','主角身份与设定一致','剧情没有脱离原作'),node('blocked','改编范围充分','')],edges:[]});
    const run=workflow.start(project.id,{nodeIds:['draft','blocked'],requestId:'semantic',overrides:{draft:{documents:[doc]},blocked:{documents:[doc]}}});
    assert.equal(run.nodes[0]!.inputCheck?.status,'pending');
    assert.equal(run.nodes[0]!.taskId,undefined);
    assert.equal(run.nodes[0]!.skills?.[0]?.version,skill.version);
    const read=(id:string)=>workflow.list(project.id)[0]!.nodes.find(item=>item.nodeId===id)!;
    const rejected=await until(()=>{workflow.refresh(project.id);return read('draft');},item=>item.status==='rejected');
    assert.equal(rejected.outputCheck?.status,'unknown');
    assert.match(rejected.reason??'',/无法确认规则/);
    assert.equal(host.store.task(rejected.taskId!)?.drama?.skills?.[0]?.version,skill.version);
    assert.equal(read('blocked').inputCheck?.status,'failed');
    assert.equal(read('blocked').taskId,undefined);
    assert.throws(()=>workflow.review(project.id,rejected.id,{decision:'approve',artifactId:rejected.artifact!.id,requestId:'too-early'}),/审稿状态/);
    const edited=workflow.review(project.id,rejected.id,{decision:'edit',artifactId:rejected.artifact!.id,content:'修订后的正文',requestId:'semantic-edit'});
    assert.equal(edited.status,'checking_output');
    const ready=await until(()=>{workflow.refresh(project.id);return read('draft');},item=>item.status==='review');
    assert.equal(ready.outputCheck?.status,'passed');
    assert.notEqual(ready.artifact!.id,rejected.artifact!.id);
    assert.throws(()=>workflow.review(project.id,ready.id,{decision:'approve',artifactId:rejected.artifact!.id,requestId:'stale'}),/版本/);
    assert.equal(workflow.review(project.id,ready.id,{decision:'approve',artifactId:ready.artifact!.id,requestId:'final'}).status,'released');
    assert.deepEqual(checks,['主角身份与设定一致','改编范围充分','剧情没有脱离原作','剧情没有脱离原作']);
  } finally {await studio.close();await rm(dataDir,{recursive:true,force:true});}
});
