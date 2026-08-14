import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { config, defaultPath, shellBin } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOME = process.env.HOME || process.env.USERPROFILE || (process.getuid?.() === 0 ? '/root' : '/tmp');
const ROUTER_HOME = process.env.WORKER_AGENTS_9ROUTER_DIR || path.join(DEFAULT_HOME, '9router');
const ROUTER_NPM_PACKAGE = process.env.WORKER_AGENTS_9ROUTER_NPM_PACKAGE || '9router-vibefin';
const ROUTER_LOG_PATH = '/tmp/9router.log';
const ROUTER_PORT = Number.parseInt(process.env.WORKER_AGENTS_9ROUTER_PORT || '20128', 10);
const ROUTER_API_KEY = process.env.WORKER_AGENTS_9ROUTER_API_KEY || 'local-dev-key';
const ROUTER_MODEL = process.env.WORKER_AGENTS_9ROUTER_MODEL || 'opencode/big-pickle';
const OPEN_ACCESS_PATCH_MARK = 'sshworker: open remote LLM API access when requireApiKey=false';
const OPEN_ACCESS_PATCH_SCRIPT = path.join(__dirname, '..', 'scripts', 'patch-9router-dashboard-guard.mjs');
const HEALTH_TIMEOUT_MS = Number.parseInt(process.env.ROUTER_HEALTH_TIMEOUT_MS || '120000', 10);
const HEALTH_POLL_MS = 2000;
const OPEN_ACCESS_RETRY_MS = Number.parseInt(process.env.ROUTER_OPEN_ACCESS_RETRY_MS || '600000', 10);
const OPEN_ACCESS_RETRY_STEP_MS = 10000;
let startupPromise = null;
let startupState = 'idle';
let startupError = '';
let openAccessLoopRunning = false;


function nextBuildArtifacts() {
  return [
    path.join(ROUTER_HOME, '.next', 'BUILD_ID'),
    path.join(ROUTER_HOME, '.next', 'routes-manifest.json'),
    path.join(ROUTER_HOME, '.next', 'prerender-manifest.json'),
  ];
}

function hasCompleteRouterBuild() {
  return nextBuildArtifacts().every((file) => fs.existsSync(file));
}

function clearRouterBuildOutput() {
  fs.rmSync(path.join(ROUTER_HOME, '.next'), { recursive: true, force: true });
}

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

function execPowerShellStrict(command) {
  return execSync(`powershell.exe -NoProfile -Command ${JSON.stringify(command)}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 600000,
    env: { ...process.env, PATH: defaultPath }
  });
}

function findRouterPackagePath() {
  const candidates = [
    ...npmGlobalPackageCandidates(),
    path.join(DEFAULT_HOME, '.local', 'lib', 'node_modules', ROUTER_NPM_PACKAGE),
    path.join('/usr/local/lib/node_modules', ROUTER_NPM_PACKAGE),
    path.join('/usr/lib/node_modules', ROUTER_NPM_PACKAGE),
    ROUTER_HOME,
    process.env.HOME ? path.join(process.env.HOME, '9router') : '',
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '9router') : '',
    '/root/9router',
    path.join('/tmp', '9router'),
  ].filter(Boolean);
  const packagePath = candidates
    .map((candidate) => (candidate.endsWith('package.json') ? candidate : path.join(candidate, 'package.json')))
    .find((candidate) => fs.existsSync(candidate));
  if (!packagePath) {
    throw new Error(`${ROUTER_NPM_PACKAGE} package.json not found; checked npm global, hosted toolcache, nvm, Cellar, HOME, /root, /tmp`);
  }
  return packagePath;
}

function npmGlobalPackageCandidates() {
  const roots = new Set();
  const npmRoot = execText('npm root -g 2>/dev/null').trim();
  if (npmRoot) roots.add(npmRoot);
  if (process.env.NPM_CONFIG_PREFIX) {
    roots.add(path.join(process.env.NPM_CONFIG_PREFIX, 'lib', 'node_modules'));
  }
  const execDir = path.dirname(process.execPath);
  for (const rel of [
    path.join('..', 'lib', 'node_modules'),
    path.join('..', '..', 'lib', 'node_modules'),
  ]) {
    roots.add(path.resolve(execDir, rel));
  }
  for (const root of ['/opt/hostedtoolcache/node', '/usr/local/share/nvm/versions/node', '/usr/local/Cellar/node']) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      for (const lib of ['x64/lib/node_modules', 'lib/node_modules']) {
        roots.add(path.join(root, entry.name, lib));
      }
    }
  }
  return [...roots].map((root) => path.join(root, ROUTER_NPM_PACKAGE, 'package.json'));
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
  return null;
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

async function ensureNpmInstalled(log) {
  try {
    findRouterPackagePath();
    return false;
  } catch {
    // Install below.
  }
  if (log) log(`[9router] Installing ${ROUTER_NPM_PACKAGE} from npm...`);
  if (process.platform === 'win32') {
    execPowerShellStrict(`$ErrorActionPreference = "Stop"; npm i -g ${ROUTER_NPM_PACKAGE}@latest --prefer-online`);
  } else {
    execSync(`npm i -g ${ROUTER_NPM_PACKAGE}@latest --prefer-online`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000, env: { ...process.env, PATH: defaultPath } });
  }
  findRouterPackagePath();
  if (log) log('[9router] npm install complete');
  return true;
}

function patchRouterDashboardGuard(log) {
  const guardCandidates = [
    path.join(ROUTER_HOME, 'src', 'dashboardGuard.js'),
    path.join(ROUTER_HOME, 'app', 'dashboardGuard.js'),
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
  const roots = new Set([ROUTER_HOME]);
  for (const pkgJson of npmGlobalPackageCandidates()) {
    roots.add(path.dirname(pkgJson));
  }
  const relativePaths = [
    path.join('app', '.next-cli-build', 'server', 'middleware.js'),
    path.join('.next', 'server', 'middleware.js'),
  ];
  const candidates = [];
  for (const root of roots) {
    for (const relative of relativePaths) {
      candidates.push(path.join(root, relative));
    }
  }
  return candidates;
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

function resolveRouterLaunch() {
  const standaloneDir = path.join(ROUTER_HOME, '.next', 'standalone');
  const standaloneServer = path.join(standaloneDir, 'server.js');
  if (fs.existsSync(standaloneServer)) {
    return { mode: 'standalone', cwd: standaloneDir, args: ['server.js'] };
  }
  if (hasCompleteRouterBuild()) {
    return {
      mode: 'next-start',
      cwd: ROUTER_HOME,
      args: [
        path.join(ROUTER_HOME, 'node_modules', 'next', 'dist', 'bin', 'next'),
        'start',
        '--port',
        String(ROUTER_PORT),
        '--hostname',
        '127.0.0.1'
      ]
    };
  }
  throw new Error('9Router build output missing: no standalone server.js and no complete .next build');
}

function launchWindowsStandalone(logFd) {
  const launch = resolveRouterLaunch();
  const standaloneDir = path.join(ROUTER_HOME, '.next', 'standalone');
  const staticSrc = path.join(ROUTER_HOME, '.next', 'static');
  const staticDst = path.join(standaloneDir, '.next', 'static');
  const publicSrc = path.join(ROUTER_HOME, 'public');
  const publicDst = path.join(standaloneDir, 'public');
  const dataDir = path.join(process.env.HOME || process.env.USERPROFILE || 'C:\\Users\\Public', '.9router', 'data');
  if (launch.mode === 'standalone') {
    fs.mkdirSync(path.dirname(staticDst), { recursive: true });
    fs.rmSync(staticDst, { recursive: true, force: true });
    fs.rmSync(publicDst, { recursive: true, force: true });
    if (fs.existsSync(staticSrc)) fs.cpSync(staticSrc, staticDst, { recursive: true });
    if (fs.existsSync(publicSrc)) fs.cpSync(publicSrc, publicDst, { recursive: true });
  }
  fs.mkdirSync(dataDir, { recursive: true });
  return spawn('C:\\Program Files\\nodejs\\node.exe', launch.args, {
    cwd: launch.cwd,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      PATH: defaultPath,
      NODE_ENV: 'production',
      PORT: String(ROUTER_PORT),
      HOSTNAME: '127.0.0.1',
      NEXT_PUBLIC_BASE_URL: `http://127.0.0.1:${ROUTER_PORT}`,
      BASE_URL: `http://127.0.0.1:${ROUTER_PORT}`,
      DATA_DIR: dataDir
    }
  });
}

function prepareStandalone() {
  const standaloneDir = path.join(ROUTER_HOME, '.next', 'standalone');
  const staticSrc = path.join(ROUTER_HOME, '.next', 'static');
  const staticDst = path.join(standaloneDir, '.next', 'static');
  const publicSrc = path.join(ROUTER_HOME, 'public');
  const publicDst = path.join(standaloneDir, 'public');
  execText(`rm -rf "${staticDst}" "${publicDst}"`);
  if (fs.existsSync(staticSrc)) execText(`cp -R "${staticSrc}" "${staticDst}"`);
  if (fs.existsSync(publicSrc)) execText(`cp -R "${publicSrc}" "${publicDst}"`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function buildLaunchCommand(port = ROUTER_PORT) {
  const dataDir = path.join(process.env.HOME || '/tmp', '.9router', 'data');
  const installedPackage = [
    path.join(DEFAULT_HOME, '.local', 'lib', 'node_modules', ROUTER_NPM_PACKAGE, 'app', 'server.js'),
    path.join('/usr/local/lib/node_modules', ROUTER_NPM_PACKAGE, 'app', 'server.js'),
    path.join('/usr/lib/node_modules', ROUTER_NPM_PACKAGE, 'app', 'server.js'),
  ].find((p) => fs.existsSync(p));
  const serverJsPath = installedPackage || path.join(ROUTER_HOME, '.next', 'standalone', 'server.js');
  const workingDir = path.dirname(serverJsPath);
  return [
    `export PATH=${shellQuote(defaultPath)}`,
    'export NODE_ENV=production',
    `export PORT=${port}`,
    'export HOSTNAME=127.0.0.1',
    `export NEXT_PUBLIC_BASE_URL=http://127.0.0.1:${port}`,
    `export BASE_URL=http://127.0.0.1:${port}`,
    `export DATA_DIR=${shellQuote(dataDir)}`,
    'mkdir -p "$DATA_DIR"',
    `cd ${shellQuote(workingDir)}`,
    `exec node ${shellQuote(serverJsPath)}`,
  ].join('; ');
}

function buildBootstrapCommand(port = ROUTER_PORT) {
  if (process.platform === 'win32') {
    return buildBootstrapPowerShellCommand(port);
  }
  const standaloneDir = path.join(ROUTER_HOME, '.next', 'standalone');
  const staticSrc = path.join(ROUTER_HOME, '.next', 'static');
  const staticDst = path.join(standaloneDir, '.next', 'static');
  const publicSrc = path.join(ROUTER_HOME, 'public');
  const publicDst = path.join(standaloneDir, 'public');
  const dataDir = path.join(process.env.HOME || '/tmp', '.9router', 'data');
  return [
    'set -e',
    `export PATH=${shellQuote(defaultPath)}`,
    `ROUTER_PORT=${shellQuote(port)}`,
    `PATCH_SCRIPT=${shellQuote(OPEN_ACCESS_PATCH_SCRIPT)}`,
    `DATA_DIR=${shellQuote(dataDir)}`,
    `STANDALONE_DIR=${shellQuote(standaloneDir)}`,
    `STATIC_SRC=${shellQuote(staticSrc)}`,
    `STATIC_DST=${shellQuote(staticDst)}`,
    `PUBLIC_SRC=${shellQuote(publicSrc)}`,
    `PUBLIC_DST=${shellQuote(publicDst)}`,
    `if ! command -v 9router >/dev/null 2>&1; then npm i -g ${ROUTER_NPM_PACKAGE}@latest --prefer-online; fi`,
    'if command -v 9router >/dev/null 2>&1; then',
    `  NPM_ROUTER_HOME="$(npm root -g 2>/dev/null)/${ROUTER_NPM_PACKAGE}"`,
    '  if [ -d "$NPM_ROUTER_HOME" ]; then node "$PATCH_SCRIPT" "$NPM_ROUTER_HOME" || echo "[9router] npm 9router open-access patch skipped"; fi',
    `  ROUTER_SERVER="$(npm root -g 2>/dev/null)/${ROUTER_NPM_PACKAGE}/app/server.js"`,
    '  if [ ! -f "$ROUTER_SERVER" ]; then ROUTER_SERVER="$STANDALONE_DIR/server.js"; fi',
    'else',
    '  ROUTER_SERVER="$STANDALONE_DIR/server.js"',
    'fi',
    'export NODE_ENV=production',
    `export PORT=${port}`,
    'export HOSTNAME=127.0.0.1',
    `export NEXT_PUBLIC_BASE_URL=http://127.0.0.1:${port}`,
    `export BASE_URL=http://127.0.0.1:${port}`,
    'export DATA_DIR=$DATA_DIR',
    'mkdir -p "$DATA_DIR"',
    'cd "$(dirname "$ROUTER_SERVER")"',
    'exec node "$ROUTER_SERVER"',
  ].join('\n');
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildBootstrapPowerShellCommand(port = ROUTER_PORT) {
  const standaloneDir = path.join(ROUTER_HOME, '.next', 'standalone');
  const staticSrc = path.join(ROUTER_HOME, '.next', 'static');
  const staticDst = path.join(standaloneDir, '.next', 'static');
  const publicSrc = path.join(ROUTER_HOME, 'public');
  const publicDst = path.join(standaloneDir, 'public');
  const dataDir = path.join(process.env.HOME || process.env.USERPROFILE || 'C:\\Users\\Public', '.9router', 'data');
  const runtimeLogPath = path.join(process.env.TEMP || 'C:\\tmp', '9router.log');
  return [
    '$ErrorActionPreference = "Stop"',
    `$env:PATH = ${psQuote(defaultPath)}`,
    `$standaloneDir = ${psQuote(standaloneDir)}`,
    `$staticSrc = ${psQuote(staticSrc)}`,
    `$staticDst = ${psQuote(staticDst)}`,
    `$publicSrc = ${psQuote(publicSrc)}`,
    `$publicDst = ${psQuote(publicDst)}`,
    `$dataDir = ${psQuote(dataDir)}`,
    `if (-not (Get-Command 9router -ErrorAction SilentlyContinue)) { npm i -g ${ROUTER_NPM_PACKAGE}@latest --prefer-online }`,
    'New-Item -ItemType Directory -Force -Path (Split-Path $staticDst) | Out-Null',
    'if (Test-Path $staticDst) { Remove-Item -Recurse -Force $staticDst }',
    'if (Test-Path $publicDst) { Remove-Item -Recurse -Force $publicDst }',
    'if (Test-Path $staticSrc) { Copy-Item -Recurse -Force $staticSrc $staticDst }',
    'if (Test-Path $publicSrc) { Copy-Item -Recurse -Force $publicSrc $publicDst }',
    '$env:NODE_ENV = "production"',
    `$env:PORT = ${psQuote(String(port))}`,
    '$env:HOSTNAME = "127.0.0.1"',
    `$env:NEXT_PUBLIC_BASE_URL = ${psQuote(`http://127.0.0.1:${port}`)}`,
    `$env:BASE_URL = ${psQuote(`http://127.0.0.1:${port}`)}`,
    '$env:DATA_DIR = $dataDir',
    'New-Item -ItemType Directory -Force -Path $env:DATA_DIR | Out-Null',
    `$runtimeLogPath = ${psQuote(runtimeLogPath)}`,
    '$nodeExe = (Get-Command node).Source',
    'Start-Process -FilePath $nodeExe -WorkingDirectory $standaloneDir -ArgumentList \'server.js\' -RedirectStandardOutput $runtimeLogPath -RedirectStandardError $runtimeLogPath',
  ].join('\n');
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

async function waitForHealth(timeoutMs = HEALTH_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const ok = await new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${ROUTER_PORT}/api/health`, (res) => {
          res.resume();
          resolve((res.statusCode || 500) < 400);
        });
        req.setTimeout(5000, () => {
          req.destroy();
          resolve(false);
        });
        req.on('error', () => resolve(false));
      });
      if (ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  return false;
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
  const routerPackagePath = findRouterPackagePath();
  const settingsScript = `
const { createRequire } = require('node:module');
const requireFromRouter = createRequire(process.argv[1]);
const Database = requireFromRouter('better-sqlite3');
const db = new Database(process.argv[2]);
db.pragma('busy_timeout = 10000');
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
if (verifiedData.requireLogin !== false) {
  throw new Error('9Router requireLogin setting did not persist');
}
if (verifiedData.requireApiKey !== false) {
  throw new Error('9Router requireApiKey setting did not persist');
}
db.close();
process.stdout.write(changed ? 'changed' : 'unchanged');
`;
  const result = execFileSync(process.execPath, [
    '-e',
    settingsScript,
    routerPackagePath,
    dbPath,
  ], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, PATH: defaultPath },
  }).trim();
  return result === 'changed';
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
    startupState = 'running';
    startupError = '';
    patchRouterMiddleware(log);
    ensureOpenAccessSettings(log);
    return getStatus();
  }
  if (startupPromise) return getStatus();
  startupError = '';
  startupState = 'installing';
  startupPromise = new Promise((resolve, reject) => {
    setTimeout(async () => {
      try {
        killExistingListeners();
        const logFd = fs.openSync(ROUTER_LOG_PATH, 'w');
        let child;
        if (process.platform === 'win32') {
          if (log) log(`[9router] Preparing Windows bootstrap on port ${ROUTER_PORT}...`);
          await ensureNpmInstalled(log);
          child = launchWindowsStandalone(logFd);
        } else {
          if (log) log(`[9router] Starting background bootstrap on port ${ROUTER_PORT}...`);
          const cmd = buildBootstrapCommand();
          child = spawn(shellBin, ['-lc', cmd], {
            detached: true,
            stdio: ['ignore', logFd, logFd],
            env: { ...process.env, PATH: defaultPath },
          });
        }
        child.unref();
        fs.closeSync(logFd);
        startupState = 'starting';
        if (log) log(`[9router] Bootstrap process started (pid ${child.pid})`);
        const healthy = await waitForHealth();
        if (healthy) {
          startupState = 'running';
          if (log) log(`[9router] Health check passed on port ${ROUTER_PORT}`);
          ensureOpenAccessSettings(log);
          writeHermesConfig();
        } else {
          startupState = 'error';
          startupError = `9Router health check failed after ${HEALTH_TIMEOUT_MS / 1000}s.`;
          if (log) log(`[9router] Health check failed after ${HEALTH_TIMEOUT_MS / 1000}s`);
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
  return getStatus();
}

export function getStatus() {
  const listenerPid = findListenerForPort(ROUTER_PORT);
  const running = Boolean(listenerPid);
  if (running) {
    startupState = 'running';
    startupError = '';
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
    : startupState === 'installing'
      ? 'installing'
      : startupState === 'starting'
        ? 'starting'
        : startupState === 'stopped'
          ? 'stopped'
          : 'error';
  const error = running
    ? ''
    : (startupError || (state === 'installing'
      ? '9Router is preparing its local checkout and build.'
      : state === 'starting'
        ? '9Router is starting in the background.'
        : state === 'stopped'
          ? ''
          : `9Router is not listening on port ${ROUTER_PORT}.`));
  return {
    configuredPort: ROUTER_PORT,
    livePort: running ? ROUTER_PORT : null,
    state,
    error,
    pid,
    logs,
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
  startupPromise = null;
  startupState = 'idle';
  startupError = '';
  killExistingListeners();
  return start(log);
}

export async function stop(log) {
  startupPromise = null;
  startupState = 'stopped';
  startupError = '';
  const pid = killExistingListeners();
  if (log) {
    if (pid) log(`[9router] Stopped pid ${pid}`);
    else log('[9router] Already stopped');
  }
  return getStatus();
}

export { ROUTER_PORT, ROUTER_API_KEY, ROUTER_MODEL, patchRouterDashboardGuard, patchRouterMiddleware };
