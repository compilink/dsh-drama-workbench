import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {canvasDraftGraph, DramaStore, DramaStoreError, verifyGraph} from './drama-store.js';
import {editorControls} from './drama-editor-control.js';
import type {StudioStore} from './store.js';

const key = z.string().regex(/^[\w-]{1,100}$/);
const revision = z.string().uuid();
const version = z.number().int().nonnegative();
const draftSchema = canvasDraftGraph.extend({
  baseVersion:version, sourceVersion:version, proposalId:key.optional(),
  name:z.string().max(200).optional(), description:z.string().max(4000).optional(),
});
const write = draftSchema.extend({expectedRevision:revision.nullable(),replaceSource:z.literal(true).optional()}).strict();
const confirmation = z.object({expectedRevision:revision}).strict();
type Draft = z.infer<typeof draftSchema> & {revision:string};
type Scope = 'project' | 'template';

function parse<T>(schema:z.ZodType<T>, input: unknown): T {
  const result=schema.safeParse(input);
  if (!result.success) throw new DramaStoreError(400,'草稿字段无效：'+result.error.issues[0]?.path.join('.'));
  return result.data;
}

/** One independently versioned working copy per canvas; only publication changes a live graph. */
export class CanvasDrafts {
  constructor(private readonly store:StudioStore, private readonly drama:DramaStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS drama_canvas_drafts(
      owner_id TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('project','template')), target_id TEXT NOT NULL,
      project_id TEXT REFERENCES drama_projects(id) ON DELETE CASCADE, revision TEXT NOT NULL, document TEXT NOT NULL,
      PRIMARY KEY(owner_id,scope,target_id));
      CREATE TRIGGER IF NOT EXISTS drama_drop_retired_template_draft AFTER UPDATE OF retired ON drama_templates WHEN NEW.retired=1
        BEGIN DELETE FROM drama_canvas_drafts WHERE scope='template' AND target_id=NEW.id AND owner_id=NEW.owner_id; END;`);
  }

  private head(scope:Scope,id:string):number {
    if (scope==='project') return this.drama.project(id).graphVersion;
    if (id==='new') return 0;
    const item=this.drama.template(id);
    if (item.retired) throw new DramaStoreError(409,'模板已从库中移除');
    return item.version;
  }

  private row(scope:Scope,id:string): Draft|null {
    const row=this.store.db.prepare('SELECT revision,document FROM drama_canvas_drafts WHERE owner_id=? AND scope=? AND target_id=?')
      .get(this.drama.ownerId,scope,id);
    return row ? {...JSON.parse(String(row.document)), revision:String(row.revision)} : null;
  }

  read(scope:Scope,id:string) {
    this.head(scope,id);
    return {draft:this.row(scope,id)};
  }

  private checkRevision(scope:Scope,id:string,expected:string|null): Draft|null {
    const draft=this.row(scope,id);
    if ((draft?.revision??null)!==expected) throw new DramaStoreError(409,'草稿已在其他窗口更新，请载入最新草稿后再操作');
    return draft;
  }

  save(scope:Scope,id:string,input:unknown) {
    const {expectedRevision,replaceSource,...data}=parse(write,input);
    return this.store.atomic(()=>{
      const head=this.head(scope,id);
      const previous=this.checkRevision(scope,id,expectedRevision);
      if (previous && !replaceSource && (data.baseVersion!==previous.baseVersion || data.sourceVersion!==previous.sourceVersion || data.proposalId!==previous.proposalId))
        throw new DramaStoreError(409,'草稿来源已变化，请先处理现有草稿');
      if (head===0 ? (data.baseVersion!==0 || data.sourceVersion!==0) :
        (data.sourceVersion<1 || data.sourceVersion>data.baseVersion || data.baseVersion>head))
        throw new DramaStoreError(400,'草稿来源版本无效');
      if (scope==='project' && (data.baseVersion!==data.sourceVersion || data.name!==undefined || data.description!==undefined))
        throw new DramaStoreError(400,'作品草稿的底稿版本或资料无效');
      if (data.proposalId && (!previous || replaceSource)) {
        if (scope!=='project') throw new DramaStoreError(400,'总编提案仅可用于所属作品');
        const proposal=editorControls(this.store)!.proposal(id,data.proposalId);
        if (proposal.baseVersion!==data.baseVersion || proposal.state!=='proposed') throw new DramaStoreError(409,'总编提案已变化');
      }
      verifyGraph(data);
      const next=randomUUID();
      this.store.db.prepare(`INSERT INTO drama_canvas_drafts VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,scope,target_id)
        DO UPDATE SET revision=excluded.revision, document=excluded.document`).run(this.drama.ownerId,scope,id,scope==='project'?id:null,next,JSON.stringify(data));
      return {draft:{...data,revision:next}};
    });
  }

  private remove(scope:Scope,id:string) {
    this.store.db.prepare('DELETE FROM drama_canvas_drafts WHERE owner_id=? AND scope=? AND target_id=?').run(this.drama.ownerId,scope,id);
  }

  discard(scope:Scope,id:string,input:unknown) {
    const {expectedRevision}=parse(confirmation,input);
    return this.store.atomic(()=>{
      this.head(scope,id);
      this.checkRevision(scope,id,expectedRevision);
      this.remove(scope,id);
      return {draft:null};
    });
  }

  publish(scope:Scope,id:string,input:unknown) {
    const {expectedRevision}=parse(confirmation,input);
    return this.store.atomic(()=>{
      const head=this.head(scope,id);
      const draft=this.checkRevision(scope,id,expectedRevision)!;
      if (draft.baseVersion!==head) throw new DramaStoreError(409,'生效版本已更新。草稿已保留，请核对最新版本后再保存');
      const {nodes,edges}=draft;
      const missing=nodes.find(node=>!node.agentId);
      if (missing) throw new DramaStoreError(400,'请先为节点「'+missing.title+'」选择 Agent');
      let item;
      if (scope==='template') {
        item=this.drama.saveTemplate({...(id==='new'?{}:{id,expectedVersion:head}),name:draft.name,description:draft.description,nodes,edges});
      } else if (draft.proposalId) {
        editorControls(this.store)!.confirm(id,draft.proposalId,{action:'save',nodes,edges});
        item=this.drama.graph(id);
      } else {
        item=this.drama.saveGraph(id,head,{nodes,edges});
      }
      this.remove(scope,id);
      return {item,draft:null};
    });
  }
}
