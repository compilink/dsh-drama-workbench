import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createStudio} from '../src/runtime.js';
import type {Studio, StudioSnapshot, RunView} from '../src/types.js';

async function settled(studio: Studio, runId: string, probes: number): Promise<RunView> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = await studio.snapshot();
    const run = state.runs.find(item => item.id === runId)!;
    if (state.activity.some(event => event.runId === runId && event.kind === 'error')) assert.fail(JSON.stringify(state.activity.filter(event => event.runId === runId && event.kind === 'error')));
    if (state.activity.filter(event => event.runId === runId && event.kind === 'probe').length >= probes && run.status === 'idle' && run.messages.some(message => message.role === 'assistant')) return run;
    await delay(20);
  }
  assert.fail(`Run did not settle: ${JSON.stringify((await studio.snapshot()).runs)}`);
}

async function logs(root: string): Promise<Array<{type?: string; data?: Record<string, unknown>; id?: string}>> {
  const files = await readdir(root, {recursive: true});
  const result = [];
  for (const filename of files.filter(name => name.endsWith('.jsonl'))) {
    result.push(...(await readFile(join(root, filename), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  }
  return result;
}

test('DSH configuration snapshots survive restart; new tasks and Runs select new template versions', {timeout: 45_000}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-integration-'));
  let studio: Studio | undefined;
  try {
    studio = await createStudio({dataDir});
    let initial = await studio.snapshot();
    for (const template of initial.templates) await studio.saveTemplate({...template, systemPrompt: `${template.systemPrompt}\n独立提示词验收标记：${template.role}-V1`});
    const first = await studio.createRun({prompt: '通过 Manager 委派 Worker 完成无副作用能力探针，并报告结果。', mode: 'hierarchical'});
    const finished = await settled(studio, first.id, 1);
    assert.equal(finished.agents.length, 3);
    const orchestrator = finished.agents.find(a => a.role === 'orchestrator')!;
    const manager = finished.agents.find(a => a.role === 'manager')!;
    const worker = finished.agents.find(a => a.role === 'worker')!;
    assert.equal(manager.parentId, orchestrator.id);
    assert.equal(worker.parentId, manager.id);
    assert.equal(finished.agents.filter(a => !a.parentId).length, 1);
    assert.deepEqual(finished.agents.map(a => a.selection.reasoningEffort), ['high', 'medium', 'low']);
    const originalIds = finished.agents.map(a => a.sessionId).sort();
    const changedWorker = (await studio.snapshot()).templates.find(t => t.role === 'worker')!;
    await studio.saveTemplate({...changedWorker, systemPrompt: '新版 Worker 提示词 V2：使用探针并向上级汇报。', selection: {...changedWorker.selection, reasoningEffort: 'high'}});
    await assert.rejects(studio.saveTemplate({...changedWorker, name: 'stale edit'}), /version conflict/);
    await studio.close(); studio = undefined;

    const events = await logs(join(dataDir, 'sessions'));
    const headers = events.filter(event => event.type === 'request/header').map(event => event.data?.header as {config: Record<string, unknown>; systemPrompt?: string});
    assert.ok(headers.some(header => header.config.model === 'planner' && header.config.reasoningEffort === 'high'));
    assert.ok(headers.some(header => header.config.model === 'coordinator' && header.config.reasoningEffort === 'medium'));
    assert.ok(headers.some(header => header.config.model === 'executor' && header.config.reasoningEffort === 'low'));
    assert.ok(headers.every(header => header.config.maxTokens === 2048), 'all role requests have the output budget');
    assert.ok(JSON.stringify(headers).includes('worker-V1'), 'actual logged model request contains its own prompt');
    assert.ok(!events.some(event => event.type?.startsWith('studio/')), 'external domain state does not use unsupported DSH session events');

    studio = await createStudio({dataDir});
    await studio.sendMessage(first.id, '补充：保留原任务验收结果。');
    await delay(50);
    const resumed = await settled(studio, first.id, 1);
    assert.deepEqual(resumed.agents.map(a => a.sessionId).sort(), originalIds);
    assert.equal(resumed.agents.find(a => a.role === 'worker')!.selection.reasoningEffort, 'low');
    assert.ok(resumed.agents.find(a => a.role === 'worker')!.systemPrompt.includes('worker-V1'));

    const extra = await studio.addTask(first.id, {prompt: '同一执行组的新独立探针任务', requestId: 'new-template-task', targetManagerId: manager.id});
    const appended = await settled(studio, first.id, 2);
    const extraWorker = appended.agents.find(a => a.id === appended.attempts.find(a => a.taskId === extra.id)!.workerId)!;
    assert.equal(extraWorker.selection.reasoningEffort, 'high');
    assert.ok(extraWorker.systemPrompt.includes('V2'));
    assert.equal(appended.agents.find(a => a.id === manager.id)!.sessionId, manager.sessionId);

    const next = await studio.createRun({prompt: '直接委派 Worker 做能力探针。', mode: 'direct'});
    const direct = await settled(studio, next.id, 1);
    assert.equal(direct.agents.length, 2);
    assert.ok(!direct.agents.some(a => a.role === 'manager'));
    assert.ok(direct.agents.every(a => !originalIds.includes(a.sessionId)));
    assert.equal(direct.agents.find(a => a.role === 'worker')!.selection.reasoningEffort, 'high');
    assert.ok(direct.agents.find(a => a.role === 'worker')!.systemPrompt.includes('V2'));
    const current = await studio.snapshot();
    assert.equal(current.templates.find(t => t.role === 'worker')!.memoryIdentityId, changedWorker.memoryIdentityId);
    assert.deepEqual(current.capabilities, {execution: 'probe-only', memory: 'sqlite-three-layer', containers: 'disabled', trustedTools: 'planned', tasks: 'durable', scheduling: 'non-preemptive'});
    await studio.close(); studio = undefined;
    const resumedHeaders = (await logs(join(dataDir, 'sessions'))).filter(event => event.type === 'request/header').map(event => event.data?.header as {config: Record<string, unknown>});
    assert.ok(resumedHeaders.length > headers.length);
    assert.ok(resumedHeaders.every(header => header.config.maxTokens === 2048), 'cold-resumed children keep the output budget');
  } finally { await studio?.close(); await rm(dataDir, {recursive: true, force: true}); }
});

test('template selection rejects unsupported effort and unknown provider before creating an agent', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-config-'));
  const studio = await createStudio({dataDir});
  try {
    const template = (await studio.snapshot()).templates[0]!;
    await assert.rejects(studio.saveTemplate({...template, selection: {...template.selection, reasoningEffort: 'invented'}}), /Unsupported reasoning effort/);
    await assert.rejects(studio.saveTemplate({...template, selection: {provider: 'unknown', model: 'missing'}}), /Unknown configured model/);
    assert.equal((await studio.snapshot()).runs.length, 0);
  } finally { await studio.close(); await rm(dataDir, {recursive: true, force: true}); }
});
