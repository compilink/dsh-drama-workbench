/** Host-side offline pilot. Not an agent tool and deliberately has no publisher. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join, relative, isAbsolute } from 'node:path';
import type { StudioStore } from './store.js';
import type { TaskEngine } from './task-engine.js';
import { stageContractPrompt, stageReadiness } from './video-role-contracts.js';
import { videoStageEditorialInstruction } from './video-editorial-standards.js';

export const VIDEO_STAGES = {
  brief: [], script: ['brief'], storyboard: ['script'], audio: ['script'],
  visuals: ['storyboard'], render: ['audio', 'visuals'],
} as const;
export type VideoStage = keyof typeof VIDEO_STAGES;
export interface VideoProbe { videoTracks: number; audioTracks: number; videoSeconds: number; audioSeconds: number; decodedFrames: number; decodedVideoEnd: number; decodedAudioEnd: number; videoComplete: boolean; audioComplete: boolean; rms: number[]; peak: number; }
export function videoQualityErrors(p: VideoProbe): string[] {
  const e: string[]=[];
  if(p.videoTracks!==1 || p.audioTracks!==1) e.push('Require exactly one video track and one mixed audio track');
  const finite=(n: number)=>Number.isFinite(n)&&n>0;
  if(![p.videoSeconds,p.audioSeconds,p.decodedVideoEnd,p.decodedAudioEnd].every(finite)) e.push('Missing or invalid duration');
  if(!p.videoComplete||!p.audioComplete||!Number.isInteger(p.decodedFrames)||p.decodedFrames<1) e.push('Full decoding did not complete');
  if(Math.abs(p.videoSeconds-p.audioSeconds)>0.25||Math.abs(p.decodedVideoEnd-p.videoSeconds)>0.25||Math.abs(p.decodedAudioEnd-p.videoSeconds)>0.25) e.push('Audio/video coverage mismatch');
  if(!Array.isArray(p.rms)||p.rms.length!==5||p.rms.some(x=>!finite(x)||x<0.0001)) e.push('Silent or missing audio segment (speech pilot policy)');
  if(!finite(p.peak)||p.peak>=0.999) e.push('Invalid or clipped audio peak');
  return e;
}
interface Artifact { hash: string; bytes: number; }
interface StageRecord { taskId: string; artifact?: Artifact; }
export interface VideoJob { id: string; runId: string; brief: string; stages: Partial<Record<VideoStage,StageRecord>>; importedRender?: Artifact; decision?: {hash: string; approved: boolean; at: string; note: string}; technical?: { hash: string; report: VideoProbe; errors: string[] }; }
export class VideoPipeline {
  constructor(private store: StudioStore, private engine: TaskEngine, private artifactDir: string, private inputRoot: string, private assertRunActive?: (runId:string)=>void) {
    mkdirSync(artifactDir,{recursive:true,mode:0o700});
    this.inputRoot=realpathSync(inputRoot);this.artifactDir=realpathSync(artifactDir);
    store.db.exec('CREATE TABLE IF NOT EXISTS video_jobs(id TEXT PRIMARY KEY, document TEXT NOT NULL); CREATE TABLE IF NOT EXISTS video_review_events(id TEXT PRIMARY KEY, job_id TEXT NOT NULL, document TEXT NOT NULL)');
  }
  private save(job: VideoJob) { this.store.db.prepare('INSERT INTO video_jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(job.id,JSON.stringify(job)); }
  get(id: string): VideoJob { const row=this.store.db.prepare('SELECT document FROM video_jobs WHERE id=?').get(id);if(!row)throw new Error('Unknown video job');const job:VideoJob=JSON.parse(String(row.document));this.assertRunActive?.(job.runId);return job; }
  create(runId: string, brief: string): VideoJob {
    this.assertRunActive?.(runId);
    if(!this.store.run(runId)||!brief.trim()||brief.length>4000)throw new Error('Invalid run or brief');
    const job:VideoJob={id:randomUUID(),runId,brief,stages:{}};this.save(job);return job;
  }
  private bytes(a: Artifact): Buffer {
    if(!/^[a-f0-9]{64}$/.test(a.hash))throw new Error('Invalid artifact hash');
    const data=readFileSync(join(this.artifactDir,a.hash));
    if(data.length!==a.bytes||createHash('sha256').update(data).digest('hex')!==a.hash)throw new Error('Artifact integrity failed');return data;
  }
  admit(id: string, stage: VideoStage): string {
    if(!Object.hasOwn(VIDEO_STAGES,stage))throw new Error('Unknown stage');
    return this.store.atomic(()=>{
      const job=this.get(id);const dependencies=VIDEO_STAGES[stage];
      for(const dep of dependencies){const a=job.stages[dep]?.artifact;if(!a)throw new Error(`Dependency not accepted: ${dep}`);this.bytes(a);}
      if(job.stages[stage])return job.stages[stage]!.taskId;
      const task=this.engine.createTask(job.runId,{requestId:`video:${id}:${stage}`,prompt:`VIDEO STAGE ${stage}\n${job.brief}\nInputs: ${dependencies.map(d=>`${d}:${job.stages[d]!.artifact!.hash}`).join(', ')}\n${stageContractPrompt(stage)}\n${videoStageEditorialInstruction(stage)}\nReturn an artifact for host validation. Never publish or request credentials. Technical completion is not human approval.`});
      job.stages[stage]={taskId:task.id};this.save(job);return task.id;
    });
  }
  plan(id: string) {
    const job=this.get(id),accepted:string[]=[];
    for(const stage of Object.keys(VIDEO_STAGES) as VideoStage[]) {const a=job.stages[stage]?.artifact;if(a){this.bytes(a);accepted.push(stage);}}
    return (Object.keys(VIDEO_STAGES) as VideoStage[]).map(stage=>({...stageReadiness(stage,accepted),taskId:job.stages[stage]?.taskId,taskStatus:job.stages[stage]?this.store.task(job.stages[stage]!.taskId)?.status:undefined,artifactAccepted:accepted.includes(stage)}));
  }
  acceptArtifact(id: string, stage: VideoStage, source: string): Artifact {
    const job=this.get(id), record=job.stages[stage];
    if(!record||this.store.task(record.taskId)?.status!=='completed')throw new Error('Stage task must be completed');
    if(record.artifact)throw new Error('Accepted stage is immutable; create a new job for revisions');
    for(const dep of VIDEO_STAGES[stage])this.bytes(job.stages[dep]!.artifact!);
    const a=this.importFile(source);
    record.artifact=a;this.save(job);return a;
  }
  private importFile(source: string): Artifact {
    const path=realpathSync(source),rel=relative(this.inputRoot,path);
    if(rel.startsWith('..')||isAbsolute(rel)||!statSync(path).isFile()||statSync(path).size>512*1024*1024)throw new Error('Input outside allowed root or too large');
    const data=readFileSync(path);if(!data.length)throw new Error('Empty artifact');
    const a={hash:createHash('sha256').update(data).digest('hex'),bytes:data.length};
    try{writeFileSync(join(this.artifactDir,a.hash),data,{flag:'wx',mode:0o600});}catch(err){if((err as NodeJS.ErrnoException).code!=='EEXIST')throw err;this.bytes(a);}
    return a;
  }
  list(): VideoJob[] { return this.store.db.prepare('SELECT document FROM video_jobs').all().map(r=>JSON.parse(String(r.document))); }
  importForReview(runId: string, brief: string, source: string): VideoJob {
    this.assertRunActive?.(runId);
    const a=this.importFile(source); const job=this.create(runId,brief);job.importedRender=a;this.save(job);return job;
  }
  private render(job: VideoJob) { return job.importedRender??job.stages.render?.artifact; }
  private checkedRender(job: VideoJob): Buffer {
    const a=this.render(job);if(!a)throw new Error('No render');
    try { return this.bytes(a); } catch(error) {
      delete job.decision;delete job.technical;this.save(job);
      this.store.db.prepare('INSERT INTO video_review_events VALUES(?,?,?)').run(randomUUID(),job.id,JSON.stringify({kind:'integrity_revoked',at:new Date().toISOString()}));throw error;
    }
  }
  preview(id: string, hash: string): Buffer {
    const job=this.get(id),a=this.render(job);if(!a||a.hash!==hash)throw new Error('Preview hash mismatch');return this.checkedRender(job);
  }
  async probe(id: string) {
    const job=this.get(id),a=this.render(job);if(!a)throw new Error('No render');this.checkedRender(job);
    // Only host-executed probe output is accepted. No HTTP input for QA reports.
    const script=fileURLToPath(new URL('../../scripts/check-video.mjs',import.meta.url));
    let stdout:string;
    try { ({stdout}=await promisify(execFile)(process.execPath,[script,join(this.artifactDir,a.hash)],{timeout:200000,maxBuffer:2*1024*1024})); }
    catch(error) { const failure=error as {code?:number;stdout?:string};if(failure.code!==2||!failure.stdout)throw error;stdout=failure.stdout; }
    const result=JSON.parse(stdout);if(result.sha256!==a.hash)throw new Error('Probe hash mismatch');
    return this.recordTechnical(id,a.hash,result.report);
  }
  /** Local owner UI only; deliberately absent from model tools and no publisher. */
  decide(id: string, hash: string, approved: boolean, note: string) {
    const job=this.get(id),a=this.render(job);if(!a||a.hash!==hash)throw new Error('Decision hash mismatch');this.checkedRender(job);
    if(approved&&(!job.technical||job.technical.hash!==hash||job.technical.errors.length))throw new Error('Technical gate not passed');
    if(typeof approved!=='boolean'||typeof note!=='string'||note.length>2000)throw new Error('Invalid decision');
    job.decision={hash,approved,at:new Date().toISOString(),note};this.store.atomic(()=>{this.save(job);this.store.db.prepare('INSERT INTO video_review_events VALUES(?,?,?)').run(randomUUID(),id,JSON.stringify(job.decision));});return this.review(id);
  }
  /** Only a trusted host probe may call this, never worker-reported JSON. */
  recordTechnical(id: string, hash: string, report: VideoProbe) {
    const job=this.get(id),a=this.render(job);if(!a||a.hash!==hash)throw new Error('Report must bind the accepted render');this.bytes(a);
    job.technical={hash,report,errors:videoQualityErrors(report)};this.save(job);return this.review(id);
  }
  review(id: string) {
    const job=this.get(id),a=this.render(job);if(a)this.checkedRender(job);
    const decision=job.decision?.hash===a?.hash?job.decision:undefined;
    return { decision, status:job.technical&&job.technical.errors.length===0?(decision?.approved?'owner_approved_no_publisher':decision?'owner_rejected':'awaiting_editorial_and_user_review'):'technical_blocked', hash:a?.hash, publishAllowed:false as const, required:['Full audiovisual editorial review','Explicit owner decision on this exact video'] };
  }
}
