import {CanvasDrafts} from './drama-canvas-drafts.js';
import {dramaProtocol} from './drama-protocol.js';
/** Loopback Workbench routes, attached after the Studio origin and CSRF checks. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { DramaStore, DramaStoreError } from './drama-store.js';
import { editorControls, ensureConfiguredSelection } from './drama-editor-control.js';
import type { DramaWorkflow } from './drama-workflow.js';
import type { Studio } from './types.js';
import { ArtifactEpisodes } from './drama-artifact-episodes.js';
import { DramaAnnotations } from './drama-annotations.js';
import { MemoryService } from './memory.js';

type Body = (req:IncomingMessage, limit?:number)=>Promise<Record<string,unknown>>;
type Send = (res:ServerResponse,status:number,data:unknown)=>void;
const textRequestBytes = 14 * 1024 * 1024;
const key = z.string().regex(/^[\w:-]{1,160}$/);
const ref = z.object({id:key,version:z.number().int().positive()});
const overrides = z.object({instruction:z.string().optional(),documents:z.array(ref).max(32).optional()});
const start = z.object({requestId:key,nodeIds:z.array(key).min(1).max(500),includeDownstream:z.boolean().optional(),overrides:z.record(key,overrides).optional()});
const review = z.object({requestId:key,decision:z.enum(['approve','reject','edit']),artifactId:key,note:z.string().optional(),content:z.string().optional()});
const action = z.object({requestId:key,action:z.enum(['pause','resume','restart'])});
const editor = z.object({requestId:key,mode:z.enum(['message','task']),text:z.string().min(1),agentId:key.optional()});
const modelSelection = z.object({provider:z.string().max(200),model:z.string().max(300),reasoningEffort:z.string().max(200).optional()});

function parse<T>(schema:z.ZodType<T>,value:unknown):T {
  const result=schema.safeParse(value);
  if(!result.success) throw new DramaStoreError(400,'请求字段无效：'+result.error.issues.map(issue=>issue.path.join('.')).join(', '));
  return result.data;
}
function version(url:URL):number|undefined {
  const raw=url.searchParams.get('version');if(raw===null) return undefined;
  return parse(z.number().int().positive(),Number(raw));
}
function file(res:ServerResponse,mime:string,filename:string,bytes:Buffer,hash?:string) {
  res.writeHead(200,{'Content-Type':mime,'Content-Length':String(bytes.length),'Cache-Control':'no-store',
    'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(Buffer.from(filename).toString('utf8')).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase()),
    ...(hash?{'X-Content-SHA256':hash}:{})});
  res.end(bytes);
}

export function createDramaRoutes(drama:DramaStore,workflow:DramaWorkflow,studio:Studio,revoke:(id:string)=>void) {
  const drafts=new CanvasDrafts(studio.drama!.store,drama);
  const episodes=new ArtifactEpisodes(studio.drama!.store,drama,workflow);
  const annotations=new DramaAnnotations(drama,workflow,studio.drama!.store);
  const memory=new MemoryService(studio.drama!.store);
  return async (req:IncomingMessage,res:ServerResponse,url:URL,method:string,body:Body,send:Send):Promise<boolean>=>{
    const parts=url.pathname.slice('/api/drama/'.length).split('/');
    const [resource,id,section,item,subsection]=parts;
    if(parts.length>7||parts.some(part=>!part||!/^[-\w]+$/.test(part))) return false;
    const reply=(status:number,value:unknown)=>{send(res,status,value);return true;};
    if(resource==='canvas-drafts' && (id==='project'||id==='template') && section) {
      if(parts.length===3 && method==='GET') return reply(200,drafts.read(id,section));
      if(parts.length===3 && method==='PUT') return reply(200,drafts.save(id,section,await body(req,textRequestBytes)));
      if(parts.length===3 && method==='DELETE') return reply(200,drafts.discard(id,section,await body(req)));
      if(parts.length===4 && item==='publish' && method==='POST') return reply(200,drafts.publish(id,section,await body(req)));
    }
    if(resource==='protocol'&&parts.length===1&&method==='GET') return reply(200,dramaProtocol);
    if(resource==='models'&&parts.length===1&&method==='GET') return reply(200,(await studio.snapshot()).models);
    if(resource==='models'&&id==='refresh'&&parts.length===2&&method==='POST') return reply(200,await studio.drama!.refreshModels());
    if(resource==='models'&&id==='probe'&&parts.length===2&&method==='POST') return reply(200,await studio.drama!.probeModel(parse(modelSelection,await body(req))));
    if(resource==='agents'&&parts.length===1) {
      if(method==='GET') return reply(200,drama.listAgents(url.searchParams.get('includeRetired')==='1').map(agent=>({...agent,effectiveTools:studio.drama!.configuredTools(agent)})));
      if(method==='POST') {
        const input=await body(req,textRequestBytes);
        if(typeof input.id==='string' && typeof input.retired==='boolean' && Object.keys(input).every(field=>['id','expectedVersion','retired'].includes(field))) {
          const previous=drama.agent(input.id);
          if(input.retired===false) ensureConfiguredSelection((await studio.snapshot()).models,previous.selection);
          const grant=drama.networkGrant(input.id);
          const agent=drama.saveAgent({...previous,...input,publicNetwork:input.retired?false:previous.publicNetwork});
          if(grant&&!drama.networkAllowed(agent.id,grant.id)) revoke(grant.id);
          return reply(200,agent);
        }
        const selection=parse(modelSelection,input.selection);
        ensureConfiguredSelection((await studio.snapshot()).models,selection);
        const prior=typeof input.id==='string'?drama.networkGrant(input.id):undefined;
        const agent=drama.saveAgent(input);
        if(prior&&!drama.networkAllowed(agent.id,prior.id)) revoke(prior.id);
        return reply(input.id?200:201,agent);
      }
    }
    if(resource==='skills') {
      if(parts.length===1&&method==='GET') return reply(200,drama.listSkills());
      if(parts.length===1&&method==='POST') {const input=await body(req);return reply(input.id?200:201,drama.saveSkill(input));}
      if(parts.length===2&&method==='GET') return reply(200,drama.skill(id!,version(url)));
      if(parts.length===2&&method==='DELETE') return reply(200,drama.retireSkill(id!,parse(z.number().int().positive(),(await body(req)).expectedVersion)));
    }
    if(resource==='templates') {
      if(parts.length===1&&method==='GET') return reply(200,drama.listTemplates());
      if(parts.length===1&&method==='POST') { const input=await body(req,textRequestBytes);return reply(input.id?200:201,drama.saveTemplate(input)); }
      if(parts.length===2&&method==='GET') return reply(200,drama.template(id!,version(url)));
      if(parts.length===3&&section==='versions'&&method==='GET') return reply(200,drama.templateHistory(id!));
      if(parts.length===2&&method==='DELETE') return reply(200,drama.retireTemplate(id!,parse(z.number().int().positive(),(await body(req)).expectedVersion)));
    }
    if(resource!=='projects') return false;
    if(parts.length===1&&method==='GET') return reply(200,drama.listProjects(url.searchParams.get('archived')==='1'));
    if(parts.length===1&&method==='POST') return reply(201,drama.createProject(await body(req)));
    if(!id) return false;
    if(parts.length===3&&method==='POST'&&section==='archive') return reply(200,workflow.archiveProject(id));
    if(parts.length===3&&method==='POST'&&section==='restore') return reply(200,drama.restoreProject(id));
    if(parts.length===2&&method==='DELETE') {
      const {archivedAt}=parse(z.object({archivedAt:z.string().min(1).max(64)}).strict(),await body(req));
      await studio.drama!.deleteArchivedProject(id,archivedAt);
      return reply(200,{deleted:true});
    }
    drama.project(id);
    if(section==='node-runs'&&item&&subsection==='history'&&parts.length===5&&method==='GET') return reply(200,await workflow.history(id,item,parse(z.number().int().min(0).max(1000000),Number(url.searchParams.get('offset')??0))));
    if(parts.length===2&&method==='GET') return reply(200,{project:drama.project(id),graph:drama.graph(id),documents:drama.listDocuments(id),runs:workflow.list(id)});
    if(parts.length===3&&section==='graph') {
      if(method==='GET') return reply(200,drama.graph(id,version(url)));
      if(method==='PUT') {
        const input=await body(req,textRequestBytes);
        return reply(200,drama.saveGraph(id,parse(z.number().int().positive(),input.expectedVersion),input));
      }
    }
    if(section==='editor-agent'&&parts.length===3&&method==='POST') {
      return reply(200,drama.bindEditor(id,parse(key,(await body(req)).agentId)));
    }
    if(section==='annotations') {
      if(parts.length===3&&method==='GET') return reply(200,annotations.list(id));
      if(parts.length===3&&method==='POST') return reply(201,annotations.add(id,await body(req)));
      if(parts.length===5&&subsection==='dispatch'&&method==='POST') return reply(200,annotations.dispatch(id,item!));
      if(parts.length===5&&subsection==='source'&&method==='GET') return reply(200,annotations.sourceVersions(id,item!));
      if(parts.length===4&&method==='POST') return reply(200,annotations.resolve(id,item!,await body(req,textRequestBytes)));
    }
    if(section==='artifacts'&&parts.length===5&&subsection==='episodes') {
      if(method==='GET') return reply(200,episodes.forArtifact(id,item!));
      if(method==='POST') return reply(200,episodes.associate(id,item!,await body(req)));
    }
    if(section==='documents'&&parts.length===5&&subsection==='artifacts'&&method==='GET') {
      const revision=version(url)??drama.document(id,item!).version;
      return reply(200,episodes.forDocument(id,item!,revision));
    }
    if(section==='artifacts'&&parts.length===4&&method==='GET') return reply(200,workflow.artifact(id,item!));
    if(section==='node-runs'&&parts.length===5&&subsection==='reviews'&&method==='GET') return reply(200,workflow.reviewHistory(id,item!));
    if(section==='node-runs'&&parts.length===7&&subsection==='children'&&parts[6]==='actions'&&method==='POST') {
      const child=parse(z.object({action:z.enum(['pause','resume']),requestId:key}),await body(req));
      return reply(200,await workflow.childAction(id,item!,parts[5]!,child.action,child.requestId));
    }
    if(section==='node-runs'&&parts.length===7&&subsection==='children'&&parts[6]==='retry'&&method==='POST') {
      return reply(200,await workflow.retryChild(id,item!,parts[5]!,parse(key,(await body(req)).requestId)));
    }
    if(section==='documents') {
      if(parts.length===3&&method==='POST') return reply(201,drama.saveDocument(id,await body(req,32*1024*1024)));
      if(parts.length===3&&method==='GET') return reply(200,drama.listDocuments(id));
      if(parts.length===4&&method==='GET') return reply(200,drama.document(id,item!,version(url)));
      if(parts.length===5&&subsection==='source'&&method==='GET') {
        const source=drama.readDocumentSource(id,item!,version(url));file(res,'application/octet-stream',source.name,source.bytes);return true;
      }
    }
    if(section==='comments'&&parts.length===3) {
      if(method==='GET') return reply(200,drama.listEpisodeComments(id));
      if(method==='POST') return reply(201,drama.addEpisodeComment(id,await body(req)));
    }
    if(section==='memory'&&method==='GET') {
      drama.project(id);
      if(parts.length===3) return reply(200,memory.projectDirectory(id,parse(z.number().int().min(0).max(100000),Number(url.searchParams.get('offset')??0))));
      if(parts.length===4) {
        const entry=memory.projectNote(id,item!);
        if(!entry) throw new DramaStoreError(404,'记忆不存在');
        return reply(200,entry);
      }
    }
    if(section==='node-inputs'&&parts.length===4) {
      if(method==='GET') return reply(200,workflow.nodeInputs(id,item!));
      if(method==='PUT') return reply(200,workflow.saveNodeInputs(id,item!,parse(overrides,await body(req,textRequestBytes))));
    }
    if(section==='runs'&&item&&subsection==='stop'&&parts.length===5&&method==='POST') {
      return reply(202,workflow.stopPlan(id,item));
    }
    if(section==='runs'&&parts.length===3) {
      if(method==='GET') return reply(200,workflow.list(id));
      if(method==='POST') return reply(201,workflow.start(id,parse(start,await body(req,textRequestBytes))));
    }
    if(section==='editor'&&parts.length===3) {
      if(method==='GET') {
        const current=workflow.editor(id);
        return reply(200,{...current,annotationLinks:annotations.links(id,current.sessionId),receipts:editorControls(studio.drama!.store)!.receipts(id,current.sessionId)});
      }
      if(method==='POST') return reply(202,await workflow.editorMessage(id,parse(editor,await body(req,textRequestBytes))));
    }
    if(section==='editor'&&item==='agent-proposals'&&subsection&&parts.length===5) {
      const control=editorControls(studio.drama!.store)!;
      if(method==='GET')return reply(200,control.agentProposal(id,subsection));
      if(method==='POST')return reply(200,control.confirmAgent(id,subsection,await body(req,textRequestBytes),(await studio.snapshot()).models));
    }
    if(section==='editor'&&item==='proposals'&&subsection&&parts.length===5) {
      const control=editorControls(studio.drama!.store)!;
      if(method==='GET')return reply(200,control.proposal(id,subsection));
      if(method==='POST')return reply(200,control.confirm(id,subsection,await body(req,textRequestBytes)));
    }
    if(section==='editor'&&item==='sessions') {
      if(parts.length===4&&method==='POST') return reply(201,workflow.newEditor(id,parse(z.object({requestId:key,agentId:key.optional()}),await body(req))));
      if(parts.length===5&&method==='PUT') return reply(200,workflow.switchEditor(id,subsection!));
    }
    if(section==='node-runs'&&parts.length===5&&method==='POST') {
      if(subsection==='review') return reply(200,workflow.review(id,item!,parse(review,await body(req,textRequestBytes))));
      if(subsection==='actions') return reply(200,await workflow.action(id,item!,parse(action,await body(req))));
    }
    if(section==='artifacts'&&parts.length===5&&subsection==='export'&&method==='GET') {
      const format=parse(z.enum(['docx','md']),url.searchParams.get('format')??'docx');
      const result=workflow.export(id,item!,format);file(res,result.mime,result.filename,result.bytes,result.hash);return true;
    }
    return false;
  };
}
