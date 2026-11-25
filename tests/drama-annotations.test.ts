import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import { ArtifactEpisodes } from '../src/drama-artifact-episodes.js';
import { DramaAnnotations } from '../src/drama-annotations.js';
import { DramaStore } from '../src/drama-store.js';
import { DramaWorkflow } from '../src/drama-workflow.js';
import { TaskEngine } from '../src/task-engine.js';
import { createStudio } from '../src/runtime.js';

test('anchored feedback creates one durable task and only applies a reviewed candidate to the exact source',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'drama-annotation-'));
  const studio=await createStudio({dataDir,drama:true,scheduler:{pollIntervalMs:10}});
  try {
    const host=studio.drama!, drama=new DramaStore(host.store), workflow=new DramaWorkflow(drama,host,studio);
    const notes=new DramaAnnotations(drama,workflow,host.store);
    const writer=drama.saveAgent({name:'编剧',role:'worker',selection:{provider:'studio-demo',model:'executor'}});
    drama.saveAgent({name:'总编',role:'orchestrator',delegateIds:[writer.id],selection:{provider:'studio-demo',model:'planner'}});
    const project=drama.createProject({name:'第一部作品'}), other=drama.createProject({name:'另一部作品'});
    const doc=drama.saveDocument(project.id,{name:'第1集',kind:'episode',episode:1,content:'他说：等等。'});
    const input={source:'episode',sourceId:doc.id,version:doc.version,start:3,end:5,selectedText:'等等',text:'让台词更紧迫',dispatch:true,requestId:'submit'};
    const saved=notes.add(project.id,input);
    assert.ok(saved.taskId);
    assert.equal(saved.taskId,notes.add(project.id,input).taskId);
    assert.equal(drama.listEpisodeComments(project.id).length,1);
    assert.equal(notes.links(project.id,saved.runId)[0]?.taskId,saved.taskId);
    assert.throws(()=>notes.add(project.id,{...input,text:'不同意见'}),/不同批注/);
    assert.throws(()=>notes.add(other.id,input),/不存在/);
    assert.throws(()=>notes.add(project.id,{...input,requestId:'mismatch',selectedText:'不匹配'}),/选区/);
    const ready=async(id:string)=>{
      const deadline=Date.now()+12000;
      while(Date.now()<deadline) {
        const entry=notes.list(project.id).find(n=>n.id===id)!;
        if(entry.candidate) return entry;
        if(entry.status==='failed'||entry.status==='blocked') assert.fail(JSON.stringify({status:entry.status,error:entry.error,branch:entry.runId?host.store.tasks(entry.runId).map(t=>[t.status,t.error]):[]}));
        await wait(20);
      }
      assert.fail('批注任务未提交验收结果：'+JSON.stringify(notes.list(project.id).find(n=>n.id===id)));
    };
    const candidate=await ready(saved.id);
    assert.ok(candidate.candidate);
    assert.equal(drama.document(project.id,doc.id).version,1);
    const decision={decision:'apply',replacement:'快走',requestId:'apply'};
    const resolved=notes.resolve(project.id,saved.id,decision);
    assert.equal(resolved.status,'applied');
    assert.equal(notes.resolve(project.id,saved.id,decision).revision?.version,2);
    assert.equal(drama.document(project.id,doc.id).content,'他说：快走。');
    assert.equal(drama.document(project.id,doc.id,1).content,doc.content);
    assert.throws(()=>notes.resolve(project.id,saved.id,{...decision,replacement:'再改'}),/已经处理/);
    const refusal=notes.add(project.id,{...input,version:2,selectedText:'快走',requestId:'refusal'});
    const assigned=host.store.task(refusal.taskId!)!;
    new TaskEngine(host.store).decide(assigned.assignedAgentId!,assigned.id,'reject','退回意见：证据不足');
    const rejected=notes.list(project.id).find(note=>note.id===refusal.id)!;
    assert.equal(rejected.status,'rejected');
    assert.equal(rejected.candidate,undefined);
    assert.match(rejected.error!,/证据不足/);
    assert.throws(()=>notes.resolve(project.id,refusal.id,decision),/没有可审阅/);
    assert.equal(drama.document(project.id,doc.id).version,2);
    const conflicting=notes.add(project.id,{...input,version:2,selectedText:'快走',requestId:'conflict'});
    drama.saveDocument(project.id,{id:doc.id,expectedVersion:2,name:doc.name,content:'人工先行修订'});
    await ready(conflicting.id);
    assert.throws(()=>notes.resolve(project.id,conflicting.id,{...decision,requestId:'stale'}),/源稿已更新/);
    assert.equal(notes.resolve(project.id,conflicting.id,{decision:'dismiss',requestId:'dismiss'}).status,'dismissed');

    assert.equal(notes.sourceVersions(project.id,conflicting.id).stale,true);
    const legacy=drama.addEpisodeComment(project.id,{documentId:doc.id,version:3,start:0,end:2,selectedText:'人工',text:'原系统的历史意见'});
    assert.equal(notes.list(project.id).find(n=>n.id===legacy.id)?.status,'saved');
    const linked=notes.dispatch(project.id,legacy.id);
    assert.equal(notes.dispatch(project.id,legacy.id).taskId,linked.taskId);
    assert.equal(notes.list(project.id).filter(n=>n.id===legacy.id).length,1);
    assert.throws(()=>notes.dispatch(other.id,legacy.id),/不存在/);
    const reanchor=notes.add(project.id,{...input,reanchorOf:conflicting.id,sourceId:doc.id,version:3,start:0,end:2,selectedText:'人工',requestId:'new-point',dispatch:false});
    assert.equal(reanchor.reanchorOf,conflicting.id);
    assert.equal(notes.dispatch(project.id,reanchor.id).id,reanchor.id);

    const n={id:'script',title:'剧本',agentId:writer.id,release:'manual',x:10,y:20};
    drama.saveGraph(project.id,project.graphVersion,{nodes:[n],edges:[]});
    const run=workflow.start(project.id,{nodeIds:['script'],requestId:'run'});
    const round=async()=>{
      const deadline=Date.now()+8000;
      while(Date.now()<deadline) {
        workflow.refresh(project.id);
        const item=workflow.list(project.id).find(r=>r.id===run.id)!.nodes[0]!;
        if(item.status==='review') return item;
        await wait(20);
      }
      assert.fail('节点没有产生候选稿');
    };
    const r=await round(),draft=r.artifact!;
    workflow.review(project.id,r.id,{decision:'approve',artifactId:draft.id,requestId:'approve'});
    const graphVersion=drama.project(project.id).graphVersion;
    drama.saveGraph(project.id,graphVersion,{nodes:[{...n,inputRule:'至少 1 份输入材料'}],edges:[]});
    const noDraft=workflow.start(project.id,{nodeIds:['script'],requestId:'waiting'});
    assert.throws(()=>workflow.latestAnnotationDraft(project.id,draft.id),/尚未提交成果/);
    workflow.stopPlan(project.id,noDraft.id);
    const deadline=Date.now()+3000;
    while(!workflow.list(project.id).find(p=>p.id===noDraft.id)?.stoppedAt && Date.now()<deadline) await wait(10);
    assert.equal(workflow.latestAnnotationDraft(project.id,draft.id).id,draft.id);

    const episodes=new ArtifactEpisodes(host.store,drama,workflow);
    const toEpisode={mode:'new',episode:2,scene:'集尾',requestId:'publish'};
    const published=episodes.associate(project.id,draft.id,toEpisode);
    assert.deepEqual(published,episodes.associate(project.id,draft.id,toEpisode));
    assert.equal(drama.document(project.id,published.id).content,draft.content);
    const reference=drama.saveDocument(project.id,{name:'背景资料',content:'一段设定'});
    assert.throws(()=>episodes.associate(project.id,draft.id,{mode:'existing',documentId:reference.id,version:reference.version,requestId:'wrong-kind'}),/分集正文/);
    assert.throws(()=>episodes.associate(other.id,draft.id,toEpisode),/Unknown artifact/);
    episodes.associate(project.id,draft.id,{mode:'existing',documentId:doc.id,version:1,requestId:'existing'});
    assert.equal(drama.document(project.id,doc.id).version,3);
    assert.equal(episodes.forArtifact(project.id,draft.id).length,2);
    assert.equal(episodes.forDocument(project.id,doc.id,1)[0]?.id,draft.id);
    const note=notes.add(project.id,{...input,source:'artifact',sourceId:draft.id,version:draft.version,start:0,end:1,selectedText:draft.content[0],requestId:'artifact'});
    await ready(note.id);
    const revised=notes.resolve(project.id,note.id,decision).revision!;
    assert.notEqual(revised.id,draft.id);
    assert.equal(revised.version,2);
    assert.equal(workflow.artifact(project.id,draft.id).content,draft.content);
    const plans=workflow.list(project.id);
    assert.equal(plans.at(-1)!.nodes[0]!.status,'review');
    assert.equal(plans.find(p=>p.id===run.id)!.nodes[0]!.artifact?.id,draft.id);
    assert.equal(workflow.reviewHistory(project.id,plans.at(-1)!.nodes[0]!.id)[0]?.revisedArtifactId,revised.id);
  } finally {await studio.close();await rm(dataDir,{recursive:true,force:true});}
});
