/** Assembled DSH memory, context recovery and optional real-container acceptance paths. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Context} from '@deepseek-ai/cordis';
import {execFileSync} from 'node:child_process';
import {CallId} from '@deepseek-ai/dsh-llm';
import type {Agent} from '@deepseek-ai/dsh-agent';
import type {ToolExecutionResult} from '@deepseek-ai/dsh-tools';
import {createStudio, mountStudio} from '../src/runtime.js';
import {DockerExecution, dockerClientEnvironment} from '../src/execution.js';
import type {Studio, StudioSnapshot, RunView} from '../src/types.js';

async function until(studio: Studio, predicate: (state: StudioSnapshot) => boolean): Promise<StudioSnapshot> {
  const deadline = Date.now() + 20_000;
  let state = await studio.snapshot();
  while (!predicate(state) && Date.now() < deadline) { await delay(10); state = await studio.snapshot(); }
  assert.ok(predicate(state), JSON.stringify(state.runs));
  return state;
}
function quiet(run: RunView): boolean { return !run.deliveries.some(item => item.state === 'pending' || item.state === 'running'); }
function value(result: ToolExecutionResult): Record<string, unknown> {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')) as Record<string, unknown>;
}
function barrier() { let resolve!: () => void; return {promise: new Promise<void>(accept => {resolve = accept;}), release: () => resolve()}; }

test('native memory tools bind the live caller and disclose bodies only through authorized read pages', {timeout: 30_000}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-phase3-memory-tools-'));
  const ctx = new Context(), rootReady = barrier(), workerReady = barrier(), rootGate = barrier(), workerGate = barrier();
  let root!: Agent, worker!: Agent, manager!: Agent;
  ctx.on('agent/created', ({agent}) => {
    agent.ctx.on('agent/request', async (_payload, next) => {
      const config = await next();
      if (config.model === 'planner' && !root) { root = agent; rootReady.release(); await rootGate.promise; }
      if (config.model === 'coordinator') manager = agent;
      if (config.model === 'executor' && !worker) { worker = agent; workerReady.release(); await workerGate.promise; }
      return config;
    });
  });
  const studio = await mountStudio(ctx, {dataDir});
  const call = (agent: Agent, name: string, args: object) => ctx.tools.execute({callId: CallId(`test-${Date.now()}-${Math.random()}`), name, arguments: args, agent, signal: new AbortController().signal});
  try {
    const run = await studio.createRun({prompt: 'Inspect authorized memory tools.', mode: 'hierarchical'});
    await rootReady.promise;
    const parentSecret = 'PARENT_PRIVATE_BODY_MUST_NOT_REACH_WORKER';
    const parent = value(await call(root, 'studio_memory_write', {layer: 'long', title: 'Private parent method', summary: 'Parent method summary', content: parentSecret}));
    ctx.on('tools/pre-execute', async () => ({kind: 'allow' as const}));
    const forbiddenExec = await call(root, 'studio_exec', {taskId: run.tasks[0]!.id, attemptId: 'invented', command: 'env'});
    assert.equal(forbiddenExec.isError, true, 'a permissive waterfall cannot grant coordinator execution');
    rootGate.release(); await workerReady.promise;
    assert.equal((await call(manager, 'studio_exec', {taskId: run.tasks[0]!.id, attemptId: 'invented', command: 'env'})).isError, true, 'a permissive waterfall cannot grant Manager execution');
    assert.equal((await call(worker, 'studio_memory_read', {id: parent.id, actorId: run.orchestratorId})).isError, true, 'model-supplied caller identity cannot grant ancestor reads');
    assert.equal((await call(worker, 'studio_memory_write', {id: parent.id, expectedVersion: parent.version, layer: 'long', title: 'Overwrite', summary: 'Must fail', content: 'fake'})).isError, true);
    const content = 'WORKER_PRIVATE_BODY_'.repeat(30);
    const entry = value(await call(worker, 'studio_memory_write', {layer: 'medium', title: 'Worker task state', summary: 'A bounded summary', content}));
    const directory = value(await call(worker, 'studio_memory_list', {query: 'WORKER_PRIVATE_BODY'}));
    assert.ok(!JSON.stringify(directory).includes(content));
    const page = value(await call(worker, 'studio_memory_read', {id: entry.id, limit: 20}));
    assert.equal(page.content, content.slice(0, 20)); assert.equal(page.nextOffset, 20);
    const rootDirectory = await studio.listMemory(run.id, {query: 'WORKER_PRIVATE_BODY'});
    assert.equal(rootDirectory.total, 1); assert.ok(!('content' in rootDirectory.items[0]!));
    assert.equal((await studio.readMemory(run.id, {id: String(entry.id), offset: 20, limit: 20})).content, content.slice(20, 40));
    workerGate.release();
    const state = await until(studio, snapshot => snapshot.runs[0]!.tasks[0]!.status === 'completed' && quiet(snapshot.runs[0]!));
    assert.ok(!JSON.stringify(state.activity).includes(parentSecret));
    assert.ok(!JSON.stringify(state.activity).includes(content));
    const workerInputs = worker.session.events.filter(event => event.type === 'user/message');
    assert.ok(!JSON.stringify(workerInputs).includes(parentSecret));
    assert.ok(!JSON.stringify(workerInputs).includes(content), 'entrypoint injection never includes memory bodies');
  } finally { rootGate.release(); workerGate.release(); await studio.close(); await rm(dataDir, {recursive: true, force: true}); }
});

test('real DSH compaction replaces active history before a logged checkpoint reference restores progress', {timeout: 30_000}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-phase3-compaction-'));
  const ctx = new Context();
  let compacted = false, nextRequestSawReference = false;
  let worker!: Agent;
  let shadowed: number[] = [];
  ctx.on('agent/created', ({agent}) => {
    agent.ctx.on('agent/pre-step', async ({step, signal}, next) => {
      const decision = await next();
      if (agent.options.model === 'executor' && step === 5 && !compacted) {
        worker = agent; compacted = true;
        const nodes = [...agent.session.surface.nodes];
        assert.ok(nodes.length > 3);
        const result = await ctx.compaction.compactRegion(nodes[0]!, nodes.at(-1)!, agent, signal);
        shadowed = result.shadowedSeqs;
        assert.equal(agent.session.surface.replaceGeneration, 1);
      }
      return decision;
    });
    agent.ctx.on('agent/request', async (_payload, next) => {
      if (compacted && agent === worker && !nextRequestSawReference) {
        const visible = agent.session.surface.nodes.map(seq => agent.session.events[seq]!);
        const reference = visible.find(event => event.type === 'user/message' && event.data.id.startsWith('studio-memory-recovery:'));
        assert.ok(reference, 'the first request after compaction can see the recovery reference');
        assert.equal(reference.type, 'user/message');
        const rendered = JSON.stringify(reference.data);
        assert.ok(rendered.includes('checkpoint'));
        assert.ok(!rendered.includes('"content":"{'), 'checkpoint body was not automatically disclosed');
        nextRequestSawReference = true;
      }
      return next();
    });
  });
  const studio = await mountStudio(ctx, {dataDir, compaction: {auto: false}});
  try {
    const run = await studio.createRun({prompt: 'Restore this task from a short-term checkpoint after actual context compaction.', mode: 'direct'});
    const state = await until(studio, snapshot => snapshot.runs.find(item => item.id === run.id)!.tasks[0]!.status === 'completed' && quiet(snapshot.runs.find(item => item.id === run.id)!));
    assert.ok(compacted && nextRequestSawReference);
    assert.ok(shadowed.length > 3 && shadowed.every(seq => !worker.session.surface.nodes.includes(seq)), 'original nodes are truly removed from the active surface');
    const events = worker.session.events;
    const end = events.find(event => event.type === 'compaction/end')!;
    const reference = events.find(event => event.type === 'user/message' && event.data.id.startsWith('studio-memory-recovery:'))!;
    assert.ok(reference.type === 'user/message');
    assert.deepEqual(reference.sourceEventSeqs, [end.seq]);
    assert.ok(events.slice(reference.seq + 1).some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'tool-call' && block.name === 'studio_memory_read')), 'the scripted model explicitly reads the persisted checkpoint after compaction');
    const checkpoints = await studio.listMemory(run.id, {layer: 'short'});
    assert.equal(checkpoints.total, 1);
    const body = await studio.readMemory(run.id, {id: checkpoints.items[0]!.id});
    assert.equal(JSON.parse(body.content).phase, 'executed');
    assert.ok(state.activity.some(item => item.kind === 'memory-recovery-reference'));
    const completed = state.runs.find(item => item.id === run.id)!;
    assert.equal(completed.attempts.length, 1, 'compaction continues the same execution attempt');
    assert.ok(completed.deliveries.every(delivery => delivery.failures === 0), 'checkpoint restoration must not rely on delivery retries');
    await studio.close();
    const resumed = await createStudio({dataDir});
    try { assert.equal((await resumed.readMemory(run.id, {id: checkpoints.items[0]!.id})).content, body.content); }
    finally { await resumed.close(); }
  } finally { await studio.close(); await rm(dataDir, {recursive: true, force: true}); }
});

test('selected previous identities reuse only long-term memory while new Sessions and short notes remain independent', {timeout: 30_000}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-phase3-reuse-'));
  const studio = await createStudio({dataDir});
  try {
    const first = await studio.createRun({prompt: 'Store first collaboration methods.', mode: 'hierarchical'});
    const initial = (await until(studio, state => state.runs.find(run => run.id === first.id)!.tasks.every(task => task.status === 'completed') && quiet(state.runs.find(run => run.id === first.id)!))).runs.find(run => run.id === first.id)!;
    const oldWorker = initial.agents.find(agent => agent.role === 'worker')!;
    const long = (await studio.listMemory(first.id, {layer: 'long', ownerAgentId: oldWorker.id})).items[0]!;
    const short = (await studio.listMemory(first.id, {layer: 'short', ownerAgentId: oldWorker.id})).items[0]!;
    const second = await studio.createRun({prompt: 'Reuse the explicitly selected team methods.', mode: 'hierarchical', reuseMemoryFromRunId: first.id});
    const reused = (await until(studio, state => state.runs.find(run => run.id === second.id)!.tasks.every(task => task.status === 'completed') && quiet(state.runs.find(run => run.id === second.id)!))).runs.find(run => run.id === second.id)!;
    const newWorker = reused.agents.find(agent => agent.role === 'worker')!;
    assert.notEqual(newWorker.id, oldWorker.id); assert.notEqual(newWorker.sessionId, oldWorker.sessionId);
    assert.equal(newWorker.memoryIdentityId, oldWorker.memoryIdentityId); assert.equal(newWorker.memorySourceAgentId, oldWorker.id);
    assert.equal((await studio.readMemory(second.id, {id: long.id})).entry.id, long.id);
    await assert.rejects(studio.readMemory(second.id, {id: short.id}), /unavailable/);
    const third = await studio.createRun({prompt: 'New independent team without identity reuse.', mode: 'direct'});
    await until(studio, state => state.runs.find(run => run.id === third.id)!.tasks.every(task => task.status === 'completed'));
    await assert.rejects(studio.readMemory(third.id, {id: long.id}), /unavailable/);
  } finally { await studio.close(); await rm(dataDir, {recursive: true, force: true}); }
});

test('only the exact stock Worker template is upgraded while personalized prompts and existing snapshots remain frozen', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-phase3-template-'));
  const oldPrompt = '你是 Worker。只执行当前 taskId/attemptId 的 studio_probe 无副作用验证，之后用 studio_report 汇报实际结果，不虚构文件修改或容器执行。';
  let studio = await createStudio({dataDir});
  try {
    const template = (await studio.snapshot()).templates.find(item => item.role === 'worker')!;
    await studio.saveTemplate({...template, systemPrompt: oldPrompt});
    const run = await studio.createRun({prompt: 'Freeze a phase-two worker snapshot.', mode: 'direct'});
    await until(studio, state => state.runs[0]!.tasks[0]!.status === 'completed' && quiet(state.runs[0]!));
    await studio.close(); studio = await createStudio({dataDir});
    const upgraded = await studio.snapshot(), worker = upgraded.runs.find(item => item.id === run.id)!.agents.find(agent => agent.role === 'worker')!;
    assert.equal(worker.systemPrompt, oldPrompt);
    const current = upgraded.templates.find(item => item.id === template.id)!;
    assert.notEqual(current.systemPrompt, oldPrompt); assert.equal(current.version, template.version + 2);
    await studio.saveTemplate({...current, systemPrompt: 'Personal instruction that must remain unchanged.'});
    await studio.close(); studio = await createStudio({dataDir});
    assert.equal((await studio.snapshot()).templates.find(item => item.id === template.id)!.systemPrompt, 'Personal instruction that must remain unchanged.');
  } finally { await studio.close(); await rm(dataDir, {recursive: true, force: true}); }
});

test('a real Worker executes container code and exposes only bounded read-only artifacts after reporting', {timeout: 60_000, skip: !process.env.STUDIO_TEST_DOCKER_IMAGE}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-phase3-container-runtime-'));
  const studio = await createStudio({dataDir, execution: {enabled: true, image: process.env.STUDIO_TEST_DOCKER_IMAGE}});
  try {
    const run = await studio.createRun({prompt: 'Execute the deterministic container demonstration and verify its file.', mode: 'direct'});
    const working = await until(studio, snapshot => snapshot.runs[0]!.attempts.some(attempt => attempt.status === 'running'));
    const activeAttempt = working.runs[0]!.attempts[0]!;
    await assert.rejects(studio.listArtifacts(run.id, activeAttempt.id, {}), /after this Attempt finishes/);
    await assert.rejects(studio.readArtifact(run.id, activeAttempt.id, {path: 'result.json'}), /after this Attempt finishes/);
    const state = await until(studio, snapshot => snapshot.runs[0]!.tasks[0]!.status === 'completed' && quiet(snapshot.runs[0]!));
    const attempt = state.runs[0]!.attempts[0]!;
    const entries = await studio.listArtifacts(run.id, attempt.id, {});
    assert.ok(entries.entries.some(entry => entry.name === 'result.json' && entry.kind === 'file'));
    const artifact = await studio.readArtifact(run.id, attempt.id, {path: 'result.json'});
    const actual = JSON.parse(artifact.content) as {taskId: string; attemptId: string; verified: boolean};
    assert.equal(actual.taskId, run.tasks[0]!.id); assert.equal(actual.attemptId, attempt.id); assert.equal(actual.verified, true);
    assert.ok(state.activity.some(event => event.kind === 'container-exec' && event.text.includes('"exitCode":0')));
    await assert.rejects(studio.readArtifact('other-run', attempt.id, {path: 'result.json'}), /Unknown artifact/);
    await assert.rejects(studio.readArtifact(run.id, attempt.id, {path: '../studio.sqlite'}), /relative|workspace/i);
  } finally {
    await studio.close();
    const owner = new DockerExecution({}, {dataDir}).ownerId;
    const args = ['volume', 'ls', '-q', '--filter', `label=dev.dsh-agent-studio.owner=${owner}`, '--filter', 'label=dev.dsh-agent-studio.managed=workspace'];
    const volumes = execFileSync('docker', args, {encoding: 'utf8', env: dockerClientEnvironment()}).trim().split('\n').filter(Boolean);
    if (volumes.length) execFileSync('docker', ['volume', 'rm', ...volumes], {env: dockerClientEnvironment()});
    await rm(dataDir, {recursive: true, force: true});
  }
});
