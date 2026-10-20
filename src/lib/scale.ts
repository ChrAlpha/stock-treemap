import type { Oklch } from './color'
import type { Period } from '~shared/snapshot'
import { contrast, mixOklch, oklchToHex } from './color'

// Diverging scale: neutral tile gray at 0, deepening toward each pole.
// Pigment names are the palette's origin — 朱砂 cinnabar, 石绿 malachite;
// the colour-blind alternative swaps in 赭石 ochre and 花青 indigo.

export type Convention = 'red-up' | 'green-up'
export type Palette = 'pigment' | 'cvd'

const FLAT: Oklch = { l: 0.91, c: 0.006, h: 225 }
const INK = '#1c232d'
const WHITE = '#ffffff'

const POLES: Record<Palette, { warm: Oklch, cool: Oklch }> = {
  pigment: {
    warm: { l: 0.53, c: 0.18, h: 30 },
    cool: { l: 0.53, c: 0.11, h: 168 },
  },
  cvd: {
    warm: { l: 0.62, c: 0.145, h: 58 },
    cool: { l: 0.49, c: 0.13, h: 258 },
  },
}

/** Saturation reached at |change| = domain, in percent. Longer windows move more. */
export const DOMAIN: Record<Period, number> = {
  d1: 3,
  pre: 3,
  post: 3,
  d5: 6,
  m1: 10,
  m3: 20,
  ytd: 30,
  y1: 50,
}

const STEPS = 48
// <1 lifts small moves off the neutral so a +0.4% day still reads as up.
const GAMMA = 0.78

export interface Swatch {
  fill: string
  /** Ink or white, whichever reads better on `fill`. */
  text: string
  /** Secondary text on `fill` (the change line). */
  textSoft: string
}

function swatch(c: Oklch): Swatch {
  const fill = oklchToHex(c)
  const onWhite = contrast(fill, WHITE)
  const onInk = contrast(fill, INK)
  const light = onWhite > onInk
  return {
    fill,
    text: light ? WHITE : INK,
    textSoft: light ? 'rgba(255,255,255,0.86)' : 'rgba(28,35,45,0.72)',
  }
}

function ramp(pole: Oklch) {
  const start = { ...FLAT, h: pole.h }
  return Array.from({ length: STEPS + 1 }, (_, i) => {
    const t = i / STEPS
    // Chroma arrives ahead of lightness so mid steps read as clean tints, not grey-tinged.
    const c = mixOklch(start, pole, t)
    return swatch({ ...c, c: start.c + (pole.c - start.c) * t ** 0.62 })
  })
}

export interface Scale {
  domain: number
  /** Swatch for a percent change; null → no data. */
  at: (v: number | null) => Swatch
  /** Text-safe colour for a signed change on the paper background. */
  ink: (v: number | null) => string
  up: Oklch
  down: Oklch
  empty: Swatch
}

export function makeScale(period: Period, convention: Convention, palette: Palette): Scale {
  const { warm, cool } = POLES[palette]
  const up = convention === 'red-up' ? warm : cool
  const down = convention === 'red-up' ? cool : warm
  const upRamp = ramp(up)
  const downRamp = ramp(down)
  const domain = DOMAIN[period]
  const empty = swatch({ l: 0.94, c: 0.004, h: 225 })
  // Darkened poles so coloured numbers on paper clear 4.5:1.
  const upInk = oklchToHex({ ...up, l: Math.min(up.l, 0.5) })
  const downInk = oklchToHex({ ...down, l: Math.min(down.l, 0.5) })
  const neutralInk = '#4b535c'

  return {
    domain,
    up,
    down,
    empty,
    at(v) {
      if (v == null || Number.isNaN(v))
        return empty
      const t = Math.min(Math.abs(v) / domain, 1) ** GAMMA
      const i = Math.round(t * STEPS)
      return (v >= 0 ? upRamp : downRamp)[i]!
    },
    ink(v) {
      if (v == null || Math.abs(v) < 0.005)
        return neutralInk
      return v > 0 ? upInk : downInk
    },
  }
}
