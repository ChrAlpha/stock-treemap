<script setup lang="ts">
import type { QuoteSource } from '~shared/snapshot'
import { computed, onBeforeUnmount, shallowRef } from 'vue'
import { dayET, duration, timeBJ, timeET } from '../lib/format'
import { marketClock, minutesUntilOpen } from '~shared/market'

const props = defineProps<{
  fetchedAt: number | null
  /** When the server considers this data superseded. */
  expiresAt: number | null
  /** When the server last answered. */
  checkedAt: number
  delay: number
  source: QuoteSource | null
  offline: boolean
}>()

const now = shallowRef(new Date())
const tick = setInterval(() => {
  now.value = new Date()
}, 15_000)
onBeforeUnmount(() => clearInterval(tick))

const clock = computed(() => marketClock(now.value))

const phase = computed(() => {
  const c = clock.value
  switch (c.phase) {
    case 'regular': return { label: '交易中', live: true }
    case 'pre': return { label: '盘前交易', live: false }
    case 'post': return { label: '盘后交易', live: false }
    default: return { label: c.isTradingDay ? '已收盘' : '休市', live: false }
  }
})

const untilOpen = computed(() => {
  if (clock.value.phase === 'regular' || clock.value.phase === 'post')
    return null
  return duration(minutesUntilOpen(now.value))
})

const ageMinutes = computed(() => props.fetchedAt ? Math.max(0, Math.round((now.value.getTime() - props.fetchedAt) / 60_000)) : null)

// Each response carries its expiry. If the server is still handing out the same data well
// after that, its refreshes are failing.
const stale = computed(() => props.expiresAt != null && props.checkedAt > props.expiresAt + 3 * 60_000)

const freshness = computed(() => {
  const at = props.fetchedAt
  const age = ageMinutes.value
  if (at == null || age == null)
    return ''
  // Outside the session the data is the settled close; say when it's from rather than how old.
  if (clock.value.phase === 'closed' && age >= 60)
    return `数据截至美东 ${dayET(at)} ${timeET(at)}`
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
        <span class="tnum text-ink-2">美东 {{ timeET(now.getTime()) }}</span>
        <span class="tnum hidden text-ink-3 sm:inline">北京 {{ timeBJ(now.getTime()) }}</span>
      </div>
      <div class="mt-1 text-[11.5px] text-ink-3">
        <template v-if="offline">
          <span class="text-[#9a5a12]">连接中断，正在重试</span>
        </template>
        <template v-else-if="stale">
          <span class="text-[#9a5a12]" :title="fetchedAt ? `最后一份快照：美东 ${timeET(fetchedAt)}` : ''">行情源暂时不可用，显示 {{ duration(ageMinutes!) }}前的数据</span>
        </template>
        <template v-else-if="fetchedAt">
          <span v-if="untilOpen">距开盘 {{ untilOpen }} · </span>
          <span v-if="clock.phase !== 'closed'">{{ source === 'nasdaq' ? '备用数据源' : `行情延迟 ${delay} 分钟` }} · </span>
          <span>{{ freshness }}</span>
        </template>
      </div>
    </div>
  </div>
</template>
