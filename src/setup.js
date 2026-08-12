import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { defaultPath, shellBin } from './config.js';

const STEPS = [
  { id: 'tmpdirs', label: 'Creating temp directories' },
  { id: 'skills', label: 'Installing shared skills from GitHub' },
  { id: 'verify', label: 'Verifying worker tools' },
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

const SKILLS_REPO = process.env.WORKER_AGENTS_SKILLS_REPO || 'https://github.com/phaneron23/skills.git';
const SKILLS_BRANCH = String(process.env.WORKER_AGENTS_SKILLS_BRANCH || '').trim();
const SKILLS_DIR = process.env.WORKER_AGENTS_SKILLS_DIR || path.join(process.env.HOME || '/tmp', '.worker-agents', 'skills');
const STATE_DIR = process.env.WORKER_AGENTS_STATE_DIR || path.join(process.env.HOME || '/tmp', '.worker-agents');
const STATE_PATH = path.join(STATE_DIR, 'state.json');

function parseGitPullSummary(output) {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  const changeLine = lines.find((line) => /\d+\s+files?\s+changed/i.test(line));
  if (changeLine) return { changed: true, text: changeLine };
  if (lines.find((line) => /already up[- ]to[- ]date/i.test(line))) return { changed: false, text: 'Already up to date.' };
  return { changed: true, text: lines.find((line) => !line.startsWith('remote:')) || 'Synced from GitHub.' };
}

function trySyncOnce(sharedSkillsDir = SKILLS_DIR) {
  return new Promise((resolve) => {
    ensureDir(path.dirname(sharedSkillsDir));
    const isCloned = fs.existsSync(path.join(sharedSkillsDir, '.git'));
    const cloneBranch = SKILLS_BRANCH ? ` --branch "${SKILLS_BRANCH}"` : '';
    const cmd = isCloned
      ? `cd "${sharedSkillsDir}" && git pull --ff-only`
      : `git clone${cloneBranch} --depth 1 "${SKILLS_REPO}" "${sharedSkillsDir}"`;
    const child = spawn(shellBin, ['-lc', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      env: { ...process.env, PATH: defaultPath },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, err: e.message }));
    child.on('exit', (code) => {
      if (code !== 0) {
        resolve({ ok: false, err: err.trim() || out.trim() || `git exited ${code}` });
        return;
      }
      const summary = isCloned ? parseGitPullSummary(`${out}\n${err}`) : { changed: true, text: 'Cloned from GitHub.' };
      resolve({ ok: true, changed: summary.changed, summary: summary.text });
    });
  });
}

async function stepSkills() {
  const result = await trySyncOnce();
  if (!result.ok) throw new Error(result.err || 'skill sync failed');
  return { changed: result.changed, summary: result.summary };
}

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

export async function syncSkills() {
  return trySyncOnce();
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
  return { changed: false, checks };
}

const STEP_FNS = { tmpdirs: stepTmpdirs, skills: stepSkills, verify: stepVerify };

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
      console.log(`[setup] ${stepDef.label} — ${result.changed ? 'configured' : 'ok'}`);
    } catch (error) {
      state.steps[i].skipped = true;
      state.steps[i].error = error.message;
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
