import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { config, defaultPath } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTER_NPM_PACKAGE = '9router-vibefin';
const ROUTER_PACKAGE_DIR = path.join(config.projectRoot, 'node_modules', ROUTER_NPM_PACKAGE);
const ROUTER_PACKAGE_JSON = path.join(ROUTER_PACKAGE_DIR, 'package.json');
const ROUTER_SERVER_PATH = path.join(ROUTER_PACKAGE_DIR, 'app', 'server.js');
const ROUTER_LOG_PATH = '/tmp/9router.log';
const ROUTER_PORT = Number.parseInt(process.env.WORKER_AGENTS_9ROUTER_PORT || '20128', 10);
const ROUTER_API_KEY = process.env.WORKER_AGENTS_9ROUTER_API_KEY || 'local-dev-key';
const ROUTER_MODEL = process.env.WORKER_AGENTS_9ROUTER_MODEL || 'opencode/big-pickle';
const OPEN_ACCESS_PATCH_MARK = 'sshworker: open remote LLM API access when requireApiKey=false';
const NODE_FILE_POLYFILL = path.join(__dirname, '..', 'scripts', 'node-file-polyfill.cjs');
const HEALTH_TIMEOUT_MS = Number.parseInt(process.env.ROUTER_HEALTH_TIMEOUT_MS || '120000', 10);
const HEALTH_POLL_MS = 2000;
const OPEN_ACCESS_RETRY_MS = Number.parseInt(process.env.ROUTER_OPEN_ACCESS_RETRY_MS || '600000', 10);
const OPEN_ACCESS_RETRY_STEP_MS = 10000;
let startupPromise = null;
let startupState = 'idle';
let startupError = '';
let openAccessLoopRunning = false;
let readinessCheckedAt = '';
let readinessModelsCount = 0;
let launchGeneration = 0;

const originalProcessEmit = process.emit;
process.emit = function suppressOwnedSqliteWarning(name, data, ...rest) {
  if (name === 'warning'
      && data?.name === 'ExperimentalWarning'
      && /SQLite/i.test(data.message || '')) {
    return false;
  }
  return originalProcessEmit.call(this, name, data, ...rest);
};

function execText(command) {
  try {
    return execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60000,
      env: { ...process.env, PATH: defaultPath }
    });
  } catch {
    return '';
  }
}

function execPowerShell(command) {
  try {
    return execSync(`powershell.exe -NoProfile -Command ${JSON.stringify(command)}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60000,
      env: { ...process.env, PATH: defaultPath }
    });
  } catch {
    return '';
  }
}

function findLinuxProcListener(port) {
  if (process.platform !== 'linux') return null;
  const portHex = Number(port).toString(16).toUpperCase().padStart(4, '0');
  const socketInodes = new Set();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let rows = [];
    try { rows = fs.readFileSync(table, 'utf8').trim().split('\n').slice(1); } catch { continue; }
    for (const row of rows) {
      const fields = row.trim().split(/\s+/);
      const localPort = fields[1]?.split(':').at(-1)?.toUpperCase();
      if (localPort === portHex && fields[3] === '0A' && fields[9]) socketInodes.add(fields[9]);
    }
  }
  if (!socketInodes.size) return null;
  let processDirs = [];
  try { processDirs = fs.readdirSync('/proc', { withFileTypes: true }); } catch { return -1; }
  for (const entry of processDirs) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const fdDir = `/proc/${entry.name}/fd`;
    let fds = [];
    try { fds = fs.readdirSync(fdDir); } catch { continue; }
    for (const fd of fds) {
      let target = '';
      try { target = fs.readlinkSync(path.join(fdDir, fd)); } catch { continue; }
      const match = target.match(/^socket:\[(\d+)\]$/);
      if (match && socketInodes.has(match[1])) return Number.parseInt(entry.name, 10);
    }
  }
  // The socket is listening, but procfs permissions hid its owning process.
  return -1;
}

function findRouterPackagePath() {
  if (!fs.existsSync(ROUTER_PACKAGE_JSON)) {
    throw new Error(`${ROUTER_NPM_PACKAGE} is missing from Worker Agents node_modules; run npm ci in ${config.projectRoot}`);
  }
  return ROUTER_PACKAGE_JSON;
}

function installedRouterServerPath() {
  findRouterPackagePath();
  if (!fs.existsSync(ROUTER_SERVER_PATH)) {
    throw new Error(`${ROUTER_NPM_PACKAGE} server.js not found at ${ROUTER_SERVER_PATH}`);
  }
  return ROUTER_SERVER_PATH;
}

function routerPackageMetadata() {
  const packagePath = findRouterPackagePath();
  const metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  return {
    name: metadata.name || ROUTER_NPM_PACKAGE,
    version: metadata.version || '',
    packagePath,
    serverPath: installedRouterServerPath(),
  };
}

function findListenerForPort(port) {
  if (process.platform === 'win32') {
    const ps = [
      `$conn = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`,
      'if ($conn) { Write-Output $conn }'
    ].join('; ');
    const out = execPowerShell(ps).trim();
    if (out) {
      const pid = Number.parseInt(out, 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  }
  const listenerCommand = process.platform === 'win32' ? 'netstat -ano' : 'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || true';
  const portPattern = new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\*|localhost|\\[::\\]|::|:::|\\.)[:.]${port}(?:\\b|\\s)`);
  const listenerRows = execText(listenerCommand).split('\n').filter(Boolean);
  for (const line of listenerRows) {
    if (!portPattern.test(line)) continue;
    if (!/LISTEN|LISTENING/i.test(line)) continue;
    const match = line.match(/pid=(\d+)/) || line.match(/\s(\d+)\/\S+/) || line.match(/\s(\d+)\s*$/);
    return match ? Number.parseInt(match[1], 10) : -1;
  }
  const lsofRows = execText(`lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null || true`).split('\n').filter(Boolean);
  if (lsofRows.length > 1) {
    const match = lsofRows[1].match(/^\S+\s+(\d+)\s/);
    return match ? Number.parseInt(match[1], 10) : null;
  }
  return findLinuxProcListener(port);
}

function killExistingListeners() {
  const pid = findListenerForPort(ROUTER_PORT);
  if (pid && pid > 0) {
    if (process.platform === 'win32') {
      execText(`taskkill /F /PID ${pid} /T`);
    } else {
      execText(`kill ${pid} 2>/dev/null || true`);
      execText(`sleep 1`);
    }
  }
  return pid && pid > 0 ? pid : null;
}

function patchRouterDashboardGuard(log) {
  const guardCandidates = [
    path.join(ROUTER_PACKAGE_DIR, 'src', 'dashboardGuard.js'),
    path.join(ROUTER_PACKAGE_DIR, 'app', 'dashboardGuard.js'),
  ];
  const guardPath = guardCandidates.find((candidate) => fs.existsSync(candidate));
  if (!guardPath) {
    if (log) log('[9router] dashboardGuard.js not found, skipping open-access patch');
    return false;
  }
  let source = fs.readFileSync(guardPath, 'utf8');
  if (source.includes(OPEN_ACCESS_PATCH_MARK)) {
    if (log) log('[9router] dashboardGuard.js already open-access patched');
    return false;
  }
  const needle = `async function canAccessPublicLlmApi(request) {
  if (isLocalRequest(request)) return true;
  if (await hasValidCliToken(request)) return true;
  return await hasValidApiKey(request);
}`;
  if (!source.includes(needle)) {
    if (log) log('[9router] canAccessPublicLlmApi shape changed, skipping open-access patch');
    return false;
  }
  const replacement = `async function canAccessPublicLlmApi(request) {
  if (isLocalRequest(request)) return true;
  if (await hasValidCliToken(request)) return true;
  // ${OPEN_ACCESS_PATCH_MARK}
  const settings = await loadSettings();
  if (settings && settings.requireApiKey === false) return true;
  return await hasValidApiKey(request);
}`;
  fs.writeFileSync(guardPath, source.replace(needle, replacement));
  if (log) log('[9router] Patched dashboardGuard.js for open remote API access');
  return true;
}

function routerMiddlewareCandidates() {
  const relativePaths = [
    path.join('app', '.next-cli-build', 'server', 'middleware.js'),
    path.join('.next', 'server', 'middleware.js'),
  ];
  return relativePaths.map((relative) => path.join(ROUTER_PACKAGE_DIR, relative));
}

function patchRouterMiddleware(log) {
  const middlewarePath = routerMiddlewareCandidates().find((candidate) => fs.existsSync(candidate));
  if (!middlewarePath) {
    if (log) log('[9router] compiled middleware.js not found, skipping open-access middleware patch');
    return false;
  }
  let source = fs.readFileSync(middlewarePath, 'utf8');
  if (source.includes('openApiKeyAccess.requireApiKey!==false')) {
    if (log) log('[9router] middleware.js already open-access patched');
    return false;
  }
  const settingsReader = source.match(/async function ([A-Za-z_$][\w$]*)\(\)\{try\{return await \(0,[A-Za-z_$][\w$]*\.getSettings\)\(\)\}catch\{return null\}\}/);
  const remoteGuard = source.match(/if\(([A-Za-z_$][\w$]*)\(b\)\)return await ([A-Za-z_$][\w$]*)\(a\)\?i\.NextResponse\.next\(\):i\.NextResponse\.json\(\{error:"API key required for remote API access"\},\{status:401\}\);/);
  if (!settingsReader || !remoteGuard) {
    if (log) log('[9router] middleware guard shape changed, skipping open-access middleware patch');
    return false;
  }
  const settingsFn = settingsReader[1];
  const pathFn = remoteGuard[1];
  const keyFn = remoteGuard[2];
  const replacement = `if(${pathFn}(b)){const openApiKeyAccess=await ${settingsFn}();if(!openApiKeyAccess||openApiKeyAccess.requireApiKey!==false)return await ${keyFn}(a)?i.NextResponse.next():i.NextResponse.json({error:"API key required for remote API access"},{status:401});}`;
  fs.writeFileSync(middlewarePath, source.replace(remoteGuard[0], replacement));
  if (log) log('[9router] Patched middleware.js for open remote API access');
  return true;
}

function isRouterMiddlewarePatched() {
  const middlewarePath = routerMiddlewareCandidates().find((candidate) => fs.existsSync(candidate));
  if (!middlewarePath) return false;
  return fs.readFileSync(middlewarePath, 'utf8').includes('openApiKeyAccess.requireApiKey!==false');
}

function assertSupportedNode() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isFinite(major) || major < 22) {
    throw new Error(`Worker Agents requires Node.js 22 or newer for its owned 9Router runtime; running ${process.version} at ${process.execPath}`);
  }
}

export function routerLaunchSpec(port = ROUTER_PORT, serverPath = installedRouterServerPath()) {
  assertSupportedNode();
  const dataDir = path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.9router', 'data');
  const existingNodeOptions = String(process.env.NODE_OPTIONS || '').trim();
  const nodeOptions = [existingNodeOptions, `--require=${NODE_FILE_POLYFILL}`].filter(Boolean).join(' ');
  return {
    executable: process.execPath,
    args: [serverPath],
    cwd: path.dirname(serverPath),
    env: {
      ...process.env,
      PATH: defaultPath,
      NODE_ENV: 'production',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      NEXT_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      BASE_URL: `http://127.0.0.1:${port}`,
      DATA_DIR: dataDir,
      NODE_OPTIONS: nodeOptions,
    },
  };
}

function launchOwnedRouter(logFd) {
  const launch = routerLaunchSpec();
  fs.mkdirSync(launch.env.DATA_DIR, { recursive: true });
  if (!isRouterMiddlewarePatched()) {
    throw new Error(`Owned 9Router middleware is not prepared; run npm ci in ${config.projectRoot}`);
  }
  return spawn(launch.executable, launch.args, {
    cwd: launch.cwd,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: launch.env,
  });
}

function writeHermesConfig(port = ROUTER_PORT) {
  const hermesConfigPath = path.join(config.hermesHome, 'config.yaml');
  const current = (() => {
    try { return fs.readFileSync(hermesConfigPath, 'utf8'); } catch { return ''; }
  })();
  const baseUrlLine = `  base_url: http://127.0.0.1:${port}/v1`;
  if (current.includes(baseUrlLine)) return false;
  const next = current
    ? current.replace(/base_url:\s*http:\/\/127\.0\.0\.1:\d+\/v1/, baseUrlLine.trimStart())
    : [
        'model:',
        '  provider: custom',
        '  default: opencode/big-pickle',
        `  base_url: http://127.0.0.1:${port}/v1`,
        `  api_key: ${ROUTER_API_KEY}`,
        '',
      ].join('\n');
  fs.mkdirSync(path.dirname(hermesConfigPath), { recursive: true });
  fs.writeFileSync(hermesConfigPath, next, { mode: 0o600 });
  return true;
}

async function probeRouterModels() {
  const response = await fetch(`http://127.0.0.1:${ROUTER_PORT}/v1/models`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`/v1/models returned HTTP ${response.status}`);
  const payload = await response.json();
  const count = Array.isArray(payload?.data) ? payload.data.length : 0;
  if (!count) throw new Error('/v1/models returned no models');
  return count;
}

async function waitForReadiness(timeoutMs = HEALTH_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const modelsCount = await probeRouterModels();
      readinessCheckedAt = new Date().toISOString();
      readinessModelsCount = modelsCount;
      return modelsCount;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  return 0;
}

async function applyOpenAccessSettings(log) {
  const dataDirCandidates = [
    process.env.DATA_DIR,
    process.env.HOME ? path.join(process.env.HOME, '.9router', 'data') : '',
    process.env.HOME ? path.join(process.env.HOME, '.9router') : '',
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.9router', 'data') : '',
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.9router') : '',
    '/root/.9router',
    '/root/.9router/data',
    '/tmp/.9router',
    path.join('/tmp', '.9router', 'data'),
  ].filter(Boolean);
  const dbCandidates = dataDirCandidates.map((dataDir) => path.join(dataDir, 'db', 'data.sqlite'));
  const DB_WAIT_MS = 60000;
  const DB_WAIT_STEP_MS = 1000;
  const dbDeadline = Date.now() + DB_WAIT_MS;
  let dbPath = '';
  let dbError = '';
  while (!dbPath) {
    const candidate = dbCandidates.find((path) => fs.existsSync(path));
    if (candidate) {
      try {
        ensureOpenAccess(candidate);
        dbPath = candidate;
      } catch (error) {
        dbError = error.message;
        if (log) log(`[9router] 9Router database not ready yet: ${error.message}`);
      }
    } else if (log) {
      log(`[9router] Waiting for 9Router database file...`);
    }
    if (!dbPath) {
      if (Date.now() >= dbDeadline) {
        throw new Error(`9Router database not ready after ${DB_WAIT_MS / 1000}s${dbError ? `: ${dbError}` : ''}`);
      }
      await new Promise((resolve) => setTimeout(resolve, DB_WAIT_STEP_MS));
    }
  }
  if (log) log('[9router] Open API access settings applied');
  return true;
}

function ensureOpenAccess(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    let changed = false;
    const row = db.prepare('select data from settings where id = 1').get();
    const data = row?.data ? JSON.parse(row.data) : {};
    if (data.requireLogin !== false) {
      data.requireLogin = false;
      changed = true;
    }
    if (data.requireApiKey !== false) {
      data.requireApiKey = false;
      changed = true;
    }
    if (changed) {
      db.prepare('insert into settings(id, data) values(1, ?) on conflict(id) do update set data = excluded.data').run(JSON.stringify(data));
    }
    const verified = db.prepare('select data from settings where id = 1').get();
    const verifiedData = JSON.parse(verified?.data || '{}');
    if (verifiedData.requireLogin !== false) throw new Error('9Router requireLogin setting did not persist');
    if (verifiedData.requireApiKey !== false) throw new Error('9Router requireApiKey setting did not persist');
    return changed;
  } finally {
    db.close();
  }
}

async function probeRouterDatabase(log) {
  // 9Router creates its SQLite DB lazily on the first request that loads
  // settings, so touch the dashboard locally before the open-access seed.
  try {
    const response = await fetch(`http://127.0.0.1:${ROUTER_PORT}/dashboard`, {
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });
    if (log) log(`[9router] Dashboard DB probe: HTTP ${response.status}`);
  } catch (error) {
    if (log) log(`[9router] Dashboard DB probe failed: ${error.message}`);
  }
}

function ensureOpenAccessSettings(log) {
  if (openAccessLoopRunning) return;
  openAccessLoopRunning = true;
  (async () => {
    try {
      const deadline = Date.now() + OPEN_ACCESS_RETRY_MS;
      while (Date.now() < deadline) {
        try {
          await probeRouterDatabase(log);
          await applyOpenAccessSettings(log);
          if (log) log('[9router] Open API access settings applied');
          return;
        } catch (error) {
          if (log) log(`[9router] Open access settings not applied yet: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, OPEN_ACCESS_RETRY_STEP_MS));
        }
      }
      if (log) log(`[9router] Open access settings patch gave up after ${OPEN_ACCESS_RETRY_MS / 1000}s`);
    } finally {
      openAccessLoopRunning = false;
    }
  })();
}

export async function start(log) {
  const live = findListenerForPort(ROUTER_PORT);
  if (live && live > 0) {
    try {
      readinessModelsCount = await probeRouterModels();
      readinessCheckedAt = new Date().toISOString();
      startupState = 'running';
      startupError = '';
      ensureOpenAccessSettings(log);
      return getStatus();
    } catch (error) {
      if (log) log(`[9router] Existing listener failed readiness and will be replaced: ${error.message}`);
      killExistingListeners();
      readinessModelsCount = 0;
      readinessCheckedAt = '';
    }
  }
  if (startupPromise) return await startupPromise;
  startupError = '';
  startupState = 'installing';
  startupPromise = new Promise((resolve, reject) => {
    setTimeout(async () => {
      try {
        killExistingListeners();
        const runtime = routerPackageMetadata();
        const logFd = fs.openSync(ROUTER_LOG_PATH, 'w');
        const generation = ++launchGeneration;
        if (log) log(`[9router] Starting owned ${runtime.name}@${runtime.version} with ${process.execPath} on port ${ROUTER_PORT}...`);
        const child = launchOwnedRouter(logFd);
        child.once('exit', (code, signal) => {
          if (generation !== launchGeneration) return;
          readinessModelsCount = 0;
          readinessCheckedAt = '';
          if (startupState !== 'stopped') {
            startupState = 'error';
            startupError = `9Router exited before or after readiness (code=${code ?? 'null'}, signal=${signal || 'none'}).`;
            if (log) log(`[9router] ${startupError}`);
          }
        });
        child.unref();
        fs.closeSync(logFd);
        startupState = 'starting';
        if (log) log(`[9router] Bootstrap process started (pid ${child.pid})`);
        const modelsCount = await waitForReadiness();
        if (modelsCount) {
          startupState = 'running';
          startupError = '';
          if (log) log(`[9router] Readiness passed with ${modelsCount} models on port ${ROUTER_PORT}`);
          ensureOpenAccessSettings(log);
          writeHermesConfig();
        } else {
          startupState = 'error';
          startupError = `9Router /v1/models readiness failed after ${HEALTH_TIMEOUT_MS / 1000}s.`;
          if (log) log(`[9router] Readiness failed after ${HEALTH_TIMEOUT_MS / 1000}s`);
        }
        resolve(getStatus());
      } catch (error) {
        startupState = 'error';
        startupError = error.message;
        if (log) log(`[9router] Startup error: ${error.message}`);
        resolve(getStatus());
      } finally {
        startupPromise = null;
      }
    }, 0);
  });
  return await startupPromise;
}

export function getStatus() {
  const listenerPid = findListenerForPort(ROUTER_PORT);
  const listening = Boolean(listenerPid);
  const running = listening && readinessModelsCount > 0;
  if (!listening) {
    readinessModelsCount = 0;
    readinessCheckedAt = '';
  }
  const pid = listenerPid && listenerPid > 0 ? listenerPid : null;
  let logs = [];
  try {
    // Bounded tail read: status polls run every few seconds and must not
    // load the whole router log into memory each time.
    const fd = fs.openSync(ROUTER_LOG_PATH, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - 65536);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    logs = buf.toString('utf8').trimEnd().split('\n').slice(-120);
  } catch { /* no log yet */ }
  const state = running
    ? 'running'
    : listening
      ? 'starting'
    : startupState === 'installing'
      ? 'installing'
      : startupState === 'starting'
        ? 'starting'
        : startupState === 'stopped'
          ? 'stopped'
          : 'error';
  const error = running || listening
    ? ''
    : (startupError || (state === 'installing'
      ? '9Router is preparing its local checkout and build.'
      : state === 'starting'
        ? '9Router is starting in the background.'
        : state === 'stopped'
          ? ''
          : `9Router is not listening on port ${ROUTER_PORT}.`));
  let runtime = null;
  try {
    runtime = {
      ...routerPackageMetadata(),
      owned: true,
      nodeVersion: process.version,
      nodeExecutable: process.execPath,
    };
  } catch (runtimeError) {
    runtime = {
      name: ROUTER_NPM_PACKAGE,
      owned: true,
      nodeVersion: process.version,
      nodeExecutable: process.execPath,
      error: runtimeError.message,
    };
  }
  return {
    configuredPort: ROUTER_PORT,
    livePort: running ? ROUTER_PORT : null,
    state,
    error,
    pid,
    logs,
    readiness: {
      ready: running,
      checkedAt: readinessCheckedAt,
      modelsCount: readinessModelsCount,
      probe: '/v1/models',
    },
    runtime,
    url: `http://127.0.0.1:${ROUTER_PORT}/dashboard/providers`,
    agent: {
      id: '__9router__',
      name: '9Router',
      state,
      port: ROUTER_PORT,
      pid,
      url: `http://127.0.0.1:${ROUTER_PORT}/dashboard/providers`,
      error,
      startedAt: '',
      command: '9router',
      logs,
    },
  };
}

export async function restart(log) {
  launchGeneration += 1;
  startupPromise = null;
  startupState = 'idle';
  startupError = '';
  readinessModelsCount = 0;
  readinessCheckedAt = '';
  killExistingListeners();
  return start(log);
}

export async function stop(log) {
  launchGeneration += 1;
  startupPromise = null;
  startupState = 'stopped';
  startupError = '';
  readinessModelsCount = 0;
  readinessCheckedAt = '';
  const pid = killExistingListeners();
  if (log) {
    if (pid) log(`[9router] Stopped pid ${pid}`);
    else log('[9router] Already stopped');
  }
  return getStatus();
}

export { ROUTER_PORT, ROUTER_API_KEY, ROUTER_MODEL, isRouterMiddlewarePatched, patchRouterDashboardGuard, patchRouterMiddleware, routerPackageMetadata };
