/** Local Web entry point for the standalone DSH application. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { VIDEO_ROLE_CONTRACTS, VIDEO_TOOL_CONTRACTS } from './video-role-contracts.js';
import { createStudio } from './runtime.js';
import { DramaStore, DramaStoreError } from './drama-store.js';
import { DramaWorkflow } from './drama-workflow.js';
import { createDramaRoutes } from './drama-http.js';
import { DramaSearchSettings } from './drama-search-settings.js';
import { publicNetworkOperation } from './drama-network.js';
import type { AgentTemplate, ExecutionMode, Studio, StudioOptions } from './types.js';

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '请求必须是 JSON 对象');
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, `${name} 必须是 1–${max} 字符的文本`);
  return value;
}

async function body(req: IncomingMessage, limit = 131072): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new HttpError(415, '请使用 application/json');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new HttpError(413, '请求过大');
    chunks.push(buffer);
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'JSON 格式无效');
  }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(data));
}

function templateInput(id: string, value: Record<string, unknown>): Omit<AgentTemplate, 'version' | 'memoryIdentityId'> & {version?: number} {
  if (value.id !== id) throw new HttpError(400, '模板 ID 不一致');
  const role = value.role;
  if (role !== 'orchestrator' && role !== 'manager' && role !== 'worker') throw new HttpError(400, 'Agent 角色无效');
  const selection = object(value.selection);
  if (value.version !== undefined && (!Number.isSafeInteger(value.version) || Number(value.version) < 1)) throw new HttpError(400, '模板版本无效');
  return {
    id: text(id, '模板 ID', 100), name: text(value.name, '名称', 100), role,
    systemPrompt: text(value.systemPrompt, 'System prompt', 16000),
    selection: {provider: text(selection.provider, 'Provider', 200), model: text(selection.model, '模型', 300),
      ...(selection.reasoningEffort !== undefined && selection.reasoningEffort !== '' ? {reasoningEffort: text(selection.reasoningEffort, '推理等级', 100)} : {})},
    ...(value.version === undefined ? {} : {version: value.version as number}),
  };
}

/** The container listener requires a loopback-only published port on the host. */
export async function startServer(options: StudioOptions & {port?: number; containerListener?: boolean; publicDir?: string; studio?: Studio}) {
  if (options.containerListener && !options.drama) throw new Error('--container-listener 仅用于 --drama 工作台');
  const csrfToken = randomBytes(32).toString('hex');
  const clients = new Set<ServerResponse>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  let publishing = false;
  let pending = false;
  let studio: Studio;
  const publicDir = options.publicDir ?? fileURLToPath(new URL('../../public/', import.meta.url));
  const broadcast = async () => {
    if (publishing) { pending = true; return; }
    if (closing || clients.size === 0) return;
    publishing = true;
    try {
      const packet = `event: state\ndata: ${JSON.stringify(await studio.snapshot())}\n\n`;
      for (const client of clients) {
        if (client.writableLength > 1_048_576) { client.end(); clients.delete(client); }
        else client.write(packet);
      }
    } catch { for (const client of clients) client.write('event: error\ndata: {"error":"状态读取失败"}\n\n'); }
    finally {
      publishing = false;
      if (pending && !closing) { pending = false; schedule(); }
    }
  };
  const schedule = () => {
    if (timer || closing) return;
    timer = setTimeout(() => { timer = undefined; void broadcast(); }, 40);
  };
  let drama: DramaStore | undefined;
  let searchSettings: DramaSearchSettings | undefined;
  const networking = new Map<string,Set<AbortController>>();
  const revoke = (id:string) => { for (const request of networking.get(id)??[]) request.abort(new Error('Agent 的公开网络权限已关闭')); };
  const network: NonNullable<StudioOptions['dramaNetwork']> = async (input) => {
    const allowed=()=>drama?.networkAllowed(input.agentId,input.grantId)===true;
    const audit=(outcome:'allowed'|'denied'|'failed',sources?:readonly unknown[])=>drama?.recordNetworkCall({projectId:input.projectId,taskId:input.taskId,attemptId:input.attemptId,agentId:input.agentId,grantId:input.grantId,operation:input.operation,outcome,...(sources?{sources}:{})});
    if (!allowed()) { audit('denied');throw new Error('Agent 的公开网络权限已关闭'); }
    const controller=new AbortController();
    const active=networking.get(input.grantId)??new Set<AbortController>();
    active.add(controller);networking.set(input.grantId,active);
    const signal=input.signal ? AbortSignal.any([input.signal,controller.signal]) : controller.signal;
    try {
      const knownSource=input.operation==='fetch' && input.value.includes('?') && drama!.networkSources(input.projectId,input.taskId,input.attemptId).some(source=>source.url===input.value);
      const result=await (options.dramaNetwork ? options.dramaNetwork({...input,signal}) : publicNetworkOperation(input.operation,input.value,signal,searchSettings?.read(),knownSource));
      if (!allowed()) throw new Error('Agent 的公开网络权限已关闭');
      const source=result&&typeof result==='object'?result as {source?:unknown;sources?:unknown}:undefined;
      audit('allowed',Array.isArray(source?.sources)?source.sources:source?.source?[source.source]:[]);
      return result;
    } catch (error) {
      audit(allowed()?'failed':'denied');
      throw error;
    } finally { active.delete(controller);if (!active.size) networking.delete(input.grantId); }
  };
  const readSkill: NonNullable<StudioOptions['dramaReadSkill']> = (input) => {
    const host=studio.drama?.store;
    const scope=host?.task(input.taskId)?.drama;
    const attempt=host?.attempt(input.attemptId);
    if(!drama||!scope||scope.projectId!==input.projectId||scope.agentId!==input.agentId||attempt?.taskId!==input.taskId||
      !scope.skills?.some(skill=>skill.id===input.skillId&&skill.version===input.version)) throw new Error('Skill 不属于当前执行');
    return {body:drama.skill(input.skillId,input.version).body};
  };
  studio = options.studio ?? await createStudio({...options, ...(options.drama ? {dramaNetwork:network,dramaReadSkill:readSkill} : {}), onChange: () => { options.onChange?.(); schedule(); }});
  let dramaTimer: NodeJS.Timeout | undefined;
  let dramaRoutes: ReturnType<typeof createDramaRoutes> | undefined;
  if (studio.drama) {
    try {
      drama = new DramaStore(studio.drama.store);
      searchSettings = new DramaSearchSettings(studio.drama.store.db, process.env.DRAMA_BUNDLED_SEARCH === '1');
      const workflow = new DramaWorkflow(drama, studio.drama, studio);
      dramaRoutes = createDramaRoutes(drama, workflow, studio, revoke);
      workflow.refresh();
      dramaTimer = setInterval(() => { workflow.refresh(); }, 250);
      dramaTimer.unref();
    } catch (error) {
      await studio.close();
      throw error;
    }
  }
  const server = createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    void (async () => {
      const host = req.headers.host;
      if (!host || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) throw new HttpError(403, '仅支持本机访问');
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (url.origin !== `http://${host}`) throw new HttpError(403, '请求来源无效');
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        if (closing) throw new HttpError(503, '服务正在停止');
        if (req.headers.origin && req.headers.origin !== url.origin) throw new HttpError(403, '请求来源不匹配');
        const supplied = req.headers['x-studio-csrf'];
        if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrfToken))) throw new HttpError(403, '请刷新页面后重试');
      }
      if (method === 'GET' && url.pathname === '/api/bootstrap') return send(res, 200, {csrfToken});
      if (method === 'GET' && url.pathname === '/api/state') return send(res, 200, await studio.snapshot());
      if (method === 'GET' && url.pathname === '/api/health') return send(res, 200, {ok: true, phase: 3, backend: 'dsh'});
      if (url.pathname.startsWith('/api/drama/')) {
        if (!dramaRoutes) throw new HttpError(404, '剧本工作台未启用');
        if (url.pathname === '/api/drama/search-settings' && searchSettings) {
          if (method==='GET') return send(res,200,searchSettings.view());
          if (method==='PUT') return send(res,200,searchSettings.save(await body(req)));
        }
        if (await dramaRoutes(req, res, url, method, body, send)) return;
      }
      if (url.pathname.startsWith('/api/video')) {
        const video=studio.video;if(!video)throw new HttpError(404,'视频试点未启用：请设置 STUDIO_VIDEO_INPUT_ROOT 为专用素材目录');
        if(method==='GET'&&url.pathname==='/api/video/contracts')return send(res,200,{roles:VIDEO_ROLE_CONTRACTS,tools:VIDEO_TOOL_CONTRACTS});
        const plan=/^\/api\/video\/([a-zA-Z0-9_-]+)\/plan$/.exec(url.pathname);if(method==='GET'&&plan)return send(res,200,video.plan(plan[1]!));
        if(method==='GET'&&url.pathname==='/api/video')return send(res,200,video.list().map(job=>({job,review:(()=>{try{return video.review(job.id);}catch{return {status:'integrity_failed',publishAllowed:false};}})()})));
        if(method==='POST'&&url.pathname==='/api/video') {
          const value=await body(req),runId=text(value.runId,'Run ID',100),brief=text(value.brief,'任务说明',4000);
          const job=value.source?video.importForReview(runId,brief,text(value.source,'素材路径',4096)):video.create(runId,brief);
          return send(res,201,job);
        }
        const match=/^\/api\/video\/([a-zA-Z0-9_-]+)\/(stage|artifact|probe|decision|preview)$/.exec(url.pathname);
        if(match) {
          const [,id,action]=match;
          if(method==='GET'&&action==='preview') {
            const hash=text(url.searchParams.get('hash'),'文件哈希',64),data=video.preview(id!,hash);
            const range=req.headers.range;
            if(range) {
              const parts=/^bytes=(\d+)-(\d*)$/.exec(range);if(!parts)throw new HttpError(416,'无效范围');
              const start=Number(parts[1]),end=parts[2]?Math.min(Number(parts[2]),data.length-1):data.length-1;
              if(start>end||start>=data.length)throw new HttpError(416,'超出文件范围');
              res.writeHead(206,{'Content-Type':'video/mp4','Content-Range':`bytes ${start}-${end}/${data.length}`,'Accept-Ranges':'bytes','Content-Length':end-start+1,'Cache-Control':'no-store'});return res.end(data.subarray(start,end+1));
            }
            res.writeHead(200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':data.length,'Cache-Control':'no-store'});return res.end(data);
          }
          if(method==='POST') {
            const value=await body(req);
            if(action==='stage')return send(res,202,{taskId:video.admit(id!,text(value.stage,'阶段',30) as import('./video-pipeline.js').VideoStage)});
            if(action==='artifact')return send(res,200,video.acceptArtifact(id!,text(value.stage,'阶段',30) as import('./video-pipeline.js').VideoStage,text(value.source,'素材路径',4096)));
            if(action==='probe')return send(res,200,await video.probe(id!));
            if(action==='decision') {
              if(typeof value.approved!=='boolean'||value.ownerAttestation!=='I reviewed this exact video')throw new HttpError(400,'需本人完整审看并明确选择');
              return send(res,200,video.decide(id!,text(value.hash,'文件哈希',64),value.approved,typeof value.note==='string'?value.note:''));
            }
          }
        }
        throw new HttpError(404,'未找到视频资源');
      }
      const memory = /^\/api\/runs\/([a-zA-Z0-9_-]+)\/memories(?:\/([a-zA-Z0-9_-]+))?$/.exec(url.pathname);
      if (method === 'GET' && memory) {
        const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : undefined;
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
        if (memory[2]) return send(res, 200, await studio.readMemory(memory[1]!, {id: memory[2], offset, limit}));
        const layer = url.searchParams.get('layer');
        if (layer && !['long','medium','short'].includes(layer)) throw new HttpError(400, '记忆层级无效');
        return send(res, 200, await studio.listMemory(memory[1]!, {
          ...(layer ? {layer: layer as 'long'|'medium'|'short'} : {}),
          ...(url.searchParams.get('query') ? {query: url.searchParams.get('query')!} : {}),
          ...(url.searchParams.get('ownerAgentId') ? {ownerAgentId: url.searchParams.get('ownerAgentId')!} : {}),
          ...(url.searchParams.get('taskId') ? {taskId: url.searchParams.get('taskId')!} : {}), offset, limit,
        }));
      }
      const artifacts = /^\/api\/runs\/([a-zA-Z0-9_-]+)\/attempts\/([a-zA-Z0-9_-]+)\/files(?:\/(read))?$/.exec(url.pathname);
      if (method === 'GET' && artifacts) {
        const path = url.searchParams.get('path') ?? '.';
        if (artifacts[3]) return send(res, 200, await studio.readArtifact(artifacts[1]!, artifacts[2]!, {path,
          ...(url.searchParams.has('offset') ? {offset: Number(url.searchParams.get('offset'))} : {}),
          ...(url.searchParams.has('limit') ? {limit: Number(url.searchParams.get('limit'))} : {})}));
        return send(res, 200, await studio.listArtifacts(artifacts[1]!, artifacts[2]!, {path}));
      }
      if (method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive'});
        res.write(': connected\n\n'); clients.add(res);
        req.on('close', () => clients.delete(res));
        schedule(); return;
      }
      const template = /^\/api\/templates\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (method === 'PUT' && template) {
        const result = await studio.saveTemplate(templateInput(template[1]!, await body(req)));
        schedule(); return send(res, 200, result);
      }
      if (method === 'POST' && url.pathname === '/api/runs') {
        const value = await body(req);
        if (!['auto', 'direct', 'hierarchical'].includes(String(value.mode))) throw new HttpError(400, '执行模式无效');
        const result = await studio.createRun({prompt: text(value.prompt, '任务', 8000), mode: value.mode as ExecutionMode,
          ...(value.orchestratorTemplateId === undefined ? {} : {orchestratorTemplateId: text(value.orchestratorTemplateId, 'Orchestrator 模板', 100)}),
          ...(value.reuseMemoryFromRunId === undefined ? {} : {reuseMemoryFromRunId: text(value.reuseMemoryFromRunId, '长期记忆来源协作', 100)})});
        schedule(); return send(res, 201, result);
      }
      const tasks = /^\/api\/runs\/([a-zA-Z0-9_-]+)\/tasks$/.exec(url.pathname);
      if (method === 'POST' && tasks) {
        const value = await body(req);
        const requestId = text(value.requestId, '提交 ID', 100);
        if (!/^[a-zA-Z0-9_-]+$/.test(requestId)) throw new HttpError(400, '提交 ID 格式无效');
        const result = await studio.addTask(tasks[1]!, {prompt: text(value.prompt, '任务', 8000), requestId,
          ...(value.targetManagerId === undefined ? {} : {targetManagerId: text(value.targetManagerId, 'Manager ID', 100)})});
        schedule(); return send(res, 202, result);
      }
      const taskAction = /^\/api\/runs\/([a-zA-Z0-9_-]+)\/tasks\/([a-zA-Z0-9_-]+)\/(retry|cancel)$/.exec(url.pathname);
      if (method === 'POST' && taskAction) {
        if (taskAction[3] === 'retry') {
          const result = await studio.retryTask(taskAction[1]!, taskAction[2]!);
          schedule(); return send(res, 202, result);
        }
        await studio.cancelTask(taskAction[1]!, taskAction[2]!);
        schedule(); return send(res, 202, {accepted: true});
      }
      const action = /^\/api\/runs\/([a-zA-Z0-9_-]+)\/(messages|stop)$/.exec(url.pathname);
      if (method === 'POST' && action) {
        if (action[2] === 'messages') await studio.sendMessage(action[1]!, text((await body(req)).text, '消息', 8000));
        else await studio.stopRun(action[1]!);
        schedule(); return send(res, 202, {accepted: true});
      }
      const staticFiles: Record<string, {file: string; mime: string}> = {
        '/': {file: 'index.html', mime: 'text/html; charset=utf-8'},
        '/index.html': {file: 'index.html', mime: 'text/html; charset=utf-8'},
        '/video.html': {file: 'video.html', mime: 'text/html; charset=utf-8'},
        '/video.js': {file: 'video.js', mime: 'text/javascript; charset=utf-8'},
        '/app.js': {file: 'app.js', mime: 'text/javascript; charset=utf-8'},
        '/styles.css': {file: 'styles.css', mime: 'text/css; charset=utf-8'},
        ...(dramaRoutes ? {
          '/drama': {file: 'drama.html', mime: 'text/html; charset=utf-8'},
          '/drama.html': {file: 'drama.html', mime: 'text/html; charset=utf-8'},
          '/drama-app.js': {file: 'drama-app.js', mime: 'text/javascript; charset=utf-8'},
          '/drama-search-settings.js': {file:'drama-search-settings.js',mime:'text/javascript; charset=utf-8'},
          '/drama-canvas-draft.js': {file:'drama-canvas-draft.js',mime:'text/javascript; charset=utf-8'},
          '/drama-material.js': {file: 'drama-material.js', mime: 'text/javascript; charset=utf-8'},
          '/drama-app.css': {file: 'drama-app.css', mime: 'text/css; charset=utf-8'},
        } : {}),
      };
      const asset = staticFiles[url.pathname];
      if ((method === 'GET' || method === 'HEAD') && asset) {
        const content = await readFile(join(publicDir, asset.file));
        res.writeHead(200, {'Content-Type': asset.mime, 'Cache-Control': 'no-cache'});
        return res.end(method === 'HEAD' ? undefined : content);
      }
      throw new HttpError(404, '未找到此资源');
    })().catch((error: unknown) => {
      if (res.headersSent) { res.end(); return; }
      const message = error instanceof Error ? error.message : '请求失败';
      const status = error instanceof HttpError || error instanceof DramaStoreError ? error.status : /not found|不存在|unknown run|unknown task|unknown artifact|unknown node execution/i.test(message) ? 404 : 400;
      send(res, status, {error: message.slice(0, 600)});
    });
  });
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': heartbeat\n\n'); }, 20_000);
  heartbeat.unref();
  const listenAddress = options.containerListener ? '0.0.0.0' : '127.0.0.1';
  try {
    await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(options.port ?? 4317, listenAddress, () => {server.off('error', reject); accept();}); });
  } catch (error) { clearInterval(heartbeat); clearInterval(dramaTimer); await studio.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP listener did not return a TCP address');
  let closePromise: Promise<void> | undefined;
  return {
    server, studio, url: `http://127.0.0.1:${address.port}`,
    close(): Promise<void> {
      return closePromise ??= (async () => {
        closing = true; clearInterval(heartbeat); clearInterval(dramaTimer); if (timer) clearTimeout(timer);
        for (const id of networking.keys()) revoke(id);
        for (const client of clients) client.end(); clients.clear();
        await new Promise<void>((accept, reject) => { server.close(error => error ? reject(error) : accept()); server.closeIdleConnections(); });
        await studio.close();
      })();
    },
  };
}

async function main(): Promise<void> {
  const {values} = parseArgs({options: {'port': {type: 'string'}, 'data-dir': {type: 'string'}, 'dsh-home': {type: 'string'}, 'container-listener': {type: 'boolean'}, drama: {type: 'boolean'}, help: {type: 'boolean'}}});
  if (values.help) { console.log('Agent Studio\n  --drama (starts the screenplay Workbench on port 4318)\n  --container-listener (Workbench in Docker, publish to host 127.0.0.1 only)\n  --port 4317\n  --data-dir .studio | .drama | .drama-demo\n  --dsh-home <existing DSH configuration directory>\n  STUDIO_MAX_WORKERS=4\n  STUDIO_DEMO_DELAY_MS=0\n  STUDIO_CONTAINER_IMAGE=<trusted local image digest> (enables offline containers)'); return; }
  const drama = values.drama === true;
  const port = Number(values.port ?? (drama ? '4318' : process.env.STUDIO_PORT ?? '4317'));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port 必须是 0–65535 的整数');
  const dshHome = process.env.STUDIO_DEMO === '1' ? undefined : values['dsh-home'] ?? process.env.STUDIO_DSH_HOME ?? process.env.DSH_HOME;
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min}–${max} 的整数`);
    return value;
  };
  const scheduler = {maxActiveWorkers: integer('STUDIO_MAX_WORKERS', 4, 1, 24),
    pollIntervalMs: integer('STUDIO_POLL_INTERVAL_MS', 50, 10, 60000),
    maxDeliveryAttempts: integer('STUDIO_MAX_DELIVERY_ATTEMPTS', 3, 1, 20),
    retryDelayMs: integer('STUDIO_RETRY_DELAY_MS', 500, 10, 60000)};
  const demoDelayMs = integer('STUDIO_DEMO_DELAY_MS', 0, 0, 60000);
  const autoCompact = process.env.STUDIO_COMPACTION_AUTO ?? 'true';
  if (!['true','false'].includes(autoCompact)) throw new Error('STUDIO_COMPACTION_AUTO 必须为 true 或 false');
  const compaction = {auto: autoCompact === 'true',
    ...(process.env.STUDIO_COMPACTION_THRESHOLD === undefined ? {} : {thresholdRatio: Number(process.env.STUDIO_COMPACTION_THRESHOLD)}),
    ...(process.env.STUDIO_COMPACTION_RETAIN === undefined ? {} : {retainRatio: Number(process.env.STUDIO_COMPACTION_RETAIN)}),
    ...(process.env.STUDIO_COMPACTION_MAX_TOKENS === undefined ? {} : {maxTokens: Number(process.env.STUDIO_COMPACTION_MAX_TOKENS)})};
  const image = process.env.STUDIO_CONTAINER_IMAGE;
  const execution = image ? {enabled: true, image,
    timeoutMs: integer('STUDIO_EXEC_TIMEOUT_MS', 30000, 100, 300000),
    maxOutputBytes: integer('STUDIO_EXEC_OUTPUT_BYTES', 65536, 1024, 1048576),
    maxFileBytes: integer('STUDIO_EXEC_FILE_BYTES', 65536, 1024, 1048576),
    memoryMb: integer('STUDIO_EXEC_MEMORY_MB', 256, 64, 4096),
    cpus: Number(process.env.STUDIO_EXEC_CPUS ?? 1),
    pidsLimit: integer('STUDIO_EXEC_PIDS', 64, 16, 512)} : {enabled: false};
  const defaultDataDir = drama ? (process.env.STUDIO_DEMO === '1' ? '.drama-demo' : '.drama') : (process.env.STUDIO_DATA_DIR ?? '.studio');
  const app = await startServer({...(process.env.STUDIO_VIDEO_INPUT_ROOT && !drama ? {videoInputRoot:resolve(process.env.STUDIO_VIDEO_INPUT_ROOT)} : {}), drama, ...(drama ? {demoModels: process.env.STUDIO_DEMO === '1'} : {}), containerListener: values['container-listener'], port, scheduler, demoDelayMs, execution, compaction, dataDir: resolve(values['data-dir'] ?? defaultDataDir), ...(dshHome ? {dshHome: resolve(dshHome)} : {})});
  if (drama) console.log(`剧本工厂：${app.url}/drama`);
  console.log(`Agent Studio · Phase 3\nLocal: ${app.url}\nSQLite 三层记忆已启用；Worker ${image ? '使用本地隔离容器，外网关闭' : '使用无副作用探针（设置 STUDIO_CONTAINER_IMAGE 启用容器）'}。`);
  const stop = () => { void app.close().then(() => process.exit(0), () => process.exit(1)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : '启动失败'); process.exitCode = 1; });
}
