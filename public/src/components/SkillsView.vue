<template>
  <section class="flex h-full min-h-0 flex-col bg-white">
    <header class="flex h-14 shrink-0 items-center border-b border-slate-200 px-4 sm:px-6">
      <button class="mr-3 rounded-lg p-2 text-slate-500 hover:bg-slate-100 lg:hidden" @click="$emit('open-menu')">☰</button>
      <div><h1 class="text-sm font-semibold text-slate-900">Skills</h1><p class="text-xs text-slate-500">Find and install capabilities for your agents</p></div>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-4xl px-4 py-8 sm:px-8">
        <section class="mb-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div class="border-b border-slate-100 p-5 sm:p-6">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div><p class="text-xs font-medium text-violet-700">MANDATORY RULES</p><h2 class="mt-1 text-lg font-semibold text-slate-900">Shared agent instructions</h2><p class="mt-1 text-sm text-slate-500">Saved on this worker and injected into every supported installed agent.</p></div>
              <span class="rounded-full px-2.5 py-1 text-xs font-medium" :class="rules.deployed ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'">{{ rules.deployed ? 'Deployed worker' : 'Local mode' }}</span>
            </div>
            <textarea v-model="rulesText" class="mt-4 min-h-40 w-full resize-y rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-700 outline-none ring-violet-500 focus:bg-white focus:ring-2" placeholder="Add mandatory rules for agents on this worker…" />
            <div class="mt-3 flex flex-wrap items-center justify-between gap-3"><p class="text-xs text-slate-400">Running conversations are unchanged. Start a new session after saving.</p><button class="rounded-xl bg-violet-700 px-4 py-2 text-sm font-medium text-white hover:bg-violet-800 disabled:opacity-50" :disabled="savingRules || loadingRules" @click="saveRules">{{ savingRules ? 'Saving…' : 'Save and inject' }}</button></div>
            <p v-if="rulesMessage" class="mt-2 text-xs" :class="rulesError ? 'text-rose-600' : 'text-emerald-600'">{{ rulesMessage }}</p>
          </div>
          <div class="grid gap-px bg-slate-100 lg:grid-cols-2">
            <details class="bg-white p-4"><summary class="cursor-pointer text-xs font-medium text-slate-700">Generated deployment rules</summary><pre class="mt-3 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-slate-500">{{ rules.generated || 'No deployment rules in local mode.' }}</pre></details>
            <details class="bg-white p-4"><summary class="cursor-pointer text-xs font-medium text-slate-700">Effective rules preview</summary><pre class="mt-3 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-slate-500">{{ rules.effective || 'No rules configured.' }}</pre></details>
          </div>
          <div class="border-t border-slate-100 p-4 sm:px-6">
            <div class="mb-2 flex items-center justify-between"><h3 class="text-xs font-semibold text-slate-700">Agent adapters</h3><span class="text-[10px] text-slate-400">{{ rules.rulesPath }}</span></div>
            <div class="grid gap-2 sm:grid-cols-2">
              <div v-for="adapter in rules.adapters" :key="adapter.id" class="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs">
                <div class="flex items-center justify-between gap-2"><span class="font-medium text-slate-700">{{ adapter.id }}</span><span :class="adapter.error ? 'text-rose-600' : adapter.injected ? 'text-emerald-600' : 'text-slate-400'">{{ adapter.error ? 'Error' : adapter.injected ? 'Injected' : adapter.skipped ? 'Skipped' : 'Ready' }}</span></div>
                <p class="mt-1 truncate text-[10px] text-slate-400" :title="adapter.targetPath || adapter.reason || ''">{{ adapter.targetPath || adapter.reason || 'No target' }}</p>
                <p v-if="adapter.error" class="mt-1 text-[10px] text-rose-600">{{ adapter.error }}</p>
              </div>
            </div>
          </div>
        </section>

        <div class="mb-8 rounded-2xl border border-emerald-100 bg-gradient-to-br from-emerald-50 to-white p-5 sm:p-6">
          <p class="text-xs font-medium text-emerald-700">SKILL HUB</p>
          <h2 class="mt-1 text-xl font-semibold tracking-tight text-slate-900">Give your agents new capabilities</h2>
          <p class="mt-1 max-w-2xl text-sm text-slate-500">Search the open skills ecosystem, inspect a result, and install it globally on this worker.</p>
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
        <div class="flex items-center justify-end gap-2 border-t border-slate-100 p-4"><span v-if="detail.installed" class="mr-auto text-xs font-medium text-emerald-600">✓ Installed</span><button v-if="!detail.installed" class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" :disabled="installing" @click="install">{{ installing ? 'Installing…' : 'Install skill' }}</button></div>
      </div>
    </div>
    <div v-if="toast" class="fixed bottom-5 left-1/2 z-[60] -translate-x-1/2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white shadow-xl">{{ toast }}</div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { RulesPayload, Skill } from '../types'
import SkillCard from './SkillCard.vue'
defineEmits<{ 'open-menu': [] }>()
const installed = ref<Skill[]>([]), results = ref<Skill[]>([]), query = ref(''), error = ref(''), toast = ref('')
const loading = ref(false), searching = ref(false), installing = ref(false), detail = ref<Skill | null>(null)
const emptyRules: RulesPayload = { ok: true, rulesPath: '', content: '', generated: '', effective: '', deployed: false, deployment: null, adapters: [] }
const rules = ref<RulesPayload>(emptyRules), rulesText = ref(''), loadingRules = ref(false), savingRules = ref(false), rulesMessage = ref(''), rulesError = ref(false)
function merged(skill: Skill) { const local = installed.value.find(item => item.name === skill.name); return local ? { ...skill, ...local, source: skill.source, url: skill.url || local.url } : skill }
async function loadInstalled() { loading.value = true; try { const r = await fetch('/api/skills-hub'); const data = await r.json(); if (!r.ok) throw new Error(data.error); installed.value = data.installed || [] } catch (e) { error.value = e instanceof Error ? e.message : 'Failed to load skills.' } finally { loading.value = false } }
async function search() { searching.value = true; error.value = ''; try { const r = await fetch(`/api/skills-hub/search?q=${encodeURIComponent(query.value.trim())}`); const data = await r.json(); if (!r.ok) throw new Error(data.error); results.value = data.results || []; if (!results.value.length) toastFor('No matching skills found.') } catch (e) { error.value = e instanceof Error ? e.message : 'Search failed.' } finally { searching.value = false } }
async function open(skill: Skill) { detail.value = skill; if (skill.installed) { try { const r = await fetch(`/api/skills-hub/readme?name=${encodeURIComponent(skill.name)}`); if (r.ok) detail.value = { ...skill, ...await r.json() } } catch {} } }
async function install() { if (!detail.value?.source) return; installing.value = true; try { const r = await fetch('/api/skills-hub/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: detail.value.source, name: detail.value.name }) }); const data = await r.json(); if (!r.ok || !data.ok) throw new Error(data.error); await loadInstalled(); toastFor(`${detail.value.displayName || detail.value.name} installed`); detail.value = null } catch (e) { toastFor(e instanceof Error ? e.message : 'Installation failed.') } finally { installing.value = false } }
async function loadRules() { loadingRules.value = true; try { const r = await fetch('/api/rules'); const data = await r.json(); if (!r.ok) throw new Error(data.error); rules.value = data; rulesText.value = data.content || '' } catch (e) { rulesError.value = true; rulesMessage.value = e instanceof Error ? e.message : 'Failed to load rules.' } finally { loadingRules.value = false } }
async function saveRules() { savingRules.value = true; rulesMessage.value = ''; rulesError.value = false; try { const r = await fetch('/api/rules', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: rulesText.value }) }); const data = await r.json(); if (!r.ok || !data.ok) throw new Error(data.error); rules.value = data; rulesText.value = data.content || ''; const failed = data.adapters.filter((adapter: { error: string | null }) => adapter.error).length; rulesMessage.value = failed ? `Rules saved with ${failed} adapter error${failed === 1 ? '' : 's'}.` : 'Rules saved and injected. Start a new agent session to use them.'; rulesError.value = failed > 0 } catch (e) { rulesError.value = true; rulesMessage.value = e instanceof Error ? e.message : 'Rules save failed.' } finally { savingRules.value = false } }
function toastFor(message: string) { toast.value = message; window.setTimeout(() => { toast.value = '' }, 3000) }
function withoutFrontmatter(content: string) { return content.replace(/^---[\s\S]*?---\s*/, '').slice(0, 12000) }
onMounted(() => { loadInstalled(); loadRules() })
</script>
