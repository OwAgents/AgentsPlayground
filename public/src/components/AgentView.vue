<template>
  <section class="flex h-full min-h-0 flex-col bg-white">
    <header class="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 px-4 sm:px-6">
      <div class="flex min-w-0 items-center gap-3">
        <button class="rounded-lg p-2 text-slate-500 hover:bg-slate-100 lg:hidden" @click="$emit('open-menu')">☰</button>
        <div class="min-w-0">
          <h1 class="truncate text-sm font-semibold text-slate-900">Worker Agents</h1>
          <p class="truncate text-xs text-slate-500">{{ workerName }}</p>
        </div>
      </div>
      <div class="flex items-center gap-2 text-xs text-slate-500">
        <span v-if="timeLeft" data-testid="worker-time-left-mobile" class="rounded-full border border-slate-200 bg-white px-2.5 py-1 font-mono font-semibold tabular-nums text-slate-700 lg:hidden">{{ timeLeft }}</span>
        <span class="hidden rounded-full border border-slate-200 bg-white px-2.5 py-1 sm:inline">{{ runningCount }}/{{ visibleAgents.length }} running</span>
        <span class="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1">
          <i class="h-1.5 w-1.5 rounded-full" :class="connected ? 'bg-emerald-500' : 'bg-amber-500'"></i>{{ connected ? 'Live' : 'Connecting' }}
        </span>
      </div>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-4xl px-4 py-8 sm:px-8">
        <div class="mb-6">
          <h2 class="text-xl font-semibold tracking-tight text-slate-900">Your worker</h2>
          <p class="mt-1 text-sm text-slate-500">Launch, inspect, and control the agent apps available on this machine.</p>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <article v-for="agent in visibleAgents" :key="agent.id" class="rounded-xl border border-slate-200 bg-white p-4 transition hover:border-slate-300 hover:shadow-sm">
            <div class="flex items-start gap-3">
              <div class="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-xl bg-slate-100 text-sm font-semibold text-slate-500">
                <img v-if="iconFor(agent)" :src="iconFor(agent)" alt="" class="h-full w-full object-cover" />
                <span v-else>{{ agent.name.slice(0, 1) }}</span>
              </div>
              <div class="min-w-0 flex-1">
                <h3 class="truncate text-sm font-medium text-slate-900">{{ agent.name }}</h3>
                <span class="mt-1 inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-medium capitalize" :class="stateClass(agent.state)">{{ agent.state }}</span>
              </div>
              <a :href="agentUrl(agent)" target="_blank" rel="noreferrer" class="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-black" :class="agent.state !== 'running' && 'pointer-events-none opacity-30'">Open ↗</a>
            </div>
            <p v-if="agent.error" class="mt-3 line-clamp-2 text-xs text-rose-600">{{ agent.error }}</p>
            <div class="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
              <button class="action" :disabled="isBusy(agent) || agent.state === 'running'" @click="act(agent, 'start')">Start</button>
              <button v-if="!isGuestDemo" class="action" :disabled="isBusy(agent)" @click="act(agent, 'restart')">Restart</button>
              <button v-if="!isGuestDemo" class="action" :disabled="isBusy(agent)" @click="act(agent, 'reinstall')">Reinstall</button>
              <button v-if="!isGuestDemo" class="action text-rose-600" :disabled="isBusy(agent) || !canStop(agent)" @click="act(agent, 'stop')">Stop</button>
              <button class="action ml-auto" @click="selectLogs(agent)">View logs</button>
            </div>
          </article>
        </div>

        <section class="mt-8 overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div class="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <div><p class="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Runtime output</p><h3 class="text-sm font-medium text-slate-900">{{ selected?.name || 'No agent selected' }}</h3></div>
            <select v-model="selectedId" class="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600"><option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select>
          </div>
          <pre class="m-0 max-h-96 min-h-52 overflow-auto bg-slate-950 p-4 text-xs leading-relaxed text-slate-300">{{ (selected?.logs || []).join('\n') || 'No activity yet.' }}</pre>
        </section>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Agent } from '../types'
const props = defineProps<{ agents: Agent[]; workerName: string; connected: boolean; timeLeft: string }>()
defineEmits<{ 'open-menu': [] }>()
const selectedId = ref('')
const visibleAgents = computed(() => props.agents.filter(agent => agent.id !== '__console__'))
watch(() => props.agents, (agents) => { if (!agents.some(a => a.id === selectedId.value)) selectedId.value = agents[0]?.id || '' }, { immediate: true })
const selected = computed(() => props.agents.find(a => a.id === selectedId.value))
const runningCount = computed(() => visibleAgents.value.filter(a => a.state === 'running').length)
const isGuestDemo = (location.hostname === 'guest.agentsweb.space' || location.hostname.startsWith('guest-demo-')) && location.hostname.endsWith('.agentsweb.space')
const icons: Record<string, string> = { 'codex-web-local': '/icons/codex.png', opencode: '/icons/opencode.png', 'hermes-webui': '/icons/hermes.png', 'agent-zero': '/icons/agent-zero.png', openclaw: '/icons/openclaw.png', 'deepseek-harness': '/icons/deepseek.svg' }
const iconFor = (agent: Agent) => icons[agent.id] || ''
const isBusy = (agent: Agent) => ['installing', 'starting', 'stopping'].includes(agent.state)
const canStop = (agent: Agent) => ['running', 'error', 'starting', 'installing'].includes(agent.state)
const stateClass = (state: string) => state === 'running' ? 'bg-emerald-50 text-emerald-700' : state === 'error' ? 'bg-rose-50 text-rose-700' : isBusy({ state } as Agent) ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'
function agentUrl(agent: Agent) {
  if (!agent.port) return agent.url || '#'
  const source = new URL(agent.url || '/', location.href)
  if (agent.proxied) {
    const target = new URL(`/proxy/${encodeURIComponent(agent.id)}${source.pathname}`, location.href)
    target.search = source.search
    target.hash = source.hash
    return target.toString()
  }
  const current = new URL(location.href)
  const suffix = '.agentsweb.space'
  const isAgentsWeb = current.hostname.endsWith(suffix)
  const isHttps = current.protocol === 'https:'
  if (isAgentsWeb && isHttps) {
    const rawBase = current.hostname.slice(0, -suffix.length).replace(/-\d+$/, '')
    source.protocol = 'https:'
    source.hostname = `${rawBase}-${agent.port}${suffix}`
    source.port = ''
  } else {
    source.protocol = current.protocol
    source.hostname = current.hostname
    source.port = String(agent.port)
  }
  return source.toString()
}
async function act(agent: Agent, action: string) { await fetch(`/api/agents/${encodeURIComponent(agent.id)}/${action}`, { method: 'POST' }) }
function selectLogs(agent: Agent) { selectedId.value = agent.id; document.querySelector('pre')?.scrollIntoView({ behavior: 'smooth' }) }
</script>

<style scoped>
@reference "tailwindcss";
.action { @apply rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-35; }
</style>
