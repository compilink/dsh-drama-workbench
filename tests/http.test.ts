import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {get} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../src/server.js';

test('only the root conversation endpoint accepts messages and writes require a same-origin CSRF token', {timeout: 20_000}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-http-'));
  const app = await startServer({dataDir, port: 0, demoDelayMs: 200});
  try {
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    assert.equal(address.address, '127.0.0.1');
    const homepage = await fetch(app.url);
    assert.equal(homepage.status, 200);
    assert.match(homepage.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    const {csrfToken} = await (await fetch(`${app.url}/api/bootstrap`)).json() as {csrfToken: string};
    const payload = JSON.stringify({prompt: '无副作用探针', mode: 'direct'});
    const noToken = await fetch(`${app.url}/api/runs`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: payload});
    assert.equal(noToken.status, 403);
    const headers = {'Content-Type': 'application/json', 'X-Studio-CSRF': csrfToken};
    const crossOrigin = await fetch(`${app.url}/api/runs`, {method: 'POST', headers: {...headers, Origin: 'https://untrusted.example'}, body: payload});
    assert.equal(crossOrigin.status, 403);
    const invalidMode = await fetch(`${app.url}/api/runs`, {method: 'POST', headers, body: JSON.stringify({prompt: 'test', mode: 'invalid'})});
    assert.equal(invalidMode.status, 400);
    const oversizedTask = await fetch(`${app.url}/api/runs`, {method: 'POST', headers, body: JSON.stringify({prompt: 'x'.repeat(8001), mode: 'direct'})});
    assert.equal(oversizedTask.status, 400);
    const created = await fetch(`${app.url}/api/runs`, {method: 'POST', headers, body: payload});
    assert.equal(created.status, 201);
    const run = await created.json() as {id: string};
    const missingId = await fetch(`${app.url}/api/runs/${run.id}/tasks`, {method: 'POST', headers, body: JSON.stringify({prompt:'extra'})});
    assert.equal(missingId.status,400);
    const taskBody = JSON.stringify({prompt:'additional independent task',requestId:'http-additional'});
    const taskResponse = await fetch(`${app.url}/api/runs/${run.id}/tasks`, {method:'POST',headers,body:taskBody});
    assert.equal(taskResponse.status,202);
    const task = await taskResponse.json() as {id:string};
    const duplicate = await fetch(`${app.url}/api/runs/${run.id}/tasks`, {method:'POST',headers,body:taskBody});
    assert.equal((await duplicate.json() as {id:string}).id,task.id);
    const badTarget = await fetch(`${app.url}/api/runs/${run.id}/tasks`, {method:'POST',headers,body:JSON.stringify({prompt:'bad target',requestId:'bad-target',targetManagerId:'outside-run'})});
    assert.equal(badTarget.status,400);
    const cancelTask = await fetch(`${app.url}/api/runs/${run.id}/tasks/${task.id}/cancel`, {method:'POST',headers});
    assert.equal(cancelTask.status,202);
    const current = await (await fetch(`${app.url}/api/state`)).json() as {runs:{tasks:{id:string;status:string}[]}[]};
    assert.equal(current.runs[0]!.tasks.find(t=>t.id===task.id)!.status,'cancelled');
    assert.notEqual(current.runs[0]!.tasks.find(t=>t.id!==task.id)!.status,'cancelled');
    const directChild = await fetch(`${app.url}/api/agents/worker/messages`, {method: 'POST', headers, body: JSON.stringify({text: 'bypass orchestrator'})});
    assert.equal(directChild.status, 404);
    const stop = await fetch(`${app.url}/api/runs/${run.id}/stop`, {method: 'POST', headers});
    assert.equal(stop.status, 202);
    const unknown = await fetch(`${app.url}/api/runs/missing/messages`, {method: 'POST', headers, body: JSON.stringify({text: 'hello'})});
    assert.equal(unknown.status, 404);
    const traversal = await fetch(`${app.url}/package.json`);
    assert.equal(traversal.status, 404);
    const state = await (await fetch(`${app.url}/api/state`)).json() as {runs: unknown[]};
    assert.equal(state.runs.length, 1, 'rejected writes do not create extra runs');
  } finally { await app.close(); await rm(dataDir, {recursive: true, force: true}); }
});

test('Docker Workbench accepts the loopback browser origin on its published port', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'drama-container-http-'));
  t.after(() => rm(dataDir, {recursive: true, force: true}));
  await assert.rejects(startServer({dataDir, containerListener: true}), /仅用于 --drama/);
  const app = await startServer({dataDir, drama: true, containerListener: true, port: 0});
  try {
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    assert.equal(address.address, '0.0.0.0');
    assert.equal((await fetch(app.url + '/api/health')).status, 200);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      get(app.url + '/api/bootstrap', {headers: {host: 'rebind.example', 'x-forwarded-host': 'localhost'}}, response => {
        response.resume();
        resolve(response.statusCode);
      }).once('error', reject);
    });
    assert.equal(status, 403);
    const {csrfToken} = await (await fetch(app.url + '/api/bootstrap')).json() as {csrfToken: string};
    for (const [origin, token, expected] of [
      [app.url, '', 403], ['https://other.example', csrfToken, 403], [app.url, csrfToken, 201],
    ] as const) {
      const response = await fetch(app.url + '/api/drama/projects', {
        method: 'POST', headers: {'content-type': 'application/json', origin, 'x-studio-csrf': token},
        body: JSON.stringify({name: '容器访问测试'}),
      });
      assert.equal(response.status, expected);
    }
  } finally { await app.close(); }
});
