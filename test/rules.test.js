import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyManagedRules, createRulesService, deploymentContext, renderRulesTemplate, RULES_START } from '../src/rules.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-rules-'));
  const homeDir = path.join(root, 'home');
  const projectRoot = path.join(root, 'app');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'Rules.template.md'), 'Dashboard {{WORKER_PUBLIC_URL}}\nPrefix {{WORKER_HOST_PREFIX}}\nFiles {{FILE_BROWSER_URL}}');
  return { root, homeDir, projectRoot };
}

test('renders only valid agentsweb deployment context with encoded HTTPS children', () => {
  assert.equal(deploymentContext('http://localhost:1456'), null);
  assert.equal(deploymentContext('https://example.com'), null);
  const context = deploymentContext('http://guest-demo-1786845105-worker-agents.agentsweb.space:1456');
  assert.deepEqual(context, {
    publicUrl: 'https://guest-demo-1786845105-worker-agents-1456.agentsweb.space/',
    workerHostPrefix: 'guest-demo-1786845105',
    workerBaseHost: 'guest-demo-1786845105-worker-agents.agentsweb.space',
    fileBrowserUrl: 'https://guest-demo-1786845105-worker-agents-18965.agentsweb.space'
  });
  const rendered = renderRulesTemplate('{{WORKER_PUBLIC_URL}} {{WORKER_HOST_PREFIX}} {{FILE_BROWSER_URL}}', context);
  assert.match(rendered, /^https:\/\//);
  assert.match(rendered, /guest-demo-1786845105/);
  assert.match(rendered, /-18965\.agentsweb\.space$/);
});

test('managed rules stay at the top, replace idempotently, and preserve existing content', () => {
  const existing = '# Existing instructions\nKeep this byte-for-byte.\n';
  const first = applyManagedRules(existing, 'Rule one');
  assert.ok(first.startsWith(RULES_START));
  assert.ok(first.endsWith(existing));
  const second = applyManagedRules(first, 'Rule two');
  assert.equal((second.match(new RegExp(RULES_START, 'g')) || []).length, 1);
  assert.match(second, /Rule two/);
  assert.doesNotMatch(second, /Rule one/);
  assert.ok(second.endsWith(existing));
  assert.equal(applyManagedRules(second, ''), existing);
});

test('local mode keeps generated rules empty and writes canonical user rules', () => {
  const { homeDir, projectRoot } = fixture();
  const service = createRulesService({ homeDir, projectRoot, env: {}, commandExists: () => false });
  const saved = service.save('Always verify the result.\n');
  assert.equal(saved.deployed, false);
  assert.equal(saved.generated, '');
  assert.equal(saved.content, 'Always verify the result.');
  assert.equal(fs.readFileSync(path.join(homeDir, '.worker-agents', 'Rules.md'), 'utf8'), saved.content);
});

test('custom homes inject supported adapters, deduplicate OpenCode and OpenWork, and skip Agent Zero', () => {
  const { root, homeDir, projectRoot } = fixture();
  const env = {
    CODEX_HOME: path.join(root, 'codex-home'),
    XDG_CONFIG_HOME: path.join(root, 'xdg'),
    HERMES_HOME: path.join(root, 'hermes-home'),
    OPENCLAW_HOME: path.join(root, 'claw-home'),
    DEEPSEEK_HARNESS_DIR: path.join(root, 'deepseek'),
    OPENWORK_DIR: path.join(root, 'openwork'),
    AGENT_ZERO_DIR: path.join(root, 'agent-zero'),
    WORKER_AGENTS_URL: 'https://worker-test-worker-agents-1456.agentsweb.space/'
  };
  for (const directory of [env.CODEX_HOME, path.join(env.XDG_CONFIG_HOME, 'opencode'), env.HERMES_HOME, path.join(env.OPENCLAW_HOME, 'workspace')]) fs.mkdirSync(directory, { recursive: true });
  for (const directory of [env.DEEPSEEK_HARNESS_DIR, env.OPENWORK_DIR]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), '{}');
  }
  fs.mkdirSync(env.AGENT_ZERO_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.AGENT_ZERO_DIR, 'run_ui.py'), '');
  const service = createRulesService({ homeDir, projectRoot, env, commandExists: () => false });
  const payload = service.save('', true, [
    { id: 'shared', title: 'Shared agent instructions', content: '', enabled: true },
    { id: 'custom', title: 'Custom checks', content: 'User rule', enabled: true },
    { id: 'disabled', title: 'Disabled checks', content: 'Never inject this', enabled: false }
  ]);
  assert.match(payload.generated, /^Dashboard https:\/\/worker-test-worker-agents-1456\.agentsweb\.space\//);
  assert.match(payload.content, /## Custom checks\n\nUser rule/);
  assert.doesNotMatch(payload.effective, /Never inject this/);
  assert.equal(payload.includeDeploymentRules, true);
  for (const id of ['codex', 'opencode', 'openwork', 'hermes', 'openclaw', 'deepseek']) {
    const report = payload.adapters.find((item) => item.id === id);
    assert.equal(report.injected, true, id);
    assert.equal(report.error, null, id);
  }
  const openCodePath = path.join(env.XDG_CONFIG_HOME, 'opencode', 'AGENTS.md');
  assert.equal((fs.readFileSync(openCodePath, 'utf8').match(new RegExp(RULES_START, 'g')) || []).length, 1);
  assert.ok(fs.existsSync(path.join(env.HERMES_HOME, 'SOUL.md')));
  assert.equal(fs.existsSync(path.join(env.HERMES_HOME, 'AGENTS.md')), false);
  const agentZero = payload.adapters.find((item) => item.id === 'agent-zero');
  assert.deepEqual({ installed: agentZero.installed, injected: agentZero.injected, skipped: agentZero.skipped, reason: agentZero.reason, targetPath: agentZero.targetPath }, {
    installed: true, injected: false, skipped: true, reason: 'unsupported', targetPath: null
  });
});

test('adapter failures are isolated and do not discard the canonical save', () => {
  const { root, homeDir, projectRoot } = fixture();
  const badCodexHome = path.join(root, 'codex-file');
  fs.writeFileSync(badCodexHome, 'not a directory');
  const service = createRulesService({ homeDir, projectRoot, env: { CODEX_HOME: badCodexHome }, commandExists: () => false });
  const payload = service.save('Persist even when one adapter fails');
  const codex = payload.adapters.find((item) => item.id === 'codex');
  assert.equal(codex.installed, true);
  assert.ok(codex.error);
  assert.equal(fs.readFileSync(service.rulesPath, 'utf8'), 'Persist even when one adapter fails');
});
