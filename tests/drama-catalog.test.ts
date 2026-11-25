import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {startServer} from '../src/server.js';
import type {ModelOption} from '../src/types.js';

test('refresh reads replaced DSH files, atomically changes live routes and preserves a probe already in progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drama-model-refresh-'));
  const home = join(root, 'dsh');
  const profile = join(home, 'profiles', 'web');
  await mkdir(profile, {recursive:true});
  let acknowledge!: () => void;
  let release!: () => void;
  const received = new Promise<void>(resolve => { acknowledge = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const reached: string[] = [];
  const provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const b of req) chunks.push(b);
    const {model} = JSON.parse(Buffer.concat(chunks).toString());
    reached.push(model);
    if (model === 'original') { acknowledge(); await proceed; }
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    const part = (choices: unknown[]) => 'data: ' + JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model,choices}) + '\n\n';
    res.end(part([{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]) +
      part([{index:0,delta:{},finish_reason:'stop'}]) + 'data: [DONE]\n\n');
  });
  await new Promise<void>((done, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', done); });
  const address = provider.address();
  assert.ok(address && typeof address !== 'string');
  const baseURL = 'http://127.0.0.1:' + address.port + '/v1';
  const path = join(profile, 'cordis.patch.yml');
  const config = (id: string) => JSON.stringify([{id:'llm-pi-ai',config:{providers:{
    fixture:{api:'openai-completions',baseURL,apiKeyEnv:'WORKBENCH_FIXTURE',models:[{id,contextWindow:32768,maxTokens:256}]}
  }}}]);
  await writeFile(path, config('original'));
  await writeFile(join(home,'.env'), 'WORKBENCH_FIXTURE=local-fixture-key');
  const app = await startServer({dataDir:join(root,'data'),dshHome:home,drama:true,port:0});
  try {
    const api = app.url + '/api/drama';
    const {csrfToken} = await fetch(app.url+'/api/bootstrap').then(r => r.json());
    const post = (route: string, body = {}) => fetch(api+route,{method:'POST',headers:{
      'x-studio-csrf':csrfToken,'content-type':'application/json'
    },body:JSON.stringify(body)});
    const list = async () => (await fetch(api+'/models').then(r=>r.json()) as ModelOption[]).map(m=>m.model);
    assert.deepEqual(await list(), ['original']);
    const original = post('/models/probe', {provider:'fixture',model:'original'});
    const timeout = AbortSignal.timeout(6000);
    await Promise.race([received, new Promise<void>((_,reject) => timeout.addEventListener('abort',() => reject(new Error('Original probe did not reach fixture')),{once:true}))]);
    await writeFile(path+'.next', config('replacement'));
    await rename(path+'.next', path);
    // The current provider continues serving its old request while the refreshed route is already usable.
    const updated = await post('/models/refresh');
    assert.equal(updated.status,200);
    assert.deepEqual((await updated.json() as ModelOption[]).map(m=>m.model), ['replacement']);
    const replacement = {provider:'fixture',model:'replacement'};
    const active = await post('/models/probe', replacement);
    assert.equal((await active.json()).status,'verified');
    release();
    assert.equal((await (await original).json()).status,'verified');
    assert.deepEqual(reached,['original','replacement']);
    assert.equal((await post('/agents',{name:'编剧',selection:replacement})).status,201);
    assert.equal((await post('/agents',{name:'旧配置',selection:{provider:'fixture',model:'original'}})).status,400);
    assert.equal((await post('/agents',{name:'演示配置',selection:{provider:'studio-demo',model:'executor'}})).status,400);
    await writeFile(path, 'not: [valid');
    assert.equal((await post('/models/refresh')).ok,false);
    assert.deepEqual(await list(),['replacement']);
    await writeFile(path, '[]');
    assert.deepEqual(await (await post('/models/refresh')).json(),[]);
    assert.deepEqual(await list(),[]);
  } finally {
    release();
    await app.close();
    provider.closeAllConnections();
    await new Promise<void>(done=>provider.close(()=>done()));
    await rm(root,{recursive:true,force:true});
  }
});
