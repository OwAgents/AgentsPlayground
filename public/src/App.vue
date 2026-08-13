<template>
  <div class="grid h-dvh grid-cols-1 overflow-hidden bg-slate-100 text-slate-900 lg:grid-cols-[280px_minmax(0,1fr)]">
    <div v-if="menuOpen" class="fixed inset-0 z-30 bg-black/40 lg:hidden" @click="menuOpen = false"></div>
    <aside class="fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-slate-200 bg-slate-100 transition-transform lg:static lg:w-auto" :class="menuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'">
      <div class="flex h-16 items-center gap-3 px-4"><div class="grid h-8 w-8 place-items-center rounded-lg bg-slate-900 text-sm font-semibold text-white">W</div><div><p class="text-sm font-semibold text-slate-900">Worker Agents</p><p class="text-[11px] text-slate-500">{{ workerName }}</p></div></div>
      <nav class="space-y-1 px-3">
        <button class="nav-row" :class="view === 'agents' && 'active'" @click="go('agents')"><span>▦</span>Agents</button>
        <button class="nav-row skill-link" :class="view === 'skills' && 'active'" @click="go('skills')"><span>✦</span><span class="flex-1 text-left">Skills</span><span class="rounded-full bg-emerald-100 px-1.5 text-[10px] text-emerald-700">Hub</span></button>
      </nav>
      <div class="mt-auto border-t border-slate-200 p-3"><div class="rounded-xl bg-white p-3 text-xs text-slate-500"><div class="flex justify-between"><span>Connection</span><span class="font-medium" :class="connected ? 'text-emerald-600' : 'text-amber-600'">{{ connected ? 'Live' : 'Reconnecting' }}</span></div><div v-if="version" class="mt-2 flex justify-between"><span>Build</span><span>{{ version }}</span></div></div></div>
    </aside>
    <main class="min-h-0 min-w-0"><AgentView v-if="view === 'agents'" :agents="status.agents" :worker-name="workerName" :connected="connected" @open-menu="menuOpen = true" /><SkillsView v-else @open-menu="menuOpen = true" /></main>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import AgentView from './components/AgentView.vue'
import SkillsView from './components/SkillsView.vue'
import type { StatusPayload } from './types'
const status = ref<StatusPayload>({ agents: [] }), connected = ref(false), menuOpen = ref(false)
const view = ref(location.hash === '#skills' ? 'skills' : 'agents')
const workerName = computed(() => status.value.worker?.name || 'Worker')
const version = computed(() => status.value.version ? `${status.value.version.versionName || ''} (${status.value.version.versionCode || ''})` : '')
async function go(next: 'agents' | 'skills') {
  view.value = next
  location.hash = next === 'skills' ? 'skills' : ''
  menuOpen.value = false
  await nextTick()
  document.querySelector('main > section > div.overflow-y-auto')?.scrollTo({ top: 0 })
}
async function refresh() { const r = await fetch('/api/status'); if (!r.ok) throw new Error(`Status failed: ${r.status}`); status.value = await r.json() }
function events() { const stream = new EventSource('/api/events'); stream.addEventListener('open', () => connected.value = true); stream.addEventListener('status', event => { connected.value = true; status.value = JSON.parse((event as MessageEvent).data) }); stream.addEventListener('error', () => connected.value = false) }
onMounted(async () => { try { await refresh(); events() } catch { connected.value = false } })
</script>

<style scoped>
@reference "tailwindcss";
.nav-row { @apply flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-200; }
.nav-row.active { @apply bg-slate-200 font-medium text-slate-900; }
.skill-link { @apply border border-emerald-100 bg-gradient-to-r from-emerald-50 to-transparent hover:border-emerald-200 hover:bg-emerald-50; }
</style>
