const $ = (id) => document.getElementById(id);
const roleNames = { orchestrator: 'Orchestrator', manager: 'Manager', worker: 'Worker' };
const roleInitials = { orchestrator: 'O', manager: 'M', worker: 'W' };
const modeNames = { auto: '自动判断', direct: '直接委派', hierarchical: '分层协作' };
const statusNames = { idle: '待命', ready: '就绪', pending: '等待中', queued: '排队中', running: '执行中', active: '进行中', waiting: '等待中', completed: '已完成', done: '已完成', stopped: '已停止', cancelled: '已取消', error: '异常', failed: '失败', created: '已创建', starting: '启动中', dormant: '休眠', paused: '已暂停', review: '待验收', blocked: '受阻', reported: '已报告', interrupted: '已中断' };
let snapshot = null;
let csrfToken = '';
let selectedRunId = null;
let selectedAgentId = null;
let selectedTemplateId = null;
let draftVersion = null;
let toastTimer;
let messageFingerprint = '';
let sending = false;
let creating = false;
let saving = false;
let eventSource = null;
let selectedView = 'tasks';
let taskFingerprint = '';
let appending = false;
let appendRunId = null;
const appendDrafts = new Map();
const pendingTaskActions = new Set();
const layerNames = {long: '长期', medium: '中期', short: '短期'};
let readRunId = null;
let memoryRequest = 0;
let memoryController;
let memoryBodyRequest = 0;
let memoryBodyController;
let memoryOffset = 0;
let memoryNextOffset;
let memoryLoaded = false;
let memorySelected;
let memoryBodyOffset = 0;
let memoryBodyNext;
let memoryBodyPrevious = [];
let fileRequest = 0;
let fileController;
let fileContext;
let fileOffset = 0;
let fileNextOffset;
let filePrevious = [];
function appendDraft(runId) {
  if (appendDrafts.has(runId)) return appendDrafts.get(runId);
  try {
    const saved = JSON.parse(sessionStorage.getItem(`studio.pendingTask.${runId}`) || 'null');
    if (saved && typeof saved.requestId === 'string' && typeof saved.prompt === 'string' && typeof saved.targetManagerId === 'string' && typeof saved.signature === 'string') {
      appendDrafts.set(runId, saved); return saved;
    }
  } catch { /* Browser storage may be disabled or contain an obsolete draft. */ }
  return undefined;
}
function saveAppendDraft(runId, draft) {
  if (draft) appendDrafts.set(runId, draft); else appendDrafts.delete(runId);
  try {
    if (draft) sessionStorage.setItem(`studio.pendingTask.${runId}`, JSON.stringify(draft));
    else sessionStorage.removeItem(`studio.pendingTask.${runId}`);
  } catch { /* In-memory draft still preserves the request ID when storage is unavailable. */ }
}

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = String(text);
  return result;
}
function dateLabel(value, full = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', full ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false } : { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
function statusLabel(status) { return statusNames[status] || status; }
function isRunning(status) { return ['running', 'active', 'starting', 'queued'].includes(status); }
function currentRun() { return snapshot?.runs.find((run) => run.id === selectedRunId); }
function setError(id, message) {
  $(id).textContent = message || '';
  $(id).hidden = !message;
}
function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}
async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET') headers.set('X-Studio-CSRF', csrfToken);
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const text = await response.text();
  let result;
  try { result = text ? JSON.parse(text) : undefined; } catch { result = { error: text }; }
  if (!response.ok) {
    const detail = typeof result?.error === 'string' ? result.error : result?.error?.message || result?.message;
    throw new Error(detail || `请求失败（${response.status}）`);
  }
  return result;
}
function connection(connected, label) {
  $('connection').className = `connection ${connected ? 'connected' : 'failed'}`;
  $('connection').lastElementChild.textContent = label;
}
function applySnapshot(next) {
  snapshot = next;
  if (!selectedRunId || !next.runs.some((run) => run.id === selectedRunId)) selectedRunId = next.runs[0]?.id || null;
  $('dshVersion').textContent = `DSH ${next.compatibility.dshVersion}`;
  $('dshVersion').title = next.compatibility.source || '独立插件原型';
  $('runCount').textContent = next.runs.length;
  renderRuns();
  renderConversation();
  renderTasks();
  renderTeam();
  renderActivity();
  renderCapabilities();
  syncReadViews();
  $('newRunButton').disabled = false;
  $('settingsButton').disabled = false;
}
function renderRuns() {
  const fragment = document.createDocumentFragment();
  for (const run of snapshot.runs) {
    const button = node('button', `run-item${run.id === selectedRunId ? ' selected' : ''}`);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(run.id === selectedRunId));
    button.title = run.title;
    button.append(node('span', 'run-item-title', run.title));
    const meta = node('span', 'run-item-meta');
    const state = node('span');
    state.append(node('i', `tiny-status ${run.status}`), document.createTextNode(statusLabel(run.status)));
    meta.append(state, node('span', '', dateLabel(run.createdAt, true)));
    button.append(meta);
    button.addEventListener('click', () => {
      if (selectedRunId === run.id) return;
      selectedRunId = run.id;
      selectedAgentId = null;
      messageFingerprint = '';
      $('messageText').value = '';
      taskFingerprint = '';
      renderRuns(); renderConversation(); renderTasks(); renderTeam(); renderActivity(); syncReadViews();
    });
    fragment.append(button);
  }
  if (!snapshot.runs.length) fragment.append(node('p', 'muted list-placeholder', '每个协作从新的 Session 开始，可追加多个独立任务。'));
  $('runList').replaceChildren(fragment);
}
function renderConversation() {
  const run = currentRun();
  const demoAgents = run?.agents.filter((agent) => agent.selection.provider === 'studio-demo').length || 0;
  const allDemo = run?.agents.length ? demoAgents === run.agents.length : snapshot.demo;
  const mixedDemo = !allDemo && demoAgents > 0;
  $('backendBadge').textContent = allDemo ? 'DEMO · 确定性模型' : mixedDemo ? '混合 · 含演示模型' : 'DSH · 已配置模型';
  $('backendBadge').classList.toggle('demo', allDemo || mixedDemo);
  $('backendBadge').title = allDemo ? '当前任务使用演示模型验证插件与协作流程，不代表真实模型推理。' : mixedDemo ? '当前任务包含真实模型与演示模型，请在成员详情查看各自配置。' : '当前使用 DSH 中配置的模型。';
  $('welcome').hidden = Boolean(run);
  $('workToolbar').hidden = !run;
  $('appendTaskButton').disabled = !run || run.status === 'stopped';
  $('appendTaskButton').title = run?.status === 'stopped' ? '此协作已停止，请新建协作' : '新增独立任务，已有任务继续执行';
  $('chatScroll').hidden = Boolean(run) && selectedView !== 'chat';
  document.querySelector('.composer-area').hidden = !run || selectedView !== 'chat';
  $('messages').hidden = !run;
  $('runTitle').textContent = run?.title || '从一个清晰的目标开始';
  $('runMode').hidden = !run;
  $('runStatus').hidden = !run;
  $('stopButton').hidden = !run || !run.tasks.some(task => ['queued', 'running', 'review'].includes(task.status));
  $('messageText').disabled = !run || sending;
  $('sendButton').disabled = !run || sending || !$('messageText').value.trim();
  if (!run) return;
  $('runMode').textContent = modeNames[run.mode] || run.mode;
  $('runStatus').textContent = statusLabel(run.status);
  $('runStatus').dataset.status = run.status;
  const fingerprint = JSON.stringify([run.id, run.status, run.messages]);
  if (fingerprint === messageFingerprint) return;
  const scroll = $('chatScroll');
  const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
  const switchedRun = !messageFingerprint;
  messageFingerprint = fingerprint;
  const fragment = document.createDocumentFragment();
  for (const message of run.messages) {
    const article = node('article', `message ${message.role}`);
    article.append(node('div', 'message-avatar', message.role === 'user' ? '你' : 'O'));
    const content = node('div', 'message-content');
    const head = node('div', 'message-head', message.role === 'user' ? '你' : 'Orchestrator');
    const time = node('time', '', dateLabel(message.createdAt));
    time.dateTime = message.createdAt;
    head.append(time);
    content.append(head, node('div', 'message-body', message.text));
    article.append(content);
    fragment.append(article);
  }
  if (run.agents.some(agent => agent.id === run.orchestratorId && isRunning(agent.status))) fragment.append(node('div', 'pending-message', 'Orchestrator 正在处理当前回合；其他任务继续执行…'));
  $('messages').replaceChildren(fragment);
  if (nearBottom || switchedRun) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
}
function renderTeam() {
  const run = currentRun();
  const agents = run?.agents || [];
  $('agentCount').textContent = agents.length;
  if (!agents.some((agent) => agent.id === selectedAgentId)) selectedAgentId = run?.orchestratorId || agents[0]?.id || null;
  const tree = document.createDocumentFragment();
  const visited = new Set();
  function appendAgent(agent, parent) {
    if (visited.has(agent.id)) return;
    visited.add(agent.id);
    const item = node('div', 'agent-node');
    const button = node('button', `agent-button${agent.id === selectedAgentId ? ' selected' : ''}`);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(agent.id === selectedAgentId));
    button.title = `${agent.name} · ${roleNames[agent.role]} · ${statusLabel(agent.status)}`;
    button.append(node('span', `role-icon ${agent.role}`, roleInitials[agent.role]));
    const text = node('span', 'agent-node-text');
    text.append(node('strong', '', agent.name), node('small', '', `${roleNames[agent.role]} · ${agent.selection.model}`));
    button.append(text, node('i', `tiny-status ${agent.status}`));
    button.addEventListener('click', () => { selectedAgentId = agent.id; renderTeam(); });
    item.append(button);
    const children = agents.filter((candidate) => candidate.parentId === agent.id);
    if (children.length) {
      const childContainer = node('div', 'agent-children');
      for (const child of children) appendAgent(child, childContainer);
      item.append(childContainer);
    }
    parent.append(item);
  }
  for (const agent of agents.filter((agent) => !agent.parentId || !agents.some((candidate) => candidate.id === agent.parentId))) appendAgent(agent, tree);
  for (const agent of agents) if (!visited.has(agent.id)) appendAgent(agent, tree);
  if (!agents.length) tree.append(node('p', 'muted list-placeholder', '创建任务后，团队会显示在这里。'));
  $('agentTree').replaceChildren(tree);
  renderDetail(agents.find((agent) => agent.id === selectedAgentId));
}
function renderDetail(agent) {
  const detail = $('agentDetail');
  if (!agent) { detail.replaceChildren(node('p', 'muted', '选择成员查看配置与最后结果。')); return; }
  const promptOpen = detail.dataset.agentId === agent.id && Boolean(detail.querySelector('details')?.open);
  detail.dataset.agentId = agent.id;
  const heading = node('div', 'detail-name');
  heading.append(node('span', `role-icon ${agent.role}`, roleInitials[agent.role]));
  const names = node('div');
  names.append(node('h3', '', agent.name), node('p', '', roleNames[agent.role]));
  heading.append(names);
  const data = node('dl', 'detail-grid');
  const rows = [['状态', statusLabel(agent.status)], ['模型', `${agent.selection.provider} / ${agent.selection.model}`], ['推理', agent.selection.reasoningEffort || '模型默认'], ['Session', agent.sessionId]];
  for (const [label, value] of rows) data.append(node('dt', '', label), node('dd', label === 'Session' ? 'mono' : '', value));
  const prompt = node('details', 'detail-fold');
  prompt.open = promptOpen;
  prompt.append(node('summary', '', '查看 System Prompt'), node('pre', '', agent.systemPrompt));
  const children = [heading, data, prompt];
  if (agent.lastResult) children.push(node('p', 'result-label', '最后结果'), node('p', 'last-result', agent.lastResult));
  else children.push(node('p', 'muted', '尚未提交结果。'));
  if (agent.error) children.push(node('p', 'agent-error', agent.error));
  detail.replaceChildren(...children);
}
function renderActivity() {
  const entries = snapshot.activity.filter((item) => item.runId === selectedRunId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 10);
  const list = entries.map((item) => {
    const member = currentRun()?.agents.find((agent) => agent.id === item.agentId);
    const name = member?.name || '团队';
    const labels = { probe: `${name} 返回能力探针结果`, report: `${name} 已提交结果`, 'agent-configured': `${name} 配置已就绪`, 'model-request': `${name} 请求模型 · ${item.text}` };
    const li = node('li', 'activity-item', labels[item.kind] || item.text);
    const time = node('time', '', dateLabel(item.createdAt));
    time.dateTime = item.createdAt;
    li.append(time);
    return li;
  });
  $('activityList').replaceChildren(...(list.length ? list : [node('li', 'muted', '暂无活动')]));
}
function populateOrchestrators() {
  $('orchestratorTemplate').replaceChildren(...snapshot.templates.filter((template) => template.role === 'orchestrator').map((template) => {
    const option = node('option', '', `${template.name} · v${template.version} · ${template.selection.model}`);
    option.value = template.id;
    return option;
  }));
}
function openNewRun(prompt = '', mode = 'auto') {
  if (!snapshot) return;
  $('taskPrompt').value = prompt;
  const radio = [...document.querySelectorAll('input[name="mode"]')].find((input) => input.value === mode);
  if (radio) radio.checked = true;
  populateOrchestrators();
  const fresh = node('option', '', '不复用 · 使用新的记忆身份'); fresh.value = '';
  $('reuseMemorySource').replaceChildren(fresh, ...snapshot.runs.map(run => {
    const option = node('option', '', `${run.title} · ${dateLabel(run.createdAt, true)}`);
    option.value = run.id; return option;
  }));
  $('reuseMemorySource').value = '';
  setError('newRunError', '');
  $('newRunDialog').showModal();
  $('taskPrompt').focus();
}
function selectView(view) {
  if (selectedView === 'memories' && view !== 'memories') {
    memoryRequest++; memoryController?.abort(); memoryLoaded = false;
    clearMemoryBody();
  }
  selectedView = view;
  for (const name of ['tasks', 'chat', 'memories']) {
    $(`${name}Tab`).setAttribute('aria-selected', String(view === name));
    $(`${name}Tab`).classList.toggle('selected', view === name);
  }
  renderConversation();
  renderTasks();
  syncReadViews();
}
function queuedReason(run, task) {
  const delivery = run.deliveries.find(item => item.taskId === task.id && item.state === 'pending');
  if (delivery?.error) return '投递暂未成功，等待自动重试';
  const receiver = run.agents.find(agent => agent.id === delivery?.agentId);
  if (receiver && isRunning(receiver.status)) return `等待 ${receiver.name} 当前回合结束`;
  const busy = snapshot.runs.flatMap(item => item.attempts).filter(attempt => attempt.status === 'running').length;
  if (busy >= snapshot.scheduler.maxActiveWorkers) return '执行资源已满，等待空闲 Worker 名额';
  return '已持久保存，等待协调者派工或执行资源';
}
function renderTasks() {
  const run = currentRun();
  $('taskBoard').hidden = !run || selectedView !== 'tasks';
  if (!run) return;
  $('taskCount').textContent = run.tasks.length;
  const busy = snapshot.runs.flatMap(item => item.attempts).filter(attempt => attempt.status === 'running').length;
  $('workerCapacity').textContent = `Worker 执行 ${busy} / ${snapshot.scheduler.maxActiveWorkers}`;
  const fingerprint = JSON.stringify([run.id, run.tasks, run.attempts, run.deliveries, run.agents.map(agent => [agent.id, agent.status]), busy, snapshot.scheduler, snapshot.capabilities, [...pendingTaskActions]]);
  if (fingerprint === taskFingerprint) return;
  taskFingerprint = fingerprint;
  const openDetails = new Set([...$('taskList').querySelectorAll('details[open]')].map(detail => detail.dataset.taskId));
  const cards = run.tasks.map((task) => {
    const card = node('article', `task-card task-${task.status}`);
    card.dataset.taskId = task.id;
    const heading = node('div', 'task-card-heading');
    const title = node('h3', '', task.title);
    const state = node('span', 'task-status', statusLabel(task.status));
    state.dataset.status = task.status;
    heading.append(title, state);
    const coordinator = run.agents.find(agent => agent.id === task.coordinatorId);
    const meta = node('p', 'task-meta', `Task ${task.id.slice(0, 8)} · ${coordinator?.name || '待分派'} · ${dateLabel(task.createdAt)}`);
    meta.title = task.id;
    card.append(heading, meta);
    if (task.status === 'queued') card.append(node('p', 'task-queue-note', queuedReason(run, task)));
    if (task.status === 'review') card.append(node('p', 'task-queue-note', '执行结果已提交，等待协调者验收'));
    if (task.result) card.append(node('p', 'task-result', task.result));
    if (task.error) card.append(node('p', 'task-error', task.error));
    const attempts = run.attempts.filter(attempt => attempt.taskId === task.id).sort((a, b) => a.number - b.number);
    const latest = attempts.at(-1);
    if (latest) {
      const worker = run.agents.find(agent => agent.id === latest.workerId);
      card.append(node('p', 'attempt-current', `第 ${latest.number} 次尝试 · ${worker?.name || latest.workerId.slice(0, 8)} · ${statusLabel(latest.status)}`));
    }
    const details = node('details', 'task-details');
    details.dataset.taskId = task.id;
    details.open = openDetails.has(task.id);
    details.append(node('summary', '', `任务说明与尝试记录（${attempts.length}）`), node('p', 'task-description', task.prompt));
    if (!attempts.length) details.append(node('p', 'muted', '尚未分配执行尝试。'));
    for (const attempt of attempts) {
      const row = node('div', 'attempt-record');
      row.append(node('strong', '', `Attempt ${attempt.number} · ${statusLabel(attempt.status)}`), node('span', 'mono', attempt.id));
      if (attempt.startedAt) row.append(node('small', '', `开始 ${dateLabel(attempt.startedAt, true)}${attempt.endedAt ? ` · 结束 ${dateLabel(attempt.endedAt, true)}` : ''}`));
      if (attempt.summary) row.append(node('p', '', attempt.summary));
      if (attempt.error) row.append(node('p', 'task-error', attempt.error));
      if (attempt.evidence?.length) {
        const evidence = node('ul', 'attempt-evidence');
        attempt.evidence.forEach(item => evidence.append(node('li', '', item)));
        row.append(evidence);
      }
      if (snapshot.capabilities.containers === 'enabled' && snapshot.capabilities.execution === 'docker') {
        const executing = ['queued', 'running'].includes(attempt.status);
        const files = node('button', 'button secondary compact', executing ? '执行结束后查看文件' : '查看文件'); files.type = 'button';
        files.disabled = executing;
        files.addEventListener('click', () => openFiles(run, task, attempt));
        row.append(files);
      }
      details.append(row);
    }
    card.append(details);
    const actions = node('div', 'task-actions');
    if (['failed', 'blocked'].includes(task.status)) {
      const retry = node('button', 'button secondary compact', '新建尝试并重试');
      retry.type = 'button'; retry.disabled = pendingTaskActions.has(task.id);
      retry.addEventListener('click', () => taskAction(run.id, task.id, 'retry'));
      actions.append(retry);
    }
    if (['queued', 'running', 'review', 'blocked', 'failed'].includes(task.status)) {
      const cancel = node('button', 'button compact danger', '取消此任务');
      cancel.type = 'button'; cancel.disabled = pendingTaskActions.has(task.id);
      cancel.addEventListener('click', () => taskAction(run.id, task.id, 'cancel'));
      actions.append(cancel);
    }
    if (actions.childElementCount) card.append(actions);
    return card;
  });
  $('taskList').replaceChildren(...(cards.length ? cards : [node('p', 'task-empty', '这是历史协作，尚无独立 Task 记录。可以追加新任务，原会话仍然保留。')]));
}
async function taskAction(runId, taskId, action) {
  if (pendingTaskActions.has(taskId)) return;
  pendingTaskActions.add(taskId); renderTasks();
  try {
    await api(`/api/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/${action}`, {method: 'POST', body: '{}'});
    setError('globalError', '');
    toast(action === 'retry' ? '新的执行尝试已进入队列' : '已取消此任务，其他任务继续执行');
    applySnapshot(await api('/api/state'));
  } catch (error) { setError('globalError', `操作失败：${error.message}`); }
  finally { pendingTaskActions.delete(taskId); renderTasks(); }
}
function openAppendTask() {
  const run = currentRun();
  if (!run) return;
  appendRunId = run.id;
  const draft = appendDraft(run.id);
  $('appendTaskPrompt').value = draft?.prompt || '';
  const defaultOption = node('option', '', '由 Orchestrator 安排');
  defaultOption.value = '';
  $('appendTaskManager').replaceChildren(defaultOption, ...run.agents.filter(agent => agent.role === 'manager').map(agent => {
    const option = node('option', '', `${agent.name} · ${statusLabel(agent.status)}`);
    option.value = agent.id; return option;
  }));
  $('appendTaskManager').value = draft?.targetManagerId || '';
  setError('appendTaskError', '');
  $('appendTaskDialog').showModal();
  $('appendTaskPrompt').focus();
}

function renderCapabilities() {
  const docker = snapshot.capabilities.execution === 'docker' && snapshot.capabilities.containers === 'enabled';
  const memory = snapshot.capabilities.memory === 'sqlite-three-layer';
  $('capabilityNotice').textContent = `Phase 3 · ${memory ? '三层记忆按需读取' : '记忆未启用'} · ${docker ? 'Worker 在本机容器执行，网络关闭' : '容器未启用，Worker 仅运行无副作用探针'}。追加任务不会打断当前执行。`;
  $('memoryCapability').textContent = memory ? '已启用' : '未启用';
  $('memoryCapability').classList.toggle('scope-current', memory);
  $('executionCapability').textContent = docker ? '已启用' : '未启用 · 探针';
  $('executionCapability').classList.toggle('scope-current', docker);
  $('networkCapability').textContent = docker ? 'network none' : '未启用';
  $('newRunExecutionNote').textContent = docker ? 'Worker 可在本机容器中执行代码与文件操作；容器网络关闭，工具安装尚未启用。' : '本次服务未启用容器，Worker 仅执行无副作用探针。';
  $('memoriesTab').disabled = !memory;
  for (const example of document.querySelectorAll('.example')) {
    example.dataset.prompt = example.dataset.mode === 'direct'
      ? docker ? '请由直属 Worker 在容器中生成一份结果文件，保存可复用的方法论，并汇总交付结果。' : '请验证一个直属 Worker 的创建和能力探针，并汇总验证结果。'
      : docker ? '请通过 Manager 分配 Worker 在容器中完成文件任务，保存任务记忆并汇总结果。' : '请创建一个 Manager，并由 Manager 创建一个 Worker，进行无副作用的能力验证，再汇总结果。';
  }
}
function memberName(id) {
  return snapshot.runs.flatMap(run => run.agents).find(agent => agent.id === id)?.name || id;
}
function memoryMetadata(entry) {
  return `${layerNames[entry.layer] || entry.layer} · ${entry.visibility === 'public' ? 'public · 公开' : 'private · 私有'} · v${entry.version} · ${memberName(entry.ownerAgentId)}`;
}
function replaceOptions(id, label, items) {
  const select = $(id), selected = select.value;
  const empty = node('option', '', label); empty.value = '';
  select.replaceChildren(empty, ...items.map(([value, text]) => { const option = node('option', '', text); option.value = value; return option; }));
  select.value = items.some(([value]) => value === selected) ? selected : '';
}
function syncReadViews() {
  const run = currentRun();
  if (readRunId !== selectedRunId) {
    readRunId = selectedRunId;
    memoryRequest++; memoryController?.abort(); memoryLoaded = false; memoryOffset = 0; memoryNextOffset = undefined;
    clearMemoryBody();
    $('memoryLayer').value = ''; $('memoryQuery').value = ''; $('memoryOwner').value = ''; $('memoryTask').value = '';
    $('memoryList').replaceChildren(); $('memoryCount').textContent = '尚未加载'; $('memoryPage').textContent = '';
    $('memoryPrevious').disabled = true; $('memoryNext').disabled = true;
    setError('memoryError', '');
    if ($('filesDialog').open) $('filesDialog').close();
    clearFiles();
  }
  $('memoryBoard').hidden = !run || selectedView !== 'memories';
  if (!run) return;
  replaceOptions('memoryOwner', '全部可见成员', run.agents.map(agent => [agent.id, `${agent.name} · ${roleNames[agent.role]}`]));
  replaceOptions('memoryTask', '全部任务', run.tasks.map(task => [task.id, `${task.title} · ${task.id.slice(0, 8)}`]));
  if (selectedView === 'memories' && !memoryLoaded) loadMemoryDirectory(0);
}
function clearMemoryBody() {
  memoryBodyRequest++; memoryBodyController?.abort(); memorySelected = undefined;
  memoryBodyOffset = 0; memoryBodyNext = undefined; memoryBodyPrevious = [];
  $('memoryTitle').textContent = '选择一条记忆'; $('memoryMetadata').textContent = '正文不会自动载入。';
  $('memoryContent').textContent = ''; $('memoryContent').hidden = true; $('memoryClose').hidden = true;
  $('memoryBodyPagination').hidden = true; setError('memoryBodyError', '');
  $('memoryList').querySelectorAll('button').forEach(button => { button.classList.remove('selected'); button.setAttribute('aria-pressed', 'false'); });
}
async function loadMemoryDirectory(offset = 0) {
  const run = currentRun(); if (!run || selectedView !== 'memories') return;
  const request = ++memoryRequest; memoryController?.abort(); memoryController = new AbortController();
  clearMemoryBody(); memoryLoaded = true;
  const params = new URLSearchParams({offset: String(offset), limit: '20'});
  for (const [field, id] of [['layer', 'memoryLayer'], ['ownerAgentId', 'memoryOwner'], ['taskId', 'memoryTask'], ['query', 'memoryQuery']]) {
    if ($(id).value.trim()) params.set(field, $(id).value.trim());
  }
  $('memoryList').replaceChildren(node('p', 'reader-empty', '正在读取目录摘要…'));
  $('memoryCount').textContent = '读取目录中'; $('memoryPage').textContent = '';
  $('memorySearchButton').disabled = true; $('memoryPrevious').disabled = true; $('memoryNext').disabled = true;
  setError('memoryError', '');
  const current = () => request === memoryRequest && selectedRunId === run.id && selectedView === 'memories';
  try {
    const data = await api(`/api/runs/${encodeURIComponent(run.id)}/memories?${params}`, {signal: memoryController.signal});
    if (!current()) return;
    memoryOffset = offset; memoryNextOffset = data.nextOffset;
    $('memoryCount').textContent = `${data.total} 条可见记忆`;
    $('memoryPage').textContent = data.total ? `${offset + 1}–${offset + data.items.length} / ${data.total}` : '没有匹配条目';
    $('memoryPrevious').disabled = offset === 0; $('memoryNext').disabled = !Number.isInteger(data.nextOffset);
    const entries = data.items.map(entry => {
      const button = node('button', 'memory-entry'); button.type = 'button'; button.dataset.memoryId = entry.id;
      button.setAttribute('aria-pressed', 'false');
      const heading = node('span', 'memory-entry-heading'); heading.append(node('strong', '', entry.title), node('span', `memory-visibility ${entry.visibility}`, entry.visibility));
      button.append(heading, node('span', 'memory-entry-meta', memoryMetadata(entry)), node('span', 'memory-summary', entry.summary));
      if (entry.tags?.length) button.append(node('span', 'memory-tags', entry.tags.map(tag => `#${tag}`).join(' ')));
      button.append(node('span', 'memory-entry-meta', `${entry.kind} · ${dateLabel(entry.updatedAt, true)}`));
      button.addEventListener('click', () => {
        clearMemoryBody(); memorySelected = entry;
        button.classList.add('selected'); button.setAttribute('aria-pressed', 'true');
        loadMemoryBody(0, []);
      });
      return button;
    });
    $('memoryList').replaceChildren(...(entries.length ? entries : [node('p', 'reader-empty', '当前范围内没有记忆。Agent 写入后，可点击“查询 / 刷新”读取目录。')]));
  } catch (error) {
    if (!current() || error.name === 'AbortError') return;
    setError('memoryError', `目录读取失败：${error.message}`); $('memoryCount').textContent = '读取失败'; $('memoryList').replaceChildren();
  } finally { if (current()) $('memorySearchButton').disabled = false; }
}
async function loadMemoryBody(offset, previous) {
  const entry = memorySelected, runId = selectedRunId; if (!entry || selectedView !== 'memories') return;
  const request = ++memoryBodyRequest; memoryBodyController?.abort(); memoryBodyController = new AbortController();
  $('memoryTitle').textContent = entry.title; $('memoryMetadata').textContent = `${memoryMetadata(entry)} · 正在读取正文…`;
  $('memoryContent').textContent = ''; $('memoryContent').hidden = true; $('memoryClose').hidden = false;
  $('memoryBodyPagination').hidden = true; setError('memoryBodyError', '');
  const current = () => request === memoryBodyRequest && selectedRunId === runId && selectedView === 'memories' && memorySelected?.id === entry.id;
  try {
    const data = await api(`/api/runs/${encodeURIComponent(runId)}/memories/${encodeURIComponent(entry.id)}?offset=${offset}&limit=2000`, {signal: memoryBodyController.signal});
    if (!current()) return;
    memorySelected = data.entry; memoryBodyOffset = data.offset; memoryBodyNext = data.nextOffset; memoryBodyPrevious = previous;
    $('memoryTitle').textContent = data.entry.title;
    $('memoryMetadata').textContent = `${memoryMetadata(data.entry)} · 所有者 ${data.entry.ownerAgentId} · ${data.entry.kind}`;
    $('memoryContent').textContent = data.content || '（此段为空）'; $('memoryContent').hidden = false;
    $('memoryBodyPagination').hidden = false;
    $('memoryBodyPage').textContent = `${data.offset}–${data.offset + data.content.length} / ${data.totalCharacters} 字符`;
    $('memoryBodyPrevious').disabled = !previous.length; $('memoryBodyNext').disabled = !Number.isInteger(data.nextOffset);
  } catch (error) {
    if (!current() || error.name === 'AbortError') return;
    setError('memoryBodyError', `正文读取失败：${error.message}。可重新点击目录条目。`);
  }
}
function clearFiles() {
  fileRequest++; fileController?.abort(); fileContext = undefined; fileOffset = 0; fileNextOffset = undefined; filePrevious = [];
  $('filesList').replaceChildren(); $('fileContent').textContent = ''; $('fileContent').hidden = true;
  $('filesPath').textContent = '.'; $('filesContext').textContent = ''; $('fileTitle').textContent = '选择一个文件';
  $('fileMetadata').textContent = '只在点击文件后读取内容。'; $('filesListNote').textContent = ''; $('filePagination').hidden = true;
  setError('filesError', '');
}
function openFiles(run, task, attempt) {
  clearFiles();
  fileContext = {runId: run.id, attemptId: attempt.id, directory: '.', path: undefined};
  $('filesContext').textContent = `${task.title} · Attempt ${attempt.number} · ${attempt.id}`;
  $('filesDialog').showModal(); loadFilesDirectory('.');
}
function filesUrl(read, params) {
  return `/api/runs/${encodeURIComponent(fileContext.runId)}/attempts/${encodeURIComponent(fileContext.attemptId)}/files${read ? '/read' : ''}?${new URLSearchParams(params)}`;
}
async function loadFilesDirectory(path) {
  if (!fileContext) return;
  const context = fileContext, request = ++fileRequest; fileController?.abort(); fileController = new AbortController();
  context.directory = path; context.path = undefined; filePrevious = [];
  $('filesPath').textContent = path; $('filesList').replaceChildren(node('p', 'reader-empty', '正在读取目录…'));
  $('filesParent').disabled = true; $('filesRefresh').disabled = true; $('filesListNote').textContent = '';
  $('fileTitle').textContent = '选择一个文件'; $('fileMetadata').textContent = '只在点击文件后读取内容。';
  $('fileContent').textContent = ''; $('fileContent').hidden = true; $('filePagination').hidden = true; setError('filesError', '');
  const current = () => request === fileRequest && fileContext === context && selectedRunId === context.runId && $('filesDialog').open;
  try {
    const data = await api(filesUrl(false, {path}), {signal: fileController.signal});
    if (!current()) return;
    const entries = data.entries.map(entry => {
      const button = node('button', 'file-entry'); button.type = 'button';
      const kind = {file: '文件', directory: '目录', symlink: '符号链接 · 不可读取', other: '特殊文件 · 不可读取'}[entry.kind] || entry.kind;
      button.append(node('span', '', `${entry.kind === 'directory' ? '▸' : '·'} ${entry.name}`), node('small', '', kind));
      button.disabled = !['file', 'directory'].includes(entry.kind);
      button.addEventListener('click', () => {
        const child = path === '.' ? entry.name : `${path}/${entry.name}`;
        if (entry.kind === 'directory') loadFilesDirectory(child);
        else { context.path = child; filePrevious = []; loadFileBody(0, []); }
      });
      return button;
    });
    $('filesList').replaceChildren(...(entries.length ? entries : [node('p', 'reader-empty', '此目录暂无文件。')]));
    $('filesListNote').textContent = data.truncated ? '目录条目已达上限，仅显示前 100 项。' : `${data.entries.length} 个条目 · 仅此 Attempt 可见的工作目录`;
  } catch (error) {
    if (!current() || error.name === 'AbortError') return;
    setError('filesError', `目录读取失败：${error.message}。执行中的操作可能占用工作目录，请稍后刷新。`); $('filesList').replaceChildren();
  } finally { if (current()) { $('filesParent').disabled = path === '.'; $('filesRefresh').disabled = false; } }
}
async function loadFileBody(offset, previous) {
  if (!fileContext?.path) return;
  const context = fileContext, path = context.path, request = ++fileRequest; fileController?.abort(); fileController = new AbortController();
  $('fileTitle').textContent = path; $('fileMetadata').textContent = '读取中…';
  $('fileContent').textContent = ''; $('fileContent').hidden = true; $('filePagination').hidden = true; setError('filesError', '');
  const current = () => request === fileRequest && fileContext === context && context.path === path && selectedRunId === context.runId && $('filesDialog').open;
  try {
    const data = await api(filesUrl(true, {path, offset: String(offset), limit: '1024'}), {signal: fileController.signal});
    if (!current()) return;
    fileOffset = data.offset; fileNextOffset = data.nextOffset; filePrevious = previous;
    $('fileMetadata').textContent = `${data.encoding} 文本 · 共 ${data.totalBytes} 字节 · 按页读取`;
    $('fileContent').textContent = data.content || '（空文件或此段为空）'; $('fileContent').hidden = false; $('filePagination').hidden = false;
    $('filePage').textContent = `${data.offset}–${data.nextOffset ?? data.totalBytes} / ${data.totalBytes} 字节`;
    $('filePrevious').disabled = !previous.length; $('fileNext').disabled = !Number.isInteger(data.nextOffset);
  } catch (error) {
    if (!current() || error.name === 'AbortError') return;
    setError('filesError', `文件读取失败：${error.message}。可重新点击文件重试。`);
  }
}

function renderTemplateList() {
  $('templateList').replaceChildren(...snapshot.templates.map((template) => {
    const button = node('button', `template-item${selectedTemplateId === template.id ? ' selected' : ''}`);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(selectedTemplateId === template.id));
    button.append(node('strong', '', roleNames[template.role]), node('span', '', template.name));
    button.addEventListener('click', () => selectTemplate(template.id));
    return button;
  }));
}
function modelValue(selection) { return JSON.stringify([selection.provider, selection.model]); }
function selectedModel() { return snapshot.models.find((model) => modelValue(model) === $('templateModel').value); }
function populateEfforts(preferred) {
  const model = selectedModel();
  const efforts = model?.efforts || [];
  $('effortField').hidden = !efforts.length;
  $('templateEffort').disabled = !efforts.length;
  const defaultOption = node('option', '', '模型默认');
  defaultOption.value = '';
  $('templateEffort').replaceChildren(defaultOption, ...efforts.map((effort) => {
    const option = node('option', '', effort.name);
    option.value = effort.id;
    return option;
  }));
  $('templateEffort').value = efforts.some((effort) => effort.id === preferred) ? preferred : '';
  $('modelNote').textContent = !model ? '当前模板的模型未在 DSH 中配置，请选择可用模型后保存。' : model.demo ? '演示模型用于验证协作流程，不发起真实模型请求。' : efforts.length ? '推理等级来自该模型在 DSH 中声明的能力。' : '该模型未提供可选推理等级，使用模型默认行为。';
}
function selectTemplate(id) {
  const template = snapshot.templates.find((item) => item.id === id);
  if (!template) return;
  selectedTemplateId = template.id;
  draftVersion = template.version;
  renderTemplateList();
  $('templateRole').textContent = roleNames[template.role];
  $('templateVersion').textContent = `版本 ${template.version}`;
  $('templateName').value = template.name;
  $('templatePrompt').value = template.systemPrompt;
  const modelOptions = snapshot.models.map((model) => {
    const option = node('option', '', `${model.demo ? '[DEMO] ' : ''}${model.name} · ${model.provider}`);
    option.value = modelValue(model);
    return option;
  });
  if (!snapshot.models.some((model) => modelValue(model) === modelValue(template.selection))) {
    const missing = node('option', '', `不可用：${template.selection.provider} / ${template.selection.model}`);
    missing.value = modelValue(template.selection);
    missing.disabled = true;
    modelOptions.unshift(missing);
  }
  $('templateModel').replaceChildren(...modelOptions);
  $('templateModel').value = modelValue(template.selection);
  populateEfforts(template.selection.reasoningEffort);
  setError('templateError', '');
  $('templateSaveState').textContent = '';
}
function openSettings() {
  if (!snapshot) return;
  selectTemplate(selectedTemplateId || snapshot.templates[0]?.id);
  $('settingsDialog').showModal();
}

$('newRunButton').disabled = true;
$('settingsButton').disabled = true;
$('newRunButton').addEventListener('click', () => openNewRun());
$('settingsButton').addEventListener('click', openSettings);
$('tasksTab').addEventListener('click', () => selectView('tasks'));
$('chatTab').addEventListener('click', () => selectView('chat'));
$('memoriesTab').addEventListener('click', () => selectView('memories'));
$('memoryFilterForm').addEventListener('submit', event => { event.preventDefault(); loadMemoryDirectory(0); });
$('memoryPrevious').addEventListener('click', () => loadMemoryDirectory(Math.max(0, memoryOffset - 20)));
$('memoryNext').addEventListener('click', () => { if (Number.isInteger(memoryNextOffset)) loadMemoryDirectory(memoryNextOffset); });
$('memoryClose').addEventListener('click', clearMemoryBody);
$('memoryBodyPrevious').addEventListener('click', () => { const previous = memoryBodyPrevious.slice(); const offset = previous.pop(); if (offset !== undefined) loadMemoryBody(offset, previous); });
$('memoryBodyNext').addEventListener('click', () => { if (Number.isInteger(memoryBodyNext)) loadMemoryBody(memoryBodyNext, [...memoryBodyPrevious, memoryBodyOffset]); });
$('filesDialog').addEventListener('close', clearFiles);
$('filesParent').addEventListener('click', () => { const parts = fileContext?.directory.split('/') || []; parts.pop(); loadFilesDirectory(parts.join('/') || '.'); });
$('filesRefresh').addEventListener('click', () => { if (fileContext) loadFilesDirectory(fileContext.directory); });
$('filePrevious').addEventListener('click', () => { const previous = filePrevious.slice(); const offset = previous.pop(); if (offset !== undefined) loadFileBody(offset, previous); });
$('fileNext').addEventListener('click', () => { if (Number.isInteger(fileNextOffset)) loadFileBody(fileNextOffset, [...filePrevious, fileOffset]); });
$('appendTaskButton').addEventListener('click', openAppendTask);
$('appendTaskForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (appending || !appendRunId) return;
  const runId = appendRunId;
  const prompt = $('appendTaskPrompt').value.trim();
  const targetManagerId = $('appendTaskManager').value;
  if (!prompt) return;
  const signature = JSON.stringify([prompt, targetManagerId]);
  const old = appendDraft(runId);
  const draft = {prompt, targetManagerId, signature, requestId: old?.signature === signature ? old.requestId : crypto.randomUUID()};
  saveAppendDraft(runId, draft);
  appending = true;
  $('submitAppendTaskButton').disabled = true;
  $('submitAppendTaskButton').textContent = '正在保存任务…';
  setError('appendTaskError', '');
  try {
    await api(`/api/runs/${encodeURIComponent(runId)}/tasks`, {method: 'POST', body: JSON.stringify({prompt, requestId: draft.requestId, ...(targetManagerId ? {targetManagerId} : {})})});
    saveAppendDraft(runId, undefined);
    $('appendTaskDialog').close();
    selectedRunId = runId;
    selectedView = 'tasks';
    taskFingerprint = '';
    try { applySnapshot(await api('/api/state')); }
    catch { setError('globalError', '任务已保存，但状态刷新暂未成功，正在等待自动更新。'); }
    selectView('tasks');
    toast('新任务已保存；当前执行不受影响');
  } catch (error) { setError('appendTaskError', `尚未确认提交成功：${error.message}。再次提交相同内容会沿用提交 ID，避免重复任务。`); }
  finally { appending = false; $('submitAppendTaskButton').disabled = false; $('submitAppendTaskButton').textContent = '提交独立任务'; }
});
document.querySelectorAll('.example').forEach((button) => button.addEventListener('click', () => openNewRun(button.dataset.prompt, button.dataset.mode)));
document.querySelectorAll('.close-dialog').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
$('templateModel').addEventListener('change', () => { populateEfforts(); $('templateSaveState').textContent = ''; });
$('templateForm').addEventListener('input', () => { $('templateSaveState').textContent = '有未保存的修改'; });
$('messageText').addEventListener('input', () => {
  $('sendButton').disabled = !currentRun() || sending || !$('messageText').value.trim();
  $('messageText').style.height = 'auto';
  $('messageText').style.height = `${Math.min($('messageText').scrollHeight, 180)}px`;
});
$('messageText').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!$('sendButton').disabled) $('messageForm').requestSubmit();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() !== 'n' || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
  if (event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName))) return;
  if (document.querySelector('dialog[open]')) return;
  event.preventDefault(); openNewRun();
});
$('newRunForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (creating) return;
  const prompt = $('taskPrompt').value.trim();
  if (!prompt) return;
  creating = true;
  $('createRunButton').disabled = true;
  $('createRunButton').textContent = '正在创建…';
  setError('newRunError', '');
  try {
    const run = await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt, mode: document.querySelector('input[name="mode"]:checked').value, orchestratorTemplateId: $('orchestratorTemplate').value, ...($('reuseMemorySource').value ? {reuseMemoryFromRunId: $('reuseMemorySource').value} : {}) }) });
    selectedRunId = run.id;
    selectedAgentId = null;
    messageFingerprint = '';
    $('messageText').value = '';
    $('newRunDialog').close();
    selectedView = 'tasks';
    taskFingerprint = '';
    selectView('tasks');
    applySnapshot(await api('/api/state'));
    $('messageText').focus();
  } catch (error) { setError('newRunError', error.message); }
  finally { creating = false; $('createRunButton').disabled = false; $('createRunButton').textContent = '创建并开始 ↗'; }
});
$('messageForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const run = currentRun();
  const text = $('messageText').value.trim();
  if (!run || !text || sending) return;
  sending = true;
  renderConversation();
  try {
    await api(`/api/runs/${encodeURIComponent(run.id)}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
    if (selectedRunId === run.id) { $('messageText').value = ''; $('messageText').style.height = 'auto'; }
    setError('globalError', '');
    applySnapshot(await api('/api/state'));
  } catch (error) { setError('globalError', `消息未发送：${error.message}`); }
  finally { sending = false; renderConversation(); $('messageText').focus(); }
});
$('stopButton').addEventListener('click', async () => {
  const run = currentRun();
  if (!run) return;
  $('stopButton').disabled = true;
  try {
    await api(`/api/runs/${encodeURIComponent(run.id)}/stop`, { method: 'POST', body: '{}' });
    toast('已请求停止此协作中的全部任务');
    applySnapshot(await api('/api/state'));
  } catch (error) { setError('globalError', `停止失败：${error.message}`); }
  finally { $('stopButton').disabled = false; }
});
$('templateForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (saving) return;
  const template = snapshot.templates.find((item) => item.id === selectedTemplateId);
  const model = selectedModel();
  if (!template || !model) { setError('templateError', '请选择当前可用的模型。'); return; }
  const selection = { provider: model.provider, model: model.model };
  if (model.efforts.length && $('templateEffort').value) selection.reasoningEffort = $('templateEffort').value;
  const input = { id: template.id, name: $('templateName').value.trim(), role: template.role, systemPrompt: $('templatePrompt').value.trim(), selection, version: draftVersion };
  if (!input.name || !input.systemPrompt) { setError('templateError', '模板名称和 System Prompt 不能为空。'); return; }
  saving = true;
  $('saveTemplateButton').disabled = true;
  $('saveTemplateButton').textContent = '保存中…';
  setError('templateError', '');
  try {
    const saved = await api(`/api/templates/${encodeURIComponent(template.id)}`, { method: 'PUT', body: JSON.stringify(input) });
    applySnapshot(await api('/api/state'));
    selectTemplate(saved.id || template.id);
    $('templateSaveState').textContent = `已保存版本 ${saved.version ?? draftVersion}，新建 Agent 时生效`;
    toast('模板配置已保存');
  } catch (error) { setError('templateError', error.message); }
  finally { saving = false; $('saveTemplateButton').disabled = false; $('saveTemplateButton').textContent = '保存模板'; }
});

async function start() {
  try {
    const bootstrap = await api('/api/bootstrap');
    csrfToken = bootstrap.csrfToken;
    applySnapshot(await api('/api/state'));
    setError('globalError', '');
    eventSource = new EventSource('/api/events');
    eventSource.onopen = () => connection(true, '已连接');
    eventSource.addEventListener('state', (event) => {
      try { applySnapshot(JSON.parse(event.data)); connection(true, '已连接'); }
      catch { setError('globalError', '收到无法解析的状态更新，请刷新页面重试。'); }
    });
    eventSource.addEventListener('error', (event) => {
      if (event instanceof MessageEvent && event.data) {
        let message = event.data;
        try { const parsed = JSON.parse(event.data); message = parsed.error?.message || parsed.error || parsed.message || event.data; } catch { /* Server errors can also be plain text. */ }
        setError('globalError', String(message));
      } else connection(false, '正在重连');
    });
  } catch (error) {
    connection(false, '连接失败');
    setError('globalError', `无法连接本地工作台：${error.message}。请确认服务正在运行后刷新页面。`);
  }
}
window.addEventListener('pagehide', () => { eventSource?.close(); memoryController?.abort(); memoryBodyController?.abort(); fileController?.abort(); });
start();
