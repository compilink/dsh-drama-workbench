import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {DramaStore, DramaStoreError} from '../src/drama-store.js';
import {StudioStore} from '../src/store.js';

function hasStatus(status: number) {
  return (error: unknown) => error instanceof DramaStoreError && error.status === status;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'drama-store-'));
  let store = new StudioStore(directory);
  t.after(async () => { store.close(); await rm(directory, {recursive: true, force: true}); });
  return {
    directory,
    get store() { return store; },
    get owner() { return new DramaStore(store, 'writer'); },
    get other() { return new DramaStore(store, 'another-writer'); },
    reopen() { store.close(); store = new StudioStore(directory); return new DramaStore(store, 'writer'); },
  };
}

const selection = {provider: 'studio-demo', model: 'executor', reasoningEffort: 'low'};
function node(id: string, agentId: string) { return {id, title: id, agentId, x: 15, y: 50}; }

test('editing an older template appends against the current version and preserves both versions and existing projects', async t => {
  const f = await fixture(t);
  const catalog = f.owner;
  const author = catalog.saveAgent({name:'编剧', selection});
  const first = catalog.saveTemplate({name:'短篇', description:'原版说明', nodes:[node('opening', author.id)], edges:[]});
  const projectAtFirst = catalog.createProject({name:'甲', templateId:first.id});
  const second = catalog.saveTemplate({...first, expectedVersion:1, name:'长篇', description:'双节点说明',
    nodes:[...first.nodes,node('finale',author.id)], edges:[{from:'opening',to:'finale'}]});
  const projectAtSecond = catalog.createProject({name:'乙', templateId:first.id});
  const directory = catalog.templateHistory(first.id);
  assert.deepEqual(directory, {currentVersion:2, versions:[
    {version:2, name:'长篇', description:'双节点说明', nodeCount:2, edgeCount:1},
    {version:1, name:'短篇', description:'原版说明', nodeCount:1, edgeCount:0},
  ]});
  assert.throws(() => f.other.templateHistory(first.id), hasStatus(404));
  const old = catalog.template(first.id, 1);
  const third = catalog.saveTemplate({...old, expectedVersion:directory.currentVersion, name:'新版短篇'});
  assert.equal(third.version, 3);
  assert.deepEqual(third.nodes, first.nodes);
  assert.deepEqual(third.edges, []);
  assert.throws(() => catalog.saveTemplate({...old, expectedVersion:directory.currentVersion, name:'过期编辑'}), hasStatus(409));
  assert.deepEqual(catalog.template(first.id, 1), first);
  assert.deepEqual(catalog.template(first.id, 2), second);
  assert.deepEqual(catalog.graph(projectAtFirst.id).nodes, first.nodes);
  assert.deepEqual(catalog.graph(projectAtSecond.id).edges, second.edges);
  assert.equal(catalog.templateHistory(first.id).currentVersion, 3);
});

test('projects pin their template-derived canvas and historical revisions survive reopen', async t => {
  const f = await fixture(t);
  const one = f.owner.saveAgent({name: '责编', selection});
  const first = f.owner.saveTemplate({name: '剧集编辑', nodes: [node('script', one.id)], edges: []});
  const existing = f.owner.createProject({name: '测试作品', templateId: first.id});
  const second = f.owner.saveTemplate({...first, expectedVersion: 1, nodes: [node('script', one.id), node('dialogue', one.id)], edges: [{from: 'script', to: 'dialogue'}]});
  const newProject = f.owner.createProject({name: '霓虹', templateId: first.id});
  assert.equal(second.version, 2);
  assert.equal(newProject.templateVersion, 2);
  assert.equal(existing.templateVersion, 1);
  assert.equal(f.owner.graph(existing.id).nodes.length, 1);
  assert.equal(f.owner.graph(newProject.id).nodes.length, 2);
  const changed = f.owner.saveGraph(existing.id, 1, {nodes: [node('rewrite', one.id)], edges: []});
  assert.equal(changed.version, 2);
  assert.throws(() => f.owner.saveGraph(existing.id, 1, {nodes: [], edges: []}), hasStatus(409));
  assert.equal(f.owner.retireTemplate(first.id, 2).retired, true);
  assert.throws(() => f.owner.createProject({name: '旧配置', templateId: first.id, templateVersion: 1}), hasStatus(409));
  const reopened = f.reopen();
  assert.deepEqual(reopened.listTemplates(), []);
  assert.equal(reopened.template(first.id, 1).nodes[0].id, 'script');
  assert.equal(reopened.graph(existing.id, 1).nodes[0].id, 'script');
  assert.equal(reopened.graph(existing.id).nodes[0].id, 'rewrite');
  assert.equal(reopened.graph(newProject.id).edges[0].to, 'dialogue');
  assert.throws(() => f.store.db.prepare('UPDATE drama_graphs SET document=? WHERE project_id=?').run('{}', existing.id), /immutable/);
});

test('canvas rejects circular and ambiguous node relationships, then accepts independent branches', async t => {
  const f = await fixture(t);
  const project = f.owner.createProject({name: '测试作品'});
  const writer = f.owner.saveAgent({name: '编剧', selection});
  const manager = f.owner.saveAgent({name: '主编', selection, role: 'orchestrator'});
  const foreign = f.other.saveAgent({name: '外部编剧', selection});
  const a = node('a', writer.id), b = node('b', writer.id), c = node('c', writer.id);
  const ab = {from: 'a', to: 'b'};
  for (const graph of [
    {nodes: [a, b], edges: [ab, {from: 'b', to: 'a'}]},
    {nodes: [a], edges: [{from: 'a', to: 'a'}]},
    {nodes: [a], edges: [ab]},
    {nodes: [a, b], edges: [ab, ab]},
    {nodes: [a, a], edges: []},
  ]) assert.throws(() => f.owner.saveGraph(project.id, 1, graph), hasStatus(400));
  assert.throws(() => f.owner.saveGraph(project.id, 1, {nodes: [node('foreign', foreign.id)], edges: []}), hasStatus(404));
  assert.equal(f.owner.graph(project.id).version, 1);
  const saved = f.owner.saveGraph(project.id, 1, {nodes: [a, b, c], edges: [ab]});
  assert.deepEqual(saved.nodes.map(n => n.id), ['a', 'b', 'c']);
  assert.equal(saved.nodes[0].release, 'manual');
  assert.equal(f.owner.saveGraph(project.id,saved.version,{nodes:[node('manager',manager.id)], edges:[]}).nodes[0].agentId,manager.id);
});

test('agent public network authority is reusable, stable across edits and revocable across prior executions', async t => {
  const f = await fixture(t);
  const saved = f.owner.saveAgent({name: '研究', selection});
  assert.equal(saved.publicNetwork, false);
  assert.equal(f.owner.networkGrant(saved.id), undefined);
  assert.throws(() => f.owner.saveAgent({name: '总编', role: 'orchestrator', selection, publicNetwork: true}), hasStatus(400));
  const enabled = f.owner.saveAgent({...saved, expectedVersion: 1, publicNetwork: true});
  const grant = f.owner.networkGrant(saved.id)!;
  assert.equal(f.owner.networkAllowed(saved.id, grant.id), true);
  assert.equal(f.other.networkAllowed(saved.id, grant.id), false);
  const edited = f.owner.saveAgent({...enabled, expectedVersion: 2, systemPrompt: '交叉核对来源。'});
  assert.equal(f.owner.networkGrant(saved.id)?.id, grant.id);
  assert.equal(f.owner.agent(saved.id, 2).systemPrompt, '');
  assert.throws(() => f.owner.saveAgent({...enabled, expectedVersion: 2, publicNetwork: false}), hasStatus(409));
  const revoked = f.owner.saveAgent({...edited, expectedVersion: 3, publicNetwork: false});
  assert.equal(f.owner.networkAllowed(saved.id, grant.id), false);
  f.owner.saveAgent({...revoked, expectedVersion: 4, publicNetwork: true});
  const reopened = f.reopen();
  assert.notEqual(reopened.networkGrant(saved.id)?.id, grant.id);
  assert.equal(reopened.networkAllowed(saved.id, grant.id), false);
  assert.equal(reopened.networkAllowed(saved.id, reopened.networkGrant(saved.id)?.id), true);
});

test('project-scoped document revisions and sealed originals are both verified', async t => {
  const f = await fixture(t);
  const project = f.owner.createProject({name: '测试作品'});
  const sibling = f.owner.createProject({name: '霓虹'});
  const foreign = f.other.createProject({name: '镜面'});
  const bytes = Buffer.from('source file\n');
  const doc = f.owner.saveDocument(project.id, {name: '角色表', content: '旧设定', source: {name: 'origin.txt', mime: 'text/plain', base64: bytes.toString('base64')}});
  const edited = f.owner.saveDocument(project.id, {id: doc.id, expectedVersion: 1, name: doc.name, content: '新设定'});
  assert.equal(edited.version, 2);
  assert.equal(f.owner.document(project.id, doc.id, 1).content, '旧设定');
  assert.equal(f.owner.document(project.id, doc.id).content, '新设定');
  assert.deepEqual(f.owner.readDocumentSource(project.id, doc.id).bytes, bytes);
  assert.throws(() => f.owner.document(sibling.id, doc.id), hasStatus(404));
  assert.throws(() => f.owner.readDocumentSource(sibling.id, doc.id), hasStatus(404));
  assert.throws(() => f.owner.listDocuments(foreign.id), hasStatus(404));
  assert.throws(() => f.other.graph(project.id), hasStatus(404));
  assert.throws(() => f.owner.saveDocument(project.id, {id: doc.id, expectedVersion: 1, name: doc.name, content: '回退编辑'}), hasStatus(409));
  assert.throws(() => f.owner.saveDocument(project.id, {name: '不合法的原件', content: '有文字', source: {name: 'bad.txt', base64: '***'}}), hasStatus(400));
  const sourcePath = join(f.directory, 'drama-blobs', project.id, doc.source!.sha256!);
  await writeFile(sourcePath, 'tampered');
  assert.throws(() => f.owner.readDocumentSource(project.id, doc.id, 1), hasStatus(409));
  assert.deepEqual(f.owner.listDocuments(project.id).map(d => d.version), [2]);
});

test('episode comments match an exact current version and remain anchored to it after the passage changes', async t => {
  const f = await fixture(t);
  const project = f.owner.createProject({name: '测试作品'});
  const doc = f.owner.saveDocument(project.id, {name: '对质', kind: 'episode', episode: 8, scene: '8-1', field: 'dialogue', content: '前半段，结束。'});
  const input = {documentId: doc.id, version: doc.version, start: 4, end: 6, selectedText: '结束', text: '保留悬念'};
  assert.throws(() => f.owner.addEpisodeComment(project.id, {...input, selectedText: '对质'}), hasStatus(400));
  const comment = f.owner.addEpisodeComment(project.id, input);
  f.owner.saveDocument(project.id, {id: doc.id, expectedVersion: 1, name: doc.name, content: '换了文本。'});
  assert.throws(() => f.owner.addEpisodeComment(project.id, input), hasStatus(409));
  assert.deepEqual(f.owner.listEpisodeComments(project.id), [comment]);
  assert.equal(f.owner.document(project.id, comment.documentId, comment.version).content.slice(comment.start, comment.end), '结束');
});

test('network evidence persists on its actual authorized attempt without input queries or cross-work reads', async t => {
  const f = await fixture(t);
  const project = f.owner.createProject({name: '测试作品'});
  const neighbor = f.owner.createProject({name: '霓虹'});
  const worker = f.owner.saveAgent({name: '研究员', selection, publicNetwork: true});
  const grantId = f.owner.networkGrant(worker.id)!.id;
  const now = new Date().toISOString();
  f.store.saveRun({id: 'run', title: project.name, mode: 'direct', orchestratorId: 'editor', status: 'idle', createdAt: now});
  const base = {projectId: project.id, taskId: 'task', attemptId: 'attempt', agentId: worker.id, grantId, operation: 'search' as const};
  f.store.saveTask({id: base.taskId, runId: 'run', title: '找来源', requestId: 'task-1', prompt: 'research', coordinatorId: 'editor', status: 'running',
    createdAt: now, updatedAt: now, drama: {projectId: project.id, nodeRunId: 'node-run', agentId: worker.id, publicNetworkGrantId: grantId}});
  f.store.saveAttempt({id: base.attemptId, taskId: base.taskId, number: 1, workerId: 'runtime-worker', status: 'running', createdAt: now});
  const source = {title: '公开来源', url: 'https://example.org/source', retrievedAt: now, excerpt: '原始摘录'};
  f.owner.recordNetworkCall({...base, outcome: 'allowed', sources: [source, source, {...source, url: 'https://127.0.0.1/source'}, {...source, url: 'javascript:alert(1)'}]});
  f.owner.recordNetworkCall({...base, outcome: 'denied', sources: [{...source, title: '越权来源'}]});
  assert.throws(() => f.owner.recordNetworkCall({...base, outcome: 'allowed', projectId: neighbor.id}), hasStatus(404));
  const reopened = f.reopen();
  assert.deepEqual(reopened.networkSources(project.id, base.taskId, base.attemptId), [source]);
  assert.deepEqual(reopened.networkSources(neighbor.id, base.taskId, base.attemptId), []);
  assert.throws(() => f.other.networkSources(project.id, base.taskId, base.attemptId), hasStatus(404));
  const columns = f.store.db.prepare('PRAGMA table_info(drama_network_audit)').all().map(row => row.name);
  assert.ok(!columns.includes('query') && !columns.includes('value'));
  assert.throws(() => f.store.db.exec('DELETE FROM drama_network_audit'), /immutable/);
});

test('previous workbench storage migrates without rewriting existing projects', async t => {
  const f = await fixture(t);
  const project = f.owner.createProject({name: '测试作品'});
  f.store.db.exec('DROP TABLE drama_skill_versions; DROP TABLE drama_skills; DROP TABLE drama_network_audit; UPDATE drama_schema SET version=1 WHERE id=1');
  const reopened = f.reopen();
  assert.equal(f.store.db.prepare('SELECT version FROM drama_schema').get()?.version, 4);
  assert.deepEqual(reopened.project(project.id), project);
  assert.deepEqual(reopened.networkSources(project.id, 'unknown-task', 'unknown-attempt'), []);
});

test('skills list metadata, pin bodies by version and retire without changing bound history', async t => {
  const f=await fixture(t);
  const first=f.owner.saveSkill({name:'节拍核对',summary:'定位拍点',body:'版本一正文'});
  assert.equal(Object.hasOwn(f.owner.listSkills()[0]!, 'body'), false);
  const agent=f.owner.saveAgent({name:'编剧',selection,skillIds:[first.id]});
  const pinned=f.owner.snapshotSkills(agent.skillIds);
  const second=f.owner.saveSkill({id:first.id,expectedVersion:first.version,name:first.name,summary:first.summary,body:'版本二正文'});
  assert.equal(second.version, 2);
  assert.equal(f.owner.skill(first.id,pinned[0]!.version).body,'版本一正文');
  assert.equal(f.owner.snapshotSkills(agent.skillIds)[0]?.version,2);
  assert.throws(() => f.other.skill(first.id), hasStatus(404));
  assert.throws(() => f.other.saveAgent({name:'其他 Agent',selection,skillIds:[first.id]}),hasStatus(404));
  f.owner.retireSkill(first.id,2);
  assert.deepEqual(f.owner.snapshotSkills(agent.skillIds),[]);
  const reopened=f.reopen();
  assert.deepEqual(reopened.agent(agent.id).skillIds,[first.id]);
  assert.equal(reopened.skill(first.id,1).body,'版本一正文');
  assert.throws(() => f.store.db.exec('DELETE FROM drama_skill_versions'),/immutable/);
});
