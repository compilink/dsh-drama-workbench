import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {DramaStore} from '../src/drama-store.js';
import {DramaWorkflow} from '../src/drama-workflow.js';
import {createStudio} from '../src/runtime.js';
import {TaskEngine} from '../src/task-engine.js';

test('large node instructions, delegated directions, Worker drafts and Manager submissions retain their entire text', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'drama-long-text-'));
  const studio = await createStudio({dataDir, drama:true, scheduler:{pollIntervalMs:60000}});
  t.after(async () => { await studio.close(); await rm(dataDir, {recursive:true,force:true}); });
  const host = studio.drama!;
  const works = new DramaStore(host.store);
  const selection = {provider:'studio-demo',model:'executor'};
  const writer = works.saveAgent({name:'编剧',role:'worker',selection});
  const editor = works.saveAgent({name:'主编',role:'manager',selection,delegateIds:[writer.id]});
  const project = works.createProject({name:'长篇剧本'});
  const chapter = '分集台词'.repeat(20_000) + '【末场】';
  const instruction = '节点说明\n' + chapter;
  works.saveGraph(project.id,1,{nodes:[{id:'edit',title:'修订',agentId:editor.id,instruction,x:0,y:0}],edges:[]});
  assert.equal(works.graph(project.id).nodes[0]!.instruction,instruction);
  const run = host.createRun({projectId:project.id,title:'审稿'});
  const task = host.dispatch({runId:run.id,projectId:project.id,nodeRunId:'edit',requestId:'edit',worker:editor,prompt:instruction});
  assert.equal(task.prompt,instruction);
  const engine = new TaskEngine(host.store,{assignment:id=>({agent:works.agent(id),skills:[]})});
  const claim = (taskId: string) => {
    const delivery = host.store.deliveries(run.id).find(item=>item.taskId === taskId && item.state === 'pending')!;
    assert.ok(delivery && engine.beginDelivery(delivery.id));
    return delivery;
  };
  claim(task.id);
  const directions = '请编辑\n' + chapter;
  const [childId] = engine.split(task.assignedAgentId!,task.id,[{agentId:writer.id,prompt:directions}]);
  const child = claim(childId);
  assert.equal(child.text,directions);
  engine.report(child.agentId,{taskId:childId,attemptId:child.attemptId!,text:chapter});
  engine.finishDelivery(child.id);
  assert.equal(host.store.task(childId)!.result,chapter);
  claim(task.id);
  const finalDraft = chapter + '\n终稿';
  engine.decide(task.assignedAgentId!,task.id,'submit',finalDraft);
  assert.equal(host.store.task(task.id)!.result,finalDraft);
});

test('reopening queued work rechecks an earlier character-limit refusal and keeps the exact materials', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'drama-old-input-limit-'));
  const studio = await createStudio({dataDir, drama:true});
  t.after(async () => { await studio.close(); await rm(dataDir, {recursive:true,force:true}); });
  const host = studio.drama!;
  const works = new DramaStore(host.store);
  const writer = works.saveAgent({name:'编剧',role:'worker',selection:{provider:'studio-demo',model:'executor'}});
  const project = works.createProject({name:'旧版待执行'});
  const manuscript = '对白'.repeat(35_000) + '原稿结尾。';
  const material = works.saveDocument(project.id,{name:'分集稿',content:manuscript});
  works.saveGraph(project.id,1,{nodes:[{id:'edit',title:'修订',agentId:writer.id,inputRule:'检查结尾',x:0,y:0}],edges:[]});
  const reviewed: string[] = [];
  const workflow = new DramaWorkflow(works,{...host,checkRule:async ({content})=>{
    reviewed.push(content);
    return {status:'passed',reason:'收到全稿'};
  }},studio);
  const plan = workflow.start(project.id,{nodeIds:['edit'],requestId:'old',overrides:{edit:{documents:[material]}}});
  await new Promise(resolve=>setImmediate(resolve));
  const nodeId = plan.nodes[0]!.id;
  host.store.db.prepare(`UPDATE drama_node_runs SET document=json_set(document,'$.inputCheck.status','unknown','$.inputCheck.reason',?) WHERE id=?`)
    .run('无法确认规则：校验材料 '+manuscript.length+' 字符，超过 48000',nodeId);
  reviewed.length = 0;
  workflow.refresh(project.id);
  await new Promise(resolve=>setImmediate(resolve));
  workflow.refresh(project.id);
  const current = workflow.list(project.id)[0]!.nodes[0]!;
  assert.equal(current.inputCheck?.status,'passed');
  assert.ok(current.taskId);
  assert.deepEqual(reviewed,[manuscript]);
});
