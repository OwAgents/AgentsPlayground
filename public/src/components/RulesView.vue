<template>
  <section class="flex h-full min-h-0 flex-col bg-white">
    <header class="flex h-14 shrink-0 items-center border-b border-slate-200 px-4 sm:px-6">
      <button class="mr-3 rounded-lg p-2 text-slate-500 hover:bg-slate-100 lg:hidden" @click="$emit('open-menu')">☰</button>
      <div><h1 class="text-sm font-semibold text-slate-900">Rules</h1><p class="text-xs text-slate-500">Mandatory instructions shared with installed agents</p></div>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-4xl px-4 py-8 sm:px-8">
        <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div><p class="text-xs font-medium text-violet-700">MANDATORY RULES</p><h2 class="mt-1 text-lg font-semibold text-slate-900">Rule sections</h2><p class="mt-1 text-sm text-slate-500">Expand, enable, edit, add, or remove sections before injecting them.</p></div>
          <div class="flex items-center gap-2"><span class="rounded-full px-2.5 py-1 text-xs font-medium" :class="rules.deployed ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'">{{ rules.deployed ? 'Deployed worker' : 'Local mode' }}</span><button class="grid h-8 w-8 place-items-center rounded-lg bg-violet-700 text-lg text-white hover:bg-violet-800" title="Add rule section" @click="addSection">+</button></div>
        </div>

        <div class="space-y-3">
          <details open class="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <summary class="section-summary"><input v-model="includeDeploymentRules" type="checkbox" class="h-4 w-4 accent-violet-700" @click.stop /><span class="min-w-0 flex-1 text-sm font-medium text-slate-800">Deployment rules</span><span class="text-xs text-slate-400">{{ includeDeploymentRules ? 'Enabled' : 'Disabled' }}</span><span class="section-chevron" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none"><path d="m6 8 4 4 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg></span></summary>
            <textarea :value="rules.generated" readonly class="min-h-56 w-full resize-y border-0 bg-white p-4 font-mono text-xs leading-relaxed text-slate-500 outline-none" placeholder="Deployment rules are available only on a deployed worker." />
          </details>

          <details v-for="section in sections" :key="section.id" open class="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <summary class="section-summary"><input v-model="section.enabled" type="checkbox" class="h-4 w-4 accent-violet-700" @click.stop /><input v-model="section.title" class="min-w-0 flex-1 bg-transparent text-sm font-medium text-slate-800 outline-none" @click.stop /><button v-if="section.removable" class="grid h-7 w-7 place-items-center rounded-full text-lg text-rose-500 hover:bg-rose-50" title="Remove section" @click.prevent.stop="removeSection(section.id)">−</button><span class="section-chevron" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none"><path d="m6 8 4 4 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg></span></summary>
            <textarea v-model="section.content" class="min-h-48 w-full resize-y border-0 bg-white p-4 font-mono text-xs leading-relaxed text-slate-700 outline-none" :placeholder="section.id === 'shared' ? 'Add mandatory rules for agents on this worker…' : 'Add rules for this section…'" />
          </details>
        </div>

        <div class="mt-4 flex flex-wrap items-center justify-between gap-3"><p class="text-xs text-slate-400">Running conversations are unchanged. Start a new session after saving.</p><button class="rounded-xl bg-violet-700 px-4 py-2 text-sm font-medium text-white hover:bg-violet-800 disabled:opacity-50" :disabled="saving || loading" @click="saveRules">{{ saving ? 'Saving…' : 'Save and inject' }}</button></div>
        <p v-if="message" class="mt-2 text-xs" :class="hasError ? 'text-rose-600' : 'text-emerald-600'">{{ message }}</p>

        <section class="mt-8 rounded-2xl border border-slate-200 bg-white p-4 sm:px-6">
          <div class="mb-2 flex items-center justify-between"><h3 class="text-xs font-semibold text-slate-700">Agent adapters</h3><span class="text-[10px] text-slate-400">New sessions load saved rules</span></div>
          <div class="grid gap-2 sm:grid-cols-2">
            <details v-for="adapter in rules.adapters" :key="adapter.id" class="adapter-details rounded-lg border border-slate-100 bg-slate-50 text-xs"><summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5"><span class="min-w-0 flex-1 font-medium text-slate-700">{{ adapter.id }}</span><span :class="adapter.error ? 'text-rose-600' : adapter.injected ? 'text-emerald-600' : 'text-slate-400'">{{ adapter.error ? 'Error' : adapter.injected ? 'Injected' : adapter.skipped ? 'Skipped' : 'Ready' }}</span><span class="section-chevron small" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none"><path d="m6 8 4 4 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg></span></summary><div class="border-t border-slate-100 px-3 py-2"><p class="break-all text-[10px] text-slate-400">{{ adapter.targetPath || adapter.reason || 'No target' }}</p><p v-if="adapter.error" class="mt-1 text-[10px] text-rose-600">{{ adapter.error }}</p></div></details>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { RuleSection, RulesPayload } from '../types'
defineEmits<{ 'open-menu': [] }>()
const emptyRules: RulesPayload = { ok: true, rulesPath: '', content: '', generated: '', effective: '', deployed: false, includeDeploymentRules: false, deployment: null, sections: [], adapters: [] }
const rules = ref<RulesPayload>(emptyRules), sections = ref<RuleSection[]>([]), includeDeploymentRules = ref(false), loading = ref(false), saving = ref(false), message = ref(''), hasError = ref(false)
function applyPayload(data: RulesPayload) { rules.value = data; sections.value = (data.sections || []).map(section => ({ ...section })); includeDeploymentRules.value = Boolean(data.includeDeploymentRules) }
async function loadRules() { loading.value = true; try { const response = await fetch('/api/rules'); const data = await response.json(); if (!response.ok) throw new Error(data.error); applyPayload(data) } catch (error) { hasError.value = true; message.value = error instanceof Error ? error.message : 'Failed to load rules.' } finally { loading.value = false } }
function addSection() { sections.value.push({ id: `custom-${Date.now()}`, title: 'New section', content: '', enabled: true, removable: true }) }
function removeSection(id: string) { sections.value = sections.value.filter(section => section.id !== id) }
async function saveRules() { saving.value = true; message.value = ''; hasError.value = false; try { const response = await fetch('/api/rules', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '', includeDeploymentRules: includeDeploymentRules.value, sections: sections.value }) }); const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error); applyPayload(data); const failed = data.adapters.filter((adapter: { error: string | null }) => adapter.error).length; message.value = failed ? `Rules saved with ${failed} adapter error${failed === 1 ? '' : 's'}.` : 'Rules saved and injected. Start a new agent session to use them.'; hasError.value = failed > 0 } catch (error) { hasError.value = true; message.value = error instanceof Error ? error.message : 'Rules save failed.' } finally { saving.value = false } }
onMounted(loadRules)
</script>

<style scoped>
@reference "tailwindcss";
.section-summary { @apply flex cursor-pointer list-none items-center gap-3 bg-slate-50 px-4 py-3 transition hover:bg-slate-100; }
.section-summary::-webkit-details-marker, .adapter-details summary::-webkit-details-marker { display: none; }
.section-chevron { @apply grid h-7 w-7 shrink-0 place-items-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition-transform duration-200; }
.section-chevron svg { @apply h-4 w-4; }
.section-chevron.small { @apply h-6 w-6; }
details[open] > summary .section-chevron { transform: rotate(180deg); }
</style>
