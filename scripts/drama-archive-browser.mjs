import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../dist/src/server.js';

const {chromium} = await import(process.env.STUDIO_PLAYWRIGHT_MODULE || 'playwright');
const dataDir = await mkdtemp(join(tmpdir(), 'drama-archive-browser-'));
let app, browser;
try {
  app = await startServer({drama: true, port: 0, dataDir, execution: {enabled: false}, demoModels: true});
  browser = await chromium.launch({headless: true, ...(process.env.STUDIO_CHROME_BIN ? {executablePath: process.env.STUDIO_CHROME_BIN} : {})});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const button = name => page.getByRole('button', {name, exact: true});
  const heading = name => page.getByRole('heading', {name, exact: true});
  const projectName = '待归档短剧';
  const card = page.getByRole('article').filter({has: heading(projectName)});
  const cardButton = name => card.getByRole('button', {name, exact: true});
  const {csrfToken} = await (await page.request.get(app.url + '/api/bootstrap')).json();
  async function post(path, data) {
    const response = await page.request.post(app.url + '/api/drama' + path, {headers: {'X-Studio-CSRF': csrfToken}, data});
    assert.ok(response.ok(), await response.text());
    return response.json();
  }

  await post('/projects', {name: '另一部短剧'});
  await page.goto(app.url + '/drama');
  await button('新建作品').click();
  const form = page.getByRole('dialog');
  await form.getByLabel('作品名').fill(projectName);
  await form.getByRole('button', {name: '创建'}).click();
  await heading('《' + projectName + '》').waitFor();
  const projectUrl = page.url();
  const projectId = new URL(projectUrl).searchParams.get('project');
  assert.ok(projectId);
  const path = '/projects/' + projectId;
  await button('资料设定').click();
  await page.locator('#doc-picker').setInputFiles({
    name: '场景设定.txt', mimeType: 'text/plain', buffer: Buffer.from('重逢发生在旧书店。')
  });
  await heading('场景设定').waitFor();
  await button('作品库').click();
  assert.equal(await cardButton('永久删除').count(), 0);
  await cardButton('归档').click();
  await card.waitFor({state: 'detached'});
  await heading('另一部短剧').waitFor();
  await button('创作台').click();
  await heading('作品库').waitFor();

  const bookmark = await browser.newPage();
  await bookmark.goto(projectUrl);
  await bookmark.getByRole('heading', {name: '作品库', exact: true}).waitFor();
  assert.equal(await bookmark.getByRole('button', {name: '编辑画布', exact: true}).count(), 0);
  await bookmark.close();

  await button('已归档').click();
  await cardButton('恢复').waitFor();
  assert.equal(await cardButton('打开').count(), 0);
  await page.reload();
  await cardButton('恢复').click();
  await page.getByText('暂无已归档作品。').waitFor();
  await button('创作中').click();
  await cardButton('打开').click();
  await button('资料设定').click();
  await heading('场景设定').waitFor();

  await button('作品库').click();
  await cardButton('归档').click();
  await card.waitFor({state: 'detached'});
  await button('已归档').click();
  await cardButton('永久删除').waitFor();
  page.once('dialog', dialog => dialog.dismiss());
  await cardButton('永久删除').click();
  await cardButton('恢复').waitFor();

  // A newly archived copy requires a fresh confirmation from the list.
  await post(path + '/restore', {});
  await post(path + '/archive', {});
  page.once('dialog', dialog => dialog.accept());
  const staleDelete = page.waitForResponse(response => response.request().method() === 'DELETE');
  const refreshedArchive = page.waitForResponse(response => response.url().includes('/projects?archived=1'));
  await cardButton('永久删除').click();
  assert.equal((await staleDelete).status(), 409);
  await refreshedArchive;
  await cardButton('恢复').waitFor();
  page.once('dialog', async dialog => {
    assert.ok(dialog.message().includes(projectName) && dialog.message().includes('无法撤销'));
    await dialog.accept();
  });
  await cardButton('永久删除').click();
  await page.getByText('暂无已归档作品。').waitFor();
  await page.reload();
  await page.getByText('暂无已归档作品。').waitFor();
  assert.equal((await page.request.get(app.url + '/api/drama' + path)).status(), 404);
  await button('创作中').click();
  await heading('另一部短剧').waitFor();
  assert.equal(await card.count(), 0);
  assert.deepEqual(errors, []);
  console.log('Chrome verified archive, bookmark isolation, list persistence, restored material, cancelled and stale confirmations, permanent deletion and unrelated project preservation.');
} finally {
  await browser?.close();
  await app?.close();
  await rm(dataDir, {recursive: true, force: true});
}
