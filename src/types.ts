/** Public application and Web types; model sessions and business tasks have distinct state. */
import type { MemoryListInput, MemoryService } from './memory.js';
import type { DockerExecution, ExecutionConfigInput } from './execution.js';
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic';
import type { DramaProject } from './drama-store.js';
import type { StudioStore } from './store.js';
export type Role = 'orchestrator' | 'manager' | 'worker';
export type ExecutionMode = 'auto' | 'direct' | 'hierarchical';
export interface ModelSelection { provider: string; model: string; reasoningEffort?: string }
export interface ModelOption { provider: string; model: string; name: string; efforts: {id: string; name: string}[]; demo: boolean }
export interface AgentTemplate { id: string; name: string; role: Role; systemPrompt: string; selection: ModelSelection; version: number; memoryIdentityId: string }
export interface AgentView { effectiveTools?:string[]; runtimePolicy?:string; dramaSkills?: DramaSkillReference[]; delegateIds?: string[];  id: string; runId: string; parentId: string | null; createdBy: string | null; templateId: string; name: string; role: Role; selection: ModelSelection; systemPrompt: string; status: string; sessionId: string; memoryIdentityId?: string; memorySourceAgentId?: string; createdAt: string; lastResult?: string; error?: string }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; createdAt: string }
export type TaskStatus = 'queued' | 'running' | 'paused' | 'review' | 'completed' | 'blocked' | 'failed' | 'cancelled';
export interface DramaSkillReference { id: string; version: number; name: string; summary: string }
export interface DramaTaskScope { projectId: string; nodeRunId: string; agentId: string; publicNetworkGrantId?: string; skills?: DramaSkillReference[] }
export interface TaskView { pauseOwners?:string[]; parentTaskId?: string; assignedAgentId?: string; childTaskIds?: string[]; reviewNote?: string; verdict?: 'reject';  id: string; runId: string; title: string; prompt: string; requestId: string; coordinatorId: string; targetManagerId?: string; status: TaskStatus; latestAttemptId?: string; result?: string; error?: string; drama?: DramaTaskScope; pauseRequested?: boolean; createdAt: string; updatedAt: string }
export type AttemptStatus = 'queued' | 'running' | 'paused' | 'reported' | 'interrupted' | 'failed' | 'cancelled';
export interface AttemptView { id: string; taskId: string; workerId: string; number: number; status: AttemptStatus; createdAt: string; startedAt?: string; endedAt?: string; summary?: string; evidence?: string[]; error?: string }
export interface DeliveryView { id: string; runId: string; agentId: string; taskId?: string; kind: 'task' | 'review' | 'result' | 'message'; attemptId?: string; text: string; state: 'pending' | 'running' | 'done' | 'failed' | 'cancelled'; failures: number; nextAt: number; createdAt: string; error?: string; recovery?: boolean; requestId?: string }
export interface RunView { id: string; title: string; mode: ExecutionMode; orchestratorId: string; memorySourceRunId?: string; dramaProjectId?: string; status: string; createdAt: string; agents: AgentView[]; messages: ChatMessage[]; tasks: TaskView[]; attempts: AttemptView[]; deliveries: DeliveryView[] }
export interface Activity { id: string; runId: string; agentId?: string; taskId?: string; kind: string; text: string; createdAt: string }
export interface SchedulerConfig { maxActiveWorkers: number; pollIntervalMs: number; maxDeliveryAttempts: number; retryDelayMs: number }
export interface StudioSnapshot { phase: 3; backend: 'dsh'; demo: boolean; templates: AgentTemplate[]; models: ModelOption[]; runs: RunView[]; activity: Activity[]; capabilities: {execution: 'docker'|'probe-only'; memory: 'sqlite-three-layer'; containers: 'enabled'|'disabled'; trustedTools: 'planned'; tasks: 'durable'; scheduling: 'non-preemptive'}; scheduler: SchedulerConfig; compatibility: {dshVersion: string; source?: string} }
export interface DramaNetworkRequest { projectId: string; taskId: string; attemptId: string; agentId: string; grantId: string; operation: 'fetch' | 'search'; value: string; signal?: AbortSignal }
export interface DramaSkillRequest { projectId: string; taskId: string; attemptId: string; agentId: string; skillId: string; version: number }
export interface DramaRuleInput { selection: ModelSelection; rule: string; content: string; signal?: AbortSignal }
export interface DramaRuleResult { status: 'passed' | 'failed' | 'unknown'; reason: string }
export type DramaWorker = Pick<AgentTemplate, 'id' | 'name' | 'version' | 'selection' | 'systemPrompt'> & {role?:Role; delegateIds?:string[]; skillIds?:string[]};
export interface DramaDispatchInput { runId: string; projectId: string; nodeRunId: string; requestId: string; prompt: string; worker: DramaWorker; publicNetworkGrantId?: string; skills?: DramaSkillReference[] }
export interface StudioDrama {
  store: StudioStore;
  archiveProject(projectId: string): DramaProject;
  deleteArchivedProject(projectId: string, archivedAt: string): Promise<void>;
  refreshModels(): Promise<ModelOption[]>;
  configuredTools(agent:{role:Role;publicNetwork:boolean;skillIds:string[];retired:boolean}):string[];
  createRun(input: {projectId: string; title: string; purpose?:'editor'|'node'|'dispatch'; skills?:DramaSkillReference[]; fallbackSelection?: ModelSelection; orchestrator?: AgentTemplate & {delegateIds?:string[]}}): RunView;
  dispatch(input: DramaDispatchInput): TaskView;
  history(projectId:string,taskId:string,offset:number):Promise<{events:import('./drama-protocol.js').VisibleDramaEvent[];nextOffset?:number}>;
  retryChild(runId:string,taskId:string):TaskView;
  pause(runId: string, taskId: string): TaskView;
  resume(runId: string, taskId: string): TaskView;
  postEditor(input: {runId: string; projectId: string; requestId: string; mode: 'message'|'task'; text: string}): void;
  probeModel(selection: ModelSelection, signal?: AbortSignal): Promise<{status: 'verified'|'demo'|'unavailable'; message: string}>;
  checkRule(input: DramaRuleInput): Promise<DramaRuleResult>;
}
export interface StudioOptions { dataDir: string; demoModels?: boolean; videoInputRoot?: string; dshHome?: string; onChange?: () => void; scheduler?: Partial<SchedulerConfig>; demoDelayMs?: number; execution?: ExecutionConfigInput; compaction?: BasicCompactionConfig; drama?: boolean; dramaNetwork?: (input: DramaNetworkRequest) => Promise<unknown>; dramaReadSkill?: (input: DramaSkillRequest) => {body: string} }
export interface NewTaskInput { prompt: string; requestId: string; targetManagerId?: string }
export interface Studio {
  /** Local host capability, never registered with model tools. */
  video?: import('./video-pipeline.js').VideoPipeline;
  /** Workbench backend seam sharing the Studio transaction and scheduler. */
  drama?: StudioDrama;
  snapshot(): Promise<StudioSnapshot>;
  saveTemplate(input: Omit<AgentTemplate, 'version' | 'memoryIdentityId'> & {version?: number}): Promise<AgentTemplate>;
  createRun(input: {prompt: string; mode: ExecutionMode; orchestratorTemplateId?: string; reuseMemoryFromRunId?: string}): Promise<RunView>;
  listMemory(runId: string, input: MemoryListInput): Promise<ReturnType<MemoryService['list']>>;
  readMemory(runId: string, input: {id: string; offset?: number; limit?: number}): Promise<ReturnType<MemoryService['read']>>;
  listArtifacts(runId: string, attemptId: string, input: {path?: string}): ReturnType<DockerExecution['listFiles']>;
  readArtifact(runId: string, attemptId: string, input: {path: string; offset?: number; limit?: number}): ReturnType<DockerExecution['readFile']>;
  addTask(runId: string, input: NewTaskInput): Promise<TaskView>;
  retryTask(runId: string, taskId: string): Promise<TaskView>;
  cancelTask(runId: string, taskId: string): Promise<void>;
  sendMessage(runId: string, text: string): Promise<void>;
  stopRun(runId: string): Promise<void>;
  close(): Promise<void>;
}
