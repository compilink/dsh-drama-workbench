import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../dist/src/server.js';

const {chromium} = await import(process.env.STUDIO_PLAYWRIGHT_MODULE || 'playwright');
const root = await mkdtemp(join(tmpdir(), 'drama-model-ui-'));
const home = join(root, 'model-source');
const profile = join(home, 'profiles', 'web');
await mkdir(profile, {recursive:true});
const path = join(profile, 'cordis.patch.yml');
const replaceModel = async id => {
  const source = [{id:'llm-pi-ai', config:{providers:{fixture:{
    api:'openai-completions', baseURL:'http://127.0.0.1:1/v1', models:[{id,contextWindow:32768,maxTokens:2048}]
  }}}}];
  await writeFile(path + '.next', JSON.stringify(source));
  await rename(path + '.next', path);
};
let browser, app;
try {
  await replaceModel('old-model');
  app = await startServer({dataDir:join(root,'data'),dshHome:home,drama:true,port:0});
  browser = await chromium.launch({headless:true,...(process.env.STUDIO_CHROME_BIN ? {executablePath:process.env.STUDIO_CHROME_BIN} : {})});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e=>errors.push(e.message));
  let refreshes = 0;
  page.on('request', request=>{if (request.url().endsWith('/api/drama/models/refresh')) refreshes++;});
  await page.goto(app.url+'/drama');
  await page.getByRole('button',{name:'Agent',exact:true}).click();
  await page.getByRole('button',{name:'新建 Agent'}).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('名称').fill('编剧');
  await form.locator('[name=model]').selectOption({label:'old-model · fixture'});
  await form.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByRole('heading',{name:'编剧'}).waitFor();
  assert.equal(refreshes,0);
  await replaceModel('enter-model');
  await page.getByRole('button',{name:'连接',exact:true}).click();
  const latest = id=>page.getByText(id+' · fixture',{exact:true}).waitFor();
  await latest('enter-model');
  assert.equal(refreshes,1);
  await replaceModel('reload-model');
  await page.reload();
  await latest('reload-model');
  assert.equal(refreshes,2);
  await replaceModel('button-model');
  await page.getByRole('button',{name:'刷新模型目录'}).click();
  await latest('button-model');
  assert.equal(refreshes,3);
  await writeFile(path, 'not: [valid');
  await page.getByRole('button',{name:'刷新模型目录'}).click();
  await page.getByRole('alert').filter({hasText:'保留上次列表'}).waitFor();
  await latest('button-model');
  await page.getByRole('button',{name:'Agent',exact:true}).click();
  await page.getByRole('button',{name:'编辑',exact:true}).click();
  assert.equal(await form.locator('[name=model]').inputValue(),'');
  assert.match(await form.locator('[name=model] option:checked').innerText(),/old-model/);
  assert.equal(await form.locator('form').evaluate(el=>el.checkValidity()),false);
  assert.deepEqual(errors,[]);
  console.log('Catalog UI passed: enter, reload, manual refresh, last good selection and removed model.');
} finally {
  await browser?.close();
  await app?.close();
  await rm(root,{recursive:true,force:true});
}
