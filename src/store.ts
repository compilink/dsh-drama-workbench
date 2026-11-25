/** SQLite application state. DSH remains the owner of native Session transcripts. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireRuntimeLock } from './runtime-lock.js';
import type { Activity, AgentTemplate, AgentView, ChatMessage, ExecutionMode, RunView, TaskView, AttemptView, DeliveryView } from './types.js';

export interface StoredAgent extends AgentView { templateVersion: number; memoryIdentityId: string }
export interface RunRecord { id: string; title: string; mode: ExecutionMode; orchestratorId: string; status: string; createdAt: string; modelRequests?: number; memorySourceRunId?: string; dramaProjectId?: string }

// Legacy runtimes probe this row's PID before serving a data directory. PID 1 is present in every supported PID namespace.
const SQLITE_LOCK_OWNER = 'sqlite-runtime-lock-v1';

/** One runtime owns the data directory for the lifetime of its SQLite lock connection. */
export class StudioStore {
  readonly db: DatabaseSync;
  private readonly releaseLock: () => void;
  private closed = false;
  private depth = 0;
  private afters: (() => void)[] = [];
  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'studio.sqlite'), {open: false});
    this.releaseLock = acquireRuntimeLock(dataDir);
    try {
      this.db.open();
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
      if (![0, 1, 2, 3].includes(version)) throw new Error(`Unsupported studio database version ${version}`);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec('CREATE TABLE IF NOT EXISTS runtime_owner(id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, nonce TEXT NOT NULL)');
        const owner = this.db.prepare('SELECT nonce FROM runtime_owner WHERE id=1').get();
        if (owner && owner.nonce !== SQLITE_LOCK_OWNER) throw new Error('This studio data directory is already owned by a legacy runtime. Stop that runtime cleanly in its original environment before migration.');
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY, document TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, document TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), role TEXT NOT NULL, parent_id TEXT, document TEXT NOT NULL);
          CREATE UNIQUE INDEX IF NOT EXISTS one_orchestrator_per_run ON agents(run_id) WHERE role='orchestrator';
          CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), document TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS activity(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), document TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), request_id TEXT NOT NULL, document TEXT NOT NULL, UNIQUE(run_id,request_id));
          CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), document TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), agent_id TEXT NOT NULL REFERENCES agents(id), task_id TEXT REFERENCES tasks(id), document TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS tasks_run ON tasks(run_id);
          CREATE INDEX IF NOT EXISTS attempts_task ON attempts(task_id);
          CREATE INDEX IF NOT EXISTS deliveries_agent ON deliveries(agent_id);
          CREATE TABLE IF NOT EXISTS memories(
            id TEXT PRIMARY KEY,
            owner_agent_id TEXT NOT NULL REFERENCES agents(id),
            owner_identity_id TEXT NOT NULL,
            layer TEXT NOT NULL CHECK(layer IN ('long','medium','short')),
            visibility TEXT NOT NULL CHECK(visibility IN ('private','public')),
            kind TEXT NOT NULL CHECK(kind IN ('note','checkpoint')),
            run_id TEXT REFERENCES runs(id),
            task_id TEXT REFERENCES tasks(id),
            title TEXT NOT NULL, summary TEXT NOT NULL, content TEXT NOT NULL,
            tags TEXT NOT NULL CHECK(json_valid(tags) AND json_type(tags)='array'),
            version INTEGER NOT NULL CHECK(version > 0),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            CHECK((layer='long' AND run_id IS NULL AND task_id IS NULL AND kind='note') OR
              (layer IN ('medium','short') AND run_id IS NOT NULL AND visibility='private')),
            CHECK(kind='note' OR layer='short')
          );
          CREATE INDEX IF NOT EXISTS memories_identity ON memories(layer,owner_identity_id);
          CREATE INDEX IF NOT EXISTS memories_agent_scope ON memories(owner_agent_id,run_id,task_id);
          CREATE UNIQUE INDEX IF NOT EXISTS memory_checkpoint_scope ON memories(owner_agent_id,IFNULL(task_id,'')) WHERE kind='checkpoint';
          CREATE TABLE IF NOT EXISTS memory_revisions(
            entry_id TEXT NOT NULL REFERENCES memories(id), version INTEGER NOT NULL,
            actor_id TEXT NOT NULL REFERENCES agents(id), document TEXT NOT NULL,
            created_at TEXT NOT NULL, PRIMARY KEY(entry_id,version)
          );
          CREATE TRIGGER IF NOT EXISTS memory_revisions_no_update BEFORE UPDATE ON memory_revisions BEGIN SELECT RAISE(ABORT,'Memory revisions are immutable'); END;
          CREATE TRIGGER IF NOT EXISTS memory_revisions_no_delete BEFORE DELETE ON memory_revisions BEGIN SELECT RAISE(ABORT,'Memory revisions are immutable'); END;
          CREATE TABLE IF NOT EXISTS memory_audit(
            id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL,
            outcome TEXT NOT NULL CHECK(outcome IN ('allowed','denied')),
            entry_id TEXT, created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS memory_audit_actor ON memory_audit(actor_id,created_at);
          PRAGMA user_version=3;`);
        this.db.prepare('INSERT INTO runtime_owner VALUES(1,1,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid, nonce=excluded.nonce').run(SQLITE_LOCK_OWNER);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) {
      try { if (this.db.isOpen) this.db.close(); }
      finally { this.releaseLock(); }
      throw error;
    }
  }
  /** Synchronous nested commands share the outer transaction; exceptions roll the entire command back. */
  atomic<T>(operation: () => T): T {
    if (this.depth) return operation();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    let result: T;
    try { result = operation(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); this.afters = []; throw error; }
    finally { this.depth--; }
    const callbacks = this.afters; this.afters = [];
    for (const callback of callbacks) callback();
    return result;
  }
  /** Notifications run after the outermost commit and are discarded on rollback. */
  afterCommit(callback: () => void): void { if (this.depth) this.afters.push(callback); else callback(); }
  templates(): AgentTemplate[] { return this.documents<AgentTemplate>('SELECT document FROM templates ORDER BY rowid'); }
  template(id: string): AgentTemplate | undefined { return this.one<AgentTemplate>('SELECT document FROM templates WHERE id=?', id); }
  saveTemplate(template: AgentTemplate): void { this.db.prepare('INSERT INTO templates VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(template.id, JSON.stringify(template)); }
  agents(runId?: string): StoredAgent[] { return runId ? this.documents<StoredAgent>('SELECT document FROM agents WHERE run_id=? ORDER BY rowid', runId) : this.documents<StoredAgent>('SELECT document FROM agents ORDER BY rowid'); }
  agent(id: string): StoredAgent | undefined { return this.one<StoredAgent>('SELECT document FROM agents WHERE id=?', id); }
  saveAgent(agent: StoredAgent): void { this.db.prepare('INSERT INTO agents VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(agent.id, agent.runId, agent.role, agent.parentId, JSON.stringify(agent)); }
  saveRun(run: RunRecord): void { this.db.prepare('INSERT INTO runs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(run.id, JSON.stringify(run)); }
  run(id: string): RunView | undefined { const run = this.one<RunRecord>('SELECT document FROM runs WHERE id=?', id); return run ? { ...run, agents: this.agents(id), messages: this.documents<ChatMessage>('SELECT document FROM messages WHERE run_id=? ORDER BY rowid', id), tasks: this.tasks(id), attempts: this.tasks(id).flatMap(t => this.attempts(t.id)), deliveries: this.deliveries(id) } : undefined; }
  runs(): RunView[] { return this.documents<RunRecord>('SELECT document FROM runs ORDER BY rowid DESC').map(run => this.run(run.id)!); }
  setRunStatus(id: string, status: string): void { const run = this.one<RunRecord>('SELECT document FROM runs WHERE id=?', id); if (!run) throw new Error('Unknown run'); this.saveRun({ ...run, status }); }
  reserveModelRequest(id: string, limit: number): void { const run = this.one<RunRecord>('SELECT document FROM runs WHERE id=?', id); if (!run) throw new Error('Unknown run'); const count = run.modelRequests ?? 0; if (count >= limit) throw new Error(`Prototype run request limit reached (${limit}); create a new run`); this.saveRun({ ...run, modelRequests: count + 1 }); }
  task(id: string): TaskView | undefined { return this.one<TaskView>('SELECT document FROM tasks WHERE id=?', id); }
  tasks(runId?: string): TaskView[] { return runId ? this.documents<TaskView>('SELECT document FROM tasks WHERE run_id=? ORDER BY rowid', runId) : this.documents<TaskView>('SELECT document FROM tasks ORDER BY rowid'); }
  saveTask(task: TaskView): void { this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(task.id, task.runId, task.requestId, JSON.stringify(task)); }
  attempt(id: string): AttemptView | undefined { return this.one<AttemptView>('SELECT document FROM attempts WHERE id=?', id); }
  attempts(taskId?: string): AttemptView[] { return taskId ? this.documents<AttemptView>('SELECT document FROM attempts WHERE task_id=? ORDER BY rowid', taskId) : this.documents<AttemptView>('SELECT document FROM attempts ORDER BY rowid'); }
  saveAttempt(attempt: AttemptView): void { this.db.prepare('INSERT INTO attempts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(attempt.id, attempt.taskId, JSON.stringify(attempt)); }
  delivery(id: string): DeliveryView | undefined { return this.one<DeliveryView>('SELECT document FROM deliveries WHERE id=?', id); }
  deliveries(runId?: string): DeliveryView[] { return runId ? this.documents<DeliveryView>('SELECT document FROM deliveries WHERE run_id=? ORDER BY rowid', runId) : this.documents<DeliveryView>('SELECT document FROM deliveries ORDER BY rowid'); }
  saveDelivery(delivery: DeliveryView): void { this.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(delivery.id, delivery.runId, delivery.agentId, delivery.taskId ?? null, JSON.stringify(delivery)); }
  message(runId: string, role: ChatMessage['role'], text: string, id: string = randomUUID()): void { this.db.prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?)').run(id, runId, JSON.stringify({ id, role, text, createdAt: new Date().toISOString() } satisfies ChatMessage)); }
  activity(runId: string, kind: string, text: string, agentId?: string, taskId?: string): void { const id = randomUUID(); this.db.prepare('INSERT INTO activity VALUES(?,?,?)').run(id, runId, JSON.stringify({ id, runId, kind, text, agentId, taskId, createdAt: new Date().toISOString() } satisfies Activity)); }
  activities(): Activity[] { return this.documents<Activity>('SELECT document FROM activity ORDER BY rowid DESC LIMIT 300'); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      try { this.db.prepare('DELETE FROM runtime_owner WHERE id=1 AND nonce=?').run(SQLITE_LOCK_OWNER); }
      finally { this.db.close(); }
    } finally { this.releaseLock(); }
  }
  private one<T>(query: string, id: string): T | undefined { const row = this.db.prepare(query).get(id); return row ? JSON.parse(String(row.document)) as T : undefined; }
  private documents<T>(query: string, ...args: string[]): T[] { return this.db.prepare(query).all(...args).map(row => JSON.parse(String(row.document)) as T); }
}
