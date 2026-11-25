/** Current delivery and its ancestors, nearest first. Only the active run can supply these sources. */
import type {StudioStore} from './store.js';
import type {DeliveryView, TaskView} from './types.js';

export function taskInputSources(store:StudioStore, delivery:DeliveryView, task?:TaskView): string[] {
  const sources=[delivery.text];
  const seen=new Set<string>();
  let next=task?.parentTaskId;
  while (next && !seen.has(next)) {
    seen.add(next);
    const parent=store.task(next);
    if (!parent || parent.runId!==delivery.runId || parent.drama?.projectId!==task?.drama?.projectId) break;
    sources.push(parent.prompt);
    next=parent.parentTaskId;
  }
  return sources;
}

/** Large inputs remain in the pinned task record. A preview and page references travel with the session on every recovery. */
export function presentTaskInputs(sources: string[], progressive:boolean) {
  const paged=progressive && sources.reduce((size,value)=>size+value.length,0)>16_000;
  const excerpts=paged?sources.map(value=>value.slice(0,1200)):sources;
  return {
    text:excerpts[0],
    ...(excerpts.length>1 ? {sourceInstructions:excerpts.slice(1).reverse()}:{}),
    ...(paged ? {inputPages:sources.map((value,source)=>({source,characters:value.length,previewCharacters:excerpts[source]!.length})),
      readInputs:'长输入仅在此展示开头。使用 drama_read_input 按 source、offset 分页或用 find 定位原文。0 为当前投递，1 为直接上级任务，依次向上。按需要读取或委派，引用前核对原文。'}:{}),
  };
}

export function readInputPage(sources:string[],source:number,offset:number,limit:number,find?:string) {
  const content=sources[source];
  if (content===undefined) throw new Error('当前任务没有这份输入');
  const start=find===undefined?Math.min(content.length,offset):content.indexOf(find,offset);
  if (start<0) return {source,totalCharacters:content.length,found:false};
  const end=Math.min(start+limit,content.length);
  return {source,totalCharacters:content.length,start,content:content.slice(start,end),nextOffset:end<content.length?end:null};
}
