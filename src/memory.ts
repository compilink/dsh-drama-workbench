/** Three-level memory with authorization before metadata, search, counts and content are disclosed. */
import { randomUUID } from 'node:crypto';
import { StudioStore } from './store.js';
import type { StoredAgent } from './store.js';

export type MemoryLayer = 'long' | 'medium' | 'short';
export type MemoryVisibility = 'private' | 'public';
export interface MemorySummary {
  id: string; version: number; layer: MemoryLayer; visibility: MemoryVisibility; kind: 'note' | 'checkpoint';
  ownerAgentId: string; runId?: string; taskId?: string; title: string; summary: string; tags: string[]; updatedAt: string;
}
export interface MemoryListInput { layer?: MemoryLayer; query?: string; ownerAgentId?: string; taskId?: string; limit?: number; offset?: number }
export interface MemoryList { items: MemorySummary[]; total: number; nextOffset?: number }
export interface MemoryWriteInput { id?: string; expectedVersion?: number; layer: MemoryLayer; title: string; summary: string; content: string; tags?: string[]; taskId?: string }
export interface MemoryCheckpointInput { taskId?: string; title?: string; summary: string; content: string; expectedVersion?: number }
export interface MemoryPage { entry: MemorySummary; content: string; offset: number; totalCharacters: number; nextOffset?: number }
export interface MemoryEntrypoint { layers: {layer: MemoryLayer; count: number}[]; checkpoint?: MemorySummary }
type ProjectMemoryRow = MemoryRow & {owner_name:string};

interface MemoryRow {
  id: string; owner_agent_id: string; owner_identity_id: string; layer: MemoryLayer; visibility: MemoryVisibility;
  kind: 'note' | 'checkpoint'; run_id: string | null; task_id: string | null; title: string; summary: string;
  content: string; tags: string; version: number; created_at: string; updated_at: string;
}
type Parameter = string | number | null;
interface Predicate { sql: string; values: Parameter[] }
const LAYERS: MemoryLayer[] = ['long', 'medium', 'short'];
const unavailable = () => new Error('Memory is unavailable');
const metadataColumns = 'id,owner_agent_id,layer,visibility,kind,run_id,task_id,title,summary,tags,version,updated_at';

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${field} must be non-empty text up to ${max} characters`);
  return value;
}
function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${field} must be an integer between ${min} and ${max}`);
  return Number(value);
}
function layer(value: unknown): MemoryLayer {
  if (value !== 'long' && value !== 'medium' && value !== 'short') throw new Error('Unknown memory layer');
  return value;
}
function tags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error('tags must contain at most 8 strings');
  return [...new Set(value.map(item => text(item, 'tag', 40)))];
}
function summary(row: Omit<MemoryRow, 'owner_identity_id' | 'content' | 'created_at'>): MemorySummary {
  const parsed: unknown = JSON.parse(row.tags);
  return {id: row.id, version: row.version, layer: row.layer, visibility: row.visibility, kind: row.kind,
    ownerAgentId: row.owner_agent_id, ...(row.run_id === null ? {} : {runId: row.run_id}),
    ...(row.task_id === null ? {} : {taskId: row.task_id}), title: row.title, summary: row.summary,
    tags: tags(parsed), updatedAt: row.updated_at};
}

/** Callers are real Agent instance IDs resolved by the host, never model-supplied owner identities. */
export class MemoryService {
  constructor(private readonly store: StudioStore) {}

  private actor(id: string): StoredAgent {
    const actor = this.store.agent(id);
    if (!actor) throw new Error('Unknown memory caller');
    return actor;
  }
  private descendants(actor: StoredAgent): StoredAgent[] {
    const members = this.store.agents(actor.runId);
    const allowed = new Map<string, StoredAgent>([[actor.id, actor]]);
    if (actor.role === 'worker') return [...allowed.values()];
    let added = true;
    while (added) {
      added = false;
      for (const member of members) {
        if (allowed.has(member.id) || !member.parentId || !allowed.has(member.parentId)) continue;
        if (actor.role === 'manager' && member.role !== 'worker') continue;
        allowed.set(member.id, member); added = true;
      }
    }
    return [...allowed.values()];
  }
  private authorization(actor: StoredAgent): Predicate {
    const descendants = this.descendants(actor);
    const owners = descendants.map(item => item.id);
    const identities = [...new Set(descendants.map(item => item.memoryIdentityId))];
    const project = this.store.db.prepare("SELECT json_extract(document,'$.dramaProjectId') AS project FROM runs WHERE id=?").get(actor.runId)?.project;
    const sameProject = "EXISTS (SELECT 1 FROM agents owner JOIN runs workspace ON workspace.id=owner.run_id WHERE owner.id=memories.owner_agent_id AND json_extract(workspace.document,'$.dramaProjectId') IS ?)";
    return {
      sql: `(${sameProject} AND ((layer='long' AND (visibility='public' OR owner_identity_id IN (${identities.map(() => '?').join(',')}))) OR (layer<>'long' AND run_id=? AND owner_agent_id IN (${owners.map(() => '?').join(',')}))))`,
      values: [typeof project === 'string' ? project : null, ...identities, actor.runId, ...owners],
    };
  }
  private query(actor: StoredAgent, input: MemoryListInput): Predicate {
    const predicate = this.authorization(actor);
    if (input.layer !== undefined) { predicate.sql += ' AND layer=?'; predicate.values.push(layer(input.layer)); }
    if (input.taskId !== undefined) { predicate.sql += ' AND task_id=?'; predicate.values.push(text(input.taskId, 'taskId', 100)); }
    if (input.ownerAgentId !== undefined) {
      const id = text(input.ownerAgentId, 'ownerAgentId', 100);
      const owner = this.descendants(actor).find(item => item.id === id);
      if (owner) {
        predicate.sql += " AND ((layer='long' AND owner_identity_id=?) OR (layer<>'long' AND owner_agent_id=?))";
        predicate.values.push(owner.memoryIdentityId, owner.id);
      } else {
        // Public long-term entries remain discoverable by their recorded author; private metadata stays filtered by authorization.
        predicate.sql += ' AND owner_agent_id=?'; predicate.values.push(id);
      }
    }
    if (input.query !== undefined) {
      const query = text(input.query, 'query', 100).replace(/[\\%_]/g, value => `\\${value}`);
      predicate.sql += " AND (title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')";
      predicate.values.push(...Array<string>(4).fill(`%${query}%`));
    }
    return predicate;
  }
  private audit(actorId: string, action: string, outcome: 'allowed' | 'denied', entryId?: string): void {
    this.store.db.prepare('INSERT INTO memory_audit VALUES(?,?,?,?,?,?)').run(randomUUID(), actorId, action, outcome, typeof entryId === 'string' ? entryId.slice(0, 100) : null, new Date().toISOString());
  }
  private audited<T>(actorId: string, action: string, entryId: string | undefined, operation: () => T): T {
    try {
      return this.store.atomic(() => {
        const result = operation();
        const createdId = result !== null && typeof result === 'object' && 'id' in result && typeof result.id === 'string' ? result.id : undefined;
        this.audit(actorId, action, 'allowed', entryId ?? createdId);
        return result;
      });
    } catch (error) {
      this.audit(actorId, action, 'denied', entryId);
      throw error;
    }
  }
  private readable(actor: StoredAgent, id: string): MemoryRow {
    const predicate = this.authorization(actor);
    const row = this.store.db.prepare(`SELECT * FROM memories WHERE (${predicate.sql}) AND id=?`).get(...predicate.values, id) as unknown as MemoryRow | undefined;
    if (!row) throw unavailable();
    return row;
  }
  private owned(actor: StoredAgent, id: string): MemoryRow {
    const row = this.store.db.prepare("SELECT * FROM memories WHERE id=? AND ((layer='long' AND owner_identity_id=?) OR (layer<>'long' AND owner_agent_id=? AND run_id=?))").get(id, actor.memoryIdentityId, actor.id, actor.runId) as unknown as MemoryRow | undefined;
    if (!row) throw unavailable();
    return row;
  }
  private task(actor: StoredAgent, taskId?: string): string | null {
    if (taskId === undefined) return null;
    const id = text(taskId, 'taskId', 100);
    const task = this.store.task(id);
    if (!task || task.runId !== actor.runId) throw new Error('Memory task is unavailable');
    const root = this.store.run(actor.runId)?.orchestratorId === actor.id;
    const participant = task.coordinatorId === actor.id || task.targetManagerId === actor.id || this.store.attempts(id).some(attempt => attempt.workerId === actor.id);
    if (!root && !participant) throw new Error('Memory task is unavailable');
    return id;
  }
  private version(row: MemoryRow, expectedVersion: number | undefined): void {
    if (expectedVersion === undefined) throw new Error('expectedVersion is required when updating memory');
    if (integer(expectedVersion, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER) !== row.version) throw new Error('Memory version conflict; read the current version before updating');
  }
  private persist(actorId: string, row: MemoryRow): MemorySummary {
    this.store.db.prepare(`INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, summary=excluded.summary, content=excluded.content, tags=excluded.tags,
      visibility=excluded.visibility, version=excluded.version, updated_at=excluded.updated_at`).run(
      row.id, row.owner_agent_id, row.owner_identity_id, row.layer, row.visibility, row.kind, row.run_id, row.task_id,
      row.title, row.summary, row.content, row.tags, row.version, row.created_at, row.updated_at);
    this.store.db.prepare('INSERT INTO memory_revisions VALUES(?,?,?,?,?)').run(row.id, row.version, actorId, JSON.stringify(row), row.updated_at);
    return summary(row);
  }
  private writeEntry(actor: StoredAgent, input: MemoryWriteInput, kind: MemoryRow['kind']): MemorySummary {
    const selectedLayer = layer(input.layer);
    const title = text(input.title, 'title', 120), description = text(input.summary, 'summary', 240), content = text(input.content, 'content', 16000);
    const selectedTags = tags(input.tags);
    if (selectedLayer === 'long' && input.taskId !== undefined) throw new Error('Long-term memory cannot belong to a Task');
    const taskId = selectedLayer === 'long' ? null : this.task(actor, input.taskId);
    const existing = input.id === undefined ? undefined : this.owned(actor, text(input.id, 'id', 100));
    if (existing) {
      this.version(existing, input.expectedVersion);
      if (existing.layer !== selectedLayer || existing.task_id !== taskId || existing.kind !== kind) throw new Error('Memory layer, Task and kind cannot change');
    } else if (input.expectedVersion !== undefined && input.expectedVersion !== 0) throw new Error('New memory must omit expectedVersion or use zero');
    const timestamp = new Date().toISOString();
    const row: MemoryRow = existing
      ? {...existing, title, summary: description, content, tags: JSON.stringify(selectedTags), version: existing.version + 1, updated_at: timestamp}
      : {id: randomUUID(), owner_agent_id: actor.id, owner_identity_id: actor.memoryIdentityId, layer: selectedLayer,
        visibility: 'private', kind, run_id: selectedLayer === 'long' ? null : actor.runId, task_id: taskId,
        title, summary: description, content, tags: JSON.stringify(selectedTags), version: 1, created_at: timestamp, updated_at: timestamp};
    return this.persist(actor.id, row);
  }

  /** Returns authorized metadata only; query matches content without exposing snippets or unauthorized counts. */
  list(actorId: string, input: MemoryListInput = {}): MemoryList {
    return this.audited(actorId, 'list', undefined, () => {
      const actor = this.actor(actorId), predicate = this.query(actor, input);
      const limit = integer(input.limit ?? 8, 'limit', 1, 20), offset = integer(input.offset ?? 0, 'offset', 0, 100000);
      const total = Number(this.store.db.prepare(`SELECT count(*) AS total FROM memories WHERE ${predicate.sql}`).get(...predicate.values)!.total);
      const rows = this.store.db.prepare(`SELECT ${metadataColumns} FROM memories WHERE ${predicate.sql} ORDER BY updated_at DESC,rowid DESC LIMIT ? OFFSET ?`).all(...predicate.values, limit, offset) as unknown as MemoryRow[];
      return {items: rows.map(summary), total, ...(offset + rows.length < total ? {nextOffset: offset + rows.length} : {})};
    });
  }
  /** Reads one bounded content page after the same authorization used by the directory. */
  read(actorId: string, input: {id: string; offset?: number; limit?: number}): MemoryPage {
    return this.audited(actorId, 'read', input.id, () => {
      const actor = this.actor(actorId), row = this.readable(actor, text(input.id, 'id', 100));
      const offset = integer(input.offset ?? 0, 'offset', 0, 16000), limit = integer(input.limit ?? 2000, 'limit', 1, 4000);
      const content = row.content.slice(offset, offset + limit);
      return {entry: summary(row), content, offset, totalCharacters: row.content.length,
        ...(offset + content.length < row.content.length ? {nextOffset: offset + content.length} : {})};
    });
  }
  /** Creates private memory or appends a revision owned by the caller; superior read access never grants writing. */
  write(actorId: string, input: MemoryWriteInput): MemorySummary {
    return this.audited(actorId, 'write', input.id, () => this.writeEntry(this.actor(actorId), input, 'note'));
  }
  /** Explicitly publishes the caller's long-term entry; intermediate and short-term content cannot be published. */
  publish(actorId: string, input: {id: string; expectedVersion: number}): MemorySummary {
    return this.audited(actorId, 'publish', input.id, () => {
      const actor = this.actor(actorId), row = this.owned(actor, text(input.id, 'id', 100));
      this.version(row, input.expectedVersion);
      if (row.layer !== 'long') throw new Error('Only long-term memory can be published');
      if (row.visibility === 'public') return summary(row);
      return this.persist(actor.id, {...row, visibility: 'public', version: row.version + 1, updated_at: new Date().toISOString()});
    });
  }
  /** Stores the latest short-term recovery checkpoint for the caller's Run or one participating Task. */
  checkpoint(actorId: string, input: MemoryCheckpointInput): MemorySummary {
    return this.audited(actorId, 'checkpoint', undefined, () => {
      const actor = this.actor(actorId), taskId = this.task(actor, input.taskId);
      const existing = this.store.db.prepare("SELECT id FROM memories WHERE owner_agent_id=? AND kind='checkpoint' AND task_id IS ?").get(actor.id, taskId);
      return this.writeEntry(actor, {layer: 'short', title: input.title ?? 'Recovery checkpoint', summary: input.summary, content: input.content,
        ...(input.taskId === undefined ? {} : {taskId: input.taskId}), ...(existing ? {id: String(existing.id)} : {}), expectedVersion: input.expectedVersion}, 'checkpoint');
    });
  }
  /** Small recovery entry point: authorized layer counts and the caller's checkpoint reference, never full memory content. */
  entrypoint(actorId: string, taskId?: string): MemoryEntrypoint {
    return this.audited(actorId, 'entrypoint', undefined, () => {
      const actor = this.actor(actorId), predicate = this.authorization(actor);
      if (taskId !== undefined) this.task(actor, taskId);
      const counts = this.store.db.prepare(`SELECT layer,count(*) AS count FROM memories WHERE ${predicate.sql} GROUP BY layer`).all(...predicate.values);
      const checkpoint = this.store.db.prepare(`SELECT ${metadataColumns} FROM memories WHERE owner_agent_id=? AND kind='checkpoint' AND task_id IS ?`).get(actor.id, taskId ?? null) as unknown as MemoryRow | undefined;
      return {layers: LAYERS.map(selected => ({layer: selected, count: Number(counts.find(row => row.layer === selected)?.count ?? 0)})), ...(checkpoint ? {checkpoint: summary(checkpoint)} : {})};
    });
  }

  /** Host-only projection for a project whose ownership was checked by the Workbench. */
  projectDirectory(projectId:string,offset=0):{entries:(MemorySummary & {ownerName:string})[]; nextOffset?:number} {
    const columns=metadataColumns.split(',').map(column=>'m.'+column).join(',');
    const start=integer(offset,'offset',0,100000);
    const rows=this.store.db.prepare(`SELECT ${columns},json_extract(a.document,'$.name') AS owner_name FROM memories m
      JOIN agents a ON a.id=m.owner_agent_id JOIN runs r ON r.id=a.run_id WHERE json_extract(r.document,'$.dramaProjectId')=?
      ORDER BY m.updated_at DESC,m.rowid DESC LIMIT 101 OFFSET ?`).all(projectId,start) as unknown as ProjectMemoryRow[];
    return {entries:rows.slice(0,100).map(row=>({...summary(row),ownerName:row.owner_name})),...(rows.length>100?{nextOffset:start+100}:{})};
  }

  /** Host-only body read within an already authorized work; agent APIs use their own role checks. */
  projectNote(projectId:string,id:string):(MemorySummary & {ownerName:string;content:string})|undefined {
    const row=this.store.db.prepare(`SELECT m.*,json_extract(a.document,'$.name') AS owner_name FROM memories m
      JOIN agents a ON a.id=m.owner_agent_id JOIN runs r ON r.id=a.run_id WHERE json_extract(r.document,'$.dramaProjectId')=? AND m.id=?`)
      .get(projectId,id) as unknown as ProjectMemoryRow|undefined;
    return row ? {...summary(row),ownerName:row.owner_name,content:row.content} : undefined;
  }
}
