import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import {credentialRef, credentialKey} from '@deepseek-ai/dsh-credentials';
import {mountConfiguredModels, ReadonlyDshCredentials} from '../src/model-source.js';

test('configured model catalog and reasoning are imported without loading unrelated profile plugins', async () => {
  const home = await mkdtemp(join(tmpdir(), 'studio-dsh-config-'));
  const ctx = new Context();
  try {
    await mkdir(join(home, 'profiles/web'), {recursive: true});
    const config = `- insert:\n    - id: unrelated\n      name: /this/plugin/must/not/be/imported.js\n      config:\n        action: !!js process.exit(99)\n- id: llm-pi-ai\n  config:\n    providers:\n      studio-fixture:\n        api: openai-completions\n        baseURL: http://127.0.0.1:1/v1\n        models:\n          - id: fixture-model\n            name: Configured fixture model\n            contextWindow: 32768\n            maxTokens: 2048\n            reasoningEfforts:\n              low: low\n              high: high\n`;
    const path = join(home, 'profiles/web/cordis.patch.yml');
    await writeFile(path, config);
    await ctx.plugin(LlmRuntime);
    await mountConfiguredModels(ctx, home);
    assert.deepEqual(ctx.llm.listProviders().map(p => p.id), ['studio-fixture']);
    const model = await ctx.llm.resolveModelInfo('studio-fixture', 'fixture-model');
    assert.deepEqual(model.reasoning?.efforts.map(e => e.id), ['low', 'high']);
    assert.equal(await readFile(path, 'utf8'), config);
  } finally { await ctx.fiber.dispose(); await rm(home, {recursive: true, force: true}); }
});

test('credential access cannot migrate files or invoke a refresh mutation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'studio-dsh-credentials-'));
  const ctx = new Context();
  try {
    const path = join(home, '.credentials.yaml');
    const original = 'version: 1\nrefs:\n  STUDIO_TEST_ONLY_KEY: fixture-not-a-secret\nrecords:\n  llm-pi-ai/fixture:\n    kind: grant\n    payload:\n      access: fixture-token\n';
    await writeFile(path, original, {mode: 0o600});
    await ctx.plugin(ReadonlyDshCredentials, {home});
    const ref = credentialRef('STUDIO_TEST_ONLY_KEY');
    assert.equal((await ctx.credentials.resolve(ref))?.value, 'fixture-not-a-secret');
    assert.equal((await ctx.credentials.describe(ref)).writable, false);
    const key = credentialKey('llm-pi-ai', 'fixture');
    assert.equal((await ctx.credentials.readRecord(key))?.kind, 'grant');
    let invoked = false;
    await assert.rejects(ctx.credentials.modifyRecord(key, async current => {invoked = true; return current;}), /cannot refresh/);
    await assert.rejects(ctx.credentials.set(ref, 'new'), /read-only/);
    assert.equal(invoked, false);
    assert.equal(await readFile(path, 'utf8'), original);
  } finally { await ctx.fiber.dispose(); await rm(home, {recursive: true, force: true}); }
});

test('executable model configuration is rejected without evaluating it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'studio-dsh-expression-'));
  const ctx = new Context();
  try {
    await writeFile(join(home, 'cordis.patch.yml'), '- id: llm-pi-ai\n  config: !!js process.exit(99)\n');
    await ctx.plugin(LlmRuntime);
    await assert.rejects(mountConfiguredModels(ctx, home), /Executable expressions/);
  } finally { await ctx.fiber.dispose(); await rm(home, {recursive: true, force: true}); }
});

test('disabled model plugins stay disabled even when settings contain providers; a later patch can enable them', async () => {
  const home = await mkdtemp(join(tmpdir(), 'studio-dsh-disabled-'));
  let ctx = new Context();
  try {
    await mkdir(join(home, 'profiles/web'), {recursive: true});
    await writeFile(join(home, 'profiles/web/cordis.patch.yml'), '- id: llm-pi-ai\n  disabled: true\n');
    await writeFile(join(home, 'settings.yaml'), 'llm-pi-ai:\n  providers:\n    disabled-fixture:\n      api: openai-completions\n      baseURL: http://127.0.0.1:1/v1\n      models:\n        - id: fixture\n          contextWindow: 32768\n          maxTokens: 2048\n');
    await ctx.plugin(LlmRuntime);
    await mountConfiguredModels(ctx, home);
    assert.deepEqual(ctx.llm.listProviders(), []);
    await ctx.fiber.dispose();
    ctx = new Context();
    await writeFile(join(home, 'cordis.patch.yml'), '- id: llm-pi-ai\n  disabled: false\n');
    await ctx.plugin(LlmRuntime);
    await mountConfiguredModels(ctx, home);
    assert.deepEqual(ctx.llm.listProviders().map(p => p.id), ['disabled-fixture']);
  } finally { await ctx.fiber.dispose(); await rm(home, {recursive: true, force: true}); }
});
