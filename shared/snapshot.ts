// Wire formats between the Worker and the web app, one pair per market.
//
// Data is split by how often it changes:
// - meta   — names, taxonomy, index membership; refreshed once per trading day
// - quotes — prices and changes; refreshed on demand while the market moves
// Rows are positional arrays to keep payloads small; `joinSnapshot` turns a
// meta + quotes pair into objects.

import type { MarketId, MarketSpec } from './markets'

export const PERIODS = ['d1', 'pre', 'post', 'd5', 'm1', 'm3', 'ytd', 'y1'] as const
export type Period = typeof PERIODS[number]

export type QuoteSource = 'tradingview' | 'nasdaq'

export interface IndexQuote {
  /** Matches `UniverseSpec.index` / `ExtraQuote.symbol`. */
  symbol: string
  price: number
  change: Partial<Record<Period, number | null>>
}

/**
 * [symbol, exchange, name, sector index, industry index, membership bits]
 * Bit i is set when the stock belongs to the market's i-th universe.
 */
export type MetaRow = [string, string, string, number, number, number]

export interface WireMeta {
  v: 2
  market: MarketId
  updatedAt: number
  /** Next time the Worker will consider refreshing (epoch ms). */
  expiresAt: number
  /** Upstream quote delay in minutes. */
  delay: number
  sectors: string[]
  industries: string[]
  fields: ['symbol', 'exchange', 'name', 'sector', 'industry', 'members']
  rows: MetaRow[]
}

export const QUOTE_FIELDS = ['symbol', 'price', 'marketCap', 'valueTraded', ...PERIODS] as const

/** [symbol, price, marketCap, valueTraded, ...changes in PERIODS order] */
export type QuoteRow = [string, number, number, number, ...(number | null)[]]

export interface WireQuotes {
  v: 2
  market: MarketId
  source: QuoteSource
  fetchedAt: number
  expiresAt: number
  /** Periods the source filled for a meaningful share of stocks. */
  periods: Period[]
  /** Trading day the data belongs to, YYYY-MM-DD, when the source says. */
  tradeDate: string | null
  /** The calendar says the market is open, but the source says it hasn't traded today. */
  holiday: boolean
  fields: typeof QUOTE_FIELDS
  rows: QuoteRow[]
  indices: IndexQuote[]
}

export interface Stock {
  symbol: string
  exchange: string
  name: string
  sector: string
  industry: string
  price: number
  marketCap: number
  valueTraded: number
  members: number
  change: Record<Period, number | null>
}

export interface Snapshot {
  market: MarketId
  source: QuoteSource
  fetchedAt: number
  expiresAt: number
  delay: number
  periods: Period[]
  tradeDate: string | null
  holiday: boolean
  stocks: Stock[]
  indices: IndexQuote[]
}

export function joinSnapshot(meta: WireMeta, quotes: WireQuotes): Snapshot {
  const ref = new Map(meta.rows.map(r => [r[0], r]))
  const stocks: Stock[] = []
  for (const q of quotes.rows) {
    // A listing newer than the reference data waits for the next meta refresh.
    const m = ref.get(q[0])
    if (!m)
      continue
    const change = {} as Record<Period, number | null>
    PERIODS.forEach((p, i) => {
      change[p] = (q[4 + i] as number | null) ?? null
    })
    stocks.push({
      symbol: q[0],
      exchange: m[1],
      name: m[2],
      sector: meta.sectors[m[3]]!,
      industry: meta.industries[m[4]]!,
      price: q[1],
      marketCap: q[2],
      valueTraded: q[3],
      members: m[5],
      change,
    })
  }
  return {
    market: quotes.market,
    source: quotes.source,
    fetchedAt: quotes.fetchedAt,
    expiresAt: quotes.expiresAt,
    delay: meta.delay,
    periods: quotes.periods,
    tradeDate: quotes.tradeDate,
    holiday: quotes.holiday,
    stocks,
    indices: quotes.indices,
  }
}

/** `MetaRow` membership bits for the universes a stock belongs to, by id. */
export function memberBits(market: MarketSpec, universes: readonly string[]) {
  let bits = 0
  market.universes.forEach((u, i) => {
    if (universes.includes(u.id))
      bits |= 1 << i
  })
  return bits
}

/** The stocks in one of the market's universes, read from their membership bits. */
export function universeOf(stocks: Stock[], market: MarketSpec, id: string) {
  const i = market.universes.findIndex(u => u.id === id)
  const u = market.universes[i]
  if (!u || u.id === 'all')
    return stocks
  const members = stocks.filter(s => s.members & (1 << i))
  // Membership unavailable: approximate by size rather than return nothing.
  return members.length || !u.size ? members : [...stocks].sort((a, b) => b.marketCap - a.marketCap).slice(0, u.size)
}
