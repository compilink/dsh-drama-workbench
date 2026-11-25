import { mountSearchSettings } from '/drama-search-settings.js';
import { hydrateCanvas, changedCanvas, saveCanvasDraft, finishCanvas, forgetCanvasRecovery, graphChanges } from '/drama-canvas-draft.js';
import { parseMaterial } from '/drama-material.js';

const nav = document.querySelector('#topnav');
const main = document.querySelector('#main');
const modal = document.querySelector('#modal');
const toast = document.querySelector('#toast');
const connection = document.querySelector('#connection-status');
const state = {
  page: 'library', section: 'workflow', projects: [], archivedProjects: [], libraryArchived: false, agents: [], models: [], templates: [], skills: [],
  snapshot: null, draft: null, previewDraft: null, selected: new Set(), inputDrafts: new Map(),
  nodeTab: 'inputs', episodePage: 1, perPage: 50, linkFrom: null, memoryOffset: 0,
};
const STATUS = {
  waiting: '等待上游或输入', queued: '已排队', running: '执行中', paused: '已暂停',
  pause_requested: '暂停中', checking_output: '正在检查输出', failed: '执行失败', rejected: '已退回', review: '待人工审核',
  released: '已放行', cancelled: '已停止', stopping:'停止中', 'output-blocked': '输出检查未通过',
};
const ROLE = {orchestrator:'Orchestrator · 总编', manager:'Manager · 协调', worker:'Worker · 执行'};
const TASK_STATUS = {queued:'排队中',running:'执行中',paused:'已暂停',review:'等待协调者验收',completed:'已完成',blocked:'需处理',failed:'失败',cancelled:'已停止'};
const CHECK_STATUS = {pending:'等待检查',running:'正在检查',passed:'通过',failed:'未通过',unknown:'无法判定'};
const activeAgents = () => state.agents.filter(agent => !agent.retired);
function nodeStatus(round) {
  if (!round) return '未执行';
  if (round.status === 'rejected') {
    if (['failed','unknown'].includes(round.outputCheck?.status)) return '输出检查' + CHECK_STATUS[round.outputCheck.status];
    return round.artifact ? '人工退回' : 'Agent 退回';
  }
  if (round.awaitingAgentReview) return '待 Agent 验收';
  return STATUS[round.status] || round.status;
}
const GRAPH_CARD = { width: 168, height: 70 };
const pageLabels = [['library', '作品库'], ['work', '创作台'], ['templates', '模板库'], ['agents', 'Agent'], ['connections', '连接']];
const sectionLabels = [['workflow', '工作流'], ['materials', '资料设定'], ['episodes', '分集'], ['delivery', '成果导出']];
const hasActiveRun = new Set(['waiting', 'paused', 'queued', 'running', 'pause_requested', 'checking_output', 'stopping']);
const fileTypes = '.docx,.txt,.md,.markdown,.csv,.tsv,.json';
const escape = (value = '') => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const segment = encodeURIComponent;
const modelKey = model => JSON.stringify([model.provider, model.model]);
let refreshError = '';
let modelRefresh;
const projectPath = () => '/projects/' + segment(state.snapshot.project.id);
const docKey = ({ id, version }) => id + ':' + version;
const runningOn = node => state.snapshot?.runs.flatMap(run => run.nodes).filter(round => round.nodeId === node) || [];
const lastRound = node => runningOn(node).at(-1);
const agentById = id => state.agents.find(agent => agent.id === id);
const picked = () => [...state.selected];
const graph = () => state.draft?.graph ?? state.snapshot?.graph;
const activeNode = () => graph()?.nodes.find(node => node.id === picked().at(-1));
const isTemplate = () => state.draft?.scope === 'template';
const blankGraph = () => ({nodes: [], edges: []});
const baseline = () => isTemplate() ? (state.templates.find(t=>t.id===state.draft.id) || blankGraph()) : state.snapshot.graph;
let canvasMenu;
let csrf, toastTimer, pointer, skipClickUntil = 0;
const pendingModelProbes = new Set();

function button(label, action, style = '', extra = '') {
  return '<button type="button" class="btn ' + style + '" data-action="' + escape(action) + '" ' + extra + '>' + escape(label) + '</button>';
}

function badge(label, color = '') {
  return '<span class="pill ' + color + '">' + escape(label) + '</span>';
}

function heading(title, actions = '', subtitle = '') {
  return '<div class="hero"><div><h1>' + escape(title) + '</h1>' + (subtitle ? '<p class="small">' + escape(subtitle) + '</p>' : '') + '</div><div class="row wrap">' + actions + '</div></div>';
}

function notice(message) {
  toast.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.textContent = ''; }, 4500);
}

function showModal(title, body) {
  modal.innerHTML = '<div class="modal-inner"><div class="row between wrap"><h2 id="modal-title">' + escape(title) + '</h2>' + button('关闭', 'close', 'text') + '</div>' + body + '</div>';
  if (!modal.open) modal.showModal();
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch('/api/drama' + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Studio-CSRF': csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    const error = new Error(result.error || '请求未完成（' + response.status + '）');
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? undefined : response.json();
}

async function loadCatalog() {
  [state.projects, state.agents, state.templates, state.models, state.skills, state.protocol] = await Promise.all([
    api('/projects'), api('/agents?includeRetired=1'), api('/templates'), api('/models'), api('/skills'), api('/protocol'),
  ]);
  updateModelStatus();
}

function updateModelStatus() {
  connection.textContent = state.models.some(model => !model.demo) ? 'DSH 模型已列出' : state.models.length ? '仅演示模型' : '暂无 DSH 模型';
}

async function refreshModels() {
  if (modelRefresh) return modelRefresh;
  modelRefresh = (async () => {
    try {
      state.models = await api('/models/refresh', {method: 'POST', body: {}});
      refreshError = '';
      updateModelStatus();
      return true;
    } catch (error) {
      refreshError = '模型目录刷新失败，保留上次列表。' + error.message;
      return false;
    } finally {
      modelRefresh = undefined;
      if (state.page === 'connections') render();
    }
  })();
  if (state.page === 'connections') render();
  return modelRefresh;
}

async function reloadProject() {
  const project = state.snapshot?.project.id;
  if (!project) return;
  try {
    const next = await api(projectPath());
    if (state.snapshot?.project.id === project) state.snapshot = next;
  } catch (error) {
    if (state.snapshot?.project.id !== project || ![404, 409].includes(error.status)) throw error;
    clearCurrentProject(project);
    await showLibrary(error.status === 409);
    notice(error.message);
  }
}

async function openProject(id) {
  const [result, stored] = await Promise.all([
    api('/projects/' + segment(id)),
    hydrateCanvas(api, {scope:'project',id}),
  ]);
  state.snapshot = result;
  state.previewDraft = null;
  state.page = 'work';
  state.libraryArchived = false;
  state.section = 'workflow';
  state.draft = stored;
  state.selected = new Set(graph().nodes.slice(0, 1).map(node => node.id));
  state.inputDrafts.clear();
  state.nodeTab = 'inputs';
  state.episodePage = 1;
  state.memoryOffset = 0;
  const url = new URL(location.href);
  url.searchParams.delete('page');
  url.searchParams.delete('template');
  url.searchParams.set('project', id);
  history.replaceState(null, '', url);
  render();
  if (stored?.dirty && !stored.conflict) changedCanvas(api, stored, refreshDraftStatus);
  if (!stored && activeNode()) {
    await fetchInputs(activeNode().id);
    if (state.snapshot?.project.id === id) render();
  }
}

function renderingProject() {
  return state.page === 'work' && state.snapshot;
}

function positionGraph() {
  const canvas = main.querySelector('.graph-canvas');
  if (!canvas) return;
  const { nodes } = graph();
  const width = Math.max(1080, ...nodes.map(node => node.x + 210));
  const height = Math.max(520, ...nodes.map(node => node.y + 120));
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  const svg = canvas.querySelector('svg');
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  for (const card of canvas.querySelectorAll('[data-node-card]')) {
    const node = nodes.find(item => item.id === card.dataset.nodeCard);
    card.style.left = node.x + 'px';
    card.style.top = node.y + 'px';
  }
  drawEdges();
}

function pathFrom(a, b) {
  const x1 = a.x + GRAPH_CARD.width / 2;
  const y1 = a.y + GRAPH_CARD.height;
  const x2 = b.x + GRAPH_CARD.width / 2;
  const y2 = b.y - 2;
  const bend = Math.max(18, Math.min(Math.abs(y2 - y1) * 0.46, 73));
  return 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (y1 + bend) + ', ' + x2 + ' ' + (y2 - bend) + ', ' + x2 + ' ' + y2;
}

function drawEdges() {
  const container = main.querySelector('#graph-edges');
  if (!container) return;
  const canvas = graph();
  const nodes = new Map(canvas.nodes.map(node => [node.id, node]));
  container.innerHTML = canvas.edges.filter(({ from, to }) => nodes.has(from) && nodes.has(to)).map(({ from, to }) => {
    const blocked = !state.draft && !availableUpstream(from, to);
    return '<path class="graph-link ' + (blocked ? 'blocked' : '') + '" d="' + pathFrom(nodes.get(from), nodes.get(to)) + '" marker-end="url(#graph-arrow)"></path>';
  }).join('');
}

function availableUpstream(from, to) {
  const target = lastRound(to);
  const rounds = runningOn(from);
  if (target && hasActiveRun.has(target.status)) {
    const bound = target.sources?.find(source => source.nodeId === from);
    const adopted = target.handoff?.find(source => source.nodeId === from);
    if (adopted) return adopted;
    if (bound?.producerId) {
      const producer = rounds.find(round => round.id === bound.producerId);
      return producer?.status === 'released' ? producer.artifact : undefined;
    }
    if (bound?.artifactId) return rounds.find(round => round.artifact?.id === bound.artifactId && round.status === 'released')?.artifact;
  }
  return rounds.findLast(round => round.status === 'released')?.artifact;
}

function render() {
  closeCanvasMenu();
  const previous = main.querySelector('#graph-scroll');
  const offset = previous && [previous.scrollLeft, previous.scrollTop];
  const focus = document.activeElement?.dataset.action;
  nav.innerHTML = pageLabels.map(([id, label]) => '<button type="button" data-action="page:' + id + '" ' + (state.page === id ? 'aria-current="page"' : '') + '>' + label + '</button>').join('');
  if (isTemplate()) main.innerHTML = heading(state.draft.item.name, button('名称与说明', 'template-details', 'text'), '模板草案') + graphView();
  else if (renderingProject()) main.innerHTML = workView();
  else if (state.page === 'agents') main.innerHTML = agentsView();
  else if (state.page === 'templates') main.innerHTML = templatesView();
  else if (state.page === 'connections') main.innerHTML = connectionsView();
  else main.innerHTML = libraryView();
  if (state.page === 'connections') mountSearchSettings(main.querySelector('#search-settings'), api);
  positionGraph();
  if (offset) main.querySelector('#graph-scroll')?.scrollTo(...offset);
  if (focus && !modal.open) {
    [...document.querySelectorAll('[data-action]')].find(item => item.dataset.action === focus)?.focus({ preventScroll: true });
  }
}

function clearCurrentProject(id) {
  if (state.snapshot?.project.id !== id) return;
  state.snapshot = null;
  state.previewDraft = null;
  if (!isTemplate()) {
    state.selected.clear();
    state.draft = null;
    state.linkFrom = null;
  }
  state.inputDrafts.clear();
  if (state.page === 'work') {
    state.page = 'library';
    if (modal.open) modal.close();
  }
  const url = new URL(location.href);
  if (url.searchParams.get('project') === id) {
    url.searchParams.delete('project');
    history.replaceState(null, '', url);
  }
}

async function loadProjects(archived) {
  if (archived) {
    state.archivedProjects = await api('/projects?archived=1');
  } else {
    state.projects = await api('/projects');
    const current = state.snapshot?.project.id;
    if (current && !state.projects.some(project => project.id === current)) clearCurrentProject(current);
  }
}

async function showLibrary(archived) {
  state.page = 'library';
  state.libraryArchived = archived;
  const url = new URL(location.href);
  url.searchParams.delete('project');
  if (archived) url.searchParams.set('page', 'archive');
  else url.searchParams.delete('page');
  history.replaceState(null, '', url);
  await loadProjects(archived);
  if (state.page === 'library' && state.libraryArchived === archived) render();
}

function libraryView() {
  const archived = state.libraryArchived;
  const projects = archived ? state.archivedProjects : state.projects;
  const cards = projects.map(project => {
    const actions = archived
      ? (project.deleting ? '' : button('恢复', 'restore-project:' + project.id, 'light')) +
        button(project.deleting ? '重试删除' : '永久删除', 'delete-project:' + project.id, 'text destructive')
      : button('打开', 'project:' + project.id, 'light') + button('归档', 'archive-project:' + project.id, 'text');
    return '<article class="paper item-card"><div class="row between"><h2>' + escape(project.name) + '</h2>' +
      badge(project.deleting ? '待完成删除' : '画布 v' + project.graphVersion) + '</div>' +
      (project.description ? '<p>' + escape(project.description) + '</p>' : '') +
      (project.templateId ? '<p class="small">模板 v' + project.templateVersion + '</p>' : '') +
      '<div class="row wrap">' + actions + '</div></article>';
  }).join('');
  const tabs = '<nav class="work-nav" aria-label="作品状态">' +
    button('创作中', 'library-filter:active', '', 'aria-current="' + !archived + '"') +
    button('已归档', 'library-filter:archived', '', 'aria-current="' + archived + '"') + '</nav>';
  const empty = archived ? '暂无已归档作品。' : '还没有创作中的作品。可从空白画布或工作流模板开始。';
  return heading('作品库', archived ? '' : button('新建作品', 'new-project', 'primary')) + tabs +
    (cards ? '<div class="grid-cards compact-library">' + cards + '</div>' : '<div class="paper pad"><p>' + empty + '</p></div>');
}

async function changeProjectState(action, id) {
  const archived = action !== 'archive-project';
  const project = (archived ? state.archivedProjects : state.projects).find(item => item.id === id);
  if (!project) return;
  const path = '/projects/' + segment(id);
  if (action === 'delete-project' && !window.confirm('永久删除《' + project.name + '》？本作品的剧稿、资料、附件和运行记录都将删除，无法撤销。')) return;
  try {
    if (action === 'delete-project') await api(path, {method: 'DELETE', body: {archivedAt: project.archivedAt}});
    else await api(path + (archived ? '/restore' : '/archive'), {method: 'POST', body: {}});
  } catch (error) {
    await loadProjects(archived);
    render();
    throw error;
  }
  if (action !== 'restore-project') clearCurrentProject(id);
  await loadProjects(archived);
  render();
  notice(action === 'archive-project' ? '已归档，可在「已归档」中恢复。' : action === 'restore-project' ? '已恢复到「创作中」。' : '作品已永久删除。');
}

function workView() {
  const { project } = state.snapshot;
  const content = state.section === 'workflow' ? graphView() : state.section === 'materials' ? documentsView() : state.section === 'episodes' ? episodesView() : deliveryView();
  return heading('《' + project.name + '》', button('作品总编', 'project-editor', 'text') + button('总编对话', 'editor', 'light'), project.description) + '<nav class="work-nav" aria-label="作品导航">' +
    sectionLabels.map(([id, label]) => '<button type="button" data-action="section:' + id + '" ' + (state.section === id ? 'aria-current="true"' : '') + '>' + label + '</button>').join('') + '</nav>' + content;
}

function graphView() {
  const current = graph();
  const selected = picked();
  const editing = Boolean(state.draft);
  const changes = editing ? graphChanges(baseline(), state.draft, id=>agentById(id)?.name) : [];
  const toolbar = state.previewDraft ? button('返回草稿','preview-draft','light') : button('＋ 节点', 'new-node', 'light') + (selected.length === 1 ? button('节点设置', 'edit-node', 'text') : '') +
    (selected.length ? button('删除', 'delete-nodes', 'text') : '') +
    (editing && !isTemplate() ? button('查看生效画布','preview-published','light') : '') +
    (editing ? button('放弃草稿', 'cancel-graph', 'text') : '') +
    button(isTemplate() ? '保存新版本' : state.draft?.proposalId ? '保存总编草案' : '保存', 'save-graph', 'primary',
      !editing || (!changes.length && !state.draft.proposalId && state.draft.id !== 'new') || state.draft.locked || state.draft.conflict ? 'disabled' : '');
  const cards = current.nodes.map(node => {
    const on = state.selected.has(node.id);
    const round = isTemplate() ? null : lastRound(node.id);
    const label = round ? nodeStatus(round) : node.release === 'manual' ? '人工批准' : '自动放行';
    const makePort = (way, title) => state.previewDraft ? '<span class="graph-port"></span>' : '<button type="button" class="graph-port ' + (way === 'out' && state.linkFrom === node.id ? 'active' : '') + '" data-action="port-' + way + ':' + escape(node.id) + '" data-port-' + way + '="' + escape(node.id) + '" aria-label="' + escape(title + ' ' + node.title) + '"></button>';
    return '<article class="graph-node ' + (on ? 'selected' : '') + '" data-node-card="' + escape(node.id) + '"><div class="graph-port-row in">' + makePort('in', '连接到') + '</div>' +
      '<button type="button" class="graph-drag" data-drag-node="' + escape(node.id) + '" aria-label="移动节点 ' + escape(node.title) + '" ' + (state.previewDraft?'disabled':'') + '>⠿</button>' +
      '<button type="button" class="node-check" data-action="multi-select:' + escape(node.id) + '" aria-label="多选 ' + escape(node.title) + '" aria-pressed="' + on + '">' + (on ? '✓' : '') + '</button>' +
      '<button class="graph-title" type="button" data-action="select:' + escape(node.id) + '" aria-pressed="' + on + '">' + escape(node.title) + '</button>' +
      '<div class="graph-meta"><span>' + escape(agentById(node.agentId)?.name || '未配置 Agent') + '</span>' + badge(label, round?.status === 'released' ? 'green' : 'amber') + '</div><div class="graph-port-row out">' + makePort('out', '从节点连出') + '</div></article>';
  }).join('');
  const canvas = '<div id="graph-scroll" class="graph-scroll" tabindex="0" aria-label="工作流节点图"><div class="graph-canvas">' +
    '<svg class="graph-svg" aria-hidden="true"><defs><marker id="graph-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7Z" fill="#6f8275"></path></marker></defs><g id="graph-edges"></g><path id="graph-drag-wire" class="graph-link drag-wire"></path></svg>' +
    (cards || '<p class="graph-empty small">添加节点后，拖动连线建立依赖。</p>') + '</div></div>';
  return '<section class="paper flow-board"><div class="flow-head"><div class="work-summary"><h2>节点图</h2>' + badge(editing ? (state.draft.proposalId ? '总编草案 · 基于 v' + current.version : '草案') : 'v' + current.version) +
    '</div><div class="row wrap">' + toolbar + '</div></div>' + canvas +
    '<div class="row between wrap graph-help"><p class="small">' + (state.previewDraft?'当前显示已生效画布。':'右键空白处添加节点，右键节点打开设置或删除。从输出端口拖到输入端口可连接节点。') + '</p>' +
    (selected.length ? '<a class="small" href="#node-detail">节点面板 ↓</a>' : '') + '</div>' +
    (editing ? '<section class="draft-changes"><div class="row between wrap"><h3>待生效变更</h3><span id="canvas-save-status" role="status" class="small">' +
      draftStatus() + '</span></div>' + (changes.length ? '<ul>' + changes.map((change,index)=>typeof change==='string' ? '<li>'+escape(change)+'</li>' :
        '<li><details data-change-index="'+index+'"><summary>'+escape(change.summary)+'</summary></details></li>').join('') + '</ul>' :
      '<p class="small">与当前生效画布一致。</p>') + '</section>' : '') + '</section>' + nodePanel();
}

main.addEventListener('toggle', event=>{
  const target=event.target;
  if (!target.open || !target.matches('details[data-change-index]') || target.querySelector('pre') || !state.draft) return;
  const change=graphChanges(baseline(),state.draft,id=>agentById(id)?.name)[Number(target.dataset.changeIndex)];
  if (typeof change==='object') target.insertAdjacentHTML('beforeend','<h4>变更前</h4><pre>'+escape(change.before || '空')+'</pre><h4>变更后</h4><pre>'+escape(change.after || '空')+'</pre>');
},true);

function nodePanel() {
  const selected = picked();
  const node = activeNode();
  const classes = ' id="node-detail" class="paper flow-detail" tabindex="-1"';
  if (!node) return '<section' + classes + '><p class="small">选择节点后查看详情。</p></section>';
  if (selected.length > 1 && state.draft) return '<section' + classes + '><h2>已选 ' + selected.length + ' 个节点</h2><p class="small">可从草案删除选中的节点。</p></section>';
  const agent = agentById(node.agentId);
  const upstream = graph().edges.filter(edge => edge.to === node.id);
  const inputDetails = '<div class="data-line"><h3>依赖</h3>' + (upstream.length ? '<ul class="preflight-list">' + upstream.map(({ from }) => {
    const source = graph().nodes.find(item => item.id === from);
    const round = isTemplate() ? null : lastRound(from);
    const available = state.draft ? undefined : availableUpstream(from, node.id);
    const availability = available ? ' · 可用 v' + available.version : round ? ' · ' + escape(nodeStatus(round)) : '';
    return '<li class="preflight-item row between"><span>' + escape(source?.title || from) + availability + '</span>' +
      (state.previewDraft ? '' : button('断开', 'unlink:' + from, 'text')) + '</li>';
  }).join('') + '</ul>' : '<p class="small">无上游节点</p>') + '</div>';
  if (state.draft) return '<section' + classes + '><h2>' + escape(node.title) + '</h2><p class="small">' + escape(agent?.name || '未配置 Agent') + '</p>' + inputDetails + '</section>';

  const rounds = selected.map(lastRound);
  const round = selected.length === 1 ? rounds[0] : undefined;
  const busy = rounds.some(item => item && ['running', 'queued', 'waiting', 'pause_requested', 'paused', 'checking_output', 'stopping'].includes(item.status));
  const pause = rounds.every(item => item && ['waiting', 'queued', 'running'].includes(item.status));
  const resume = rounds.every(item => item?.status === 'paused');
  const actions = (busy ? '' : button(round ? '重跑本节点' : '执行', 'run', 'primary') + button(round ? '重跑本节点及下游' : '执行选中节点及下游', 'run-tree', 'light')) +
    (pause ? button('暂停', 'round-action:pause', 'light') : '') + (resume ? button('恢复', 'round-action:resume', 'primary') : '') +
    (busy && rounds.every(item => item && ['waiting', 'queued', 'running', 'paused','checking_output'].includes(item.status)) ? button('重跑', 'round-action:restart', 'light') : '');
  if (selected.length > 1) {
    const list = selected.map(id => '<li class="preflight-item">' + escape(graph().nodes.find(item => item.id === id)?.title) + ' · ' + escape(nodeStatus(lastRound(id))) + '</li>').join('');
    return '<section' + classes + '><div class="section-title"><h2>已选 ' + selected.length + ' 个节点</h2><div class="row wrap">' + actions + '</div></div><ul class="preflight-list">' + list + '</ul></section>';
  }

  const tabs = [['inputs', '输入'], ['review', '审稿'], ['history', '历史']].map(([id, label]) => button(label, 'node-tab:' + id, 'flow-tab', 'aria-current="' + (state.nodeTab === id) + '"')).join('');
  const inputs = inputsFor(node);
  const show = state.nodeTab === 'review' ? reviewPanel(round) : state.nodeTab === 'history' ? historyPanel(node) :
    inputDetails + handoffView(round?.handoff) + checkView('输入检查', round?.inputCheck) + '<div class="data-line"><div class="row between wrap"><h3>执行指令与输入文件</h3>' + (busy ? '' : button('编辑输入', 'edit-inputs', 'light')) +
      '</div><p class="preserve">' + escape(inputs.instruction || '未设置执行指令') + '</p>' +
      (inputs.documents.length ? '<ul class="node-input-files">' + inputs.documents.map(ref => '<li>' + escape(state.snapshot.documents.find(doc => doc.id === ref.id)?.name || ref.id) + ' · v' + ref.version + '</li>').join('') + '</ul>' : '') + '</div>';
  const reason = round?.reason ? '<p class="flow-alert small">' + escape(round.reason) + '</p>' : '';
  return '<section' + classes + '><div class="section-title"><div><h2>' + escape(node.title) + '</h2><p class="small">' +
    escape((round?.agent ?? agent)?.name || '未配置 Agent') + ' · ' + escape(ROLE[(round?.agent ?? agent)?.role] || '') + ' · ' + (node.release === 'manual' ? '人工批准' : '自动放行') +
    (agent?.publicNetwork ? ' · 公开网络' : '') + '</p></div><div class="row wrap">' + actions + '</div></div>' + reason +
    roundConfiguration(round) + childTaskList(round) + '<div class="row wrap flow-tabs" aria-label="节点视图">' + tabs + '</div><div class="flow-panel">' + show + '</div></section>';
}

function delegateLabel(agent) {
  return (agent.delegateIds || []).map(id => agentById(id)?.name || id).join('、') || '无';
}

function toolsList(tools) {
  return tools?.length ? '<details class="disclose"><summary>节点工具 · ' + tools.length + '</summary><p class="preserve">' + tools.map(escape).join(' · ') + '</p></details>' : '';
}

function rolePolicy(role) {
  const text = {
    orchestrator:'总编可委派已授权的 Manager 或 Worker，汇总、审核和验收结果。作品总编在直接对话中可查看、运行及停止本作品工作流，改图生成待保存草案；画布上的总编负责其节点任务。',
    manager:'Manager 可将任务拆给已授权的 Worker，检查交付、提出修改并验收本环节。',
    worker:'Worker 根据本轮指令和输入提交成果，具体工具由运行环境、任务授权及权限决定。'
  }[role];
  return '<p class="small" data-role-policy>' + escape(text) + '</p>';
}

function roundConfiguration(round) {
  if (!round?.agent) return '';
  const a = round.agent, list = ids => (ids || []).map(id => agentById(id)?.name || id).join('、') || '无';
  return '<details class="disclose"><summary>本轮实际配置</summary><p>' + escape(a.name) + ' · v' + escape(a.version) + ' · ' +
    escape(ROLE[a.role]) + ' · ' + escape(a.selection?.model) + ' · ' + escape(a.selection?.reasoningEffort || '模型默认') +
    '</p><p class="preserve">' + escape(a.systemPrompt || '未填写职责') + '</p>' + toolsList(a.effectiveTools) +
    (a.skills?.length ? '<p>本轮 Skill：' + a.skills.map(skill=>escape(skill.name) + ' v' + escape(skill.version)).join('、') + '</p>' : '') +
    (a.runtimePolicy ? '<details><summary>运行协议</summary><pre class="material-preview">' + escape(a.runtimePolicy) + '</pre></details>' : '') +
    '<p class="preserve">本轮指令：' + escape(round.instruction || '未填写') + '</p><p>输入检查：' + escape(round.inputRule || '未配置') +
    '</p><p>输出检查：' + escape(round.outputRule || '未配置') + '</p>' +
    (round.documents?.length ? '<p>作品资料：' + round.documents.map(doc=>button((state.snapshot.documents.find(d=>d.id===doc.id)?.name || doc.id) + ' v' + doc.version,
      'versioned-document:'+doc.id,'text','data-version="'+Number(doc.version)+'"')).join(' ') + '</p>' : '') +
    (a.role !== 'worker' ? '<p>可委派：' + escape(list(a.delegateIds)) + '</p>' : '') + '</details>';
}

function childTaskList(round) {
  if (!round?.childTasks?.length) return round?.awaitingAgentReview ? '<p class="small">等待协调 Agent 验收。</p>' : '';
  return '<details class="disclose" open><summary>子任务 · ' + round.childTasks.length + '</summary><ul class="preflight-list">' +
    round.childTasks.map(task => '<li class="preflight-item"><strong>' + escape(task.name) + '</strong> · ' + escape(ROLE[task.role]) +
      ' · ' + escape(task.verdict==='reject' ? 'Agent 退回' : TASK_STATUS[task.status] || task.status) + (task.version ? ' · v' + escape(task.version) : '') +
      '<p class="preserve">' + escape(task.prompt || '') + '</p>' + (task.selection ? '<p class="small">模型 ' + escape(task.selection.model) + ' · ' + escape(task.selection.reasoningEffort || '模型默认') + '</p>' : '') + toolsList(task.effectiveTools) + (task.attempts?.length ? '<details><summary>执行尝试 · ' + task.attempts.length + '</summary><ul>' + task.attempts.map(a=>'<li>第 ' + escape(a.number) + ' 次 · ' +
      escape(({queued:'排队中',running:'执行中',paused:'已暂停',reported:'已提交',failed:'失败',cancelled:'已停止'})[a.status] || a.status) + (a.error ? ' · ' + escape(a.error) : '') + '</li>').join('') + '</ul></details>' : '') +
      (task.reviewNote ? '<p>审核意见：' + escape(task.reviewNote) + '</p>' : '') +
      (task.result ? '<details><summary>结果</summary><pre class="material-preview">' + escape(task.result) + '</pre></details>' : '') +
      (task.error ? '<p class="form-error">' + escape(task.error) + '</p>' : '') +
      (task.canPause ? button('暂停子任务','child-pause:'+task.id,'text','data-round="'+escape(round.id)+'"') : '') +
      (task.canResume ? button('恢复子任务','child-resume:'+task.id,'text','data-round="'+escape(round.id)+'"') : '') +
      (['failed','blocked'].includes(task.status) ? button('仅重试此任务', 'retry-child:' + task.id, 'light', 'data-round="' + escape(round.id) + '"') : '') +
      '</li>').join('') + '</ul></details>';
}

function reviewPanel(round) {
  const artifact = round?.artifact;
  if (!artifact) return checkView('输出检查', round?.outputCheck) + '<p class="small">本轮暂无成果。</p>';
  const allowReview = round.status === 'review';
  const buttons = button('打开成果与批注', 'artifact:' + artifact.id, 'light') + (allowReview ? button('批准并放行', 'review:approve', 'primary') + button('退回', 'review:reject', 'light') : '') +
    (allowReview || round.status === 'rejected' ? button('直接编辑', 'review:edit', 'text') : '');
  return '<div class="stack"><div class="row between wrap"><div><h3>' + escape(artifact.title || artifact.name || '节点成果') + '</h3><p class="small">' +
    escape(nodeStatus(round)) + (artifact.version ? ' · v' + artifact.version : '') + '</p></div><div class="row wrap">' + buttons + '</div></div>' +
    '<pre class="material-preview">' + escape(artifact.content ?? artifact.text ?? '') + '</pre>' + checkView('输出检查', round.outputCheck) + evidenceView(artifact.sources) + downloadLinks(artifact,round.status==='released'?'已放行':'候选稿') + '</div>';
}

function checkView(label, result) {
  if (!result) return '';
  const status = CHECK_STATUS[result.status] ?? result.status;
  return '<div class="data-line small"><strong>' + escape(label) + '</strong> · ' + escape(status) +
    (result.inputCount != null ? ' · ' + escape(result.inputCount) + ' 份输入' : '') +
    (result.characters != null ? ' · ' + escape(result.characters) + ' 字符' : '') +
    (result.selection?.model ? ' · 校验模型 ' + escape(result.selection.model) : '') +
    (result.reason ? '<p class="preserve">' + escape(result.reason) + '</p>' : '') + '</div>';
}

function evidenceView(sources) {
  if (!Array.isArray(sources) || !sources.length) return '';
  return '<details class="disclose"><summary>公开来源 · ' + sources.length + '</summary><ul class="preflight-list">' + sources.map(source => {
    let destination;
    try {
      const url = new URL(source.url);
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) destination = url.href;
    } catch { /* A malformed source URL remains text. */ }
    const title = escape(source.title || source.url || '来源');
    return '<li class="preflight-item">' + (destination ? '<a href="' + escape(destination) + '" target="_blank" rel="noopener noreferrer">' + title + '</a>' : title) +
      (source.provider ? '<p class="small">搜索来源 ' + escape(source.provider) + '</p>' : '') +
      (source.retrievedAt ? '<p class="small">访问时间 ' + escape(source.retrievedAt) + '</p>' : '') + (source.excerpt ? '<blockquote>' + escape(source.excerpt) + '</blockquote>' : '') + '</li>';
  }).join('') + '</ul></details>';
}

function historyPanel(node) {
  const entries = [...runningOn(node.id)].reverse();
  if (!entries.length) return '<p class="small">暂无执行记录。</p>';
  return '<ul class="preflight-list">' + entries.map(round => '<li class="preflight-item"><strong>' + escape(nodeStatus(round)) +
    '</strong>' + (round.reason ? '<p class="small">' + escape(round.reason) + '</p>' : '') +
    (round.artifact ? '<p class="small">成果 ' + escape(round.artifact.title || '') + (round.artifact.version ? ' v' + round.artifact.version : '') + '</p>' : '') + handoffView(round.handoff) + button('查看本轮','receipt-run:' + round.runId,'text') + button('执行与审稿记录', 'review-history:' + round.id, 'text') + (round.artifact ? button('打开成果与批注','artifact:' + round.artifact.id,'text') : '') + '</li>').join('') + '</ul>';
}

function handoffView(handoff) {
  if (!Array.isArray(handoff) || !handoff.length) return '';
  return '<p class="small">已采用上游成果 · ' + handoff.map(item => escape(item.title || item.nodeId) + ' v' + item.version).join('、') + '</p>';
}

function downloadLinks(artifact, phase) {
  if (!artifact?.id) return '';
  const download = '/api/drama' + projectPath() + '/artifacts/' + segment(artifact.id) + '/export?format=';
  return '<div class="row wrap">' + (phase ? '<span class="small">' + escape(phase) + ' · v' + escape(artifact.version) + '</span>' : '') + '<a class="btn light" href="' + download + 'docx" download>下载 Word</a><a class="btn text" href="' + download + 'md" download>下载 Markdown</a></div>';
}

function deliveryView() {
  const entries = state.snapshot.runs.flatMap(run => run.nodes).filter(round => round.artifact && round.status === 'released').reverse();
  return '<section class="paper pad stack"><h2>成果导出</h2>' + (entries.length ? entries.map(round => {
    const node = graph().nodes.find(item => item.id === round.nodeId);
    return '<article class="data-line"><h3>' + escape(round.artifact.title || node?.title || '阶段成果') + '</h3><p class="small">已放行' +
      (round.artifact.version ? ' · v' + round.artifact.version : '') + '</p>' + button('打开成果与批注', 'artifact:' + round.artifact.id, 'text') + downloadLinks(round.artifact) + '</article>';
  }).join('') : '<p class="small">已放行的阶段成果会显示在这里。</p>') + '</section>';
}

function documentsView() {
  const docs = state.snapshot.documents.filter(doc => doc.kind === 'reference');
  return '<section class="paper pad stack"><div class="section-title"><div><h2>资料设定</h2><p class="small">可上传 DOCX、TXT、Markdown、CSV、TSV、JSON，提取正文后可直接编辑。</p></div><div class="row wrap">' +
    button('上传资料', 'pick-docs', 'primary') + button('新建', 'new-doc', 'text') + button('作品记忆', 'memory', 'text') + '</div></div>' +
    '<input id="doc-picker" type="file" accept="' + fileTypes + '" multiple hidden aria-label="上传资料">' +
    (docs.length ? '<div class="material-list">' + docs.map(doc => documentTile(doc)).join('') + '</div>' : '<p class="small">暂无资料。</p>') + '</section>';
}

function documentTile(doc) {
  return '<article class="material-tile"><div><h3>' + escape(doc.name) + '</h3><p class="small">v' + doc.version + '</p></div>' +
    button(doc.kind === 'episode' ? '打开正文与批注' : '打开', 'document:' + doc.id, 'light') + '</article>';
}

function episodesView() {
  const docs = state.snapshot.documents.filter(doc => doc.kind === 'episode');
  const groups = new Map();
  for (const doc of docs) {
    const number = Number(doc.episode);
    if (!groups.has(number)) groups.set(number, []);
    groups.get(number).push(doc);
  }
  const episodes = [...groups].sort(([a], [b]) => a - b);
  const pages = Math.max(1, Math.ceil(episodes.length / state.perPage));
  state.episodePage = Math.min(state.episodePage, pages);
  const first = (state.episodePage - 1) * state.perPage;
  return '<section class="paper pad episode-reader"><div class="section-title"><div><h2>分集</h2><p class="small">打开正文，选中文字即可批注或提交总编修订。</p></div>' + button('添加分集正文', 'new-episode', 'primary') +
    '</div><div class="row between wrap"><label class="episode-limit">每页集数<select id="episode-limit">' +
    [10, 25, 50, 100, 200, 500].map(size => '<option ' + (state.perPage === size ? 'selected' : '') + '>' + size + '</option>').join('') +
    '</select></label><div class="episode-pagination">' + button('上一页', 'previous-episodes', 'text', state.episodePage === 1 ? 'disabled' : '') +
    '<span class="small">' + state.episodePage + ' / ' + pages + '</span>' + button('下一页', 'next-episodes', 'text', state.episodePage === pages ? 'disabled' : '') +
    '</div></div><div class="episode-list">' + (episodes.length ? episodes.slice(first, first + state.perPage).map(([number, entries]) => '<details class="disclose episode-stub"><summary>第 ' + number + ' 集</summary>' +
      entries.map(documentTile).join('') + '</details>').join('') : '<p class="small">暂无分集正文。</p>') + '</div></section>';
}

function documentForm(doc, kind = doc?.kind ?? 'reference') {
  return '<form class="flow-form" data-form="document" data-kind="' + kind + '" data-id="' + escape(doc?.id) + '" data-version="' + escape(doc?.version) + '">' +
    '<label>名称<input name="name" maxlength="120" value="' + escape(doc?.name) + '" required></label>' +
    (kind === 'episode' ? '<div class="row wrap"><label>集数<input type="number" name="episode" min="1" max="10000" value="' + escape(doc?.episode) + '" required></label>' +
      '<label>场次（可选）<input name="scene" value="' + escape(doc?.scene) + '"></label><label>字段（可选）<input name="field" value="' + escape(doc?.field) + '"></label></div>' : '') +
    '<label>正文<textarea name="content" rows="11" required>' + escape(doc?.content) + '</textarea></label><p class="small form-error" role="alert"></p>' +
    '<button class="btn primary" type="submit">保存</button></form>';
}

function documentModal(doc, comments, linked = []) {
  const latest = state.snapshot.documents.find(item => item.id === doc.id)?.version ?? doc.version;
  const versions = Array.from({ length: Math.min(latest, 100) }, (_, index) => latest - index);
  if(!versions.includes(doc.version)) versions.push(doc.version);
  const versionPicker = versions.length > 1 ? '<label class="row">版本<select id="doc-version" data-document="' + escape(doc.id) + '">' +
    versions.map(version => '<option value="' + version + '" ' + (version === doc.version ? 'selected' : '') + '>v' + version + '</option>').join('') + '</select></label>' : '<p class="small">v' + doc.version + '</p>';
  const source = doc.source?.sha256 ? '<a class="btn text" download href="/api/drama' + projectPath() + '/documents/' + segment(doc.id) + '/source?version=' + doc.version + '">下载上传原件</a>' : '';
  showModal(doc.name, versionPicker + '<pre id="document-excerpt" data-version="' + doc.version + '" class="material-preview"></pre><div class="row wrap">' +
    (doc.version === latest ? button('编辑', 'edit-document:' + doc.id, 'light') : '') + source +
    (doc.kind === 'episode' && doc.version === latest ? button('批注选中文字', 'annotate:' + doc.id, 'text', 'id="annotate-button"') : '') + '</div>' +
    (linked.length ? '<h3>关联的节点成果</h3><div class="row wrap">' +
     linked.map(item=>button(item.title + ' v' + item.version,'artifact:' + item.id,'text')).join('') + '</div>' : '') + annotationsPanel(comments));
  modal.querySelector('#document-excerpt').textContent = doc.content;
}

async function openDocument(id, version) {
  const doc = await api(projectPath() + '/documents/' + segment(id) + (version ? '?version=' + segment(version) : ''));
  const [comments, linked] = doc.kind === 'episode' ? await Promise.all([api(projectPath() + '/annotations'),api(projectPath() + '/documents/' + segment(id) + '/artifacts?version=' + doc.version)]) : [[],[]];
  documentModal(doc, comments.filter(comment => comment.source === 'episode' && comment.sourceId === doc.id && comment.version === doc.version),linked);
}

function annotationsPanel(entries) {
  const labels = {saved:'已保存',rejected:'总编退回',candidate:'待人工采纳',applied:'已采纳',dismissed:'已放弃'};
  if (!entries.length) return '';
  return '<details class="disclose" data-annotations data-source="' + escape(entries[0].source) + '" data-source-id="' + escape(entries[0].sourceId) +
    '" data-version="' + escape(entries[0].version) + '"><summary>批注 ' + entries.length + ' 条</summary><ul class="preflight-list">' + entries.map(entry =>
    '<li class="preflight-item"><blockquote>' + escape(entry.selectedText) + '</blockquote><p class="preserve">' + escape(entry.text) +
    '</p>' + badge(labels[entry.status] || TASK_STATUS[entry.status] || entry.status) +
    (entry.status === 'saved' ? button('提交总编修订','dispatch-annotation:' + entry.id,'light') : '') + button('对照最新稿','annotation-compare:' + entry.id,'text') +
    (entry.reanchorOf ? button('查看原批注','annotation-origin:' + entry.reanchorOf,'text') : '') +
    (entry.taskId ? button('查看委派任务','annotation-task:' + entry.id,'text') : '') +
    (entry.error ? '<p class="form-error">' + escape(entry.error) + '</p>' : '') +
    (entry.status === 'candidate' ? button('审阅修订','annotation-candidate:' + entry.id,'light') : '') +
    (entry.revision ? button('查看采纳版本 v' + entry.revision.version, 'annotation-revision:' + entry.id,'text') : '') + '</li>').join('') + '</ul></details>';
}

async function openArtifact(id) {
  const [draft,entries,episodes] = await Promise.all([api(projectPath() + '/artifacts/' + segment(id)),api(projectPath() + '/annotations'),
    api(projectPath() + '/artifacts/' + segment(id) + '/episodes')]);
  const round=state.snapshot.runs.flatMap(run=>run.nodes).find(node=>node.artifact?.id===id);
  const phase=round ? (round.status==='released'?'已放行':'候选稿') : '历史稿';
  showModal(draft.title, '<p class="small">节点成果 · v' + draft.version + '</p><pre id="document-excerpt" data-source="artifact" data-version="' + draft.version +
    '" class="material-preview"></pre><div class="row wrap">' + button('批注选中文字','annotate:' + draft.id,'light','id="annotate-button"') + button('关联分集或场次','link-episode:'+draft.id,'text') + downloadLinks(draft,phase) +
    '</div>' + (episodes.length ? '<div class="row wrap"><h3>关联分集</h3>' + episodes.map(d=>button('第 '+d.episode+' 集'+(d.scene?' · '+d.scene:'')+' · v'+d.version,
      'versioned-document:'+d.id,'text','data-version="'+Number(d.version)+'"')).join('') + '</div>' : '') + annotationsPanel(entries.filter(entry => entry.source === 'artifact' && entry.sourceId === draft.id)));
  modal.querySelector('#document-excerpt').textContent = draft.content;
}

function agentsView() {
  const cards = state.agents.map(agent => {
    const model = state.models.find(item => item.provider === agent.selection.provider && item.model === agent.selection.model);
    const skills = (agent.skillIds ?? []).map(id => state.skills.find(item => item.id === id)?.name).filter(Boolean);
    return '<article class="paper item-card"><div class="row between wrap"><h2>' + escape(agent.name) + '</h2>' + badge((agent.retired ? '已停用 · ' : '') + 'v' + agent.version) +
      '</div><p class="small">' + escape(ROLE[agent.role]) + ' · ' + escape(model?.name || agent.selection.model) + (agent.selection.reasoningEffort ? ' · ' + escape(agent.selection.reasoningEffort) : '') +
      '</p>' + (agent.systemPrompt ? '<p class="agent-duties">' + escape(agent.systemPrompt) + '</p>' : '') +
      (agent.role !== 'worker' ? '<p class="small">允许委派：' + escape(delegateLabel(agent)) + '</p>' : '') +
      (agent.role === 'worker' ? '<p class="small">公开网络 ' + (agent.publicNetwork ? '已开启' : '已关闭') + '</p>' : '') +
      toolsList(agent.effectiveTools) + (skills.length ? '<p class="small">Skill · ' + escape(skills.join('、')) + '</p>' : '') + button('编辑', 'edit-agent:' + agent.id, 'light') + button(agent.retired ? '重新启用' : '停用', 'toggle-agent:' + agent.id, 'text') + '</article>';
  }).join('');
  return heading('Agent 配置', button('运行规则','protocol','text') + button('Skill 管理', 'skills', 'light') + button('新建 Agent', 'new-agent', 'primary'), 'Agent 可供多个节点和作品复用。') +
    (cards ? '<div class="grid-cards compact-library">' + cards + '</div>' : '<div class="paper pad"><p>添加 Agent 后可在画布中选择角色与职责。</p></div>');
}

function agentForm(agent, proposal) {
  const currentModel = state.models.findIndex(item => item.provider === agent?.selection.provider && item.model === agent?.selection.model);
  const role = agent?.role ?? proposal?.role ?? 'worker';
  const placeholder = agent && currentModel === -1 ? '原模型已移除：' + agent.selection.model + '，请选择新模型' : '请选择模型';
  const models = state.models.map((item, index) => '<option value="' + escape(modelKey(item)) + '" ' + (currentModel === index ? 'selected' : '') + '>' + escape(item.name || item.model) + ' · ' +
    escape(item.provider) + (item.demo ? ' · 演示' : '') + '</option>').join('');
  return '<form class="flow-form" data-form="agent" data-proposal="' + escape(proposal?.id) + '" data-id="' + escape(agent?.id) + '" data-version="' + escape(agent?.version) + '">' +
    '<label>名称<input name="name" value="' + escape(agent?.name ?? proposal?.name) + '" maxlength="100" required></label><label>角色<select name="role" ' + (agent ? 'disabled' : '') + '>' +
    [['worker', 'Worker · 执行'], ['manager', 'Manager · 协调'], ['orchestrator', 'Orchestrator · 总编']].map(([key, label]) => '<option value="' + key + '" ' +
      (key === role ? 'selected' : '') + '>' + label + '</option>').join('') + '</select></label><label>模型<select name="model" required><option value="">' + escape(placeholder) + '</option>' + models + '</select></label>' +
    '<label>推理等级<select name="effort">' + effortOptions(currentModel, agent?.selection.reasoningEffort) + '</select></label><label>职责设定（可选）<textarea name="prompt" rows="4">' +
    escape(agent?.systemPrompt ?? proposal?.systemPrompt) + '</textarea></label><fieldset ' + (role !== 'worker' ? 'hidden' : '') + '><legend>权限</legend><label class="option"><input type="checkbox" name="network" ' +
    (agent?.publicNetwork ? 'checked' : '') + '> 公开网络</label><p class="small">允许任务通过「连接」中启用的来源搜索并读取公开 HTTPS 网页。关闭后停止新的联网请求。</p></fieldset>' +
    rolePolicy(role) + delegateOptions(role, agent) + agentSkills(agent) +
    '<p class="small form-error" role="alert"></p><button class="btn primary" type="submit">保存</button></form>';
}

function delegateOptions(role, agent) {
  const candidates = activeAgents().filter(other => other.id !== agent?.id && other.role !== 'orchestrator');
  const rows = candidates.map(other => '<label class="option" data-child-role="' + other.role + '" ' + (role === 'manager' && other.role !== 'worker' ? 'hidden' : '') +
    '><input type="checkbox" name="delegate" value="' + escape(other.id) + '" ' + (agent?.delegateIds?.includes(other.id) ? 'checked' : '') +
    '> ' + escape(other.name) + ' · ' + escape(ROLE[other.role]) + '</label>');
  return '<fieldset data-delegates ' + (role === 'worker' ? 'hidden' : '') + '><legend>允许委派的 Agent</legend><p class="small">仅能委派勾选的下属。留空时可审核或验收输入。</p>' +
    (rows.length ? rows.join('') : '<p class="small">先建立下属 Agent，再绑定到本角色。</p>') + '</fieldset>';
}

function agentSkills(agent) {
  const active = state.skills.filter(skill => !skill.retired);
  const selected = agent?.skillIds ?? [];
  const unavailable = selected.filter(id => !active.some(skill => skill.id === id));
  if (!active.length && !unavailable.length) return '';
  const checkbox = (id, label) => '<label class="option"><input name="skill" type="checkbox" value="' + escape(id) + '" ' +
    (selected.includes(id) ? 'checked' : '') + '> ' + escape(label) + '</label>';
  const choices = active.map(skill => checkbox(skill.id, skill.name + ' · v' + skill.version));
  const old = unavailable.map(id => checkbox(id, (state.skills.find(skill => skill.id === id)?.name ?? '历史 Skill') + ' · 已退役'));
  return '<fieldset><legend>Skill</legend>' + choices.concat(old).join('') + '</fieldset>';
}

function skillCatalog() {
  const cards = state.skills.filter(skill => !skill.retired).map(skill => '<li class="preflight-item"><div class="row between wrap"><strong>' +
    escape(skill.name) + ' · v' + skill.version + '</strong><div class="row wrap">' + button('打开', 'skill:' + skill.id, 'light') +
    button('退役', 'retire-skill:' + skill.id, 'text') + '</div></div><p class="small">' + escape(skill.summary) + '</p></li>').join('');
  showModal('Skill 管理', '<div class="row between wrap"><p class="small">在 Agent 配置中绑定可复用的 Skill。</p>' + button('新建 Skill', 'new-skill', 'primary') +
    '</div>' + (cards ? '<ul class="preflight-list editor-messages">' + cards + '</ul>' : '<p class="small">暂无启用的 Skill。</p>'));
}

function skillForm(skill) {
  return '<form class="flow-form" data-form="skill" data-id="' + escape(skill?.id) + '" data-version="' + escape(skill?.version) + '">' +
    '<label>名称<input name="name" required maxlength="120" value="' + escape(skill?.name) + '"></label><label>摘要<input name="summary" maxlength="600" value="' +
    escape(skill?.summary) + '" required></label><label>从本机导入正文（可选）<input type="file" name="source" accept=".md,.markdown,.txt"></label>' +
    '<label>正文<textarea name="body" rows="10" maxlength="24000" required>' + escape(skill?.body) + '</textarea></label><p class="small form-error" role="alert"></p>' +
    '<div class="row wrap"><button class="btn primary" type="submit">保存' + (skill ? '新版本' : '') + '</button>' + button('返回 Skill 管理', 'skills', 'text') + '</div></form>';
}

async function memoryCatalog(offset = 0) {
  const { entries, nextOffset } = await api(projectPath() + '/memory?offset=' + offset);
  state.memoryOffset = offset;
  const labels = { long: '长期', medium: '中期', short: '短期' };
  const groups = Object.entries(labels).map(([layer, label]) => {
    const rows = entries.filter(entry => entry.layer === layer).map(entry => '<li class="preflight-item"><div class="row between wrap"><strong>' +
      escape(entry.title) + ' · v' + entry.version + '</strong>' + button('打开', 'memory-entry:' + entry.id, 'light') + '</div><p class="small">' +
      escape(entry.ownerName || '') + ' · ' + (entry.visibility === 'public' ? '公开' : '私有') + '</p><p class="small preserve">' + escape(entry.summary) + '</p></li>').join('');
    return rows ? '<section><h3>' + label + '记忆</h3><ul class="preflight-list">' + rows + '</ul></section>' : '';
  }).join('');
  const paging = (offset ? button('上一页', 'memory:' + Math.max(0, offset - 100), 'text') : '') +
    (nextOffset ? button('下一页', 'memory:' + nextOffset, 'text') : '');
  showModal('作品记忆', (groups || '<p class="small">暂无记忆记录。</p>') + (paging ? '<div class="row wrap">' + paging + '</div>' : ''));
}

function effortOptions(index, selected) {
  return '<option value="">模型默认</option>' + (state.models[index]?.efforts ?? []).map(effort => '<option value="' + escape(effort.id) + '" ' +
    (effort.id === selected ? 'selected' : '') + '>' + escape(effort.name || effort.id) + '</option>').join('');
}

function connectionsView() {
  return heading('连接', button(modelRefresh ? '正在刷新…' : '刷新模型目录', 'refresh-models', 'light', modelRefresh ? 'disabled' : '')) +
    (refreshError ? '<p class="form-error" role="alert">' + escape(refreshError) + '</p>' : '') + '<section class="paper pad stack"><h2>DSH 模型</h2>' +
    '<p class="small">列表来自工作台已连接的 DSH 配置。选择模型与推理等级请前往 Agent 页面。</p><ul class="preflight-list">' +
    state.models.map((model, index) => '<li class="preflight-item row between wrap"><span>' + escape(model.name || model.model) + ' · ' + escape(model.provider) + (model.demo ? ' · 演示' : '') + '</span>' +
      button('测试连接', 'probe-model:' + index, 'text') + '</li>').join('') +
    '</ul></section><section id="search-settings" class="paper pad stack"></section>';
}

function templatesView() {
  const cards = state.templates.map(template => '<article class="paper item-card"><div class="row between wrap"><h2>' + escape(template.name) +
    '</h2>' + button('版本历史 · v' + template.version, 'template-history:' + template.id, 'text') + '</div>' +
    (template.description ? '<p>' + escape(template.description) + '</p>' : '') +
    '<p class="small">' + template.nodes.length + ' 个节点 · ' + template.edges.length + ' 条连线</p><div class="row wrap">' +
    button('用此模板新建', 'new-project:' + template.id, 'light') + button('编辑', 'edit-template:' + template.id, 'text') +
    button('从库中移除', 'delete-template:' + template.id, 'text') + '</div></article>').join('');
  return heading('模板库', button('新增模板', 'new-template', 'primary'), '模板更新用于新建作品。') +
    (cards ? '<div class="grid-cards compact-library">' + cards + '</div>' : '<div class="paper pad"><p>暂无模板。</p></div>');
}

async function showTemplateHistory(id) {
  const {currentVersion, versions} = await api('/templates/' + segment(id) + '/versions');
  if (state.page !== 'templates' || isTemplate()) return;
  const entries = versions.map(version => '<li class="preflight-item"><div class="row between wrap"><h3>v' +
    escape(version.version) + ' · ' + escape(version.name) + '</h3>' + (version.version === currentVersion ? badge('当前版本', 'green') : '') +
    '</div>' + (version.description ? '<p>' + escape(version.description) + '</p>' : '') +
    '<div class="row between wrap"><span class="small">' + version.nodeCount + ' 个节点 · ' + version.edgeCount + ' 条连线</span>' +
    button('从此版编辑', 'edit-template-version:' + version.version, 'light') + '</div></li>').join('');
  showModal('模板版本历史', '<p class="small">选择版本打开画布。保存后会新增一个模板版本，已创建的作品保留自己的画布。</p>' +
    '<ul class="preflight-list" data-template-history="' + escape(id) + '" data-current-version="' + currentVersion + '">' + entries + '</ul>');
}

function projectForm(templateId) {
  return '<form class="flow-form" data-form="project"><label>作品名<input name="name" maxlength="120" required></label><label>说明（可选）' +
    '<textarea name="description" rows="3"></textarea></label>' + editorChoice('',true) + '<label>工作流模板<select name="template"><option value="">空白画布</option>' +
    state.templates.map(template => '<option value="' + escape(template.id) + '" ' + (template.id === templateId ? 'selected' : '') + '>' + escape(template.name) +
      ' · v' + template.version + '</option>').join('') + '</select></label><p class="small form-error" role="alert"></p><button class="btn primary" type="submit">创建</button></form>';
}

function templateForm(template) {
  return '<form class="flow-form" data-form="template"><label>名称<input name="name" maxlength="120" value="' + escape(template?.name) +
    '" required></label><label>说明（可选）<textarea name="description" rows="3">' + escape(template?.description) + '</textarea></label>' +
    (!template?.id && state.snapshot?.graph ? '<label>画布来源<select name="source"><option value="">空白</option><option value="project">当前打开作品的已保存画布</option></select></label>' : '') +
    '<button class="btn primary" type="submit">' + (template ? '保存到草案' : '打开模板画布') + '</button><p class="small form-error" role="alert"></p></form>';
}

function nodeHint(agent) {
  if(!agent) return '选择 Agent 后可查看本节点的执行方式。';
  if(agent.role==='worker') return 'Worker 按指令提交具体成果。';
  return '在指令中写明本节点负责拆分、审核或验收，以及交付标准。可委派：' + delegateLabel(agent) + '。';
}

function nodeForm(node) {
  const options = activeAgents().map(agent => '<option value="' + escape(agent.id) + '" ' +
    (node?.agentId === agent.id ? 'selected' : '') + '>' + escape(agent.name) + ' · ' + escape(ROLE[agent.role]) + (agent.publicNetwork ? ' · 公开网络' : '') + '</option>').join('');
  return '<form class="flow-form" data-form="node" data-id="' + escape(node?.id) + '"><label>节点名称<input name="title" maxlength="120" value="' +
    escape(node?.title) + '" required></label><label>节点 Agent<select name="agent" required><option value="">请选择</option>' + options +
    '</select></label>' + (options ? '' : '<p class="small">请先在 Agent 页面创建可用配置。</p>') +
    '<label>默认执行指令<textarea name="instruction">' + escape(node?.instruction) + '</textarea></label>' +
    '<p class="small" data-node-hint>' + escape(nodeHint(agentById(node?.agentId))) + '</p>' +
    '<label>输入检查规则<textarea name="inputRule" placeholder="可空，例如：至少 2 份输入材料">' + escape(node?.inputRule) + '</textarea></label>' +
    '<label>输出检查规则<textarea name="outputRule" placeholder="可空，例如：必须包含「人物」">' + escape(node?.outputRule) + '</textarea></label>' +
    '<label>放行条件<select name="release"><option value="manual">人工批准</option><option value="auto" ' + (node?.release === 'auto' ? 'selected' : '') +
    '>检查通过后自动放行</option></select></label><button class="btn primary" type="submit">' + (node ? '保存到草案' : '加入画布') +
    '</button><p class="small form-error" role="alert"></p></form>';
}

function inputForm(node) {
  const draft = inputsFor(node);
  const checked = new Set(draft.documents.map(docKey));
  const listed = [...state.snapshot.documents];
  for (const ref of draft.documents) {
    if (!listed.some(doc => docKey(doc) === docKey(ref))) {
      listed.push({ ...ref, name: listed.find(doc => doc.id === ref.id)?.name || ref.id });
    }
  }
  const documents = listed.map(doc => '<label class="option"><input name="document" type="checkbox" value="' + escape(docKey(doc)) + '" ' +
    (checked.has(docKey(doc)) ? 'checked' : '') + '> ' + escape(doc.name) + ' · v' + doc.version + '</label>').join('');
  return '<form class="flow-form" data-form="inputs" data-id="' + escape(node.id) + '"><label>执行指令<textarea name="instruction" rows="5">' +
    escape(draft.instruction) + '</textarea></label><div class="row wrap">' + button('恢复节点默认指令','default-instruction','text') +
    '<span class="small">此后执行使用，已开始的轮次保留原输入。</span></div><fieldset><legend>从作品资料选择输入</legend>' + (documents || '<p class="small">暂无资料。</p>') +
    '</fieldset><label class="node-input-drop">点击或拖拽上传输入文件<input name="uploads" type="file" multiple accept="' + fileTypes + '"><span id="attached-files" class="small"></span></label>' +
    '<p class="small form-error" role="alert"></p><button class="btn primary" type="submit">保存执行输入</button></form>';
}

function inputsFor(node) {
  const saved = state.inputDrafts.get(node.id) ?? state.snapshot?.inputs?.[node.id];
  return { instruction: saved?.instruction ?? node.instruction, documents: saved?.documents ?? [] };
}

async function fetchInputs(nodeId) {
  const projectId = state.snapshot?.project.id;
  const saved = await api(projectPath() + '/node-inputs/' + segment(nodeId));
  if (state.snapshot?.project.id === projectId) state.inputDrafts.set(nodeId, saved ?? {});
}

function reviewForm(decision, round) {
  const artifact = round.artifact;
  const form = '<form class="flow-form" data-form="review" data-decision="' + decision + '" data-round="' + escape(round.id) +
    '" data-artifact="' + escape(artifact.id) + '"><p class="small">' + escape(artifact.title) + ' · v' + artifact.version + '</p>';
  if (decision === 'edit') return form + '<label>人工修改正文<textarea name="content" rows="11" required>' + escape(artifact.content) +
    '</textarea></label><p class="small form-error" role="alert"></p><button class="btn primary" type="submit">保存新稿</button></form>';
  if (decision === 'reject') return form + '<label>修改意见<textarea name="note" rows="5" required></textarea></label>' +
    '<p class="small form-error" role="alert"></p><button class="btn primary" type="submit">退回本节点</button></form>';
  return form + '<p>批准后，相连的下游可以读取这一版。</p><p class="small form-error" role="alert"></p><button class="btn primary" type="submit">确认批准</button></form>';
}

function draftStatus() {
  const draft = state.draft;
  if (!draft) return '';
  if (draft.error) return escape(draft.error) + ' ' + button(draft.conflict?'载入已保存草稿':'重试保存草稿',draft.conflict?'load-saved-draft':'retry-draft','text');
  const version = isTemplate() ? (state.templates.find(t=>t.id===draft.id)?.version || 0) : state.snapshot.graph.version;
  if (version !== draft.baseVersion) return '生效画布已更新，请核对变更。基于旧版的草稿无法直接发布。';
  if (draft.dirty || draft.pending) return '正在保存草稿…';
  if (draft.revision) return '草稿已自动保存';
  return '';
}

function refreshDraftStatus(draft) {
  if (state.draft !== draft) return;
  const target = main.querySelector('#canvas-save-status');
  if (target) target.innerHTML = draftStatus();
  if (draft.conflict) main.querySelector('[data-action="save-graph"]')?.setAttribute('disabled','');
}

function startGraphDraft() {
  if (!state.draft) {
    const saved = state.snapshot.graph;
    state.draft = {scope:'project',id:state.snapshot.project.id,revision:null,baseVersion:saved.version,sourceVersion:saved.version,graph:structuredClone(saved)};
  }
  if (state.draft.locked) throw new Error('正在处理这份画布，请稍后。');
  return state.draft;
}

function markGraphChanged() {
  changedCanvas(api,state.draft,refreshDraftStatus);
}

async function startTemplateDraft(template, source, options={}) {
  const id=template.id || 'new';
  const baseVersion=options.headVersion ?? template.version ?? 0;
  const sourceVersion=options.sourceVersion ?? template.version ?? 0;
  const fresh={scope:'template',id,baseVersion,sourceVersion,revision:null,item:structuredClone(template),
    graph:{version:sourceVersion,nodes:structuredClone(source?.nodes || []),edges:structuredClone(source?.edges || [])}};
  const stored=await hydrateCanvas(api, {...fresh,item:structuredClone(template)});
  if (options.existingOnly && !stored) return false;
  const replace=Boolean(stored && options.explicitSource && (sourceVersion !== stored.sourceVersion || graphChanges(template,stored).length));
  if (replace && !window.confirm('已有一份模板草稿。用选中的历史版本替换这份草稿？已发布版本会保留。')) return;
  if (replace && stored.conflict) throw new Error('当前窗口与已保存草稿有冲突，请先打开最新模板并载入已保存草稿。');
  state.draft=replace || !stored ? fresh : stored;
  if (replace) { fresh.revision=stored.revision; fresh.replaceSource=true; }
  if (replace || !stored && (id==='new' || sourceVersion!==baseVersion) || state.draft.dirty && !state.draft.conflict) markGraphChanged();
  state.page='templates';
  state.selected=new Set(graph().nodes.slice(0,1).map(node=>node.id));
  state.linkFrom=null;
  const url=new URL(location.href);
  url.searchParams.set('page','templates');
  url.searchParams.set('template',id);
  url.searchParams.delete('project');
  history.replaceState(null,'',url);
  render();
  return true;
}

async function leaveCanvas() {
  const draft=state.draft;
  state.previewDraft=null;
  if (draft) {
    if (draft.locked) throw new Error('正在处理这份画布，请稍后。');
    await saveCanvasDraft(api,draft,refreshDraftStatus);
    state.draft=null;
  }
  const url=new URL(location.href);
  url.searchParams.delete('template');
  history.replaceState(null,'',url);
  state.linkFrom=null;
  state.selected=new Set(state.snapshot?.graph.nodes.slice(0,1).map(node=>node.id));
}

async function resumeProjectDraft() {
  const stored=await hydrateCanvas(api,{scope:'project',id:state.snapshot.project.id});
  state.draft=stored;
  if (stored?.dirty && !stored.conflict) markGraphChanged();
  const ids=new Set(graph().nodes.map(n=>n.id));
  state.selected=new Set([...state.selected].filter(id=>ids.has(id)));
}

async function loadSavedDraft() {
  const draft=state.draft;
  if (!window.confirm('载入服务器上的草稿？本窗口未同步的修改将被替换。')) return;
  const loaded=await hydrateCanvas(api,{...draft,dirty:false,conflict:false,error:'',pending:null},true);
  forgetCanvasRecovery(draft);
  if (loaded) state.draft=loaded;
  else {
    state.draft=null;
    if (draft.scope==='project') await reloadProject();
    else await loadCatalog();
  }
  state.selected=new Set(graph()?.nodes.slice(0,1).map(n=>n.id));
  render();
}

async function closeDraft(publish) {
  const draft=state.draft;
  if (!draft || draft.locked) return;
  if (!publish && !window.confirm('放弃这份画布草稿？已生效的画布会保留。')) return;
  draft.locked=true;
  try {
    await finishCanvas(api,draft,publish,refreshDraftStatus);
  } catch (error) {
    draft.error=error.message;
    if (error.status===409) draft.conflict=true;
    render();
    throw error;
  } finally { draft.locked=false; }
  state.draft=null;
  state.linkFrom=null;
  if (draft.scope==='template') {
    const url=new URL(location.href);
    url.searchParams.delete('template');
    history.replaceState(null,'',url);
    await loadCatalog();
  } else await reloadProject();
  render();
  notice(publish?'画布已保存。':'已放弃草稿。');
}

function selectNode(id, multiple = false) {
  if (multiple) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
  } else state.selected = new Set([id]);
  state.nodeTab = lastRound(id)?.status === 'review' ? 'review' : 'inputs';
  render();
}

function addEdge(from, to) {
  if (!from) return notice('请先选择一条连线的起点。');
  const draft = startGraphDraft().graph;
  if (!draft) return notice('请先选择一条连线的起点。');
  if (draft.edges.some(edge => edge.from === from && edge.to === to)) return notice('这条连线已存在。');
  const pending = [to];
  const seen = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (id === from) return notice('此连线会造成循环依赖。');
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of draft.edges) if (edge.from === id) pending.push(edge.to);
  }
  draft.edges.push({ from, to });
  markGraphChanged();
  state.linkFrom = null;
  render();
}

function availablePosition() {
  const { nodes } = state.draft.graph;
  for (let y = 26; ; y += 100) {
    for (const x of [26, 228, 430, 632, 834]) {
      if (nodes.every(node => Math.abs(node.x - x) >= GRAPH_CARD.width + 10 || Math.abs(node.y - y) >= GRAPH_CARD.height + 10)) return { x, y };
    }
  }
}

function editorChoice(bound, optional = false) {
  const catalog = activeAgents().filter(agent => agent.role === 'orchestrator');
  const selected = bound || (catalog.length === 1 ? catalog[0].id : '');
  return '<label>总编 Agent<select name="agent" ' + (optional ? '' : 'required') + '><option value="">' +
    (optional ? '稍后绑定' : '请选择已配置的总编') + '</option>' +
    catalog.map(agent => '<option value="' + escape(agent.id) + '" ' + (selected === agent.id ? 'selected' : '') + '>' + escape(agent.name) +
      ' · v' + agent.version + '</option>').join('') + '</select></label>' +
    (catalog.length ? '' : '<p class="small">先在 Agent 配置中添加 Orchestrator。</p>');
}

const receiptState = {observed:'已查询',proposed:'待保存草案',saved:'已保存',discarded:'已放弃',started:'已启动',stopping:'停止中',stopped:'已停止',failed:'失败'};
const receiptOp = {suggest_agent:'建议新建 Agent',inspect:'查看工作流',propose:'拟定画布',start:'执行工作流',stop:'停止工作流'};
function editorUpdates(data) {
  const links = new Map((data.annotationLinks || []).map(item => [item.taskId,item]));
  const relatedSource = task => {
    const entry=links.get(task.id);
    return entry ? button('查看原文与批注','annotation-origin:'+entry.id,'text') : '';
  };
  const changesView = changes => {
    if (!changes) return '';
    const labels = {added:'新增节点',modified:'调整节点',removed:'删除节点',edgesAdded:'新增连线',edgesRemoved:'移除连线'};
    return '<ul class="small">' + Object.entries(labels).filter(([field])=>changes[field]?.length).map(([field,label])=>
      '<li>' + label + '：' + changes[field].map(escape).join('、') + '</li>').join('') + '</ul>';
  };
  const messages = (data.messages || []).map(message => '<li class="preflight-item"><strong>' + (message.role === 'user' ? '你' : '总编') +
    '</strong><p class="preserve">' + escape(message.text ?? message.content) + '</p></li>').join('');
  const tasks = (data.tasks || []).map(task => '<li class="preflight-item"><strong>' + escape(task.verdict==='reject' ? 'Agent 退回' : TASK_STATUS[task.status] || task.status) + '</strong> · ' +
    escape(task.title || task.id) + relatedSource(task) + (task.error ? '<p class="form-error">' + escape(task.error) + '</p>' : '') +
    (task.result ? '<details><summary>任务结果</summary><pre class="material-preview">' + escape(task.result) + '</pre></details>' : '') + '</li>').join('');
  const receipts = (data.receipts || []).map(row => '<li class="preflight-item"><strong>' + escape(receiptOp[row.operation] || row.operation) + '</strong> · ' +
    escape(receiptState[row.state] || row.state) + '<p class="preserve">' + escape(row.summary) + '</p>' + changesView(row.changes) +
    (row.template ? '<p>工作流模板 ' + escape(row.template.name) + ' · v' + escape(row.template.version) + '</p>' : '') +
    (row.graphVersion ? '<p class="small">画布 v' + escape(row.graphVersion) + '</p>' : '') + (row.runId ? button('查看运行','receipt-run:'+row.runId,'light') : '') +
    (row.operation === 'suggest_agent' && row.state === 'proposed' ? button('配置此 Agent','agent-proposal:'+row.id,'light') + button('放弃建议','discard-agent-proposal:'+row.id,'text') :
     row.state === 'proposed' ? button('打开草案','proposal:'+row.id,'light') + button('放弃草案','discard-proposal:'+row.id,'text') : '') + '</li>').join('');
  return (messages ? '<ul class="preflight-list editor-messages">' + messages + '</ul>' : '') +
    (receipts ? '<h3>工作流操作回执</h3><ul class="preflight-list">' + receipts + '</ul>' : '') +
    (tasks ? '<h3>委派任务</h3><ul class="preflight-list">' + tasks + '</ul>' : '') +
    (messages || receipts || tasks ? '' : '<p class="small">暂无对话或委派。</p>');
}

async function editorModal() {
  const data = await api(projectPath() + '/editor');
  const { agent, sessionId, sessions = [] }=data;
  const formatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
  const history = sessions.length > 1 ? '<label>对话<select id="editor-session">' + sessions.map(session => {
    const time = Date.parse(session.createdAt);
    const title = session.agent + (Number.isFinite(time) ? ' · ' + formatter.format(time) : '');
    return '<option value="' + escape(session.id) + '" ' + (sessionId === session.id ? 'selected' : '') + '>' + escape(title) + '</option>';
  }).join('') + '</select></label>' : '';
  const controls = '<div class="row between wrap"><p class="small">' + escape(state.snapshot.project.name) + '</p>' +
    (sessionId ? button('新建对话', 'new-editor-session', 'text') : '') + '</div>' + history;
  showModal('总编对话', controls + '<div id="editor-updates" data-session="' + escape(sessionId) + '">' + editorUpdates(data) + '</div>' + editorForm(agent));
}

function editorForm(agent) {
  const selector = agent ? '<p class="small">会话总编 · ' + escape(agent) + '</p>' : editorChoice(state.snapshot.project.editorAgentId);
  return '<form class="flow-form" data-form="editor">' + selector + '<label>操作<select name="mode"><option value="message">对话与管理工作流</option><option value="task">追加独立任务</option>' +
    '</select></label><label>给总编的说明<textarea name="text" rows="4" placeholder="例如：用已有模板拟一份工作流；查看执行进度" required></textarea></label>' +
    '<p class="small form-error" role="alert"></p><button class="btn primary" type="submit">提交</button></form>';
}

function editorSessionForm() {
  return '<form class="flow-form" data-form="editor-session">' + editorChoice(state.snapshot.project.editorAgentId) +
    '<div class="row wrap"><button class="btn primary" type="submit">创建</button>' + button('返回对话', 'editor', 'text') +
    '</div><p class="small form-error" role="alert"></p></form>';
}

async function handleAction(action, event) {
  const [name, value] = action.split(':');
  switch (name) {
    case 'close': modal.close(); break;
    case 'page':
      if (value === state.page && !state.draft) break;
      await leaveCanvas();
      if (value === 'library' || (value === 'work' && !state.snapshot)) {
        await showLibrary(state.libraryArchived);
        break;
      }
      state.page = value;
      {
        const url = new URL(location.href);
        if (state.page === 'connections') url.searchParams.set('page', 'connections');
        else url.searchParams.delete('page');
        if (state.page === 'work' && state.snapshot) url.searchParams.set('project', state.snapshot.project.id);
        history.replaceState(null, '', url);
      }
      if (state.page === 'work') { await reloadProject(); if (renderingProject() && state.section==='workflow') await resumeProjectDraft(); render(); break; }
      if (state.page === 'connections') { await refreshModels(); break; }
      if (state.page === 'templates' || state.page === 'agents') await loadCatalog();
      render();
      break;
    case 'library-filter':
      await showLibrary(value === 'archived');
      break;
    case 'archive-project':
    case 'restore-project':
    case 'delete-project':
      await changeProjectState(name, value);
      break;
    case 'project':
      await leaveCanvas();
      await openProject(value);
      break;
    case 'section':
      if (value === state.section) break;
      await leaveCanvas();
      state.section = value;
      if (value === 'workflow') await resumeProjectDraft();
      render();
      break;
    case 'new-project':
      await loadCatalog();
      showModal('新建作品', projectForm(value));
      break;
    case 'toggle-agent': {
      const agent = agentById(value);
      if (!agent || (!agent.retired && !window.confirm('停用「' + agent.name + '」？新任务将无法选用，已开始的任务保留其配置。'))) break;
      await api('/agents', {method:'POST',body:{id:agent.id,expectedVersion:agent.version,retired:!agent.retired}});
      await loadCatalog(); render(); break;
    }
    case 'child-pause':
    case 'child-resume': {
      const round=event.target.closest('[data-round]').dataset.round;
      await api(projectPath()+'/node-runs/'+segment(round)+'/children/'+segment(value)+'/actions',{method:'POST',body:{action:name==='child-pause'?'pause':'resume',requestId:crypto.randomUUID()}});
      await reloadProject();render();break;
    }
    case 'retry-child': {
      const round = event.target.closest('[data-round]').dataset.round;
      await api(projectPath() + '/node-runs/' + segment(round) + '/children/' + segment(value) + '/retry', {method:'POST',body:{requestId:crypto.randomUUID()}});
      await reloadProject(); render(); break;
    }
    case 'new-agent': showModal('新建 Agent', agentForm()); break;
    case 'edit-agent': showModal('编辑 Agent', agentForm(agentById(value))); break;
    case 'protocol': {
      const p=state.protocol ?? await api('/protocol');
      const row=(title,body)=>'<details class="disclose"><summary>'+escape(title)+'</summary><pre class="material-preview">'+escape(body)+'</pre></details>';
      const lines=(values)=>Object.entries(values || {}).map(([key,v])=>key+' · '+(Array.isArray(v)?v.join('、'):v)).join('\n');
      showModal('生效的运行规则', '<p class="small">Agent 职责、委派对象、Skill、节点指令和检查规则可在各自设置中修改。以下为工作台实际使用的工具协议和约束。</p>'+
        Object.entries(p.roles).map(([role,body])=>row(ROLE[role] || role,body)).join('') + row('作品总编对话管理',p.editor) +
        row('节点成果提交',p.nodeOutput) + row('独立检查模型的指令',p.validator) + row('配置来源',lines(p.sources)) +
        row('可用工具',lines(p.tools)) + row('每次可拆分的子任务数',p.limits.branchesPerSplit) + row('校验模型单次回复上限',p.limits.ruleReplyTokens + ' tokens'));
      break;
    }
    case 'skills': skillCatalog(); break;
    case 'new-skill': showModal('新建 Skill', skillForm()); break;
    case 'skill': {
      const skill = await api('/skills/' + segment(value));
      showModal(skill.name + ' · v' + skill.version, skillForm(skill));
      break;
    }
    case 'retire-skill': {
      const skill = state.skills.find(item => item.id === value);
      if (!skill || !window.confirm('退役「' + skill.name + '」？后续任务将跳过该 Skill。')) break;
      await api('/skills/' + segment(value), { method: 'DELETE', body: { expectedVersion: skill.version } });
      await loadCatalog();
      render();
      skillCatalog();
      notice('Skill 已退役。');
      break;
    }
    case 'memory': await memoryCatalog(Number(value) || 0); break;
    case 'memory-entry': {
      const entry = await api(projectPath() + '/memory/' + segment(value));
      showModal(entry.title, '<p class="small">v' + entry.version + ' · ' + escape(entry.ownerName || '') + '</p><pre class="material-preview">' +
        escape(entry.content) + '</pre>' + button('返回记忆目录', 'memory:' + state.memoryOffset, 'text'));
      break;
    }
    case 'refresh-models':
      if (await refreshModels()) notice('模型目录已刷新，共 ' + state.models.length + ' 个模型。');
      break;
    case 'new-template':
      if (!await startTemplateDraft({name:'新模板',description:''},undefined,{existingOnly:true})) showModal('新增模板',templateForm());
      break;
    case 'edit-template': {
      const template = await api('/templates/' + segment(value));
      await startTemplateDraft(template, template, {headVersion:template.version, sourceVersion:template.version});
      break;
    }
    case 'template-history': await showTemplateHistory(value); break;
    case 'edit-template-version': {
      const list = event.target.closest('[data-template-history]');
      if (!list) break;
      const template = await api('/templates/' + segment(list.dataset.templateHistory) + '?version=' + segment(value));
      if (!modal.open || !modal.contains(list)) break;
      modal.close();
      await startTemplateDraft(template, template, {headVersion:Number(list.dataset.currentVersion), sourceVersion:template.version, explicitSource:true});
      break;
    }
    case 'template-details': showModal('名称与说明', templateForm(state.draft.item)); break;
    case 'delete-template': {
      const template = state.templates.find(item => item.id === value);
      if (!template || !window.confirm('从模板库移除《' + template.name + '》？保留历史版本和已有作品的画布。')) break;
      await api('/templates/' + segment(value), { method: 'DELETE', body: { expectedVersion: template.version } });
      await loadCatalog();
      render();
      notice('已从模板库移除，历史版本已保留。');
      break;
    }
    case 'select':
      selectNode(value, event.metaKey || event.ctrlKey || event.shiftKey);
      if (!state.draft && picked().length === 1 && !state.inputDrafts.has(value)) {
        await fetchInputs(value);
        if (activeNode()?.id === value) render();
      }
      break;
    case 'multi-select': selectNode(value, true); break;
    case 'new-node':
    case 'edit-node': {
      const node=name==='edit-node' ? activeNode() : undefined;
      showModal(node?'节点设置':'添加节点',nodeForm(node));
      break;
    }
    case 'port-out':
      if (Date.now() < skipClickUntil) break;
      state.linkFrom = value;
      render();
      break;
    case 'port-in': addEdge(state.linkFrom, value); break;
    case 'unlink':
      startGraphDraft();
      state.draft.graph.edges = state.draft.graph.edges.filter(edge => edge.from !== value || edge.to !== activeNode()?.id);
      markGraphChanged(); render();
      break;
    case 'delete-nodes':
      if (!window.confirm('从画布删除选中的 ' + state.selected.size + ' 个节点及相关连线？')) break;
      startGraphDraft();
      state.draft.graph.nodes = state.draft.graph.nodes.filter(node => !state.selected.has(node.id));
      state.draft.graph.edges = state.draft.graph.edges.filter(edge => !state.selected.has(edge.from) && !state.selected.has(edge.to));
      state.selected.clear();
      markGraphChanged(); render();
      break;
    case 'preview-published': {
      const draft=state.draft;
      if (!draft || draft.locked) break;
      await saveCanvasDraft(api,draft,refreshDraftStatus);
      await reloadProject();
      if (!state.snapshot || state.draft!==draft) break;
      state.previewDraft=draft;
      state.draft=null;
      state.selected=new Set([...state.selected].filter(id=>state.snapshot.graph.nodes.some(n=>n.id===id)));
      if (activeNode()) await fetchInputs(activeNode().id);
      render();break;
    }
    case 'preview-draft': {
      const previous=state.previewDraft;
      state.previewDraft=null;
      await resumeProjectDraft();
      if (!state.draft && previous) notice('此草稿已在其他窗口处理。');
      render();break;
    }
    case 'cancel-graph': await closeDraft(false); break;
    case 'save-graph': await closeDraft(true); break;
    case 'retry-draft': await saveCanvasDraft(api,state.draft,refreshDraftStatus); render(); break;
    case 'load-saved-draft': await loadSavedDraft(); break;
    case 'default-instruction':
      modal.querySelector('textarea[name="instruction"]').value=activeNode()?.instruction || '';break;
    case 'edit-inputs': {
      const node = activeNode();
      await fetchInputs(node.id);
      showModal('执行指令与输入文件', inputForm(node));
      break;
    }
    case 'node-tab':
      state.nodeTab = value;
      render();
      break;
    case 'run':
    case 'run-tree': {
      const includeDownstream = name === 'run-tree';
      if (includeDownstream) {
        const affected = new Set(picked());
        const queue = picked();
        for (const from of queue) for (const edge of graph().edges) if (edge.from === from && !affected.has(edge.to)) {
          affected.add(edge.to);
          queue.push(edge.to);
        }
        if (!window.confirm('本轮计划执行：' + graph().nodes.filter(node => affected.has(node.id)).map(node => node.title).join('、'))) break;
      }
      await api(projectPath() + '/runs', { method: 'POST', body: { nodeIds: picked(), includeDownstream, requestId: crypto.randomUUID() } });
      await reloadProject();
      state.nodeTab = 'inputs';
      render();
      notice('已提交执行。');
      break;
    }
    case 'round-action': {
      if (value === 'restart' && !window.confirm('停止选中节点的当前执行，并提交新一轮？')) break;
      const rounds = picked().map(lastRound);
      const issues = [];
      for (const round of rounds) {
        try {
          await api(projectPath() + '/node-runs/' + segment(round.id) + '/actions', { method: 'POST', body: { action: value, requestId: crypto.randomUUID() } });
        } catch (error) { issues.push((round.title ?? '节点') + '：' + error.message); }
      }
      await reloadProject();
      render();
      notice(issues.length ? '已处理 ' + (rounds.length - issues.length) + '/' + rounds.length + ' 个节点。' + issues.join('；') : '操作已提交。');
      break;
    }
    case 'review': {
      const round = lastRound(activeNode()?.id);
      if (!round?.artifact) break;
      showModal({ approve: '批准并交接', reject: '退回节点', edit: '人工编辑成果' }[value], reviewForm(value, round));
      break;
    }
    case 'pick-docs': main.querySelector('#doc-picker')?.click(); break;
    case 'new-doc': showModal('新建资料', documentForm()); break;
    case 'new-episode': showModal('添加分集正文', documentForm(undefined, 'episode')); break;
    case 'document': await openDocument(value); break;
    case 'versioned-document': await openDocument(value,event.target.closest('[data-version]').dataset.version);break;
    case 'edit-document': {
      const doc = await api(projectPath() + '/documents/' + segment(value));
      showModal('编辑资料', documentForm(doc));
      break;
    }
    case 'link-episode': {
      const docs=state.snapshot.documents.filter(d=>d.kind==='episode');
      showModal('关联分集或场次','<form class="flow-form" data-form="link-episode" data-id="'+escape(value)+'"><label>处理方式<select name="target"><option value="">用这一版成果新建分集正文</option>'+
        docs.map(d=>'<option value="'+escape(d.id)+'" data-version="'+d.version+'">关联已有：第 '+d.episode+' 集'+(d.scene?' · '+escape(d.scene):'')+' · '+escape(d.name)+' v'+d.version+'</option>').join('')+
        '</select></label><fieldset><legend>新分集正文</legend><label>集数<input type="number" min="1" max="10000" name="episode" required></label><label>场次（可选）<input name="scene" maxlength="200"></label></fieldset>'+
        '<p class="small">关联已有分集会保存两个确切版本之间的链接。新建会复制当前成果正文。</p><button type="submit" class="btn primary">保存关联</button><p class="small form-error" role="alert"></p></form>');break;
    }
    case 'artifact': await openArtifact(value); break;
    case 'review-history':
    case 'next-history': {
      const offset=name==='next-history'?Number(event.target.closest('[data-offset]').dataset.offset):0;
      const data=await api(projectPath() + '/node-runs/' + segment(value) + '/history?offset='+offset);
      const labels = {approve:'批准',reject:'退回',edit:'编辑'};
      const audit = data.reviews.map(row => '<li class="preflight-item"><strong>' + escape(labels[row.decision] ?? row.decision) +
        '</strong> · ' + escape(new Date(row.at).toLocaleString()) + '<p class="preserve">' + escape(row.note) + '</p>' + button('查看原稿','artifact:'+row.artifactId,'text') +
        (row.revisedArtifactId && row.revisedArtifactId !== row.artifactId ? button('查看新稿','artifact:'+row.revisedArtifactId,'light') : '') + '</li>').join('');
      const events=data.events.map(item=>'<li class="preflight-item"><strong>'+escape(item.agent)+'</strong> · '+escape(item.kind)+' · '+escape(item.at)+
        '<p class="preserve">'+escape(item.text)+'</p></li>').join('');
      showModal('本轮执行与审稿记录','<h3>稿件版本</h3><div class="row wrap">'+data.drafts.map(d=>button(d.title+' v'+d.version,'artifact:'+d.id,'text')).join('')+
        '</div><h3>人工审稿</h3>'+(audit?'<ul class="preflight-list">'+audit+'</ul>':'<p class="small">暂无人工审稿。</p>')+
        '<h3>会话与工具记录</h3>'+(events?'<ul class="preflight-list editor-messages">'+events+'</ul>':'<p class="small">本页暂无执行消息。</p>')+
        '<div class="row wrap">'+(offset?button('返回第一页','review-history:'+value,'text'):'') +
        (data.nextOffset!==undefined?button('下一页记录','next-history:'+value,'light','data-offset="'+Number(data.nextOffset)+'"'):'')+'</div>');
      break;
    }
    case 'dispatch-annotation': {
      const result=await api(projectPath()+'/annotations/'+segment(value)+'/dispatch',{method:'POST',body:{}});
      if(result.source==='artifact') await openArtifact(result.sourceId); else await openDocument(result.sourceId,result.version);
      notice('已提交原批注，可从此处查看任务。');break;
    }
    case 'annotation-compare':
    case 'annotation-reanchor': {
      const {entry,latest,stale}=await api(projectPath()+'/annotations/'+segment(value)+'/source');
      if(name==='annotation-reanchor') {
        if(entry.source==='artifact') await openArtifact(latest.id);else await openDocument(latest.id,latest.version);
        const excerpt=modal.querySelector('#document-excerpt');
        reanchors.set(excerpt,entry);
        const hint=document.createElement('p');
        hint.className='flow-alert';
        hint.textContent='在最新稿重新选择原批注的对应文字，然后点“批注选中文字”。原意见：'+entry.text;
        excerpt.before(hint);
      } else {
        showModal('对照批注与最新稿','<h3>原选区 · v'+escape(entry.version)+'</h3><blockquote>'+escape(entry.selectedText)+'</blockquote><p>'+escape(entry.text)+
          '</p><h3>最新稿同一位置附近 · v'+escape(latest.version)+'</h3><pre class="material-preview">'+escape(latest.excerpt)+'</pre>'+
          ((stale || entry.status==='rejected' || entry.status==='failed' || entry.status==='blocked')?button('在最新稿重新定位','annotation-reanchor:'+entry.id,'light'):'<p class="small">原批注已定位于最新版本。</p>'));
      }
      break;
    }
    case 'annotation-task': {
      const entry=(await api(projectPath()+'/annotations')).find(row=>row.id===value);
      if(!entry?.runId) throw new Error('未找到关联的委派任务');
      await api(projectPath()+'/editor/sessions/'+segment(entry.runId),{method:'PUT',body:{}});
      await editorModal();break;
    }
    case 'annotation-origin':
    case 'annotation-candidate':
    case 'annotation-revision': {
      const entry = (await api(projectPath() + '/annotations')).find(row => row.id === value);
      if (!entry) throw new Error('批注未找到');
      if(name === 'annotation-origin') {
        if(entry.source==='artifact') await openArtifact(entry.sourceId); else await openDocument(entry.sourceId,entry.version);
      } else if (name === 'annotation-revision') {
        if(entry.source === 'artifact') await openArtifact(entry.revision.id);
        else await openDocument(entry.revision.id,entry.revision.version);
      } else {
        showModal('审阅批注修订', '<p class="small">原文 v' + entry.version + '</p><blockquote>' + escape(entry.selectedText) + '</blockquote><p>' + escape(entry.text) +
          '</p><form class="flow-form" data-form="apply-annotation" data-id="' + escape(entry.id) + '"><label>替换选区的候选文本<textarea name="replacement" rows="6">' +
          escape(entry.candidate) + '</textarea></label><p class="small">采纳会创建新版本，选区以外保留原文。</p><div class="row wrap"><button type="submit" class="btn primary">采纳修订</button>' +
          button('放弃修订','dismiss-annotation:'+entry.id,'text') + '</div><p class="small form-error" role="alert"></p></form>');
      }
      break;
    }
    case 'dismiss-annotation': {
      const entry=await api(projectPath()+'/annotations/'+segment(value),{method:'POST',body:{decision:'dismiss',requestId:crypto.randomUUID()}});
      if(entry.source==='artifact') await openArtifact(entry.sourceId); else await openDocument(entry.sourceId,entry.version);
      break;
    }
    case 'annotate': {
      const selection = window.getSelection();
      const container = modal.querySelector('#document-excerpt');
      if (!selection || !container?.contains(selection.anchorNode) || !container.contains(selection.focusNode) || !selection.toString().trim()) {
        notice('先选中需要修改的分集正文。');
        break;
      }
      const quote = selection.toString();
      const range = document.createRange();
      range.setStart(container, 0);
      range.setEnd(selection.getRangeAt(0).startContainer, selection.getRangeAt(0).startOffset);
      const offset = range.toString().length;
      if (quote.length > 4000) return notice('选区过长，请缩小至需要修改的段落。');
      const version = Number(container.dataset.version);
      const source = container.dataset.source || 'episode';
      const previous = reanchors.get(container);
      showModal('提交批注', '<blockquote class="material-preview">' + escape(quote) + '</blockquote><form class="flow-form" data-form="annotation">' +
        '<label>修改意见<textarea name="note" rows="5" maxlength="1000" required>' + escape(previous?.text || '') + '</textarea></label>' +
        '<label>批注处理<select name="dispatch"><option value="task">提交总编修订</option><option value="save">仅保存批注</option></select></label>' +
        '<p class="small form-error" role="alert"></p><button class="btn primary" type="submit">提交批注</button></form>');
      annotationContexts.set(modal.querySelector('form'), {source,sourceId:value,version,quote,offset,reanchorOf:previous?.id});
      break;
    }
    case 'previous-episodes':
      state.episodePage = Math.max(1, state.episodePage - 1);
      render();
      break;
    case 'next-episodes': state.episodePage++; render(); break;
    case 'editor': await editorModal(); break;
    case 'project-editor':
      showModal('作品默认总编', '<form class="flow-form" data-form="project-editor">' + editorChoice(state.snapshot.project.editorAgentId) +
        '<p class="small">用于新对话及后续委派，已有会话保留原总编。</p><button class="btn primary" type="submit">保存</button><p class="form-error" role="alert"></p></form>'); break;
    case 'agent-proposal': {
      const proposal=await api(projectPath()+'/editor/agent-proposals/'+segment(value));
      showModal('配置总编建议的 Agent',agentForm(undefined,proposal));
      break;
    }
    case 'discard-agent-proposal':
      await api(projectPath()+'/editor/agent-proposals/'+segment(value),{method:'POST',body:{action:'discard'}});
      await editorModal();break;
    case 'proposal': {
      const prior=state.draft || state.previewDraft;
      if (prior && !window.confirm('用总编提案替换当前画布草稿？')) break;
      if(prior) await saveCanvasDraft(api,prior,refreshDraftStatus);
      const proposal = await api(projectPath() + '/editor/proposals/' + segment(value));
      state.previewDraft=null;
      state.draft = {scope:'project',id:state.snapshot.project.id,revision:prior?.revision ?? null,replaceSource:!!prior?.revision,baseVersion:proposal.baseVersion,sourceVersion:proposal.baseVersion,proposalId:value,graph:{version:proposal.baseVersion,nodes:proposal.nodes,edges:proposal.edges}};
      markGraphChanged();
      state.section='workflow'; state.selected=new Set(proposal.nodes.slice(0,1).map(n=>n.id));state.linkFrom=null;modal.close();render();break;
    }
    case 'discard-proposal':
      if (!window.confirm('放弃这份总编草案？')) break;
      await api(projectPath() + '/editor/proposals/' + segment(value),{method:'POST',body:{action:'discard'}});
      await editorModal(); break;
    case 'stop-run':
      if(!window.confirm('停止这次运行及其未完成的子任务？')) break;
      await api(projectPath()+'/runs/'+segment(value)+'/stop',{method:'POST',body:{}});
      await handleAction('receipt-run:'+value,event);break;
    case 'receipt-run': {
      const runs=await api(projectPath()+'/runs');
      const run=runs.find(r=>r.id===value); if(!run) throw new Error('未找到本作品的运行');
      showModal('工作流运行', '<p class="small">画布 v' + escape(run.graphVersion) + ' · ' + escape(run.id) + '</p>' +
        (run.stopRequestedAt ? '<p>' + (run.stoppedAt?'已停止':'停止中') + '</p>' : '') + (run.stopError ? '<p class="form-error">' + escape(run.stopError) + '</p>' : '') +
        (run.nodes.some(n=>!['failed','cancelled','released','rejected'].includes(n.status)) && (!run.stopRequestedAt || run.stopError) ? button('停止此轮','stop-run:'+run.id,'light') : '') +
        '<ul class="preflight-list">' + run.nodes.map(node=>'<li class="preflight-item">'+escape(node.title)+' · '+escape(nodeStatus(node))+
        (node.reason?'<p>'+escape(node.reason)+'</p>':'')+childTaskList(node)+'</li>').join('')+'</ul>' + button('返回对话','editor','light'));break;
    }
    case 'new-editor-session': showModal('新建总编对话', editorSessionForm()); break;
    case 'probe-model': {
      const model = state.models[Number(value)];
      if (!model) return;
      const modelKey = JSON.stringify([model.provider, model.model]);
      if (pendingModelProbes.has(modelKey)) {
        notice('该模型的连接测试正在进行。');
        return;
      }
      pendingModelProbes.add(modelKey);
      const started = performance.now();
      const elapsed = () => ((performance.now() - started) / 1000).toFixed(1) + ' 秒';
      showModal('模型连接测试', '<p class="small">' + escape(model.name || model.model) + '</p><p data-probe-status></p>');
      const status = modal.querySelector('[data-probe-status]');
      const waiting = () => { status.textContent = '正在等待模型响应，已用 ' + elapsed() + '。首次加载本地模型可能较慢。'; };
      waiting();
      const timer = setInterval(waiting, 1000);
      try {
        const result = await api('/models/probe', { method: 'POST', body: { provider: model.provider, model: model.model } });
        status.textContent = result.message + '（' + elapsed() + '）';
        if (!modal.open || !status.isConnected) notice((model.name || model.model) + '：' + result.message);
      } catch (error) {
        status.textContent = '连接测试未完成（' + elapsed() + '）。';
        throw error;
      } finally {
        clearInterval(timer);
        pendingModelProbes.delete(modelKey);
      }
      break;
    }
  }
}

function encodeFile(bytes) {
  if (bytes.toBase64) return bytes.toBase64();
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(binary);
}

async function uploadFiles(files, destination) {
  const references = [];
  const failures = [];
  for (const file of files) {
    try {
      const result = await parseMaterial(file);
      const source = { name: file.name, base64: encodeFile(result.bytes), ...(file.type ? { mime: file.type } : {}) };
      const doc = await api(destination + '/documents', { method: 'POST', body: { name: result.title, content: result.body, source } });
      references.push({ id: doc.id, version: doc.version });
    } catch (error) {
      failures.push(file.name + '：' + error.message);
    }
  }
  return { references, failures };
}

const stagedFiles = new WeakMap();
const annotationContexts = new WeakMap();
const reanchors = new WeakMap();

async function handleForm(form) {
  const fields = new FormData(form);
  const value = name => String(fields.get(name) ?? '').trim();
  switch (form.dataset.form) {
    case 'project': {
      const template = state.templates.find(item => item.id === value('template'));
      const project = await api('/projects', { method: 'POST', body: { name: value('name'), description: value('description'), ...(value('agent') ? {editorAgentId:value('agent')} : {}), ...(template ? { templateId: template.id, templateVersion: template.version } : {}) } });
      await loadCatalog();
      await openProject(project.id);
      break;
    }
    case 'agent': {
      const model = state.models.find(item => modelKey(item) === value('model'));
      if (!model) throw new Error('请选择一个可用模型。');
      const existing = agentById(form.dataset.id);
      const role = existing?.role || value('role');
      const config = {
        ...(existing ? { id: existing.id, expectedVersion: Number(form.dataset.version) } : {}),
        name: value('name'), role, systemPrompt: value('prompt'),
        selection: { provider: model.provider, model: model.model, ...(value('effort') ? { reasoningEffort: value('effort') } : {}) },
        publicNetwork: role === 'worker' && fields.has('network'),
        skillIds: fields.getAll('skill'), delegateIds: role === 'worker' ? [] : fields.getAll('delegate').filter(id => role === 'orchestrator' || agentById(id)?.role === 'worker'),
      };
      if(form.dataset.proposal) {
        await api(projectPath()+'/editor/agent-proposals/'+segment(form.dataset.proposal),{method:'POST',body:{action:'save',agent:config}});
        await loadCatalog(); render();return editorModal();
      }
      await api('/agents',{method:'POST',body:config});
      await loadCatalog(); render();notice('Agent 配置已保存。');
      break;
    }
    case 'skill': {
      const existing = form.dataset.id;
      await api('/skills', { method: 'POST', body: {
        ...(existing ? { id: existing, expectedVersion: Number(form.dataset.version) } : {}),
        name: value('name'), summary: value('summary'), body: String(fields.get('body') ?? ''),
      } });
      await loadCatalog();
      render();
      skillCatalog();
      notice(existing ? '新版 Skill 已保存。' : 'Skill 已创建。');
      return;
    }
    case 'template': {
      if (isTemplate()) {
        Object.assign(state.draft.item, { name: value('name'), description: value('description') });
        markGraphChanged(); render();
      } else {
        await startTemplateDraft({ name: value('name'), description: value('description') }, value('source') === 'project' ? state.snapshot.graph : undefined);
      }
      break;
    }
    case 'node': {
      const draft = startGraphDraft().graph;
      const current = draft.nodes.find(node => node.id === form.dataset.id);
      const node = {
        id: current?.id ?? crypto.randomUUID(), title: value('title'), agentId: value('agent'), instruction: value('instruction'),
        inputRule: value('inputRule'), outputRule: value('outputRule'), release: value('release'),
        ...(current ? { x: current.x, y: current.y } : availablePosition()),
      };
      if (current) draft.nodes[draft.nodes.indexOf(current)] = node;
      else draft.nodes.push(node);
      markGraphChanged();
      selectNode(node.id);
      break;
    }
    case 'document':
      await api(projectPath() + '/documents', { method: 'POST', body: {
        ...(form.dataset.id ? { id: form.dataset.id, expectedVersion: Number(form.dataset.version) } : {}),
        name: value('name'), content: String(fields.get('content') ?? ''), kind: form.dataset.kind,
        ...(form.dataset.kind === 'episode' ? { episode: Number(value('episode')), ...(value('scene') ? { scene: value('scene') } : {}), ...(value('field') ? { field: value('field') } : {}) } : {}),
      } });
      await reloadProject();
      render();
      notice('已保存资料版本。');
      break;
    case 'inputs': {
      const documents = fields.getAll('document').map(item => {
        const [id, revision] = String(item).split(':');
        return { id, version: Number(revision) };
      });
      const files = stagedFiles.get(form) ?? fields.getAll('uploads').filter(file => file.name);
      const result = await uploadFiles(files, projectPath());
      for (const ref of result.references) if (!documents.some(doc => docKey(doc) === docKey(ref))) documents.push(ref);
      const instruction=value('instruction');
      const draft = { ...(instruction && instruction!==activeNode()?.instruction ? {instruction} : {}), documents };
      await api(projectPath() + '/node-inputs/' + segment(form.dataset.id), { method: 'PUT', body: draft });
      state.inputDrafts.set(form.dataset.id, draft);
      if (files.length) await reloadProject();
      render();
      notice(result.failures.length ? result.failures.join('；') : '已保存，后续执行将沿用这些输入。');
      break;
    }
    case 'review': {
      await api(projectPath() + '/node-runs/' + segment(form.dataset.round) + '/review', { method: 'POST', body: {
        decision: form.dataset.decision, artifactId: form.dataset.artifact, requestId: crypto.randomUUID(),
        ...(value('note') ? { note: value('note') } : {}), ...(value('content') ? { content: String(fields.get('content')) } : {}),
      } });
      await reloadProject();
      state.nodeTab = 'review';
      render();
      notice({ approve: '已批准。', edit: '已保存新稿。', reject: '已退回并记录意见。' }[form.dataset.decision]);
      break;
    }
    case 'project-editor':
      await api(projectPath()+'/editor-agent',{method:'POST',body:{agentId:value('agent')}});
      await reloadProject();render();notice('已保存作品默认总编。');break;
    case 'editor':
      await api(projectPath() + '/editor', { method: 'POST', body: {
        text: value('text'), mode: value('mode'), requestId: crypto.randomUUID(), ...(value('agent') ? { agentId: value('agent') } : {}),
      } });
      return editorModal();
    case 'editor-session':
      await api(projectPath() + '/editor/sessions', { method: 'POST', body: {
        requestId: crypto.randomUUID(), ...(value('agent') ? { agentId: value('agent') } : {}),
      } });
      return editorModal();
    case 'annotation': {
      const entry = annotationContexts.get(form);
      const dispatch = value('dispatch') === 'task';
      const text = value('note');
      const submission = JSON.stringify([dispatch,text]);
      if (entry.submission !== submission) {entry.requestId = crypto.randomUUID();entry.submission = submission;}
      const result = await api(projectPath() + '/annotations', {method:'POST',body:{
        source:entry.source, sourceId:entry.sourceId, version:entry.version, start:entry.offset, end:entry.offset+entry.quote.length,
        selectedText:entry.quote, text, dispatch, reanchorOf:entry.reanchorOf,requestId:entry.requestId}});
      notice(result.taskId ? '已创建修订任务，可在原文批注处查看进度。' : '批注已保存。');
      break;
    }
    case 'link-episode': {
      const target=value('target');
      const spec=target ? {mode:'existing',documentId:target,version:Number(form.elements.target.selectedOptions[0].dataset.version)} :
        {mode:'new',episode:Number(value('episode')),...(value('scene')?{scene:value('scene')}:{})};
      const content=JSON.stringify(spec);
      if(form.dataset.lastInput!==content) {form.dataset.request=crypto.randomUUID();form.dataset.lastInput=content;}
      await api(projectPath()+'/artifacts/'+segment(form.dataset.id)+'/episodes',{method:'POST',body:{...spec,requestId:form.dataset.request}});
      await reloadProject();render();return openArtifact(form.dataset.id);
    }
    case 'apply-annotation': {
      const result=await api(projectPath()+'/annotations/'+segment(form.dataset.id),{method:'POST',body:{
        decision:'apply',replacement:String(fields.get('replacement') ?? ''),requestId:crypto.randomUUID()}});
      await reloadProject(); render();
      if(result.source==='artifact') return openArtifact(result.revision.id);
      return openDocument(result.revision.id,result.revision.version);
    }
  }
  modal.close();
}

document.addEventListener('click', event => {
  const action = event.target.closest('[data-action]');
  if (!action) {
    const card = event.target.closest('[data-node-card]');
    if (card && !event.target.closest('button')) selectNode(card.dataset.nodeCard, event.metaKey || event.ctrlKey || event.shiftKey);
    return;
  }
  if (action.disabled) return;
  action.disabled = true;
  Promise.resolve(handleAction(action.dataset.action, event)).catch(error => notice(error.message)).finally(() => { action.disabled = false; });
});

document.addEventListener('submit', event => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  if (form.dataset.busy) return;
  form.dataset.busy = 'true';
  const submit = form.querySelector('button[type="submit"]');
  const errorArea = form.querySelector('.form-error');
  submit.disabled = true;
  if (errorArea) errorArea.textContent = '';
  handleForm(form).catch(error => {
    if (errorArea) errorArea.textContent = error.message;
    else notice(error.message);
  }).finally(() => {
    delete form.dataset.busy;
    submit.disabled = false;
  });
});

function showStagedNames(form) {
  const area = form.querySelector('#attached-files');
  if (area) area.textContent = (stagedFiles.get(form) ?? []).map(file => file.name).join('、');
}

document.addEventListener('change', event => {
  const input = event.target;
  if (input.id === 'episode-limit') {
    state.perPage = Number(input.value);
    state.episodePage = 1;
    render();
  } else if (input.id === 'doc-version') {
    openDocument(input.dataset.document, input.value).catch(error => notice(error.message));
  } else if (input.id === 'editor-session') {
    input.disabled = true;
    api(projectPath() + '/editor/sessions/' + segment(input.value), { method: 'PUT', body: {} }).then(editorModal).catch(error => {
      input.disabled = false;
      notice(error.message);
    });
  } else if(input.matches('[data-form="link-episode"] [name="target"]')) {
    input.form.querySelector('fieldset').hidden=Boolean(input.value);input.form.querySelector('fieldset').disabled=Boolean(input.value);
  } else if(input.matches('[data-form="node"] [name="agent"]')) {
    input.form.querySelector('[data-node-hint]').textContent=nodeHint(agentById(input.value));
  } else if (input.matches('[data-form="agent"] [name="model"]')) {
    input.form.elements.effort.innerHTML = effortOptions(state.models.findIndex(item => modelKey(item) === input.value));
  } else if (input.matches('[data-form="agent"] [name="role"]')) {
    input.form.querySelector('fieldset').hidden = input.value !== 'worker';
    input.form.querySelector('[data-role-policy]').outerHTML = rolePolicy(input.value);
    const delegates = input.form.querySelector('[data-delegates]');
    delegates.hidden = input.value === 'worker';
    for (const row of delegates.querySelectorAll('[data-child-role]')) row.hidden = input.value === 'manager' && row.dataset.childRole !== 'worker';
  } else if (input.matches('[data-form="skill"] [name="source"]') && input.files.length) {
    const file = input.files[0];
    const form = input.form;
    if (file.size > 96000) {
      form.querySelector('.form-error').textContent = 'Skill 文件过大，请导入精简后的文本。';
      return;
    }
    file.text().then(body => {
      if (body.length > 24000) throw new Error('Skill 正文超过 24000 字符。');
      form.elements.body.value = body;
    }).catch(error => { form.querySelector('.form-error').textContent = error.message; });
  } else if (input.matches('[data-form="inputs"] [name="uploads"]')) {
    stagedFiles.set(input.form, [...input.files]);
    showStagedNames(input.form);
  } else if (input.id === 'doc-picker' && input.files.length) {
    const projectId = state.snapshot.project.id;
    input.disabled = true;
    notice('正在读取资料。');
    uploadFiles([...input.files], projectPath()).then(async ({ references, failures }) => {
      if (projectId === state.snapshot?.project.id) {
        await reloadProject();
        render();
      }
      notice([references.length ? '已保存 ' + references.length + ' 份资料。' : '', ...failures].filter(Boolean).join('；'));
    }).catch(error => notice(error.message)).finally(() => { input.disabled = false; input.value = ''; });
  }
});

for (const type of ['dragover', 'dragleave', 'drop']) {
  document.addEventListener(type, event => {
    const target = event.target.closest('.node-input-drop');
    if (!target) return;
    event.preventDefault();
    target.classList.toggle('is-dragging', type === 'dragover');
    if (type !== 'drop') return;
    const form = target.closest('form');
    const files = stagedFiles.get(form) ?? [];
    stagedFiles.set(form, [...files, ...event.dataTransfer.files]);
    showStagedNames(form);
  });
}

document.addEventListener('mousedown', event => {
  if (event.target.closest('#annotate-button')) event.preventDefault();
});

function closeCanvasMenu() {
  canvasMenu?.remove();
  canvasMenu=null;
}

function openCanvasMenu(node, x, y) {
  selectNode(node.id);
  const menu=document.createElement('div');
  menu.className='canvas-context';
  menu.setAttribute('role','menu');
  menu.setAttribute('aria-label','节点操作');
  menu.innerHTML=button('节点设置','edit-node','text','role="menuitem"') + button('删除节点','delete-nodes','text destructive','role="menuitem"');
  document.body.append(menu);
  canvasMenu=menu;
  menu.style.left=Math.max(4,Math.min(innerWidth-menu.offsetWidth-4,x))+'px';
  menu.style.top=Math.max(4,Math.min(innerHeight-menu.offsetHeight-4,y))+'px';
  menu.firstElementChild.focus({preventScroll:true});
}

main.addEventListener('contextmenu',event=>{
  const canvas=event.target.closest('.graph-canvas');
  if (!canvas) return;
  event.preventDefault();
  if (state.draft?.locked || state.previewDraft) return;
  const card=event.target.closest('[data-node-card]');
  if (card) {
    const node=graph().nodes.find(n=>n.id===card.dataset.nodeCard);
    if (node) openCanvasMenu(node,event.clientX,event.clientY);
    return;
  }
  const box=canvas.getBoundingClientRect();
  const draft=startGraphDraft();
  let number=1;
  const titles=new Set(draft.graph.nodes.map(n=>n.title));
  while (titles.has('新节点 '+number)) number++;
  const node={id:crypto.randomUUID(),title:'新节点 '+number,agentId:'',release:'manual',instruction:'',inputRule:'',outputRule:'',
    x:Math.max(0,Math.min(25000,Math.round(event.clientX-box.left))),y:Math.max(0,Math.min(25000,Math.round(event.clientY-box.top)))};
  draft.graph.nodes.push(node);
  markGraphChanged();
  selectNode(node.id);
});
document.addEventListener('pointerdown',event=>{
  if (canvasMenu && !canvasMenu.contains(event.target)) closeCanvasMenu();
});
document.addEventListener('click',event=>{
  if (canvasMenu?.contains(event.target)) closeCanvasMenu();
});
document.addEventListener('scroll',closeCanvasMenu,true);
window.addEventListener('resize',closeCanvasMenu);
document.addEventListener('keydown',event=>{
  if (!canvasMenu) return;
  if (event.key==='Escape') {
    closeCanvasMenu();
    main.querySelector('[data-node-card].selected .graph-title')?.focus({preventScroll:true});
  } else if (event.key==='ArrowUp' || event.key==='ArrowDown') {
    event.preventDefault();
    const items=[...canvasMenu.querySelectorAll('button')];
    const offset=event.key==='ArrowDown'?1:-1;
    items[(items.indexOf(document.activeElement)+offset+items.length)%items.length].focus();
  } else if (event.key==='Tab') closeCanvasMenu();
});

document.addEventListener('pointerdown', event => {
  const grip=event.target.closest('[data-drag-node], [data-port-out], .graph-title');
  if (!grip || event.button!==0 || state.draft?.locked || state.previewDraft) return;
  const node=graph().nodes.find(item=>item.id===grip.closest('[data-node-card]').dataset.nodeCard);
  pointer={id:event.pointerId,nodeId:node.id,grip,type:grip.hasAttribute('data-port-out')?'link':'move',
    origin:[event.clientX,event.clientY],position:[node.x,node.y],moved:false,workspace:state.draft};
  grip.setPointerCapture?.(event.pointerId);
});

function moveNode(node,x,y) {
  node.x=Math.max(0,Math.min(25000,Math.round(x)));
  node.y=Math.max(0,Math.min(25000,Math.round(y)));
  positionGraph();
}
document.addEventListener('pointermove',event=>{
  if (pointer?.id!==event.pointerId || pointer.workspace!==state.draft) return;
  const dx=event.clientX-pointer.origin[0],dy=event.clientY-pointer.origin[1];
  if (!pointer.moved && Math.hypot(dx,dy)<4) return;
  if (pointer.type==='move' && !pointer.moved) pointer.workspace=startGraphDraft();
  pointer.moved=true;
  const node=graph().nodes.find(n=>n.id===pointer.nodeId);
  if (pointer.type==='move') moveNode(node,pointer.position[0]+dx,pointer.position[1]+dy);
  else {
    const box=main.querySelector('.graph-canvas').getBoundingClientRect();
    main.querySelector('#graph-drag-wire').setAttribute('d','M '+(node.x+GRAPH_CARD.width/2)+' '+(node.y+GRAPH_CARD.height)+' L '+(event.clientX-box.left)+' '+(event.clientY-box.top));
  }
});

function endDrag(event) {
  if (pointer?.id!==event.pointerId) return;
  const completed=pointer;
  pointer=null;
  main.querySelector('#graph-drag-wire')?.removeAttribute('d');
  if (!completed.moved || completed.workspace!==state.draft) return;
  skipClickUntil=Date.now()+300;
  if (completed.type==='move') {
    if (event.type==='pointerup') { markGraphChanged(); selectNode(completed.nodeId); }
    else {
      const node=graph().nodes.find(n=>n.id===completed.nodeId);
      if (node) moveNode(node,...completed.position);
    }
    return;
  }
  if (event.type!=='pointerup') return;
  const input=document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-port-in]');
  if (input) addEdge(completed.nodeId,input.dataset.portIn);
  else notice('请拖到下游节点的输入端口。');
}
for (const type of ['pointerup','pointercancel','lostpointercapture']) document.addEventListener(type,endDrag);
document.addEventListener('keydown',event=>{
  const grip=event.target.closest('[data-drag-node]');
  const offsets={ArrowLeft:[-10,0],ArrowUp:[0,-10],ArrowRight:[10,0],ArrowDown:[0,10]};
  const offset=offsets[event.key];
  if (!grip || !offset || state.draft?.locked || state.previewDraft) return;
  event.preventDefault();
  const node=startGraphDraft().graph.nodes.find(n=>n.id===grip.dataset.dragNode);
  moveNode(node,node.x+offset[0],node.y+offset[1]);
  markGraphChanged();
  render();
  main.querySelector('[data-drag-node="'+CSS.escape(node.id)+'"]')?.focus({preventScroll:true});
});
window.addEventListener('beforeunload',event=>{
  if (state.draft?.pending || state.draft?.dirty) { event.preventDefault(); event.returnValue=true; }
});

async function initialize() {
  main.innerHTML = '<p class="small">正在打开工作台…</p>';
  try {
    const response = await fetch('/api/bootstrap');
    if (!response.ok) throw new Error('无法打开工作台。');
    ({ csrfToken: csrf } = await response.json());
    await loadCatalog();
    const params = new URL(location.href).searchParams;
    const project = params.get('project');
    if (params.get('page') === 'connections') {
      state.page = 'connections';
      await refreshModels();
    }
    else if (params.get('template')) {
      const id=params.get('template');
      const template=id==='new'?{name:'新模板',description:''}:await api('/templates/'+segment(id));
      await startTemplateDraft(template,template);
    }
    else if (params.get('page') === 'templates') { state.page='templates'; render(); }
    else if (params.get('page') === 'archive') await showLibrary(true);
    else if (project && state.projects.some(item => item.id === project)) await openProject(project);
    else if (project) {
      await showLibrary(false);
      notice('作品当前不可打开，可在「已归档」中查看。');
    } else render();
  } catch (error) {
    main.innerHTML = '<div class="paper pad"><h1>工作台无法连接</h1><p>' + escape(error.message) + '</p></div>';
  }
}

async function poll() {
  try {
    if (document.hidden || !renderingProject() || pointer) return;
    const notes = modal.open && modal.querySelector('[data-annotations][open]');
    if(notes) {
      const {source,sourceId,version}=notes.dataset;
      const rows=(await api(projectPath()+'/annotations')).filter(entry=>entry.source===source && entry.sourceId===sourceId && entry.version===Number(version));
      const markup=annotationsPanel(rows);
      if(notes.isConnected && markup && notes._lastMarkup !== markup && !getSelection()?.toString()) {
        const template=document.createElement('template');template.innerHTML=markup;
        const panel=template.content.firstElementChild;panel.open=true;panel._lastMarkup=markup;notes.replaceWith(panel);
      }
    }
    const editor = modal.open && modal.querySelector('#editor-updates');
    const project = state.snapshot.project.id;
    if (editor) {
      const data = await api(projectPath() + '/editor');
      if (project === state.snapshot?.project.id && editor.isConnected && editor.dataset.session === (data.sessionId || '')) {
        const markup=editorUpdates(data);
        if(editor._lastMarkup !== markup) { editor.innerHTML = markup; editor._lastMarkup = markup; }
      }
    }
    if (!modal.open && !state.draft) {
      const previous = JSON.stringify([state.snapshot.graph,state.snapshot.runs,state.snapshot.documents]);
      const focused = activeNode()?.id;
      const old = focused && lastRound(focused)?.status;
      await reloadProject();
      if (project === state.snapshot?.project.id && !modal.open && !state.draft && previous !== JSON.stringify([state.snapshot.graph,state.snapshot.runs,state.snapshot.documents])) {
        const ids = new Set(state.snapshot.graph.nodes.map(n => n.id));
        state.selected = new Set([...state.selected].filter(id => ids.has(id)));
        if (focused === activeNode()?.id && old !== 'review' && lastRound(focused)?.status === 'review') state.nodeTab = 'review';
        render();
      }
    }
  } catch (error) {
    connection.textContent = '连接中断，正在重试';
  } finally {
    setTimeout(poll, 1700);
  }
}

void initialize().then(() => setTimeout(poll, 1700));
