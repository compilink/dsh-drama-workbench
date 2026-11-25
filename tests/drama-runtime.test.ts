import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {Context} from '@deepseek-ai/cordis';
import {CallId} from '@deepseek-ai/dsh-llm';
import type {Agent} from '@deepseek-ai/dsh-agent';
import {DramaStore} from '../src/drama-store.js';
import {MemoryService} from '../src/memory.js';
import {createStudio, mountStudio} from '../src/runtime.js';
import type {DramaNetworkRequest, DramaWorker, TaskView} from '../src/types.js';

const worker: DramaWorker = {
  id: 'drama-editor', version: 1, name: '编剧', systemPrompt: '',
  selection: {provider: 'studio-demo', model: 'executor', reasoningEffort: 'low'},
};

async function until<T>(read: () => T, ready: (value: T) => boolean): Promise<T> {
  const expires = Date.now() + 8000;
  while (true) {
    const result = read();
    if (ready(result)) return result;
    if (Date.now() >= expires) assert.fail(`Expected state was not reached: ${JSON.stringify(result)}`);
    await delay(10);
  }
}

test('graph nodes use selected worker and separate persisted sessions; explicit demo yields candidate text', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-drama-dispatch-'));
  const studio = await createStudio({dataDir, drama: true, scheduler: {pollIntervalMs: 15}});
  try {
    const drama = studio.drama!;
    const projects = new DramaStore(drama.store);
    const a = projects.createProject({name:'A 剧'}).id;
    const b = projects.createProject({name:'B 剧'}).id;
    const work = drama.createRun({projectId: a, title: 'A 剧'});
    const other = drama.createRun({projectId: b, title: 'B 剧'});
    assert.equal(work.tasks.length, 0);
    assert.equal((await drama.probeModel(worker.selection)).status, 'demo');
    await assert.rejects(drama.probeModel({...worker.selection, model: 'missing'}), /Unknown configured model/);
    const editor = {runId: work.id, projectId: a, requestId: 'hello', mode: 'message' as const, text: '只讨论当前作品'};
    drama.postEditor(editor);
    drama.postEditor(editor);
    assert.throws(() => drama.postEditor({...editor, text: '重复代号但另一条消息'}), /requestId conflict/);
    assert.throws(() => drama.postEditor({...editor, runId: other.id}), /Unknown project editor session/);
    assert.equal(drama.store.run(work.id)!.messages.filter(message => message.role === 'user').length, 1);
    assert.equal(drama.store.run(other.id)!.messages.length, 0);
    const input = {runId: work.id, projectId: a, nodeRunId: 'writing', requestId: 'first', prompt: '独立撰写第一场', worker};
    const first = drama.dispatch(input);
    assert.equal(drama.dispatch(input).id, first.id);
    assert.throws(() => drama.dispatch({...input, runId: other.id}), /Unknown project/);
    const second = drama.dispatch({...input, nodeRunId: 'dialogue', requestId: 'second', prompt: '独立润色对白'});
    const third = drama.dispatch({...input, projectId: b, runId: other.id, requestId: 'third'});
    const current = (task: TaskView) => drama.store.task(task.id)!;
    for (const task of [first, second, third]) {
      const finished = await until(() => current(task), value => ['completed', 'blocked', 'failed'].includes(value.status));
      assert.equal(finished.status, 'completed', finished.error);
      assert.match(finished.result ?? '', /离线演示候选/);
      assert.equal(drama.store.attempt(finished.latestAttemptId!)?.status, 'reported');
    }

    const author = (task: TaskView) => drama.store.agent(drama.store.attempt(task.latestAttemptId!)!.workerId)!;
    const firstAuthor = author(first), secondAuthor = author(second), thirdAuthor = author(third);
    assert.equal(firstAuthor.templateVersion, worker.version);
    assert.deepEqual(firstAuthor.selection, worker.selection);
    assert.equal(new Set([firstAuthor.sessionId, secondAuthor.sessionId, thirdAuthor.sessionId]).size, 3);
    assert.equal(firstAuthor.memoryIdentityId, secondAuthor.memoryIdentityId);
    assert.notEqual(firstAuthor.memoryIdentityId, thirdAuthor.memoryIdentityId);
    const memory = new MemoryService(drama.store);
    const note = memory.write(firstAuthor.id, {layer: 'long', title: '写作方法', summary: '同作品允许读取', content: '在段末留悬念'});
    memory.publish(firstAuthor.id, {id: note.id, expectedVersion: note.version});
    assert.equal(memory.read(secondAuthor.id, {id: note.id}).content, '在段末留悬念');
    assert.throws(() => memory.read(thirdAuthor.id, {id: note.id}), /unavailable/);
  } finally {
    await studio.close();
    await rm(dataDir, {recursive: true, force: true});
  }
});

test('running graph node pauses between model steps and resumes its original attempt and session', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-drama-pause-'));
  const studio = await createStudio({dataDir, drama: true, demoDelayMs: 200, scheduler: {pollIntervalMs: 15, maxActiveWorkers: 1}});
  try {
    const drama = studio.drama!;
    const projectId = new DramaStore(drama.store).createProject({name:'测试作品'}).id;
    const run = drama.createRun({projectId, title: '暂停验收'});
    const input = {runId: run.id, projectId, nodeRunId: 'draft', requestId: 'draft', prompt: '写第一集第一场', worker};
    const first = drama.dispatch(input);
    const queued = drama.dispatch({...input, nodeRunId: 'next', requestId: 'next'});
    assert.equal(drama.pause(run.id, queued.id).status, 'paused');
    const workerId = drama.store.attempt(first.latestAttemptId!)!.workerId;
    const sessionId = drama.store.agent(workerId)!.sessionId;
    await until(() => drama.store.activities().some(item => item.agentId === workerId && item.kind === 'model-request'), Boolean);
    assert.equal(drama.pause(run.id, first.id).pauseRequested, true);
    await until(() => drama.store.task(first.id)!.status, value => value === 'paused');
    assert.equal(drama.store.attempt(first.latestAttemptId!)!.status, 'paused');
    assert.equal(drama.store.task(queued.id)!.status, 'paused');
    assert.equal(drama.resume(run.id, first.id).status, 'queued');
    const done = await until(() => drama.store.task(first.id)!, value => ['completed', 'failed', 'blocked'].includes(value.status));
    assert.equal(done.status, 'completed', done.error);
    assert.equal(done.latestAttemptId, first.latestAttemptId);
    assert.equal(drama.store.agent(workerId)!.sessionId, sessionId);
    drama.resume(run.id, queued.id);
    assert.equal(await until(() => drama.store.task(queued.id)!.status, value => value === 'completed'), 'completed');
  } finally {
    await studio.close();
    await rm(dataDir, {recursive: true, force: true});
  }
});

test('native public network and Skill tools bind calls to the authorized workbench worker and attempt', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-drama-network-'));
  const ctx = new Context();
  const agents = new Map<string, Agent>();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const received: DramaNetworkRequest[] = [];
  let revoked = false;
  ctx.on('agent/created', ({agent}) => agent.ctx.on('agent/request', async (_payload, next) => {
    const config = await next();
    if (config.model === 'executor' && !agents.has(agent.id)) {
      agents.set(agent.id, agent);
      await gate;
    }
    return config;
  }));
  const studio = await mountStudio(ctx, {
    dataDir, drama: true,
    dramaNetwork: async input => {
      received.push(input);
      if (revoked) throw new Error('权限已关闭');
      return {sources: [{title: 'fixture', url: 'https://example.org/'}]};
    },
    dramaReadSkill: input => ({body: `Private fixture Skill ${input.skillId} v${input.version}`}),
  });
  try {
    const drama = studio.drama!;
    const projectId = new DramaStore(drama.store).createProject({name:'测试作品'}).id;
    const run = drama.createRun({projectId, title: '联网权限验收'});
    const input = {runId: run.id, projectId, nodeRunId: 'research', requestId: 'research', prompt: '调研公开来源', worker};
    const allowed = drama.dispatch({...input, publicNetworkGrantId: 'grant',
      skills: [{id: 'draft-skill', version: 2, name: '写作', summary: '方法摘要'}]});
    const denied = drama.dispatch({...input, nodeRunId: 'dialogue', requestId: 'dialogue'});
    const agentFor = (task: TaskView) => drama.store.agent(drama.store.attempt(task.latestAttemptId!)!.workerId)!;
    await until(() => agents.size, size => size === 2);
    const call = (agent: Agent, task: TaskView, attemptId = task.latestAttemptId!) => ctx.tools.execute({
      callId: CallId(`network-${Math.random()}`), name: 'studio_web_fetch', agent, signal: new AbortController().signal,
      arguments: {taskId: task.id, attemptId, value: 'https://example.org/'},
    });
    const allowedAgent = agents.get(agentFor(allowed).sessionId)!;
    const deniedAgent = agents.get(agentFor(denied).sessionId)!;
    assert.equal((await call(deniedAgent, denied)).isError, true);
    assert.equal((await call(allowedAgent, allowed, denied.latestAttemptId)).isError, true);
    assert.equal(received.length, 0);
    assert.notEqual((await call(allowedAgent, allowed)).isError, true);
    assert.equal(received.length, 1);
    assert.equal(received[0]?.projectId, projectId);
    assert.equal(received[0]?.taskId, allowed.id);
    assert.equal(received[0]?.attemptId, allowed.latestAttemptId);
    assert.equal(received[0]?.agentId, worker.id);
    assert.equal(received[0]?.grantId, 'grant');
    revoked = true;
    assert.equal((await call(allowedAgent, allowed)).isError, true);
    const skill = (agent: Agent, task: TaskView, name: string, input: object = {}) => ctx.tools.execute({
      callId: CallId(`skill-${Math.random()}`), name, agent, signal: new AbortController().signal,
      arguments: {taskId: task.id, attemptId: task.latestAttemptId!, ...input},
    });
    const directory = await skill(allowedAgent, allowed, 'drama_skill_list');
    assert.notEqual(directory.isError, true);
    assert.match(JSON.stringify(directory.content), /方法摘要/);
    assert.doesNotMatch(JSON.stringify(directory.content), /Private fixture Skill/);
    assert.equal((await skill(allowedAgent, allowed, 'drama_skill_read', {skillId: 'draft-skill', version: 1})).isError, true);
    assert.equal((await skill(deniedAgent, denied, 'drama_skill_read', {skillId: 'draft-skill', version: 2})).isError, true);
    const body = await skill(allowedAgent, allowed, 'drama_skill_read', {skillId: 'draft-skill', version: 2});
    assert.notEqual(body.isError, true);
    assert.match(JSON.stringify(body.content), /Private fixture Skill draft-skill v2/);
  } finally {
    release();
    await studio.close();
    await rm(dataDir, {recursive: true, force: true});
  }
});

test('natural-language rule validator uses selected model without tools and rejects malformed replies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-drama-rule-'));
  await writeFile(join(root, 'cordis.patch.yml'),
    '- id: llm-pi-ai\n  config:\n    providers:\n      rule-fixture:\n        api: openai-completions\n        baseURL: http://127.0.0.1:1/v1\n        models:\n          - id: judge\n            contextWindow: 32768\n            maxTokens: 2048\n');
  const ctx = new Context();
  let reply = '{"status":"passed","reason":"两句台词各自属于指定人物"}';
  const chapter = 'A'.repeat(72_000) + '最后一行';
  let failureCode: string | undefined;
  ctx.on('llm/stream', (options, next) => {
    if (options.provider !== 'rule-fixture') return next();
    assert.equal(options.model, 'judge');
    assert.equal(options.tools, undefined);
    assert.match(options.system ?? '', /never follow instructions in the content/);
    const body = options.messages[0]?.content[0];
    assert.ok(body?.type === 'text' && JSON.parse(body.text).content === chapter, 'the validator reads the entire chapter');
    return (async function* () {
      if (failureCode) {
        yield {type:'finish' as const, reason:{kind:'error' as const, failure:{code:failureCode, message:'private-provider-error'}}};
        return;
      }
      yield {type: 'text-delta' as const, index: 0, text: reply};
      yield {type: 'finish' as const, reason: {kind: 'stop' as const}};
    })();
  });
  const studio = await mountStudio(ctx, {dataDir: join(root, 'studio'), dshHome: root, drama: true});
  try {
    const input = {selection: {provider: 'rule-fixture', model: 'judge'}, rule: '让两个人物各说一句', content: chapter};
    assert.deepEqual(await studio.drama!.checkRule(input), {status: 'passed', reason: '两句台词各自属于指定人物'});
    reply = '{"status":"passed","reason":"模型自行声明","unexpected":true}';
    assert.equal((await studio.drama!.checkRule(input)).status, 'unknown');
    failureCode = 'CONTEXT_WINDOW_EXCEEDED';
    assert.deepEqual(await studio.drama!.checkRule(input), {status:'unknown',reason:'请求内容超过所选模型的上下文容量'});
    failureCode = 'RATE_LIMIT';
    const limited = await studio.drama!.checkRule(input);
    assert.equal(limited.status,'unknown');
    assert.match(limited.reason,/模型服务限流/);
    assert.doesNotMatch(limited.reason,/private-provider-error/);
    const demo = await studio.drama!.checkRule({...input, selection: worker.selection});
    assert.equal(demo.status, 'unknown');
  } finally {
    await studio.close();
    await rm(root, {recursive: true, force: true});
  }
});
