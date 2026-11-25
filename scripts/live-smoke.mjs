/** Explicit opt-in: one real configured Worker with demo coordinators. */
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createStudio} from '../dist/src/runtime.js';

const provider = process.env.STUDIO_LIVE_PROVIDER;
const model = process.env.STUDIO_LIVE_MODEL;
const dshHome = process.env.STUDIO_DSH_HOME;
if (!provider || !model || !dshHome) throw new Error('Set STUDIO_DSH_HOME, STUDIO_LIVE_PROVIDER and STUDIO_LIVE_MODEL explicitly. This command calls the selected real model.');
const dataDir = await mkdtemp(join(tmpdir(), 'studio-live-smoke-'));
let studio;
let latest;
try {
  studio = await createStudio({dataDir, dshHome});
  const template = (await studio.snapshot()).templates.find(t => t.role === 'worker');
  await studio.saveTemplate({...template, selection: {provider, model}, systemPrompt: 'You are the Worker for a Phase 2 integration test. Use the taskId and attemptId from the current delivery. Execute ONLY the harmless studio_probe tool with text "live-dsh-probe". Then call studio_report with taskId, attemptId and a short text describing the actual probe result. Omit the optional evidence field for this probe. Do not delegate, use external tools, or claim file changes. Keep your response short.'});
  const run = await studio.createRun({mode: 'direct', prompt: 'Run one harmless Worker capability probe and report the actual result.'});
  const deadline = Date.now() + 90_000;
  let outcome;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const state = await studio.snapshot();
    latest = state;
    const current = state.runs.find(r => r.id === run.id);
    const worker = current.agents.find(a => a.role === 'worker');
    const events = state.activity.filter(e => e.runId === run.id);
    const status = JSON.stringify({status: current.status, agents: current.agents.map(a => ({role:a.role,status:a.status})), events: events.map(e => e.kind)});
    if (status !== lastStatus) { console.log(status); lastStatus = status; }
    const error = current.tasks.find(t => ['failed','blocked'].includes(t.status));
    if (error) throw new Error(error.error ?? 'Live task failed');
    if (worker && current.tasks.every(t => t.status === 'completed') && current.deliveries.every(d => d.state === 'done') && current.messages.some(m => m.role === 'assistant') && events.some(e => e.kind === 'probe' && e.agentId === worker.id) && events.some(e => e.kind === 'report' && e.agentId === worker.id)) {
      outcome = {verifiedAt: new Date().toISOString(), transport: 'real DSH runtime and provider adapter', provider, model,
        coordinators: 'offline scripted demo', worker: 'live model',
        tools: events.filter(e => e.agentId === worker.id && ['probe', 'report'].includes(e.kind)).reverse().map(e => e.kind),
        requests: events.filter(e => e.agentId === worker.id && e.kind === 'model-request').reverse().map(e => e.text),
        tasks: current.tasks.map(t => ({id:t.id,status:t.status,latestAttemptId:t.latestAttemptId})), attempts: current.attempts.map(a => ({id:a.id,status:a.status,number:a.number})), deliveries: current.deliveries.map(d => ({kind:d.kind,state:d.state})), result: worker.lastResult, externalSideEffects: 'none'};
      break;
    }
    await delay(200);
  }
  if (!outcome) {
    throw new Error('Live Worker did not complete both probe and report within 90 seconds');
  }
  console.log(JSON.stringify(outcome, null, 2));
  if (process.env.STUDIO_EVIDENCE_PATH) await writeFile(process.env.STUDIO_EVIDENCE_PATH, JSON.stringify(outcome, null, 2) + '\n');
} catch (error) {
  const diagnostic = {verifiedAt: new Date().toISOString(), passed: false, provider, model, error: String(error), runs: latest?.runs, activity: latest?.activity};
  if (process.env.STUDIO_EVIDENCE_PATH) await writeFile(process.env.STUDIO_EVIDENCE_PATH, JSON.stringify(diagnostic, null, 2) + '\n');
  throw error;
} finally { await studio?.close(); await rm(dataDir, {recursive: true, force: true}); }
