<script setup lang="ts">
import type { Convention, Palette } from '../lib/scale'
import { onClickOutside, onKeyStroke } from '@vueuse/core'
import { computed, ref } from 'vue'
import { makeScale } from '../lib/scale'

const convention = defineModel<Convention>('convention', { required: true })
const palette = defineModel<Palette>('palette', { required: true })

const open = ref(false)
const root = ref<HTMLElement>()
onClickOutside(root, () => {
  open.value = false
})
onKeyStroke('Escape', () => {
  open.value = false
})

const options = computed(() => ({
  // Name the convention by the colours actually on screen.
  convention: (palette.value === 'cvd'
    ? [['red-up', '橙涨蓝跌'], ['green-up', '蓝涨橙跌']] as const
    : [['red-up', '红涨绿跌'], ['green-up', '绿涨红跌']] as const
  ).map(([id, label]) => {
    const s = makeScale('d1', id, palette.value)
    return { id, label, up: s.at(3).fill, down: s.at(-3).fill }
  }),
  palette: ([['pigment', '标准'], ['cvd', '色觉友好']] as const).map(([id, label]) => {
    const s = makeScale('d1', convention.value, id)
    return { id, label, up: s.at(3).fill, down: s.at(-3).fill }
  }),
}))
</script>

<template>
  <div ref="root" class="relative">
    <button
      class="focus-ring flex h-8 items-center gap-1.5 rounded-md px-2 text-ink-2 hover:bg-paper-deep/70 hover:text-ink"
      :aria-expanded="open"
      aria-haspopup="dialog"
      @click="open = !open"
    >
      <span class="flex gap-[2px]" aria-hidden="true">
        <span class="h-3 w-1.5 rounded-[1.5px]" :style="{ background: options.convention.find(o => o.id === convention)!.up }" />
        <span class="h-3 w-1.5 rounded-[1.5px]" :style="{ background: options.convention.find(o => o.id === convention)!.down }" />
      </span>
      <span class="text-[12.5px]">配色</span>
    </button>
    <div
      v-if="open"
      role="dialog"
      aria-label="配色设置"
      class="absolute right-0 top-[calc(100%+6px)] z-30 w-[240px] rounded-[10px] bg-paper-card p-3 shadow-[0_0_0_1px_rgba(28,35,45,0.08),0_12px_32px_-8px_rgba(28,35,45,0.22)]"
    >
      <fieldset v-for="group in (['convention', 'palette'] as const)" :key="group" class="m-0 border-0 p-0 [&+&]:mt-3">
        <legend class="mb-1.5 p-0 text-[11px] text-ink-3">{{ group === 'convention' ? '涨跌颜色' : '色板' }}</legend>
        <div class="grid grid-cols-2 gap-1.5">
          <label
            v-for="o in options[group]"
            :key="o.id"
            class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] transition-shadow has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-solid has-[:focus-visible]:outline-ink"
            :class="(group === 'convention' ? convention : palette) === o.id ? 'bg-paper text-ink font-600 shadow-[0_0_0_1px_#1c232d]' : 'text-ink-2 shadow-[0_0_0_1px_#dbe1e4] hover:text-ink'"
          >
            <input
              class="sr-only"
              type="radio"
              :name="group"
              :value="o.id"
              :checked="(group === 'convention' ? convention : palette) === o.id"
              @change="group === 'convention' ? (convention = o.id as Convention) : (palette = o.id as Palette)"
            >
            <span class="flex gap-[2px]" aria-hidden="true">
              <span class="h-3.5 w-2 rounded-[2px]" :style="{ background: o.up }" />
              <span class="h-3.5 w-2 rounded-[2px]" :style="{ background: o.down }" />
            </span>
            {{ o.label }}
          </label>
        </div>
      </fieldset>
      <p class="m-0 mt-3 text-[11px] leading-relaxed text-ink-3">色觉友好色板用赭石与花青替代红绿，红绿色弱时更易分辨。</p>
    </div>
  </div>
</template>
