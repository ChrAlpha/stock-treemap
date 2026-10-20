<script setup lang="ts">
import type { Scale } from '../lib/scale'
import type { IndexQuote, Period, Universe } from '~shared/snapshot'
import { computed } from 'vue'
import { count, pct, price } from '../lib/format'
import { UNIVERSE_INDEX, UNIVERSE_LABEL } from '../lib/labels'
import { UNIVERSES } from '~shared/snapshot'

const props = defineProps<{
  indices: IndexQuote[]
  period: Period
  scale: Scale
  /** Cap-weighted change per universe for the period, from constituents. */
  weighted: Record<Universe, number | null>
  counts: Record<Universe, number>
}>()

const model = defineModel<Universe>({ required: true })

const items = computed(() => UNIVERSES.map((u) => {
  const quote = props.indices.find(q => q.symbol === UNIVERSE_INDEX[u])
  // Indices have no pre/post figure; fall back to constituents, then to the day.
  const change = quote?.change[props.period] ?? props.weighted[u] ?? quote?.change.d1 ?? null
  return {
    id: u,
    label: UNIVERSE_LABEL[u],
    value: quote ? price(quote.price) : `${count(props.counts[u])} 只`,
    change,
  }
}))

const vix = computed(() => props.indices.find(q => q.symbol === 'VIX'))
</script>

<template>
  <nav class="scroll-x flex items-stretch gap-1 -mx-2 px-2" aria-label="股票池">
    <button
      v-for="item in items"
      :key="item.id"
      class="focus-ring group relative shrink-0 rounded-md px-2.5 pb-2 pt-1.5 text-left transition-colors duration-150"
      :class="model === item.id ? 'text-ink' : 'text-ink-2 hover:text-ink hover:bg-paper-deep/70'"
      :aria-pressed="model === item.id"
      @click="model = item.id"
    >
      <span class="block text-[12px] leading-4" :class="model === item.id ? 'font-600' : 'font-500'">{{ item.label }}</span>
      <span class="tnum mt-0.5 flex items-baseline gap-2 whitespace-nowrap text-[13px] leading-4">
        <span class="font-500 text-ink max-sm:hidden">{{ item.value }}</span>
        <span class="font-550" :style="{ color: scale.ink(item.change) }">{{ pct(item.change) }}</span>
      </span>
      <span
        class="absolute inset-x-2.5 bottom-0.5 h-0.5 rounded-full bg-ink transition-transform duration-200 origin-left"
        :class="model === item.id ? 'scale-x-100' : 'scale-x-0'"
      />
    </button>
    <div v-if="vix" class="ml-2 hidden shrink-0 flex-col justify-center border-l border-rule pl-4 pr-1 lg:flex" title="CBOE 波动率指数">
      <span class="text-[12px] leading-4 text-ink-3">VIX 恐慌指数</span>
      <span class="tnum mt-0.5 flex items-baseline gap-2 text-[13px] leading-4">
        <span class="font-500">{{ vix.price.toFixed(2) }}</span>
        <span class="text-ink-2">{{ pct(vix.change.d1) }}</span>
      </span>
    </div>
  </nav>
</template>
