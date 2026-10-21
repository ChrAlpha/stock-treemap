import type { MarketSpec } from '~shared/markets'
import type { Stock } from '~shared/snapshot'

// Hong Kong share-class markers: －Ｗ weighted voting rights, －Ｓ secondary
// listing, －ＳＷ both, －Ｂ pre-revenue biotech. Half- or full-width.
const HK_MARKER = /\s*[－-]\s*[A-ZＡ-Ｚ]{1,2}$/
const CORPORATE = /,?\s+(?:Inc\.?|Incorporated|Corporation|Corp\.?|Company|Co\.|Ltd\.?|Limited|plc|Plc|PLC|N\.V\.|S\.A\.|SE|AG|Holdings?|Group)\s*$/
// A second, narrower pass for "Co., Ltd." without eating "Holdings" off "HSBC Holdings Plc".
const CORPORATE_TAIL = /,?\s+(?:Inc\.?|Corporation|Corp\.?|Co\.|Ltd\.?)\s*$/

/** Company name without legal-form or share-class tails, for tight spots. */
export function shortName(name: string) {
  return name.replace(HK_MARKER, '').replace(CORPORATE, '').replace(CORPORATE_TAIL, '')
}

/** The main label for a stock: its ticker, or its name where tickers are numeric codes. */
export function stockLabel(s: Stock, market: MarketSpec) {
  return market.tileLabel === 'name' ? shortName(s.name) : s.symbol
}

/** The secondary label: whichever of name and ticker isn't the main one. */
export function stockSubLabel(s: Stock, market: MarketSpec) {
  return market.tileLabel === 'name' ? s.symbol : shortName(s.name)
}

const WIDE = /[^\x00-\x7F]/

/**
 * How a search query hits a stock: by ticker prefix, or anywhere in the name
 * (two letters at least, or any CJK character). `q` is trimmed and upper-cased.
 */
export function matchQuery(s: Stock, q: string): 'symbol' | 'name' | null {
  if (!q)
    return null
  if (s.symbol.toUpperCase().startsWith(q))
    return 'symbol'
  if ((q.length >= 2 || WIDE.test(q)) && s.name.toUpperCase().includes(q))
    return 'name'
  return null
}
