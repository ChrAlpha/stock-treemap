import type { QuoteRow } from '../shared/snapshot'

// Nasdaq.com screener backend — backup quote source. Daily change only, and it
// moves roughly end-of-day, so it's only worth using when TradingView has been
// down since before the latest session.
//
// The mid-cap-and-up filter (≥ $2B) keeps the response near 300KB so parsing
// fits the free plan's CPU budget; the plain table carries no volume or
// sector, which the reference data already covers.
const URL_ = 'https://api.nasdaq.com/api/screener/stocks?tableonly=true&offset=0&limit=5000&marketcap=mega|large|mid'

interface NasdaqTable {
  data?: {
    asof?: string
    table?: { rows?: Record<string, string>[] }
  }
}

const toNumber = (s: unknown) => {
  if (typeof s !== 'string')
    return null
  const n = Number(s.replace(/[$,%\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

export async function fetchNasdaqQuotes(): Promise<{ asOf: string | null, rows: QuoteRow[] }> {
  const res = await fetch(URL_, {
    headers: {
      // The endpoint rejects requests without a browser-like UA.
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      'accept': 'application/json',
    },
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok)
    throw new Error(`Nasdaq screener: HTTP ${res.status}`)
  const json = await res.json<NasdaqTable>()
  const table = json.data?.table?.rows
  if (!Array.isArray(table))
    throw new Error('Nasdaq screener: no rows')

  // "Last price as of Oct 19, 2026" → 2026-10-19
  const text = json.data?.asof?.replace(/^.*as of\s*/i, '')
  const t = text ? Date.parse(`${text} UTC`) : Number.NaN
  const asOf = Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null

  const rows: QuoteRow[] = []
  for (const r of table) {
    const price = toNumber(r.lastsale)
    const cap = toNumber(r.marketCap)
    if (!r.symbol || !price || !cap)
      continue
    rows.push([r.symbol.trim().replace('/', '.'), price, cap, 0, toNumber(r.pctchange), null, null, null, null, null, null, null])
  }
  return { asOf, rows }
}
