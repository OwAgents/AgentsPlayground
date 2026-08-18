<template>
  <section class="flex h-full min-h-0 flex-col bg-white">
    <header class="flex h-14 shrink-0 items-center border-b border-slate-200 px-4 sm:px-6">
      <button class="mr-3 rounded-lg p-2 text-slate-500 hover:bg-slate-100 lg:hidden" @click="$emit('open-menu')">☰</button>
      <div><h1 class="text-sm font-semibold text-slate-900">Skills</h1><p class="text-xs text-slate-500">Find and install capabilities for your agents</p></div>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-4xl px-4 py-8 sm:px-8">
        <div class="mb-8 rounded-2xl border border-emerald-100 bg-gradient-to-br from-emerald-50 to-white p-5 sm:p-6">
          <p class="text-xs font-medium text-emerald-700">SKILL HUB</p>
          <h2 class="mt-1 text-xl font-semibold tracking-tight text-slate-900">Give your agents new capabilities</h2>
          <p class="mt-1 max-w-2xl text-sm text-slate-500">Search and install capabilities with npx skills. Baseline skills are preinstalled during worker setup.</p>
          <form class="mt-5 flex gap-2" @submit.prevent="search">
            <div class="relative flex-1"><span class="absolute left-3 top-2.5 text-slate-400">⌕</span><input v-model="query" class="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none ring-emerald-500 focus:ring-2" placeholder="Search skills, e.g. browser automation" /></div>
            <button class="rounded-xl bg-slate-900 px-4 text-sm font-medium text-white hover:bg-black disabled:opacity-50" :disabled="searching || query.trim().length < 2">{{ searching ? 'Searching…' : 'Search' }}</button>
          </form>
          <p v-if="error" class="mt-2 text-xs text-rose-600">{{ error }}</p>
        </div>

        <section v-if="results.length" class="mb-9">
          <div class="mb-3 flex items-center justify-between"><h3 class="text-sm font-semibold text-slate-800">Search results</h3><span class="text-xs text-slate-400">{{ results.length }} found</span></div>
          <div class="grid gap-3 sm:grid-cols-2"><SkillCard v-for="skill in results" :key="skill.source" :skill="merged(skill)" @select="open" /></div>
        </section>
        <section>
          <div class="mb-3 flex items-center justify-between"><h3 class="text-sm font-semibold text-slate-800">Installed skills</h3><button class="text-xs text-slate-400 hover:text-slate-700" @click="loadInstalled">Refresh</button></div>
          <div v-if="loading" class="rounded-xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-400">Loading skills…</div>
          <div v-else-if="!installed.length" class="rounded-xl border border-dashed border-slate-200 p-8 text-center"><p class="text-sm font-medium text-slate-700">No skills installed yet</p><p class="mt-1 text-xs text-slate-400">Search above to add your first skill.</p></div>
          <div v-else class="grid gap-3 sm:grid-cols-2"><SkillCard v-for="skill in installed" :key="skill.path" :skill="skill" :show-owner="false" @select="open" /></div>
        </section>
      </div>
    </div>

    <div v-if="detail" class="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" @click.self="detail = null">
      <div class="flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl">
        <div class="flex items-start justify-between p-5 pb-3"><div><h3 class="text-lg font-semibold text-slate-900">{{ detail.displayName || detail.name }}</h3><p class="text-xs text-slate-400">{{ detail.owner }}</p></div><button class="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" @click="detail = null">✕</button></div>
        <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-5"><p v-if="detail.description" class="text-sm leading-relaxed text-slate-600">{{ detail.description }}</p><pre v-if="detail.content" class="mt-4 whitespace-pre-wrap border-t border-slate-100 pt-4 text-xs leading-relaxed text-slate-600">{{ withoutFrontmatter(detail.content) }}</pre><a v-if="detail.url" :href="detail.url" target="_blank" class="mt-4 inline-block text-xs text-blue-600 hover:underline">View source ↗</a></div>
        <div class="flex items-center justify-end gap-2 border-t border-slate-100 p-4"><span v-if="detail.installed" class="mr-auto text-xs font-medium text-emerald-600">✓ Installed</span><button v-if="!detail.installed" class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" :disabled="installing" @click="install">{{ installing ? 'Installing…' : 'Install skill' }}</button><button v-else class="rounded-lg border border-rose-200 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50" :disabled="removing" @click="remove">{{ removing ? 'Removing…' : 'Uninstall skill' }}</button></div>
      </div>
    </div>
    <div v-if="toast" class="fixed bottom-5 left-1/2 z-[60] -translate-x-1/2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white shadow-xl">{{ toast }}</div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { Skill } from '../types'
import SkillCard from './SkillCard.vue'
defineEmits<{ 'open-menu': [] }>()
const installed = ref<Skill[]>([]), baseline = ref<Skill[]>([]), results = ref<Skill[]>([]), query = ref(''), error = ref(''), toast = ref('')
const loading = ref(false), searching = ref(false), installing = ref(false), removing = ref(false), detail = ref<Skill | null>(null)
function merged(skill: Skill) { const local = installed.value.find(item => item.name === skill.name); return local ? { ...skill, ...local, source: skill.source, url: skill.url || local.url } : skill }
async function loadInstalled() { loading.value = true; try { const r = await fetch('/api/skills-hub'); const data = await r.json(); if (!r.ok) throw new Error(data.error); baseline.value = data.baseline || []; const baselineNames = new Set(baseline.value.map(skill => skill.name)); installed.value = (data.installed || []).map((skill: Skill) => ({ ...skill, baseline: baselineNames.has(skill.name) })) } catch (e) { error.value = e instanceof Error ? e.message : 'Failed to load skills.' } finally { loading.value = false } }
async function search() { searching.value = true; error.value = ''; try { const r = await fetch(`/api/skills-hub/search?q=${encodeURIComponent(query.value.trim())}`); const data = await r.json(); if (!r.ok) throw new Error(data.error); results.value = data.results || []; if (!results.value.length) toastFor('No matching skills found.') } catch (e) { error.value = e instanceof Error ? e.message : 'Search failed.' } finally { searching.value = false } }
async function open(skill: Skill) { detail.value = skill; if (skill.installed) { try { const r = await fetch(`/api/skills-hub/readme?name=${encodeURIComponent(skill.name)}`); if (r.ok) detail.value = { ...skill, ...await r.json() } } catch {} } }
async function install() { if (!detail.value?.source) return; installing.value = true; try { const r = await fetch('/api/skills-hub/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: detail.value.source, name: detail.value.name }) }); const data = await r.json(); if (!r.ok || !data.ok) throw new Error(data.error); await loadInstalled(); toastFor(`${detail.value.displayName || detail.value.name} installed`); detail.value = null } catch (e) { toastFor(e instanceof Error ? e.message : 'Installation failed.') } finally { installing.value = false } }
async function remove() { if (!detail.value?.name) return; removing.value = true; try { const name = detail.value.name; const r = await fetch('/api/skills-hub/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }); const data = await r.json(); if (!r.ok || !data.ok) throw new Error(data.error); await loadInstalled(); toastFor(`${detail.value.displayName || name} uninstalled`); detail.value = null } catch (e) { toastFor(e instanceof Error ? e.message : 'Uninstallation failed.') } finally { removing.value = false } }
function toastFor(message: string) { toast.value = message; window.setTimeout(() => { toast.value = '' }, 3000) }
function withoutFrontmatter(content: string) { return content.replace(/^---[\s\S]*?---\s*/, '').slice(0, 12000) }
onMounted(loadInstalled)
</script>
