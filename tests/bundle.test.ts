/** Lifecycle and offline tarball acceptance for the external DSH bundle. */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import * as bundle from '../src/bundle.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

function observeAddress(ctx: Context): () => string {
  let url: string | undefined;
  ctx.logger.exporter({ export(message) {
    if (message.name === 'dsh-agent-studio') url = /http:\/\/127\.0\.0\.1:\d+/.exec(String(message.args[0]))?.[0];
  } });
  return () => { assert.ok(url, 'Bundle should announce its loopback listener'); return url; };
}

test('profile lifecycle starts a loopback Studio and releases its independent runtime', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-bundle-lifecycle-'));
  const host = new Context();
  const address = observeAddress(host);
  try {
    await host.plugin(bundle, { port: 0, dataDir });
    const url = address();
    assert.equal(host.get('agents'), undefined);
    assert.equal(host.get('llm'), undefined);
    const response = await fetch(`${url}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, phase: 3, backend: 'dsh' });
    const state = await (await fetch(`${url}/api/state`)).json() as { backend: string; models: unknown[] };
    assert.equal(state.backend, 'dsh');
    assert.ok(state.models.length > 0);
    await host.fiber.dispose();
    await assert.rejects(fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) }));
  } finally {
    await host.fiber.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('npm tarball boots through public exports with offline local DSH dependencies', { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'studio-bundle-pack-'));
  const packageRoot = join(temporary, 'package');
  try {
    const npmCommand = process.env.npm_execpath;
    const packArgs = ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary, '--cache', join(temporary, 'npm-cache')];
    const packed = npmCommand
      ? await exec(process.execPath, [npmCommand, ...packArgs], { cwd: root, timeout: 30_000 })
      : await exec('npm', packArgs, { cwd: root, timeout: 30_000 });
    const manifest = JSON.parse(packed.stdout) as { filename: string; files: { path: string }[] }[];
    assert.equal(manifest.length, 1);
    const files = manifest[0]!.files.map(file => file.path);
    for (const required of ['dist/src/bundle.js', 'dist/src/server.js', 'public/index.html', 'public/app.js', 'public/styles.css', 'cordis.patch.yml', 'compatibility.json']) assert.ok(files.includes(required), required);
    assert.ok(!files.some(file => file.startsWith('node_modules/') || file.includes('studio.sqlite')));
    await exec('tar', ['-xzf', join(temporary, manifest[0]!.filename), '-C', temporary], { timeout: 10_000 });
    const agentPath = await realpath(join(root, 'node_modules/@deepseek-ai/dsh-agent'));
    const dshRoot = process.env.DSH_ROOT ?? dirname(dirname(dirname(agentPath)));
    await exec(process.execPath, ['scripts/bootstrap.mjs', `--dsh-root=${dshRoot}`], { cwd: packageRoot, timeout: 30_000 });
    await mkdir(join(temporary, 'data'));
    const code = `
      import { strict as assert } from 'node:assert';
      import { Context } from '@deepseek-ai/cordis';
      import * as bundle from 'dsh-agent-studio';
      let url;
      const host = new Context();
      host.logger.exporter({export(message) { if(message.name === 'dsh-agent-studio') url = /http:\\/\\/127\\.0\\.0\\.1:\\d+/.exec(String(message.args[0]))?.[0]; }});
      try {
        await host.plugin(bundle, { port: 0, dataDir: process.env.STUDIO_TEST_DATA });
        assert.ok(url);
        for (const path of ['/api/health', '/', '/app.js', '/styles.css']) {
          const response = await fetch(url + path);
          assert.equal(response.status, 200, path);
          assert.ok((await response.text()).length > 0, path);
        }
        await host.fiber.dispose();
        await assert.rejects(fetch(url + '/api/health', {signal: AbortSignal.timeout(1000)}));
      } finally { await host.fiber.dispose(); }
      console.log('Packed bundle public exports, Web assets, and disposal verified.');
    `;
    const smoke = await exec(process.execPath, ['--input-type=module', '-e', code], { cwd: packageRoot, timeout: 20_000, env: { ...process.env, STUDIO_TEST_DATA: resolve(temporary, 'data') } });
    assert.match(smoke.stdout, /Packed bundle public exports/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
