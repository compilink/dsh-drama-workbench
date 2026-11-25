/** Native DSH integration checks for durable, non-preemptive task scheduling. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {spawn} from 'node:child_process';
import {Context} from '@deepseek-ai/cordis';
import {createStudio, mountStudio} from '../src/runtime.js';
import type {RunView, Studio, StudioSnapshot} from '../src/types.js';

async function until(studio: Studio, predicate: (state: StudioSnapshot) => boolean, label: string): Promise<StudioSnapshot> {
  const deadline = Date.now() + 15_000;
  let state = await studio.snapshot();
  while (!predicate(state) && Date.now() < deadline) { await delay(10); state = await studio.snapshot(); }
  assert.ok(predicate(state), `${label}: ${JSON.stringify(state.runs)}`);
  return state;
}
const runOf = (state: StudioSnapshot, id: string): RunView => state.runs.find(run => run.id === id)!;
const taskDone = (run: RunView, id: string): boolean => run.tasks.find(task => task.id === id)?.status === 'completed';
const quiet = (run: RunView): boolean => !run.deliveries.some(item => item.state === 'pending' || item.state === 'running');
interface LoggedEvent { type?: string; data?: {reason?: {kind?: string}; outcome?: string; id?: string; content?: unknown; message?: unknown}; }
async function sessionEvents(dataDir: string, sessionId: string): Promise<LoggedEvent[]> {
  const root = join(dataDir, 'sessions');
  const files = (await readdir(root, {recursive: true})).filter(file => file.endsWith('.jsonl') && file.split(sep).includes(sessionId));
  assert.ok(files.length, `native transcript exists for ${sessionId}`);
  return (await Promise.all(files.map(file => readFile(join(root, file), 'utf8')))).flatMap(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as LoggedEvent));
}
function assertUninterrupted(events: LoggedEvent[]): void {
  const ends = events.filter(event => event.type === 'turn/end');
  assert.ok(ends.length > 0, 'the original Worker reached a native turn end');
  assert.ok(ends.every(event => event.data?.reason?.kind === 'completed'), 'no original Worker turn was aborted, interrupted or failed');
  assert.ok(!events.some(event => event.type === 'agent/inbox/spliced' && event.data?.outcome === 'canceled'), 'no original Worker input was cancelled');
}

test('appending an independent task starts another same-template Worker without interrupting the active task', {timeout: 30_000}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-phase2-parallel-'));
  let studio: Studio | undefined;
  try {
    studio = await createStudio({dataDir, demoDelayMs: 400, scheduler: {maxActiveWorkers: 2, pollIntervalMs: 10}});
    const run = await studio.createRun({prompt: 'Original task A: preserve this objective.', mode: 'direct'});
    const first = run.tasks[0]!;
    const started = runOf(await until(studio, state => runOf(state, run.id).attempts.some(attempt => attempt.taskId === first.id && attempt.status === 'running'), 'first Worker starts'), run.id);
    const firstAttempt = started.attempts.find(attempt => attempt.taskId === first.id)!;
    const firstWorker = started.agents.find(agent => agent.id === firstAttempt.workerId)!;
    await until(studio, state => state.activity.some(event => event.agentId === firstWorker.id && event.kind === 'model-request'), 'first Worker is inside a real model request');
    const input = {prompt: 'Independent task B: produce a separate result.', requestId: 'parallel-task-b'};
    const second = await studio.addTask(run.id, input);
    assert.equal((await studio.addTask(run.id, input)).id, second.id, 'duplicate submission creates one Task');
    await assert.rejects(studio.addTask(run.id, {...input, prompt: 'A different objective with the same request id.'}), /conflict|different|request/i);
    const overlapping = runOf(await until(studio, state => runOf(state, run.id).attempts.filter(attempt => attempt.status === 'running').length === 2, 'both independent Workers run concurrently'), run.id);
    assert.equal(overlapping.tasks.find(task => task.id === first.id)!.prompt, first.prompt);
    const secondAttempt = overlapping.attempts.find(attempt => attempt.taskId === second.id)!;
    const secondWorker = overlapping.agents.find(agent => agent.id === secondAttempt.workerId)!;
    assert.notEqual(secondWorker.id, firstWorker.id);
    assert.notEqual(secondWorker.sessionId, firstWorker.sessionId);
    assert.equal(secondWorker.templateId, firstWorker.templateId);
    const finished = runOf(await until(studio, state => {
      const current = runOf(state, run.id); return taskDone(current, first.id) && taskDone(current, second.id) && quiet(current);
    }, 'both Tasks are explicitly accepted'), run.id);
    assert.equal(finished.tasks.length, 2);
    assert.equal(finished.attempts.filter(attempt => attempt.taskId === first.id).length, 1);
    assert.equal(finished.attempts.filter(attempt => attempt.taskId === second.id).length, 1);
    assert.equal(finished.agents.filter(agent => agent.role === 'orchestrator').length, 1);
    assert.ok(finished.tasks.every(task => task.result?.length));
    await studio.close(); studio = undefined;
    const originalLog = await sessionEvents(dataDir, firstWorker.sessionId);
    assertUninterrupted(originalLog);
    const originalInputs = originalLog.filter(event => event.type === 'user/message');
    assert.equal(originalInputs.length, 1, 'new Task never enters the active Worker conversation');
    assert.ok(!JSON.stringify(originalInputs).includes(second.id));
  } finally { await studio?.close(); await rm(dataDir, {recursive: true, force: true}); }
});

test('a Manager accepts queued additional work while its Worker runs and the worker capacity stays enforced', {timeout: 30_000}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-phase2-manager-'));
  const studio = await createStudio({dataDir, demoDelayMs: 350, scheduler: {maxActiveWorkers: 1, pollIntervalMs: 10}});
  try {
    const run = await studio.createRun({prompt: 'Manager task A.', mode: 'hierarchical'});
    const first = run.tasks[0]!;
    const working = runOf(await until(studio, state => runOf(state, run.id).attempts.some(attempt => attempt.status === 'running'), 'first managed Worker starts'), run.id);
    const manager = working.agents.find(agent => agent.role === 'manager')!;
    assert.ok(manager);
    const second = await studio.addTask(run.id, {prompt: 'Manager task B, independently queued.', requestId: 'manager-b', targetManagerId: manager.id});
    const queued = runOf(await until(studio, state => runOf(state, run.id).attempts.some(attempt => attempt.taskId === second.id && attempt.status === 'queued'), 'additional Task is dispatched but waits for a worker slot'), run.id);
    assert.equal(queued.tasks.find(task => task.id === second.id)!.coordinatorId, manager.id);
    assert.equal(queued.attempts.filter(attempt => attempt.status === 'running').length, 1);
    assert.equal(queued.attempts.find(attempt => attempt.taskId === first.id)!.status, 'running');
    const allManagedWorkers = queued.agents.filter(agent => agent.role === 'worker');
    assert.equal(allManagedWorkers.length, 2);
    assert.ok(allManagedWorkers.every(worker => worker.parentId === manager.id));
    const finished = runOf(await until(studio, state => {
      const current = runOf(state, run.id);
      assert.ok(current.attempts.filter(attempt => attempt.status === 'running').length <= 1, 'worker slots never oversubscribe');
      return current.tasks.every(task => task.status === 'completed') && quiet(current);
    }, 'capacity queue drains'), run.id);
    const a = finished.attempts.find(attempt => attempt.taskId === first.id)!;
    const b = finished.attempts.find(attempt => attempt.taskId === second.id)!;
    assert.ok(a.endedAt && b.startedAt && b.startedAt >= a.endedAt, 'B starts only after A releases execution capacity');
    await studio.sendMessage(run.id, '补充说明：保持当前结果。');
    const chatted = runOf(await until(studio, state => quiet(runOf(state, run.id)), 'root-only supplemental message settles'), run.id);
    assert.equal(chatted.tasks.length, 2, 'supplemental chat does not silently create independent work');
    assert.equal(chatted.agents.filter(agent => agent.role === 'manager').length, 1);
  } finally { await studio.close(); await rm(dataDir, {recursive: true, force: true}); }
});

test('shutdown preserves pending work and interrupted Attempt history for restart recovery', {timeout: 30_000}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-phase2-recovery-'));
  let studio: Studio | undefined;
  try {
    studio = await createStudio({dataDir, demoDelayMs: 500, scheduler: {maxActiveWorkers: 1, pollIntervalMs: 10}});
    const run = await studio.createRun({prompt: 'Recover running task A.', mode: 'direct'});
    const first = run.tasks[0]!;
    const active = runOf(await until(studio, state => runOf(state, run.id).attempts.some(attempt => attempt.status === 'running'), 'A starts before shutdown'), run.id);
    const oldAttempt = active.attempts.find(attempt => attempt.taskId === first.id)!;
    await until(studio, state => state.activity.some(event => event.agentId === oldAttempt.workerId && event.kind === 'model-request'), 'A entered its model request before shutdown');
    const second = await studio.addTask(run.id, {prompt: 'Recover pending task B.', requestId: 'recover-b'});
    const queued = runOf(await until(studio, state => runOf(state, run.id).attempts.some(attempt => attempt.taskId === second.id && attempt.status === 'queued'), 'B is durable and waiting'), run.id);
    const pendingAttempt = queued.attempts.find(attempt => attempt.taskId === second.id)!;
    const rootId = queued.orchestratorId;
    const originalSessions = new Map(queued.agents.map(agent => [agent.id, agent.sessionId]));
    await studio.close(); studio = undefined;
    studio = await createStudio({dataDir, demoDelayMs: 0, scheduler: {maxActiveWorkers: 1, pollIntervalMs: 10}});
    const recovered = runOf(await until(studio, state => {
      const current = runOf(state, run.id); return current.tasks.every(task => task.status === 'completed') && quiet(current);
    }, 'restarted scheduler finishes both original Tasks'), run.id);
    assert.equal(recovered.tasks.length, 2);
    assert.equal(recovered.orchestratorId, rootId);
    assert.ok(recovered.agents.every(agent => originalSessions.get(agent.id) === agent.sessionId), 'restart retains existing member sessions');
    assert.equal(recovered.attempts.find(attempt => attempt.id === oldAttempt.id)!.status, 'interrupted');
    const newAttempt = recovered.attempts.find(attempt => attempt.taskId === first.id && attempt.id !== oldAttempt.id)!;
    assert.equal(newAttempt.number, oldAttempt.number + 1);
    assert.equal(newAttempt.status, 'reported');
    assert.equal(recovered.attempts.filter(attempt => attempt.taskId === second.id).length, 1, 'unstarted work does not need a fabricated interrupted attempt');
    assert.equal(recovered.attempts.find(attempt => attempt.taskId === second.id)!.id, pendingAttempt.id);
    assert.equal((await studio.addTask(run.id, {prompt: second.prompt, requestId: second.requestId})).id, second.id, 'idempotency survives restart');
  } finally { await studio?.close(); await rm(dataDir, {recursive: true, force: true}); }
});

test('cancelling one active Task leaves the sibling Worker uninterrupted and cancelled work stays cancelled after restart', {timeout: 30_000}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-phase2-cancel-'));
  let studio: Studio | undefined;
  try {
    studio = await createStudio({dataDir, demoDelayMs: 350, scheduler: {maxActiveWorkers: 2, pollIntervalMs: 10}});
    const run = await studio.createRun({prompt: 'Task A must continue.', mode: 'direct'});
    const first = run.tasks[0]!;
    await until(studio, state => runOf(state, run.id).attempts.some(attempt => attempt.status === 'running'), 'A starts');
    const second = await studio.addTask(run.id, {prompt: 'Only cancel Task B.', requestId: 'cancel-b'});
    const overlap = runOf(await until(studio, state => runOf(state, run.id).attempts.filter(attempt => attempt.status === 'running').length === 2, 'A and B run'), run.id);
    const originalWorker = overlap.agents.find(agent => agent.id === overlap.attempts.find(attempt => attempt.taskId === first.id)!.workerId)!;
    await studio.cancelTask(run.id, second.id);
    const finished = runOf(await until(studio, state => taskDone(runOf(state, run.id), first.id) && quiet(runOf(state, run.id)), 'A finishes after B is cancelled'), run.id);
    assert.equal(finished.tasks.find(task => task.id === second.id)!.status, 'cancelled');
    assert.equal(finished.attempts.find(attempt => attempt.taskId === second.id)!.status, 'cancelled');
    await studio.close(); studio = undefined;
    assertUninterrupted(await sessionEvents(dataDir, originalWorker.sessionId));
    studio = await createStudio({dataDir, scheduler: {pollIntervalMs: 10}});
    const reopened = runOf(await studio.snapshot(), run.id);
    assert.equal(reopened.tasks.find(task => task.id === second.id)!.status, 'cancelled');
    assert.ok(!reopened.deliveries.some(item => item.taskId === second.id && ['pending', 'running'].includes(item.state)));
  } finally { await studio?.close(); await rm(dataDir, {recursive: true, force: true}); }
});

test('explicit retry preserves the failed Attempt and creates a new execution attempt', {timeout: 30_000}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-phase2-retry-'));
  const ctx = new Context();
  let injectFailure = true;
  ctx.on('agent/request', async (_payload, next) => {
    const config = await next();
    if (config.model === 'executor' && injectFailure) { injectFailure = false; throw new Error('Intentional one-shot Worker provider failure'); }
    return config;
  });
  const studio = await mountStudio(ctx, {dataDir, scheduler: {maxDeliveryAttempts: 1, pollIntervalMs: 10}});
  try {
    const run = await studio.createRun({prompt: 'Retry this task after a provider error.', mode: 'direct'});
    const task = run.tasks[0]!;
    const failed = runOf(await until(studio, state => ['failed', 'blocked'].includes(runOf(state, run.id).tasks[0]!.status), 'provider failure is recorded'), run.id);
    const originalAttempt = failed.attempts[0]!;
    assert.ok(originalAttempt);
    assert.equal(originalAttempt.status, 'failed');
    await studio.retryTask(run.id, task.id);
    const completed = runOf(await until(studio, state => taskDone(runOf(state, run.id), task.id) && quiet(runOf(state, run.id)), 'explicit retry succeeds'), run.id);
    assert.equal(completed.tasks.length, 1);
    assert.equal(completed.attempts.length, 2);
    assert.equal(completed.attempts.find(attempt => attempt.id === originalAttempt.id)!.status, 'failed');
    const retried = completed.attempts.find(attempt => attempt.id !== originalAttempt.id)!;
    assert.equal(retried.number, originalAttempt.number + 1);
    assert.equal(retried.status, 'reported');
  } finally { await studio.close(); await rm(dataDir, {recursive: true, force: true}); }
});

test('a killed host recovers running and queued tasks from SQLite without duplicate submission or lost attempt history', {timeout: 30_000}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-phase2-crash-'));
  const script = `
    import {createStudio} from ${JSON.stringify(new URL('../src/runtime.js', import.meta.url).href)};
    import {setTimeout as delay} from 'node:timers/promises';
    const studio = await createStudio({dataDir:process.env.STUDIO_CRASH_DATA_DIR,demoDelayMs:10000,scheduler:{maxActiveWorkers:1,pollIntervalMs:10}});
    const run = await studio.createRun({prompt:'Crash recovery task A.',mode:'direct'});
    let working;
    for (;;) {
      const snapshot=await studio.snapshot(); const current=snapshot.runs.find(r=>r.id===run.id);
      working=current.attempts.find(a=>a.status==='running');
      if (working && snapshot.activity.some(e=>e.kind==='model-request' && e.agentId===working.workerId)) break;
      await delay(10);
    }
    const second = await studio.addTask(run.id,{prompt:'Crash recovery task B.',requestId:'crash-b'});
    for (;;) {
      const current=(await studio.snapshot()).runs.find(r=>r.id===run.id);
      const pending=current.attempts.find(a=>a.taskId===second.id && a.status==='queued');
      if (pending) { console.log(JSON.stringify({ready:true,runId:run.id,firstId:run.tasks[0].id,secondId:second.id,activeAttempt:working.id,pendingAttempt:pending.id})); break; }
      await delay(10);
    }
    setInterval(()=>{},10000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {env: {...process.env, STUDIO_CRASH_DATA_DIR: dataDir}, stdio: ['ignore', 'pipe', 'pipe']});
  let studio: Studio | undefined;
  try {
    const ready = await new Promise<{runId: string; firstId: string; secondId: string; activeAttempt: string; pendingAttempt: string}>((accept, reject) => {
      let stdout = '', stderr = '';
      const timeout = setTimeout(() => reject(new Error(`Child did not reach durable running+queued state: ${stderr}`)), 15_000);
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Child exited before crash point (${code}): ${stderr}`)); });
      child.stdout.on('data', chunk => {
        stdout += String(chunk);
        for (;;) {
          const newline = stdout.indexOf('\n'); if (newline < 0) break;
          const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
          try { const value = JSON.parse(line) as {ready?: boolean; runId: string; firstId: string; secondId: string; activeAttempt: string; pendingAttempt: string}; if (value.ready) { clearTimeout(timeout); accept(value); } }
          catch { /* Ignore non-JSON diagnostic lines from native runtime startup. */ }
        }
      });
    });
    const exited = new Promise<void>(accept => child.once('exit', () => accept()));
    assert.equal(child.kill('SIGKILL'), true);
    await exited;
    studio = await createStudio({dataDir, scheduler: {maxActiveWorkers: 1, pollIntervalMs: 10}});
    const recovered = runOf(await until(studio, state => {
      const current = runOf(state, ready.runId); return current.tasks.every(task => task.status === 'completed') && quiet(current);
    }, 'host restart recovers all work after SIGKILL'), ready.runId);
    assert.equal(recovered.tasks.length, 2);
    assert.equal(recovered.attempts.find(attempt => attempt.id === ready.activeAttempt)!.status, 'interrupted');
    assert.equal(recovered.attempts.filter(attempt => attempt.taskId === ready.firstId).length, 2);
    assert.equal(recovered.attempts.find(attempt => attempt.id === ready.pendingAttempt)!.status, 'reported');
    assert.equal(recovered.attempts.filter(attempt => attempt.taskId === ready.secondId).length, 1);
    assert.equal((await studio.addTask(ready.runId, {prompt: 'Crash recovery task B.', requestId: 'crash-b'})).id, ready.secondId);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await studio?.close();
    await rm(dataDir, {recursive: true, force: true});
  }
});

test('new work queues behind an Orchestrator or Manager that is already generating without entering or cancelling its current turn', {timeout: 30_000}, async () => {
  for (const role of ['orchestrator', 'manager'] as const) {
    const dataDir = await mkdtemp(join(tmpdir(), `studio-phase2-busy-${role}-`));
    const ctx = new Context();
    let release!: () => void;
    const gate = new Promise<void>(accept => { release = accept; });
    let entered!: () => void;
    const insideRequest = new Promise<void>(accept => { entered = accept; });
    let blockedAgent: import('@deepseek-ai/dsh-agent').Agent | undefined;
    let matchingRequests = 0;
    const targetModel = role === 'orchestrator' ? 'planner' : 'coordinator';
    ctx.on('agent/created', ({agent}) => {
      agent.ctx.on('agent/request', async (_payload, next) => {
        const config = await next();
        if (config.model === targetModel) {
          matchingRequests++;
          if (!blockedAgent) { blockedAgent = agent; entered(); await gate; }
        }
        return config;
      });
    });
    let studio: Studio | undefined;
    try {
      studio = await mountStudio(ctx, {dataDir, scheduler: {maxActiveWorkers: 2, pollIntervalMs: 10}});
      const run = await studio.createRun({prompt: `Task A while ${role} is generating.`, mode: role === 'manager' ? 'hierarchical' : 'direct'});
      let barrierTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([insideRequest, new Promise<never>((_accept, reject) => { barrierTimer = setTimeout(() => reject(new Error(`${role} did not enter its native model request`)), 5000); })]);
      } finally { if (barrierTimer) clearTimeout(barrierTimer); }
      assert.ok(blockedAgent);
      const active = runOf(await studio.snapshot(), run.id);
      const recipient = active.agents.find(agent => agent.sessionId === blockedAgent!.id)!;
      assert.equal(recipient.role, role);
      const second = await studio.addTask(run.id, {prompt: `Independent B for busy ${role}.`, requestId: `busy-${role}-b`, ...(role === 'manager' ? {targetManagerId: recipient.id} : {})});
      const queued = runOf(await until(studio, state => runOf(state, run.id).deliveries.some(delivery => delivery.taskId === second.id && delivery.agentId === recipient.id && delivery.state === 'pending'), 'new Task waits behind the busy coordinator'), run.id);
      assert.equal(blockedAgent.status, 'running');
      assert.equal(matchingRequests, 1, 'new work starts no overlapping coordinator model request');
      const currentInputs = blockedAgent.session.events.filter(event => event.type === 'user/message');
      assert.equal(currentInputs.length, 1, 'only the original Task has entered the coordinator history');
      assert.ok(!JSON.stringify(currentInputs).includes(second.id), 'new task is not injected into the current turn');
      assert.ok(queued.deliveries.some(delivery => delivery.agentId === recipient.id && delivery.taskId === run.tasks[0]!.id && delivery.state === 'running'));
      release();
      await until(studio, state => {
        const current = runOf(state, run.id); return current.tasks.every(task => task.status === 'completed') && quiet(current);
      }, 'both tasks finish after the coordinator naturally finishes its first request');
      await studio.close(); studio = undefined;
      assertUninterrupted(await sessionEvents(dataDir, recipient.sessionId));
    } finally { release(); await studio?.close(); await rm(dataDir, {recursive: true, force: true}); }
  }
});
