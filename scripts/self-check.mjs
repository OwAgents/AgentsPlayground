#!/usr/bin/env node

import fs from 'node:fs';

import {
  isRouterMiddlewarePatched,
  routerLaunchSpec,
  routerPackageMetadata,
} from '../src/9router.js';

const major = Number.parseInt(process.versions.node.split('.')[0], 10);
if (!Number.isFinite(major) || major < 22) {
  throw new Error(`Node.js 22+ required, found ${process.version} at ${process.execPath}`);
}

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const expected = packageJson.dependencies?.['9router-vibefin'];
const locked = lock.packages?.['node_modules/9router-vibefin']?.version;
if (expected !== '0.5.51' || locked !== expected) {
  throw new Error(`9Router dependency drift: package=${expected || '<missing>'}, lock=${locked || '<missing>'}`);
}

const runtime = routerPackageMetadata();
const launch = routerLaunchSpec();
if (runtime.version !== expected) throw new Error(`Installed 9Router ${runtime.version} does not match ${expected}`);
if (!isRouterMiddlewarePatched()) throw new Error('Owned 9Router middleware is not prepared; run npm ci');
if (launch.executable !== process.execPath) throw new Error('9Router launch does not share the Worker Agents Node executable');

console.log(JSON.stringify({
  ok: true,
  workerAgentsVersion: packageJson.version,
  nodeVersion: process.version,
  nodeExecutable: process.execPath,
  router: runtime,
}, null, 2));
