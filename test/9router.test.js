import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import path from 'node:path';

import { isRouterMiddlewarePatched, routerLaunchSpec, routerPackageMetadata } from '../src/9router.js';

test('launch uses only the Worker Agents-owned locked package', () => {
  const runtime = routerPackageMetadata();
  const launch = routerLaunchSpec(20128);

  assert.equal(runtime.name, '9router-vibefin');
  assert.equal(runtime.version, '0.5.51');
  assert.match(runtime.packagePath, /workerAgents\/node_modules\/9router-vibefin\/package\.json$/);
  assert.equal(launch.executable, process.execPath);
  assert.deepEqual(launch.args, [runtime.serverPath]);
  assert.equal(launch.cwd, path.dirname(runtime.serverPath));
  assert.equal(launch.env.PORT, '20128');
  assert.equal(launch.env.DATA_DIR, path.join(process.env.HOME, '.9router', 'data'));
  assert.match(launch.env.NODE_OPTIONS, /node-file-polyfill\.cjs/);
  assert.equal(isRouterMiddlewarePatched(), true);
});

test('source contains no global npm or source-build router fallback', () => {
  const source = fs.readFileSync(new URL('../src/9router.js', import.meta.url), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(packageJson.dependencies['9router-vibefin'], '0.5.51');
  assert.equal(packageJson.engines.node, '>=22');
  assert.equal(packageJson.scripts.postinstall, 'node scripts/prepare-owned-9router.mjs');
  assert.doesNotMatch(source, /npm root -g/);
  assert.doesNotMatch(source, /npm (?:i|install) -g/);
  assert.doesNotMatch(source, /WORKER_AGENTS_9ROUTER_DIR/);
  assert.doesNotMatch(source, /\.next[\\/]standalone[\\/]server\.js/);
});
