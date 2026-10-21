<script setup lang="ts">
import type { MarketSpec } from '~shared/markets'
import type { QuoteSource } from '~shared/snapshot'
import { useIntervalFn } from '@vueuse/core'
import { computed, shallowRef } from 'vue'
import { BEIJING, dayIn, duration, sameClock, timeIn } from '../lib/format'
import { phaseLabel } from '../lib/phase'
import { marketClock, minutesUntilOpen } from '~shared/clock'

const props = defineProps<{
  market: MarketSpec
  fetchedAt: number | null
  /** When the server considers this data superseded. */
  expiresAt: number | null
  /** When the server last answered. */
  checkedAt: number
  delay: number
  source: QuoteSource | null
  offline: boolean
  /** The source says the market isn't trading today. */
  holiday: boolean
  /** Trading day the data belongs to, YYYY-MM-DD. */
  tradeDate: string | null
}>()

const now = shallowRef(new Date())
useIntervalFn(() => {
  now.value = new Date()
}, 15_000)

const clock = computed(() => marketClock(props.market, now.value))
const phase = computed(() => phaseLabel(props.market, clock.value, props.holiday))
const local = computed(() => timeIn(props.market.tz, now.value.getTime()))
// Beijing time alongside, unless the market already keeps it.
const beijing = computed(() => sameClock(props.market.tz, BEIJING, now.value.getTime()) ? null : timeIn(BEIJING, now.value.getTime()))

const untilOpen = computed(() => {
  // On an unlisted holiday the next open isn't known.
  if (props.holiday || clock.value.phase === 'regular' || clock.value.phase === 'post')
    return null
  return duration(minutesUntilOpen(props.market, now.value))
})

const ageMinutes = computed(() => props.fetchedAt ? Math.max(0, Math.round((now.value.getTime() - props.fetchedAt) / 60_000)) : null)

// Each response carries its expiry. If the server is still handing out the same data well
// after that, its refreshes are failing.
const stale = computed(() => props.expiresAt != null && props.checkedAt > props.expiresAt + 3 * 60_000)

const trading = computed(() => !props.holiday && clock.value.phase !== 'closed' && clock.value.phase !== 'break')

const freshness = computed(() => {
  const at = props.fetchedAt
  const age = ageMinutes.value
  if (at == null || age == null)
    return ''
  // Outside the session the data is the settled close; say when it's from rather than how old.
  if (!trading.value) {
    // Before the open, or on a day without trading, it's an earlier session's close however recently it was fetched.
    const d = props.tradeDate
    if (d && d < clock.value.date)
      return `${Number(d.slice(5, 7))}月${Number(d.slice(8))}日收盘数据`
    if (age >= 60)
      return `数据截至${props.market.city} ${dayIn(props.market.tz, at)} ${timeIn(props.market.tz, at)}`
  }
  if (age < 1)
    return '刚刚更新'
  return `${duration(age)}前更新`
})
</script>

<template>
  <div class="flex items-center gap-3 text-right">
    <div class="leading-tight">
      <div class="flex items-center justify-end gap-2 text-[12px]">
        <span class="relative flex h-2 w-2 shrink-0" aria-hidden="true">
          <span v-if="phase.live" class="absolute inset-0 animate-ping rounded-full bg-ink/40 [animation-duration:2.4s]" />
          <span class="relative h-2 w-2 rounded-full" :class="phase.live ? 'bg-ink' : 'border-[1.5px] border-ink-3'" />
        </span>
        <span class="font-600 text-ink">{{ phase.label }}</span>
        <span class="tnum text-ink-2">{{ market.city }} {{ local }}</span>
        <span v-if="beijing" class="tnum hidden text-ink-3 sm:inline">北京 {{ beijing }}</span>
      </div>
      <div class="mt-1 text-[11.5px] text-ink-3">
        <template v-if="offline">
          <span class="text-[#9a5a12]">连接中断，正在重试</span>
        </template>
        <template v-else-if="stale">
          <span class="text-[#9a5a12]" :title="fetchedAt ? `最后一份快照：${market.city} ${timeIn(market.tz, fetchedAt)}` : ''">行情源暂时不可用，显示 {{ duration(ageMinutes!) }}前的数据</span>
        </template>
        <template v-else-if="fetchedAt">
          <span v-if="untilOpen">距开盘 {{ untilOpen }} · </span>
          <span v-if="trading">{{ source === 'nasdaq' ? '备用数据源' : delay ? `行情延迟 ${delay} 分钟` : '实时行情' }} · </span>
          <span>{{ freshness }}</span>
        </template>
      </div>
    </div>
  </div>
</template>
