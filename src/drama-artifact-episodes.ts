/** Associates a pinned node draft with a specific episode document version. */
import { z } from 'zod';
import { DramaStoreError, type DramaStore } from './drama-store.js';
import type { StudioStore } from './store.js';
import type { DramaWorkflow } from './drama-workflow.js';

const id=z.string().min(1).max(100).regex(/^[\w-]+$/);
const link=z.discriminatedUnion('mode',[
  z.object({mode:z.literal('existing'),documentId:id,version:z.number().int().positive(),requestId:id}).strict(),
  z.object({mode:z.literal('new'),episode:z.number().int().min(1).max(10000),scene:z.string().trim().min(1).max(200).optional(),requestId:id}).strict(),
]);

export class ArtifactEpisodes {
  constructor(private readonly store:StudioStore,private readonly drama:DramaStore,private readonly workflow:DramaWorkflow) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS drama_artifact_episodes(
      project_id TEXT NOT NULL REFERENCES drama_projects(id),artifact_id TEXT NOT NULL REFERENCES drama_drafts(id),
      document_id TEXT NOT NULL,version INTEGER NOT NULL,request_id TEXT NOT NULL,input TEXT NOT NULL,
      PRIMARY KEY(project_id,request_id),FOREIGN KEY(document_id,version) REFERENCES drama_document_versions(document_id,version))`);
  }
  forArtifact(projectId:string,artifactId:string) {
    this.workflow.artifact(projectId,artifactId);
    const rows=this.store.db.prepare('SELECT DISTINCT document_id,version FROM drama_artifact_episodes WHERE project_id=? AND artifact_id=? ORDER BY version').all(projectId,artifactId);
    return rows.map(r=>{
      const {id,name,episode,scene,version}=this.drama.document(projectId,String(r.document_id),Number(r.version));
      return {id,name,episode,scene,version};
    });
  }
  forDocument(projectId:string,documentId:string,version:number) {
    this.drama.document(projectId,documentId,version);
    const rows=this.store.db.prepare('SELECT DISTINCT artifact_id FROM drama_artifact_episodes WHERE project_id=? AND document_id=? AND version=?').all(projectId,documentId,version);
    return rows.map(row=>{
      const {id,title,version}=this.workflow.artifact(projectId,String(row.artifact_id));
      return {id,title,version};
    });
  }
  associate(projectId:string,artifactId:string,value:unknown) {
    const parsed=link.safeParse(value);
    if(!parsed.success) throw new DramaStoreError(400,'请选择已有分集或填写新分集的集号');
    const input=parsed.data,encoded=JSON.stringify(input);
    return this.store.atomic(()=>{
      const draft=this.workflow.artifact(projectId,artifactId);
      const prior=this.store.db.prepare('SELECT document_id,version,input,artifact_id FROM drama_artifact_episodes WHERE project_id=? AND request_id=?').get(projectId,input.requestId);
      if(prior) {
        if(prior.input!==encoded||prior.artifact_id!==artifactId) throw new DramaStoreError(409,'请求已用于另一条分集关联');
        return {id:String(prior.document_id),version:Number(prior.version)};
      }
      const doc=input.mode==='existing'?this.drama.document(projectId,input.documentId,input.version):
        this.drama.saveDocument(projectId,{kind:'episode',episode:input.episode,scene:input.scene,name:draft.title,content:draft.content});
      if(doc.kind!=='episode') throw new DramaStoreError(400,'只能关联分集正文');
      this.store.db.prepare('INSERT INTO drama_artifact_episodes VALUES(?,?,?,?,?,?)').run(projectId,artifactId,doc.id,doc.version,input.requestId,encoded);
      return {id:doc.id,version:doc.version};
    });
  }
}
