import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {startServer} from '../src/server.js';
import {MemoryService} from '../src/memory.js';

test('the Workbench API owns agent permissions, exact review, merge and Word download', async () => {
  const dataDir=await mkdtemp(join(tmpdir(),'drama-web-'));
  const app=await startServer({dataDir,drama:true,port:0,scheduler:{pollIntervalMs:15}});
  try {
    const asset=await fetch(app.url+'/drama');
    assert.equal(asset.status,200);
    assert.match(await asset.text(),/\/drama-app.js/);
    assert.equal((await fetch(app.url+'/drama-app.css')).status,200);
    assert.equal((await fetch(app.url+'/drama-material.js')).status,200);
    const bootstrap=await fetch(app.url+'/api/bootstrap').then(result=>result.json()) as {csrfToken:string};
    const path=app.url+'/api/drama';
    async function save(route:string,value:unknown,method='POST',status=200) {
      const response=await fetch(path+route,{method,headers:{'content-type':'application/json','x-studio-csrf':bootstrap.csrfToken},body:JSON.stringify(value)});
      const data=await response.json();
      assert.equal(response.status,status,JSON.stringify(data));
      return data;
    }
    const unauthorized=await fetch(path+'/agents',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(unauthorized.status,403);
    const selection={provider:'studio-demo',model:'executor'};
    const probe=await save('/models/probe',selection);
    assert.equal(probe.status,'demo');
    const skill=await save('/skills',{name:'结构检查',summary:'核对叙事拍点',body:'正文不应在目录中返回。'},'POST',201);
    const catalog=await fetch(path+'/skills').then(response=>response.json()) as Record<string,unknown>[];
    assert.deepEqual(catalog.map(entry=>entry.id),[skill.id]);
    assert.equal(Object.hasOwn(catalog[0]!,'body'),false);
    const agent=await save('/agents',{name:'资料编剧',role:'worker',selection,publicNetwork:true,skillIds:[skill.id]},'POST',201);
    assert.equal(agent.publicNetwork,true);
    assert.deepEqual(agent.skillIds,[skill.id]);
    const project=await save('/projects',{name:'江边来信'},'POST',201);
    const route='/projects/'+project.id;
    const other=await save('/projects',{name:'别的作品'},'POST',201);
    const work=app.studio.drama!.createRun({projectId:project.id,title:'记忆测试'});
    const memory=new MemoryService(app.studio.drama!.store).write(work.orchestratorId,{layer:'long',title:'拍点约定',summary:'先读摘要',content:'此段正文仅在这一作品可查。'});
    const directory=await fetch(path+route+'/memory').then(response=>response.json()) as {entries:Record<string,unknown>[]};
    assert.deepEqual(directory.entries.map(entry=>entry.id),[memory.id]);
    assert.equal(Object.hasOwn(directory.entries[0]!,'content'),false);
    assert.equal((await fetch(path+'/projects/'+other.id+'/memory/'+memory.id)).status,404);
    const detail=await fetch(path+route+'/memory/'+memory.id).then(response=>response.json()) as {content:string};
    assert.match(detail.content,/仅在这一作品/);
    const material=await save(route+'/documents',{name:'原设定.txt',content:'旧城与晚班车。',source:{name:'原设定.txt',base64:Buffer.from('旧城与晚班车。').toString('base64')}},'POST',201);
    const original=await fetch(path+route+'/documents/'+material.id+'/source');
    assert.equal(await original.text(),'旧城与晚班车。');
    const shape=(id:string,release:string)=>({id,title:id,agentId:agent.id,instruction:'写一段 '+id,release,x:100,y:100});
    await save(route+'/graph',{expectedVersion:project.graphVersion,nodes:[shape('research','manual'),shape('episode','manual')],edges:[{from:'research',to:'episode'}]},'PUT');
    await save(route+'/node-inputs/research',{documents:[{id:material.id,version:material.version}]},'PUT');
    const started=await save(route+'/runs',{nodeIds:['research'],includeDownstream:true,requestId:'launch'},'POST',201);
    const wait=async (check:(run:typeof started)=>boolean) => {
      for(let index=0;index<100;index++) {
        const runs=await fetch(path+route+'/runs').then(x=>x.json()) as Array<typeof started>;
        const run=runs.find(item=>item.id===started.id);
        if(run&&check(run)) return run;
        await delay(50);
      }
      assert.fail('Workflow state did not settle');
    };
    const reviewed=await wait(run=>run.nodes[0].status==='review');
    assert.equal(reviewed.nodes[1].status,'waiting');
    assert.ok(!reviewed.nodes[1].taskId);
    const {id,artifact}=reviewed.nodes[0];
    await save(route+'/node-runs/'+id+'/review',{decision:'approve',artifactId:artifact.id,requestId:'review'});
    const handoff=await wait(run=>run.nodes[1].status==='review');
    assert.equal(handoff.nodes[1].handoff[0].artifactId,artifact.id);
    const exported=await fetch(path+route+'/artifacts/'+artifact.id+'/export?format=docx');
    assert.equal(exported.status,200);
    assert.match(exported.headers.get('content-type')??'',/wordprocessingml/);
    assert.match(exported.headers.get('x-content-sha256')??'',/^[0-9a-f]{64}$/);
    assert.equal(Buffer.from(await exported.arrayBuffer()).readUInt32LE(),0x04034b50);
    const revoked=await save('/agents',{id:agent.id,expectedVersion:agent.version,name:agent.name,role:'worker',selection,publicNetwork:false});
    assert.equal(revoked.publicNetwork,false);
  } finally {await app.close();await rm(dataDir,{recursive:true,force:true});}
});
