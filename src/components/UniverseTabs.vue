<script setup lang="ts">
import type { Scale } from '../lib/scale'
import type { MarketSpec } from '~shared/markets'
import type { IndexQuote, Period } from '~shared/snapshot'
import { computed } from 'vue'
import { count, pct, price } from '../lib/format'

const props = defineProps<{
  market: MarketSpec
  indices: IndexQuote[]
  period: Period
  scale: Scale
  /** Cap-weighted change per universe for the period, from constituents. */
  weighted: Record<string, number | null>
  counts: Record<string, number>
}>()

const model = defineModel<string>({ required: true })

const quote = (symbol?: string) => symbol ? props.indices.find(q => q.symbol === symbol) : undefined

const items = computed(() => props.market.universes.map((u) => {
  const q = quote(u.index)
  // Indices have no pre/post figure; fall back to constituents, then to the day.
  const change = q?.change[props.period] ?? props.weighted[u.id] ?? q?.change.d1 ?? null
  return {
    id: u.id,
    label: u.label,
    value: q ? price(q.price) : `${count(props.counts[u.id] ?? 0)} 只`,
    change,
  }
}))

const extras = computed(() => props.market.extras.flatMap((x) => {
  const q = quote(x.symbol)
  return q ? [{ ...x, price: q.price, change: q.change.d1 ?? null }] : []
}))
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
    <div
      v-for="(x, i) in extras"
      :key="x.symbol"
      class="hidden shrink-0 flex-col justify-center pl-4 pr-1 lg:flex"
      :class="i === 0 ? 'ml-2 border-l border-rule' : ''"
      :title="x.title"
    >
      <span class="text-[12px] leading-4 text-ink-3">{{ x.label }}</span>
      <span class="tnum mt-0.5 flex items-baseline gap-2 whitespace-nowrap text-[13px] leading-4">
        <span class="font-500">{{ price(x.price) }}</span>
        <span :class="x.neutral ? 'text-ink-2' : 'font-500'" :style="x.neutral ? undefined : { color: scale.ink(x.change) }">{{ pct(x.change) }}</span>
      </span>
    </div>
  </nav>
</template>
