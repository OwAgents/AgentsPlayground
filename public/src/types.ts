export type Agent = {
  id: string; name: string; state: string; port?: number; url?: string; proxied?: boolean; error?: string; logs?: string[]
}

export type StatusPayload = {
  agents: Agent[]; worker?: { name?: string }; version?: { versionCode?: string | number; versionName?: string };
  lifecycle?: { expiresAt?: string } | null
}

export type Skill = {
  name: string; displayName?: string; owner: string; description: string; installed: boolean;
  source?: string; path?: string; url: string; installCountLabel?: string; content?: string; baseline?: boolean
}

export type RuleAdapter = {
  id: string; installed: boolean; targetPath: string | null; injected: boolean; skipped: boolean;
  reason: string | null; error: string | null
}

export type RuleSection = { id: string; title: string; content: string; enabled: boolean; removable: boolean }

export type RulesPayload = {
  ok: boolean; rulesPath: string; content: string; generated: string; effective: string; deployed: boolean; includeDeploymentRules: boolean;
  sections: RuleSection[];
  deployment: { publicUrl: string; workerHostPrefix: string; workerBaseHost: string; fileBrowserUrl: string } | null;
  adapters: RuleAdapter[]
}
