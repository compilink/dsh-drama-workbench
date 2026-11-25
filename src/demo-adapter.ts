/** Deterministic task-aware demo provider; no model service is contacted. */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CallId, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ModelOption } from './types.js';

export const DEMO_MODELS: ModelOption[] = ['planner', 'coordinator', 'executor'].map(model => ({ provider: 'studio-demo', model, name: `演示 ${model}（离线脚本）`, efforts: ['low', 'medium', 'high'].map(id => ({ id, name: id })), demo: true }));
function textChunks(value: string): StreamChunk[] { return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: value }, { type: 'block-end', index: 0, block: { type: 'text', text: value } }, { type: 'usage', usage: { inputTokens: 1, outputTokens: value.length } }, { type: 'finish', reason: { kind: 'stop' } }]; }
function toolChunks(name: string, args: object): StreamChunk[] { const id = CallId(randomUUID()); const json = JSON.stringify(args); return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json }, { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } }, { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }, { type: 'finish', reason: { kind: 'tool-calls' } }]; }
interface Envelope { delegates?:{id:string;name:string;role:string}[];children?:{id:string;result?:string}[]; kind: string; taskId?: string; attemptId?: string; text: string; drama?: boolean; targetManagerId?: string; report?: {summary?: string; evidence?: string[]}; execution?: 'docker' | 'probe-only'; memory?: {checkpoint?: {id: string; version: number}}; memorySources?: {agentId: string; role: string; templateId: string}[] }

/** Finite tool decisions over the latest durable delivery and actual DSH tool history. */
export class DemoAdapter extends LlmAdapter {
  constructor(private readonly options: {workerDelayMs?: number} = {}) { super(); }
  override async listModels(): Promise<LlmResolvedModelInfo[]> { return Promise.all(DEMO_MODELS.map(model => this.resolveModel(model.provider, model.model))); }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return { provider, id: model, name: `Offline demo ${model}`, context: {contextWindow: 131072}, reasoning: { efforts: ['low', 'medium', 'high'].map(id => ({ id: ReasoningEffortId(id), name: id })) } }; }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted();
    const lastSource = options.messages.at(-1)?.source;
    if (lastSource?.kind === 'plugin' && lastSource.plugin === 'dsh-compaction-basic') {
      yield* textChunks('The current Studio delivery remains authoritative. Recover progress from its short-term checkpoint reference; verify tool outcomes before resuming the same task and attempt.');
      return;
    }
    const role = /STUDIO_ROLE=(\w+)/.exec(options.system ?? '')?.[1];
    const mode = /STUDIO_MODE=(\w+)/.exec(options.system ?? '')?.[1];
    const index = options.messages.findLastIndex(message => message.role === 'user' && message.source.kind === 'plugin' && message.source.plugin === 'dsh-agent-studio');
    const input = options.messages[index];
    const content = input?.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '';
    let envelope: Envelope;
    try { envelope = JSON.parse(content) as Envelope; }
    catch { yield* textChunks('【离线演示】等待结构化任务投递。'); return; }
    const calls = options.messages.slice(index + 1).flatMap(message => message.content.filter(block => block.type === 'tool-call'));
    const results = options.messages.slice(index + 1).flatMap(message => message.content.filter(block => block.type === 'tool-result'));
    const called = (name: string) => calls.some(call => call.name === name);
    const wrote = (layer: string) => calls.some(call => call.name === 'studio_memory_write' && (JSON.parse(call.arguments) as {layer?: string}).layer === layer);
    const result = (name: string): Record<string, unknown> | undefined => {
      const call = calls.findLast(item => item.name === name);
      const output = call ? results.find(item => item.toolCallId === call.id) : undefined;
      if (!output || output.isError) return;
      const value = output.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      try { return JSON.parse(value) as Record<string, unknown>; } catch { return; }
    };
    if (results.some(item => item.isError)) { yield* textChunks('【离线演示】工具返回错误，本任务保留实际错误并停止；未声称工作已完成。'); return; }
    let chunks: StreamChunk[];
    if (envelope.kind === 'message') chunks = textChunks('【离线演示】已收到会话补充。正在执行的任务保持不变；新增独立工作请使用“追加任务”。');
    else if (envelope.kind === 'result') chunks = textChunks(`【演示协调器】任务 ${envelope.taskId?.slice(0, 8)} 已验收。${envelope.text}\n${envelope.execution === 'docker' ? '执行工具使用本地隔离容器，产物保留在该 Attempt 工作区。' : '本次执行能力为无副作用探针。'}追加任务不会打断其他执行。`);
    else if(envelope.drama&&role!=='worker'&&envelope.kind==='review') {
      chunks=toolChunks('studio_decide',{taskId:envelope.taskId,decision:'submit',text:'【离线协调验收】\n'+(envelope.children??[]).map(child=>child.result).join('\n')});
    } else if(envelope.drama&&role!=='worker'&&envelope.kind==='task') {
      const targets=envelope.delegates??[];
      chunks=targets.length?toolChunks('studio_split',{taskId:envelope.taskId,branches:targets.slice(0,16).map(target=>({agentId:target.id,prompt:target.name+'按原始输入处理分工'}))})
        :toolChunks('studio_decide',{taskId:envelope.taskId,decision:'submit',text:'【离线审稿】已核对本轮输入。'});
    } else if (envelope.kind === 'review') chunks = toolChunks('studio_accept', { taskId: envelope.taskId, text: `验收 Worker 报告：${envelope.report?.summary ?? envelope.text}` });
    else if (envelope.kind !== 'task') chunks = textChunks('');
    else if (role === 'worker' && envelope.drama) {
      if (!calls.length && this.options.workerDelayMs) await delay(this.options.workerDelayMs, undefined, {signal: options.signal});
      const scope = {taskId: envelope.taskId, attemptId: envelope.attemptId};
      if (!called('studio_probe')) chunks = toolChunks('studio_probe', {...scope, text: '生成离线测试候选'});
      else chunks = toolChunks('studio_report', {...scope, text: '【离线演示候选】\n第一场　傍晚　内景\n阿宁合上旧信封。\n阿宁：等潮水退了，我们再出发。\n\n此候选仅用于验证流程。'});
    }
    else if (role === 'worker') {
      if (!calls.length && this.options.workerDelayMs) await delay(this.options.workerDelayMs, undefined, { signal: options.signal });
      const scope = {taskId: envelope.taskId, attemptId: envelope.attemptId};
      const checkpoint = result('studio_memory_checkpoint');
      const checkpointCount = calls.filter(call => call.name === 'studio_memory_checkpoint').length;
      let restored: Record<string, unknown> | undefined;
      const read = result('studio_memory_read');
      if (typeof read?.content === 'string') { try { restored = JSON.parse(read.content) as Record<string, unknown>; } catch { /* Free-form checkpoints are interpreted by real models; the scripted demo only restores its own JSON records. */ } }
      const completed = restored?.phase === 'executed' && restored.attemptId === envelope.attemptId;
      const docker = envelope.execution === 'docker';
      if (envelope.memory?.checkpoint && !called('studio_memory_read')) chunks = toolChunks('studio_memory_read', {id: envelope.memory.checkpoint.id});
      else if (!called('studio_memory_list')) chunks = toolChunks('studio_memory_list', {layer: 'long', limit: 8});
      else if (!wrote('long')) chunks = toolChunks('studio_memory_write', {layer: 'long', title: '执行结果核验方法', summary: '以实际工具结果为依据；恢复后核验已有工作再继续。', content: '报告前检查工具的退出码、超时和实际文件内容。上下文恢复后先读取检查点，并核验文件及当前 Attempt。不得把未执行的计划当成结果。'});
      else if (!wrote('medium')) chunks = toolChunks('studio_memory_write', {layer: 'medium', title: '当前任务目标与范围', summary: '记录当前任务目标，仅授权当前 Attempt 的隔离执行。', content: `Task ${envelope.taskId}；Attempt ${envelope.attemptId}。目标：${envelope.text.slice(0, 6000)}。执行模式：${docker ? '本地隔离容器' : '无副作用探针'}。`});
      else if (!checkpointCount) chunks = toolChunks('studio_memory_checkpoint', {summary: completed ? '已恢复已验证的执行进度，继续核验并报告。' : '任务已接收，下一步执行并核验工具结果。', content: JSON.stringify({...scope, phase: completed ? 'executed' : 'ready', next: completed ? 'verify-and-report' : docker ? 'write-run-read' : 'probe'}), ...(envelope.memory?.checkpoint ? {expectedVersion: envelope.memory.checkpoint.version} : {})});
      else if (docker && !completed && !called('studio_file_write')) chunks = toolChunks('studio_file_write', {...scope, path: 'studio-demo.mjs', content: `import {writeFileSync} from 'node:fs';\nconst result=${JSON.stringify({...scope, verified: true, operation: 'local-container-code', prompt: envelope.text.slice(0, 1000)})};\nwriteFileSync('result.json',JSON.stringify(result,null,2)+'\\n');\nconsole.log('studio-container-ok');\n`});
      else if (docker && !completed && !called('studio_exec')) chunks = toolChunks('studio_exec', {...scope, command: 'node studio-demo.mjs'});
      else if (docker && !completed && (result('studio_exec')?.exitCode !== 0 || result('studio_exec')?.timedOut || result('studio_exec')?.aborted || result('studio_exec')?.outputLimitExceeded)) chunks = textChunks('【离线演示】容器命令未完整成功，保留实际执行结果供重试。');
      else if (docker && !called('studio_file_read')) chunks = toolChunks('studio_file_read', {...scope, path: 'result.json'});
      else if (docker && typeof result('studio_file_read')?.content !== 'string') chunks = textChunks('【离线演示】没有读取到容器产物，未报告成功。');
      else if (!docker && !completed && !called('studio_probe')) chunks = toolChunks('studio_probe', {...scope, text: envelope.text.slice(0, 1000)});
      else if (checkpointCount === 1) chunks = toolChunks('studio_memory_checkpoint', {summary: docker ? '容器代码已执行，result.json 已读取；下一步报告。' : '无副作用探针已完成；下一步报告。', content: JSON.stringify({...scope, phase: 'executed', next: 'report', evidence: docker ? ['result.json', 'node studio-demo.mjs'] : [`studio_probe:${envelope.attemptId}`]}), expectedVersion: checkpoint?.version});
      else chunks = toolChunks('studio_report', {...scope, text: docker ? `Worker 已在隔离容器中运行 node studio-demo.mjs，并读取实际产物 result.json：${String(result('studio_file_read')?.content).slice(0, 1800)}` : `Worker 已完成任务 ${envelope.taskId?.slice(0, 8)} 的无副作用探针：${envelope.text.slice(0, 200)}。模型 ${options.model}，推理等级 ${options.reasoningEffort ?? '默认'}。`, evidence: docker ? [`workspace:${envelope.attemptId}:result.json`] : [`studio_probe:${envelope.attemptId}`]});
    } else {
      const manager = role === 'orchestrator' && (envelope.targetManagerId || mode === 'hierarchical' || (mode === 'auto' && (envelope.text.length >= 80 || /复杂|多个|拆分|parallel/i.test(envelope.text))));
      const source = envelope.memorySources?.find(candidate => candidate.role === (manager ? 'manager' : 'worker'));
      chunks = toolChunks('studio_delegate', { taskId: envelope.taskId, role: manager ? 'manager' : 'worker', prompt: envelope.text.slice(0, 8000), ...(envelope.targetManagerId && manager ? { agentId: envelope.targetManagerId } : source ? {memorySourceAgentId: source.agentId, templateId: source.templateId} : {}) });
    }
    for (const chunk of chunks) { options.signal?.throwIfAborted(); yield chunk; }
  }
}
