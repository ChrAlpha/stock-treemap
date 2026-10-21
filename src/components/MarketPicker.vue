<script setup lang="ts">
import type { MarketId } from '~shared/markets'
import { onClickOutside, onKeyStroke, useIntervalFn } from '@vueuse/core'
import { computed, nextTick, ref, shallowRef } from 'vue'
import { timeIn } from '../lib/format'
import { phaseLabel } from '../lib/phase'
import { marketClock } from '~shared/clock'
import { MARKET_IDS, MARKETS, REGIONS } from '~shared/markets'

// Picking a market is the only thing that loads it. The list itself is
// computed from each market's trading hours, so opening it fetches nothing.
//
// On phones the button sits too far right for the panel to fit beside it, so
// the root stays static and the panel hangs off the header row in App.vue.

const props = defineProps<{
  /** Source-reported closure for the market on screen. */
  holiday: boolean
}>()

const model = defineModel<MarketId>({ required: true })

const open = ref(false)
const root = ref<HTMLElement>()
const button = ref<HTMLButtonElement>()
const list = ref<HTMLElement>()
const cursor = ref(0)
const now = shallowRef(new Date())

useIntervalFn(() => {
  now.value = new Date()
}, 30_000)

onClickOutside(root, () => {
  open.value = false
})

const current = computed(() => MARKETS[model.value])

const rows = computed(() => MARKET_IDS.map((id) => {
  const m = MARKETS[id]
  const status = phaseLabel(m, marketClock(m, now.value), id === model.value && props.holiday)
  return { id, label: m.label, region: m.region, status, time: timeIn(m.tz, now.value.getTime()), city: m.city }
}))

// Asia-Pacific in one column; the Americas over Europe in the other.
const columns = computed(() => [
  [REGIONS[0]],
  [REGIONS[1], REGIONS[2]],
].map(regions => regions.map(r => ({ ...r, rows: rows.value.filter(row => row.region === r.id) }))))

/** Keyboard order follows the columns as laid out. */
const order = computed(() => columns.value.flatMap(col => col.flatMap(r => r.rows.map(row => row.id))))

async function toggle() {
  open.value = !open.value
  if (!open.value)
    return
  now.value = new Date()
  cursor.value = Math.max(order.value.indexOf(model.value), 0)
  await nextTick()
  list.value?.focus()
}

function choose(id: MarketId) {
  model.value = id
  open.value = false
}

function onKey(e: KeyboardEvent) {
  const n = order.value.length
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight')
    cursor.value = (cursor.value + 1) % n
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft')
    cursor.value = (cursor.value - 1 + n) % n
  else if (e.key === 'Home')
    cursor.value = 0
  else if (e.key === 'End')
    cursor.value = n - 1
  else if (e.key === 'Enter' || e.key === ' ')
    choose(order.value[cursor.value]!)
  else if (e.key === 'Escape') {
    // Kept from the page, where Esc would also zoom the map out.
    e.stopPropagation()
    close()
  }
  else
    return
  e.preventDefault()
}

function close() {
  open.value = false
  button.value?.focus()
}

onKeyStroke('Escape', () => {
  open.value = false
})
</script>

<template>
  <div ref="root" class="relative max-sm:static">
    <button
      ref="button"
      class="focus-ring -ml-1 flex h-8 items-center gap-1.5 rounded-md px-2 hover:bg-paper-deep/70"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :title="`切换市场（当前：${current.title}）`"
      @click="toggle"
    >
      <span class="text-[14px] font-600 text-ink">{{ current.label }}</span>
      <svg viewBox="0 0 10 10" class="h-2.5 w-2.5 text-ink-3 transition-transform duration-150" :class="open ? 'rotate-180' : ''" aria-hidden="true">
        <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <div
      v-if="open"
      class="absolute left-0 top-[calc(100%+6px)] z-40 w-[min(420px,calc(100vw-24px))] rounded-[10px] bg-paper-card p-2 shadow-[0_0_0_1px_rgba(28,35,45,0.08),0_12px_32px_-8px_rgba(28,35,45,0.22)]"
    >
      <div
        ref="list"
        role="listbox"
        aria-label="市场"
        tabindex="-1"
        class="grid grid-cols-1 gap-x-2 outline-none sm:grid-cols-2"
        :aria-activedescendant="`market-${order[cursor]}`"
        @keydown="onKey"
      >
        <div v-for="(col, ci) in columns" :key="ci">
          <div v-for="region in col" :key="region.id" class="[&+&]:mt-2">
            <div class="px-2 pb-1 pt-1.5 text-[11px] text-ink-3">
              {{ region.label }}
            </div>
            <div
              v-for="row in region.rows"
              :id="`market-${row.id}`"
              :key="row.id"
              role="option"
              :aria-selected="row.id === model"
              class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px]"
              :class="[
                row.id === model ? 'bg-paper font-600 text-ink shadow-[0_0_0_1px_#dbe1e4]' : 'text-ink-2 hover:text-ink',
                order[cursor] === row.id ? 'bg-paper-deep' : '',
              ]"
              @mouseenter="cursor = order.indexOf(row.id)"
              @click="choose(row.id)"
            >
              <span class="relative flex h-1.5 w-1.5 shrink-0" aria-hidden="true">
                <span class="h-1.5 w-1.5 rounded-full" :class="row.status.live ? 'bg-ink' : 'border border-ink-3'" />
              </span>
              <span class="min-w-0 flex-1 truncate">{{ row.label }}</span>
              <span class="shrink-0 text-[11.5px] font-400" :class="row.status.live ? 'text-ink' : 'text-ink-3'">{{ row.status.short }}</span>
              <span class="tnum w-9 shrink-0 text-right text-[11.5px] font-400 text-ink-3" :title="`${row.city}时间`">{{ row.time }}</span>
            </div>
          </div>
        </div>
      </div>
      <p class="m-0 mt-2 border-t border-rule-soft px-2 pt-2 text-[11px] leading-relaxed text-ink-3">
        时间为各市场当地时间。交易状态按常规时段推算，未计入美股以外市场的节假日。只有选中的市场会加载行情。
      </p>
    </div>
  </div>
</template>
