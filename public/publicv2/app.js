const connectionChip = document.querySelector('#connectionChip');
const connectionState = document.querySelector('#connectionState');
const buildVersionEl = document.querySelector('#buildVersion');
const workerNameEls = document.querySelectorAll('[data-worker-name]');
const liveGrid = document.querySelector('#liveGrid');
const liveEmpty = document.querySelector('#liveEmpty');
const launchGrid = document.querySelector('#launchGrid');
const metricEls = {
  running: document.querySelectorAll('[data-metric="running"]'),
  busy: document.querySelectorAll('[data-metric="busy"]'),
  errors: document.querySelectorAll('[data-metric="errors"]'),
  total: document.querySelectorAll('[data-metric="total"]')
};
const authTitle = document.querySelector('#authTitle');
const authDetail = document.querySelector('#authDetail');
const providersLink = document.querySelector('#providersLink');
const skillsDetail = document.querySelector('#skillsDetail');
const updateSkillsBtn = document.querySelector('#updateSkillsBtn');
const logSelect = document.querySelector('#logSelect');
const logTitle = document.querySelector('#logTitle');
const logOutput = document.querySelector('#logOutput');
const drawer = document.querySelector('#logDrawer');
const themeSelect = document.querySelector('#themeSelect');
const jumpLogs = document.querySelector('#jumpLogs');
const jumpLaunch = document.querySelector('#jumpLaunch');

let state = { auth: { loggedIn: false }, agents: [] };
let selectedLogId = '';

const agentIcons = {
  opencode: './icons/opencode.png',
  openclaw: './icons/openclaw.png',
  'codex-web-local': './icons/codex.png',
  'hermes-webui': './icons/hermes.png',
  openwork: './icons/openwork.png',
  'agent-zero': './icons/agent-zero.png',
  'web-vnc': './icons/web-vnc.svg',
  codex: './icons/codex.png',
  hermes: './icons/hermes.png',
  filebrowser: './icons/agent-default.svg'
};

const blurbs = {
  'codex-web-local': 'Chat and code with Codex in the browser.',
  opencode: 'Open-source coding agent UI.',
  'hermes-webui': 'Friendly multi-tool agent workspace.',
  openwork: 'Headless OpenWork web UI.',
  'agent-zero': 'Autonomous research-style agent.',
  openclaw: 'Gateway for tools and sessions.',
  filebrowser: 'Browse the worker filesystem.'
};

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

function agentStateClass(agent) {
  return ['running', 'starting', 'installing', 'stopping', 'error'].includes(agent.state) ? agent.state : '';
}

function isBusy(agent) {
  return ['installing', 'starting', 'stopping'].includes(agent.state);
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

function actionUrl(agent, canOpen) {
  return canOpen ? publicAgentUrl(agent) : '#';
}

function actionLinkAttrs(agent, canOpen, extra = '') {
  const href = escapeAttribute(actionUrl(agent, canOpen));
  const disabled = canOpen ? '' : ' aria-disabled="true" tabindex="-1"';
  return `href="${href}"${extra}${disabled}`;
}

function iconMarkup(agent) {
  const icon = agentIcons[agent.id];
  if (icon) {
    return `<img src="${escapeAttribute(icon)}" alt="${escapeAttribute(agent.name)} logo">`;
  }
  return `<span class="icon-fallback">${escapeHtml((agent.name || '?').slice(0, 1))}</span>`;
}

function sortAgents(agents) {
  const rank = (agent) => {
    if (agent.state === 'running') return 0;
    if (isBusy(agent)) return 1;
    if (agent.state === 'error') return 2;
    return 3;
  };
  return [...agents].sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)));
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
}

function loadTheme() {
  const storedTheme = localStorage.getItem('workerAgents.theme') || 'system';
  if (themeSelect) themeSelect.value = storedTheme;
  applyTheme(storedTheme);
}

function setConnection(label, mode = 'live') {
  if (connectionState) connectionState.textContent = label;
  if (!connectionChip) return;
  connectionChip.classList.toggle('live', mode === 'live');
  connectionChip.classList.toggle('bad', mode === 'bad');
}

function updateMetrics(agents) {
  const running = agents.filter((agent) => agent.state === 'running').length;
  const busy = agents.filter((agent) => isBusy(agent)).length;
  const errors = agents.filter((agent) => agent.state === 'error').length;
  metricEls.running.forEach((el) => { el.textContent = String(running); });
  metricEls.busy.forEach((el) => { el.textContent = String(busy); });
  metricEls.errors.forEach((el) => { el.textContent = String(errors); });
  metricEls.total.forEach((el) => { el.textContent = String(agents.length); });
  workerNameEls.forEach((el) => { el.textContent = window.location.hostname || 'localhost'; });
}

function updateAuth(auth, router) {
  const codexNote = auth.loggedIn ? ' Legacy Codex credentials are present.' : '';
  const livePort = router?.livePort || router?.configuredPort || 20128;
  const routerState = router?.state || 'unknown';
  const host = window.location.hostname || 'localhost';
  if (authTitle) authTitle.textContent = `Providers · 9Router ${routerState}`;
  if (providersLink) {
    const target = new URL(window.location.href);
    target.port = String(livePort);
    target.pathname = '/dashboard/providers';
    target.search = '';
    target.hash = '';
    providersLink.href = target.toString();
  }
  if (!authDetail) return;
  if (router?.error) {
    authDetail.textContent = `${router.error} Default model: opencode/big-pickle.${codexNote}`;
    return;
  }
  authDetail.textContent = `Manage model providers at ${host}:${livePort}. Default model: opencode/big-pickle.${codexNote}`;
}

function primaryActionMarkup(agent, sizeClass = '') {
  const busy = isBusy(agent);
  const canOpen = agent.state === 'running';
  if (canOpen) {
    return `<a class="btn open ${sizeClass}" ${actionLinkAttrs(agent, true, ' target="_blank" rel="noreferrer"')}>Open app</a>`;
  }
  if (busy) {
    return `<button class="btn primary ${sizeClass}" type="button" disabled>${escapeHtml(agent.state)}…</button>`;
  }
  if (agent.state === 'error') {
    return `<button class="btn primary ${sizeClass}" type="button" data-action="restart" data-id="${escapeAttribute(agent.id)}">Fix & launch</button>`;
  }
  return `<button class="btn primary ${sizeClass}" type="button" data-action="start" data-id="${escapeAttribute(agent.id)}">Launch</button>`;
}

function secondaryActions(agent) {
  const busy = isBusy(agent);
  const canOpen = agent.state === 'running';
  const canStop = agent.state === 'running' || agent.state === 'error' || agent.state === 'starting' || agent.state === 'installing';
  return `
    <button class="btn ghost" type="button" data-action="restart" data-id="${escapeAttribute(agent.id)}" ${busy ? 'disabled' : ''}>Restart</button>
    <button class="btn stop" type="button" data-action="stop" data-id="${escapeAttribute(agent.id)}" ${busy || !canStop ? 'disabled' : ''}>Stop</button>
    <button class="btn ghost" type="button" data-action="logs" data-id="${escapeAttribute(agent.id)}">Logs</button>
    <a class="btn ghost" ${actionLinkAttrs(agent, canOpen)}>Open here</a>
  `;
}

function liveCardMarkup(agent) {
  const tone = agent.state === 'running' ? 'running' : isBusy(agent) ? 'busy' : agent.state === 'error' ? 'error' : '';
  const blurb = blurbs[agent.id] || 'Worker agent console target.';
  return `
    <div class="live-top">
      <div class="icon-shell">${iconMarkup(agent)}</div>
      <div class="live-copy">
        <h4>${escapeHtml(agent.name)}</h4>
        <p>${escapeHtml(blurb)}</p>
      </div>
      <span class="state-pill ${agentStateClass(agent)}">${escapeHtml(agent.state)}</span>
    </div>
    <div class="btn-row">
      ${primaryActionMarkup(agent, 'xl')}
      ${secondaryActions(agent)}
    </div>
    ${agent.error ? `<p class="error-text">${escapeHtml(agent.error)}</p>` : ''}
  `;
}

function launchTileMarkup(agent) {
  const tone = agent.state === 'running' ? 'running' : isBusy(agent) ? 'busy' : agent.state === 'error' ? 'error' : '';
  const detail = agent.state === 'running'
    ? `Ready on port ${agent.port}`
    : isBusy(agent)
      ? `${agent.state}… hang tight`
      : agent.state === 'error'
        ? 'Needs a relaunch'
        : `Tap Launch · port ${agent.port}`;
  return `
    <div class="tile-top">
      <div class="icon-shell">${iconMarkup(agent)}</div>
      <span class="state-pill ${agentStateClass(agent)}">${escapeHtml(agent.state)}</span>
    </div>
    <div>
      <h4>${escapeHtml(agent.name)}</h4>
      <p class="meta">${escapeHtml(detail)}</p>
    </div>
    <div class="btn-row">
      ${primaryActionMarkup(agent)}
      <button class="btn ghost" type="button" data-action="logs" data-id="${escapeAttribute(agent.id)}">Logs</button>
    </div>
  `;
}

function renderLive(agents) {
  const active = agents.filter((agent) => agent.state === 'running' || isBusy(agent) || agent.state === 'error');
  liveEmpty.classList.toggle('hidden', active.length > 0);
  liveGrid.replaceChildren(...active.map((agent) => {
    const card = document.createElement('article');
    card.className = `live-card ${agent.state === 'running' ? 'running' : isBusy(agent) ? 'busy' : agent.state === 'error' ? 'error' : ''}`;
    card.dataset.agentId = agent.id;
    card.innerHTML = liveCardMarkup(agent);
    return card;
  }));
}

function renderLaunch(agents) {
  launchGrid.replaceChildren(...agents.map((agent) => {
    const tile = document.createElement('article');
    const tone = agent.state === 'running' ? 'running' : isBusy(agent) ? 'busy' : agent.state === 'error' ? 'error' : '';
    tile.className = `agent-tile ${tone}`.trim();
    tile.dataset.agentId = agent.id;
    tile.innerHTML = launchTileMarkup(agent);
    return tile;
  }));
}

function renderLogs() {
  const agent = state.agents.find((item) => item.id === selectedLogId);
  if (!agent) {
    logTitle.textContent = 'No agent selected';
    logOutput.textContent = 'Start an agent to stream install and runtime logs here.';
    return;
  }
  logTitle.textContent = `${agent.name} logs`;
  logOutput.textContent = (agent.logs || []).join('\n') || 'Waiting for output…';
  logOutput.scrollTop = logOutput.scrollHeight;
}

function renderLogSelect(agents) {
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

function render(payload) {
  state = payload;
  const agents = sortAgents(state.agents || []);
  state.agents = agents;
  if (buildVersionEl && state.version) {
    buildVersionEl.textContent = `Build ${state.version.versionCode}`;
  }
  updateMetrics(agents);
  updateAuth(state.auth || {}, state.router);
  renderLive(agents);
  renderLaunch(agents);
  renderLogSelect(agents);
}

async function refresh() {
  const response = await fetch('/api/status');
  if (!response.ok) throw new Error(`Status failed: ${response.status}`);
  render(await response.json());
}

async function postAction(id, action) {
  setConnection(`${action} requested`, 'live');
  const response = await fetch(`/api/agents/${id}/${action}`, { method: 'POST' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    setConnection(body.error || `${action} failed`, 'bad');
  }
  await refresh();
}

function connectEvents() {
  const events = new EventSource('/api/events');
  events.addEventListener('open', () => setConnection('Live', 'live'));
  events.addEventListener('status', (event) => {
    setConnection('Live', 'live');
    render(JSON.parse(event.data));
  });
  events.addEventListener('error', () => setConnection('Reconnecting', 'bad'));
}

function scrollLogsIntoView() {
  drawer?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.addEventListener('click', async (event) => {
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
  const agent = state.agents.find((item) => item.id === id);
  if (agent) {
    if (action === 'start') agent.state = 'installing';
    else if (action === 'restart' || action === 'stop') agent.state = 'stopping';
    renderLive(state.agents);
    renderLaunch(state.agents);
  }
  await postAction(id, action);
  selectedLogId = id;
  logSelect.value = id;
  renderLogs();
  scrollLogsIntoView();
});

logSelect?.addEventListener('change', () => {
  selectedLogId = logSelect.value;
  renderLogs();
});

jumpLogs?.addEventListener('click', (event) => {
  event.preventDefault();
  scrollLogsIntoView();
});

jumpLaunch?.addEventListener('click', (event) => {
  event.preventDefault();
  document.querySelector('#launchSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

if (updateSkillsBtn) {
  updateSkillsBtn.addEventListener('click', async () => {
    updateSkillsBtn.disabled = true;
    updateSkillsBtn.textContent = 'Updating…';
    if (skillsDetail) skillsDetail.textContent = 'Pulling skills from GitHub…';
    try {
      const res = await fetch('/api/skills/update', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        updateSkillsBtn.textContent = 'Done';
        if (skillsDetail) skillsDetail.textContent = data.summary || 'Skills updated from GitHub.';
      } else {
        updateSkillsBtn.textContent = 'Failed';
        if (skillsDetail) skillsDetail.textContent = data.error || 'Update failed.';
      }
    } catch (error) {
      updateSkillsBtn.textContent = 'Error';
      if (skillsDetail) skillsDetail.textContent = error.message;
    }
    setTimeout(() => {
      updateSkillsBtn.disabled = false;
      updateSkillsBtn.textContent = 'Update skills';
    }, 4000);
  });
}

themeSelect?.addEventListener('change', () => {
  localStorage.setItem('workerAgents.theme', themeSelect.value);
  applyTheme(themeSelect.value);
});

loadTheme();
refresh().then(connectEvents).catch((error) => {
  setConnection(error.message, 'bad');
});
