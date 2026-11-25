// Each local edit is saved against the last acknowledged revision of this canvas.
const recoveryKey = draft => 'drama.canvas.pending.' + draft.scope + '.' + draft.id;
const path = draft => '/canvas-drafts/' + draft.scope + '/' + encodeURIComponent(draft.id);

function content(draft) {
  return {
    baseVersion: draft.baseVersion, sourceVersion: draft.sourceVersion,
    nodes: draft.graph.nodes, edges: draft.graph.edges,
    ...(draft.item ? {name: draft.item.name, description: draft.item.description || ''} : {}),
    ...(draft.proposalId ? {proposalId: draft.proposalId} : {}),
  };
}
function restore(draft, row) {
  draft.graph = {version:row.sourceVersion, nodes: row.nodes, edges: row.edges};
  draft.baseVersion = row.baseVersion;
  draft.sourceVersion = row.sourceVersion;
  draft.proposalId = row.proposalId;
  if (draft.item) Object.assign(draft.item,{name:row.name,description:row.description});
}
function fingerprint(value) {
  return JSON.stringify([value.baseVersion,value.sourceVersion,value.name || '',value.description || '',value.proposalId || '',
    value.nodes.map(n=>[n.id,n.title,n.agentId,n.instruction || '',n.inputRule || '',n.outputRule || '',n.release,n.x,n.y]),
    value.edges.map(e=>[e.from,e.to])]);
}
function remember(draft) {
  try { sessionStorage.setItem(recoveryKey(draft), JSON.stringify({revision:draft.revision, sent:draft.sent, replaceSource:draft.replaceSource, value:content(draft)})); }
  catch { /* Browser storage is optional; the server write still runs and beforeunload guards unacknowledged edits. */ }
}
export function forgetCanvasRecovery(draft) {
  try { sessionStorage.removeItem(recoveryKey(draft)); } catch { /* Browser storage may be unavailable. */ }
}
export async function hydrateCanvas(api, draft, ignoreLocal = false) {
  const {draft:row} = await api(path(draft));
  draft.revision = row?.revision ?? null;
  if (row) restore(draft,row);
  let recovery;
  if (!ignoreLocal) {
    try { recovery=JSON.parse(sessionStorage.getItem(recoveryKey(draft)) || 'null'); } catch { /* The server draft still loads. */ }
  }
  if (recovery) {
    const server = row && fingerprint(row);
    if (server === fingerprint(recovery.value)) forgetCanvasRecovery(draft);
    else {
      restore(draft,recovery.value);
      draft.dirty = true;
      draft.replaceSource = recovery.replaceSource;
      if (draft.revision !== recovery.revision && (!server || recovery.sent !== server)) {
        draft.conflict = true;
        draft.error = '草稿已在其他窗口变更。载入已保存草稿前，可以复制本页的修改。';
      }
    }
  }
  return row || recovery ? draft : null;
}
export function saveCanvasDraft(api, draft, update) {
  if (draft.pending) return draft.pending;
  if (draft.conflict) return Promise.reject(new Error(draft.error));
  if (!draft.dirty) return Promise.resolve();
  draft.pending = Promise.resolve().then(async () => {
    while (draft.dirty) {
      const data = structuredClone(content(draft));
      draft.sent = fingerprint(data);
      remember(draft);
      const result = await api(path(draft), {method:'PUT',body:{...data,expectedRevision:draft.revision,...(draft.replaceSource?{replaceSource:true}:{})}});
      draft.revision = result.draft.revision;
      draft.replaceSource = false;
      draft.dirty = draft.sent !== fingerprint(content(draft));
      draft.sent = null;
      if (!draft.dirty) forgetCanvasRecovery(draft);
      else remember(draft);
    }
    draft.error = '';
  }).catch(error => {
    draft.error = error.message;
    draft.conflict = error.status === 409;
    throw error;
  }).finally(() => {
    draft.pending = null;
    update(draft);
  });
  return draft.pending;
}
export function changedCanvas(api, draft, update) {
  draft.dirty = true;
  remember(draft);
  void saveCanvasDraft(api,draft,update).catch(() => {});
}
export async function finishCanvas(api, draft, publish, update) {
  if (publish) await saveCanvasDraft(api,draft,update);
  else {
    try { await draft.pending; } catch { /* Discard also works if the last edit could not be saved. */ }
    if (draft.error || draft.dirty) {
      const {draft:current}=await api(path(draft));
      if (current && draft.sent === fingerprint(current)) draft.revision=current.revision;
      if ((current?.revision ?? null)!==draft.revision) {
        const error=new Error('草稿已在其他窗口变更，请先载入已保存草稿。');
        error.status=409;
        throw error;
      }
    }
  }
  if (draft.revision) {
    const result = await api(path(draft) + (publish ? '/publish' : ''), {method:publish?'POST':'DELETE',body:{expectedRevision:draft.revision}});
    forgetCanvasRecovery(draft);
    return result;
  }
  forgetCanvasRecovery(draft);
}
function excerpt(value, offset=0) {
  if (!value) return '空';
  const start=Math.max(0,offset-10);
  return (start?'…':'')+value.slice(start,start+64).replace(/\s+/g,' ')+(value.length>start+64?'…':'');
}

export function graphChanges(current, draft, agentName=id=>id) {
  const old = new Map(current.nodes.map(n=>[n.id,n]));
  const next = new Map(draft.graph.nodes.map(n=>[n.id,n]));
  const changes = [];
  if (draft.item && (draft.item.name !== (current.name || '') || (draft.item.description || '') !== (current.description || ''))) {
    if (draft.item.name !== (current.name || '')) changes.push('模板名称：' + draft.item.name);
    if ((draft.item.description || '') !== (current.description || '')) changes.push('修改模板说明');
  }
  const fields = {title:'名称',agentId:'Agent',instruction:'执行指令',inputRule:'输入检查',outputRule:'输出检查',release:'放行条件'};
  for (const node of draft.graph.nodes) {
    const prev = old.get(node.id);
    if (!prev) { changes.push('添加节点「' + node.title + '」'); continue; }
    for (const [field,label] of Object.entries(fields)) {
      const before=prev[field] || '', after=node[field] || '';
      if (before===after) continue;
      let change;
      if (field==='agentId') change=(agentName(before)||'未配置')+' → '+(agentName(after)||'未配置');
      else if (field==='release') change=(before==='manual'?'人工批准':'自动放行')+' → '+(after==='manual'?'人工批准':'自动放行');
      else {
        let offset=0;
        while (offset<before.length && before[offset]===after[offset]) offset++;
        change=excerpt(before,offset)+' → '+excerpt(after,offset);
      }
      const summary='修改「'+prev.title+'」的'+label+'：'+change;
      if (['instruction','inputRule','outputRule'].includes(field) && (before.length>64 || after.length>64)) {
        changes.push({summary,before,after});
      } else changes.push(summary);
    }
    if (prev.x!==node.x || prev.y!==node.y) changes.push('移动「'+node.title+'」：('+prev.x+', '+prev.y+') → ('+node.x+', '+node.y+')');
  }
  for (const node of old.values()) if (!next.has(node.id)) changes.push('删除节点「' + node.title + '」');
  const key = e => e.from+'>'+e.to;
  const oldEdges = new Set(current.edges.map(key)), newEdges = new Set(draft.graph.edges.map(key));
  const edgeName = (e,nodes) => (nodes.get(e.from)?.title || e.from) + ' → ' + (nodes.get(e.to)?.title || e.to);
  for (const edge of draft.graph.edges) if (!oldEdges.has(key(edge))) changes.push('连接 ' + edgeName(edge,next));
  for (const edge of current.edges) if (!newEdges.has(key(edge))) changes.push('断开 ' + edgeName(edge,old));
  return changes;
}
