import net from 'node:net';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { execSync } from 'node:child_process';
import { config, defaultPath } from './config.js';
import * as nineRouter from './9router.js';
import { createLoginUrl, exchangeCodeForTokens, getAuthStatus, logout } from './auth.js';
import { supervisor } from './agents.js';
import { ensureSshd, runSetup, getSetupStatus, onSetupEvent } from './setup.js';
import { installSkill, listInstalledSkills, readInstalledSkill, searchSkills } from './skill-hub.js';

const publicDir = path.join(config.projectRoot, 'public');
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml']
]);
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const HERMES_CONFIG_PATH = path.join(config.hermesHome, 'config.yaml');
const WORKER_STATE_PATH = path.join(config.codexHome, '..', '.worker-agents', 'state.json');
const ROUTER_LOG_PATH = '/tmp/9router.log';
const consoleLogs = [];
const MAX_CONSOLE_LOGS = 500;
const PUBLIC_LOG_LINES = 40;

function captureConsoleLog(level, args) {
  const raw = [].map.call(args, String).join(' ');
  const clean = raw.replace(ANSI, '').trimEnd();
  if (!clean) return;
  consoleLogs.push(`${new Date().toLocaleTimeString()} [${level}] ${clean}`);
  if (consoleLogs.length > MAX_CONSOLE_LOGS) consoleLogs.shift();
}

const _origLog = console.log;
const _origWarn = console.warn;
const _origError = console.error;
console.log = function(...a) { captureConsoleLog('LOG', a); return _origLog.apply(console, a); };
console.warn = function(...a) { captureConsoleLog('WARN', a); return _origWarn.apply(console, a); };
console.error = function(...a) { captureConsoleLog('ERROR', a); return _origError.apply(console, a); };

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function lifecyclePayload() {
  let expiresAt = config.expiresAt;
  if (!expiresAt) {
    try {
      const state = JSON.parse(readFileSafe(WORKER_STATE_PATH));
      expiresAt = state.expires_at || '';
    } catch {
      expiresAt = '';
    }
  }
  return expiresAt ? { expiresAt } : null;
}

function readLastLines(filePath, limit = 120) {
  const text = readFileSafe(filePath);
  if (!text) return [];
  return text.trimEnd().split('\n').slice(-limit);
}

function execText(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function getListenerRows() {
  const rows = execText('ss -tlnp 2>/dev/null || true').split('\n').filter(Boolean);
  if (rows.length) return rows;
  return execText('netstat -anv -p tcp 2>/dev/null || true').split('\n').filter(Boolean);
}


function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

function requestOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || `${config.host}:${config.port}`;
  const hostname = String(host).toLowerCase().replace(/:\d+$/, '');
  // FRP terminates at the Worker Agents process over plain HTTP and may
  // rewrite X-Forwarded-Proto.  An advertised `worker-PORT.agentsweb.space`
  // hostname is nevertheless always the Caddy HTTPS entry point.
  const proto = /-\d+\.agentsweb\.space$/.test(hostname)
    ? 'https'
    : (req.headers['x-forwarded-proto'] || 'http');
  return `${proto}://${host}`;
}

function encodedHttpsAgentUrl(publicOrigin, agentUrl, port) {
  const rebased = new URL(agentUrl);
  const origin = new URL(publicOrigin);
  const suffix = '.agentsweb.space';
  rebased.protocol = origin.protocol;
  rebased.hostname = origin.hostname;
  rebased.port = origin.port;
  if ((origin.protocol === 'https:' || /-\d+\.agentsweb\.space$/.test(origin.hostname)) && origin.hostname.endsWith(suffix) && port) {
    const rawBase = origin.hostname.slice(0, -suffix.length);
    const base = rawBase.replace(/-\d+$/, '');
    rebased.protocol = 'https:';
    rebased.hostname = `${base}-${port}${suffix}`;
    rebased.port = '';
  }
  return rebased.toString();
}

function publicAgent(agent, origin) {
  if (!agent?.url) return { ...agent, logs: Array.isArray(agent?.logs) ? agent.logs.slice(-PUBLIC_LOG_LINES) : agent?.logs };
  try {
    const publicOrigin = new URL(origin);
    if (agent.proxied) {
      const rebased = new URL(agent.url);
      rebased.protocol = publicOrigin.protocol;
      rebased.hostname = publicOrigin.hostname;
      rebased.port = publicOrigin.port;
      return { ...agent, url: rebased.toString(), logs: Array.isArray(agent.logs) ? agent.logs.slice(-PUBLIC_LOG_LINES) : agent.logs };
    }
    return { ...agent, url: encodedHttpsAgentUrl(origin, agent.url, agent.port), logs: Array.isArray(agent.logs) ? agent.logs.slice(-PUBLIC_LOG_LINES) : agent.logs };
  } catch {
    return { ...agent, logs: Array.isArray(agent.logs) ? agent.logs.slice(-PUBLIC_LOG_LINES) : agent.logs };
  }
}

function publicRouter(router, origin) {
  try {
    const rebase = (url, port) => encodedHttpsAgentUrl(origin, url, port);
    return {
      ...router,
      logs: Array.isArray(router?.logs) ? router.logs.slice(-PUBLIC_LOG_LINES) : router?.logs,
      url: rebase(router.url, router.livePort || router.configuredPort),
      agent: router.agent
        ? { ...router.agent, url: rebase(router.agent.url, router.agent.port), logs: Array.isArray(router.agent.logs) ? router.agent.logs.slice(-PUBLIC_LOG_LINES) : router.agent.logs }
        : router.agent
    };
  } catch {
    return router;
  }
}

function getOpenClawProxyTarget() {
  const snapshot = supervisor.snapshot().find((agent) => agent.id === 'openclaw');
  if (!snapshot?.port || snapshot.state !== 'running') return null;
  return {
    port: snapshot.port,
    origin: `http://127.0.0.1:${snapshot.port}`
  };
}

function getAgentProxyTarget(id) {
  if (id === '__9router__') {
    const router = nineRouter.getStatus();
    if (!router.livePort || router.state !== 'running') return null;
    return { port: router.livePort };
  }
  const snapshot = supervisor.snapshot().find((agent) => agent.id === id);
  if (!snapshot?.port || snapshot.state !== 'running') return null;
  return { port: snapshot.port };
}

function localhostLabel(id) {
  return String(id || '')
    .toLowerCase()
    .replace(/^_+|_+$/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function localhostAgentIdFromRequest(req) {
  const hostname = String(req.headers.host || '')
    .toLowerCase()
    .replace(/:\d+$/, '');
  if (!hostname.endsWith('.localhost')) return '';
  const label = hostname.slice(0, -'.localhost'.length);
  if (!label || label.includes('.')) return '';
  if (label === localhostLabel('__9router__')) return '__9router__';
  return supervisor.snapshot().find((agent) => localhostLabel(agent.id) === label)?.id || '';
}

function encodedPortFromRequest(req) {
  const routedPort = Number.parseInt(String(req.headers['x-agentsweb-target-port'] || ''), 10);
  if (routedPort >= 1 && routedPort <= 65535) return routedPort;
  const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .toLowerCase()
    .replace(/:\d+$/, '');
  const suffix = '.agentsweb.space';
  if (!rawHost.endsWith(suffix)) return 0;
  const match = rawHost.slice(0, -suffix.length).match(/-(\d{1,5})$/);
  if (!match) return 0;
  const port = Number.parseInt(match[1], 10);
  return port >= 1 && port <= 65535 ? port : 0;
}

function proxyPortHttp(req, res, port) {
  const upstream = http.request({
    hostname: '127.0.0.1',
    port,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: `127.0.0.1:${port}` }
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', (error) => sendJson(res, 502, { error: `Port ${port} is unavailable: ${error.message}` }));
  req.pipe(upstream);
}

function proxyPortUpgrade(req, socket, port) {
  const upstream = net.connect(port, '127.0.0.1', () => {
    const lines = [`GET ${req.url || '/'} HTTP/1.1`, `Host: 127.0.0.1:${port}`];
    for (const [key, value] of Object.entries(req.headers)) {
      if (!value || key.toLowerCase() === 'host') continue;
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`);
    }
    lines.push('\r\n');
    upstream.write(lines.join('\r\n'));
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'));
}

function proxyAgentHttp(req, res, id, prefix = '') {
  const target = getAgentProxyTarget(id);
  if (!target) {
    sendJson(res, 503, { error: `${id} is not running` });
    return;
  }
  const upstream = http.request({
    hostname: '127.0.0.1',
    port: target.port,
    method: req.method,
    path: prefix ? (req.url.replace(prefix, '') || '/') : (req.url || '/'),
    headers: { ...req.headers, host: `127.0.0.1:${target.port}` }
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', (error) => sendJson(res, 502, { error: error.message }));
  req.pipe(upstream);
}

function proxyAgentUpgrade(req, socket, id, prefix = '') {
  const target = getAgentProxyTarget(id);
  if (!target) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  const upstream = net.connect(target.port, '127.0.0.1', () => {
    const path = prefix ? (req.url.replace(prefix, '') || '/') : (req.url || '/');
    const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${target.port}`];
    for (const [key, value] of Object.entries(req.headers)) {
      if (!value || key.toLowerCase() === 'host') continue;
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`);
    }
    lines.push('\r\n');
    upstream.write(lines.join('\r\n'));
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'));
}

function handleOpenClawUpgrade(req, socket) {
  const target = getOpenClawProxyTarget();
  if (!target) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  const upstream = net.connect(target.port, '127.0.0.1', () => {
    const lines = [
      `GET ${req.url.replace(/^\/proxy\/openclaw/, '') || '/'} HTTP/1.1`,
      `Host: 127.0.0.1:${target.port}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      `Origin: ${target.origin}`
    ];
    for (const [key, value] of Object.entries(req.headers)) {
      if (!value) continue;
      const lower = key.toLowerCase();
      if (['host', 'connection', 'upgrade', 'origin'].includes(lower)) continue;
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${key}: ${item}`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    }
    lines.push('\r\n');
    upstream.write(lines.join('\r\n'));
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => {
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  });
}

async function findAvailablePort(basePort, maxRange) {
  for (let offset = 0; offset < maxRange; offset++) {
    const port = basePort + offset;
    const available = await new Promise((resolve) => {
      const tester = net.createServer();
      tester.once('error', () => resolve(false));
      tester.once('listening', () => {
        tester.close();
        resolve(true);
      });
      tester.listen(port, config.host);
    });
    if (available) return port;
  }
  return basePort;
}

function statusPayload(req) {
  const origin = requestOrigin(req);
  const router = publicRouter(nineRouter.getStatus(), origin);
  const agents = supervisor.snapshot().map((agent) => publicAgent(agent, origin));
  const filtered = config.launch
    ? agents.filter((a) => a.id === config.launch)
    : agents;
  return {
    version: buildVersion,
    lifecycle: lifecyclePayload(),
    auth: getAuthStatus(),
    router,
    agents: [
      router.agent,
      ...filtered,
      {
        id: '__console__',
        name: 'Agent Console',
        state: 'running',
        port: config.port,
        pid: process.pid,
        url: '',
        error: '',
        startedAt: '',
        command: '',
        logs: consoleLogs.slice(-PUBLIC_LOG_LINES)
      }
    ],
    setup: getSetupStatus()
  };
}

function serveStatic(res, pathname, headOnly = false) {
  const normalized = pathname === '/' ? '/index.html' : pathname;
  let filePath = path.normalize(path.join(publicDir, normalized));
  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'content-type': contentTypes.get(ext) || 'application/octet-stream' });
  if (headOnly) {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}
function serveLaunchPage(res) {
  const filePath = path.join(publicDir, 'launch.html');
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: 'launch.html not found' });
    return;
  }
  let html = fs.readFileSync(filePath, 'utf8');
  html = html.replace('{{LAUNCH_AGENT}}', escapeHtml(config.launch));
  html = html.replace('{{LAUNCH_AGENT_JSON}}', JSON.stringify(config.launch));
  sendHtml(res, 200, html);
}


async function handleAgentAction(req, res, pathname) {
  const match = pathname.match(/^\/api\/agents\/([^/]+)\/(start|stop|restart)$/);
  if (!match || req.method !== 'POST') return false;
  const [, id, action] = match;
  if (id === '__9router__') {
    try {
      const result =
        action === 'restart' ? await nineRouter.restart(console.log)
        : action === 'stop' ? await nineRouter.stop(console.log)
        : await nineRouter.start(console.log);
      sendJson(res, 200, { ok: true, agent: result.agent, router: result });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return true;
  }
  try {
    const result = publicAgent(await supervisor[action](id), requestOrigin(req));
    sendJson(res, 200, { ok: true, agent: result });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  }
  return true;
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  });

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('status', statusPayload(req));
  const listener = (event) => send('status', { ...statusPayload(req), event });
  supervisor.on('change', listener);
  const unsubSetup = onSetupEvent(() => send('status', statusPayload(req)));
  const interval = setInterval(() => send('status', statusPayload(req)), 5000);

  req.on('close', () => {
    clearInterval(interval);
    supervisor.off('change', listener);
    unsubSetup();
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${config.host}:${config.port}`}`);
  const encodedPort = encodedPortFromRequest(req);
  if (encodedPort && encodedPort !== config.port) {
    proxyPortHttp(req, res, encodedPort);
    return;
  }
  const localhostAgentId = localhostAgentIdFromRequest(req);
  if (localhostAgentId) {
    proxyAgentHttp(req, res, localhostAgentId);
    return;
  }

  if (url.pathname === '/favicon.ico' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(204, { 'cache-control': 'public, max-age=86400' });
    res.end();
    return;
  }

  if (url.pathname === '/api/status' && req.method === 'GET') {
    sendJson(res, 200, statusPayload(req));
    return;
  }

  if (url.pathname === '/api/events' && req.method === 'GET') {
    handleEvents(req, res);
    return;
  }

  if (url.pathname === '/api/auth/login' && req.method === 'GET') {
    redirect(res, createLoginUrl());
    return;
  }

  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    logout();
    sendJson(res, 200, { ok: true, auth: getAuthStatus() });
    return;
  }

  if (url.pathname === '/auth/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    try {
      if (!code) throw new Error('Missing OAuth code.');
      await exchangeCodeForTokens(code, state);
      // Restart Hermes WebUI so legacy auth callbacks still refresh the
      // on-disk default config, which now stays pinned to 9Router.
      try { await supervisor.restart('hermes-webui'); } catch {}
      sendHtml(res, 200, '<!doctype html><meta charset="utf-8"><title>Signed in</title><script>location.href="/?dashboard=1"</script><p>Signed in. Returning to the console.</p>');
    } catch (error) {
      sendHtml(res, 500, `<!doctype html><meta charset="utf-8"><title>Login failed</title><p>Login failed: ${escapeHtml(error.message)}</p><p><a href="/">Return to console</a></p>`);
    }
    return;
  }

  if (url.pathname === '/api/skills-hub' && req.method === 'GET') {
    sendJson(res, 200, { installed: listInstalledSkills() });
    return;
  }

  if (url.pathname === '/api/skills-hub/search' && req.method === 'GET') {
    try {
      sendJson(res, 200, { results: await searchSkills(url.searchParams.get('q')) });
    } catch (error) {
      sendJson(res, 502, { error: error.message || 'Skill search failed.' });
    }
    return;
  }

  if (url.pathname === '/api/skills-hub/readme' && req.method === 'GET') {
    const skill = readInstalledSkill(url.searchParams.get('name'));
    if (!skill) sendJson(res, 404, { error: 'Installed skill not found.' });
    else sendJson(res, 200, skill);
    return;
  }

  if (url.pathname === '/api/skills-hub/install' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const skill = await installSkill(body.source, body.name);
      sendJson(res, 200, { ok: true, skill });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message || 'Skill installation failed.' });
    }
    return;
  }

  if (await handleAgentAction(req, res, url.pathname)) return;
  if (url.pathname === '/proxy/web-vnc' || url.pathname.startsWith('/proxy/web-vnc/')) {
    proxyAgentHttp(req, res, 'web-vnc', '/proxy/web-vnc');
    return;
  }
  // Launch mode: serve launch.html at / (unless ?dashboard=1)
  if (config.launch && url.pathname === '/' && req.method === 'GET') {
    if (url.searchParams.get('dashboard') !== '1') {
      serveLaunchPage(res);
      return;
    }
  }


  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(res, url.pathname, req.method === 'HEAD');
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    sendJson(res, 500, { error: error.message });
  });
});

server.on('upgrade', (req, socket) => {
  const encodedPort = encodedPortFromRequest(req);
  if (encodedPort && encodedPort !== config.port) {
    proxyPortUpgrade(req, socket, encodedPort);
    return;
  }
  const localhostAgentId = localhostAgentIdFromRequest(req);
  if (localhostAgentId) {
    if (localhostAgentId === 'openclaw') handleOpenClawUpgrade(req, socket);
    else proxyAgentUpgrade(req, socket, localhostAgentId);
    return;
  }
  if (req.url === '/proxy/web-vnc' || req.url?.startsWith('/proxy/web-vnc/')) {
    proxyAgentUpgrade(req, socket, 'web-vnc', '/proxy/web-vnc');
    return;
  }
  if (req.url === '/proxy/openclaw' || req.url?.startsWith('/proxy/openclaw/')) {
    handleOpenClawUpgrade(req, socket);
    return;
  }
  socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
});

process.on('SIGINT', async () => {
  await supervisor.stopAll();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await supervisor.stopAll();
  process.exit(0);
});

try {
  ensureSshd();
} catch (error) {
  console.error('[sshd] Startup error:', error.message);
}

(async () => {
  // Kill any stale process on the default port before acquiring
  try {
    const pids = execSync(`lsof -ti :${config.port} 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (pids) {
      for (const pid of pids.split('\n').filter(Boolean)) {
        try { process.kill(parseInt(pid, 10), 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  } catch {
    // lsof not available — try fuser as fallback
    try { execSync(`fuser -k ${config.port}/tcp 2>/dev/null`, { stdio: 'ignore' }); } catch {}
  }
  const resolvedPort = await findAvailablePort(config.port, config.portScanRange);
  if (resolvedPort !== config.port) {
    console.log(`Port ${config.port} in use, using port ${resolvedPort} instead`);
  }
  server.listen(resolvedPort, config.host, () => {
  console.log(`Agent console listening at http://${config.host}:${resolvedPort}`);

  // Idempotent filesystem preflight (non-fatal)
  runSetup().catch((error) => {
    console.error('[setup] Preflight error:', error.message);
  }).then(() => {
  nineRouter.start(console.log).then((routerStatus) => {
    if (routerStatus.state === 'error' && !routerStatus.livePort) {
      console.warn('[9router] Background startup did not produce a live listener');
    }
  }).catch((error) => {
    console.error('[9router] Startup error:', error.message);
  });
  if (config.launch) {
    if (supervisor.agents.has(config.launch)) {
      console.log(`Launch mode: auto-starting agent "${config.launch}"...`);
      supervisor.start(config.launch).catch((error) => {
        console.error(`Launch mode: failed to start "${config.launch}":`, error.message);
      });
    } else {
      console.error(`Launch mode: unknown agent "${config.launch}". Available: ${Array.from(supervisor.agents.keys()).join(', ')}`);
    }
  }
  if (config.autoStartAll) {
    console.log(`Auto-start mode: installing and starting all agents (${Array.from(supervisor.agents.keys()).join(', ')})...`);
    supervisor.startAll().then((results) => {
      const failed = results.filter((result) => !result.ok);
      console.log(`Auto-start mode: ${results.length - failed.length}/${results.length} agents started.`);
      for (const result of failed) {
        console.error(`Auto-start mode: failed to start "${result.id}": ${result.error}`);
      }
    }).catch((error) => {
      console.error('Auto-start mode: error during agent startup:', error.message);
    });
  }
  });
  });
})();
const buildVersion = (() => {
  // Optional packaged build metadata.
  try {
    const apkVersionPath = path.join(process.cwd(), '.apk_version');
    const versionCode = parseInt(fs.readFileSync(apkVersionPath, 'utf-8').trim(), 10);
    if (!isNaN(versionCode) && versionCode > 0) {
      return { versionCode, versionName: '0.1.0' };
    }
  } catch { /* fall through */ }

  // On Mac dev: compute from git
  try {
    const cwd = config.projectRoot;
    const count = execSync('git rev-list --count HEAD', { encoding: 'utf-8', cwd }).trim();
    return { versionCode: parseInt(count, 10) + 578, versionName: '0.1.0' };
  } catch {
    return { versionCode: 0, versionName: 'dev' };
  }
})();
