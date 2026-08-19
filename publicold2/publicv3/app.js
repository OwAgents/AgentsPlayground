const grid = document.querySelector('#agentGrid');
const connectionChip = document.querySelector('#connectionChip');
const connectionState = document.querySelector('#connectionState');
const agentCount = document.querySelector('#agentCount');
const workerName = document.querySelector('[data-worker-name]');
const buildVersionEl = document.querySelector('#buildVersion');
const logSelect = document.querySelector('#logSelect');
const logTitle = document.querySelector('#logTitle');
const logOutput = document.querySelector('#logOutput');

let state = { agents: [] };
let selectedLogId = '';

const agentIcons = {
  codex: '/icons/codex.png',
  opencode: '/icons/opencode.png',
  hermes: '/icons/hermes.png',
  openwork: '/icons/openwork.png',
  'agent-zero': '/icons/agent-zero.png',
  openclaw: '/icons/openclaw.png'
};

function agentStateClass(agent) {
  return ['running', 'starting', 'installing', 'stopping', 'error'].includes(agent.state) ? agent.state : '';
}

function publicAgentUrl(agent) {
  if (!agent?.port) return agent?.url || '#';
  try {
    const source = new URL(agent.url || '/', window.location.href);
    const target = new URL(window.location.href);
    target.port = String(agent.port);
    target.pathname = source.pathname || '/';
    target.search = source.search || '';
    target.hash = source.hash || '';
    return target.toString();
  } catch {
    return agent.url || '#';
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}

function renderAgent(agent) {
  const busy = ['installing', 'starting', 'stopping'].includes(agent.state);
  const canOpen = agent.state === 'running';
  const canStop = agent.state === 'running' || agent.state === 'error' || agent.state === 'starting' || agent.state === 'installing';
  const icon = agentIcons[agent.id];
  const openHref = canOpen ? escapeAttribute(publicAgentUrl(agent)) : '#';
  const openDisabled = canOpen ? '' : ' aria-disabled="true" tabindex="-1"';
  const article = document.createElement('article');
  article.className = 'agent';
  article.dataset.agentId = agent.id;
  article.innerHTML = `
    <div class="agent-main">
      <div class="agent-id">
        <span class="agent-icon">${icon ? `<img src="${escapeAttribute(icon)}" alt="">` : `<b>${escapeHtml((agent.name || '?').slice(0, 1))}</b>`}</span>
        <div class="agent-titles">
          <h3>${escapeHtml(agent.name)}</h3>
          <span class="state ${agentStateClass(agent)}">${escapeHtml(agent.state)}</span>
        </div>
      </div>
      <a class="btn open" href="${openHref}" target="_blank" rel="noreferrer"${openDisabled}>Open <span>↗</span></a>
    </div>
    <div class="agent-actions">
      <button class="btn small" data-action="start" data-id="${agent.id}" ${busy || agent.state === 'running' ? 'disabled' : ''}>Start</button>
      <button class="btn small" data-action="restart" data-id="${agent.id}" ${busy ? 'disabled' : ''}>Restart</button>
      <button class="btn small stop" data-action="stop" data-id="${agent.id}" ${busy || !canStop ? 'disabled' : ''}>Stop</button>
      <button class="btn small" data-action="logs" data-id="${agent.id}">Logs</button>
    </div>
    ${agent.error ? `<p class="agent-error">${escapeHtml(agent.error)}</p>` : ''}
  `;
  return article;
}

function renderAgents(agents) {
  grid.replaceChildren(...agents.map(renderAgent));
  const running = agents.filter((agent) => agent.state === 'running').length;
  agentCount.textContent = `${running}/${agents.length} running`;
  const previous = selectedLogId;
  logSelect.replaceChildren(...agents.map((agent) => {
    const option = document.createElement('option');
    option.value = agent.id;
    option.textContent = agent.name;
    return option;
  }));
  selectedLogId = agents.some((agent) => agent.id === previous) ? previous : agents[0]?.id || '';
  logSelect.value = selectedLogId;
  renderLogs();
}

function renderLogs() {
  const agent = state.agents.find((item) => item.id === selectedLogId);
  if (!agent) {
    logTitle.textContent = 'No agent selected';
    logOutput.textContent = '';
    return;
  }
  logTitle.textContent = agent.name;
  logOutput.textContent = (agent.logs || []).join('\n');
  logOutput.scrollTop = logOutput.scrollHeight;
}

function render(payload) {
  state = payload;
  if (workerName && payload.worker?.name) {
    workerName.textContent = payload.worker.name;
  }
  if (buildVersionEl && payload.version) {
    buildVersionEl.textContent = `Build ${payload.version.versionCode} (${payload.version.versionName})`;
  }
  renderAgents(payload.agents || []);
}

async function refresh() {
  const response = await fetch('/api/status');
  if (!response.ok) throw new Error(`Status failed: ${response.status}`);
  render(await response.json());
}

async function postAction(id, action) {
  connectionState.textContent = `${action} requested`;
  const response = await fetch(`/api/agents/${id}/${action}`, { method: 'POST' });
  const body = await response.json();
  if (!response.ok || !body.ok) {
    connectionState.textContent = body.error || `${action} failed`;
  }
  await refresh();
}

function connectEvents() {
  const events = new EventSource('/api/events');
  events.addEventListener('open', () => {
    connectionChip.classList.add('live');
    connectionState.textContent = 'Live';
  });
  events.addEventListener('status', (event) => {
    connectionChip.classList.add('live');
    connectionState.textContent = 'Live';
    render(JSON.parse(event.data));
  });
  events.addEventListener('error', () => {
    connectionChip.classList.remove('live');
    connectionState.textContent = 'Reconnecting';
  });
}

grid.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const { action, id } = target.dataset;
  if (action === 'logs') {
    selectedLogId = id;
    logSelect.value = id;
    renderLogs();
    document.querySelector('#logs').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  target.disabled = true;
  const agent = state.agents.find((item) => item.id === id);
  if (agent) {
    if (action === 'start') agent.state = 'installing';
    else if (action === 'restart' || action === 'stop') agent.state = 'stopping';
    renderAgents(state.agents);
  }
  await postAction(id, action);
  selectedLogId = id;
  logSelect.value = id;
  renderLogs();
});

logSelect.addEventListener('change', () => {
  selectedLogId = logSelect.value;
  renderLogs();
});

refresh().then(connectEvents).catch((error) => {
  connectionState.textContent = error.message;
});
