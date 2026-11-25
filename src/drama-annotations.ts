/** Anchors a screenplay revision to an immutable source and its optional editor task. */
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { DramaStore, DramaStoreError } from './drama-store.js';
import type { DramaWorkflow } from './drama-workflow.js';
import type { StudioStore } from './store.js';

const key = z.string().min(1).max(160).regex(/^[\w:-]+$/);
const anchor = z.object({source:z.enum(['episode','artifact']),sourceId:key,version:z.number().int().positive(),
  start:z.number().int().nonnegative(),end:z.number().int().positive(),selectedText:z.string().min(1).max(4000),
  text:z.string().trim().min(1).max(1000),dispatch:z.boolean(),reanchorOf:key.optional(),requestId:key});
const decision = z.object({decision:z.enum(['apply','dismiss']),replacement:z.string().optional(),requestId:key});
type Entry = Omit<z.output<typeof anchor>,'dispatch'|'requestId'> & {id:string;createdAt:string;taskId?:string;runId?:string;
  resolution?:'applied'|'dismissed';revision?:{id:string;version:number};decisionKey?:string;decisionHash?:string};
function parse<T>(schema:z.ZodType<T>,value:unknown):T {
  const checked=schema.safeParse(value);
  if(!checked.success) throw new DramaStoreError(400,'批注字段无效：'+checked.error.issues.map(issue=>issue.path.join('.')).join('、'));
  return checked.data;
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class DramaAnnotations {
  constructor(private readonly drama:DramaStore,private readonly workflow:DramaWorkflow,private readonly store:StudioStore) {
    store.db.exec('CREATE TABLE IF NOT EXISTS drama_annotations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES drama_projects(id),request_id TEXT NOT NULL,digest TEXT NOT NULL,document TEXT NOT NULL,UNIQUE(project_id,request_id))');
  }
  private view(entry:Entry) {
    const task=entry.taskId?this.store.task(entry.taskId):undefined;
    const rejected=task?.verdict==='reject';
    const candidate=task?.status==='completed'&&!rejected?task.result:undefined;
    return {...entry, ...(task?{taskStatus:task.status,error:rejected?task.result:task.error}:{}), ...(candidate?{candidate}:{}),
      status:entry.resolution || (candidate?'candidate':rejected?'rejected':task?.status??'saved')};
  }
  list(projectId:string) {
    const saved=this.store.db.prepare('SELECT document FROM drama_annotations WHERE project_id=? ORDER BY rowid DESC').all(projectId)
      .map(row=>this.view(JSON.parse(String(row.document)) as Entry));
    const ids=new Set(saved.map(row=>row.id));
    return [...saved,...this.drama.listEpisodeComments(projectId).filter(row=>!ids.has(row.id)).map(row=>this.view({...row,source:'episode',sourceId:row.documentId}))];
  }
  links(projectId:string,sessionId?:string) {
    if(!sessionId) return [];
    const rows=this.store.db.prepare("SELECT document FROM drama_annotations WHERE project_id=? AND json_extract(document,'$.runId')=? ORDER BY rowid").all(projectId,sessionId);
    return rows.map(row=>{
      const {id,taskId,source,sourceId,version}=JSON.parse(String(row.document)) as Entry;
      return {id,taskId,source,sourceId,version};
    });
  }
  private entry(projectId:string,id:string):Entry {
    this.drama.project(projectId);
    const row=this.store.db.prepare('SELECT document FROM drama_annotations WHERE project_id=? AND id=?').get(projectId,id);
    if(row) return JSON.parse(String(row.document)) as Entry;
    const old=this.drama.listEpisodeComments(projectId).find(c=>c.id===id);
    if(!old) throw new DramaStoreError(404,'批注不存在');
    return {...old,source:'episode',sourceId:old.documentId};
  }
  sourceVersions(projectId:string,id:string) {
    const e=this.entry(projectId,id);
    const current=e.source==='episode'?this.drama.document(projectId,e.sourceId):this.workflow.latestAnnotationDraft(projectId,e.sourceId);
    return {entry:this.view(e),latest:{id:current.id,version:current.version,
      excerpt:current.content.slice(Math.max(0,e.start-60), Math.min(current.content.length,e.end+60))},
      stale:e.version!==current.version||e.sourceId!==current.id};
  }
  private send(projectId:string,entry:Entry) {
    const source=entry.source==='episode'?this.drama.document(projectId,entry.sourceId,entry.version):this.workflow.artifact(projectId,entry.sourceId);
    const title='name' in source?source.name:source.title;
    const text='修订《'+title+'》v'+source.version+' 的选中文字。仅提交用于替换下列选区的完整修订文本，保留选区外内容。\n原文：'+entry.selectedText+'\n修改意见：'+entry.text;
    Object.assign(entry,this.workflow.annotationTask(projectId,text,'annotation:'+entry.id));
  }
  dispatch(projectId:string,id:string) {
    return this.store.atomic(()=>{
      const entry=this.entry(projectId,id);
      if(entry.taskId) return this.view(entry);
      this.send(projectId,entry);
      this.store.db.prepare('INSERT INTO drama_annotations(id,project_id,request_id,digest,document) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document')
        .run(id,projectId,'~'+id,'legacy',JSON.stringify(entry));
      return this.view(entry);
    });
  }
  add(projectId:string,value:unknown) {
    const input=parse(anchor,value);
    this.drama.project(projectId);
    return this.store.atomic(()=>{
      const hash=digest(input);
      const prior=this.store.db.prepare('SELECT digest,document FROM drama_annotations WHERE project_id=? AND request_id=?').get(projectId,input.requestId);
      if(prior) {
        if(prior.digest!==hash) throw new DramaStoreError(409,'该请求已用于不同批注');
        return this.view(JSON.parse(String(prior.document)) as Entry);
      }
      const source=input.source==='episode'?this.drama.document(projectId,input.sourceId):this.workflow.artifact(projectId,input.sourceId);
      if(source.version!==input.version || ('kind' in source && source.kind!=='episode')) throw new DramaStoreError(409,'请在分集或节点成果的对应版本添加批注');
      if(input.start>=input.end||source.content.slice(input.start,input.end)!==input.selectedText||input.end>source.content.length) throw new DramaStoreError(400,'选区与原文不一致');
      const {dispatch,requestId,...point}=input;
      const id=input.source==='episode'?this.drama.addEpisodeComment(projectId,{documentId:point.sourceId,...point}).id:randomUUID();
      const entry:Entry={...point,id,createdAt:new Date().toISOString()};
      if(point.reanchorOf) {
        const ref=this.sourceVersions(projectId,point.reanchorOf);
        if(ref.entry.source!==point.source || ref.latest.id!==point.sourceId || ref.latest.version!==point.version) throw new DramaStoreError(409,'请重新选择同一来源的最新稿件');
      }
      if(dispatch) this.send(projectId,entry);
      this.store.db.prepare('INSERT INTO drama_annotations VALUES(?,?,?,?,?)').run(id,projectId,requestId,hash,JSON.stringify(entry));
      return this.view(entry);
    });
  }
  resolve(projectId:string,id:string,value:unknown) {
    const input=parse(decision,value);
    this.drama.project(projectId);
    return this.store.atomic(()=>{
      const row=this.store.db.prepare('SELECT document FROM drama_annotations WHERE project_id=? AND id=?').get(projectId,id);
      if(!row) throw new DramaStoreError(404,'批注不存在');
      const entry=JSON.parse(String(row.document)) as Entry;
      const hash=digest(input);
      if(entry.resolution) {
        if(entry.decisionKey===input.requestId && entry.decisionHash===hash) return this.view(entry);
        throw new DramaStoreError(409,'这条修订已经处理');
      }
      const candidate=this.view(entry).candidate;
      if(!candidate) throw new DramaStoreError(409,'没有可审阅的任务候选稿');
      if(input.decision==='apply') {
        const source=entry.source==='episode'?this.drama.document(projectId,entry.sourceId):this.workflow.artifact(projectId,entry.sourceId);
        if(source.version!==entry.version) throw new DramaStoreError(409,'源稿已更新，请在最新版本重新批注');
        const replacement=input.replacement??candidate;
        const content=source.content.slice(0,entry.start)+replacement+source.content.slice(entry.end);
        if(!content.trim()) throw new DramaStoreError(400,'修订后的正文不能为空');
        if('kind' in source) {
          const updated=this.drama.saveDocument(projectId,{id:source.id,expectedVersion:source.version,name:source.name,content});
          entry.revision={id:updated.id,version:updated.version};
        } else {
          const updated=this.workflow.artifact(projectId,this.workflow.applyAnnotation(projectId,source.id,content,'apply-annotation:'+id));
          entry.revision={id:updated.id,version:updated.version};
        }
        entry.resolution='applied';
      } else entry.resolution='dismissed';
      entry.decisionKey=input.requestId;entry.decisionHash=hash;
      this.store.db.prepare('UPDATE drama_annotations SET document=? WHERE project_id=? AND id=?').run(JSON.stringify(entry),projectId,id);
      return this.view(entry);
    });
  }
}
