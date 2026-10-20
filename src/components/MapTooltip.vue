<script setup lang="ts">
import type { Scale } from '../lib/scale'
import type { Period, Stock } from '~shared/snapshot'
import { computed, ref, watchEffect } from 'vue'
import { money, pct, price } from '../lib/format'
import { PERIOD_SHORT } from '../lib/labels'
import { industryName, sectorName } from '~shared/taxonomy'

const props = defineProps<{
  stock: Stock
  x: number
  y: number
  /** Map size, for keeping the card inside. */
  bounds: { width: number, height: number }
  period: Period
  periods: Period[]
  scale: Scale
  peers: Stock[]
  pinned: boolean
}>()

const emit = defineEmits<{ close: [] }>()

const card = ref<HTMLElement>()
const size = ref({ w: 280, h: 300 })
watchEffect(() => {
  void props.stock
  if (card.value)
    size.value = { w: card.value.offsetWidth, h: card.value.offsetHeight }
}, { flush: 'post' })

const position = computed(() => {
  const gap = 18
  const { w, h } = size.value
  const { width, height } = props.bounds
  let left = props.x + gap
  let top = props.y + gap
  if (left + w > width - 4)
    left = props.x - gap - w
  if (top + h > height - 4)
    top = Math.max(4, height - h - 4)
  return { left: `${Math.max(4, left)}px`, top: `${Math.max(4, top)}px` }
})

const main = computed(() => props.stock.change[props.period])
const grid = computed(() => props.periods.filter(p => p !== 'pre' && p !== 'post' || props.stock.change[p] != null))
</script>

<template>
  <div
    ref="card"
    class="absolute z-20 w-[272px] rounded-[10px] bg-paper-card/97 p-3.5 text-[12px] shadow-[0_0_0_1px_rgba(28,35,45,0.08),0_12px_32px_-8px_rgba(28,35,45,0.22),0_2px_6px_rgba(28,35,45,0.06)] backdrop-blur-sm"
    :class="pinned ? 'pointer-events-auto' : 'pointer-events-none'"
    :style="position"
    role="dialog"
    :aria-label="`${stock.symbol} ${stock.name}`"
  >
    <header class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="flex items-baseline gap-2">
          <span class="text-[17px] font-700 tracking-[-0.01em] [font-stretch:92%]">{{ stock.symbol }}</span>
          <span class="text-[10.5px] font-500 tracking-[0.04em] text-ink-3">{{ stock.exchange }}</span>
        </div>
        <div class="mt-0.5 truncate text-ink-2">{{ stock.name }}</div>
      </div>
      <button v-if="pinned" class="focus-ring -mr-1 -mt-1 rounded p-1 text-ink-3 hover:text-ink" aria-label="关闭" @click="emit('close')">
        <svg viewBox="0 0 16 16" class="h-3.5 w-3.5"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
      </button>
    </header>
    <div class="mt-1 text-[11.5px] text-ink-3">{{ industryName(stock.industry) }} · {{ sectorName(stock.sector) }}</div>

    <div class="tnum mt-3 flex items-baseline justify-between border-t border-rule-soft pt-2.5">
      <span class="text-[20px] font-600 tracking-[-0.01em]">{{ price(stock.price) }}</span>
      <span class="text-[17px] font-650" :style="{ color: scale.ink(main) }">{{ pct(main) }}</span>
    </div>

    <dl class="tnum mt-2.5 grid grid-cols-4 gap-x-1 gap-y-1.5">
      <div
        v-for="p in grid"
        :key="p"
        class="rounded-[5px] px-1.5 py-1"
        :class="p === period ? 'bg-paper-deep' : ''"
      >
        <dt class="text-[10.5px] text-ink-3">{{ PERIOD_SHORT[p] }}</dt>
        <dd class="m-0 text-[11.5px] font-550" :style="{ color: scale.ink(stock.change[p]) }">{{ pct(stock.change[p]) }}</dd>
      </div>
    </dl>

    <dl class="tnum mt-2.5 grid grid-cols-2 gap-x-3 border-t border-rule-soft pt-2.5">
      <div>
        <dt class="text-[10.5px] text-ink-3">市值</dt>
        <dd class="m-0 font-550">{{ money(stock.marketCap) }}</dd>
      </div>
      <div>
        <dt class="text-[10.5px] text-ink-3">今日成交额</dt>
        <dd class="m-0 font-550">{{ money(stock.valueTraded) }}</dd>
      </div>
    </dl>

    <section v-if="peers.length" class="mt-2.5 border-t border-rule-soft pt-2.5">
      <h3 class="m-0 mb-1.5 text-[10.5px] font-500 text-ink-3">同行业</h3>
      <ul class="tnum m-0 grid list-none grid-cols-2 gap-x-3 gap-y-1 p-0">
        <li v-for="p in peers" :key="p.symbol" class="flex items-center gap-1.5">
          <span class="h-2 w-2 shrink-0 rounded-[2px]" :style="{ background: scale.at(p.change[period]).fill }" />
          <span class="font-600 [font-stretch:90%]">{{ p.symbol }}</span>
          <span class="ml-auto text-[11.5px]" :style="{ color: scale.ink(p.change[period]) }">{{ pct(p.change[period]) }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
