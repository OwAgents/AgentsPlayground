import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { defaultPath, shellBin } from './config.js';
import { baselineSkills, installSkill } from './skill-hub.js';
import { isRouterMiddlewarePatched, routerPackageMetadata } from './9router.js';

const STEPS = [
  { id: 'tmpdirs', label: 'Creating temp directories' },
  { id: 'verify', label: 'Verifying worker tools' },
  { id: 'skills', label: 'Installing baseline skills' },
];

const state = {
  running: false,
  done: false,
  failed: false,
  error: '',
  currentStep: '',
  currentStepIndex: -1,
  steps: STEPS.map((s) => ({ ...s, done: false, skipped: false, error: '' })),
  startedAt: '',
  completedAt: '',
};

let listeners = [];

function notify(event) {
  for (const fn of listeners) {
    try { fn(event); } catch { /* ignore listener failures */ }
  }
}

export function onSetupEvent(fn) {
  listeners.push(fn);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

export function getSetupStatus() {
  return { ...state, steps: state.steps.map((s) => ({ ...s })) };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function ensureSshd() {
  return { ok: true, skipped: true };
}

async function stepTmpdirs() {
  ensureDir('/tmp');
  return { changed: false };
}

const STATE_DIR = process.env.WORKER_AGENTS_STATE_DIR || path.join(process.env.HOME || '/tmp', '.worker-agents');
const STATE_PATH = path.join(STATE_DIR, 'state.json');

function readStateLinks() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return {
      workerAgentsUrl: String(data.worker_agents_url || data.url || '').trim(),
    };
  } catch {
    return { workerAgentsUrl: '' };
  }
}

export function refreshAgentsLinks() {
  const links = readStateLinks();
  return {
    ok: true,
    changed: Boolean(links.workerAgentsUrl),
    links,
    agents: {},
  };
}

async function stepVerify() {
  const checks = {};
  for (const bin of ['node', 'git']) {
    const result = await new Promise((resolve) => {
      const child = spawn(bin, ['--version'], { env: { ...process.env, PATH: defaultPath } });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (error) => resolve({ ok: false, version: error.message }));
      child.on('exit', (code) => resolve({ ok: code === 0, version: (out || err).trim() }));
    });
    checks[bin] = result;
  }
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 22) {
    throw new Error(`Node.js 22+ required, found ${process.version} at ${process.execPath}`);
  }
  const router = routerPackageMetadata();
  if (router.version !== '0.5.51') {
    throw new Error(`Expected owned 9router-vibefin@0.5.51, found ${router.version || '<missing>'}`);
  }
  if (!isRouterMiddlewarePatched()) {
    throw new Error('Owned 9Router middleware is not prepared; run npm ci');
  }
  checks.runtime = {
    ok: true,
    nodeVersion: process.version,
    nodeExecutable: process.execPath,
    router,
  };
  return { changed: false, checks };
}

async function stepSkills() {
  const results = [];
  for (const skill of await baselineSkills()) {
    try {
      const installed = await installSkill(skill.source, skill.name);
      results.push({ name: skill.name, installed: true, path: installed.path });
    } catch (error) {
      if (skill.required !== false) throw error;
      results.push({ name: skill.name, installed: false, skipped: true, error: error.message });
    }
  }
  return { changed: results.some((result) => result.installed), skills: results };
}

const STEP_FNS = { tmpdirs: stepTmpdirs, verify: stepVerify, skills: stepSkills };

export async function runSetup() {
  if (state.done || state.running) return getSetupStatus();
  state.running = true;
  state.failed = false;
  state.error = '';
  state.startedAt = new Date().toISOString();
  state.steps = STEPS.map((s) => ({ ...s, done: false, skipped: false, error: '' }));

  for (let i = 0; i < STEPS.length; i += 1) {
    const stepDef = STEPS[i];
    state.currentStep = stepDef.label;
    state.currentStepIndex = i;
    notify({ type: 'setup', ...getSetupStatus() });
    try {
      const result = await STEP_FNS[stepDef.id]();
      state.steps[i].done = true;
      if (result.checks) state.checks = result.checks;
      if (result.skills) state.skills = result.skills;
      console.log(`[setup] ${stepDef.label} — ${result.changed ? 'configured' : 'ok'}`);
    } catch (error) {
      state.steps[i].skipped = true;
      state.steps[i].error = error.message;
      if (stepDef.id === 'verify') {
        state.failed = true;
        state.error = error.message;
      }
      console.warn(`[setup] ${stepDef.label} — skipped: ${error.message}`);
    }
  }

  state.running = false;
  state.done = true;
  state.currentStep = '';
  state.currentStepIndex = -1;
  state.checks = state.checks || {};
  state.completedAt = new Date().toISOString();
  notify({ type: 'setup', ...getSetupStatus() });
  return getSetupStatus();
}
