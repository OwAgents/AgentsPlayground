import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function toInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export const config = Object.freeze({
  projectRoot,
  host: process.env.AGENT_CONSOLE_HOST || (process.platform === 'win32' ? '127.0.0.1' : 'localhost'),
  // Launch mode is opt-in; unset or empty AGENT_LAUNCH means no auto-launch.
  launch: process.env.AGENT_LAUNCH || '',
  // Auto-start every agent on boot. Each agent installs itself via its
  // beforeStart hook before the process is spawned.
  autoStartAll: process.env.AGENT_AUTO_START_ALL === '1',
  port: toInt(process.env.AGENT_CONSOLE_PORT || process.env.PORT, 1456),
  oauthClientId: process.env.OPENAI_OAUTH_CLIENT_ID || '',
  oauthBaseUrl: process.env.OPENAI_OAUTH_BASE_URL || 'https://auth.openai.com',
  oauthRedirectUri: process.env.OPENAI_OAUTH_REDIRECT_URI || 'http://localhost:1456/auth/callback',
  codexHome: path.resolve(expandHome(process.env.CODEX_HOME || '~/.codex')),
  openClawHome: path.resolve(expandHome(process.env.OPENCLAW_HOME || '~/.openclaw')),
  hermesHome: path.resolve(expandHome(
    process.env.HERMES_HOME
      || (process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'hermes')
        : '~/.hermes')
  )),
  logLimit: toInt(process.env.AGENT_LOG_LIMIT, 500),
  readyTimeoutMs: toInt(process.env.AGENT_READY_TIMEOUT_MS, 45000),
  portScanRange: toInt(process.env.AGENT_PORT_SCAN_RANGE, 10),
  sshdPort: toInt(process.env.AGENT_CONSOLE_SSHD_PORT, 8027),
  expiresAt: process.env.LOLGAMES_TUNNEL_EXPIRES_AT || ''
});

export const defaultPath = (
  process.platform === 'win32'
    ? [
        path.join(os.homedir(), '.local/bin'),
        path.join(os.homedir(), '.opencode/bin'),
        'C:\\Program Files\\Git\\mingw64\\bin',
        'C:\\Program Files\\Git\\usr\\bin',
        'C:\\Program Files\\nodejs',
        'C:\\npm\\prefix',
        'C:\\Windows\\System32',
        'C:\\Windows',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
        process.env.PATH || ''
      ]
    : [
        path.join(os.homedir(), '.local/bin'),
        path.join(os.homedir(), '.opencode/bin'),
        '/mingw64/bin',
        '/opt/node20/bin',
        '/usr/bin',
        '/c/Program Files/nodejs',
        '/c/npm/prefix',
        'C:\\npm\\prefix',
        'C:\\Program Files\\nodejs',
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        process.env.PATH || ''
      ]
).filter(Boolean).join(path.delimiter);

export function nowIso() {
  return new Date().toISOString();
}

export const shellBin = process.platform === 'win32' ? 'bash' : 'sh';
