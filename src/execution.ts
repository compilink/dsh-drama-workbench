/** Worker commands run in local Docker containers with isolated, persistent Attempt volumes. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export interface ExecutionConfigInput { enabled?: boolean; image?: string; timeoutMs?: number; maxOutputBytes?: number; maxFileBytes?: number; memoryMb?: number; cpus?: number; pidsLimit?: number }
export interface ExecutionConfig { enabled: boolean; image?: string; timeoutMs: number; maxOutputBytes: number; maxFileBytes: number; memoryMb: number; cpus: number; pidsLimit: number; network: 'none' }
export interface ExecutionContext { runId: string; taskId: string; attemptId: string; workerId: string }
export interface ExecutionResult { exitCode: number | null; signal: string | null; timedOut: boolean; aborted: boolean; outputLimitExceeded: boolean; stdout: string; stderr: string; workspace: {volume: string; attemptId: string} }
export interface FileReadResult { path: string; content: string; encoding: 'utf8'; offset: number; totalBytes: number; nextOffset: number | null }
export interface FileWriteResult { path: string; bytesWritten: number }
export interface FileListResult { path: string; entries: {name: string; kind: 'file' | 'directory' | 'symlink' | 'other'}[]; truncated: boolean }
interface ProcessResult { exitCode: number | null; signal: string | null; timedOut: boolean; aborted: boolean; outputLimitExceeded: boolean; stdout: string; stderr: string }

const OWNER_LABEL = 'dev.dsh-agent-studio.owner';
const ATTEMPT_LABEL = 'dev.dsh-agent-studio.attempt';
const MANAGED_LABEL = 'dev.dsh-agent-studio.managed';
const LOCAL_ID = /^[a-zA-Z0-9_-]{1,100}$/;

function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return Number(value);
}

/** Resolves host-owned configuration; models cannot select images, mounts, network or resource limits. */
export function resolveExecution(input: ExecutionConfigInput = {}): ExecutionConfig {
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('execution.enabled must be boolean');
  const enabled = input.enabled ?? false;
  if (input.image !== undefined && (typeof input.image !== 'string' || input.image.length > 300 || !/^(?:[a-zA-Z0-9._/:+-]+@)?sha256:[a-f0-9]{64}$/.test(input.image))) throw new Error('execution.image must be an immutable local image ID or repository@sha256 digest');
  if (enabled && !input.image) throw new Error('Enabled container execution requires an explicitly configured immutable image');
  const cpus = input.cpus ?? 1;
  if (typeof cpus !== 'number' || !Number.isFinite(cpus) || cpus < 0.1 || cpus > 8) throw new Error('execution.cpus must be between 0.1 and 8');
  return {enabled, ...(input.image ? {image: input.image} : {}), timeoutMs: integer(input.timeoutMs ?? 30_000, 'execution.timeoutMs', 100, 300_000), maxOutputBytes: integer(input.maxOutputBytes ?? 65_536, 'execution.maxOutputBytes', 1024, 1_048_576), maxFileBytes: integer(input.maxFileBytes ?? 65_536, 'execution.maxFileBytes', 1024, 1_048_576), memoryMb: integer(input.memoryMb ?? 256, 'execution.memoryMb', 64, 4096), pidsLimit: integer(input.pidsLimit ?? 64, 'execution.pidsLimit', 16, 512), cpus, network: 'none'};
}

/** The Docker client needs local context settings; container processes never receive this environment. */
export function dockerClientEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH','HOME','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','DOCKER_CERT_PATH','DOCKER_TLS_VERIFY','XDG_RUNTIME_DIR','TMPDIR']) if (source[key] !== undefined) env[key] = source[key];
  return env;
}

/** Relative workspace paths only; the container helper additionally rejects every symbolic-link component. */
export function validateWorkspacePath(value: unknown, allowRoot = false): string {
  if (typeof value !== 'string' || value.length > 1024 || value.includes('\0') || value.includes('\\') || value.startsWith('/') || value.split('/').some(part => part === '..') || (!allowRoot && (!value || value === '.'))) throw new Error('Path must stay relative to the Attempt workspace');
  return value || '.';
}

// This trusted program runs inside the container. No Worker-controlled filesystem path is opened on the host.
const FILE_HELPER = String.raw`
const fs=require('node:fs');const path=require('node:path');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
function safe(value,create){
 if(typeof value!=='string'||value.length>1024||value.includes('\0')||value.includes('\\')||path.isAbsolute(value)||value.split('/').includes('..'))throw Error('Invalid workspace path');
 const parts=value.split('/').filter(p=>p&&p!=='.');let current='/workspace';
 for(let i=0;i<parts.length;i++){
  current=path.join(current,parts[i]);let stat;
  try{stat=fs.lstatSync(current);}catch(e){if(e.code!=='ENOENT')throw e;if(create&&i<parts.length-1){fs.mkdirSync(current,{mode:0o700});stat=fs.lstatSync(current);}else if(i<parts.length-1)throw e;}
  if(stat?.isSymbolicLink())throw Error('Symbolic links are not allowed in file-tool paths');
  if(i<parts.length-1&&stat&&!stat.isDirectory())throw Error('Parent is not a directory');
 }
 return current;
}
let result;const file=safe(input.path,input.op==='write');
if(input.op==='write'){
 const bytes=Buffer.from(input.content,'utf8');if(bytes.length>input.maxFileBytes)throw Error('File exceeds the configured write limit');
 const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK,0o600);
 try{if(!fs.fstatSync(fd).isFile())throw Error('Path is not a regular file');fs.writeFileSync(fd,bytes);}finally{fs.closeSync(fd);}
 result={path:input.path,bytesWritten:bytes.length};
}else if(input.op==='read'){
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const stat=fs.fstatSync(fd);if(!stat.isFile())throw Error('Path is not a regular file');const size=Math.max(0,Math.min(input.limit,stat.size-input.offset));const data=Buffer.alloc(size);const bytes=fs.readSync(fd,data,0,size,input.offset);result={path:input.path,content:data.subarray(0,bytes).toString('utf8'),encoding:'utf8',offset:input.offset,totalBytes:stat.size,nextOffset:input.offset+bytes<stat.size?input.offset+bytes:null};}finally{fs.closeSync(fd);}
}else if(input.op==='list'){
 const stat=fs.lstatSync(file);if(!stat.isDirectory())throw Error('Path is not a directory');const names=fs.readdirSync(file,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name));result={path:input.path,entries:names.slice(0,100).map(e=>({name:e.name,kind:e.isSymbolicLink()?'symlink':e.isDirectory()?'directory':e.isFile()?'file':'other'})),truncated:names.length>100};
}else throw Error('Unknown file operation');
process.stdout.write(JSON.stringify(result));
`;

/** Each operation gets a new unprivileged container; only its own Attempt volume persists. */
export class DockerExecution {
  readonly config: ExecutionConfig;
  readonly ownerId: string;
  private readonly env = dockerClientEnvironment();
  private readonly prepared = new Map<string, string>();
  private readonly active = new Map<string, {controller: AbortController; done: Promise<unknown>}>();
  private initialized = false;
  private closing = false;
  private closePromise?: Promise<void>;
  constructor(input: ExecutionConfigInput = {}, options: {dataDir: string}) {
    this.config = resolveExecution(input);
    this.ownerId = createHash('sha256').update(resolve(options.dataDir)).digest('hex').slice(0,20);
  }

  /** Fails before enabling tools unless Docker is local and the configured image already exists. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.config.enabled) { this.initialized = true; return; }
    const configuredHost = this.env.DOCKER_CONTEXT ? undefined : this.env.DOCKER_HOST;
    const endpoint = configuredHost ?? JSON.parse((await this.control(['context','inspect','--format','{{json .Endpoints.docker.Host}}'])).stdout) as string;
    if (typeof endpoint !== 'string' || !endpoint.startsWith('unix://')) throw new Error('Worker execution requires a local Unix-socket Docker daemon');
    const daemon = await this.control(['info','--format','{{.OSType}}']);
    if (daemon.stdout.trim() !== 'linux') throw new Error('Worker execution requires Linux containers');
    const inspected = await this.control(['image','inspect',this.config.image!, '--format','{{json .Config}}']);
    const inheritedVolumes = (JSON.parse(inspected.stdout) as {Volumes?: Record<string, unknown>}).Volumes;
    if (inheritedVolumes && Object.keys(inheritedVolumes).length) throw new Error('Worker images must not declare additional VOLUME mounts');
    await this.reap();
    this.initialized = true;
  }

  /** Executes shell code inside an unprivileged, offline container and returns bounded output. */
  async execute(context: ExecutionContext, input: {command: string; timeoutMs?: number}, signal?: AbortSignal): Promise<ExecutionResult> {
    if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 32_000) throw new Error('command must be non-empty text up to 32000 characters');
    const timeoutMs = input.timeoutMs === undefined ? this.config.timeoutMs : integer(input.timeoutMs,'timeoutMs',100,this.config.timeoutMs);
    return this.operation(context,signal,async (operationSignal,volume) => ({...await this.container(context,volume,['/bin/sh','-c',input.command],undefined,timeoutMs,operationSignal),workspace:{volume,attemptId:context.attemptId}}));
  }
  /** Reads a bounded UTF-8 slice after resolving every path component inside the workspace. */
  async readFile(context: ExecutionContext, input: {path: string; offset?: number; limit?: number}, signal?: AbortSignal): Promise<FileReadResult> {
    const path=validateWorkspacePath(input.path);
    const offset=integer(input.offset??0,'offset',0,Number.MAX_SAFE_INTEGER);
    const limit=integer(input.limit??Math.min(8192,Math.floor(this.config.maxOutputBytes/8)),'limit',1,Math.min(this.config.maxFileBytes,Math.floor(this.config.maxOutputBytes/8)));
    return this.files<FileReadResult>(context,{op:'read',path,offset,limit},signal);
  }
  /** Writes text only to the current Attempt volume; parent directories are created inside that container. */
  async writeFile(context: ExecutionContext, input: {path: string; content: string}, signal?: AbortSignal): Promise<FileWriteResult> {
    const path=validateWorkspacePath(input.path);
    if(typeof input.content!=='string'||Buffer.byteLength(input.content,'utf8')>this.config.maxFileBytes) throw new Error('content exceeds the configured file write limit');
    return this.files<FileWriteResult>(context,{op:'write',path,content:input.content,maxFileBytes:this.config.maxFileBytes},signal);
  }
  /** Lists at most 100 workspace entries without following symbolic links. */
  async listFiles(context: ExecutionContext, input: {path?: string} = {}, signal?: AbortSignal): Promise<FileListResult> {
    return this.files<FileListResult>(context,{op:'list',path:validateWorkspacePath(input.path??'.',true)},signal);
  }
  /** Cancels only the current operation for the selected Attempt and waits for its container to stop. */
  async cancelAttempt(attemptId: string): Promise<void> { if(!LOCAL_ID.test(attemptId))throw new Error('Invalid Attempt identifier');const operation=this.active.get(attemptId);if(operation){operation.controller.abort(new Error('Attempt cancelled'));await Promise.allSettled([operation.done]);}if(this.config.enabled&&this.initialized)await this.reap(attemptId); }
  /** Removes existing volumes for the supplied idle attempts, verifying both the volume name and ownership labels. */
  async removeAttemptWorkspaces(attemptIds: readonly string[]): Promise<void> {
    if (!attemptIds.length || !this.config.enabled) return;
    const ids = new Set(attemptIds);
    for (const id of ids) {
      if (!LOCAL_ID.test(id) || this.active.has(id)) throw new Error('无法清理正在使用或无法识别的执行工作区');
    }
    for (const id of ids) {
      const volume = this.volumeName(id);
      const matches = await this.control(['volume','ls','-q','--filter',`label=${ATTEMPT_LABEL}=${id}`,'--filter',`label=${MANAGED_LABEL}=workspace`]);
      const names = matches.stdout.trim().split(/\s+/).filter(Boolean);
      if (!names.length) continue;
      if (names.length !== 1 || names[0] !== volume) throw new Error('执行卷属于其他数据目录，请在原 Docker 执行环境重试删除');
      await this.verifyVolume(volume, id);
      await this.control(['volume', 'rm', volume]);
      this.prepared.delete(id);
    }
  }

  /** Stops owned operations and removes their containers; completed workspace volumes remain available. */
  close(): Promise<void> {
    return this.closePromise??=(async()=>{this.closing=true;const operations=[...this.active.values()];for(const operation of operations)operation.controller.abort(new Error('Execution provider closed'));await Promise.allSettled(operations.map(operation=>operation.done));if(this.config.enabled&&this.initialized)await this.reap();})();
  }

  private async reap(attemptId?:string):Promise<void> {
    const orphaned=await this.control(['ps','-aq','--filter',`label=${OWNER_LABEL}=${this.ownerId}`,'--filter',`label=${MANAGED_LABEL}=worker`,...(attemptId?['--filter',`label=${ATTEMPT_LABEL}=${attemptId}`]:[])]);
    for(const id of orphaned.stdout.trim().split(/\s+/).filter(Boolean)){
      if(!/^[a-f0-9]{12,64}$/.test(id))throw new Error('Unexpected Docker container identifier');
      await this.control(['rm','-f',id]);
    }
  }

  private async files<T>(context: ExecutionContext,input: Record<string,unknown>,signal?: AbortSignal): Promise<T> {
    return this.operation(context,signal,async (operationSignal,volume) => {
      const result=await this.container(context,volume,['/usr/local/bin/node','-e',FILE_HELPER],JSON.stringify(input),this.config.timeoutMs,operationSignal,false,input.op!=='write');
      if(result.aborted||result.timedOut||result.outputLimitExceeded||result.exitCode!==0) throw new Error(`Container file operation failed: ${result.aborted?'aborted':result.timedOut?'timed out':result.outputLimitExceeded?'output limit exceeded':result.stderr.trim()||`exit ${result.exitCode}`}`);
      return JSON.parse(result.stdout) as T;
    });
  }
  private async operation<T>(context: ExecutionContext,signal: AbortSignal|undefined,work:(signal:AbortSignal,volume:string)=>Promise<T>):Promise<T> {
    if(!this.config.enabled)throw new Error('Worker container execution is disabled');
    if(!this.initialized||this.closing)throw new Error('Worker container execution is not available');
    for(const value of Object.values(context))if(typeof value!=='string'||!LOCAL_ID.test(value))throw new Error('Invalid execution context identifier');
    if(this.active.has(context.attemptId))throw new Error('This Attempt already has an active container operation');
    const controller=new AbortController();const operationSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const done=Promise.resolve().then(async()=>{operationSignal.throwIfAborted();const volume=await this.workspace(context,operationSignal);operationSignal.throwIfAborted();return work(operationSignal,volume);});
    this.active.set(context.attemptId,{controller,done});
    try{return await done;}finally{this.active.delete(context.attemptId);}
  }
  private async workspace(context:ExecutionContext,signal:AbortSignal):Promise<string> {
    const existing=this.prepared.get(context.attemptId);if(existing)return existing;
    const volume=this.volumeName(context.attemptId);
    await this.control(['volume','create','--label',`${OWNER_LABEL}=${this.ownerId}`,'--label',`${ATTEMPT_LABEL}=${context.attemptId}`,'--label',`${MANAGED_LABEL}=workspace`,volume],signal);
    await this.verifyVolume(volume, context.attemptId, signal);
    // The fixed initializer changes only this volume root's mode. Worker-controlled code always runs as uid 1000.
    const initialized=await this.container(context,volume,['/usr/local/bin/node','-e',"require('node:fs').chmodSync('/workspace',0o777)"],undefined,this.config.timeoutMs,signal,true);
    if(initialized.exitCode!==0||initialized.aborted||initialized.timedOut||initialized.outputLimitExceeded)throw new Error('Workspace initialization failed');
    this.prepared.set(context.attemptId,volume);return volume;
  }
  private volumeName(attemptId: string): string {
    return `studio-${this.ownerId}-${createHash('sha256').update(attemptId).digest('hex').slice(0,20)}`;
  }
  private async verifyVolume(volume: string, attemptId: string, signal?: AbortSignal): Promise<void> {
    const labels = JSON.parse((await this.control(['volume','inspect',volume,'--format','{{json .Labels}}'],signal)).stdout) as Record<string,string>;
    if (labels[OWNER_LABEL] !== this.ownerId || labels[ATTEMPT_LABEL] !== attemptId || labels[MANAGED_LABEL] !== 'workspace') throw new Error('Workspace volume ownership mismatch');
  }
  private async container(context:ExecutionContext,volume:string,command:string[],input:string|undefined,timeoutMs:number,signal:AbortSignal,initialize=false,readOnlyWorkspace=false):Promise<ProcessResult> {
    const name=`studio-${this.ownerId}-${randomUUID()}`;
    const args=['create','--pull=never','--name',name,'--label',`${OWNER_LABEL}=${this.ownerId}`,'--label',`${ATTEMPT_LABEL}=${context.attemptId}`,'--label',`${MANAGED_LABEL}=worker`,'--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--network=none','--pids-limit',String(this.config.pidsLimit),'--memory',`${this.config.memoryMb}m`,'--memory-swap',`${this.config.memoryMb}m`,'--cpus',String(this.config.cpus),'--user',initialize?'0:0':'1000:1000','--workdir','/workspace','--mount',`type=volume,source=${volume},target=/workspace,volume-nocopy${readOnlyWorkspace?',readonly':''}`,'--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=67108864,uid=1000,gid=1000','--env','HOME=/tmp','--entrypoint',command[0]!, ...(input===undefined?[]:['-i']),this.config.image!,...command.slice(1)];
    const remove=()=>this.control(['rm','-f',name]).then(()=>undefined).catch(async(error:unknown)=>{
      const stillPresent=await this.control(['ps','-aq','--filter',`name=^/${name}$`]);if(stillPresent.stdout.trim())throw error;
    });
    try {
      // Let the bounded create request settle before cleanup, even if cancellation arrives during creation.
      await this.control(args);
      signal.throwIfAborted();
      return await this.process(['start','--attach',...(input===undefined?[]:['--interactive']),name],{input,timeoutMs,signal,onStop:remove,maxOutputBytes:this.config.maxOutputBytes});
    }
    finally { await remove(); }
  }
  private async control(args:string[],signal?:AbortSignal):Promise<ProcessResult> {
    const result=await this.process(args,{timeoutMs:15_000,signal,maxOutputBytes:65_536});
    if(result.exitCode!==0||result.timedOut||result.aborted||result.outputLimitExceeded)throw new Error(`Docker ${args[0]} failed: ${result.aborted?'aborted':result.timedOut?'timed out':result.outputLimitExceeded?'output limit exceeded':result.stderr.trim()||`exit ${result.exitCode}`}`);
    return result;
  }
  private process(args:string[],options:{input?:string;timeoutMs:number;signal?:AbortSignal;maxOutputBytes:number;onStop?:()=>Promise<void>}):Promise<ProcessResult> {
    return new Promise((accept,reject)=>{
      if(options.signal?.aborted){reject(options.signal.reason??new Error('Aborted'));return;}
      const child=spawn('docker',args,{env:this.env,stdio:['pipe','pipe','pipe'],windowsHide:true});
      let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),bytes=0,timedOut=false,aborted=false,outputLimitExceeded=false,stopPromise:Promise<void>|undefined;
      const stop=()=>{stopPromise??=(async()=>{try{await options.onStop?.();}finally{child.kill('SIGKILL');}})();void stopPromise.catch(()=>undefined);};
      const abort=()=>{aborted=true;stop();};
      const timer=setTimeout(()=>{timedOut=true;stop();},options.timeoutMs);timer.unref();
      options.signal?.addEventListener('abort',abort,{once:true});
      const collect=(chunk:Buffer,channel:'stdout'|'stderr')=>{const remaining=Math.max(0,options.maxOutputBytes-bytes);const kept=chunk.subarray(0,remaining);bytes+=kept.length;if(channel==='stdout')stdout=Buffer.concat([stdout,kept]);else stderr=Buffer.concat([stderr,kept]);if(chunk.length>remaining){outputLimitExceeded=true;stop();}};
      child.stdout.on('data',(chunk:Buffer)=>collect(chunk,'stdout'));child.stderr.on('data',(chunk:Buffer)=>collect(chunk,'stderr'));
      child.stdin.on('error',()=>{ /* The container may close input before the bounded request has drained. */ });
      child.once('error',error=>{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);reject(error);});
      child.once('close',(exitCode,exitSignal)=>{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);void Promise.resolve(stopPromise).then(()=>accept({exitCode,signal:exitSignal,timedOut,aborted,outputLimitExceeded,stdout:stdout.toString('utf8'),stderr:stderr.toString('utf8')}),reject);});
      child.stdin.end(options.input);
    });
  }
}
