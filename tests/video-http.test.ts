import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startServer} from '../src/server.js';
test('local video UI: controlled import, range preview, gated decision and no publish route', {timeout:20000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'video-http-')),input=join(dir,'input');await mkdir(input);const source=join(input,'sample.mp4');await writeFile(source,'synthetic fixture bytes');
 const app=await startServer({dataDir:join(dir,'db'),videoInputRoot:input,port:0});
 try {
  const {csrfToken}=await(await fetch(`${app.url}/api/bootstrap`)).json() as {csrfToken:string};
  const headers={'Content-Type':'application/json','X-Studio-CSRF':csrfToken};
  const post=(path:string,value:unknown)=>fetch(`${app.url}${path}`,{method:'POST',headers,body:JSON.stringify(value)});
  assert.equal((await fetch(`${app.url}/video.html`)).status,200);
  const run=await(await post('/api/runs',{prompt:'synthetic test',mode:'direct'})).json() as {id:string};
  const response=await post('/api/video',{runId:run.id,brief:'synthetic imported media',source});assert.equal(response.status,201);
  const job=await response.json() as {id:string;importedRender:{hash:string}};const prefix=`/api/video/${job.id}`;
  const preview=await fetch(`${app.url}${prefix}/preview?hash=${job.importedRender.hash}`,{headers:{Range:'bytes=0-8'}});assert.equal(preview.status,206);assert.equal(await preview.text(),'synthetic');
  assert.equal((await fetch(`${app.url}${prefix}/preview?hash=${'0'.repeat(64)}`)).status,400);
  assert.equal((await post(`${prefix}/decision`,{hash:job.importedRender.hash,approved:true})).status,400);
  assert.equal((await post(`${prefix}/decision`,{hash:job.importedRender.hash,approved:true,ownerAttestation:'I reviewed this exact video'})).status,400);
  assert.equal((await fetch(`${app.url}${prefix}/decision`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await post(`${prefix}/publish`,{})).status,404);
  const normal=await(await post('/api/video',{runId:run.id,brief:'staged workflow'})).json() as {id:string};
  assert.equal((await post(`/api/video/${normal.id}/stage`,{stage:'render'})).status,400);
  assert.equal((await post(`/api/video/${normal.id}/stage`,{stage:'brief'})).status,202);
  const plan=await(await fetch(`${app.url}/api/video/${normal.id}/plan`)).json() as {stage:string;missingInputs:string[];pendingAdapters:string[];taskId?:string}[];
  assert.ok(plan.find(s=>s.stage==='brief')!.taskId);assert.deepEqual(plan.find(s=>s.stage==='render')!.missingInputs,['audio','visuals']);
  assert.equal((await fetch(`${app.url}/api/video/contracts`)).status,200);
  const outside=join(dir,'outside');await writeFile(outside,'private');assert.equal((await post('/api/video',{runId:run.id,brief:'bad',source:outside})).status,400);
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
