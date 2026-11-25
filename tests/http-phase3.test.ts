/** HTTP memory views use the Run's Orchestrator identity and never grant remote execution or memory writes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startServer} from '../src/server.js';
import type {MemoryList,MemoryPage} from '../src/memory.js';

test('Web memory directory discloses summaries before bounded bodies and explicit Run reuse carries only long memory', {timeout:20000}, async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'studio-http-memory-'));
  const app=await startServer({dataDir,port:0});
  const until=async(id:string)=>{
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){const run=(await app.studio.snapshot()).runs.find(r=>r.id===id)!;if(run.tasks.every(t=>t.status==='completed')&&run.deliveries.every(d=>d.state==='done'))return run;await delay(10);}
    throw new Error('Task did not complete');
  };
  try {
    const {csrfToken}=await(await fetch(app.url+'/api/bootstrap')).json() as {csrfToken:string};
    const headers={'Content-Type':'application/json','X-Studio-CSRF':csrfToken};
    const created=await fetch(app.url+'/api/runs',{method:'POST',headers,body:JSON.stringify({mode:'hierarchical',prompt:'Memory API verification'})});
    assert.equal(created.status,201);const {id}=await created.json() as {id:string};
    const original=await until(id);
    const base=`${app.url}/api/runs/${id}/memories`;
    const directory=await(await fetch(base+'?layer=long&limit=1')).json() as MemoryList;
    assert.equal(directory.items.length,1);assert.equal('content' in directory.items[0]!,false);
    const entry=directory.items[0]!;
    const read=await(await fetch(`${base}/${entry.id}?limit=4`)).json() as MemoryPage;
    assert.equal(read.content.length,4);assert.equal(read.nextOffset,4);
    const full=await(await fetch(`${base}/${entry.id}`)).json() as MemoryPage;
    assert.equal(JSON.stringify(await app.studio.snapshot()).includes(full.content),false,'default state never embeds memory bodies');
    assert.equal((await fetch(`${base}/${entry.id}?limit=0`)).status,400);
    assert.equal((await fetch(base+'?layer=not-a-layer')).status,400);
    assert.equal((await fetch(base,{method:'POST',headers,body:'{}'})).status,404);
    const short=await(await fetch(base+'?layer=short')).json() as MemoryList;
    const reused=await fetch(app.url+'/api/runs',{method:'POST',headers,body:JSON.stringify({mode:'hierarchical',prompt:'Reuse only private long-term knowledge',reuseMemoryFromRunId:id})});
    assert.equal(reused.status,201);const next=await until((await reused.json() as {id:string}).id);
    const oldWorker=original.agents.find(a=>a.role==='worker')!,worker=next.agents.find(a=>a.role==='worker')!;
    assert.notEqual(worker.sessionId,oldWorker.sessionId);assert.equal(worker.memoryIdentityId,oldWorker.memoryIdentityId);
    assert.equal((await fetch(`${app.url}/api/runs/${next.id}/memories/${entry.id}`)).status,200);
    assert.equal((await fetch(`${app.url}/api/runs/${next.id}/memories/${short.items[0]!.id}`)).status,400);
    const invalid=await fetch(app.url+'/api/runs',{method:'POST',headers,body:JSON.stringify({mode:'direct',prompt:'invalid source',reuseMemoryFromRunId:'unknown'})});
    assert.equal(invalid.status,400);
    assert.equal((await fetch(`${app.url}/api/runs/${id}/attempts/${original.attempts[0]!.id}/exec`,{method:'POST',headers,body:'{}'})).status,404);
  } finally {await app.close();await rm(dataDir,{recursive:true,force:true});}
});
