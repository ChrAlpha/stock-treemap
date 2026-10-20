<script setup lang="ts">
import type { Scale } from '../lib/scale'
import type { Period, Stock } from '~shared/snapshot'
import { computed, ref, watch } from 'vue'
import { count, money, pct } from '../lib/format'
import { weightedChange } from '../lib/treemap'

// The legend is also the day's distribution: each colour step carries a bar
// for how many stocks landed in it. Hover a step to find them on the map;
// click to hold the selection.

export interface Range { lo: number, hi: number }

const props = defineProps<{
  stocks: Stock[]
  period: Period
  scale: Scale
}>()

const range = defineModel<Range | null>('range', { default: null })

const SIDE = 6
const locked = ref<number | null>(null)
const hovered = ref<number | null>(null)

const bins = computed(() => {
  const d = props.scale.domain
  const step = d / SIDE
  const edges = [-Infinity, ...Array.from({ length: SIDE * 2 + 1 }, (_, i) => -d + i * step), Infinity]
  const list = edges.slice(0, -1).map((lo, i) => ({
    lo,
    hi: edges[i + 1]!,
    count: 0,
    cap: 0,
    // Colour at the bin's middle; tails take the saturated end.
    color: props.scale.at(Number.isFinite(lo) && Number.isFinite(edges[i + 1]!) ? (lo + edges[i + 1]!) / 2 : (lo === -Infinity ? -d * 1.2 : d * 1.2)).fill,
  }))
  for (const s of props.stocks) {
    const v = s.change[props.period]
    if (v == null)
      continue
    const i = list.findIndex(b => v >= b.lo && v < b.hi)
    const bin = list[i]
    if (bin) {
      bin.count++
      bin.cap += s.marketCap
    }
  }
  const max = Math.max(1, ...list.map(b => b.count))
  return list.map(b => ({ ...b, height: b.count ? Math.max(2, Math.round((b.count / max) * 26)) : 0 }))
})

const breadth = computed(() => {
  let up = 0
  let down = 0
  let flat = 0
  for (const s of props.stocks) {
    const v = s.change[props.period]
    if (v == null)
      continue
    if (v > 0.005)
      up++
    else if (v < -0.005)
      down++
    else flat++
  }
  return { up, down, flat }
})

const mean = computed(() => weightedChange(props.stocks, props.period))

/** Horizontal position (0–1) of a value on the strip; tails each take one bin. */
function position(v: number) {
  const d = props.scale.domain
  const n = SIDE * 2 + 2
  if (v <= -d)
    return 0.5 / n
  if (v >= d)
    return (n - 0.5) / n
  return (1 + ((v + d) / (2 * d)) * SIDE * 2) / n
}

function rangeLabel(lo: number, hi: number) {
  if (!Number.isFinite(lo))
    return `${pct(hi, { digits: 1 })} 以下`
  if (!Number.isFinite(hi))
    return `${pct(lo, { digits: 1 })} 以上`
  return `${pct(lo, { digits: 1 })} 至 ${pct(hi, { digits: 1 })}`
}

const active = computed(() => hovered.value ?? locked.value)
const readout = computed(() => {
  const i = active.value
  if (i == null)
    return null
  const b = bins.value[i]
  return b ? { label: rangeLabel(b.lo, b.hi), count: b.count, cap: b.cap } : null
})

watch(active, (i) => {
  const b = i == null ? null : bins.value[i]
  range.value = b ? { lo: b.lo, hi: b.hi } : null
})

// Selections don't survive a change of what's being measured.
watch(() => [props.period, props.scale.domain], () => {
  locked.value = null
  hovered.value = null
})
watch(range, (r) => {
  if (!r && locked.value != null && hovered.value == null)
    locked.value = null
})

const boundaries = computed(() => {
  const d = props.scale.domain
  const n = SIDE * 2 + 2
  return [
    { at: 1 / n, label: pct(-d, { digits: 0 }) },
    { at: 0.5, label: '0' },
    { at: (n - 1) / n, label: pct(d, { digits: 0 }) },
  ]
})

function toggle(i: number) {
  locked.value = locked.value === i ? null : i
}
</script>

<template>
  <div class="flex flex-wrap items-end gap-x-6 gap-y-2">
    <div class="relative w-[min(100%,360px)] shrink-0" @mouseleave="hovered = null">
      <div class="grid h-[30px] items-end gap-[2px]" :style="{ gridTemplateColumns: `repeat(${bins.length}, minmax(0, 1fr))` }">
        <button
          v-for="(b, i) in bins"
          :key="i"
          class="focus-ring group flex h-full flex-col justify-end rounded-[2px]"
          :aria-label="`${rangeLabel(b.lo, b.hi)}：${b.count} 只`"
          :aria-pressed="locked === i"
          @mouseenter="hovered = i"
          @focus="hovered = i"
          @blur="hovered = null"
          @click="toggle(i)"
        >
          <span
            class="w-full rounded-t-[2px] transition-colors duration-150"
            :class="active === i ? 'bg-ink' : locked != null ? 'bg-ink/10' : 'bg-ink/20 group-hover:bg-ink/45'"
            :style="{ height: `${b.height}px` }"
          />
        </button>
      </div>
      <div class="relative mt-[3px] grid h-2 gap-[2px]" :style="{ gridTemplateColumns: `repeat(${bins.length}, minmax(0, 1fr))` }">
        <span
          v-for="(b, i) in bins"
          :key="i"
          class="rounded-[2px] transition-[box-shadow] duration-150"
          :style="{ background: b.color, boxShadow: active === i ? '0 0 0 1.5px #1c232d' : undefined }"
        />
        <span
          v-if="mean != null"
          class="pointer-events-none absolute -bottom-[7px] h-0 w-0 -translate-x-1/2 border-x-[4px] border-b-[5px] border-x-transparent border-b-ink"
          :style="{ left: `${position(mean) * 100}%` }"
          :title="`市值加权 ${pct(mean)}`"
        />
      </div>
      <div class="relative mt-2 h-3.5 text-[10.5px] text-ink-3 tnum">
        <span
          v-for="m in boundaries"
          :key="m.label"
          class="absolute -translate-x-1/2"
          :style="{ left: `${m.at * 100}%` }"
        >{{ m.label }}</span>
      </div>
    </div>

    <p class="tnum mb-[18px] min-h-[18px] text-[12px] text-ink-2" aria-live="polite">
      <template v-if="readout">
        <span class="font-600 text-ink">{{ readout.label }}</span>
        <span> · {{ count(readout.count) }} 只 · 市值 {{ money(readout.cap) }}</span>
        <span v-if="locked != null && hovered == null" class="text-ink-3"> · 再次点击取消</span>
      </template>
      <template v-else>
        <span>上涨 <b class="font-600" :style="{ color: scale.ink(1) }">{{ count(breadth.up) }}</b></span>
        <span class="mx-2 text-rule">|</span>
        <span>下跌 <b class="font-600" :style="{ color: scale.ink(-1) }">{{ count(breadth.down) }}</b></span>
        <template v-if="breadth.flat">
          <span class="mx-2 text-rule">|</span>
          <span>平 <b class="font-600 text-ink">{{ count(breadth.flat) }}</b></span>
        </template>
        <span class="mx-2 text-rule">|</span>
        <span>市值加权 <b class="font-600" :style="{ color: scale.ink(mean) }">{{ pct(mean) }}</b></span>
      </template>
    </p>
  </div>
</template>
