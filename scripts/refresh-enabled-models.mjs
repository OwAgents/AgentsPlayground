#!/usr/bin/env node

/**
 * Discover and probe models for every active 9router connection and built-in
 * no-auth provider, then save successful results. Connection results are saved
 * as providerSpecificData.enabledModels; no-auth results are saved in the
 * local refresh file for inspection and future integration.
 *
 * Usage:
 *   node scripts/refresh-enabled-models.mjs [base-url]
 *
 * The script intentionally only writes successful probes. It preserves all
 * other providerSpecificData fields and never prints credentials or response
 * bodies.
 */

const baseUrl = (process.argv[2] || process.env.N9ROUTER_URL || "http://127.0.0.1:20127").replace(/\/$/, "");
const timeoutMs = Number(process.env.N9ROUTER_MODEL_TIMEOUT_MS || 15000);
const refreshFile = process.env.N9ROUTER_REFRESH_FILE || `${process.env.HOME}/.9router/enabled-models.json`;

const withTimeout = async (url, options = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const json = async (response) => {
  try { return await response.json(); } catch { return null; }
};

const modelsFrom = (payload) => {
  const list = Array.isArray(payload) ? payload : (payload?.models || payload?.data || payload?.results || []);
  return list.filter((m) => typeof m === "string" || m?.id || m?.name);
};

const noAuthProviders = [
  { id: "opencode", alias: "oc", url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  { id: "mimo-free", alias: "mmf", url: "https://models.dev/api.json", type: "mimo-free" },
];
const noAuthFilters = {
  "opencode-free": (list) => list.filter((m) => m?.id?.endsWith("-free") || m?.id === "big-pickle"),
  "mimo-free": (list) => list.filter((m) => m?.id?.startsWith("mimo") || m?.name?.toLowerCase().includes("mimo")),
};

const refreshedNoAuth = {};
for (const provider of noAuthProviders) {
  try {
    const response = await withTimeout(provider.url);
    const payload = await json(response);
    const candidates = noAuthFilters[provider.type]?.(modelsFrom(payload)) || [];
    const successful = [];
    for (const candidate of candidates) {
      const rawModel = typeof candidate === "string" ? candidate : candidate.id;
      const model = `${provider.alias}/${rawModel}`;
      try {
        const probe = await withTimeout(`${baseUrl}/v1/chat/completions`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply exactly OK" }], stream: false }),
        });
        if (probe.ok) successful.push(rawModel);
      } catch {}
    }
    refreshedNoAuth[provider.alias] = { provider: provider.id, discovered: candidates.length, working: successful };
    console.log(`${provider.alias}: discovered=${candidates.length} working=${successful.length}`);
  } catch {
    console.log(`${provider.alias}: live discovery failed; skipped`);
  }
}

const connectionsResponse = await withTimeout(`${baseUrl}/api/providers`);
if (!connectionsResponse.ok) throw new Error(`GET /api/providers failed (${connectionsResponse.status})`);
const connections = (await json(connectionsResponse))?.connections || [];

for (const connection of connections.filter((c) => c.isActive !== false)) {
  const prefix = connection.providerSpecificData?.prefix || connection.provider;
  let discovered = [];
  let discoverySucceeded = false;
  try {
    const response = await withTimeout(`${baseUrl}/api/providers/${encodeURIComponent(connection.id)}/models`);
    if (response.ok) {
      discovered = modelsFrom(await json(response));
      discoverySucceeded = true;
    }
  } catch {}

  if (!discoverySucceeded || discovered.length === 0) {
    console.log(`${connection.provider}: discovery failed or returned no models; skipped`);
    continue;
  }

  const successful = [];
  for (const rawModel of discovered) {
    const model = rawModel.startsWith(`${prefix}/`) ? rawModel : `${prefix}/${rawModel}`;
    try {
      const response = await withTimeout(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply exactly OK" }], stream: false }),
      });
      if (response.ok) successful.push(rawModel);
    } catch {}
  }

  if (successful.length === 0) {
    console.log(`${connection.provider}: discovered=${discovered.length} working=0; skipped`);
    continue;
  }

  const providerSpecificData = {
    ...(connection.providerSpecificData || {}),
    enabledModels: successful,
  };
  const update = await withTimeout(`${baseUrl}/api/providers/${encodeURIComponent(connection.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerSpecificData }),
  });
  if (!update.ok) throw new Error(`PUT connection ${connection.id} failed (${update.status})`);
  console.log(`${connection.provider}: discovered=${discovered.length} working=${successful.length}`);
}

if (connections.length === 0) console.log("No provider connections found; nothing to refresh.");

if (Object.keys(refreshedNoAuth).length > 0) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  await fs.mkdir(path.dirname(refreshFile), { recursive: true });
  await fs.writeFile(refreshFile, `${JSON.stringify({ updatedAt: new Date().toISOString(), providers: refreshedNoAuth }, null, 2)}\n`, { mode: 0o600 });
  console.log(`Saved no-auth refresh results to ${refreshFile}`);
}
