/** Memory authorization and disclosure checks use real SQLite records and current organization ownership. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {StudioStore} from '../src/store.js';
import type {StoredAgent} from '../src/store.js';
import {MemoryService} from '../src/memory.js';
import type {MemoryLayer,MemorySummary} from '../src/memory.js';

async function fixture() {
  const path=await mkdtemp(join(tmpdir(),'studio-memory-'));
  const store=new StudioStore(path);
  const timestamp=new Date().toISOString();
  function run(id:string,root:string) {store.saveRun({id,title:id,mode:'auto',orchestratorId:root,status:'idle',createdAt:timestamp});}
  function agent(id:string,runId:string,role:StoredAgent['role'],parentId:string|null,identity=`identity-${id}`) {
    const value:StoredAgent={id,sessionId:`session-${id}`,runId,parentId,createdBy:parentId,templateId:`shared-${role}-template`,templateVersion:1,memoryIdentityId:identity,name:id,role,selection:{provider:'studio-demo',model:role},systemPrompt:role,status:'idle',createdAt:timestamp};
    store.saveAgent(value);return value;
  }
  run('r1','o');agent('o','r1','orchestrator',null);agent('m1','r1','manager','o');agent('m2','r1','manager','o');
  agent('w1','r1','worker','m1');agent('w2','r1','worker','m2');agent('wd','r1','worker','o');
  run('r2','o2');agent('o2','r2','orchestrator',null);agent('m3','r2','manager','o2');agent('w3','r2','worker','m3');
  const memory=new MemoryService(store);
  function note(actorId:string,layer:MemoryLayer,label=actorId) {
    return memory.write(actorId,{layer,title:`${label} methodology`,summary:`${label} summary`,content:`${label} private body`,tags:['scope-proof']});
  }
  return {path,store,memory,run,agent,note,close:async()=>{store.close();await rm(path,{recursive:true,force:true});}};
}

test('each role reads itself and descendants across all layers without reading superiors or sibling groups',async()=>{
  const f=await fixture();
  try {
    const actors=['o','m1','m2','w1','w2','wd'];
    const records=new Map<string,MemorySummary>();
    for(const actor of actors)for(const layer of ['long','medium','short'] as const)records.set(`${actor}:${layer}`,f.note(actor,layer));
    const expected:Record<string,string[]>={o:actors,m1:['m1','w1'],m2:['m2','w2'],w1:['w1'],w2:['w2'],wd:['wd']};
    for(const actor of actors)for(const owner of actors)for(const layer of ['long','medium','short'] as const){
      const entry=records.get(`${owner}:${layer}`)!;
      if(expected[actor].includes(owner))assert.equal(f.memory.read(actor,{id:entry.id}).entry.id,entry.id);
      else assert.throws(()=>f.memory.read(actor,{id:entry.id}),/^Error: Memory is unavailable$/);
    }
    assert.equal(f.memory.list('o',{limit:20}).total,18);
    assert.equal(f.memory.list('m1',{limit:20}).total,6);
    assert.equal(f.memory.list('w1',{limit:20}).total,3);
    assert.equal(f.memory.list('w3').total,0,'a different Run has no implicit identity or session access');
    assert.equal(f.memory.list('w1',{ownerAgentId:'w2'}).total,0,'the same Worker template does not share private memory');
  }finally{await f.close();}
});

test('directory search, pagination, counts and missing-ID errors reveal no unauthorized metadata',async()=>{
  const f=await fixture();
  try{
    const secret=f.memory.write('m2',{layer:'medium',title:'private-manager-title',summary:'private-manager-summary',content:'unrelated-magic-needle'});
    const own=f.memory.write('w1',{layer:'medium',title:'visible',summary:'short visible summary',content:'own-body-needle '+ 'x'.repeat(4500)});
    for(const input of [{query:'unrelated-magic-needle'},{ownerAgentId:'m2'},{ownerAgentId:'missing'},{query:'private-manager-title',limit:1,offset:0}]){
      assert.deepEqual(f.memory.list('w1',input),{items:[],total:0});
    }
    const metadata=f.memory.list('w1',{query:'own-body-needle',limit:1});
    assert.equal(metadata.total,1);assert.equal(metadata.items[0].id,own.id);
    assert.equal('content' in metadata.items[0],false);assert.equal(JSON.stringify(metadata).includes('own-body-needle'),false);
    assert.equal('ownerIdentityId' in metadata.items[0],false);
    for(const id of [secret.id,'does-not-exist'])assert.throws(()=>f.memory.read('w1',{id}),/^Error: Memory is unavailable$/);
    const page=f.memory.read('w1',{id:own.id,limit:4000});assert.equal(page.content.length,4000);assert.equal(page.nextOffset,4000);
    const tail=f.memory.read('w1',{id:own.id,offset:page.nextOffset});assert.equal(tail.nextOffset,undefined);assert.equal(page.content+tail.content,'own-body-needle '+'x'.repeat(4500));
    assert.throws(()=>f.memory.read('w1',{id:own.id,limit:4001}),/limit/);
    assert.throws(()=>f.memory.list('w1',{limit:21}),/limit/);
    assert.deepEqual(f.memory.list('w1',{query:'%'}),{items:[],total:0},'search wildcard characters are literal');
    assert.equal(f.memory.list('o',{query:'unrelated-magic-needle'}).items[0].id,secret.id);
  }finally{await f.close();}
});

test('publication is explicit and only the owner can revise or publish memory, including public entries',async()=>{
  const f=await fixture();
  try{
    const entry=f.note('w1','long','shared-guidance');
    assert.equal(entry.visibility,'private');assert.equal(f.memory.list('w2').total,0);
    const edit={id:entry.id,expectedVersion:entry.version,layer:'long' as const,title:entry.title,summary:entry.summary,content:'overwrite'};
    for(const actor of ['m1','o','w2']){
      assert.throws(()=>f.memory.write(actor,edit),/^Error: Memory is unavailable$/);
      assert.throws(()=>f.memory.publish(actor,{id:entry.id,expectedVersion:entry.version}),/^Error: Memory is unavailable$/);
    }
    const published=f.memory.publish('w1',{id:entry.id,expectedVersion:entry.version});
    assert.equal(published.visibility,'public');assert.equal(published.version,2);
    assert.equal(f.memory.read('w2',{id:entry.id}).content,'shared-guidance private body');
    assert.equal(f.memory.read('w3',{id:entry.id}).entry.id,entry.id);
    assert.throws(()=>f.memory.write('w2',{...edit,expectedVersion:2}),/^Error: Memory is unavailable$/);
    const medium=f.note('w1','medium');assert.throws(()=>f.memory.publish('w1',{id:medium.id,expectedVersion:1}),/Only long-term/);
    const revisions=f.store.db.prepare('SELECT version FROM memory_revisions WHERE entry_id=? ORDER BY version').all(entry.id);
    assert.deepEqual(revisions.map(row=>row.version),[1,2]);
  }finally{await f.close();}
});

test('explicit identity reuse carries private long-term memory across Runs but never medium or short memory',async()=>{
  const f=await fixture();
  try{
    const oldLong=f.note('w1','long');const oldMedium=f.note('w1','medium');const oldShort=f.note('w1','short');
    assert.equal(f.memory.list('w3').total,0);
    f.agent('w3','r2','worker','m3','identity-w1');
    assert.equal(f.memory.read('w3',{id:oldLong.id}).entry.id,oldLong.id);
    assert.equal(f.memory.read('m3',{id:oldLong.id}).entry.id,oldLong.id);
    assert.equal(f.memory.read('o2',{id:oldLong.id}).entry.id,oldLong.id);
    assert.equal(f.memory.list('m3',{ownerAgentId:'w3'}).items[0].id,oldLong.id);
    for(const actor of ['w3','m3','o2'])for(const entry of [oldMedium,oldShort])assert.throws(()=>f.memory.read(actor,{id:entry.id}),/^Error: Memory is unavailable$/);
    const revised=f.memory.write('w3',{id:oldLong.id,expectedVersion:1,layer:'long',title:'continued methodology',summary:'continued',content:'new verified guidance'});
    assert.equal(revised.version,2);assert.equal(f.memory.read('w1',{id:oldLong.id}).content,'new verified guidance');
    assert.throws(()=>f.memory.write('m3',{id:oldLong.id,expectedVersion:2,layer:'long',title:'take over',summary:'take over',content:'forbidden'}),/^Error: Memory is unavailable$/);
  }finally{await f.close();}
});

test('checkpoint and task-scoped notes require participation, preserve revisions and restore via a small reference',async()=>{
  const f=await fixture();
  try{
    const timestamp=new Date().toISOString();
    f.store.saveTask({id:'t1',runId:'r1',requestId:'r1-task',title:'task',prompt:'task',coordinatorId:'m1',status:'running',latestAttemptId:'a1',createdAt:timestamp,updatedAt:timestamp});
    f.store.saveAttempt({id:'a1',taskId:'t1',workerId:'w1',number:1,status:'running',createdAt:timestamp});
    const checkpoint=f.memory.checkpoint('w1',{taskId:'t1',summary:'files inspected, tests next',content:'sensitive recovery body'});
    const endpoint=f.memory.entrypoint('w1','t1');
    assert.equal(endpoint.checkpoint!.id,checkpoint.id);assert.equal(endpoint.checkpoint!.version,1);
    assert.equal(JSON.stringify(endpoint).includes('sensitive recovery body'),false);
    assert.equal(f.memory.read('m1',{id:checkpoint.id}).content,'sensitive recovery body');
    assert.equal(f.memory.read('o',{id:checkpoint.id}).content,'sensitive recovery body');
    for(const actor of ['m2','w2','w3']){
      assert.throws(()=>f.memory.checkpoint(actor,{taskId:'t1',summary:'cannot',content:'cannot'}),/Memory task is unavailable/);
      assert.throws(()=>f.memory.write(actor,{layer:'medium',taskId:'t1',title:'cannot',summary:'cannot',content:'cannot'}),/Memory task is unavailable/);
      assert.throws(()=>f.memory.entrypoint(actor,'t1'),/Memory task is unavailable/);
    }
    assert.throws(()=>f.memory.checkpoint('w1',{taskId:'t1',summary:'next',content:'next'}),/expectedVersion/);
    const next=f.memory.checkpoint('w1',{taskId:'t1',expectedVersion:1,summary:'tests complete',content:'actual test outcome'});
    assert.equal(next.id,checkpoint.id);assert.equal(next.version,2);
    assert.throws(()=>f.memory.checkpoint('w1',{taskId:'t1',expectedVersion:1,summary:'stale',content:'stale'}),/version conflict/);
    const runCheckpoint=f.memory.checkpoint('w1',{summary:'run summary',content:'run-level progress'});
    assert.equal(f.memory.entrypoint('w1').checkpoint!.id,runCheckpoint.id);
    assert.equal(f.memory.entrypoint('w1','t1').checkpoint!.id,checkpoint.id);
    const history=f.store.db.prepare('SELECT document FROM memory_revisions WHERE entry_id=? ORDER BY version').all(checkpoint.id).map(row=>JSON.parse(String(row.document)).content);
    assert.deepEqual(history,['sensitive recovery body','actual test outcome']);
    assert.throws(()=>f.store.db.prepare('UPDATE memory_revisions SET document=? WHERE entry_id=?').run('{}',checkpoint.id),/immutable/);
    assert.throws(()=>f.store.db.prepare('DELETE FROM memory_revisions WHERE entry_id=?').run(checkpoint.id),/immutable/);
  }finally{await f.close();}
});

test('reopening SQLite retains memory content and audit entries without recording content in access logs',async()=>{
  const f=await fixture();
  let reopened:StudioStore|undefined;
  try{
    const entry=f.memory.write('w1',{layer:'medium',title:'audit-title-secret',summary:'audit-summary-secret',content:'audit-body-secret'});
    f.memory.read('w1',{id:entry.id});assert.throws(()=>f.memory.read('w2',{id:entry.id}),/unavailable/);
    f.store.close();reopened=new StudioStore(f.path);
    const memory=new MemoryService(reopened);assert.equal(memory.read('w1',{id:entry.id}).content,'audit-body-secret');
    const logs=reopened.db.prepare('SELECT * FROM memory_audit ORDER BY rowid').all();
    assert.ok(logs.some(row=>row.actor_id==='w1'&&row.action==='write'&&row.outcome==='allowed'&&row.entry_id===entry.id));
    assert.ok(logs.some(row=>row.actor_id==='w2'&&row.action==='read'&&row.outcome==='denied'));
    assert.ok(logs.some(row=>row.actor_id==='w1'&&row.action==='read'&&row.outcome==='allowed'));
    for(const secret of ['audit-title-secret','audit-summary-secret','audit-body-secret'])assert.equal(JSON.stringify(logs).includes(secret),false);
    assert.equal(reopened.db.prepare('PRAGMA user_version').get()!.user_version,3);
  }finally{reopened?.close();await f.close();}
});

test('schema two migration adds memory transactionally and preserves existing records under the runtime ownership lock',async()=>{
  const path=await mkdtemp(join(tmpdir(),'studio-memory-migration-'));
  const db=new DatabaseSync(join(path,'studio.sqlite'));
  db.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY,document TEXT NOT NULL);
    CREATE TABLE messages(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),document TEXT NOT NULL);
    CREATE TABLE runtime_owner(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,nonce TEXT NOT NULL);
    PRAGMA user_version=2;`);
  const run={id:'old-run',title:'phase two history',mode:'auto',orchestratorId:'old-root',status:'idle',createdAt:'2026-11-09T00:00:00Z'};
  const message={id:'old-message',role:'user',text:'preserved',createdAt:run.createdAt};
  db.prepare('INSERT INTO runs VALUES(?,?)').run(run.id,JSON.stringify(run));db.prepare('INSERT INTO messages VALUES(?,?,?)').run(message.id,run.id,JSON.stringify(message));
  db.prepare('INSERT INTO runtime_owner VALUES(1,?,?)').run(process.pid,'old-live-owner');
  try{
    assert.throws(()=>new StudioStore(path),/already owned/);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,2);
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='memories'").get()!.count,0);
    db.exec('DELETE FROM runtime_owner');db.close();
    const migrated=new StudioStore(path);
    try{
      assert.equal(migrated.db.prepare('PRAGMA user_version').get()!.user_version,3);
      assert.equal(migrated.run(run.id)!.title,run.title);assert.deepEqual(migrated.run(run.id)!.messages,[message]);
      assert.equal(migrated.db.prepare('SELECT count(*) AS count FROM memories').get()!.count,0);
    }finally{migrated.close();}
  }finally{if(db.isOpen)db.close();await rm(path,{recursive:true,force:true});}
});
