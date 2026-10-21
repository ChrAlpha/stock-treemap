import type { Convention, Palette } from '../lib/scale'
import type { Focus, SizeBy } from '../lib/treemap'
import type { MarketId } from '~shared/markets'
import type { Period } from '~shared/snapshot'
import { useLocalStorage } from '@vueuse/core'
import { reactive, watch } from 'vue'
import { isMarketId, MARKETS } from '~shared/markets'
import { PERIODS } from '~shared/snapshot'

// View state lives in the URL so a map can be shared or bookmarked;
// display preferences live in localStorage.

export interface View {
  market: MarketId
  universe: string
  period: Period
  sizeBy: SizeBy
  focus: Focus
}

const DEFAULTS = { period: 'd1', sizeBy: 'marketCap' } as const

export const defaultUniverse = (m: MarketId) => MARKETS[m].universes[0]!.id

function readUrl(lastMarket: MarketId): View {
  const q = new URLSearchParams(location.search)
  const pick = <T extends string>(v: string | null, allowed: readonly T[], fallback: T) =>
    (allowed as readonly string[]).includes(v ?? '') ? v as T : fallback
  // A shared link always names its market; a bare visit opens the last one viewed.
  const m = q.get('m')
  const market = isMarketId(m) ? m : lastMarket
  return {
    market,
    universe: pick(q.get('u'), MARKETS[market].universes.map(u => u.id), defaultUniverse(market)),
    period: pick(q.get('p'), PERIODS, DEFAULTS.period),
    sizeBy: pick(q.get('size'), ['marketCap', 'valueTraded'] as const, DEFAULTS.sizeBy),
    focus: q.get('f') || null,
  }
}

export function useView() {
  const last = useLocalStorage<string>('bantu:market', 'us')
  const view = reactive<View>(readUrl(isMarketId(last.value) ? last.value : 'us'))

  watch(view, (v) => {
    last.value = v.market
    const q = new URLSearchParams()
    // Always written, so a shared link doesn't fall back to the recipient's last market.
    q.set('m', v.market)
    if (v.universe !== defaultUniverse(v.market))
      q.set('u', v.universe)
    if (v.period !== DEFAULTS.period)
      q.set('p', v.period)
    if (v.sizeBy !== DEFAULTS.sizeBy)
      q.set('size', v.sizeBy)
    if (v.focus)
      q.set('f', v.focus)
    history.replaceState(null, '', `?${q}`)
  }, { immediate: true })

  return view
}

export function usePrefs() {
  return {
    convention: useLocalStorage<Convention>('bantu:convention', 'red-up'),
    palette: useLocalStorage<Palette>('bantu:palette', 'pigment'),
  }
}
