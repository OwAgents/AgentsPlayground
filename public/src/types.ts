export type Agent = {
  id: string; name: string; state: string; port?: number; url?: string; proxied?: boolean; error?: string; logs?: string[]
}

export type StatusPayload = {
  agents: Agent[]; worker?: { name?: string }; version?: { versionCode?: string | number; versionName?: string }
}

export type Skill = {
  name: string; displayName?: string; owner: string; description: string; installed: boolean;
  source?: string; path?: string; url: string; installCountLabel?: string; content?: string
}
