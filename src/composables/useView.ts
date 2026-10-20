import type { Convention, Palette } from '../lib/scale'
import type { SizeBy } from '../lib/treemap'
import type { Period, Universe } from '~shared/snapshot'
import { useLocalStorage } from '@vueuse/core'
import { reactive, watch } from 'vue'
import { PERIODS, UNIVERSES } from '~shared/snapshot'

// View state lives in the URL so a map can be shared or bookmarked;
// display preferences live in localStorage.

export interface View {
  universe: Universe
  period: Period
  sizeBy: SizeBy
  focus: string | null
}

const DEFAULTS: View = { universe: 'sp500', period: 'd1', sizeBy: 'marketCap', focus: null }

function readUrl(): View {
  const q = new URLSearchParams(location.search)
  const pick = <T extends string>(v: string | null, allowed: readonly T[], fallback: T) =>
    (allowed as readonly string[]).includes(v ?? '') ? v as T : fallback
  return {
    universe: pick(q.get('u'), UNIVERSES, DEFAULTS.universe),
    period: pick(q.get('p'), PERIODS, DEFAULTS.period),
    sizeBy: pick(q.get('size'), ['marketCap', 'valueTraded'] as const, DEFAULTS.sizeBy),
    focus: q.get('f') || null,
  }
}

export function useView() {
  const view = reactive<View>(readUrl())

  watch(view, (v) => {
    const q = new URLSearchParams()
    if (v.universe !== DEFAULTS.universe)
      q.set('u', v.universe)
    if (v.period !== DEFAULTS.period)
      q.set('p', v.period)
    if (v.sizeBy !== DEFAULTS.sizeBy)
      q.set('size', v.sizeBy)
    if (v.focus)
      q.set('f', v.focus)
    const search = q.toString()
    history.replaceState(null, '', search ? `?${search}` : location.pathname)
  })

  return view
}

export function usePrefs() {
  return {
    convention: useLocalStorage<Convention>('bantu:convention', 'red-up'),
    palette: useLocalStorage<Palette>('bantu:palette', 'pigment'),
  }
}
