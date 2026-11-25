import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../dist/src/server.js';

const {chromium} = await import(process.env.STUDIO_PLAYWRIGHT_MODULE || 'playwright');
const dataDir = await mkdtemp(join(tmpdir(), 'drama-template-history-'));
let app, browser;
try {
  app = await startServer({drama:true, port:0, dataDir, execution:{enabled:false}, demoModels:true});
  browser = await chromium.launch({headless:true, ...(process.env.STUDIO_CHROME_BIN ? {executablePath:process.env.STUDIO_CHROME_BIN} : {})});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const {csrfToken} = await (await page.request.get(app.url + '/api/bootstrap')).json();
  async function api(path, data) {
    const response = await page.request.fetch(app.url + '/api/drama' + path, {
      method:data ? 'POST' : 'GET', ...(data ? {data, headers:{'X-Studio-CSRF':csrfToken}} : {}),
    });
    assert.ok(response.ok(), await response.text());
    return response.json();
  }
  const writer = await api('/agents', {name:'编剧', role:'worker', selection:{provider:'studio-demo', model:'executor'}});
  const node = (id, title) => ({id, title, agentId:writer.id, x:50, y:50});
  const first = await api('/templates', {name:'剧本策划', description:'初版说明', nodes:[node('research','题材调研')], edges:[]});
  const project = await api('/projects', {name:'沿用旧版的作品', templateId:first.id});
  const second = await api('/templates', {...first, expectedVersion:1, name:'含精修的流程', description:'第二版说明',
    nodes:[...first.nodes, node('polish','精修')], edges:[{from:'research', to:'polish'}]});
  const button = name => page.getByRole('button',{name,exact:true});
  const dialog = page.getByRole('dialog');
  await page.goto(app.url + '/drama');
  await button('模板库').click();
  await button('版本历史 · v2').click();
  const oldRow = dialog.getByRole('listitem').filter({has:page.getByRole('heading',{name:'v1 · 剧本策划',exact:true})});
  assert.match(await oldRow.innerText(), /初版说明/);
  assert.match(await oldRow.innerText(), /1 个节点 · 0 条连线/);
  assert.match(await dialog.getByRole('listitem').first().innerText(), /当前版本/);
  await oldRow.getByRole('button',{name:'从此版编辑'}).click();
  await page.locator('[data-node-card="research"]').waitFor();
  assert.equal(await page.locator('[data-node-card="polish"]').count(),0);
  await button('名称与说明').click();
  assert.equal(await dialog.getByLabel('名称',{exact:true}).inputValue(),'剧本策划');
  assert.equal(await dialog.getByLabel('说明（可选）').inputValue(),'初版说明');
  await dialog.getByLabel('名称',{exact:true}).fill('调研短流程');
  await dialog.getByLabel('说明（可选）').fill('从初版调整');
  await dialog.locator('[type="submit"]').click();
  await page.locator('[data-action="save-graph"]').click();
  await button('版本历史 · v3').waitFor();
  const current = await api('/templates/' + first.id);
  assert.equal(current.name,'调研短流程');
  assert.equal(current.description,'从初版调整');
  assert.deepEqual(current.nodes,first.nodes);
  assert.deepEqual(current.edges,first.edges);
  assert.deepEqual(await api('/templates/'+first.id+'?version=2'),second);
  assert.deepEqual(await api('/templates/'+first.id+'?version=1'),first);
  const snapshot = await api('/projects/'+project.id);
  assert.equal(snapshot.project.templateVersion,1);
  assert.deepEqual(snapshot.graph.nodes,first.nodes);
  assert.deepEqual(snapshot.graph.edges,first.edges);
  await button('编辑').click();
  await button('名称与说明').click();
  await dialog.getByLabel('名称',{exact:true}).fill('尚未发布的模板');
  await dialog.locator('[type="submit"]').click();
  await button('模板库').click();
  await button('版本历史 · v3').waitFor();
  const draftPath = '/canvas-drafts/template/' + first.id;
  const saved = (await api(draftPath)).draft;
  assert.equal(saved.name,'尚未发布的模板');
  async function selectSecond(accept) {
    await button('版本历史 · v3').click();
    const row = dialog.getByRole('listitem').filter({has:page.getByRole('heading',{name:'v2 · 含精修的流程',exact:true})});
    const confirmation = page.waitForEvent('dialog').then(async message => {
      assert.match(message.message(),/草稿/);
      if (accept) await message.accept();
      else await message.dismiss();
    });
    await Promise.all([confirmation, row.getByRole('button',{name:'从此版编辑'}).click()]);
  }
  await selectSecond(false);
  assert.equal((await api(draftPath)).draft.revision,saved.revision);
  await selectSecond(true);
  await page.locator('[data-node-card="polish"]').waitFor();
  await button('模板库').click();
  await button('版本历史 · v3').waitFor();
  const replaced = (await api(draftPath)).draft;
  assert.equal(replaced.sourceVersion,2);
  assert.equal(replaced.baseVersion,3);
  assert.equal(replaced.name,second.name);
  assert.deepEqual(replaced.edges,second.edges);
  assert.equal((await api('/templates/'+first.id)).version,3);
  await button('编辑').click();
  await button('名称与说明').click();
  await dialog.getByLabel('名称',{exact:true}).fill('沿第二版修改的草稿');
  await dialog.locator('[type="submit"]').click();
  await button('模板库').click();
  await button('版本历史 · v3').waitFor();
  await selectSecond(false);
  assert.equal((await api(draftPath)).draft.name,'沿第二版修改的草稿');
  await selectSecond(true);
  await page.locator('[data-node-card="polish"]').waitFor();
  await button('模板库').click();
  await button('版本历史 · v3').waitFor();
  assert.equal((await api(draftPath)).draft.name,second.name);
  await button('新增模板').click();
  await dialog.getByLabel('名称',{exact:true}).fill('只保存了草稿的模板');
  await dialog.getByRole('button',{name:'打开模板画布'}).click();
  await page.getByRole('heading',{name:'只保存了草稿的模板',exact:true}).waitFor();
  await button('模板库').click();
  await button('版本历史 · v3').waitFor();
  assert.equal((await api('/templates')).length,1);
  await button('新增模板').click();
  await page.getByRole('heading',{name:'只保存了草稿的模板',exact:true}).waitFor();
  assert.equal(await dialog.count(),0);
  assert.deepEqual(errors,[]);
  console.log('Chrome verified template history, new versions from old canvases, unchanged published works, and explicit replacement or retention of an existing draft.');
} finally {
  await browser?.close();
  await app?.close();
  await rm(dataDir,{recursive:true,force:true});
}
