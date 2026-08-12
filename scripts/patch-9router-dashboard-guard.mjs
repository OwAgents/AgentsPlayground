#!/usr/bin/env node
// Standalone CLI for the 9Router dashboardGuard open-access patch.
// Usage: node patch-9router-dashboard-guard.mjs <router-home>
import path from 'node:path';

const routerHome = path.resolve(process.argv[2] || '');
if (!routerHome) {
  console.error('usage: patch-9router-dashboard-guard.mjs <router-home>');
  process.exit(2);
}

// ROUTER_HOME is read from the environment at module load, so set it first.
process.env.WORKER_AGENTS_9ROUTER_DIR = routerHome;

const { patchRouterDashboardGuard, patchRouterMiddleware } = await import('../src/9router.js');

try {
  patchRouterDashboardGuard((message) => console.log(message));
  patchRouterMiddleware((message) => console.log(message));
} catch (error) {
  console.error(`[9router] dashboardGuard open-access patch failed: ${error.message}`);
  process.exit(1);
}
