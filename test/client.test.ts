import type { Stock } from '../shared/snapshot'
import { describe, expect, it } from 'vitest'
import { MARKETS } from '../shared/markets'
import { memberBits, universeOf } from '../shared/snapshot'
import { contrast } from '../src/lib/color'
import { pct } from '../src/lib/format'
import { matchQuery, shortName, stockLabel } from '../src/lib/names'
import { makeScale } from '../src/lib/scale'
import { industryId, parentFocus, parseFocus, sectorId } from '../src/lib/treemap'

const stock = (s: Partial<Stock>): Stock => ({
  symbol: 'X',
  exchange: 'X',
  name: 'X',
  sector: 'Finance',
  industry: 'Major Banks',
  price: 1,
  marketCap: 1,
  valueTraded: 0,
  members: 0,
  change: { d1: 0, pre: null, post: null, d5: null, m1: null, m3: null, ytd: null, y1: null },
  ...s,
})

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

describe('names', () => {
  it('drops Hong Kong share-class markers and legal forms', () => {
    expect(shortName('小米集團－Ｗ')).toBe('小米集團')
    expect(shortName('百度集團－ＳＷ')).toBe('百度集團')
    expect(shortName('Samsung Electronics Co., Ltd.')).toBe('Samsung Electronics')
    expect(shortName('HSBC Holdings Plc')).toBe('HSBC Holdings')
    expect(shortName('工商银行')).toBe('工商银行')
  })

  it('labels tiles by name where tickers are numeric codes', () => {
    const s = stock({ symbol: '700', name: '騰訊控股' })
    expect(stockLabel(s, MARKETS.hk)).toBe('騰訊控股')
    expect(stockLabel(stock({ symbol: 'NVDA', name: 'NVIDIA Corporation' }), MARKETS.us)).toBe('NVDA')
  })

  it('searches by ticker prefix, or by name from one CJK character', () => {
    const moutai = stock({ symbol: '600519', name: '贵州茅台' })
    const nvda = stock({ symbol: 'NVDA', name: 'NVIDIA Corporation' })
    expect(matchQuery(moutai, '6005')).toBe('symbol')
    expect(matchQuery(moutai, '茅')).toBe('name')
    expect(matchQuery(nvda, 'N')).toBe('symbol')
    expect(matchQuery(nvda, 'C')).toBeNull() // one Latin letter: tickers only
    expect(matchQuery(nvda, 'CORP')).toBe('name')
  })
})

describe('universeOf', () => {
  it('reads membership bits in the market\'s universe order', () => {
    // hk: hsi = bit 0, hstech = bit 1.
    const list = [stock({ symbol: '700', members: 3 }), stock({ symbol: '5', members: 1 }), stock({ symbol: '9999', members: 0 })]
    expect(universeOf(list, MARKETS.hk, 'hsi').map(s => s.symbol)).toEqual(['700', '5'])
    expect(universeOf(list, MARKETS.hk, 'hstech').map(s => s.symbol)).toEqual(['700'])
    expect(universeOf(list, MARKETS.hk, 'all')).toHaveLength(3)
  })

  it('reads back the bits the Worker writes', () => {
    const members = memberBits(MARKETS.us, ['ndx', 'sp500', 'unknown'])
    const list = [stock({ symbol: 'NVDA', members }), stock({ symbol: 'IBM', members: memberBits(MARKETS.us, ['sp500', 'dji']) })]
    expect(universeOf(list, MARKETS.us, 'ndx').map(s => s.symbol)).toEqual(['NVDA'])
    expect(universeOf(list, MARKETS.us, 'sp500')).toHaveLength(2)
  })
})

describe('focus ids', () => {
  it('round-trips sectors and industries, slashes included', () => {
    expect(parseFocus(sectorId('Finance'))).toEqual({ sector: 'Finance', industry: null })
    expect(parseFocus(industryId('Consumer Durables', 'Electronics/Appliances'))).toEqual({ sector: 'Consumer Durables', industry: 'Electronics/Appliances' })
  })

  it('rejects malformed ids from a hand-edited link', () => {
    for (const f of [null, '', 's:', 'i:Finance', 'i:Finance/', 'x:Finance'])
      expect(parseFocus(f), String(f)).toBeNull()
  })

  it('zooms out one level at a time', () => {
    expect(parentFocus(industryId('Finance', 'Major Banks'))).toBe(sectorId('Finance'))
    expect(parentFocus(sectorId('Finance'))).toBeNull()
    expect(parentFocus(null)).toBeNull()
  })
})
