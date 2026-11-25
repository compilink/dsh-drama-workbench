/** Explicit opt-in real Worker verification through memory tools and local Docker, using isolated data. */
import {mkdtemp,rm,writeFile,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createStudio} from '../dist/src/runtime.js';
import {dockerClientEnvironment} from '../dist/src/execution.js';

const provider=process.env.STUDIO_LIVE_PROVIDER, model=process.env.STUDIO_LIVE_MODEL, dshHome=process.env.STUDIO_DSH_HOME, image=process.env.STUDIO_TEST_DOCKER_IMAGE;
if(!provider||!model||!dshHome||!image)throw new Error('Set STUDIO_DSH_HOME, STUDIO_LIVE_PROVIDER, STUDIO_LIVE_MODEL and STUDIO_TEST_DOCKER_IMAGE explicitly. This calls a real model and creates real local containers.');
const dataDir=await mkdtemp(join(tmpdir(),'studio-live-execution-'));
let studio,latest,passed=false;
const ownerId=createHash('sha256').update(dataDir).digest('hex').slice(0,20);
try {
  studio=await createStudio({dataDir,dshHome,execution:{enabled:true,image},scheduler:{maxDeliveryAttempts:1}});
  const template=(await studio.snapshot()).templates.find(t=>t.role==='worker');
  await studio.saveTemplate({...template,selection:{provider,model},systemPrompt:`You are a Worker verifying real memory and Docker execution. Follow these stages in order. Always copy taskId and attemptId exactly from the latest Studio delivery for execution tools.
1. studio_file_write: path answer.mjs, content "import {writeFileSync} from 'node:fs'; writeFileSync('answer.txt',String(6*7)); console.log('computed');".
2. studio_exec: command "node answer.mjs". Inspect that exitCode is zero and no timeout/abort/output limit occurred.
3. studio_file_read: path answer.txt. Read the actual result.
4. studio_memory_write: layer medium, title "Verified arithmetic", summary "Container result was checked", content describing the actual file result. Omit optional fields.
5. studio_memory_checkpoint: summary "Execution verified; ready to report", content describing completed work and the next step report. Omit optional fields.
6. studio_report: text describing the actual result, with taskId and attemptId. Omit optional evidence.
Never delegate or use studio_probe. Omit every optional tool argument, especially timeoutMs, offset, limit, expectedVersion, scope and evidence, unless a tool explicitly requires it for recovery. Do not repeat successful stages. Do not claim success without actual tool results. Keep each argument concise.`});
  const run=await studio.createRun({mode:'direct',prompt:'Compute 6*7 in the isolated local container, read answer.txt, save verified medium memory and a short checkpoint, then report the actual result.'});
  const deadline=Date.now()+120000;
  while(Date.now()<deadline){
    latest=await studio.snapshot();const current=latest.runs.find(r=>r.id===run.id);
    const failed=current.tasks.find(t=>['failed','blocked'].includes(t.status));if(failed)throw new Error(failed.error??'Live task failed');
    if(current.tasks.every(t=>t.status==='completed')&&current.deliveries.every(d=>d.state==='done')){
      const attempt=current.attempts[0],file=await studio.readArtifact(run.id,attempt.id,{path:'answer.txt'});
      if(file.content!=='42')throw new Error('Actual container result did not equal 42');
      const medium=await studio.listMemory(run.id,{layer:'medium',taskId:current.tasks[0].id});
      const short=await studio.listMemory(run.id,{layer:'short',taskId:current.tasks[0].id});
      if(!medium.items.length||!short.items.some(entry=>entry.kind==='checkpoint'))throw new Error('Worker did not save both medium memory and a short checkpoint');
      const record={verifiedAt:new Date().toISOString(),passed:true,provider,model,image,coordinators:'deterministic demo',worker:'real configured model',file:{path:file.path,content:file.content},mediumEntries:medium.total,shortEntries:short.total,task:current.tasks[0],attempt,requests:latest.activity.filter(e=>e.agentId===attempt.workerId&&e.kind==='model-request').length};
      if(process.env.STUDIO_EVIDENCE_PATH)await writeFile(process.env.STUDIO_EVIDENCE_PATH,JSON.stringify(record,null,2)+'\n');
      console.log(JSON.stringify(record,null,2));passed=true;break;
    }
    await delay(250);
  }
  if(!passed)throw new Error('Live Worker did not complete verified execution and memory writes in 120 seconds');
}catch(error){
  const events=[];
  const files=await readdir(join(dataDir,'sessions'),{recursive:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  for(const path of files)if(path.endsWith('.jsonl')){
    const lines=(await readFile(join(dataDir,'sessions',path),'utf8')).trim().split('\n');
    for(const line of lines){const event=JSON.parse(line);if(event.type==='tool/call'||event.type==='tool/result')events.push({type:event.type,data:event.data});}
  }
  const record={verifiedAt:new Date().toISOString(),passed:false,provider,model,error:String(error),runs:latest?.runs,activity:latest?.activity,toolDiagnostics:events};
  if(process.env.STUDIO_EVIDENCE_PATH)await writeFile(process.env.STUDIO_EVIDENCE_PATH,JSON.stringify(record,null,2)+'\n');
  throw error;
}finally{
  await studio?.close();
  const volumes=execFileSync('docker',['volume','ls','-q','--filter',`label=dev.dsh-agent-studio.owner=${ownerId}`],{encoding:'utf8',env:dockerClientEnvironment()}).trim();
  if(volumes)execFileSync('docker',['volume','rm',...volumes.split(/\s+/)],{env:dockerClientEnvironment(),stdio:'ignore'});
  await rm(dataDir,{recursive:true,force:true});
}
