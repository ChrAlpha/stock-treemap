import type { IndexQuote, Period, QuoteRow } from '../shared/snapshot'
import { PERIODS } from '../shared/snapshot'

// TradingView's screener backend. Undocumented; anonymous POST.
const SCAN = 'https://scanner.tradingview.com'
const TIMEOUT = 12_000

const PERIOD_COLUMNS: Record<Period, string> = {
  d1: 'change',
  pre: 'premarket_change',
  post: 'postmarket_change',
  d5: 'Perf.5D',
  m1: 'Perf.1M',
  m3: 'Perf.3M',
  ytd: 'Perf.YTD',
  y1: 'Perf.Y',
}

// US-listed common stock and listed ADRs above $1B, one row per company.
const UNIVERSE = {
  filter: [
    { left: 'market_cap_basic', operation: 'greater', right: 1e9 },
    { left: 'exchange', operation: 'in_range', right: ['NASDAQ', 'NYSE', 'AMEX'] },
    { left: 'type', operation: 'in_range', right: ['stock', 'dr'] },
    { left: 'subtype', operation: 'nequal', right: 'preferred' },
  ],
  // Primary listings only (drops GOOGL next to GOOG), but keep foreign companies whose primary listing is abroad.
  filter2: {
    operator: 'and',
    operands: [{
      operation: {
        operator: 'or',
        operands: [
          { expression: { left: 'is_primary', operation: 'equal', right: true } },
          { expression: { left: 'type', operation: 'equal', right: 'dr' } },
          // Foreign companies cross-listed as common stock (RY, AZN, TRI).
          { expression: { left: 'country', operation: 'nequal', right: 'United States' } },
        ],
      },
    }],
  },
  options: { lang: 'en' },
  sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
  range: [0, 4000],
}

interface ScanResponse {
  totalCount: number
  data: { s: string, d: unknown[] }[] | null
  error?: string
}

async function scan(market: string, body: unknown): Promise<ScanResponse> {
  const res = await fetch(`${SCAN}/${market}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok)
    throw new Error(`TradingView ${market} scan: HTTP ${res.status}`)
  const json = await res.json<ScanResponse>()
  if (json.error || !Array.isArray(json.data))
    throw new Error(`TradingView ${market} scan: ${json.error ?? 'no data'}`)
  return json
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown, fallback = '') => (typeof v === 'string' && v ? v : fallback)
const round2 = (v: unknown) => {
  const n = num(v)
  return n == null ? null : Math.round(n * 100) / 100
}
const symbolOf = (s: string) => s.slice(s.indexOf(':') + 1)

function delayFromMode(mode: unknown) {
  if (typeof mode !== 'string')
    return 15
  if (mode === 'streaming' || mode === 'realtime')
    return 0
  const seconds = Number(mode.match(/(\d+)$/)?.[1])
  return Number.isFinite(seconds) ? Math.round(seconds / 60) : 15
}

export interface RefRow {
  symbol: string
  exchange: string
  name: string
  sector: string
  industry: string
}

/** Reference columns only: strings that change rarely. */
export async function fetchReference(): Promise<{ rows: RefRow[], delay: number }> {
  const [json, modes] = await Promise.all([
    scan('america', { ...UNIVERSE, columns: ['name', 'description', 'exchange', 'sector', 'industry'] }),
    // The quote delay is the same across listings; a sample is enough and keeps it off every row.
    scan('america', { ...UNIVERSE, columns: ['update_mode'], range: [0, 20] }),
  ])
  const rows = json.data!.map(({ s, d: [name, description, exchange, sector, industry] }) => {
    const symbol = str(name, symbolOf(s))
    return {
      symbol,
      exchange: str(exchange, s.split(':')[0]),
      name: str(description, symbol),
      sector: str(sector, 'Miscellaneous'),
      industry: str(industry, 'Miscellaneous'),
    }
  })
  const counts = new Map<number, number>()
  for (const { d } of modes.data!) {
    const delay = delayFromMode(d[0])
    counts.set(delay, (counts.get(delay) ?? 0) + 1)
  }
  const delay = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 15
  return { rows, delay }
}

const QUOTE_COLUMNS = ['close', 'market_cap_basic', 'Value.Traded', ...PERIODS.map(p => PERIOD_COLUMNS[p])]

/**
 * Numbers only — this runs on every refresh, so it is the CPU hot path on the
 * free plan (~5ms for ~2.5k rows). Keep the per-row work minimal.
 */
export async function fetchQuotes(): Promise<QuoteRow[]> {
  const json = await scan('america', { ...UNIVERSE, columns: QUOTE_COLUMNS })
  const rows: QuoteRow[] = []
  for (const { s, d } of json.data!) {
    const price = num(d[0])
    const cap = num(d[1])
    if (price == null || cap == null)
      continue
    rows.push([
      symbolOf(s),
      Math.round(price * 100) / 100,
      Math.round(cap / 1e4) * 1e4,
      Math.round((num(d[2]) ?? 0) / 1e4) * 1e4,
      round2(d[3]),
      round2(d[4]),
      round2(d[5]),
      round2(d[6]),
      round2(d[7]),
      round2(d[8]),
      round2(d[9]),
      round2(d[10]),
    ])
  }
  return rows
}

const INDICES: { ticker: string, symbol: string, name: string }[] = [
  { ticker: 'SP:SPX', symbol: 'SPX', name: '标普 500' },
  { ticker: 'NASDAQ:NDX', symbol: 'NDX', name: '纳指 100' },
  { ticker: 'DJ:DJI', symbol: 'DJI', name: '道琼斯' },
  { ticker: 'TVC:RUT', symbol: 'RUT', name: '罗素 2000' },
  { ticker: 'TVC:VIX', symbol: 'VIX', name: 'VIX' },
]

export async function fetchIndices(): Promise<IndexQuote[]> {
  const json = await scan('global', {
    symbols: { tickers: INDICES.map(i => i.ticker) },
    columns: ['close', ...PERIODS.map(p => PERIOD_COLUMNS[p])],
  })
  const byTicker = new Map(json.data!.map(r => [r.s, r.d]))
  return INDICES.flatMap(({ ticker, symbol, name }) => {
    const d = byTicker.get(ticker)
    const price = num(d?.[0])
    if (!d || price == null)
      return []
    const change: IndexQuote['change'] = {}
    PERIODS.forEach((p, i) => {
      change[p] = round2(d[1 + i])
    })
    return [{ symbol, name, price, change }]
  })
}

/** Strip share-class suffixes so BRK.A matches the index's BRK.B. */
export const baseTicker = (symbol: string) => symbol.replace(/[./][A-Z]$/, '')

/**
 * Keys an index member can be matched by. The primary listing isn't always the
 * class the index holds (GOOG vs GOOGL, BRK.A vs BRK.B), so match on the ticker
 * base or the company's full name, which share classes have in common.
 * (logoid looked tempting but KO's bottlers share it.)
 */
export function memberKeys(symbol: string, name?: string) {
  const keys = [baseTicker(symbol)]
  const company = name?.replace(/\s+(?:Class|Series)\s+[A-Z]\b.*$/i, '').trim()
  if (company)
    keys.push(`name:${company}`)
  return keys
}

export interface Membership {
  sp500: Set<string>
  ndx: Set<string>
  dji: Set<string>
}

export async function fetchMembership(): Promise<Membership> {
  const list = async (symbolset: string, min: number) => {
    const json = await scan('america', {
      symbols: { symbolset: [symbolset] },
      options: { lang: 'en' },
      columns: ['name', 'description', 'is_primary'],
      range: [0, 1000],
    })
    // Expected sizes: 503 / 101 / 30 listings; anything well short means a truncated response.
    if (json.data!.length < min)
      throw new Error(`${symbolset}: only ${json.data!.length} members`)
    const keys = json.data!.flatMap(({ s, d: [name, description, primary] }) => {
      const symbol = str(name, symbolOf(s))
      // Name matching is only for secondary share classes; distinct companies can share a name ("First Bancorp").
      return primary === false && typeof description === 'string' ? memberKeys(symbol, description) : memberKeys(symbol)
    })
    return new Set(keys)
  }
  const [sp500, ndx, dji] = await Promise.all([
    list('SYML:SP;SPX', 480),
    list('SYML:NASDAQ;NDX', 95),
    list('SYML:DJ;DJI', 29),
  ])
  return { sp500, ndx, dji }
}
