import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installSkill, parseSkillSearchOutput, removeSkill } from '../src/skill-hub.js';

test('parses skills CLI results and merges installed state', () => {
  const output = `\u001b[32macme/tools@browser-use 12.4K installs\u001b[0m\n└ https://skills.sh/acme/tools/browser-use\nother/repo@writer 90 installs\n└ https://skills.sh/other/repo/writer\n`;
  assert.deepEqual(parseSkillSearchOutput(output, new Set(['browser-use'])), [
    {
      name: 'browser-use', displayName: 'Browser Use', owner: 'acme/tools', source: 'acme/tools@browser-use',
      description: '', installCountLabel: '12.4K installs', url: 'https://skills.sh/acme/tools/browser-use', installed: true
    },
    {
      name: 'writer', displayName: 'Writer', owner: 'other/repo', source: 'other/repo@writer',
      description: '', installCountLabel: '90 installs', url: 'https://skills.sh/other/repo/writer', installed: false
    }
  ]);
});

test('ignores unrelated CLI output', () => {
  assert.deepEqual(parseSkillSearchOutput('Searching...\nNo results'), []);
});

test('allows uninstalling a preinstalled baseline skill', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-agents-skills-'));
  const skillDir = path.join(root, 'skills', 'mcp-duckgo');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# test baseline skill\n');
  const fakeNpx = path.join(root, 'npx');
  fs.writeFileSync(fakeNpx, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CODEX_HOME/args"\nif [ "$3" = "add" ]; then name="${4##*@}"; mkdir -p "$CODEX_HOME/skills/$name"; printf "# test baseline skill\\n" > "$CODEX_HOME/skills/$name/SKILL.md"; else rm -rf "$CODEX_HOME/skills/$4"; fi\n');
  fs.chmodSync(fakeNpx, 0o755);
  const previousHome = process.env.CODEX_HOME;
  const previousPath = process.env.PATH;
  process.env.CODEX_HOME = root;
  process.env.PATH = `${root}:${previousPath}`;
  try {
    assert.equal((await installSkill('aahl/skills@mcp-duckgo', 'mcp-duckgo')).name, 'mcp-duckgo');
    assert.deepEqual(fs.readFileSync(path.join(root, 'args'), 'utf8').trim().split('\n'), [
      '--yes', 'skills', 'add', 'aahl/skills@mcp-duckgo', '--yes', '--global', '--agent', '*'
    ]);
    assert.deepEqual(await removeSkill('mcp-duckgo'), { name: 'mcp-duckgo', removed: true });
    assert.equal(fs.existsSync(skillDir), false);
    assert.deepEqual(fs.readFileSync(path.join(root, 'args'), 'utf8').trim().split('\n'), [
      '--yes', 'skills', 'remove', 'mcp-duckgo', '--yes', '--global', '--agent', '*'
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
