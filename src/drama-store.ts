/** Project-scoped workbench state on the Studio database. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { assertProjectIdle, collectProjectResources, installProjectDeletion, purgeProject } from './drama-project-lifecycle.js';
import { isPublicSourceUrl } from './drama-network.js';
import type { StudioStore } from './store.js';
import type { ModelSelection, Role } from './types.js';

import { DramaStoreError } from './drama-store-error.js';
export { DramaStoreError } from './drama-store-error.js';

const MIB = 1024 * 1024;
const ORIGINAL_LIMIT = 8 * MIB;
const key = z.string().regex(/^[\w-]{1,100}$/);
const revision = z.number().int().positive();
const label = z.string().trim().min(1).max(200);
const description = z.string().max(4000).default('');
const namedEdit = { id: key.optional(), expectedVersion: revision.optional(), name: label };
const skillSchema = z.object({...namedEdit, summary:z.string().trim().min(1).max(600), body:z.string().min(1).max(24_000)});
const nodeSchema = z.object({
  id: key,
  title: label,
  agentId: key,
  instruction: z.string().default(''),
  inputRule: z.string().default(''),
  outputRule: z.string().default(''),
  release: z.enum(['manual', 'auto']).default('manual'),
  x: z.number(),
  y: z.number(),
});
const graphFields = {
  nodes: z.array(nodeSchema),
  edges: z.array(z.object({from: key, to: key})),
};
const graphSchema = z.object(graphFields);
// An unassigned node can be placed on a draft before the user chooses its Agent.
export const canvasDraftGraph = graphSchema.extend({nodes: z.array(nodeSchema.extend({agentId: key.or(z.literal(''))}))});
const projectSchema = z.object({name: label, description, editorAgentId: key.optional(), templateId: key.optional(), templateVersion: revision.optional()});
const templateSchema = z.object({...namedEdit, description, ...graphFields});
const agentSchema = z.object({
  ...namedEdit,
  role: z.enum(['orchestrator', 'manager', 'worker']).optional(),
  systemPrompt: z.string().optional(),
  selection: z.object({provider: label, model: z.string().trim().min(1).max(300), reasoningEffort: label.optional()}),
  publicNetwork: z.boolean().optional(),
  skillIds: z.array(key).max(12).optional(),
  delegateIds: z.array(key).max(64).optional(),
  retired: z.boolean().optional(),
});
const documentSchema = z.object({
  ...namedEdit,
  kind: z.enum(['reference', 'episode']).optional(),
  content: z.string(),
  episode: z.number().int().positive().max(10000).optional(),
  scene: z.string().trim().min(1).max(200).optional(),
  field: z.string().trim().min(1).max(200).optional(),
  source: z.union([label, z.object({name: label, mime: z.string().max(100).optional(), base64: z.string().min(1).max(Math.ceil(ORIGINAL_LIMIT / 3) * 4)})]).optional(),
});
const commentSchema = z.object({
  documentId: key,
  version: revision,
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  selectedText: z.string().min(1).max(4000),
  text: z.string().trim().min(1).max(4000),
});
const networkSourceSchema = z.object({
  provider: z.string().max(180).optional(),
  title: z.string().trim().min(1).max(400),
  url: z.string().max(2048).refine(isPublicSourceUrl),
  retrievedAt: z.string().max(60).refine(value => Number.isFinite(Date.parse(value))),
  excerpt: z.string().max(12000),
});

export type DramaNode = z.output<typeof nodeSchema>;
export type DramaGraphData = z.output<typeof graphSchema>;
export interface DramaGraph extends DramaGraphData { projectId: string; version: number }
export interface DramaProject {
  id: string;
  name: string;
  description: string;
  graphVersion: number;
  archivedAt?: string;
  deleting?: boolean;
  editorAgentId?: string;
  templateId?: string;
  templateVersion?: number;
  createdAt: string;
  updatedAt: string;
}
export interface DramaTemplate extends DramaGraphData {
  id: string;
  version: number;
  name: string;
  description: string;
  retired: boolean;
}
interface TemplateVersionSummary {
  version: number;
  name: string;
  description: string;
  nodeCount: number;
  edgeCount: number;
}
export interface DramaAgent {
  id: string;
  version: number;
  name: string;
  role: Role;
  systemPrompt: string;
  selection: ModelSelection;
  publicNetwork: boolean;
  skillIds: string[];
  delegateIds: string[];
  retired: boolean;
}
export interface DramaSkillSummary { id:string; version:number; name:string; summary:string; retired:boolean }
export interface DramaSkill extends DramaSkillSummary { body:string }
export interface DramaNetworkGrant { id: string; agentId: string; grantedAt: string }
export type DramaNetworkSource = z.output<typeof networkSourceSchema>;
export interface DramaNetworkAuditInput {
  projectId: string;
  taskId: string;
  attemptId: string;
  agentId: string;
  grantId: string;
  operation: 'fetch' | 'search';
  outcome: 'allowed' | 'denied' | 'failed';
  sources?: readonly unknown[];
}
export interface DramaDocumentSource { name: string; mime?: string; sha256?: string; bytes?: number }
export interface DramaDocument {
  id: string;
  projectId: string;
  version: number;
  name: string;
  kind: 'reference' | 'episode';
  content: string;
  episode?: number;
  scene?: string;
  field?: string;
  source?: DramaDocumentSource;
  updatedAt: string;
}
export interface DramaEpisodeComment extends z.output<typeof commentSchema> {
  id: string;
  projectId: string;
  createdAt: string;
}

function parsed<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const field = result.error.issues[0]?.path.join('.');
  throw new DramaStoreError(400, field ? `字段「${field}」无效` : '请求内容无效');
}

function checkVersion(actual: number, expected: number | undefined): void {
  if (actual !== expected) throw new DramaStoreError(409, `版本已变更，请刷新后重试（当前版本 ${actual}）`);
}

function contentHash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

export function verifyGraph(graph: DramaGraphData): void {
  const children = new Map(graph.nodes.map(node => [node.id, new Set<string>()]));
  if (children.size !== graph.nodes.length) throw new DramaStoreError(400, '画布中有重复的节点 ID');
  const degrees = new Map(graph.nodes.map(node => [node.id, 0]));
  for (const {from, to} of graph.edges) {
    const targets = children.get(from);
    const degree = degrees.get(to);
    if (!targets || degree === undefined) throw new DramaStoreError(400, '连线引用了不存在的节点');
    if (targets.has(to)) throw new DramaStoreError(400, '画布中有重复的连线');
    targets.add(to);
    degrees.set(to, degree + 1);
  }
  const ready = graph.nodes.filter(node => degrees.get(node.id) === 0).map(node => node.id);
  for (let i = 0; i < ready.length; i++) {
    for (const target of children.get(ready[i]!)!) {
      const degree = degrees.get(target)! - 1;
      degrees.set(target, degree);
      if (degree === 0) ready.push(target);
    }
  }
  if (ready.length !== graph.nodes.length) throw new DramaStoreError(400, '画布连线不能形成环');
}

export class DramaStore {
  /** `ownerId` is derived by the host, never supplied by a workbench request. */
  constructor(private readonly store: StudioStore, readonly ownerId = 'local-owner') {
    store.atomic(() => {
      store.db.exec('CREATE TABLE IF NOT EXISTS drama_schema(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)');
      const schema = store.db.prepare('SELECT version FROM drama_schema WHERE id=1').get();
      if (schema?.version === 4) return;
      if (schema?.version === 3) { installProjectDeletion(store); return; }
      if (schema && schema.version !== 1 && schema.version !== 2) throw new Error(`Unsupported drama storage version ${schema.version}`);
      if (!schema) {
        store.db.exec(`
        CREATE TABLE drama_projects(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, version INTEGER NOT NULL, document TEXT NOT NULL);
        CREATE INDEX drama_projects_owner ON drama_projects(owner_id);
        CREATE TABLE drama_graphs(project_id TEXT NOT NULL REFERENCES drama_projects(id), version INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(project_id, version));
        CREATE TABLE drama_templates(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, version INTEGER NOT NULL, retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1)));
        CREATE INDEX drama_templates_owner ON drama_templates(owner_id);
        CREATE TABLE drama_template_versions(template_id TEXT NOT NULL REFERENCES drama_templates(id), version INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(template_id, version));
        CREATE TABLE drama_agents(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, version INTEGER NOT NULL);
        CREATE INDEX drama_agents_owner ON drama_agents(owner_id);
        CREATE TABLE drama_agent_versions(agent_id TEXT NOT NULL REFERENCES drama_agents(id), version INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(agent_id, version));
        CREATE TABLE drama_network_grants(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES drama_agents(id), actor_id TEXT NOT NULL, granted_at TEXT NOT NULL, revoked_at TEXT);
        CREATE UNIQUE INDEX drama_agent_active_grant ON drama_network_grants(agent_id) WHERE revoked_at IS NULL;
        CREATE TABLE drama_documents(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES drama_projects(id), version INTEGER NOT NULL);
        CREATE INDEX drama_documents_project ON drama_documents(project_id);
        CREATE TABLE drama_document_versions(document_id TEXT NOT NULL REFERENCES drama_documents(id), version INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(document_id, version));
        CREATE TABLE drama_episode_comments(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES drama_projects(id), document_id TEXT NOT NULL, version INTEGER NOT NULL, document TEXT NOT NULL,
          FOREIGN KEY(document_id, version) REFERENCES drama_document_versions(document_id, version));
        CREATE INDEX drama_comments_project ON drama_episode_comments(project_id);
        INSERT INTO drama_schema VALUES (1,1);
      `);
        for (const table of ['drama_graphs', 'drama_template_versions', 'drama_agent_versions', 'drama_document_versions', 'drama_episode_comments']) {
          for (const action of ['UPDATE', 'DELETE']) {
            store.db.exec(`CREATE TRIGGER ${table}_no_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'Drama revisions are immutable'); END;`);
          }
        }
      }
      if (schema?.version !== 2) store.db.exec(`
        CREATE TABLE drama_network_audit(
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES drama_projects(id),
          task_id TEXT NOT NULL REFERENCES tasks(id),
          attempt_id TEXT NOT NULL REFERENCES attempts(id),
          agent_id TEXT NOT NULL REFERENCES drama_agents(id),
          grant_id TEXT NOT NULL REFERENCES drama_network_grants(id),
          operation TEXT NOT NULL CHECK(operation IN ('search','fetch')),
          outcome TEXT NOT NULL CHECK(outcome IN ('allowed','denied','failed')),
          sources TEXT NOT NULL CHECK(json_valid(sources) AND json_type(sources)='array'),
          created_at TEXT NOT NULL
        );
        CREATE INDEX drama_network_audit_attempt ON drama_network_audit(project_id,task_id,attempt_id);
        CREATE TRIGGER drama_network_audit_no_update BEFORE UPDATE ON drama_network_audit BEGIN SELECT RAISE(ABORT,'Drama audit rows are immutable'); END;
        CREATE TRIGGER drama_network_audit_no_delete BEFORE DELETE ON drama_network_audit BEGIN SELECT RAISE(ABORT,'Drama audit rows are immutable'); END;
        UPDATE drama_schema SET version=2 WHERE id=1;
      `);
      store.db.exec(`
        CREATE TABLE drama_skills(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, version INTEGER NOT NULL, retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1)));
        CREATE INDEX drama_skills_owner ON drama_skills(owner_id);
        CREATE TABLE drama_skill_versions(skill_id TEXT NOT NULL REFERENCES drama_skills(id), version INTEGER NOT NULL, name TEXT NOT NULL, summary TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(skill_id,version));
        CREATE TRIGGER drama_skill_versions_no_update BEFORE UPDATE ON drama_skill_versions BEGIN SELECT RAISE(ABORT,'Drama revisions are immutable'); END;
        CREATE TRIGGER drama_skill_versions_no_delete BEFORE DELETE ON drama_skill_versions BEGIN SELECT RAISE(ABORT,'Drama revisions are immutable'); END;
        UPDATE drama_schema SET version=3 WHERE id=1;
      `);
      installProjectDeletion(store);
    });
  }

  listProjects(archived = false): DramaProject[] {
    return this.store.db.prepare(`SELECT document FROM drama_projects WHERE owner_id=?
      AND (json_extract(document,'$.archivedAt') IS NOT NULL)=? ORDER BY rowid DESC`)
      .all(this.ownerId, Number(archived)).map(row => JSON.parse(String(row.document)) as DramaProject);
  }

  private ownedProject(id: string): DramaProject {
    const row = this.store.db.prepare('SELECT document FROM drama_projects WHERE id=? AND owner_id=?').get(id, this.ownerId);
    if (!row) throw new DramaStoreError(404, '作品不存在');
    return JSON.parse(String(row.document)) as DramaProject;
  }

  project(id: string): DramaProject {
    const project = this.ownedProject(id);
    if (project.archivedAt) throw new DramaStoreError(409, '作品已归档，请先恢复作品');
    return project;
  }

  private saveLifecycle(project: DramaProject): DramaProject {
    this.store.db.prepare('UPDATE drama_projects SET document=? WHERE id=? AND owner_id=?')
      .run(JSON.stringify(project), project.id, this.ownerId);
    return project;
  }

  archiveProject(id: string): DramaProject {
    return this.store.atomic(() => {
      const project = this.ownedProject(id);
      if (project.archivedAt) return project;
      assertProjectIdle(this.store, id);
      // A stale delete confirmation must never match a later archive, even within one clock tick.
      const archivedAt = new Date(Math.max(Date.now(), Date.parse(project.updatedAt) + 1)).toISOString();
      return this.saveLifecycle({...project, archivedAt, updatedAt: archivedAt});
    });
  }

  restoreProject(id: string): DramaProject {
    return this.store.atomic(() => {
      const project = this.ownedProject(id);
      if (project.deleting) throw new DramaStoreError(409, '作品已开始永久删除，请继续删除');
      if (!project.archivedAt) return project;
      const {archivedAt, ...restored} = project;
      const updatedAt = new Date(Math.max(Date.now(), Date.parse(archivedAt) + 1)).toISOString();
      return this.saveLifecycle({...restored, updatedAt});
    });
  }

  private confirmedArchive(id: string, archivedAt: string): DramaProject {
    const project = this.ownedProject(id);
    if (!project.archivedAt) throw new DramaStoreError(409, '仅可永久删除已归档作品');
    if (!archivedAt || archivedAt !== project.archivedAt) throw new DramaStoreError(409, '作品归档状态已变化，请重新确认删除');
    return project;
  }

  /** Commit the deletion decision before releasing external resources. A restart can retry using the same archive receipt. */
  beginProjectDeletion(id: string, archivedAt: string) {
    return this.store.atomic(() => {
      const project = this.confirmedArchive(id, archivedAt);
      assertProjectIdle(this.store, id);
      const resources = collectProjectResources(this.store, id);
      if (!project.deleting) this.saveLifecycle({...project, deleting: true});
      return resources;
    });
  }

  deleteProject(id: string, archivedAt: string): void {
    this.store.atomic(() => {
      if (!this.confirmedArchive(id, archivedAt).deleting) throw new DramaStoreError(409, '请先确认永久删除');
      purgeProject(this.store, id);
    });
  }

  private editorConfig(id:string) {
    const agent=this.agent(id);
    if(agent.role!=='orchestrator'||agent.retired) throw new DramaStoreError(400,'请选择可用的总编 Agent');
    return agent;
  }

  bindEditor(projectId:string,agentId:string) {
    return this.store.atomic(()=>{
      const project=this.project(projectId);
      this.editorConfig(agentId);
      if(project.editorAgentId!==agentId && this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='drama_project_sessions'").get()) this.store.db.prepare('DELETE FROM drama_project_sessions WHERE project_id=?').run(projectId);
      const next={...project,editorAgentId:agentId,updatedAt:new Date(Math.max(Date.now(),Date.parse(project.updatedAt))).toISOString()};
      this.store.db.prepare('UPDATE drama_projects SET document=? WHERE id=? AND owner_id=?').run(JSON.stringify(next),projectId,this.ownerId);
      return next;
    });
  }

  createProject(unchecked: unknown): DramaProject {
    const input = parsed(projectSchema, unchecked);
    if (input.templateVersion && !input.templateId) throw new DramaStoreError(400, '请指定模板');
    return this.store.atomic(() => {
      const template = input.templateId ? this.template(input.templateId, input.templateVersion) : undefined;
      if (template?.retired) throw new DramaStoreError(409, '模板已退役');
      const now = new Date().toISOString();
      const candidates=this.listAgents().filter(agent=>agent.role==='orchestrator');
      const editor=input.editorAgentId ? this.editorConfig(input.editorAgentId) : candidates.length===1 ? candidates[0] : undefined;
      const project: DramaProject = {
        ...(editor ? {editorAgentId:editor.id}:{}),
        id: randomUUID(), name: input.name, description: input.description, graphVersion: 1,
        ...(template ? {templateId: template.id, templateVersion: template.version} : {}), createdAt: now, updatedAt: now,
      };
      const graph: DramaGraph = {projectId: project.id, version: 1, nodes: template?.nodes ?? [], edges: template?.edges ?? []};
      this.store.db.prepare('INSERT INTO drama_projects VALUES(?,?,?,?)').run(project.id, this.ownerId, project.graphVersion, JSON.stringify(project));
      this.store.db.prepare('INSERT INTO drama_graphs VALUES(?,?,?)').run(project.id, graph.version, JSON.stringify(graph));
      return project;
    });
  }

  graph(projectId: string, version?: number): DramaGraph {
    const project = this.project(projectId);
    const row = this.store.db.prepare('SELECT document FROM drama_graphs WHERE project_id=? AND version=?').get(project.id, version ?? project.graphVersion);
    if (!row) throw new DramaStoreError(404, '画布版本不存在');
    return JSON.parse(String(row.document)) as DramaGraph;
  }

  previewGraph(unchecked: unknown): DramaGraphData {
    const data = parsed(graphSchema, unchecked);
    this.validateGraph(data);
    return data;
  }

  saveGraph(projectId: string, expectedVersion: number, unchecked: unknown): DramaGraph {
    const data = parsed(graphSchema, unchecked);
    return this.store.atomic(() => {
      const project = this.project(projectId);
      checkVersion(project.graphVersion, expectedVersion);
      this.validateGraph(data);
      const graph: DramaGraph = {projectId, version: project.graphVersion + 1, ...data};
      const updatedProject = {...project, graphVersion: graph.version, updatedAt: new Date(Math.max(Date.now(), Date.parse(project.updatedAt))).toISOString()};
      this.store.db.prepare('INSERT INTO drama_graphs VALUES(?,?,?)').run(projectId, graph.version, JSON.stringify(graph));
      this.store.db.prepare('UPDATE drama_projects SET version=?, document=? WHERE id=?').run(graph.version, JSON.stringify(updatedProject), projectId);
      return graph;
    });
  }

  listTemplates(): DramaTemplate[] {
    return this.store.db.prepare(`SELECT v.document FROM drama_templates t JOIN drama_template_versions v ON v.template_id=t.id AND v.version=t.version
      WHERE t.owner_id=? AND t.retired=0 ORDER BY t.rowid DESC`).all(this.ownerId).map(row => ({...JSON.parse(String(row.document)) as DramaTemplate, retired: false}));
  }

  templateHistory(id: string): {currentVersion: number; versions: TemplateVersionSummary[]} {
    const rows = this.store.db.prepare(`SELECT v.version, json_extract(v.document,'$.name') AS name,
      json_extract(v.document,'$.description') AS description, json_array_length(v.document,'$.nodes') AS nodeCount,
      json_array_length(v.document,'$.edges') AS edgeCount
      FROM drama_templates t JOIN drama_template_versions v ON v.template_id=t.id
      WHERE t.id=? AND t.owner_id=? ORDER BY v.version DESC`).all(id, this.ownerId).map(row => ({
        version:Number(row.version), name:String(row.name), description:String(row.description ?? ''),
        nodeCount:Number(row.nodeCount), edgeCount:Number(row.edgeCount),
      }));
    if (!rows.length) throw new DramaStoreError(404, '模板不存在');
    return {currentVersion: rows[0]!.version, versions: rows};
  }

  template(id: string, version?: number): DramaTemplate {
    const row = this.store.db.prepare(`SELECT t.retired, v.document FROM drama_templates t JOIN drama_template_versions v ON v.template_id=t.id AND v.version=COALESCE(?,t.version)
      WHERE t.id=? AND t.owner_id=?`).get(version ?? null, id, this.ownerId);
    if (!row) throw new DramaStoreError(404, '模板版本不存在');
    return {...JSON.parse(String(row.document)) as DramaTemplate, retired: row.retired === 1};
  }

  saveTemplate(unchecked: unknown): DramaTemplate {
    const {id, expectedVersion, name, description, nodes, edges} = parsed(templateSchema, unchecked);
    return this.store.atomic(() => {
      const previous = id ? this.template(id) : undefined;
      if (previous?.retired) throw new DramaStoreError(409, '模板已退役');
      if (previous || expectedVersion !== undefined) checkVersion(previous?.version ?? 0, expectedVersion);
      this.validateGraph({nodes, edges});
      const template: DramaTemplate = {id: id ?? randomUUID(), version: (previous?.version ?? 0) + 1, name, description, nodes, edges, retired: false};
      if (previous) this.store.db.prepare('UPDATE drama_templates SET version=? WHERE id=?').run(template.version, template.id);
      else this.store.db.prepare('INSERT INTO drama_templates(id,owner_id,version) VALUES(?,?,?)').run(template.id, this.ownerId, template.version);
      this.store.db.prepare('INSERT INTO drama_template_versions VALUES(?,?,?)').run(template.id, template.version, JSON.stringify(template));
      return template;
    });
  }

  retireTemplate(id: string, expectedVersion: number): DramaTemplate {
    return this.store.atomic(() => {
      const template = this.template(id);
      checkVersion(template.version, expectedVersion);
      this.store.db.prepare('UPDATE drama_templates SET retired=1 WHERE id=?').run(id);
      return {...template, retired: true};
    });
  }

  listAgents(includeRetired=false): DramaAgent[] {
    return this.store.db.prepare(`SELECT v.document, g.id AS grant_id FROM drama_agents a JOIN drama_agent_versions v ON v.agent_id=a.id AND v.version=a.version
      LEFT JOIN drama_network_grants g ON g.agent_id=a.id AND g.revoked_at IS NULL WHERE a.owner_id=? ORDER BY a.rowid DESC`).all(this.ownerId)
      .map(row => this.agentView(row)).filter(agent=>includeRetired || !agent.retired);
  }

  private agentView(row:{document?:unknown;grant_id?:unknown}): DramaAgent {
    const agent = JSON.parse(String(row.document)) as DramaAgent;
    return {...agent, retired:agent.retired??false, delegateIds:agent.delegateIds??[], skillIds:agent.skillIds??[], publicNetwork:Boolean(row.grant_id)};
  }

  agent(id: string, version?: number): DramaAgent {
    const row = this.store.db.prepare(`SELECT v.document, g.id AS grant_id FROM drama_agents a JOIN drama_agent_versions v ON v.agent_id=a.id AND v.version=COALESCE(?,a.version)
      LEFT JOIN drama_network_grants g ON g.agent_id=a.id AND g.revoked_at IS NULL WHERE a.id=? AND a.owner_id=?`).get(version ?? null, id, this.ownerId);
    if (!row) throw new DramaStoreError(404, 'Agent 版本不存在');
    return this.agentView(row);
  }

  saveAgent(unchecked: unknown): DramaAgent {
    const input = parsed(agentSchema, unchecked);
    return this.store.atomic(() => {
      const previous = input.id ? this.agent(input.id) : undefined;
      if (previous || input.expectedVersion !== undefined) checkVersion(previous?.version ?? 0, input.expectedVersion);
      const role = input.role ?? previous?.role ?? 'worker';
      if (previous && previous.role !== role) throw new DramaStoreError(400, '请选择或新建对应角色的 Agent');
      const retired=input.retired ?? previous?.retired ?? false;
      const enabled = !retired && (input.publicNetwork ?? previous?.publicNetwork ?? false);
      const delegateIds=[...new Set(input.delegateIds ?? previous?.delegateIds ?? [])];
      for(const id of delegateIds) {
        const child=this.agent(id);
        if(role==='worker'||child.role==='orchestrator'||(role==='manager'&&child.role!=='worker')||id===input.id) throw new DramaStoreError(400,'此角色不能委派给所选 Agent');
        if(child.retired&&!previous?.delegateIds.includes(child.id)) throw new DramaStoreError(409,'不能新增已退役的委派对象');
      }
      if (enabled && role !== 'worker') throw new DramaStoreError(400, '公开网络权限只适用于 Worker');
      const skillIds = [...new Set(input.skillIds ?? previous?.skillIds ?? [])];
      if (input.skillIds) for (const id of skillIds) {
        const skill=this.skill(id);
        if (skill.retired && !previous?.skillIds.includes(id)) throw new DramaStoreError(409, '不能绑定已退役的 Skill');
      }
      const agent: DramaAgent = {
        id: input.id ?? randomUUID(), version: (previous?.version ?? 0) + 1, name: input.name, role,
        systemPrompt: input.systemPrompt ?? previous?.systemPrompt ?? '', selection: input.selection, publicNetwork: enabled, skillIds, delegateIds, retired,
      };
      if (previous) this.store.db.prepare('UPDATE drama_agents SET version=? WHERE id=?').run(agent.version, agent.id);
      else this.store.db.prepare('INSERT INTO drama_agents VALUES(?,?,?)').run(agent.id, this.ownerId, agent.version);
      const {publicNetwork, ...configuration} = agent;
      this.store.db.prepare('INSERT INTO drama_agent_versions VALUES(?,?,?)').run(agent.id, agent.version, JSON.stringify(configuration));
      if (publicNetwork && !previous?.publicNetwork) {
        this.store.db.prepare('INSERT INTO drama_network_grants(id,agent_id,actor_id,granted_at) VALUES(?,?,?,?)').run(randomUUID(), agent.id, this.ownerId, new Date().toISOString());
      }
      if (!publicNetwork && previous?.publicNetwork) {
        this.store.db.prepare('UPDATE drama_network_grants SET revoked_at=? WHERE agent_id=? AND revoked_at IS NULL').run(new Date().toISOString(), agent.id);
      }
      return agent;
    });
  }

  listSkills(): DramaSkillSummary[] {
    const rows=this.store.db.prepare(`SELECT s.id,s.retired,v.version,v.name,v.summary FROM drama_skills s JOIN drama_skill_versions v ON v.skill_id=s.id AND v.version=s.version
      WHERE s.owner_id=? ORDER BY s.rowid DESC`).all(this.ownerId);
    return rows.map(row=>({id:String(row.id),version:Number(row.version),name:String(row.name),summary:String(row.summary),retired:Boolean(row.retired)}));
  }

  skill(id:string,version?:number): DramaSkill {
    const row=this.store.db.prepare(`SELECT s.retired,v.version,v.name,v.summary,v.body FROM drama_skills s JOIN drama_skill_versions v ON v.skill_id=s.id AND v.version=COALESCE(?,s.version)
      WHERE s.id=? AND s.owner_id=?`).get(version??null,id,this.ownerId);
    if(!row) throw new DramaStoreError(404,'Skill 版本不存在');
    return {id,version:Number(row.version),name:String(row.name),summary:String(row.summary),body:String(row.body),retired:Boolean(row.retired)};
  }

  saveSkill(unchecked:unknown): DramaSkill {
    const input=parsed(skillSchema,unchecked);
    if(!input.body.trim()) throw new DramaStoreError(400,'请填写 Skill 正文');
    return this.store.atomic(()=>{
      const previous=input.id?this.skill(input.id):undefined;
      if(previous?.retired) throw new DramaStoreError(409,'Skill 已退役');
      if(previous||input.expectedVersion!==undefined) checkVersion(previous?.version??0,input.expectedVersion);
      const id=input.id??randomUUID(),version=(previous?.version??0)+1;
      if(previous) this.store.db.prepare('UPDATE drama_skills SET version=? WHERE id=?').run(version,id);
      else this.store.db.prepare('INSERT INTO drama_skills(id,owner_id,version) VALUES(?,?,?)').run(id,this.ownerId,version);
      this.store.db.prepare('INSERT INTO drama_skill_versions VALUES(?,?,?,?,?)').run(id,version,input.name,input.summary,input.body);
      return {id,version,name:input.name,summary:input.summary,body:input.body,retired:false};
    });
  }

  retireSkill(id:string,expectedVersion:number): DramaSkillSummary {
    return this.store.atomic(()=>{
      const {body:_body,...skill}=this.skill(id);
      checkVersion(skill.version,expectedVersion);
      this.store.db.prepare('UPDATE drama_skills SET retired=1 WHERE id=?').run(id);
      return {...skill,retired:true};
    });
  }

  /** Pin enabled metadata; execution reads exact versions with the bound Task. */
  snapshotSkills(skillIds:readonly string[] = []): Omit<DramaSkillSummary,'retired'>[] {
    const skills=new Map(this.listSkills().map(skill=>[skill.id,skill]));
    return skillIds.flatMap(id=>{
      const skill=skills.get(id);
      if(!skill||skill.retired) return [];
      const {retired:_retired,...ref}=skill;
      return [ref];
    });
  }

  /** Return the live grant to bind before execution starts. */
  networkGrant(agentId: string): DramaNetworkGrant | undefined {
    const row = this.store.db.prepare(`SELECT g.id, g.granted_at FROM drama_network_grants g JOIN drama_agents a ON a.id=g.agent_id
      WHERE a.id=? AND a.owner_id=? AND g.revoked_at IS NULL`).get(agentId, this.ownerId);
    return row && {id: String(row.id), agentId, grantedAt: String(row.granted_at)};
  }

  /** Check the exact bound grant. Reopening a grant never resumes older executions. */
  networkAllowed(agentId: string, grantId: string | undefined): boolean {
    return grantId !== undefined && this.networkGrant(agentId)?.id === grantId;
  }

  /** Keep source evidence and the result of the call without storing the requested keyword or URL. */
  recordNetworkCall(input: DramaNetworkAuditInput): void {
    this.project(input.projectId);
    const scope = this.store.task(input.taskId)?.drama;
    const attempt = this.store.attempt(input.attemptId);
    if (scope?.projectId !== input.projectId || scope.agentId !== input.agentId || scope.publicNetworkGrantId !== input.grantId || attempt?.taskId !== input.taskId) {
      throw new DramaStoreError(404, '联网记录不属于此执行');
    }
    const sources: DramaNetworkSource[] = [];
    if (input.outcome === 'allowed') {
      for (const value of input.sources?.slice(0, 5) ?? []) {
        const parsedSource = networkSourceSchema.safeParse(value);
        if (parsedSource.success) sources.push(parsedSource.data);
      }
    }
    this.store.db.prepare('INSERT INTO drama_network_audit VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), input.projectId, input.taskId, input.attemptId, input.agentId, input.grantId, input.operation, input.outcome, JSON.stringify(sources), new Date().toISOString());
  }

  networkSources(projectId: string, taskId: string, attemptId: string): DramaNetworkSource[] {
    this.project(projectId);
    const rows = this.store.db.prepare(`SELECT sources FROM drama_network_audit WHERE project_id=? AND task_id=? AND attempt_id=? AND outcome='allowed'
      ORDER BY rowid`).all(projectId, taskId, attemptId);
    const sources = new Map<string, DramaNetworkSource>();
    for (const row of rows) {
      for (const source of JSON.parse(String(row.sources)) as DramaNetworkSource[]) sources.set(JSON.stringify(source), source);
    }
    return [...sources.values()];
  }

  listDocuments(projectId: string): DramaDocument[] {
    this.project(projectId);
    return this.store.db.prepare(`SELECT v.document FROM drama_documents d JOIN drama_document_versions v ON v.document_id=d.id AND v.version=d.version
      WHERE d.project_id=? ORDER BY d.rowid DESC`).all(projectId).map(row => JSON.parse(String(row.document)) as DramaDocument);
  }

  document(projectId: string, id: string, version?: number): DramaDocument {
    this.project(projectId);
    const row = this.store.db.prepare(`SELECT v.document FROM drama_documents d JOIN drama_document_versions v ON v.document_id=d.id AND v.version=COALESCE(?,d.version)
      WHERE d.project_id=? AND d.id=?`).get(version ?? null, projectId, id);
    if (!row) throw new DramaStoreError(404, '资料版本不存在');
    return JSON.parse(String(row.document)) as DramaDocument;
  }

  saveDocument(projectId: string, unchecked: unknown): DramaDocument {
    const input = parsed(documentSchema, unchecked);
    return this.store.atomic(() => {
      this.project(projectId);
      const previous = input.id ? this.document(projectId, input.id) : undefined;
      if (previous || input.expectedVersion !== undefined) checkVersion(previous?.version ?? 0, input.expectedVersion);
      const kind = input.kind ?? previous?.kind ?? 'reference';
      const episode = input.episode ?? previous?.episode;
      const scene = input.scene ?? previous?.scene;
      const field = input.field ?? previous?.field;
      if (kind === 'episode' ? !episode : episode !== undefined || scene !== undefined || field !== undefined) throw new DramaStoreError(400, '分集资料需要有效的集号');
      const source = input.source === undefined ? previous?.source : this.saveDocumentSource(projectId, input.source);
      const document: DramaDocument = {
        id: input.id ?? randomUUID(), projectId, version: (previous?.version ?? 0) + 1, name: input.name,
        kind, content: input.content, ...(episode ? {episode, scene, field} : {}), ...(source ? {source} : {}), updatedAt: new Date().toISOString(),
      };
      if (previous) this.store.db.prepare('UPDATE drama_documents SET version=? WHERE id=?').run(document.version, document.id);
      else this.store.db.prepare('INSERT INTO drama_documents VALUES(?,?,?)').run(document.id, projectId, document.version);
      this.store.db.prepare('INSERT INTO drama_document_versions VALUES(?,?,?)').run(document.id, document.version, JSON.stringify(document));
      return document;
    });
  }

  /** Recheck sealed bytes before returning them for an authenticated download. */
  readDocumentSource(projectId: string, id: string, version?: number): {name: string; mime: string; bytes: Buffer} {
    const doc = this.document(projectId, id, version);
    const source = doc.source;
    if (!source?.sha256 || !/^[a-f0-9]{64}$/.test(source.sha256)) throw new DramaStoreError(404, '没有可下载的原件');
    const path = join(this.store.dataDir, 'drama-blobs', projectId, source.sha256);
    if (!existsSync(path)) throw new DramaStoreError(409, '资料原件丢失');
    const bytes = readFileSync(path);
    if (bytes.length !== source.bytes || contentHash(bytes) !== source.sha256) throw new DramaStoreError(409, '资料原件校验失败');
    return {name: source.name, mime: source.mime ?? 'application/octet-stream', bytes};
  }

  addEpisodeComment(projectId: string, unchecked: unknown): DramaEpisodeComment {
    const input = parsed(commentSchema, unchecked);
    return this.store.atomic(() => {
      const document = this.document(projectId, input.documentId);
      checkVersion(document.version, input.version);
      if (document.kind !== 'episode' || input.end <= input.start || input.end > document.content.length || document.content.slice(input.start, input.end) !== input.selectedText) {
        throw new DramaStoreError(400, '选区与分集原文不一致');
      }
      const comment: DramaEpisodeComment = {...input, id: randomUUID(), projectId, createdAt: new Date().toISOString()};
      this.store.db.prepare('INSERT INTO drama_episode_comments VALUES(?,?,?,?,?)').run(comment.id, projectId, comment.documentId, comment.version, JSON.stringify(comment));
      return comment;
    });
  }

  listEpisodeComments(projectId: string): DramaEpisodeComment[] {
    this.project(projectId);
    return this.store.db.prepare('SELECT document FROM drama_episode_comments WHERE project_id=? ORDER BY rowid DESC').all(projectId)
      .map(row => JSON.parse(String(row.document)) as DramaEpisodeComment);
  }

  private validateGraph(graph: DramaGraphData): void {
    verifyGraph(graph);
    for (const agentId of new Set(graph.nodes.map(node => node.agentId))) {
      if (this.agent(agentId).retired) throw new DramaStoreError(400, '节点引用的 Agent 已退役，请重新选择');
    }
  }

  private saveDocumentSource(projectId: string, input: NonNullable<z.output<typeof documentSchema>['source']>): DramaDocumentSource {
    if (typeof input === 'string') return {name: input};
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)) throw new DramaStoreError(400, '原件编码无效');
    const bytes = Buffer.from(input.base64, 'base64');
    if (bytes.length === 0 || bytes.length > ORIGINAL_LIMIT || bytes.toString('base64') !== input.base64) throw new DramaStoreError(400, '原件编码无效或超过 8 MiB');
    const sha256 = contentHash(bytes);
    const directory = join(this.store.dataDir, 'drama-blobs', projectId);
    const target = join(directory, sha256);
    mkdirSync(directory, {recursive: true, mode: 0o700});
    if (existsSync(target)) {
      if (contentHash(readFileSync(target)) !== sha256) throw new DramaStoreError(409, '已存在的原件校验失败');
    } else {
      const staged = mkdtempSync(join(directory, '.staged-'));
      try {
        const file = join(staged, 'source');
        const handle = openSync(file, 'wx', 0o600);
        try { writeFileSync(handle, bytes); fsyncSync(handle); }
        finally { closeSync(handle); }
        renameSync(file, target);
        const folder = openSync(directory, 'r');
        try { fsyncSync(folder); }
        finally { closeSync(folder); }
      } finally { rmSync(staged, {recursive: true, force: true}); }
    }
    const mime = input.mime && /^[\w.+-]+\/[\w.+-]+$/.test(input.mime) ? input.mime : 'application/octet-stream';
    return {name: input.name, mime, sha256, bytes: bytes.length};
  }
}
