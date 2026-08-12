const grid = document.querySelector('#agentGrid');
const buildVersionEl = document.querySelector('#buildVersion');
const authTitle = document.querySelector('#authTitle');
const authDetail = document.querySelector('#authDetail');
const providersLink = document.querySelector('#providersLink');
const connectionState = document.querySelector('#connectionState');
const logSelect = document.querySelector('#logSelect');
const logTitle = document.querySelector('#logTitle');
const logOutput = document.querySelector('#logOutput');
const logPanel = document.querySelector('.log-panel');

let state = { auth: { loggedIn: false }, agents: [] };
let selectedLogId = '';

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

function displayAgentUrl(agent) {
  return agent.state === 'running' ? publicAgentUrl(agent) : '-';
}

function actionUrl(agent, canOpen) {
  return canOpen ? publicAgentUrl(agent) : '#';
}

function actionLinkAttrs(agent, canOpen, extra = '') {
  const href = escapeAttribute(actionUrl(agent, canOpen));
  const disabled = canOpen ? '' : ' aria-disabled="true" tabindex="-1"';
  return `href="${href}"${extra}${disabled}`;
}

function updateAuth(auth, router) {
  const codexNote = auth.loggedIn ? ' Legacy Codex credentials are present.' : '';
  const livePort = router?.livePort || router?.configuredPort || 20128;
  const state = router?.state || 'unknown';
  const host = window.location.hostname || 'localhost';
  authTitle.textContent = `9Router ${state}`;
  if (providersLink) {
    const target = new URL(window.location.href);
    target.port = String(livePort);
    target.pathname = '/dashboard/providers';
    target.search = '';
    target.hash = '';
    providersLink.href = target.toString();
  }
  if (router?.error) {
    authDetail.textContent = `${router.error} Default model: opencode/big-pickle.${codexNote}`;
    return;
  }
  authDetail.textContent = `Manage providers at ${host}:${livePort}. Default model: opencode/big-pickle.${codexNote}`;
}

function renderAgent(agent) {
  const busy = ['installing', 'starting', 'stopping'].includes(agent.state);
  const canOpen = agent.state === 'running';
  const canStop = agent.state === 'running' || agent.state === 'error' || agent.state === 'starting' || agent.state === 'installing';
  const article = document.createElement('article');
  article.className = 'agent-card';
  article.innerHTML = `
    <div class="agent-head">
      <div>
        <h2 class="agent-name">${escapeHtml(agent.name)}</h2>
        <div class="agent-meta">
          <span>Port</span><code>${agent.port}</code>
          <span>PID</span><code>${agent.pid || '-'}</code>
          <span>URL</span><code>${escapeHtml(displayAgentUrl(agent))}</code>
        </div>
      </div>
      <span class="state ${agentStateClass(agent)}">${escapeHtml(agent.state)}</span>
    </div>
    <div class="agent-actions">
      <button class="button primary" data-action="start" data-id="${agent.id}" ${busy || agent.state === 'running' ? 'disabled' : ''}>Start</button>
      <button class="button ghost" data-action="restart" data-id="${agent.id}" ${busy ? 'disabled' : ''}>Restart</button>
      <button class="button stop" data-action="stop" data-id="${agent.id}" ${busy || !canStop ? 'disabled' : ''}>Stop</button>
      <a class="button ghost" ${actionLinkAttrs(agent, canOpen)}>Open</a>
      <a class="button ghost" ${actionLinkAttrs(agent, canOpen, ' target="_blank" rel="noreferrer"')}>Web</a>
      <button class="button ghost" data-action="logs" data-id="${agent.id}">Logs</button>
    </div>
    ${agent.error ? `<p class="muted">${escapeHtml(agent.error)}</p>` : ''}
  `;
  return article;
}

function renderAgents(agents) {
  grid.replaceChildren(...agents.map(renderAgent));
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

function scrollLogsIntoView() {
  logPanel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function render(payload) {
  state = payload;
  if (buildVersionEl && state.version) {
    buildVersionEl.textContent = `Build ${state.version.versionCode} (${state.version.versionName})`;
  }
  updateAuth(state.auth, state.router);
  renderAgents(state.agents);
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
    connectionState.textContent = 'Live';
  });
  events.addEventListener('status', (event) => {
    connectionState.textContent = 'Live';
    render(JSON.parse(event.data));
  });
  events.addEventListener('error', () => {
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
    scrollLogsIntoView();
    return;
  }
  target.disabled = true;
  // Optimistic UI: show state change immediately instead of waiting for SSE
  const agent = state.agents.find(a => a.id === id);
  if (agent) {
    if (action === 'start') agent.state = 'installing';
    else if (action === 'restart' || action === 'stop') agent.state = 'stopping';
    renderAgents(state.agents);
  }
  await postAction(id, action);
  // Auto-select logs for the agent that was started/stopped/restarted
  selectedLogId = id;
  logSelect.value = id;
  renderLogs();
  scrollLogsIntoView();
});

logSelect.addEventListener('change', () => {
  selectedLogId = logSelect.value;
  renderLogs();
});

const updateSkillsBtn = document.querySelector('#updateSkillsBtn');
if (updateSkillsBtn) {
  const skillsDetail = document.querySelector('#skillsDetail');
  updateSkillsBtn.addEventListener('click', async () => {
    updateSkillsBtn.disabled = true;
    updateSkillsBtn.textContent = 'Updating...';
    skillsDetail.textContent = 'Pulling skills from GitHub...';
    try {
      const res = await fetch('/api/skills/update', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        updateSkillsBtn.textContent = '\u2713 Done';
        skillsDetail.textContent = data.summary || 'Skills updated from GitHub.';
      } else {
        updateSkillsBtn.textContent = '\u2717 Failed';
        skillsDetail.textContent = data.error || 'Update failed.';
      }
    } catch (e) {
      updateSkillsBtn.textContent = '\u2717 Error';
      skillsDetail.textContent = e.message;
    }
    setTimeout(() => {
      updateSkillsBtn.disabled = false;
      updateSkillsBtn.textContent = 'Update Skills';
    }, 4000);
  });
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

refresh().then(connectEvents).catch((error) => {
  connectionState.textContent = error.message;
});
