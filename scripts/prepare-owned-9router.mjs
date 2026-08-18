#!/usr/bin/env node

const {
  isRouterMiddlewarePatched,
  patchRouterDashboardGuard,
  patchRouterMiddleware,
  routerPackageMetadata,
} = await import('../src/9router.js');

const runtime = routerPackageMetadata();
patchRouterDashboardGuard((message) => console.log(message));
patchRouterMiddleware((message) => console.log(message));
if (!isRouterMiddlewarePatched()) {
  throw new Error(`Unable to prepare ${runtime.name}@${runtime.version} middleware at ${runtime.packagePath}`);
}
console.log(`[9router] Prepared owned ${runtime.name}@${runtime.version}`);
