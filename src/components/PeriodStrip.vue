<script setup lang="ts">
import type { Scale } from '../lib/scale'
import type { Period } from '~shared/snapshot'
import { pct } from '../lib/format'
import { PERIOD_LABEL } from '../lib/labels'

defineProps<{
  periods: { id: Period, change: number | null, available: boolean }[]
  /** Text colour for a change; independent of the selected period's scale. */
  ink: Scale['ink']
}>()

const model = defineModel<Period>({ required: true })
</script>

<template>
  <div class="scroll-x flex items-center gap-0.5 -mx-1 px-1" role="radiogroup" aria-label="涨跌区间">
    <button
      v-for="p in periods"
      :key="p.id"
      role="radio"
      class="focus-ring flex shrink-0 items-baseline gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[12.5px] transition-[color,background-color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-40"
      :class="model === p.id
        ? 'bg-paper-card text-ink font-600 shadow-[0_0_0_1px_#dbe1e4,0_1px_2px_rgba(28,35,45,0.06)]'
        : 'text-ink-2 hover:text-ink hover:bg-paper-deep/70'"
      :aria-checked="model === p.id"
      :disabled="!p.available"
      :title="p.available ? undefined : '当前数据源没有这个区间'"
      @click="model = p.id"
    >
      <span>{{ PERIOD_LABEL[p.id] }}</span>
      <span v-if="p.available" class="tnum text-[11.5px] font-500" :style="{ color: ink(p.change) }">{{ pct(p.change) }}</span>
    </button>
  </div>
</template>
