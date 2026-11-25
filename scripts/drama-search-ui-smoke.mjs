/** Check that search source selections persist across a new browser page in an isolated workbench. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../dist/src/server.js';
const {chromium}=await import(process.env.STUDIO_PLAYWRIGHT_MODULE || 'playwright');
const dir=await mkdtemp(join(tmpdir(),'drama-search-ui-'));
const app=await startServer({dataDir:dir,drama:true,port:0,demoModels:true});
let browser;
try {
  browser=await chromium.launch({headless:true,...(process.env.STUDIO_CHROME_BIN?{executablePath:process.env.STUDIO_CHROME_BIN}:{})});
  const page=await browser.newPage();
  const errors=[];
  page.on('pageerror',err=>errors.push(err.message));
  await page.goto(app.url+'/drama');
  async function settings() {
    await page.getByRole('button',{name:'连接',exact:true}).click();
    const form=page.locator('form').filter({has:page.getByRole('heading',{name:'公开网络搜索来源'})});
    await form.getByRole('checkbox',{name:'维基百科',exact:true}).waitFor();
    return form;
  }
  const form=await settings();
  for(const id of ['google','bing','baidu']) await form.locator('input[value="'+id+'"]').check();
  await form.getByRole('textbox').fill('https://search.example.org/search');
  await form.getByRole('button',{name:'保存搜索设置'}).click();
  await form.getByText('已保存，后续搜索采用此配置。').waitFor();
  await page.reload();
  const next=await settings();
  for(const id of ['google','bing','baidu']) assert.equal(await next.locator('input[value="'+id+'"]').isChecked(),true);
  assert.equal(await next.getByRole('textbox').inputValue(),'https://search.example.org/search');
  assert.deepEqual(errors,[]);
  console.log('Search source selections saved and persisted after reload.');
} finally {await browser?.close();await app.close();await rm(dir,{recursive:true,force:true});}
