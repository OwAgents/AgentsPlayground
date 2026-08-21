import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, defaultPath } from './config.js';

export const RULES_START = '<!-- worker-agents:mandatory-rules:start -->';
export const RULES_END = '<!-- worker-agents:mandatory-rules:end -->';

function exists(filePath) {
  try { return fs.existsSync(filePath); } catch { return false; }
}

function commandExists(command, env = process.env) {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore', timeout: 3000, env: { ...env, PATH: defaultPath } });
    return true;
  } catch {
    return false;
  }
}

function readText(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, content, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function applyManagedRules(existing, effectiveRules) {
  const blockPattern = new RegExp(`${escapeRegExp(RULES_START)}[\\s\\S]*?${escapeRegExp(RULES_END)}(?:\\r?\\n)*`, 'g');
  const preserved = String(existing || '').replace(blockPattern, '');
  const rules = String(effectiveRules || '').trim();
  if (!rules) return preserved;
  const block = `${RULES_START}\n<mandatory_rules>\n${rules}\n</mandatory_rules>\n${RULES_END}\n`;
  return preserved ? `${block}\n${preserved}` : block;
}

export function deploymentContext(publicUrl) {
  const raw = String(publicUrl || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const suffix = '.agentsweb.space';
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname.endsWith(suffix)) return null;
    const encodedHost = hostname.slice(0, -suffix.length);
    const encodedBase = encodedHost.replace(/-\d+$/, '');
    if (!encodedBase || encodedBase.includes('.')) return null;
    const workerHostPrefix = encodedBase.endsWith('-worker-agents')
      ? encodedBase.slice(0, -'-worker-agents'.length)
      : encodedBase;
    if (!workerHostPrefix) return null;
    const dashboardUrl = `https://${encodedBase}-1456${suffix}/`;
    const fileBrowserUrl = `https://${encodedBase}-18965${suffix}`;
    return {
      publicUrl: dashboardUrl,
      workerHostPrefix,
      workerBaseHost: `${encodedBase}${suffix}`,
      workerChildHostPrefix: encodedBase,
      fileBrowserUrl
    };
  } catch {
    return null;
  }
}

export function renderRulesTemplate(template, context) {
  if (!context) return '';
  return String(template || '')
    .replaceAll('{{WORKER_PUBLIC_URL}}', context.publicUrl)
    .replaceAll('{{WORKER_HOST_PREFIX}}', context.workerHostPrefix)
    .replaceAll('{{WORKER_CHILD_HOST_PREFIX}}', context.workerChildHostPrefix || context.workerHostPrefix)
    .replaceAll('{{FILE_BROWSER_URL}}', context.fileBrowserUrl)
    .trim();
}

function statePublicUrl(statePath, env) {
  const configured = env.AGENT_CONSOLE_PUBLIC_URL || env.WORKER_AGENTS_URL;
  if (configured) return configured;
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return state.worker_agents_url || state.url || '';
  } catch {
    return '';
  }
}

function baseReport(id, installed, targetPath, reason = null) {
  return { id, installed, targetPath, injected: false, skipped: !installed || Boolean(reason), reason: reason || (!installed ? 'not-installed' : null), error: null };
}

function normalizeSections(sections, fallbackContent = '') {
  if (!Array.isArray(sections) || !sections.length) {
    return [{ id: 'shared', title: 'Shared agent instructions', content: fallbackContent, enabled: true, removable: false }];
  }
  const seen = new Set();
  return sections.map((section, index) => {
    let id = String(section?.id || `section-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '-');
    while (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    return {
      id,
      title: String(section?.title || `Section ${index + 1}`).trim() || `Section ${index + 1}`,
      content: String(section?.content || ''),
      enabled: section?.enabled !== false,
      removable: id !== 'shared'
    };
  });
}

function renderEnabledSections(sections) {
  const enabled = sections.filter((section) => section.enabled && section.content.trim());
  if (enabled.length === 1 && enabled[0].id === 'shared') return enabled[0].content.trim();
  return enabled.map((section) => `## ${section.title}\n\n${section.content.trim()}`).join('\n\n');
}

export function createRulesService(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const projectRoot = options.projectRoot || config.projectRoot;
  const workerStateDir = env.WORKER_AGENTS_STATE_DIR || path.join(homeDir, '.worker-agents');
  const rulesPath = options.rulesPath || path.join(workerStateDir, 'Rules.md');
  const settingsPath = options.settingsPath || path.join(workerStateDir, 'rules-settings.json');
  const statePath = options.statePath || path.join(workerStateDir, 'state.json');
  const templatePath = options.templatePath || path.join(projectRoot, 'Rules.template.md');
  const hasCommand = options.commandExists || ((command) => commandExists(command, env));
  let reports = [];

  function resolvedPaths() {
    const codexHome = path.resolve(env.CODEX_HOME || path.join(homeDir, '.codex'));
    const xdgConfigHome = path.resolve(env.XDG_CONFIG_HOME || path.join(homeDir, '.config'));
    const hermesHome = path.resolve(env.HERMES_HOME || (process.platform === 'win32' ? path.join(env.LOCALAPPDATA || homeDir, 'hermes') : path.join(homeDir, '.hermes')));
    const openClawHome = path.resolve(env.OPENCLAW_HOME || path.join(homeDir, '.openclaw'));
    const deepSeekDir = path.resolve(env.DEEPSEEK_HARNESS_DIR || path.join(homeDir, 'deepseek-harness'));
    const deepSeekHome = path.resolve(env.DSH_HOME || path.join(homeDir, '.dsh'));
    const agentZeroDir = path.resolve(env.AGENT_ZERO_DIR || path.join(homeDir, 'agent-zero'));
    const opencodeTarget = path.join(xdgConfigHome, 'opencode', 'AGENTS.md');
    return { codexHome, hermesHome, openClawHome, deepSeekDir, deepSeekHome, agentZeroDir, opencodeTarget };
  }

  function detectAdapters() {
    const paths = resolvedPaths();
    const codexInstalled = exists(paths.codexHome) || hasCommand('codex') || hasCommand('codexapp');
    const opencodeInstalled = exists(path.dirname(paths.opencodeTarget)) || hasCommand('opencode');
    const hermesInstalled = exists(paths.hermesHome) || hasCommand('hermes') || hasCommand('hermes-webui');
    const openclawInstalled = exists(paths.openClawHome) || hasCommand('openclaw');
    const deepseekInstalled = exists(path.join(paths.deepSeekDir, 'package.json'));
    const agentZeroInstalled = exists(path.join(paths.agentZeroDir, 'run_ui.py'));
    return [
      baseReport('codex', codexInstalled, path.join(paths.codexHome, 'AGENTS.md')),
      baseReport('opencode', opencodeInstalled, paths.opencodeTarget),
      baseReport('hermes', hermesInstalled, path.join(paths.hermesHome, 'SOUL.md')),
      baseReport('openclaw', openclawInstalled, path.join(paths.openClawHome, 'workspace', 'AGENTS.md')),
      // DeepSeek Harness reserves $DSH_HOME/AGENTS.md for user-global
      // instructions. Do not put shared rules in the harness checkout: that
      // file is not consulted when a session opens another project.
      baseReport('deepseek', deepseekInstalled, path.join(paths.deepSeekHome, 'AGENTS.md')),
      baseReport('agent-zero', agentZeroInstalled, null, 'unsupported')
    ];
  }

  function effectiveState() {
    const deployment = deploymentContext(statePublicUrl(statePath, env));
    const settings = (() => {
      try {
        return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch {
        return {};
      }
    })();
    const includeDeploymentRules = typeof settings.includeDeploymentRules === 'boolean' ? settings.includeDeploymentRules : Boolean(deployment);
    const sections = normalizeSections(settings.sections, readText(rulesPath));
    const generated = renderRulesTemplate(readText(templatePath), deployment);
    const content = renderEnabledSections(sections);
    const effective = [includeDeploymentRules ? generated : '', content].filter(Boolean).join('\n\n');
    return { content, generated, effective, deployment, includeDeploymentRules, sections };
  }

  function inject(ids = null) {
    const selected = ids ? new Set(Array.isArray(ids) ? ids : [ids]) : null;
    const state = effectiveState();
    const detected = detectAdapters();
    const writes = new Map();
    reports = detected.map((report) => {
      if (selected && !selected.has(report.id)) return report;
      if (report.skipped || !report.targetPath) return report;
      try {
        let result = writes.get(report.targetPath);
        if (!result) {
          const existing = readText(report.targetPath);
          const next = applyManagedRules(existing, state.effective);
          if (next !== existing) atomicWrite(report.targetPath, next);
          result = { injected: true };
          writes.set(report.targetPath, result);
        }
        return { ...report, injected: result.injected, skipped: false, reason: null };
      } catch (error) {
        return { ...report, injected: false, skipped: false, reason: null, error: error.message };
      }
    });
    return payload(state);
  }

  function payload(state = effectiveState()) {
    return {
      ok: true,
      rulesPath,
      content: state.content,
      generated: state.generated,
      effective: state.effective,
      includeDeploymentRules: state.includeDeploymentRules,
      sections: state.sections,
      deployed: Boolean(state.deployment),
      deployment: state.deployment,
      adapters: reports.length ? reports : detectAdapters()
    };
  }

  function save(content, includeDeploymentRules, sections) {
    if (typeof content !== 'string') throw new Error('Rules content must be a string.');
    const current = effectiveState();
    const normalized = normalizeSections(sections, content);
    const rendered = renderEnabledSections(normalized);
    atomicWrite(rulesPath, rendered);
    atomicWrite(settingsPath, `${JSON.stringify({ includeDeploymentRules: typeof includeDeploymentRules === 'boolean' ? includeDeploymentRules : current.includeDeploymentRules, sections: normalized }, null, 2)}\n`);
    return inject();
  }

  return { rulesPath, templatePath, payload, save, inject, detectAdapters };
}

export const rulesService = createRulesService();

export function reconcileRules(adapterId = null) {
  return rulesService.inject(adapterId);
}
