import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startServer} from '../dist/src/server.js';
const origin='http://127.0.0.1:11434';
const model=process.env.STUDIO_DRAMA_LIVE_MODEL ?? await readFile(new URL('../.local/ollama-smoke-model',import.meta.url),'utf8').then(text=>text.trim()).catch(error=>{
  if(error.code==='ENOENT') return '';
  throw error;
});
if (!model || !/^[a-zA-Z0-9_.:-]+$/.test(model)) throw new Error('Set STUDIO_DRAMA_LIVE_MODEL to the name of a locally installed Ollama model');
delete process.env.STUDIO_ENDPOINT_OVERRIDES;
const [running,catalog]=await Promise.all(['ps','tags'].map(route=>fetch(origin+'/api/'+route,{signal:AbortSignal.timeout(4000)}).then(async response=>{
  if(!response.ok) throw new Error('Local Ollama preflight failed');
  return response.json();
})));
const active=running.models??[];
if(!catalog.models?.some(item=>item.name===model)) throw new Error('Install the selected local test model before running the smoke test');
if(active.some(item=>item.name!==model)) {console.log(JSON.stringify({stage:'preflight',status:'skipped-other-active-model'}));process.exit(2);}
const root=await mkdtemp(join(tmpdir(),'drama-real-graph-'));
const dshHome=join(root,'fixture-home');
await mkdir(dshHome);
await writeFile(join(dshHome,'cordis.patch.yml'),'- id: llm-pi-ai\n  config:\n    providers:\n      local-fixture:\n        api: openai-completions\n        baseURL: '+origin+'/v1\n        headers:\n          Authorization: Bearer workbench-local-fixture\n        models:\n          - id: '+model+'\n            name: Local verification model\n            contextWindow: 32768\n            maxTokens: 512\n');
let app;
try {
  app=await startServer({drama:true,dshHome,dataDir:join(root,'work'),port:0,scheduler:{maxActiveWorkers:1,maxDeliveryAttempts:1,pollIntervalMs:35}});
  const token=(await fetch(app.url+'/api/bootstrap').then(r=>r.json())).csrfToken;
  const path=app.url+'/api/drama';
  async function save(segment,value,method='POST') {
    const response=await fetch(path+segment,{method,headers:{'content-type':'application/json','x-studio-csrf':token},body:JSON.stringify(value)});
    const data=await response.json();
    if(!response.ok) throw new Error('HTTP '+response.status+' '+segment);
    return data;
  }
  const selection={provider:'local-fixture',model};
  const connection=await save('/models/probe',selection);
  console.log(JSON.stringify({stage:'probe',status:connection.status,isolatedConfiguration:true}));
  if(connection.status!=='verified') process.exitCode=3;
  else {
    const agent=await save('/agents',{name:'本机短剧验收',role:'worker',selection,systemPrompt:'只写极短的虚构中文场景。用 studio_report 提交全文，参数中的 Task 和 Attempt 必须逐字复制任务消息。'});
    const work=await save('/projects',{name:'完全虚构的公交站'});
    const workPath='/projects/'+work.id;
    const node=(id,title)=>({id,title,agentId:agent.id,release:'manual',x:0,y:0,instruction:'写三行中文。人物小林和老何。只用不超过80字写候选全文，完成马上调用 studio_report 提交。'});
    await save(workPath+'/graph',{expectedVersion:work.graphVersion,nodes:[node('first','第一场'),node('second','第二场')],edges:[{from:'first',to:'second'}]},'PUT');
    const first=await save(workPath+'/runs',{nodeIds:['first'],includeDownstream:true,requestId:'actual'});
    async function watch(id) {
      const until=Date.now()+25_000;
      let item;
      while(Date.now()<until) {
        const runs=await fetch(path+workPath+'/runs').then(r=>r.json());
        item=runs.find(r=>r.id===first.id).nodes.find(n=>n.nodeId===id);
        if(['review','failed','rejected'].includes(item?.status)) return item;
        await delay(250);
      }
      return item;
    }
    const drafted=await watch('first');
    console.log(JSON.stringify({stage:'draft',status:drafted?.status,artifact:!!drafted?.artifact}));
    if(drafted?.status!=='review') process.exitCode=4;
    else {
      const approved=await save(workPath+'/node-runs/'+drafted.id+'/review',{decision:'approve',requestId:'approval',artifactId:drafted.artifact.id});
      const exported=await fetch(path+workPath+'/artifacts/'+drafted.artifact.id+'/export?format=docx');
      const next=await watch('second');
      const result={stage:'handoff',approved:approved.status==='released',inputIsExact:next?.handoff?.[0]?.artifactId===drafted.artifact.id,status:next?.status,docx:exported.ok&&Buffer.from(await exported.arrayBuffer()).readUInt32LE(0)===0x04034b50};
      console.log(JSON.stringify(result));
      if(result.status!=='review'||!result.approved||!result.inputIsExact||!result.docx) process.exitCode=5;
    }
  }
} finally {await app?.close();await rm(root,{recursive:true,force:true});}
