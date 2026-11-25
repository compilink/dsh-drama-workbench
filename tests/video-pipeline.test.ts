import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,symlinkSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StudioStore} from '../src/store.js';
import {TaskEngine} from '../src/task-engine.js';
import {VIDEO_WRITING_RULES,VIDEO_EDITORIAL_CHECKLIST,videoStageEditorialInstruction} from '../src/video-editorial-standards.js';
import {VideoPipeline,videoQualityErrors,VIDEO_STAGES,type VideoProbe} from '../src/video-pipeline.js';
const good:VideoProbe={videoTracks:1,audioTracks:1,videoSeconds:30,audioSeconds:30,decodedFrames:900,decodedVideoEnd:30,decodedAudioEnd:30,videoComplete:true,audioComplete:true,rms:[.1,.1,.1,.1,.1],peak:.7};
test('video technical gate rejects incomplete audio coverage and fails closed',()=>{
 assert.deepEqual(videoQualityErrors(good),[]);
 for(const patch of [{audioTracks:2,audioSeconds:8,decodedAudioEnd:8},{decodedAudioEnd:7.5},{videoComplete:false},{videoSeconds:NaN},{peak:1},{rms:[]},{rms:[.1,.1,0,.1,.1]},{audioTracks:undefined}])assert.ok(videoQualityErrors({...good,...patch} as VideoProbe).length);
});
test('video stages use durable TaskEngine tasks, hash handoff and never grant publishing',()=>{
 const dir=mkdtempSync(join(tmpdir(),'studio-video-')),input=join(dir,'in'),out=join(dir,'artifacts');mkdirSync(input);
 const store=new StudioStore(join(dir,'db'));
 try {
  for(const role of ['orchestrator','manager','worker'] as const)store.saveTemplate({id:role,name:role,role,systemPrompt:role,selection:{provider:'studio-demo',model:role},version:1,memoryIdentityId:role});
  store.saveRun({id:'r',title:'pilot',mode:'auto',orchestratorId:'o',status:'idle',createdAt:new Date().toISOString()});
  store.saveAgent({id:'o',sessionId:'o',runId:'r',parentId:null,createdBy:null,templateId:'orchestrator',templateVersion:1,memoryIdentityId:'o',name:'O',role:'orchestrator',selection:{provider:'studio-demo',model:'planner'},systemPrompt:'O',status:'idle',createdAt:new Date().toISOString()});
  const engine=new TaskEngine(store,{onChange:()=>{}}),pipeline=new VideoPipeline(store,engine,out,input),job=pipeline.create('r','Synthetic training clip');
  assert.throws(()=>pipeline.admit(job.id,'render'),/Dependency/);
  const source=join(input,'result');writeFileSync(source,'stage result');
  for(const stage of Object.keys(VIDEO_STAGES) as (keyof typeof VIDEO_STAGES)[]) {
   const taskId=pipeline.admit(job.id,stage);if(stage==='script')for(const rule of VIDEO_WRITING_RULES)assert.ok(store.task(taskId)!.prompt.includes(rule));assert.equal(pipeline.admit(job.id,stage),taskId);
   assert.throws(()=>pipeline.acceptArtifact(job.id,stage,source),/completed/);
   const work=engine.delegate('o',{taskId,role:'worker',prompt:stage});
   const delivery=store.deliveries().find(d=>d.attemptId===work.attemptId)!;engine.beginDelivery(delivery.id);
   engine.report(work.agentId,{taskId,attemptId:work.attemptId!,text:'prepared'});engine.accept('o',{taskId,text:'checked'});
   const outside=join(dir,'outside');writeFileSync(outside,'private');const link=join(input,'link');if(stage==='brief'){symlinkSync(outside,link);assert.throws(()=>pipeline.acceptArtifact(job.id,stage,link),/outside/);}
   pipeline.acceptArtifact(job.id,stage,source);
  }
  const hash=pipeline.get(job.id).stages.render!.artifact!.hash;
  assert.throws(()=>pipeline.recordTechnical(job.id,'0'.repeat(64),good),/bind/);
  assert.equal(pipeline.recordTechnical(job.id,hash,good).status,'awaiting_editorial_and_user_review');
  assert.equal(pipeline.review(job.id).publishAllowed,false);
  // Synthetic fixture only, not approval of any real user content.
  assert.throws(()=>pipeline.decide(job.id,'0'.repeat(64),true,'test'),/hash/);
  assert.equal(pipeline.decide(job.id,hash,true,'synthetic test').status,'owner_approved_no_publisher');
  assert.equal(pipeline.review(job.id).publishAllowed,false);
  const reopened=new VideoPipeline(store,engine,out,input);assert.equal(reopened.review(job.id).hash,hash);
  writeFileSync(join(out,hash),'tampered');assert.throws(()=>pipeline.review(job.id),/integrity/);assert.equal(pipeline.get(job.id).decision,undefined);assert.equal(pipeline.get(job.id).technical,undefined);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('synthetic probe fixtures distinguish an incomplete soundtrack from a fully decoded mix',()=>{
 const fixtures=JSON.parse(readFileSync('tests/fixtures/video-probes.json','utf8')) as {incomplete: VideoProbe; complete: VideoProbe};
 const errors=videoQualityErrors(fixtures.incomplete);
 assert.ok(errors.includes('Audio/video coverage mismatch'));
 assert.ok(errors.includes('Require exactly one video track and one mixed audio track'));
 assert.deepEqual(videoQualityErrors(fixtures.complete),[]);
});

test('video stages carry script, audio and editorial review criteria',()=>{
 const script=videoStageEditorialInstruction('script');
 for(const rule of VIDEO_WRITING_RULES)assert.ok(script.includes(rule));
 assert.match(videoStageEditorialInstruction('audio'),/短试听样本/);
 const render=videoStageEditorialInstruction('render');
 for(const check of VIDEO_EDITORIAL_CHECKLIST)assert.ok(render.includes(check));
});
