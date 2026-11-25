import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const folder = await mkdtemp(join(tmpdir(), 'drama-docker-test-'));
const dataDir = join(folder, 'demo-data');
const catalogData = join(folder, 'configured-data');
const dshHome = join(folder, 'model-source');
const profile = join(dshHome, 'profiles', 'web');
const patch = join(profile, 'cordis.patch.yml');
const project = 'drama-test-' + randomUUID();
const env = { ...process.env, DRAMA_DATA_DIR: catalogData, DRAMA_PORT: '0', DRAMA_DSH_HOME: dshHome, DRAMA_DEMO: '0',
  DRAMA_UID: String(process.getuid()), DRAMA_GID: String(process.getgid()) };
const compose = (...args) => execFileSync('docker', ['compose', '--project-name', project, ...args],
  { cwd: root, env, encoding: 'utf8', timeout: 120_000 }).trim();
let origin;
let token;

async function connect() {
  const binding = compose('port', 'workbench', '4318');
  assert.match(binding, /^127\.0\.0\.1:\d+$/);
  origin = 'http://' + binding;
  const response = await fetch(origin + '/api/bootstrap');
  assert.equal(response.status, 200);
  token = (await response.json()).csrfToken;
}

function request(route, method = 'GET', data) {
  return fetch(origin + '/api/drama' + route, { method, headers: {
    'Content-Type': 'application/json', 'X-Studio-CSRF': token, Origin: origin
  }, ...(data === undefined ? {} : {body: JSON.stringify(data)}) });
}

async function api(route, method, data) {
  const response = await request(route, method, data);
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
}

function modelConfig(id) {
  return JSON.stringify([{id: 'llm-pi-ai', config: {providers: {'studio-fixture': {
    api: 'openai-completions', baseURL: 'http://127.0.0.1:1/v1',
    models: [{id, name: id, contextWindow: 32768, maxTokens: 2048}]
  }}}}]);
}

async function replacePatch(contents) {
  const replacement = patch + '.new';
  await writeFile(replacement, contents, {mode: 0o600});
  await rename(replacement, patch);
}

async function replaceVisiblePatch(contents) {
  await replacePatch(contents);
  // macOS file sharing delivers host updates separately from the HTTP refresh request.
  compose('exec', '-T', 'workbench', 'node', '--input-type=module', '-e', `
    import {get} from 'node:http';
    import {setTimeout as delay} from 'node:timers/promises';
    const deadline = Date.now() + 5000;
    do {
      const response = await new Promise((resolve, reject) => get({
        socketPath: '/run/drama-models/reader.sock', path: '/profiles/web/cordis.patch.yml'
      }, resolve).on('error', reject));
      const bytes = [];
      for await (const chunk of response) bytes.push(chunk);
      if (response.statusCode === 200 && Buffer.concat(bytes).toString() === process.argv[1]) process.exit(0);
      await delay(25);
    } while (Date.now() < deadline);
    throw new Error('The configuration reader did not observe the host fixture replacement');
  `, contents);
}

async function checkCatalog(expected) {
  const models = await api('/models');
  assert.deepEqual(models.map(model => [model.provider, model.model, model.demo]), [['studio-fixture', expected, false]]);
}

try {
  await mkdir(catalogData, {mode: 0o700});
  await mkdir(profile, {recursive: true, mode: 0o700});
  await writeFile(join(dshHome, '.credentials.yaml'), '{}\n', {mode: 0o600});
  await writeFile(patch, modelConfig('fixture-before'), {mode: 0o600});
  compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '90');
  await connect();
  const catalogContainer = compose('ps', '-q', 'workbench');
  const catalogToken = token;
  await checkCatalog('fixture-before');

  await replaceVisiblePatch(modelConfig('fixture-after'));
  await api('/models/refresh', 'POST', {});
  await checkCatalog('fixture-after');
  await replaceVisiblePatch('broken: [');
  const failedRefresh = await request('/models/refresh', 'POST', {});
  assert.ok(failedRefresh.status >= 400, 'An invalid source must fail the refresh');
  await failedRefresh.text();
  await checkCatalog('fixture-after');
  await replaceVisiblePatch(modelConfig('fixture-recovered'));
  await api('/models/refresh', 'POST', {});
  await checkCatalog('fixture-recovered');
  // Rapidly changing file sizes previously returned a valid file's prefix at the prior file's length.
  for (let round = 0; round < 5; round++) {
    await replacePatch('broken: [');
    const rejected = await request('/models/refresh', 'POST', {});
    assert.ok(rejected.status >= 400, 'Expected an error for incomplete YAML');
    await rejected.text();
    const next = 'immediate-' + round;
    await replacePatch(modelConfig(next));
    await api('/models/refresh', 'POST', {});
    await checkCatalog(next);
  }
  assert.equal(compose('ps', '-q', 'workbench'), catalogContainer);
  await connect();
  assert.equal(token, catalogToken, 'The Workbench process restarted during refresh');
  console.log('Docker catalog passed: atomic replacement, removed models, last good catalog after invalid YAML and refresh without restarting.');

  compose('down', '--volumes', '--timeout', '15');
  await mkdir(dataDir, {mode: 0o700});
  env.DRAMA_DATA_DIR = dataDir;
  env.DRAMA_DEMO = '1';
  compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '90');
  await connect();
  assert.ok((await api('/models')).some(model => model.demo && model.provider === 'studio-demo' && model.model === 'executor'));
  const first = compose('ps', '-q', 'workbench');
  const work = await api('/projects', 'POST', {name: '容器持久化验收'});
  const route = '/projects/' + work.id;
  const bytes = Buffer.from('城南车站，夜。');
  const document = await api(route + '/documents', 'POST', {name: '开场', content: bytes.toString(),
    source: {name: '开场.txt', base64: bytes.toString('base64')}});
  const agent = await api('/agents', 'POST', {name: '验收编剧', role: 'worker', selection: {provider: 'studio-demo', model: 'executor'}});
  const node = {id: 'draft', title: '编写开场', agentId: agent.id, instruction: '编写开场', release: 'manual', x: 0, y: 0};
  await api(route + '/graph', 'PUT', {expectedVersion: work.graphVersion, nodes: [node], edges: []});
  await api(route + '/runs', 'POST', {nodeIds: [node.id], requestId: 'first-draft'});
  let review;
  for (let i = 0; i < 60; i++) {
    const [run] = await api(route + '/runs');
    if (run.nodes[0].status === 'review') { review = run.nodes[0]; break; }
    await delay(250);
  }
  assert.ok(review?.artifact?.id, 'Expected a draft awaiting manual review');
  assert.deepEqual(await readFile(join(dataDir, 'drama-blobs', work.id, document.source.sha256)), bytes);
  assert.ok((await readdir(join(dataDir, 'sessions'))).length > 0);
  assert.ok((await readdir(dataDir)).includes('studio.sqlite'));

  compose('run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', 'workbench', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { StudioStore } from './dist/src/store.js';
    assert.throws(() => new StudioStore('/data'), /already owned/);
  `);
  compose('kill', '-s', 'SIGKILL', 'workbench');
  compose('up', '-d', '--force-recreate', '--no-build', '--wait', '--wait-timeout', '90');
  await connect();
  assert.notEqual(compose('ps', '-q', 'workbench'), first);
  const [restored] = await api(route + '/runs');
  assert.equal(restored.nodes[0].status, 'review');
  assert.equal(restored.nodes[0].artifact.id, review.artifact.id);
  const original = await fetch(origin + '/api/drama' + route + '/documents/' + document.id + '/source');
  assert.equal(original.status, 200);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
  await api(route + '/node-runs/' + review.id + '/review', 'POST', {
    decision: 'approve', artifactId: review.artifact.id, requestId: 'approve-recovered-draft'
  });
  const word = await fetch(origin + '/api/drama' + route + '/artifacts/' + review.artifact.id + '/export?format=docx');
  assert.equal(word.status, 200);
  assert.equal(Buffer.from(await word.arrayBuffer()).readUInt32LE(), 0x04034b50);
  console.log('Docker persistence passed: host SQLite, original upload, session files, review and Word export after forced replacement.');
} finally {
  compose('down', '--volumes', '--timeout', '15');
  await rm(folder, {recursive: true, force: true});
}
