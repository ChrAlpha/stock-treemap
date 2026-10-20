<script setup lang="ts">
import type { Stock } from '~shared/snapshot'
import { onKeyStroke } from '@vueuse/core'
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  /** Everything searchable, in the order to rank ties. */
  stocks: Stock[]
  /** Symbols in the current universe; others are labelled. */
  inUniverse: Set<string>
}>()

const emit = defineEmits<{ pick: [stock: Stock] }>()
const query = defineModel<string>({ default: '' })

const input = ref<HTMLInputElement>()
const open = ref(false)
const cursor = ref(0)

const results = computed(() => {
  const q = query.value.trim().toUpperCase()
  if (!q)
    return []
  const starts: Stock[] = []
  const names: Stock[] = []
  for (const s of props.stocks) {
    if (s.symbol.startsWith(q))
      starts.push(s)
    else if (q.length >= 2 && s.name.toUpperCase().includes(q))
      names.push(s)
  }
  // Exact ticker, then what's on the current map, then by size; name matches after tickers.
  const here = (s: Stock) => Number(props.inUniverse.has(s.symbol))
  const rank = (a: Stock, b: Stock) => Number(b.symbol === q) - Number(a.symbol === q) || here(b) - here(a) || b.marketCap - a.marketCap
  return [...starts.sort(rank), ...names.sort(rank)].slice(0, 8)
})

watch(results, () => {
  cursor.value = 0
})

function pick(s: Stock | undefined) {
  if (!s)
    return
  emit('pick', s)
  open.value = false
  input.value?.blur()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    cursor.value = Math.min(cursor.value + 1, results.value.length - 1)
    e.preventDefault()
  }
  else if (e.key === 'ArrowUp') {
    cursor.value = Math.max(cursor.value - 1, 0)
    e.preventDefault()
  }
  else if (e.key === 'Enter') {
    pick(results.value[cursor.value])
  }
  else if (e.key === 'Escape') {
    query.value = ''
    open.value = false
    input.value?.blur()
    e.stopPropagation()
  }
}

onKeyStroke('/', (e) => {
  const target = e.target as HTMLElement | null
  if (target?.closest('input, textarea'))
    return
  e.preventDefault()
  input.value?.focus()
})
</script>

<template>
  <div class="relative">
    <label class="group flex h-8 w-[200px] items-center gap-2 rounded-md bg-paper-card px-2.5 shadow-[0_0_0_1px_#dbe1e4] transition-shadow focus-within:shadow-[0_0_0_1.5px_#1c232d] max-sm:w-full">
      <svg viewBox="0 0 16 16" class="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
      <input
        ref="input"
        v-model="query"
        class="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-ink-3"
        placeholder="代码或公司名"
        aria-label="搜索股票"
        autocomplete="off"
        spellcheck="false"
        role="combobox"
        :aria-expanded="open && results.length > 0"
        aria-controls="search-results"
        @focus="open = true"
        @blur="open = false"
        @keydown="onKey"
      >
      <kbd v-if="!query" class="rounded border border-rule px-1 text-[10.5px] leading-4 text-ink-3 font-sans max-sm:hidden">/</kbd>
    </label>
    <ul
      v-if="open && results.length"
      id="search-results"
      role="listbox"
      class="absolute right-0 top-[calc(100%+6px)] z-30 m-0 w-[280px] list-none rounded-[10px] bg-paper-card p-1 shadow-[0_0_0_1px_rgba(28,35,45,0.08),0_12px_32px_-8px_rgba(28,35,45,0.22)] max-sm:left-0 max-sm:w-auto"
    >
      <li
        v-for="(s, i) in results"
        :key="s.symbol"
        role="option"
        :aria-selected="i === cursor"
        class="flex cursor-pointer items-baseline gap-2 rounded-md px-2.5 py-1.5"
        :class="i === cursor ? 'bg-paper-deep' : ''"
        @mousedown.prevent="pick(s)"
        @mouseenter="cursor = i"
      >
        <span class="w-14 shrink-0 font-650 [font-stretch:90%]">{{ s.symbol }}</span>
        <span class="min-w-0 flex-1 truncate text-[12px] text-ink-2">{{ s.name }}</span>
        <span v-if="!inUniverse.has(s.symbol)" class="shrink-0 text-[10.5px] text-ink-3">全市场</span>
      </li>
    </ul>
  </div>
</template>
