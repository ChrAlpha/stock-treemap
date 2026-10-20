// Wire formats for the public API, shared by the Worker and the web app.
//
// Data is split by how often it changes:
// - meta   — names, taxonomy, index membership; refreshed once per trading day
// - quotes — prices and changes; refreshed on demand while the market moves
// Rows are positional arrays to keep payloads small; `joinSnapshot` turns a
// meta + quotes pair into objects.

export const PERIODS = ['d1', 'pre', 'post', 'd5', 'm1', 'm3', 'ytd', 'y1'] as const
export type Period = typeof PERIODS[number]

export const UNIVERSES = ['sp500', 'ndx', 'dji', 'all'] as const
export type Universe = typeof UNIVERSES[number]

/** Bit flags for index membership. */
export const MEMBER = { sp500: 1, ndx: 2, dji: 4 } as const

export type QuoteSource = 'tradingview' | 'nasdaq'

export interface IndexQuote {
  symbol: string
  name: string
  price: number
  change: Partial<Record<Period, number | null>>
}

/** [symbol, exchange, name, sector index, industry index, membership bits] */
export type MetaRow = [string, string, string, number, number, number]

export interface WireMeta {
  v: 1
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
  v: 1
  source: QuoteSource
  fetchedAt: number
  expiresAt: number
  /** Periods the source filled for a meaningful share of stocks. */
  periods: Period[]
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
  source: QuoteSource
  fetchedAt: number
  expiresAt: number
  delay: number
  periods: Period[]
  stocks: Stock[]
  indices: IndexQuote[]
  /** Quote rows with no reference data yet (e.g. a listing newer than meta). */
  unmatched: number
}

export function joinSnapshot(meta: WireMeta, quotes: WireQuotes): Snapshot {
  const ref = new Map(meta.rows.map(r => [r[0], r]))
  const stocks: Stock[] = []
  let unmatched = 0
  for (const q of quotes.rows) {
    const m = ref.get(q[0])
    if (!m) {
      unmatched++
      continue
    }
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
    source: quotes.source,
    fetchedAt: quotes.fetchedAt,
    expiresAt: quotes.expiresAt,
    delay: meta.delay,
    periods: quotes.periods,
    stocks,
    indices: quotes.indices,
    unmatched,
  }
}

export function universeOf(stocks: Stock[], u: Universe) {
  if (u === 'all')
    return stocks
  const members = stocks.filter(s => s.members & MEMBER[u])
  // Membership unavailable: approximate by size rather than return nothing.
  const fallback = { sp500: 500, ndx: 100, dji: 30 }[u]
  return members.length ? members : [...stocks].sort((a, b) => b.marketCap - a.marketCap).slice(0, fallback)
}
