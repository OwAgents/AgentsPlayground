import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SEARCH_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 120_000;
const SKILLS_REPOSITORY = process.env.WORKER_AGENTS_SKILLS_REPOSITORY || 'agents-dev/skills';
const SKILLS_BRANCH = process.env.WORKER_AGENTS_SKILLS_BRANCH || 'main';
const SKILLS_TREE_URL = `https://api.github.com/repos/${SKILLS_REPOSITORY}/git/trees/${SKILLS_BRANCH}?recursive=1`;
const SKILLS_DISCOVERY_TIMEOUT_MS = 15_000;
const UNIVERSAL_AGENT_ARGS = ['--global', '--agent', '*'];
let baselineSkillsPromise;

function skillRoots() {
  const roots = [
    process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'skills') : '',
    path.join(os.homedir(), '.codex', 'skills'),
    path.join(os.homedir(), '.agents', 'skills')
  ].filter(Boolean);
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function frontmatterDescription(markdown) {
  const match = String(markdown).match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return '';
  const line = match[1].split(/\r?\n/).find((entry) => /^description\s*:/i.test(entry.trim()));
  return line ? line.replace(/^description\s*:\s*/i, '').replace(/^['"]|['"]$/g, '').trim() : '';
}

function readInstalledSkillEntry(root, entry) {
  const skillPath = path.join(root, entry.name, 'SKILL.md');
  if (!entry.isDirectory() || entry.name.startsWith('.') || !fs.existsSync(skillPath)) return null;
  let description = '';
  try { description = frontmatterDescription(fs.readFileSync(skillPath, 'utf8')); } catch {}
  return {
    name: entry.name,
    displayName: entry.name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
    owner: 'local',
    description,
    installed: true,
    path: skillPath,
    url: ''
  };
}

export function listInstalledSkills() {
  const skills = new Map();
  for (const root of skillRoots()) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch {}
    for (const entry of entries) {
      const skill = readInstalledSkillEntry(root, entry);
      if (skill && !skills.has(skill.name)) skills.set(skill.name, skill);
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function parseSkillsTree(tree) {
  const skills = new Map();
  for (const entry of Array.isArray(tree) ? tree : []) {
    const match = String(entry?.path || '').match(/^skills\/([^/]+)\/SKILL\.md$/);
    if (!match || entry.type !== 'blob') continue;
    const name = match[1];
    skills.set(name, {
      name,
      source: `${SKILLS_REPOSITORY}@${name}`,
      required: true,
      path: entry.path
    });
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function discoverBaselineSkills() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SKILLS_DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(SKILLS_TREE_URL, {
      headers: { accept: 'application/vnd.github+json' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Skills repository discovery failed with HTTP ${response.status}.`);
    const payload = await response.json();
    return parseSkillsTree(payload.tree);
  } finally {
    clearTimeout(timeout);
  }
}

export function baselineSkills() {
  if (!baselineSkillsPromise) {
    baselineSkillsPromise = discoverBaselineSkills().catch((error) => {
      console.warn(`[skills] Unable to discover baseline skills: ${error.message}`);
      return [];
    });
  }
  return baselineSkillsPromise.then((skills) => skills.map((skill) => ({ ...skill })));
}

export async function baselineStatus() {
  const installed = new Map(listInstalledSkills().map((skill) => [skill.name, skill]));
  return (await baselineSkills()).map((skill) => ({ ...skill, installed: installed.has(skill.name), path: installed.get(skill.name)?.path || '' }));
}

export function parseSkillSearchOutput(output, installedNames = new Set()) {
  const lines = String(output).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const results = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(.+?@[^@\s]+)\s+([\d.]+[KMB]?)\s+installs$/i);
    if (!match) continue;
    const source = match[1];
    const separator = source.lastIndexOf('@');
    if (separator <= 0) continue;
    const owner = source.slice(0, separator);
    const name = source.slice(separator + 1);
    const next = lines[index + 1] || '';
    const urlMatch = next.match(/(?:^└\s*)?(https?:\/\/\S+)$/);
    if (urlMatch) index += 1;
    results.push({
      name,
      displayName: name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
      owner,
      source,
      description: '',
      installCountLabel: `${match[2]} installs`,
      url: urlMatch?.[1] || '',
      installed: installedNames.has(name)
    });
  }
  return results;
}

export async function searchSkills(query) {
  const cleanQuery = String(query || '').trim();
  if (cleanQuery.length < 2) return [];
  const installed = new Set(listInstalledSkills().map((skill) => skill.name));
  const { stdout } = await execFileAsync('npx', ['--yes', 'skills', 'find', cleanQuery], {
    timeout: SEARCH_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024
  });
  return parseSkillSearchOutput(stdout, installed);
}

export async function installSkill(source, expectedName = '') {
  const cleanSource = String(source || '').trim();
  if (!/^[A-Za-z0-9._/-]+@[A-Za-z0-9._-]+$/.test(cleanSource)) throw new Error('Missing or invalid skill source.');
  await execFileAsync('npx', ['--yes', 'skills', 'add', cleanSource, '--yes', ...UNIVERSAL_AGENT_ARGS], {
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024
  });
  const name = String(expectedName || cleanSource.slice(cleanSource.lastIndexOf('@') + 1));
  const installed = listInstalledSkills().find((skill) => skill.name === name);
  if (!installed) throw new Error(`Installation finished, but ${name} was not found in the global skills directories.`);
  return installed;
}

export async function removeSkill(name) {
  const cleanName = String(name || '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(cleanName)) throw new Error('Missing or invalid skill name.');
  if (!listInstalledSkills().some((skill) => skill.name === cleanName)) {
    throw new Error(`${cleanName} is not installed.`);
  }
  await execFileAsync('npx', ['--yes', 'skills', 'remove', cleanName, '--yes', ...UNIVERSAL_AGENT_ARGS], {
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024
  });
  if (listInstalledSkills().some((skill) => skill.name === cleanName)) {
    throw new Error(`Removal finished, but ${cleanName} is still present in the global skills directories.`);
  }
  return { name: cleanName, removed: true };
}

export function readInstalledSkill(name) {
  const skill = listInstalledSkills().find((candidate) => candidate.name === String(name || ''));
  if (!skill) return null;
  return { ...skill, content: fs.readFileSync(skill.path, 'utf8') };
}
