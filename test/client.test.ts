import { describe, expect, it } from 'vitest'
import { contrast } from '../src/lib/color'
import { pct } from '../src/lib/format'
import { makeScale } from '../src/lib/scale'

describe('pct', () => {
  it('uses a true minus and trims decimals as values grow', () => {
    expect(pct(0.4237)).toBe('+0.42%')
    expect(pct(-3.17)).toBe('−3.17%')
    expect(pct(12.345)).toBe('+12.3%')
    expect(pct(0.001)).toBe('0.00%')
    expect(pct(null)).toBe('—')
  })
})

describe('scale', () => {
  for (const palette of ['pigment', 'cvd'] as const) {
    it(`${palette}: tile labels stay readable at every step`, () => {
      const s = makeScale('d1', 'red-up', palette)
      for (let v = -4; v <= 4; v += 0.25) {
        const sw = s.at(v)
        expect(contrast(sw.fill, sw.text)).toBeGreaterThanOrEqual(3.6)
      }
    })
    it(`${palette}: coloured numbers on paper clear 4.5:1`, () => {
      const s = makeScale('d1', 'red-up', palette)
      expect(contrast(s.ink(1), '#f1f7f8')).toBeGreaterThanOrEqual(4.5)
      expect(contrast(s.ink(-1), '#f1f7f8')).toBeGreaterThanOrEqual(4.5)
    })
  }
  it('swaps poles with the convention', () => {
    const cn = makeScale('d1', 'red-up', 'pigment')
    const us = makeScale('d1', 'green-up', 'pigment')
    expect(cn.at(3).fill).toBe(us.at(-3).fill)
  })
})
