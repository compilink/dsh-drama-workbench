import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../dist/src/server.js';

const {chromium}=await import(process.env.STUDIO_PLAYWRIGHT_MODULE || 'playwright');
const dataDir=await mkdtemp(join(tmpdir(),'drama-canvas-browser-'));
const server=await startServer({drama:true,port:0,dataDir});
let browser;
try {
  const {csrfToken}=await fetch(server.url+'/api/bootstrap').then(r=>r.json());
  async function api(route,method='GET',body) {
    const r=await fetch(server.url+'/api/drama'+route,{method,headers:{'x-studio-csrf':csrfToken,'content-type':'application/json'},body:JSON.stringify(body)});
    const x=await r.json(); assert.ok(r.ok,JSON.stringify(x));return x;
  }
  const project=await api('/projects','POST',{name:'右键编辑验收'});
  const path='/projects/'+project.id;
  const draftPath='/canvas-drafts/project/'+project.id;

  browser=await chromium.launch({headless:true,...(process.env.STUDIO_CHROME_BIN?{executablePath:process.env.STUDIO_CHROME_BIN}:{})});
  const page=await browser.newPage({viewport:{width:1400,height:950}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',d=>d.accept());
  await page.goto(server.url+'/drama?project='+project.id);
  const canvas=page.locator('.graph-canvas');
  async function add(x,y) {
    const put=page.waitForResponse(r=>r.url().endsWith(draftPath) && r.request().method()==='PUT' && r.ok());
    await canvas.click({button:'right',position:{x,y}});
    await put;
  }
  async function setup(title,name,instruction) {
    await page.getByRole('button',{name:title,exact:true}).click({button:'right'});
    await page.getByRole('menuitem',{name:'节点设置'}).click();
    const form=page.getByRole('dialog');
    await form.getByLabel('节点名称').fill(name);
    await form.getByLabel('节点 Agent').selectOption(agent.id);
    if (instruction) await form.getByLabel('默认执行指令').fill(instruction);
    await form.getByRole('button',{name:'保存到草案'}).click();
    await page.getByText('草稿已自动保存',{exact:true}).waitFor();
  }
  await add(70,54);
  const first=(await api(draftPath)).draft;
  assert.deepEqual([first.nodes[0].x,first.nodes[0].y],[70,54]);
  assert.equal(first.nodes[0].agentId,'');
  assert.equal((await api(path)).graph.nodes.length,0);
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByText(/请先为节点/).first().waitFor();
  assert.equal((await api(path)).graph.nodes.length,0);
  const agent=await api('/agents','POST',{name:'编剧',role:'worker',selection:{provider:'studio-demo',model:'executor'}});
  await page.reload();
  await setup('新节点 1','大纲');
  await add(430,175);
  await setup('新节点 1','正文');
  await page.getByRole('button',{name:'从节点连出 大纲'}).dragTo(page.getByRole('button',{name:'连接到 正文'}));
  await page.getByText('连接 大纲 → 正文',{exact:true}).waitFor();
  const grip=page.getByRole('button',{name:'移动节点 正文'});
  await grip.focus();
  await grip.press('ArrowRight');
  await page.getByText('草稿已自动保存',{exact:true}).waitFor();
  const draft=(await api(draftPath)).draft;
  assert.equal(draft.nodes[1].x,440);
  assert.equal(draft.edges.length,1);
  const handle=await grip.boundingBox();
  await page.mouse.move(handle.x+5,handle.y+5);
  await page.mouse.down();
  await page.mouse.move(handle.x+55,handle.y+25,{steps:4});
  await page.mouse.up();
  await page.getByText('草稿已自动保存',{exact:true}).waitFor();
  assert.equal((await api(draftPath)).draft.nodes[1].x,490);
  await page.getByRole('button',{name:'资料设定'}).click();
  await page.getByRole('button',{name:'工作流',exact:true}).click();
  await page.getByText('连接 大纲 → 正文',{exact:true}).waitFor();
  await page.reload();
  await page.getByText('连接 大纲 → 正文',{exact:true}).waitFor();
  assert.equal((await api(path)).graph.nodes.length,0);
  assert.equal(await page.getByRole('button',{name:'执行',exact:true}).count(),0);
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByText('画布已保存。',{exact:true}).waitFor();
  assert.equal((await api(path)).graph.edges.length,1);
  assert.equal((await api(draftPath)).draft,null);
  const expanded='保留人物动机。'.repeat(24)+'全文结尾';
  await setup('大纲','大纲',expanded);
  await page.locator('.draft-changes details summary').click();
  assert.equal(await page.locator('.draft-changes details pre').last().textContent(),expanded);
  await page.getByRole('button',{name:'放弃草稿'}).click();
  await page.locator('.draft-changes').waitFor({state:'detached'});
  await page.getByRole('button',{name:'大纲',exact:true}).click({button:'right'});
  await page.getByRole('menuitem',{name:'删除节点'}).click();
  await page.getByText('删除节点「大纲」',{exact:true}).waitFor();
  await page.getByText('断开 大纲 → 正文',{exact:true}).waitFor();
  assert.equal((await api(path)).graph.nodes.length,2);
  await page.getByRole('button',{name:'查看生效画布'}).click();
  await page.getByRole('button',{name:'大纲',exact:true}).click();
  await page.getByRole('button',{name:'执行',exact:true}).waitFor();
  assert.equal(await page.locator('[data-node-card]').count(),2);
  await page.getByRole('button',{name:'返回草稿'}).click();
  await page.getByText('删除节点「大纲」',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-node-card]').count(),1);
  await page.getByRole('button',{name:'放弃草稿'}).click();
  await page.locator('.draft-changes').waitFor({state:'detached'});
  await page.getByText('已放弃草稿。',{exact:true}).waitFor();
  assert.equal((await api(draftPath)).draft,null);
  assert.equal(await page.locator('[data-node-card]').count(),2);

  const other=await browser.newPage();
  await other.goto(server.url+'/drama?project='+project.id);
  await other.locator('.graph-canvas').waitFor();
  await add(720,80);
  await other.locator('.graph-canvas').click({button:'right',position:{x:720,y:280}});
  await other.getByRole('button',{name:'载入已保存草稿'}).waitFor();
  assert.equal((await api(draftPath)).draft.nodes.at(-1).x,720);
  other.on('dialog',d=>d.accept());
  await other.getByRole('button',{name:'载入已保存草稿'}).click();
  await other.getByText('草稿已自动保存',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('Canvas browser verified right-click placement and menus, wiring and movement, durable drafts, explicit publication, safe deletion, discard and multi-tab conflicts.');
} finally {
  await browser?.close();
  await server.close();
  await rm(dataDir,{recursive:true,force:true});
}
