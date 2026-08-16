export type Agent = {
  id: string; name: string; state: string; port?: number; url?: string; proxied?: boolean; error?: string; logs?: string[]
}

export type StatusPayload = {
  agents: Agent[]; worker?: { name?: string }; version?: { versionCode?: string | number; versionName?: string };
  lifecycle?: { expiresAt?: string } | null
}

export type Skill = {
  name: string; displayName?: string; owner: string; description: string; installed: boolean;
  source?: string; path?: string; url: string; installCountLabel?: string; content?: string
}

export type RuleAdapter = {
  id: string; installed: boolean; targetPath: string | null; injected: boolean; skipped: boolean;
  reason: string | null; error: string | null
}

export type RulesPayload = {
  ok: boolean; rulesPath: string; content: string; generated: string; effective: string; deployed: boolean;
  deployment: { publicUrl: string; workerHostPrefix: string; workerBaseHost: string; fileBrowserUrl: string } | null;
  adapters: RuleAdapter[]
}
