import EventEmitter from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { config, defaultPath, nowIso, shellBin } from './config.js';
import { importCodexAuthForHermes, refreshTokenIfNeeded } from './auth.js';
import { reconcileRules } from './rules.js';

const ANSI_ESCAPE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const browserHost = process.env.AGENT_BROWSER_HOST || '127.0.0.1';

function stripAnsi(line) {
  return String(line).replace(ANSI_ESCAPE, '');
}

function injectRulesAfterInstall(adapterId, log) {
  const report = reconcileRules(adapterId).adapters.find((item) => item.id === adapterId);
  if (!report) return;
  if (report.error) log(`[rules] ${adapterId}: ${report.error}`);
  else if (report.injected) log(`[rules] ${adapterId}: injected ${report.targetPath}`);
  else if (report.skipped) log(`[rules] ${adapterId}: skipped (${report.reason})`);
}

function agentLogFileFor(agentId) {
  const template = process.env.AGENT_CONSOLE_AGENT_LOG;
  if (template) {
    return template.includes('{agentId}')
      ? template.replaceAll('{agentId}', agentId)
      : template;
  }
  return `/tmp/agent-console-agent-${agentId}.log`;
}

function commandFromEnv(envName, fallback) {
  return process.env[envName] || fallback;
}

function sh(command, options = {}) {
  const { shell = shellBin, shellArgs, env, ...rest } = options;
  const args = shellArgs || (shell.toLowerCase().includes('powershell')
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command]
    : shell.toLowerCase().includes('cmd.exe') || shell.toLowerCase().endsWith('\\cmd')
      ? ['/d', '/s', '/c', command]
    : ['-lc', command]);
  return spawn(shell, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: defaultPath, ...(env || {}) },
    ...rest
  });
}

async function runCommand(command, options = {}) {
  const { onData, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = sh(command, spawnOptions);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8'); stdout += s; if (onData) onData(s); });
    child.stderr?.on('data', (chunk) => { const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8'); stderr += s; if (onData) onData(s); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error((stderr || stdout || `command exited ${code}`).trim()));
      }
    });
  });
}

function commandExists(command) {
  try {
    const check = JSON.stringify(`command -v ${command}`);
    execSync(`${shellBin} -lc ${check}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, PATH: defaultPath } });
    return true;
  } catch {
    return false;
  }
}

function applyPortTemplate(template, port) {
  return template.replaceAll('{port}', String(port));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function macWebVncPasswordPath() {
  return process.env.WEB_VNC_PASSWORD_FILE || path.join(os.homedir(), '.worker-agents', 'web-vnc-password');
}

function macWebVncPassword() {
  const configured = process.env.WEB_VNC_PASSWORD?.trim();
  const passwordPath = macWebVncPasswordPath();
  let password = configured;

  if (!password && fs.existsSync(passwordPath)) {
    password = fs.readFileSync(passwordPath, 'utf8').trim();
  }
  if (!password) {
    // Apple Remote Desktop's legacy RFB password is limited to eight bytes.
    password = crypto.randomBytes(4).toString('hex');
    fs.mkdirSync(path.dirname(passwordPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(passwordPath, `${password}\n`, { mode: 0o600 });
  }
  if (Buffer.byteLength(password, 'utf8') > 8) {
    throw new Error('WEB_VNC_PASSWORD must be eight bytes or fewer for macOS Screen Sharing.');
  }
  return password;
}

function configureMacNoVncForLegacyPassword(dir) {
  const rfbPath = path.join(dir, 'core', 'rfb.js');
  if (!fs.existsSync(rfbPath)) {
    throw new Error(`noVNC is incomplete: ${rfbPath} is missing.`);
  }
  const source = fs.readFileSync(rfbPath, 'utf8');
  const original = '            securityTypeARD,\n';
  const replacement = '            // Apple advertises ARD before legacy VNC, but this worker uses the VNC password.\n';
  if (source.includes(original)) {
    fs.writeFileSync(rfbPath, source.replace(original, replacement), 'utf8');
  }
}


function windowsCodexCommand() {
  if (process.platform !== 'win32') return '';
  const prefix = process.env.npm_config_prefix || 'C:\\npm\\prefix';
  const candidate = path.join(prefix, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  return fs.existsSync(candidate) ? candidate : '';
}

function windowsAgentShell(command = '') {
  if (process.platform !== 'win32') return shellBin;
  const normalized = String(command).trim().toLowerCase();
  if (normalized.startsWith('powershell ') || normalized.startsWith('powershell.exe ')) return 'powershell.exe';
  return 'cmd.exe';
}

function windowsHermesAgentDir() {
  if (process.platform !== 'win32') return '';
  const base = process.env.LOCALAPPDATA || os.homedir();
  if (!base) return '';
  return process.env.HERMES_AGENT_DIR || path.join(base, 'hermes-agent');
}

function windowsHermesExe() {
  const agentDir = windowsHermesAgentDir();
  return agentDir ? path.join(agentDir, 'venv', 'Scripts', 'hermes.exe') : '';
}

function windowsHermesPython() {
  const agentDir = windowsHermesAgentDir();
  return agentDir ? path.join(agentDir, 'venv', 'Scripts', 'python.exe') : '';
}

function psSingleQuote(value) {
  return String(value).replaceAll("'", "''");
}

function routerPort() {
  const value = Number.parseInt(process.env.WORKER_AGENTS_9ROUTER_PORT || '20128', 10);
  return Number.isFinite(value) ? value : 20128;
}

function routerBaseUrl() {
  return `http://127.0.0.1:${routerPort()}/v1`;
}

function routerApiKey() {
  return process.env.WORKER_AGENTS_9ROUTER_API_KEY || 'local-dev-key';
}

function routerDefaultModel() {
  return process.env.WORKER_AGENTS_9ROUTER_MODEL || 'opencode/big-pickle';
}

let liveRouterModels = null;

function deepSeekHarnessModel() {
  return process.env.DEEPSEEK_HARNESS_MODEL || 'oc/deepseek-v4-flash-free';
}

function deepSeekHarnessDir() {
  return process.env.DEEPSEEK_HARNESS_DIR || path.join(os.homedir(), 'deepseek-harness');
}

function deepSeekHarnessPublicHost(port) {
  const advertised = process.env.AGENT_CONSOLE_PUBLIC_URL
    || process.env.WORKER_AGENTS_URL
    || readWorkerAgentsPublicUrl();
  try {
    const url = new URL(advertised);
    const suffix = '.agentsweb.space';
    if (!url.hostname.endsWith(suffix)) return '';
    const base = url.hostname.slice(0, -suffix.length).replace(/-\d+$/, '');
    return `${base}-${port}${suffix}`;
  } catch {
    return '';
  }
}

async function discoverDeepSeekHarnessModels(log) {
  const response = await fetch(`${routerBaseUrl()}/models`);
  if (!response.ok) throw new Error(`9Router /v1/models returned HTTP ${response.status}`);
  const payload = await response.json();
  const models = (Array.isArray(payload) ? payload : payload?.data)
    ?.map((model) => typeof model === 'string' ? model : model?.id)
    ?.filter((model) => typeof model === 'string' && model.trim())
    ?.map((model) => model.trim());
  if (!models?.length) throw new Error('9Router /v1/models returned no models');
  const uniqueModels = [...new Set(models)];
  log(`[deepseek-harness] discovered ${uniqueModels.length} live 9Router models`);
  return uniqueModels;
}

async function discoverRouterModels(log) {
  if (liveRouterModels?.length) return liveRouterModels;
  liveRouterModels = await discoverDeepSeekHarnessModels(log);
  return liveRouterModels;
}

function openCodeConfig(models = liveRouterModels || [routerDefaultModel()]) {
  const providerId = '9router';
  const selectedModel = openCodeSelectedModel(models);
  return JSON.stringify({
    '$schema': 'https://opencode.ai/config.json',
    disabled_providers: ['openai'],
    model: `${providerId}/${selectedModel}`,
    provider: {
      [providerId]: {
        npm: '@ai-sdk/openai-compatible',
        name: '9Router',
        options: {
          baseURL: routerBaseUrl(),
          apiKey: routerApiKey()
        },
        models: Object.fromEntries(models.map((model) => {
          const normalized = normalizeOpenCodeModel(model);
          return [normalized, { name: normalized }];
        }))
      }
    }
  });
}

function ensureOpenCodeConfig(models = liveRouterModels || [routerDefaultModel()]) {
  const configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
  const configPath = path.join(configDir, 'opencode.json');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, `${openCodeConfig(models)}\n`, { mode: 0o600 });
  return configPath;
}

function openCodeSelectedModel(models = liveRouterModels || [routerDefaultModel()]) {
  const preferred = models.includes(routerDefaultModel()) ? routerDefaultModel() : models[0];
  return normalizeOpenCodeModel(preferred);
}

function normalizeOpenCodeModel(model) {
  return String(model || '').replace(/^(?:opencode|oc)\//, '');
}

async function ensureDeepSeekHarnessSettings(log) {
  const models = await discoverRouterModels(log);
  const preferredModel = deepSeekHarnessModel();
  const selectedModel = models.includes(preferredModel) ? preferredModel : models[0];
  const settingsPath = path.join(os.homedir(), '.dsh', 'settings.yaml');
  const next = [
    'llm-pi-ai:',
    '  providers:',
    '    nine-router:',
    '      displayName: 9Router',
    '      apiKeyEnv: NINE_ROUTER_API_KEY',
    '      api: openai-completions',
    `      baseURL: ${routerBaseUrl()}`,
    '      models:',
    ...models.flatMap((model) => [`        - id: ${model}`, `          name: ${model} via 9Router`]),
    'agent-default-model:',
    '  provider: nine-router',
    `  model: ${selectedModel}`,
    ''
  ].join('\n');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, next, { mode: 0o600 });
  return settingsPath;
}

async function ensureDeepSeekHarnessInstalled(log) {
  const dir = deepSeekHarnessDir();
  const pnpm = 'npx --yes pnpm@9';
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    await runCommand(`export PATH=/usr/local/bin:$PATH && rm -rf ${shellQuote(dir)} && git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git ${shellQuote(dir)}`, { onData: log });
  }
  const trustSource = path.join(dir, 'packages/client/connection/src/index.ts');
  if (fs.existsSync(trustSource)) {
    const source = fs.readFileSync(trustSource, 'utf8');
    const oldGuard = '!isTrustedApiRequest(request, [])';
    if (source.includes(oldGuard)) {
      fs.writeFileSync(trustSource, source.replace(oldGuard, '!isTrustedApiRequest(request, trustedHosts)'));
      log('[deepseek-harness] patched privileged API trust to use trustedHosts');
    }
  }
  const buildMarker = path.join(dir, '.worker-agents-built');
  if (!fs.existsSync(buildMarker)) {
    await runCommand(`export PATH=/usr/local/bin:$PATH && cd ${shellQuote(dir)} && ${pnpm} install --no-frozen-lockfile && ${pnpm} build`, { onData: log });
    fs.writeFileSync(buildMarker, `${new Date().toISOString()}\n`);
  }
  await ensureDeepSeekHarnessSettings(log);
  return dir;
}

function defaultDeepSeekHarnessCommand(port) {
  const dir = deepSeekHarnessDir();
  const trustedHost = deepSeekHarnessPublicHost(port);
  if (!trustedHost) throw new Error('DeepSeek Harness requires the Worker Agents public agentsweb hostname');
  return `export PATH=/usr/local/bin:$PATH && cd ${shellQuote(dir)} && exec npx --yes pnpm@9 dsh web --host 127.0.0.1 --port ${port} --trusted-host ${shellQuote(trustedHost)}`;
}

function ensureHermesRouterConfig(port = routerPort()) {
  const hermesConfigPath = path.join(config.hermesHome, 'config.yaml');
  const next = [
    'model:',
    '  provider: custom',
    `  default: ${routerDefaultModel()}`,
    `  base_url: http://127.0.0.1:${port}/v1`,
    `  api_key: ${routerApiKey()}`,
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(hermesConfigPath), { recursive: true });
  fs.writeFileSync(hermesConfigPath, next, { mode: 0o600 });
  return hermesConfigPath;
}

async function ensureGlobalPackage(commandName, packageName, log) {
  if (commandExists(commandName)) return false;
  await runCommand(`npm install -g ${packageName}`, { onData: log });
  return true;
}

async function ensureHermesWebUiRepo(log) {
  const hermesWebUiDir = process.env.HERMES_WEBUI_DIR || path.join(os.homedir(), 'hermes-webui');
  const repo = process.env.HERMES_WEBUI_GIT_URL || 'https://github.com/nesquena/hermes-webui.git';
  if (fs.existsSync(path.join(hermesWebUiDir, 'bootstrap.py'))) return { changed: false, dir: hermesWebUiDir };
  await runCommand(`rm -rf "${hermesWebUiDir}" && git clone --depth 1 "${repo}" "${hermesWebUiDir}"`, { onData: log });
  return { changed: true, dir: hermesWebUiDir };
}

async function ensureHermesInstalled(port, log) {
  const { changed, dir } = await ensureHermesWebUiRepo(log);
  const hasBootstrap = fs.existsSync(path.join(dir, 'bootstrap.py'));
  if (process.platform === 'win32') {
    const hermesExe = windowsHermesExe();
    if (hermesExe && fs.existsSync(hermesExe) && fs.existsSync(path.join(dir, 'start.ps1'))) {
      return changed;
    }
    const installScript = path.join(os.tmpdir(), 'install-hermes-agent.ps1');
    const installDir = windowsHermesAgentDir();
    await runCommand(
      [
        '$ProgressPreference = "SilentlyContinue"',
        '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
        `$scriptPath = '${psSingleQuote(installScript)}'`,
        `Invoke-WebRequest -UseBasicParsing -Uri 'https://hermes-agent.nousresearch.com/install.ps1' -OutFile $scriptPath`,
        `& powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath -NonInteractive -SkipSetup -InstallDir '${psSingleQuote(installDir)}'`
      ].join('; '),
      { onData: log, shell: 'powershell.exe' }
    );
    return true;
  }
  if (commandExists('hermes') && (commandExists('hermes-webui') || hasBootstrap)) {
    return changed;
  }
  if (hasBootstrap) {
    try {
      await runCommand('curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup --skip-browser --non-interactive', { onData: log });
    } catch {
      // bootstrap.py from the cloned repo is still a viable fallback launch path
    }
    return true;
  }
  throw new Error('Hermes WebUI repo is missing bootstrap.py');
}

function defaultHermesWebUiCommand(port) {
  const hermesWebUiDir = process.env.HERMES_WEBUI_DIR || path.join(os.homedir(), 'hermes-webui');
  if (process.platform === 'win32' && fs.existsSync(path.join(hermesWebUiDir, 'start.ps1'))) {
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(hermesWebUiDir, 'start.ps1')}" -Port ${port} -BindHost 0.0.0.0`;
  }
  if (fs.existsSync(path.join(hermesWebUiDir, 'bootstrap.py'))) {
    return `${shellBin} -lc 'cd "${hermesWebUiDir}" && exec python3 bootstrap.py --skip-agent-install --no-browser --foreground --host 0.0.0.0 ${port}'`;
  }
  const webui = `exec /usr/local/bin/hermes-webui --skip-agent-install --no-browser --foreground --host 0.0.0.0 ${port}`;
  return [
    `${shellBin} -lc `,
    '\'',
    webui,
    '\''
  ].join('');
}

async function ensureHermesGatewayStarted(log) {
  if (process.platform === 'win32' || !['1', 'true', 'yes'].includes(String(process.env.HERMES_WEBUI_START_GATEWAY ?? '1').toLowerCase())) return;
  const command = [
    'gateway_bin="$(command -v hermes || true)"; ',
    'if [ -z "$gateway_bin" ]; then for candidate in "$HOME/.hermes/hermes-agent/venv/bin/hermes" "$HOME/.hermes/hermes-agent/hermes" "$HOME/.hermes/bin/hermes" "$HOME/.local/bin/hermes" "$HOME/.local/share/hermes/bin/hermes"; do if [ -x "$candidate" ]; then gateway_bin="$candidate"; break; fi; done; fi; ',
    'if [ -z "$gateway_bin" ]; then echo "Hermes gateway executable not found"; exit 1; fi; ',
    'gateway_log="${HERMES_WEBUI_GATEWAY_LOG:-${HERMES_HOME:-$HOME/.hermes}/gateway.log}"; mkdir -p "$(dirname "$gateway_log")"; ',
    'nohup "$gateway_bin" gateway run </dev/null >> "$gateway_log" 2>&1 &'
  ].join('');
  await runCommand(command, { onData: log });
  log('[hermes-webui] Hermes gateway launch requested');
}



function openWorkDir() {
  return process.env.OPENWORK_DIR || path.join(os.homedir(), 'openwork');
}

const OPENWORK_VITE_PATCH_MARK = 'sshworker: force esnext for Vite dep optimizer (esbuild 0.28.1)';

function patchOpenWorkViteConfig(log) {
  const configPath = path.join(openWorkDir(), 'apps', 'app', 'vite.config.ts');
  if (!fs.existsSync(configPath)) {
    if (log) log('[openwork] vite.config.ts not found, skipping esbuild optimizer patch');
    return false;
  }
  let source = fs.readFileSync(configPath, 'utf8');
  if (source.includes(OPENWORK_VITE_PATCH_MARK)) {
    if (log) log('[openwork] vite.config.ts already patched for esnext dep optimizer');
    return false;
  }
  const needle = '  server: {';
  if (!source.includes(needle)) {
    if (log) log('[openwork] vite.config.ts shape changed, skipping esbuild optimizer patch');
    return false;
  }
  const replacement = `  // ${OPENWORK_VITE_PATCH_MARK}
  optimizeDeps: {
    esbuildOptions: { target: "esnext" },
  },

  server: {`;
  fs.writeFileSync(configPath, source.replace(needle, replacement));
  if (log) log('[openwork] Patched vite.config.ts dep optimizer target to esnext');
  return true;
}

async function ensureOpenWorkRepo(log) {
  const dir = openWorkDir();
  const repo = process.env.OPENWORK_GIT_URL || 'https://github.com/different-ai/openwork.git';
  if (fs.existsSync(path.join(dir, 'package.json'))) return { changed: false, dir };
  await runCommand(`rm -rf "${dir}" && git clone --depth 1 "${repo}" "${dir}"`, { onData: log });
  return { changed: true, dir };
}

async function ensureOpenWorkInstalled(log) {
  await ensureGlobalPackage('pnpm', 'pnpm', log);
  await ensureGlobalPackage('bun', 'bun', log);
  await ensureGlobalPackage('opencode', 'opencode-ai', log);
  const { dir } = await ensureOpenWorkRepo(log);
  await runCommand(`cd "${dir}" && pnpm install --frozen-lockfile`, { onData: log });
  if (patchOpenWorkViteConfig(log)) {
    for (const cachePath of [
      path.join(dir, 'apps', 'app', 'node_modules', '.vite'),
      path.join(dir, 'node_modules', '.vite')
    ]) {
      fs.rmSync(cachePath, { recursive: true, force: true });
    }
  }
  return dir;
}


function openWorkPublicHost(port) {
  const explicit = process.env.OPENWORK_PUBLIC_HOST || process.env.VITE_ALLOWED_HOSTS || '';
  if (explicit) return explicit.split(',')[0].trim();
  const publicUrl = process.env.AGENT_CONSOLE_PUBLIC_URL || process.env.WORKER_AGENTS_URL || readWorkerAgentsPublicUrl();
  if (!publicUrl) return '';
  try {
    const hostname = new URL(publicUrl).hostname;
    if (port && hostname.endsWith('.agentsweb.space')) {
      return hostname.match(/-\d+\.agentsweb\.space$/)
        ? hostname.replace(/-\d+(\.agentsweb\.space)$/, `-${port}$1`)
        : `${hostname.replace(/\.agentsweb\.space$/, '')}-${port}.agentsweb.space`;
    }
    return hostname;
  } catch {
    return '';
  }
}

function defaultOpenWorkCommand(port) {
  const dir = openWorkDir();
  const serverPort = port + 1;
  return [
    `cd ${shellQuote(dir)} && `,
    `OPENWORK_REMOTE_ACCESS=1 OPENWORK_WEB_PORT=${port} OPENWORK_PORT=${serverPort} `,
      `OPENWORK_PUBLIC_HOST=${shellQuote(openWorkPublicHost(port))} VITE_ALLOWED_HOSTS=${shellQuote(openWorkPublicHost(port))} `,
    'OPENWORK_DEV_HEADLESS_WEB_AUTOBUILD=1 ',
    'exec pnpm dev:headless-web'
  ].join('');
}


function agentZeroDir() {
  return process.env.AGENT_ZERO_DIR || path.join(os.homedir(), 'agent-zero');
}

function agentZeroUsrDir() {
  return process.env.AGENT_ZERO_USR_DIR || path.join(os.homedir(), 'agent-zero-usr');
}

function agentZeroPython() {
  return path.join(agentZeroDir(), '.venv', 'bin', 'python');
}

function ensureAgentZeroConfig(apiBase = process.env.AGENT_ZERO_9ROUTER_BASE_URL || routerBaseUrl()) {
  const usrDir = agentZeroUsrDir();
  const pluginDir = path.join(usrDir, 'plugins', '_model_config');
  fs.mkdirSync(pluginDir, { recursive: true });
  const apiKey = routerApiKey();
  const model = routerDefaultModel();
  const presets = [
    '- name: Default',
    '  chat:',
    '    provider: openai',
    `    name: ${model}`,
    `    api_base: ${apiBase}`,
    '    ctx_length: 128000',
    '    ctx_history: 0.7',
    '    vision: false',
    '    kwargs: {}',
    '  utility:',
    '    provider: openai',
    `    name: ${model}`,
    `    api_base: ${apiBase}`,
    '    ctx_length: 128000',
    '    ctx_input: 0.7',
    '    kwargs: {}',
    '  embedding:',
    '    provider: huggingface',
    '    name: sentence-transformers/all-MiniLM-L6-v2',
    '    api_base: ""',
    '    kwargs: {}',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(pluginDir, 'presets.yaml'), presets, { mode: 0o600 });
  fs.mkdirSync(path.join(usrDir, 'workdir'), { recursive: true });
  return { usrDir, apiKey };
}

async function ensureAgentZeroRepo(log) {
  const dir = agentZeroDir();
  const repo = process.env.AGENT_ZERO_GIT_URL || 'https://github.com/agent0ai/agent-zero.git';
  if (fs.existsSync(path.join(dir, 'run_ui.py'))) return { changed: false, dir };
  await runCommand(`rm -rf "${dir}" && git clone --depth 1 "${repo}" "${dir}"`, { onData: log });
  return { changed: true, dir };
}

async function ensureAgentZeroInstalled(log) {
  const { dir } = await ensureAgentZeroRepo(log);
  const python = agentZeroPython();
  const marker = path.join(dir, '.venv', '.worker-agents-installed');
  if (!fs.existsSync(python)) {
    await runCommand(`cd "${dir}" && python3 -m venv .venv`, { onData: log });
  }
  if (!fs.existsSync(marker)) {
    const hasCoreDeps = fs.existsSync(python) && await runCommand(
      `cd "${dir}" && .venv/bin/python -c "import flask, litellm, uvicorn, sentence_transformers"`,
      { onData: log }
    ).then(() => true, () => false);
    if (!hasCoreDeps) {
      await runCommand(`cd "${dir}" && .venv/bin/python -m pip install --upgrade pip && .venv/bin/python -m pip install -r requirements.txt`, { onData: log });
    }
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  }
  ensureAgentZeroConfig();
  return dir;
}

function defaultAgentZeroCommand(port) {
  const dir = agentZeroDir();
  const { apiKey } = ensureAgentZeroConfig();
  return [
    `cd ${shellQuote(dir)} && `,
    `WEB_UI_HOST=127.0.0.1 WEB_UI_PORT=${port} `,
    `OPENAI_API_KEY=${shellQuote(apiKey)} `,
    `A0_SET_api_keys=${shellQuote(JSON.stringify({ openai: apiKey }))} `,
    'exec .venv/bin/python run_ui.py ',
    `--host=127.0.0.1 --port=${port}`
  ].join('');
}

function fileBrowserDir() {
  return path.join(config.projectRoot, 'filebrowser');
}

async function ensureFileBrowserInstalled(log) {
  const dir = fileBrowserDir();
  const packageJson = path.join(dir, 'package.json');
  if (!fs.existsSync(packageJson)) {
    throw new Error(`File Browser bundle is missing at ${dir}`);
  }
  const marker = path.join(dir, 'node_modules', '.worker-agents-installed');
  if (!fs.existsSync(marker)) {
    await runCommand(`cd "${dir}" && npm install`, { onData: log });
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  }
  return dir;
}

function defaultFileBrowserCommand(port) {
  const dir = fileBrowserDir();
  return [
    `cd ${shellQuote(dir)} && `,
    `PORT=${port} `,
    'exec node server.js'
  ].join('');
}

async function ensureWebVncInstalled(log) {
  if (process.platform === 'darwin') {
    const dir = process.env.WEB_VNC_NOVNC_DIR || path.join(os.homedir(), '.worker-agents', 'novnc');
    if (!fs.existsSync(path.join(dir, 'vnc.html'))) {
      await runCommand(`rm -rf ${shellQuote(dir)} && git clone --depth 1 https://github.com/novnc/noVNC.git ${shellQuote(dir)}`, { onData: log });
    }
    configureMacNoVncForLegacyPassword(dir);
    const hasWebsockify = await runCommand('python3 -c "import websockify"').then(() => true, () => false);
    if (!hasWebsockify) {
      await runCommand('python3 -m pip install --user --upgrade websockify', { onData: log });
    }
    const kickstart = '/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart';
    const password = macWebVncPassword();
    await runCommand(
      `sudo -n ${shellQuote(kickstart)} -activate -configure -access -on -users ${shellQuote(os.userInfo().username)} -privs -all -clientopts -setvnclegacy -vnclegacy yes -setvncpw -vncpw ${shellQuote(password)} -restart -agent -console && sudo -n launchctl kickstart -k system/com.apple.screensharing`,
      { onData: log }
    );
    const ready = await waitForPort(5900, 15000);
    if (!ready) throw new Error('macOS Screen Sharing did not start an RFB listener on port 5900.');
    return true;
  }
  if (process.platform !== 'linux') {
    throw new Error(`Web VNC is unsupported on ${process.platform}.`);
  }
  const required = ['Xvfb', 'fluxbox', 'x11vnc', 'websockify'];
  if (required.every(commandExists) && fs.existsSync('/usr/share/novnc/vnc.html')) return false;
  const installCommand = typeof process.getuid === 'function' && process.getuid() === 0
    ? 'apt-get update && env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb fluxbox x11vnc novnc websockify xterm dbus-x11'
    : 'sudo -n apt-get update && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb fluxbox x11vnc novnc websockify xterm dbus-x11';
  await runCommand(
    installCommand,
    { onData: log }
  );
  if (!fs.existsSync('/usr/share/novnc/vnc.html')) {
    throw new Error('noVNC installation completed but /usr/share/novnc/vnc.html is missing.');
  }
  return true;
}

async function reclaimWebVncPort(port, log) {
  // Worker Agents can be refreshed while Websockify is still alive from the
  // previous console process. Reclaim only the Web VNC listener, so the new
  // supervisor owns its process group and Start/Stop stays truthful.
  const command = process.platform === 'win32'
    ? `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`
    : `for pid in $(lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true); do ps -p "$pid" -o command= | grep -q '[w]ebsockify' && kill "$pid" || true; done`;
  await runCommand(command, { onData: log }).catch(() => {});
}

function defaultWebVncCommand(port) {
  const display = process.env.WEB_VNC_DISPLAY || ':99';
  const rfbPort = Number.parseInt(process.env.WEB_VNC_RFB_PORT || '15900', 10);
  return [
    `export DISPLAY=${shellQuote(display)}`,
    `Xvfb ${shellQuote(display)} -screen 0 1440x900x24 -ac -nolisten tcp &`,
    'xvfb_pid=$!',
    'cleanup() { kill "$xvfb_pid" "$fluxbox_pid" "$x11vnc_pid" 2>/dev/null || true; }',
    'trap cleanup EXIT INT TERM',
    'fluxbox >/tmp/worker-agents-web-vnc-fluxbox.log 2>&1 &',
    'fluxbox_pid=$!',
    'sleep 1',
    `x11vnc -display ${shellQuote(display)} -forever -shared -nopw -rfbport ${rfbPort} >/tmp/worker-agents-web-vnc-x11vnc.log 2>&1 &`,
    'x11vnc_pid=$!',
    'xterm -geometry 120x35+40+40 -title "Worker Terminal" >/tmp/worker-agents-web-vnc-xterm.log 2>&1 &',
    `for i in $(seq 1 15); do lsof -nP -iTCP:${rfbPort} -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 1; done; lsof -nP -iTCP:${rfbPort} -sTCP:LISTEN >/dev/null 2>&1 || { echo "x11vnc did not start on port ${rfbPort}"; exit 1; }`,
    `exec websockify --web=/usr/share/novnc ${port} 127.0.0.1:${rfbPort}`
  ].join('\n');
}

function defaultMacWebVncCommand(port) {
  const dir = process.env.WEB_VNC_NOVNC_DIR || path.join(os.homedir(), '.worker-agents', 'novnc');
  return `exec python3 -m websockify --web=${shellQuote(dir)} ${port} 127.0.0.1:5900`;
}

function normalizeReadyPatterns(patterns = []) {
  return patterns.map((pattern) => pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i'));
}

function loadCustomWorkerDefinitions() {
  const filePath = process.env.WORKER_AGENTS_CONFIG || path.join(config.projectRoot, 'workers.json');
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${filePath} must contain a JSON array`);
  return parsed.map((worker) => {
    if (!worker?.id || !worker?.command) throw new Error('Each worker needs id and command');
    const basePort = Number.parseInt(worker.basePort ?? worker.port ?? 19000, 10);
    return {
      id: String(worker.id),
      name: String(worker.name || worker.id),
      basePort: Number.isFinite(basePort) ? basePort : 19000,
      path: worker.path || '/',
      readyPath: worker.readyPath,
      command: (port) => applyPortTemplate(String(worker.command), port),
      readyPatterns: normalizeReadyPatterns(worker.readyPatterns || ['listening', 'http://127.0.0.1:', 'http://localhost:']),
      env: () => buildBaseEnv(worker.env || {})
    };
  });
}

function readOpenClawToken() {
  try {
    const configPath = path.join(config.openClawHome, 'openclaw.json');
    const json = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return json?.gateway?.auth?.token || '';
  } catch {
    return '';
  }
}

function readWorkerAgentsPublicUrl() {
  try {
    const statePath = path.join(os.homedir(), '.worker-agents', 'state.json');
    const json = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return String(json?.worker_agents_url || json?.url || '').trim();
  } catch {
    return '';
  }
}

function deriveOpenClawAllowedOrigins(port) {
  const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  // If AGENT_CONSOLE_PUBLIC_URL is set, derive the agentsweb origin from it
  const publicUrl = process.env.AGENT_CONSOLE_PUBLIC_URL || process.env.WORKER_AGENTS_URL || '';
  if (publicUrl) {
    try {
      const u = new URL(publicUrl);
      u.port = String(port);
      origins.push(u.origin);
    } catch {}
  }
  return origins;
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function ensureCodexWebUi9RouterConfig() {
  fs.mkdirSync(config.codexHome, { recursive: true });
  const statePath = path.join(config.codexHome, 'webui-custom-providers.json');
  const state = {
    enabled: true,
    provider: 'custom',
    model: routerDefaultModel(),
    customBaseUrl: routerBaseUrl(),
    apiKey: routerApiKey(),
    customKey: true,
    wireApi: 'responses',
    providerKeys: {}
  };
  writeJson(statePath, state);
}

function ensureOpenClawConfig(port = 18789, models = liveRouterModels || [routerDefaultModel()]) {
  const configPath = path.join(config.openClawHome, 'openclaw.json');
  const existing = (() => {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      return {};
    }
  })();

  const routerProviderId = '9router';
  const routerModel = models.includes(routerDefaultModel()) ? routerDefaultModel() : models[0];
  const routerQualifiedModel = `${routerProviderId}/${routerModel}`;
  existing.models ||= {};
  existing.models.mode ||= 'merge';
  existing.models.providers ||= {};
  existing.models.providers[routerProviderId] = {
    ...(existing.models.providers[routerProviderId] || {}),
    baseUrl: routerBaseUrl(),
    apiKey: routerApiKey(),
    api: 'openai-completions',
    authHeader: true,
    models: models.map((model) => ({
      id: model,
      name: model,
      api: 'openai-responses'
    }))
  };
  existing.agents ||= {};
  existing.agents.defaults ||= {};
  existing.agents.defaults.model = { primary: routerQualifiedModel };
  existing.agents.defaults.models = Object.fromEntries(
    models.map((model) => [`${routerProviderId}/${model}`, {}])
  );
  existing.gateway ||= {};
  existing.gateway.mode ||= 'local';
  existing.gateway.trustedProxies = Array.from(new Set([
    ...(Array.isArray(existing.gateway.trustedProxies) ? existing.gateway.trustedProxies : []),
    '127.0.0.1/32',
    '::1/128'
  ]));
  existing.gateway.auth ||= {};
  existing.gateway.auth.mode ||= 'token';
  existing.gateway.auth.token ||= cryptoToken();
  existing.gateway.controlUi ||= {};
  existing.gateway.controlUi.allowedOrigins = Array.from(new Set([
    ...(Array.isArray(existing.gateway.controlUi.allowedOrigins) ? existing.gateway.controlUi.allowedOrigins : []),
    ...deriveOpenClawAllowedOrigins(port)
  ]));
  existing.gateway.controlUi.allowInsecureAuth = true;
  existing.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
  existing.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback = true;
  existing.update ||= {};
  existing.update.checkOnStart = false;
  writeJson(configPath, existing);
}

async function ensureOpenClawBaseline(log) {
  const workspaceDir = path.join(config.openClawHome, 'workspace');
  const sessionsDir = path.join(config.openClawHome, 'agents', 'main', 'sessions');
  if (fs.existsSync(path.join(config.openClawHome, 'openclaw.json')) && fs.existsSync(workspaceDir) && fs.existsSync(sessionsDir)) {
    return false;
  }
  await runCommand(
    `openclaw setup --baseline --non-interactive --accept-risk --skip-channels --skip-skills --skip-ui --skip-health --workspace ${JSON.stringify(workspaceDir)}`, { onData: log }
  );
  return true;
}
function ensureOpenClawPatch() {
  const targetPath = openClawPatchPath();
  if (fs.existsSync(targetPath)) return;
  const content = [
    'const __req = typeof require === "function"',
    '  ? require',
    '  : ((globalThis.process && typeof globalThis.process.getBuiltinModule === "function")',
    '      ? (id) => globalThis.process.getBuiltinModule(id)',
    '      : null);',
    'const os = __req ? __req("os") : null;',
    'const _ni = os && typeof os.networkInterfaces === "function" ? os.networkInterfaces : null;',
    'if (_ni) {',
    '  os.networkInterfaces = function() {',
    '    try { return _ni.call(this); } catch(e) {',
    '      return {',
    '        lo: [{',
    '          address: "127.0.0.1",',
    '          netmask: "255.0.0.0",',
    '          family: "IPv4",',
    '          mac: "00:00:00:00:00:00",',
    '          internal: true,',
    '          cidr: "127.0.0.1/8"',
    '        }]',
    '      };',
    '    }',
    '  };',
    '}',
    ''
  ].join('\n');
  fs.writeFileSync(targetPath, content, { mode: 0o644 });
}

function openClawPatchPath() {
  return path.join(os.homedir(), '.openclaw-patch.js');
}

function cryptoToken() {
  return crypto.randomBytes(24).toString('hex');
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(basePort) {
  for (let offset = 0; offset < config.portScanRange; offset += 1) {
    const port = basePort + offset;
    if (await isPortFree(port)) return port;
  }
  return basePort;
}

async function waitForPort(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(750);
      socket.once('connect', () => {
        socket.end();
        resolve(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => resolve(false));
    });
    if (connected) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function waitForHttpReady(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.status < 500) return true;
    } catch {
      // Connection error — keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function isHttpReady(url) {
  let timeout;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    return res.status < 500;
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}


function buildBaseEnv(extra = {}) {
  return {
    ...process.env,
    HOME: os.homedir(),
    PATH: defaultPath,
    CODEX_HOME: config.codexHome,
    OPENCLAW_HOME: config.openClawHome,
    HERMES_HOME: config.hermesHome,
    NODE_PATH: '/usr/local/lib/node_modules',
    LANG: process.env.LANG || 'C.UTF-8',
    ...extra
  };
}

const builtInDefinitions = [
  {
    id: 'deepseek-harness',
    name: 'DeepSeek Harness',
    basePort: 3080,
    path: '/',
    command: (port) => applyPortTemplate(
      process.env.AGENT_CMD_DEEPSEEK_HARNESS || defaultDeepSeekHarnessCommand(port),
      port
    ),
    readyPatterns: [/http:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0):/i, /dsh web/i, /listening/i],
    beforeStart: async (_port, log) => {
      await ensureDeepSeekHarnessInstalled(log);
      injectRulesAfterInstall('deepseek', log);
    },
    env: () => buildBaseEnv({
      NINE_ROUTER_API_KEY: routerApiKey(),
      OPENAI_API_KEY: routerApiKey(),
      OPENAI_BASE_URL: routerBaseUrl(),
      PATH: `/usr/local/bin:${defaultPath}`
    })
  },
  {
    id: 'codex-web-local',
    name: 'Codex Web Local',
    basePort: 18923,
    path: '/',
    command: (port) => applyPortTemplate(
      commandFromEnv(
        'AGENT_CMD_CODEX_WEB_LOCAL',
        'codexapp --port {port} --no-password --no-tunnel'
      ),
      port
    ),
    readyPatterns: [/http:\/\/(localhost|127\.0\.0\.1):/i, /listening/i],
    beforeStart: async (_port, log) => {
      await refreshTokenIfNeeded();
      await ensureGlobalPackage('codexapp', 'codexapp', log);
      if (process.platform === 'win32') {
        await ensureGlobalPackage('codex', '@openai/codex', log);
      }
      await discoverRouterModels(log);
      ensureCodexWebUi9RouterConfig();
      ensureOpenClawPatch();
      injectRulesAfterInstall('codex', log);
    },
    env: () => buildBaseEnv({
      CUSTOM_ENDPOINT_API_KEY: routerApiKey(),
      CODEXUI_CODEX_COMMAND: process.env.CODEXUI_CODEX_COMMAND || windowsCodexCommand(),
      npm_config_prefix: process.env.npm_config_prefix || (process.platform === 'win32' ? 'C:\\npm\\prefix' : undefined),
      NODE_OPTIONS: process.platform === 'win32'
        ? ''
        : `--require ${openClawPatchPath()} --unhandled-rejections=warn`
    })
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    basePort: 18924,
    path: '/Lw/session',
    command: (port) => applyPortTemplate(
      commandFromEnv('AGENT_CMD_OPENCODE', 'opencode web --port {port} --hostname 127.0.0.1'),
      port
    ),
    readyPatterns: [/http:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0):/i, /listening/i],
    beforeStart: async (_port, log) => {
      await discoverRouterModels(log);
      await ensureGlobalPackage('opencode', 'opencode-ai', log);
      log(`[opencode] configured local 9Router provider at ${ensureOpenCodeConfig()}`);
      injectRulesAfterInstall('opencode', log);
    },
    env: () => buildBaseEnv({
      OPENCODE_CONFIG_CONTENT: openCodeConfig(),
      OPENCODE_MODEL: `9router/${openCodeSelectedModel()}`
    })
  },
  {
    id: 'hermes-webui',
    name: 'Hermes WebUI',
    basePort: 18935,
    path: '/',
    readyPath: '/health',
    command: (port) => applyPortTemplate(
      commandFromEnv(
        'AGENT_CMD_HERMES_WEBUI',
        defaultHermesWebUiCommand(port)
      ),
      port
    ),
    readyPatterns: [/\/health/i, /HTTP server/i, /http:\/\/(127\.0\.0\.1|0\.0\.0\.0):/i],
    beforeStart: async (_port, log) => {
      await refreshTokenIfNeeded();
      await discoverRouterModels(log);
      ensureHermesRouterConfig();
      await ensureHermesInstalled(18935, log);
      await ensureHermesGatewayStarted(log);
      importCodexAuthForHermes();
      injectRulesAfterInstall('hermes', log);
    },
    env: (port) => buildBaseEnv({
      HERMES_WEBUI_HOST: '0.0.0.0',
      HERMES_WEBUI_PORT: String(port),
      HERMES_WEBUI_SKIP_ONBOARDING: '1',
      HERMES_WEBUI_PRESERVE_ENV: '1',
      UV_LINK_MODE: 'copy',
      HERMES_WEBUI_AGENT_DIR: process.env.HERMES_WEBUI_AGENT_DIR || windowsHermesAgentDir(),
      HERMES_WEBUI_PYTHON: process.env.HERMES_WEBUI_PYTHON || windowsHermesPython()
    })
  },
  {
    id: 'openwork',
    name: 'OpenWork',
    basePort: 18945,
    path: '/',
    command: (port) => applyPortTemplate(
      commandFromEnv('AGENT_CMD_OPENWORK', defaultOpenWorkCommand(port)),
      port
    ),
    readyPatterns: [/dev:headless-web.*Web URL:/i, /VITE.*ready/i, /Local:/i],
    beforeStart: async (_port, log) => {
      await refreshTokenIfNeeded();
      await discoverRouterModels(log);
      await ensureOpenWorkInstalled(log);
      injectRulesAfterInstall('openwork', log);
    },
    env: () => buildBaseEnv({
      OPENAI_BASE_URL: routerBaseUrl(),
      OPENAI_API_KEY: routerApiKey(),
      WORKER_AGENTS_9ROUTER_MODEL: routerDefaultModel(),
      OPENCODE_PROVIDER: 'openai',
      OPENCODE_MODEL: routerDefaultModel(),
      OPENWORK_PUBLIC_HOST: openWorkPublicHost(18945),
      VITE_ALLOWED_HOSTS: openWorkPublicHost(18945)
    })
  },
  {
    id: 'agent-zero',
    name: 'Agent Zero',
    basePort: 18955,
    path: '/',
    command: (port) => applyPortTemplate(
      commandFromEnv('AGENT_CMD_AGENT_ZERO', defaultAgentZeroCommand(port)),
      port
    ),
    readyPatterns: [/Running on/i, /Uvicorn running/i, /listening/i],
    beforeStart: async (_port, log) => {
      await discoverRouterModels(log);
      ensureAgentZeroConfig();
      await ensureAgentZeroInstalled(log);
      injectRulesAfterInstall('agent-zero', log);
    },
    env: () => buildBaseEnv({
      OPENAI_API_KEY: routerApiKey(),
      OPENAI_BASE_URL: routerBaseUrl()
    })
  },
  {
    id: 'openclaw',
    name: 'OpenClaw Gateway',
    basePort: 18789,
    path: '/',
    command: (port) => applyPortTemplate(
      commandFromEnv('AGENT_CMD_OPENCLAW', 'openclaw gateway run --port {port} --allow-unconfigured'),
      port
    ),
    readyPatterns: [/listening on/i, /gateway is ready/i],
    beforeStart: async (port, log) => {
      await refreshTokenIfNeeded();
      await ensureGlobalPackage('openclaw', 'openclaw', log);
      const models = await discoverRouterModels(log);
      ensureOpenClawConfig(port, models);
      await ensureOpenClawBaseline(log);
      ensureOpenClawPatch();
      injectRulesAfterInstall('openclaw', log);
    },
    env: () => buildBaseEnv({
      UV_USE_IO_URING: '0',
      PLAYWRIGHT_BROWSERS_PATH: '/root/.cache/ms-playwright',
      NODE_OPTIONS: `--require ${openClawPatchPath()}`,
      OPENAI_BASE_URL: routerBaseUrl(),
      OPENAI_API_KEY: routerApiKey(),
      OPENCLAW_GATEWAY_TOKEN: readOpenClawToken(),
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
      BRAVE_API_KEY: process.env.BRAVE_API_KEY || ''
    }),
    url: (port) => {
      const token = readOpenClawToken();
      const suffix = token ? `?token=${encodeURIComponent(token)}` : '';
      return `http://${browserHost}:${port}/${suffix}`;
    }
  },
  {
    id: 'filebrowser',
    name: 'File Browser',
    basePort: 18965,
    path: '/',
    command: (port) => applyPortTemplate(
      commandFromEnv('AGENT_CMD_FILEBROWSER', defaultFileBrowserCommand(port)),
      port
    ),
    readyPath: '/api/files',
    readyPatterns: [/Server running at http:\/\/localhost:/i, /File Explorer:/i],
    beforeStart: async (_port, log) => {
      await ensureFileBrowserInstalled(log);
    },
    env: () => buildBaseEnv()
  },
  {
    id: 'web-vnc',
    name: 'Web VNC',
    basePort: 18975,
    // The broker mounts this agent below /proxy/web-vnc. noVNC resolves its
    // WebSocket path from this query value; using the broker root works for
    // both the normal and lightweight clients, while the old default path
    // attempted a socket URL the public proxy did not route correctly.
    path: '/vnc.html?autoconnect=1&resize=scale&path=proxy%2Fweb-vnc%2Fwebsockify',
    proxied: true,
    command: (port) => applyPortTemplate(
      commandFromEnv('AGENT_CMD_WEB_VNC', process.platform === 'darwin' ? defaultMacWebVncCommand(port) : defaultWebVncCommand(port)),
      port
    ),
    readyPath: '/vnc.html',
    readyPatterns: [/WebSocket server settings/i, /Listen on port/i],
    reclaimPort: async (log) => reclaimWebVncPort(18975, log),
    beforeStart: async (_port, log) => {
      await ensureWebVncInstalled(log);
    },
    env: () => buildBaseEnv()
  }
];

const definitions = [...builtInDefinitions, ...loadCustomWorkerDefinitions()];

class AgentRuntime {
  constructor(definition, notify) {
    this.definition = definition;
    this.notify = notify;
    this.state = 'stopped';
    this.logs = [];
    this.process = null;
    this.port = definition.basePort;
    this.pid = null;
    this.error = '';
    this.startedAt = '';
    this.command = '';
  }

  snapshot(includeLogs = true) {
    const url = this.definition.url
      ? this.definition.url(this.port)
      : `http://${browserHost}:${this.port}${this.definition.path}`;
    return {
      id: this.definition.id,
      name: this.definition.name,
      state: this.state,
      port: this.port,
      pid: this.pid,
      url,
      error: this.error,
      startedAt: this.startedAt,
      command: this.command,
      proxied: Boolean(this.definition.proxied),
      logs: includeLogs ? this.logs : undefined
    };
  }

  log(line) {
    const clean = stripAnsi(line).trimEnd();
    if (!clean) return;
    // Cap line size so one oversized chunk cannot blow up the in-memory log
    // ring or the diagnostic log file (logLimit only bounds the line count).
    const truncated = clean.length > 8192 ? `${clean.slice(0, 8192)}... [truncated]` : clean;
    const formatted = `${new Date().toLocaleTimeString()} [${this.definition.id}] ${truncated}`;
    this.logs.push(formatted);
    if (this.logs.length > config.logLimit) this.logs = this.logs.slice(-config.logLimit);
    try {
      fs.appendFileSync(agentLogFileFor(this.definition.id), `${formatted}\n`);
    } catch {
      // Keep the live UI working even if the diagnostic file cannot be written.
    }
    this.notify({ type: 'log', agentId: this.definition.id });
  }

  markRunning() {
    if (this.state !== 'starting' && this.state !== 'error') return;
    this.state = 'running';
    this.error = '';
    this.startedAt ||= nowIso();
    this.notify({ type: 'state', agentId: this.definition.id });
  }

  async waitForReady(child) {
    const portReady = await waitForPort(this.port, config.readyTimeoutMs);
    if (this.process !== child || this.state !== 'starting') return;
    if (!portReady) {
      this.state = 'error';
      this.error = `Timed out waiting for port ${this.port}`;
      this.log(this.error);
      this.notify({ type: 'state', agentId: this.definition.id });
      const path = this.definition.readyPath ?? this.definition.path ?? '/';
      this.recoverWhenReady(child, `http://127.0.0.1:${this.port}${path}`);
      return;
    }

    const path = this.definition.readyPath ?? this.definition.path ?? '/';
    const readyUrl = `http://127.0.0.1:${this.port}${path}`;
    this.log(`Waiting for HTTP readiness: ${readyUrl}`);
    const httpReady = await waitForHttpReady(readyUrl, config.readyTimeoutMs);
    if (this.process !== child || this.state !== 'starting') return;
    if (httpReady) {
      this.markRunning();
    } else {
      this.state = 'error';
      this.error = `Timed out waiting for HTTP readiness at ${readyUrl}`;
      this.log(this.error);
      this.notify({ type: 'state', agentId: this.definition.id });
      this.recoverWhenReady(child, readyUrl);
    }
  }

  async start() {
    if (this.state === 'running' || this.state === 'starting' || this.state === 'installing') return this.snapshot();
    this.state = 'installing';
    this.error = '';
    this.logs = [];
    this.startedAt = '';
    this.notify({ type: 'state', agentId: this.definition.id });

    try {
      await this.definition.reclaimPort?.((chunk) => {
        const lines = String(chunk).split(/\r?\n/);
        for (const line of lines) if (line) this.log(line);
      });
      this.port = await findAvailablePort(this.definition.basePort);
      await this.definition.beforeStart?.(this.port, (chunk) => {
        const lines = String(chunk).split(/\r?\n/);
        for (const line of lines) {
          if (line) this.log(line);
        }
      });
      this.state = 'starting';
      this.notify({ type: 'state', agentId: this.definition.id });
      this.command = this.definition.command(this.port);
      this.log(`Starting: ${this.command}`);
      const shell = windowsAgentShell(this.command);
      const shellArgs = shell.toLowerCase().includes('powershell')
        ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', this.command]
        : shell.toLowerCase().includes('cmd.exe')
          ? ['/d', '/s', '/c', this.command]
          : ['-lc', this.command];
      const child = spawn(shell, shellArgs, {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.definition.env?.(this.port) || buildBaseEnv()
      });
      this.process = child;
      this.pid = child.pid;

      this.pipeOutput(child, child.stdout);
      this.pipeOutput(child, child.stderr);

      child.once('error', (error) => {
        this.error = error.message;
        this.state = 'error';
        this.log(`Error: ${error.message}`);
        this.notify({ type: 'state', agentId: this.definition.id });
      });

      child.once('exit', (code, signal) => {
        const wasStopping = this.state === 'stopping';
        this.process = null;
        this.pid = null;
        const path = this.definition.readyPath ?? this.definition.path ?? '/';
        const readyUrl = `http://127.0.0.1:${this.port}${path}`;
        const allowRecovery = process.platform === 'win32' && !wasStopping;
        this.state = wasStopping ? 'stopped' : code === 0 ? 'stopped' : 'error';
        this.error = this.state === 'error' ? `Process exited with code ${code ?? 'null'} signal ${signal ?? 'null'}` : '';
        this.log(`Process exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`);
        this.notify({ type: 'state', agentId: this.definition.id });
        if (allowRecovery && this.state === 'error') {
          this.recoverDetachedService(readyUrl).catch(() => {});
        }
      });

      this.waitForReady(child);
    } catch (error) {
      this.state = 'error';
      this.error = error.message;
      this.log(`Error: ${error.message}`);
      this.notify({ type: 'state', agentId: this.definition.id });
    }
    return this.snapshot();
  }

  pipeOutput(child, stream) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 65536) {
        // A child streamed more than 64KB without a newline. Keep a tail so
        // the remaining output still appears, but never let buffer grow
        // without bound (it previously could hold hundreds of MB).
        const tail = buffer.slice(-8192);
        buffer = '';
        this.log(tail);
      }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      lines.forEach((line) => {
        this.log(line);
        this.recoverIfReadyFromOutput(child, line);
      });
    });
    stream.on('end', () => {
      if (buffer) {
        this.log(buffer);
        this.recoverIfReadyFromOutput(child, buffer);
      }
    });
  }

  recoverIfReadyFromOutput(child, line) {
    if (this.process !== child || this.state !== 'error') return;
    const clean = stripAnsi(line);
    const hasReadyOutput = this.definition.readyPatterns?.some((pattern) => pattern.test(clean));
    if (!hasReadyOutput) return;
    const path = this.definition.readyPath ?? this.definition.path ?? '/';
    const readyUrl = `http://127.0.0.1:${this.port}${path}`;
    this.recoverWhenReady(child, readyUrl);
  }

  async recoverWhenReady(child, readyUrl) {
    const started = Date.now();
    while (this.process === child && this.state === 'error' && Date.now() - started < config.readyTimeoutMs) {
      if (await isHttpReady(readyUrl)) {
        if (this.process === child && this.state === 'error') {
          this.log(`Recovered after readiness check passed: ${readyUrl}`);
          this.markRunning();
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async recoverDetachedService(readyUrl) {
    const started = Date.now();
    while (this.state === 'error' && Date.now() - started < config.readyTimeoutMs) {
      if (await isHttpReady(readyUrl)) {
        if (this.state === 'error') {
          this.log(`Recovered after detached service readiness passed: ${readyUrl}`);
          this.markRunning();
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async stop() {
    if (!this.process || this.state === 'stopped') {
      this.state = 'stopped';
      this.notify({ type: 'state', agentId: this.definition.id });
      return this.snapshot();
    }
    const child = this.process;
    this.state = 'stopping';
    this.log('Stopping...');
    this.notify({ type: 'state', agentId: this.definition.id });

    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // Process may have already exited.
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (this.process === child) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // Process may have already exited.
        }
      }
    }
    this.process = null;
    this.pid = null;
    this.state = 'stopped';
    this.notify({ type: 'state', agentId: this.definition.id });
    return this.snapshot();
  }
}

class AgentSupervisor extends EventEmitter {
  constructor() {
    super();
    this.agents = new Map(definitions.map((definition) => [
      definition.id,
      new AgentRuntime(definition, (event) => this.emit('change', event))
    ]));
  }

  snapshot() {
    return Array.from(this.agents.values()).map((agent) => agent.snapshot());
  }

  get(id) {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Unknown agent: ${id}`);
    return agent;
  }

  async start(id) {
    return this.get(id).start();
  }

  async stop(id) {
    return this.get(id).stop();
  }

  async restart(id) {
    await this.stop(id);
    return this.start(id);
  }

  async startAll() {
    const results = [];
    for (const [id, agent] of this.agents) {
      try {
        const snapshot = await agent.start();
        const running = snapshot.state === 'running' || snapshot.state === 'starting';
        results.push({ id, ok: running, state: snapshot.state });
      } catch (error) {
        results.push({ id, ok: false, error: error.message });
      }
    }
    return results;
  }

  async stopAll() {
    await Promise.all(Array.from(this.agents.values()).map((agent) => agent.stop()));
  }
}

export const supervisor = new AgentSupervisor();
