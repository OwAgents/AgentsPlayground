<template><button class="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-3 text-left transition hover:border-slate-300 hover:shadow-sm" @click="$emit('select', skill)"><div class="flex w-full items-start gap-2.5"><div class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-medium uppercase text-slate-500">{{ skill.owner.charAt(0) }}</div><div class="min-w-0 flex-1"><div class="flex items-center gap-2"><span class="truncate text-sm font-medium text-slate-900">{{ skill.displayName || skill.name }}</span><span v-if="skill.installed" class="rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium leading-none text-emerald-700">Installed</span><span v-if="skill.baseline" class="rounded-md border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium leading-none text-blue-700">Preinstalled</span></div><span v-if="showOwner" class="text-xs text-slate-400">{{ skill.owner }}</span></div></div><p v-if="skill.description" class="m-0 line-clamp-2 text-xs text-slate-500">{{ skill.description }}</p><span v-if="skill.installCountLabel" class="text-[10px] text-slate-400">{{ skill.installCountLabel }}</span></button></template>
<script setup lang="ts">
import type { Skill } from '../types'

withDefaults(defineProps<{
  skill: Skill
  showOwner?: boolean
}>(), {
  showOwner: true,
})

defineEmits<{
  select: [skill: Skill]
}>()
</script>
