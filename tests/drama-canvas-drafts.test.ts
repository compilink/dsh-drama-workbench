import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {StudioStore} from '../src/store.js';
import {DramaStore} from '../src/drama-store.js';
import {CanvasDrafts} from '../src/drama-canvas-drafts.js';

test('project draft persists before assignment, publishes atomically and rejects stale revisions or stale head',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'canvas-drafts-'));
  let store=new StudioStore(dir);
  try{
    let drama=new DramaStore(store);
    let drafts=new CanvasDrafts(store,drama);
    const project=drama.createProject({name:'作品'});
    const agent=drama.saveAgent({name:'编剧',role:'worker',selection:{provider:'fixture',model:'fixture'}});
    const node={id:'a',title:'人物',agentId:'',x:1,y:2};
    const input={expectedRevision:null,baseVersion:1,sourceVersion:1,nodes:[node],edges:[]};
    const first=drafts.save('project',project.id,input).draft;
    assert.deepEqual(drama.graph(project.id).nodes,[]);
    assert.throws(()=>drafts.publish('project',project.id,{expectedRevision:first.revision}),/选择 Agent/);
    assert.throws(()=>drafts.save('project',project.id,input),/其他窗口/);
    store.close();store=new StudioStore(dir);drama=new DramaStore(store);drafts=new CanvasDrafts(store,drama);
    assert.deepEqual(drafts.read('project',project.id).draft,first);
    const ready=drafts.save('project',project.id,{...input,expectedRevision:first.revision,nodes:[{...node,agentId:agent.id}]}).draft;
    assert.throws(()=>drafts.discard('project',project.id,{expectedRevision:first.revision}),/其他窗口/);
    const saved=drafts.publish('project',project.id,{expectedRevision:ready.revision});
    assert.equal(saved.item.version,2);
    assert.equal(drafts.read('project',project.id).draft,null);
    const stale=drafts.save('project',project.id,{...input,sourceVersion:2,baseVersion:2}).draft;
    drama.saveGraph(project.id,2,{nodes:[],edges:[]});
    assert.throws(()=>drafts.publish('project',project.id,{expectedRevision:stale.revision}),/生效版本/);
    assert.equal(drafts.read('project',project.id).draft?.revision,stale.revision);
    const archive=drama.archiveProject(project.id);
    assert.throws(()=>drafts.read('project',project.id),/已归档/);
    drama.beginProjectDeletion(project.id,archive.archivedAt!);drama.deleteProject(project.id,archive.archivedAt!);
    assert.equal(store.db.prepare('SELECT count(*) n FROM drama_canvas_drafts').get()?.n,0);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
