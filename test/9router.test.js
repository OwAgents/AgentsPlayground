import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBootstrapCommand } from '../src/9router.js';

test('bootstrap pins the discovered npm package across mixed Node prefixes', () => {
  const serverPath = '/usr/lib/node_modules/9router-vibefin/app/server.js';
  const command = buildBootstrapCommand(20128, serverPath);

  assert.match(command, /ROUTER_SERVER='\/usr\/lib\/node_modules\/9router-vibefin\/app\/server\.js'/);
  assert.match(command, /NPM_ROUTER_HOME="\$\(dirname "\$\(dirname "\$ROUTER_SERVER"\)"\)"/);
  assert.doesNotMatch(command, /npm root -g/);
  assert.doesNotMatch(command, /command -v 9router/);
  assert.doesNotMatch(command, /\.next\/standalone\/server\.js/);
});
