import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillSearchOutput } from '../src/skill-hub.js';

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
