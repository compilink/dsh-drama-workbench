import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { CallId } from '@deepseek-ai/dsh-llm';
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import { mountStudio } from '../src/runtime.js';

/** Deliberately call hidden and unknown tools after an allow-all policy listener. */
test('role guards reject hidden/unknown execution and manager promotion despite an allow-all waterfall', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-role-policy-'));
  const ctx = new Context();
  const studio = await mountStudio(ctx, { dataDir });
  const attacks: { role: string; name: string; result: Promise<ToolExecutionResult> }[] = [];
  ctx.on('tools/pre-execute', async () => ({ kind: 'allow' as const }));
  ctx.on('agent/created', async ({ agent }) => {
    const snapshot = await studio.snapshot();
    const run = snapshot.runs.find(r => r.agents.some(a => a.sessionId === agent.id))!;
    const role = run.agents.find(a => a.sessionId === agent.id)!.role;
    const taskId = run.tasks[0]!.id;
    const attack = (name: string, args: object) => attacks.push({ role, name, result: ctx.tools.execute({ callId: CallId(`attack-${role}-${name}`), name, arguments: args, agent, signal: new AbortController().signal }) });
    attack('unregistered_external_tool', {});
    if (role !== 'worker') attack('studio_probe', { text: 'must not execute' });
    if (role === 'worker') attack('studio_delegate', { taskId, role: 'manager', prompt: 'must not create' });
    if (role === 'manager') attack('studio_delegate', { taskId, role: 'manager', prompt: 'must not create' });
  });
  try {
    const run = await studio.createRun({ prompt: 'Probe the hierarchy', mode: 'hierarchical' });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const snapshot = await studio.snapshot();
      if (snapshot.runs.find(r => r.id === run.id)!.tasks.every(t => t.status === 'completed')) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(attacks.length, 7);
    for (const attack of attacks) {
      const result = await attack.result;
      assert.equal(result.isError, true, `${attack.role} must not execute ${attack.name}`);
      const rendered = result.content.filter(block => block.type === 'text').map(block => block.text).join(' ');
      assert.match(rendered, attack.role === 'manager' && attack.name === 'studio_delegate' ? /Role cannot delegate/ : /Role policy denies/);
    }
    const snapshot = await studio.snapshot();
    assert.equal(snapshot.runs[0]!.agents.length, 3);
    assert.equal(snapshot.activity.filter(a => a.kind === 'probe').length, 1);
  } finally { await studio.close(); await rm(dataDir, { recursive: true, force: true }); }
});

import { DatabaseSync } from 'node:sqlite';
import { StudioStore } from '../src/store.js';

test('a data directory has one live runtime owner and can reopen after close', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-owner-'));
  const studio = await mountStudio(new Context(), { dataDir });
  try { await assert.rejects(mountStudio(new Context(), { dataDir }), /already owned/); }
  finally { await studio.close(); }
  const reopened = await mountStudio(new Context(), { dataDir });
  await reopened.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('separate processes cannot share a data directory and SIGKILL releases its SQLite lock', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-crashed-owner-'));
  const child = (script: string) => spawnSync(process.execPath, ['--input-type=module', '-e',
    `const {StudioStore} = await import(process.argv[1]); const store = new StudioStore(process.argv[2]); ${script}`,
    new URL('../src/store.js', import.meta.url).href, dataDir], {encoding: 'utf8', timeout: 5_000});
  const owner = new StudioStore(dataDir);
  try {
    const competing = child('store.close()');
    assert.equal(competing.status, 1);
    assert.match(competing.stderr, /already owned/);
    owner.close();
    const crashed = child("store.db.exec('CREATE TABLE committed_before_crash(id INTEGER)'); process.kill(process.pid, 'SIGKILL')");
    assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
    const recovered = new StudioStore(dataDir);
    try {
      assert.ok(recovered.db.prepare("SELECT name FROM sqlite_master WHERE name='committed_before_crash'").get());
      assert.equal(recovered.db.prepare('SELECT pid FROM runtime_owner').get()?.pid, 1);
      assert.throws(() => new StudioStore(dataDir), /already owned/);
    } finally { recovered.close(); }
  } finally { owner.close(); await rm(dataDir, {recursive: true, force: true}); }
});

test('an external lock directory fences other lock domains through a shared data mount and survives a crash', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-domain-data-'));
  const domainDir = await mkdtemp(join(tmpdir(), 'studio-domain-lock-'));
  const otherDomain = await mkdtemp(join(tmpdir(), 'studio-other-lock-'));
  const inDomain = (lockDir: string, script: string) => spawnSync(process.execPath, ['--input-type=module', '-e',
    `const {StudioStore} = await import(process.argv[1]); const store = new StudioStore(process.argv[2]); ${script}`,
    new URL('../src/store.js', import.meta.url).href, dataDir], {
    env: {...process.env, STUDIO_RUNTIME_LOCK_DIR: lockDir}, encoding: 'utf8', timeout: 5_000});
  try {
    const crashed = inDomain(domainDir, "store.db.exec('CREATE TABLE domain_check(value INTEGER)'); process.kill(process.pid, 'SIGKILL')");
    assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
    const refused = inDomain(otherDomain, 'store.close()');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /different runtime lock directory/);
    assert.throws(() => new StudioStore(dataDir), /different runtime lock directory/);
    const recovered = inDomain(domainDir, "store.db.prepare('SELECT * FROM domain_check').all(); store.close()");
    assert.equal(recovered.status, 0, recovered.stderr);
    const transferred = inDomain(otherDomain, 'store.close()');
    assert.equal(transferred.status, 0, transferred.stderr);
    new StudioStore(dataDir).close();
  } finally {
    await Promise.all([dataDir, domainDir, otherDomain].map(dir => rm(dir, {recursive: true, force: true})));
  }
});

test('a legacy owner outside the current PID namespace cannot be mistaken for an abandoned directory', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-legacy-owner-'));
  try {
    new StudioStore(dataDir).close();
    const db = new DatabaseSync(join(dataDir, 'studio.sqlite'));
    try {
      db.prepare('INSERT INTO runtime_owner VALUES(1,?,?)').run(2147483647, 'legacy-owner');
      assert.throws(() => new StudioStore(dataDir), /legacy runtime/);
      assert.equal(db.prepare('SELECT nonce FROM runtime_owner').get()?.nonce, 'legacy-owner');
      db.exec('DELETE FROM runtime_owner');
    } finally { db.close(); }
    new StudioStore(dataDir).close();
  } finally { await rm(dataDir, {recursive: true, force: true}); }
});

test('unknown database versions are rejected without rewriting their version', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-version-'));
  let db = new DatabaseSync(join(dataDir, 'studio.sqlite'));
  db.exec('PRAGMA user_version=999');
  db.close();
  assert.throws(() => new StudioStore(dataDir), /Unsupported studio database version 999/);
  db = new DatabaseSync(join(dataDir, 'studio.sqlite'));
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 999);
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});
