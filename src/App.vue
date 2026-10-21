<script setup lang="ts">
import type { HoverInfo } from './components/MarketMap.vue'
import type { Range } from './components/DistributionScale.vue'
import type { MarketId } from '~shared/markets'
import type { Stock } from '~shared/snapshot'
import { onKeyStroke, useElementSize, useTitle } from '@vueuse/core'
import { computed, ref, shallowRef, toRef, watch } from 'vue'
import BrandMark from './components/BrandMark.vue'
import DistributionScale from './components/DistributionScale.vue'
import MapTooltip from './components/MapTooltip.vue'
import MarketMap from './components/MarketMap.vue'
import MarketPicker from './components/MarketPicker.vue'
import MarketStatus from './components/MarketStatus.vue'
import PeriodStrip from './components/PeriodStrip.vue'
import SearchBox from './components/SearchBox.vue'
import SettingsMenu from './components/SettingsMenu.vue'
import UniverseTabs from './components/UniverseTabs.vue'
import { useSnapshot } from './composables/useSnapshot'
import { defaultUniverse, usePrefs, useView } from './composables/useView'
import { count, pct, timeIn } from './lib/format'
import { PERIOD_LABEL } from './lib/labels'
import { matchQuery } from './lib/names'
import { makeScale } from './lib/scale'
import { industryName, sectorName } from './lib/taxonomy'
import { industryId, parentFocus, parseFocus, sectorId, weightedChange } from './lib/treemap'
import { MARKETS } from '~shared/markets'
import { PERIODS, universeOf } from '~shared/snapshot'

const view = useView()
const market = computed(() => MARKETS[view.market])
const { snapshot, state, offline, checkedAt, reload } = useSnapshot(toRef(view, 'market'))
const { convention, palette } = usePrefs()

const scale = computed(() => makeScale(view.period, convention.value, palette.value))

useTitle(computed(() => `版图 · ${market.value.title}热力图`))

// ── Universe ────────────────────────────────────────────────────

const allStocks = computed(() => snapshot.value?.stocks ?? [])
const universes = computed(() => Object.fromEntries(market.value.universes.map(u => [u.id, universeOf(allStocks.value, market.value, u.id)])) as Record<string, Stock[]>)
const universe = computed(() => market.value.universes.find(u => u.id === view.universe) ?? market.value.universes[0]!)
const stocks = computed(() => universes.value[universe.value.id] ?? allStocks.value)
const inUniverse = computed(() => new Set(stocks.value.map(s => s.symbol)))
const allLabel = computed(() => market.value.universes.at(-1)!.label)

// ── Periods ─────────────────────────────────────────────────────

const available = computed(() => new Set(snapshot.value?.periods ?? ['d1']))
const periodItems = computed(() => PERIODS
  // Extended-hours windows only appear when there's data for them.
  .filter(p => (p !== 'pre' && p !== 'post') || available.value.has(p))
  .map(p => ({ id: p, change: weightedChange(stocks.value, p), available: available.value.has(p) })))

watch(available, (set) => {
  if (snapshot.value && !set.has(view.period))
    view.period = 'd1'
})

const universeChanges = computed(() => Object.fromEntries(Object.entries(universes.value).map(([id, list]) => [id, weightedChange(list, view.period)])))
const universeCounts = computed(() => Object.fromEntries(Object.entries(universes.value).map(([id, list]) => [id, list.length])))

// ── Focus (zoom) ────────────────────────────────────────────────

const focusParts = computed(() => parseFocus(view.focus))

const scoped = computed(() => {
  const p = focusParts.value
  if (!p)
    return stocks.value
  return stocks.value.filter(s => s.sector === p.sector && (!p.industry || s.industry === p.industry))
})

// Drop a zoom that no longer points anywhere (a mangled link, or a sector this universe lacks).
watch([stocks, () => view.focus], () => {
  if (view.focus && snapshot.value && (!focusParts.value || scoped.value.length === 0))
    view.focus = null
})

const crumbs = computed(() => {
  const p = focusParts.value
  if (!p)
    return []
  const list = [{ id: sectorId(p.sector), label: sectorName(p.sector), change: weightedChange(stocks.value.filter(s => s.sector === p.sector), view.period) }]
  if (p.industry)
    list.push({ id: industryId(p.sector, p.industry), label: industryName(p.industry), change: weightedChange(scoped.value, view.period) })
  return list
})

const scopeSummary = computed(() => {
  const p = focusParts.value
  const n = scoped.value.length
  if (!p)
    return `${new Set(stocks.value.map(s => s.sector)).size} 个板块 · ${count(n)} 只`
  if (!p.industry)
    return `${new Set(scoped.value.map(s => s.industry)).size} 个行业 · ${count(n)} 只`
  return `${count(n)} 只`
})

function zoomOut() {
  view.focus = parentFocus(view.focus)
}

// ── Highlight: search & legend ──────────────────────────────────

const query = ref('')
const range = ref<Range | null>(null)
const marked = ref<string | null>(null)

const highlight = computed<((s: Stock) => boolean) | null>(() => {
  const q = query.value.trim().toUpperCase()
  if (q)
    return s => matchQuery(s, q) != null
  const r = range.value
  if (r) {
    const p = view.period
    return (s) => {
      const v = s.change[p]
      return v != null && v >= r.lo && v < r.hi
    }
  }
  return null
})

function pick(s: Stock) {
  if (!inUniverse.value.has(s.symbol))
    view.universe = 'all'
  view.focus = sectorId(s.sector)
  marked.value = s.symbol
  query.value = ''
}

watch(() => view.universe, () => {
  marked.value = null
})

// ── Market ──────────────────────────────────────────────────────

/** Switching market starts over: its own universes, no zoom, no selection. */
function switchMarket(m: MarketId) {
  if (m === view.market)
    return
  view.market = m
  view.universe = defaultUniverse(m)
  view.focus = null
  query.value = ''
  range.value = null
  hover.value = null
}

// ── Tooltip ─────────────────────────────────────────────────────

const hover = shallowRef<HoverInfo | null>(null)
const mapBox = ref<HTMLElement>()
const { width: mapW, height: mapH } = useElementSize(mapBox)

const peers = computed(() => {
  const h = hover.value
  if (!h)
    return []
  return stocks.value
    .filter(s => s.industry === h.stock.industry && s.symbol !== h.stock.symbol)
    .sort((a, b) => b.marketCap - a.marketCap)
    .slice(0, 6)
})

watch([() => view.focus, () => view.universe, () => view.sizeBy], () => {
  hover.value = null
})

onKeyStroke('Escape', () => {
  if (hover.value?.pinned)
    hover.value = null
  else if (marked.value || range.value || query.value) {
    marked.value = null
    range.value = null
    query.value = ''
  }
  else zoomOut()
})

// ── Copy ────────────────────────────────────────────────────────

const mapLabel = computed(() => {
  const n = scoped.value
  const up = n.filter(s => (s.change[view.period] ?? 0) > 0).length
  const down = n.filter(s => (s.change[view.period] ?? 0) < 0).length
  const where = crumbs.value.at(-1)?.label ?? `${market.value.label}${universe.value.label}`
  return `${where}热力图，${PERIOD_LABEL[view.period]}：上涨 ${up} 只，下跌 ${down} 只，市值加权 ${pct(weightedChange(n, view.period))}。`
})

const sourceNote = computed(() => {
  const s = snapshot.value
  if (!s)
    return ''
  const { city, tz } = market.value
  const at = `${city} ${timeIn(tz, s.fetchedAt)} 快照`
  if (s.source === 'nasdaq')
    return `备用数据源 Nasdaq · 仅有今日涨跌 · ${at}`
  return `行情来自 TradingView 公开数据，${s.delay ? `延迟约 ${s.delay} 分钟` : '实时'} · ${at}`
})

const sizeOptions = [
  { id: 'marketCap', label: '市值' },
  { id: 'valueTraded', label: '成交额' },
] as const
</script>

<template>
  <div class="mx-auto flex h-full min-h-[640px] max-w-[1920px] flex-col px-3 sm:px-5">
    <header class="flex flex-wrap items-center gap-x-6 gap-y-2 pt-3 sm:pt-4">
      <div class="flex shrink-0 items-center gap-2.5">
        <h1 class="m-0 flex items-center gap-2.5" :title="`版图 · ${market.title}热力图`">
          <BrandMark class="h-[22px] w-[22px]" />
          <span class="text-[19px] font-700 tracking-[0.06em]">版图</span>
          <span class="sr-only">{{ market.title }}热力图</span>
        </h1>
        <span class="h-3.5 w-px bg-rule" aria-hidden="true" />
        <MarketPicker :model-value="view.market" :holiday="snapshot?.holiday ?? false" @update:model-value="switchMarket" />
      </div>
      <MarketStatus
        class="order-2 ml-auto lg:order-3"
        :market="market"
        :fetched-at="snapshot?.fetchedAt ?? null"
        :expires-at="snapshot?.expiresAt ?? null"
        :checked-at="checkedAt"
        :delay="snapshot?.delay ?? market.delay"
        :source="snapshot?.source ?? null"
        :offline="offline"
        :holiday="snapshot?.holiday ?? false"
        :trade-date="snapshot?.tradeDate ?? null"
      />
      <UniverseTabs
        v-model="view.universe"
        class="order-3 w-full min-w-0 lg:order-2 lg:w-auto lg:flex-1"
        :market="market"
        :indices="snapshot?.indices ?? []"
        :period="view.period"
        :scale="scale"
        :weighted="universeChanges"
        :counts="universeCounts"
      />
    </header>

    <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-rule pt-2.5">
      <PeriodStrip v-model="view.period" class="min-w-0 max-w-full" :periods="periodItems" :ink="scale.ink" />
      <div class="ml-auto flex w-full items-center gap-2 sm:w-auto">
        <div class="flex shrink-0 items-center gap-0.5 rounded-md" role="radiogroup" aria-label="面积代表">
          <span class="mr-1 text-[12px] text-ink-3">面积</span>
          <button
            v-for="o in sizeOptions"
            :key="o.id"
            role="radio"
            :aria-checked="view.sizeBy === o.id"
            class="focus-ring rounded-md px-2.5 py-1.5 text-[12.5px] transition-[color,background-color,box-shadow] duration-150"
            :class="view.sizeBy === o.id ? 'bg-paper-card font-600 text-ink shadow-[0_0_0_1px_#dbe1e4,0_1px_2px_rgba(28,35,45,0.06)]' : 'text-ink-2 hover:bg-paper-deep/70 hover:text-ink'"
            @click="view.sizeBy = o.id"
          >
            {{ o.label }}
          </button>
        </div>
        <SearchBox v-model="query" class="min-w-0 flex-1 sm:flex-none" :stocks="allStocks" :in-universe="inUniverse" :all-label="allLabel" @pick="pick" />
        <SettingsMenu v-model:convention="convention" v-model:palette="palette" />
      </div>
    </div>

    <main class="mt-2 flex min-h-[420px] flex-1 flex-col">
      <div class="flex h-7 items-center gap-1.5 text-[12px]">
        <nav class="flex min-w-0 items-center gap-1.5" aria-label="当前位置">
          <button
            class="focus-ring shrink-0 rounded px-1 py-0.5"
            :class="crumbs.length ? 'text-ink-2 hover:text-ink' : 'font-600 text-ink cursor-default'"
            @click="view.focus = null"
          >
            全部板块
          </button>
          <template v-for="(c, i) in crumbs" :key="c.id">
            <svg viewBox="0 0 8 8" class="h-2 w-2 shrink-0 text-ink-3" aria-hidden="true"><path d="M2.5 1l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.2" /></svg>
            <button
              class="focus-ring flex min-w-0 items-baseline gap-1.5 rounded px-1 py-0.5"
              :class="i === crumbs.length - 1 ? 'font-600 text-ink cursor-default' : 'text-ink-2 hover:text-ink'"
              @click="view.focus = c.id"
            >
              <span class="truncate">{{ c.label }}</span>
              <span class="tnum shrink-0 text-[11.5px] font-500" :style="{ color: scale.ink(c.change) }">{{ pct(c.change) }}</span>
            </button>
          </template>
        </nav>
        <span class="tnum ml-auto shrink-0 text-[11.5px] text-ink-3">
          {{ scopeSummary }}<span class="hidden lg:inline"> · {{ crumbs.length ? 'Esc 或右键返回上一级' : '点击板块或个股放大' }}</span>
        </span>
      </div>

      <div ref="mapBox" class="relative min-h-0 flex-1">
        <MarketMap
          v-if="snapshot"
          :key="view.market"
          :market="market"
          :stocks="stocks"
          :period="view.period"
          :size-by="view.sizeBy"
          :scale="scale"
          :focus="view.focus"
          :highlight="highlight"
          :marked="marked"
          :label="mapLabel"
          @focus="view.focus = $event"
          @hover="hover = $event"
        />
        <MapTooltip
          v-if="hover"
          :market="market"
          :stock="hover.stock"
          :x="hover.x"
          :y="hover.y"
          :pinned="hover.pinned"
          :bounds="{ width: mapW, height: mapH }"
          :period="view.period"
          :periods="snapshot?.periods ?? ['d1']"
          :scale="scale"
          :peers="peers"
          @close="hover = null"
        />
        <div v-if="!snapshot" class="absolute inset-0 grid place-items-center rounded-md bg-paper-deep/50">
          <div class="max-w-[320px] text-center">
            <template v-if="state === 'loading'">
              <p class="m-0 text-[13px] text-ink-2">正在载入{{ market.title }}行情…</p>
              <p class="m-0 mt-1.5 text-[12px] text-ink-3">长时间无人访问后，首次打开需要现取数据，约一两秒。</p>
            </template>
            <template v-else>
              <p class="m-0 text-[14px] font-600">暂时拿不到行情</p>
              <p class="m-0 mt-1.5 text-[12.5px] text-ink-2">可能是网络中断，也可能是行情源暂时不可用。页面每 20 秒会自动重试一次。</p>
              <button class="chip mt-3 shadow-[0_0_0_1px_#dbe1e4]" @click="reload()">重试</button>
            </template>
          </div>
        </div>
      </div>
    </main>

    <footer class="flex flex-wrap items-end justify-between gap-x-8 gap-y-1 pb-3 pt-3 sm:pb-4">
      <DistributionScale v-if="snapshot" v-model:range="range" class="min-w-0 flex-1" :stocks="scoped" :period="view.period" :scale="scale" :currency="market.currency" />
      <p class="tnum m-0 mb-[18px] text-[11px] text-ink-3">
        {{ sourceNote }}<span v-if="sourceNote"> · 仅供参考，不构成投资建议</span>
      </p>
    </footer>
  </div>
</template>
