import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {startEditorModelFixture} from './fixtures/editor-model.js';
import {startServer} from '../src/server.js';
import {presentTaskInputs,readInputPage} from '../src/drama-task-input.js';

test('a delivery can page all of its referenced input including ancestor instructions',()=>{
  const sources=['分工','原文'.repeat(10_000)+'尾声'];
  const first=presentTaskInputs(sources,true);
  assert.equal(first.inputPages?.[1]?.characters,sources[1]!.length);
  assert.ok(!first.sourceInstructions![0]!.includes('尾声'));
  assert.equal(readInputPage(sources,1,0,100,'尾声').content,'尾声');
  let offset:number|null=0,body='';
  while(offset!==null){const page=readInputPage(sources,1,offset,4000);body+=page.content;offset=page.nextOffset??null;}
  assert.equal(body,sources[1]);
  assert.throws(()=>readInputPage(sources,2,0,100),/没有这份输入/);
});

test('an editor receives a preview then reads the exact end of a long original via its granted input tool',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'drama-input-model-'));
  const wire:string[]=[];
  const fixture=await startEditorModelFixture(dir,messages=>wire.push(JSON.stringify(messages)));
  const app=await startServer({drama:true,dataDir:join(dir,'data'),dshHome:fixture.home,port:0});
  try {
    const {csrfToken}=await fetch(app.url+'/api/bootstrap').then(r=>r.json());
    const post=async(path:string,data:unknown)=>{
      const r=await fetch(app.url+'/api/drama'+path,{method:'POST',headers:{'content-type':'application/json','x-studio-csrf':csrfToken},body:JSON.stringify(data)});
      const result=await r.json(); assert.ok(r.ok,JSON.stringify(result));return result;
    };
    const editor=await post('/agents',{role:'orchestrator',name:'总编',selection:{provider:'fixture',model:'fixture'}});
    const project=await post('/projects',{name:'测试作品',editorAgentId:editor.id});
    const prefix='段落'.repeat(32_000);
    fixture.respond({source:0,offset:prefix.length,limit:32},'已读取末尾。','drama_read_input');
    const reply=await post('/projects/'+project.id+'/editor',{requestId:'long',mode:'message',text:prefix+'末尾证据XYZ'});
    for(let i=0;i<240 && app.studio.drama!.store.deliveries(reply.sessionId)[0]?.state!=='done';i++)await delay(25);
    assert.equal(app.studio.drama!.store.deliveries(reply.sessionId)[0]?.state,'done');
    assert.ok(wire[0]?.includes('inputPages'));
    assert.ok(!wire[0]?.includes('末尾证据XYZ'));
    assert.ok(wire.slice(1).some(message=>message.includes('末尾证据XYZ')));
  }finally{await app.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
