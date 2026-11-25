/** Project-owned history and files can be purged only after the owner confirms the current archive. */
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { StudioStore } from './store.js';
import { DramaStoreError } from './drama-store-error.js';

/** Immutable revisions may be deleted only together with the project that owns them. */
export function installProjectDeletion(store: StudioStore): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS drama_deletion_runs(
    project_id TEXT NOT NULL REFERENCES drama_projects(id), run_id TEXT PRIMARY KEY REFERENCES runs(id))`);
  const projectOf = {
    drama_graphs: 'OLD.project_id',
    drama_document_versions: '(SELECT project_id FROM drama_documents WHERE id=OLD.document_id)',
    drama_episode_comments: 'OLD.project_id',
    drama_network_audit: 'OLD.project_id',
    memory_revisions: `(SELECT scope.project_id FROM memories m JOIN agents a ON a.id=m.owner_agent_id
      JOIN drama_deletion_runs scope ON scope.run_id=a.run_id WHERE m.id=OLD.entry_id)`,
  };
  for (const [table, project] of Object.entries(projectOf)) {
    store.db.exec(`DROP TRIGGER IF EXISTS ${table}_no_delete;
      CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
      WHEN NOT EXISTS (SELECT 1 FROM drama_projects WHERE id=${project} AND json_extract(document,'$.deleting')=1)
      BEGIN SELECT RAISE(ABORT,'Project history is immutable'); END;`);
  }
  store.db.exec('UPDATE drama_schema SET version=4 WHERE id=1');
}

function hasTable(store: StudioStore, name: string): boolean {
  return !!store.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
}

function sessionTables(store: StudioStore): string[] {
  return ['drama_editor_sessions', 'drama_project_sessions', 'drama_dispatch_sessions'].filter(name => hasTable(store, name));
}

export function projectForRun(store: StudioStore, runId: string): string | undefined {
  const row = store.db.prepare("SELECT json_extract(document,'$.dramaProjectId') AS project FROM runs WHERE id=?").get(runId);
  if (!row) throw new DramaStoreError(404, 'Unknown run');
  const owners = new Set<string>();
  if (typeof row.project === 'string') owners.add(row.project);
  for (const table of sessionTables(store)) {
    for (const binding of store.db.prepare(`SELECT project_id FROM ${table} WHERE run_id=?`).all(runId)) owners.add(String(binding.project_id));
  }
  if (owners.size > 1) throw new DramaStoreError(409, '会话包含多个作品绑定，无法安全处理');
  return owners.values().next().value;
}

export function projectRunIds(store: StudioStore, projectId: string): string[] {
  const tables = sessionTables(store);
  const selects = ["SELECT id FROM runs WHERE json_extract(document,'$.dramaProjectId')=?", ...tables.map(table =>
    `SELECT run_id FROM ${table} WHERE project_id=?`)];
  const ids = store.db.prepare(selects.join(' UNION ')).all(...selects.map(() => projectId)).map(row => String(row.id));
  const list = JSON.stringify(ids);
  // Old editor-session bindings can establish ownership even when the Run has no project field.
  const conflicts = ["SELECT id FROM runs WHERE id IN (SELECT value FROM json_each(?)) AND json_extract(document,'$.dramaProjectId')<>?",
    ...tables.map(table => `SELECT run_id FROM ${table} WHERE run_id IN (SELECT value FROM json_each(?)) AND project_id<>?`),
    "SELECT id FROM tasks WHERE run_id IN (SELECT value FROM json_each(?)) AND json_extract(document,'$.drama.projectId')<>?"];
  if (store.db.prepare(conflicts.join(' UNION ALL ') + ' LIMIT 1').get(...conflicts.flatMap(() => [list, projectId]))) {
    throw new DramaStoreError(409, '执行记录包含其他作品的绑定，无法安全归档或删除');
  }
  return ids;
}

export function assertProjectIdle(store: StudioStore, projectId: string): void {
  const runs = JSON.stringify(projectRunIds(store, projectId));
  const runList = 'IN (SELECT value FROM json_each(?))';
  const active = store.db.prepare(`SELECT id FROM deliveries WHERE run_id ${runList} AND json_extract(document,'$.state') IN ('pending','running')
    UNION ALL SELECT id FROM tasks WHERE run_id ${runList} AND json_extract(document,'$.status') IN ('queued','running','paused','review')
    UNION ALL SELECT a.id FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE t.run_id ${runList} AND json_extract(a.document,'$.status') IN ('queued','running','paused') LIMIT 1`)
    .get(runs, runs, runs);
  const workflowBusy = hasTable(store, 'drama_graph_runs') && store.db.prepare(`
    SELECT r.id FROM drama_graph_runs r WHERE r.project_id=? AND json_extract(r.document,'$.stopRequestedAt') IS NOT NULL
      AND json_extract(r.document,'$.stoppedAt') IS NULL
    UNION ALL SELECT n.id FROM drama_node_runs n JOIN drama_graph_runs r ON r.id=n.graph_run_id
      WHERE r.project_id=? AND (json_extract(n.document,'$.status') IN ('queued','running','checking_output','pause_requested','paused','stopping')
        OR json_extract(n.document,'$.restartPending')=1
        OR (json_extract(n.document,'$.status')='waiting' AND json_extract(n.document,'$.inputCheck.status')='pending')) LIMIT 1`).get(projectId, projectId);
  if (active || workflowBusy) throw new DramaStoreError(409, '作品仍有执行中、排队或暂停的任务，请等待完成或先停止后再归档');
}

export function collectProjectResources(store: StudioStore, projectId: string) {
  const runIds = projectRunIds(store, projectId);
  const runs = JSON.stringify(runIds);
  if (hasTable(store, 'video_jobs') && store.db.prepare("SELECT 1 FROM video_jobs WHERE json_extract(document,'$.runId') IN (SELECT value FROM json_each(?)) LIMIT 1").get(runs)) {
    throw new DramaStoreError(409, '此作品的会话仍被视频试点作业引用，无法永久删除');
  }
  const agents = store.db.prepare("SELECT id,json_extract(document,'$.sessionId') AS session_id FROM agents WHERE run_id IN (SELECT value FROM json_each(?))").all(runs);
  const sessionIds = agents.map(agent => String(agent.session_id));
  if (store.db.prepare(`SELECT 1 FROM agents WHERE run_id NOT IN (SELECT value FROM json_each(?))
    AND json_extract(document,'$.sessionId') IN (SELECT value FROM json_each(?)) LIMIT 1`).get(runs, JSON.stringify(sessionIds))) {
    throw new DramaStoreError(409, '会话被其他作品引用，无法安全删除');
  }
  const attempts = store.db.prepare('SELECT a.id FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE t.run_id IN (SELECT value FROM json_each(?))').all(runs);
  return {runIds, sessionIds, agentIds: agents.map(agent => String(agent.id)), attemptIds: attempts.map(a => String(a.id))};
}

function ownDirectory(path: string): boolean {
  const stat = lstatSync(path, {throwIfNoEntry: false});
  if (!stat) return false;
  if (!stat.isDirectory()) throw new DramaStoreError(409, '作品存储目录异常，清理已暂停');
  return true;
}

function removeFiles(store: StudioStore, projectId: string, sessionIds: string[]): void {
  // Workbench project and native Session IDs are generated safe path segments; reject malformed legacy data.
  for (const id of [projectId, ...sessionIds]) {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new DramaStoreError(409, '作品文件标识异常，清理已暂停');
  }
  const blobs = join(store.dataDir, 'drama-blobs');
  if (ownDirectory(blobs)) rmSync(join(blobs, projectId), {recursive: true, force: true});
  const root = join(store.dataDir, 'sessions');
  if (!sessionIds.length || !ownDirectory(root)) return;
  // Native JSONL groups UUID session directories by the cwd recorded at creation, including past data-directory names.
  for (const group of readdirSync(root, {withFileTypes: true})) {
    if (!group.isDirectory()) continue;
    for (const id of sessionIds) rmSync(join(root, group.name, id), {recursive: true, force: true});
  }
}

/** Caller holds the SQLite write transaction and has released native handles and Attempt volumes. */
export function purgeProject(store: StudioStore, projectId: string): void {
  const {sessionIds, runIds} = collectProjectResources(store, projectId);
  const db = store.db;
  const scope = db.prepare('INSERT INTO drama_deletion_runs(project_id,run_id) VALUES(?,?)');
  for (const run of runIds) scope.run(projectId, run);
  const runs = 'SELECT run_id FROM drama_deletion_runs WHERE project_id=?';
  const agents = `SELECT id FROM agents WHERE run_id IN (${runs})`;
  const ownedMemories = `SELECT id FROM memories WHERE owner_agent_id IN (${agents})`;
  const statements: [string, string][] = [
    ['drama_editor_receipts', 'project_id=?'], ['drama_artifact_episodes', 'project_id=?'],
    ['drama_annotations', 'project_id=?'], ['drama_exports', 'project_id=?'],
    ['drama_network_audit', 'project_id=?'], ['drama_reviews', 'project_id=?'], ['drama_drafts', 'project_id=?'],
    ['drama_node_runs', 'graph_run_id IN (SELECT id FROM drama_graph_runs WHERE project_id=?)'],
    ['drama_graph_runs', 'project_id=?'], ['drama_node_inputs', 'project_id=?'], ['drama_commands', 'project_id=?'],
    ['drama_episode_comments', 'project_id=?'],
    ['drama_document_versions','document_id IN (SELECT id FROM drama_documents WHERE project_id=?)'],
    ['drama_documents', 'project_id=?'], ['drama_graphs', 'project_id=?'],
    ['drama_editor_sessions', 'project_id=?'], ['drama_project_sessions', 'project_id=?'], ['drama_dispatch_sessions', 'project_id=?'],
    ['memory_audit', `entry_id IN (${ownedMemories})`], ['memory_audit', `actor_id IN (${agents})`],
    ['memory_revisions', `entry_id IN (${ownedMemories})`], ['memories', `owner_agent_id IN (${agents})`],
    ['deliveries', `run_id IN (${runs})`], ['attempts', `task_id IN (SELECT id FROM tasks WHERE run_id IN (${runs}))`],
    ['tasks', `run_id IN (${runs})`], ['messages', `run_id IN (${runs})`], ['activity', `run_id IN (${runs})`], ['agents', `run_id IN (${runs})`],
  ];
  for (const [table, condition] of statements) {
    if (hasTable(store, table)) db.prepare(`DELETE FROM ${table} WHERE ${condition}`).run(projectId);
  }
  db.prepare('DELETE FROM drama_deletion_runs WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM runs WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(runIds));
  db.prepare('DELETE FROM drama_projects WHERE id=?').run(projectId);
  // Keep the full cleanup manifest in SQLite on error or interruption. Already removed paths can be retried.
  removeFiles(store, projectId, sessionIds);
}
