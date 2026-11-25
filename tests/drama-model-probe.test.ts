import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {Context} from '@deepseek-ai/cordis';
import {type StreamChunk} from '@deepseek-ai/dsh-llm';
import {modelProbeTimeout, probeConfiguredModel} from '../src/drama-model-probe.js';
import {mountStudio} from '../src/runtime.js';

const selection = {provider: 'probe-fixture', model: 'test'};
const signal = new AbortController().signal;

test('connection probes receive a model response without creating a DSH session or a workbench run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drama-probe-'));
  const ctx = new Context();
  const optionsSeen: {tools: boolean; messages: number; signal?: AbortSignal}[] = [];
  ctx.on('llm/stream', (options, next) => {
    if (options.provider !== selection.provider) return next();
    optionsSeen.push({tools: !!options.tools, messages: options.messages.length, signal: options.signal});
    return (async function* (): AsyncGenerator<StreamChunk> {
      yield {type: 'reasoning-delta', index: 0, text: ' '};
      yield {type: 'text-delta', index: 1, text: 'OK'};
      assert.fail('A successful probe should stop generating after the first non-empty response');
    })();
  });
  try {
    await writeFile(join(root, 'cordis.patch.yml'), JSON.stringify([{id: 'llm-pi-ai', config: {providers: {
      [selection.provider]: {api: 'openai-completions', baseURL: 'http://127.0.0.1:1/v1', models: [{id: selection.model, contextWindow: 32768, maxTokens: 2048}]}
    }}}]));
    const studio = await mountStudio(ctx, {drama: true, dataDir: join(root, 'work'), dshHome: root});
    try {
      assert.equal((await studio.drama!.probeModel(selection)).status, 'verified');
      assert.equal(optionsSeen.length, 1);
      assert.equal(optionsSeen[0]!.tools, false);
      assert.equal(optionsSeen[0]!.messages, 1);
      assert.equal(optionsSeen[0]!.signal?.aborted, true);
      assert.equal(ctx.sessions.list().length, 0);
      assert.equal(studio.drama!.store.runs().length, 0);
    } finally { await studio.close(); }
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('in-band and thrown provider failures are classified without echoing provider messages', async () => {
  for (const [code, text, expected] of [
    ['AUTH','Unauthorized','授权'], ['PI_AI_ERROR',"model 'missing' not found", '找不到所选模型'],
    ['ECONNREFUSED','connect failed','无法连接'], ['TIMEOUT','upstream timed out','超时'],
    ['RATE_LIMIT','rate limited','限流'], ['PI_AI_ERROR','some custom failure','运行日志'],
  ]) {
    const failure = {code: code!, message: text + ' simulated-sensitive-value'};
    for (const transport of ['finish','throw']) {
      const result = await probeConfiguredModel({stream: async function* () {
        if (transport === 'throw') throw Object.assign(new Error('wrapped'), {cause: failure});
        yield {type: 'finish', reason: {kind: 'error', failure}};
      }}, selection, signal);
      assert.equal(result.status, 'unavailable');
      assert.ok(result.message.includes(expected!));
      assert.doesNotMatch(result.message, /simulated-sensitive-value/);
    }
  }
  const empty = await probeConfiguredModel({stream: async function* () {
    yield {type: 'text-delta', text: ' ', index: 0};
    yield {type: 'finish', reason: {kind: 'stop'}};
  }}, selection, signal);
  assert.equal(empty.status, 'unavailable');
  assert.match(empty.message, /未返回/);
});

test('a slow cold load observes the configured deadline and cancellation is reported separately', async () => {
  assert.equal(modelProbeTimeout('180000'), 180_000);
  assert.equal(modelProbeTimeout('600000'), 600_000);
  assert.throws(() => modelProbeTimeout('200'), /STUDIO_MODEL_PROBE_TIMEOUT_MS/);
  const timedOut = await probeConfiguredModel({stream: async function* (options) {
    await delay(1000, undefined, {signal: options.signal});
    yield {type: 'text-delta', text: 'OK', index: 0};
  }}, selection, signal, 25);
  assert.equal(timedOut.status, 'unavailable');
  assert.match(timedOut.message, /超时/);
  const cancelled = await probeConfiguredModel({stream() { throw new Error('Unexpected request'); }}, selection, AbortSignal.abort());
  assert.match(cancelled.message, /已取消/);
});
