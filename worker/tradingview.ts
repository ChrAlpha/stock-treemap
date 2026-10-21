import type { IndexQuote, Period, QuoteRow } from '../shared/snapshot'
import type { Source } from './sources'
import { PERIODS } from '../shared/snapshot'

// TradingView's screener backend. Undocumented; anonymous POST.
const SCAN = 'https://scanner.tradingview.com'
const TIMEOUT = 12_000

// ── Politeness ──────────────────────────────────────────────────
// Every market shares one upstream, so it's throttled as one: a few requests
// at a time per isolate, and when it says slow down (429), every market in
// this isolate stops asking for a while and serves what it has.

const MAX_CONCURRENT = 4
const DEFAULT_PAUSE = 2 * 60_000
const MAX_PAUSE = 15 * 60_000

let active = 0
const waiting: (() => void)[] = []
let pausedUntil = 0

async function acquire() {
  while (active >= MAX_CONCURRENT)
    await new Promise<void>(resolve => waiting.push(resolve))
  active++
}

function release() {
  active--
  waiting.shift()?.()
}

function pauseFor(res: Response) {
  const seconds = Number(res.headers.get('retry-after'))
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_PAUSE
  pausedUntil = Math.max(pausedUntil, Date.now() + Math.min(ms, MAX_PAUSE))
}

/** For tests. */
export function resetThrottle() {
  pausedUntil = 0
}

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

const EXTENDED = new Set<Period>(['pre', 'post'])

interface ScanResponse {
  totalCount: number
  data: { s: string, d: unknown[] }[] | null
  error?: string
}

async function scan(scanner: string, body: unknown): Promise<ScanResponse> {
  await acquire()
  try {
    // Checked after the wait too: a 429 may have landed while this request was queued.
    if (Date.now() < pausedUntil)
      throw new Error(`TradingView asked us to slow down; paused until ${new Date(pausedUntil).toISOString()}`)
    const res = await fetch(`${SCAN}/${scanner}/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    })
    if (res.status === 429)
      pauseFor(res)
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`TradingView ${scanner} scan: HTTP ${res.status}`)
    }
    const json = await res.json<ScanResponse>()
    if (json.error || !Array.isArray(json.data))
      throw new Error(`TradingView ${scanner} scan: ${json.error ?? 'no data'}`)
    return json
  }
  finally {
    release()
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
// Some names come padded with ideographic spaces.
const str = (v: unknown, fallback = '') => (typeof v === 'string' && v.trim() ? v.trim() : fallback)
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

function universe(src: Source, columns: string[], range: number) {
  return {
    filter: src.filter,
    ...(src.filter2 ? { filter2: src.filter2 } : {}),
    options: { lang: src.lang },
    sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
    columns,
    range: [0, range],
  }
}

export interface RefRow {
  symbol: string
  exchange: string
  name: string
  sector: string
  industry: string
}

/** Reference columns only: strings that change rarely. */
export async function fetchReference(src: Source): Promise<{ rows: RefRow[], delay: number }> {
  // A little deeper than the quotes, so a stock that climbs past the cutoff still has a name.
  const depth = src.limit + Math.ceil(src.limit / 5)
  const [json, modes] = await Promise.all([
    scan(src.scanner, universe(src, ['name', 'description', 'exchange', 'sector', 'industry'], depth)),
    // The quote delay is the same across listings; a sample is enough and keeps it off every row.
    scan(src.scanner, universe(src, ['update_mode'], 20)),
  ])
  const seen = new Set<string>()
  const rows: RefRow[] = []
  for (const { s, d: [name, description, exchange, sector, industry] } of json.data!) {
    const symbol = str(name, symbolOf(s))
    if (seen.has(symbol))
      continue
    seen.add(symbol)
    rows.push({
      symbol,
      exchange: str(exchange, s.split(':')[0]),
      name: str(description, symbol),
      sector: str(sector, 'Miscellaneous'),
      industry: str(industry, 'Miscellaneous'),
    })
  }
  const counts = new Map<number, number>()
  for (const { d } of modes.data!) {
    const delay = delayFromMode(d[0])
    counts.set(delay, (counts.get(delay) ?? 0) + 1)
  }
  const delay = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 15
  return { rows, delay }
}

/**
 * Numbers only — this runs on every refresh, so it is the CPU hot path on the
 * free plan (~5ms for ~2.5k rows). Keep the per-row work minimal.
 */
export async function fetchQuotes(src: Source): Promise<QuoteRow[]> {
  const periods = PERIODS.filter(p => src.extended || !EXTENDED.has(p))
  // Column index in the response for each period, or -1 where it isn't requested.
  const at = PERIODS.map(p => periods.includes(p) ? 3 + periods.indexOf(p) : -1)
  const json = await scan(src.scanner, universe(src, ['close', 'market_cap_basic', 'Value.Traded', ...periods.map(p => PERIOD_COLUMNS[p])], src.limit))
  const seen = new Set<string>()
  const rows: QuoteRow[] = []
  for (const { s, d } of json.data!) {
    const price = num(d[0])
    const cap = num(d[1])
    const symbol = symbolOf(s)
    if (price == null || cap == null || seen.has(symbol))
      continue
    seen.add(symbol)
    const row: QuoteRow = [
      symbol,
      Math.round(price * 100) / 100,
      Math.round(cap / 1e4) * 1e4,
      Math.round((num(d[2]) ?? 0) / 1e4) * 1e4,
    ]
    for (const i of at)
      row.push(i < 0 ? null : round2(d[i]))
    rows.push(row)
  }
  return rows
}

export interface SessionState {
  /** The exchange says it's in its regular session. */
  live: boolean
  /** Trading day the latest bar belongs to, YYYY-MM-DD. */
  tradeDate: string | null
}

/** Index quotes for the market's tabs, plus whether it is trading today. */
export async function fetchIndices(src: Source): Promise<{ indices: IndexQuote[], session: SessionState | null }> {
  const probe = src.probe ?? src.indices[0]?.ticker
  const tickers = src.indices.map(i => i.ticker)
  if (probe && !tickers.includes(probe))
    tickers.push(probe)
  if (!tickers.length)
    return { indices: [], session: null }
  const json = await scan(src.indexScanner, {
    symbols: { tickers },
    columns: ['close', 'current_session', 'time_business_day', ...PERIODS.map(p => PERIOD_COLUMNS[p])],
  })
  const byTicker = new Map(json.data!.map(r => [r.s, r.d]))
  const indices = src.indices.flatMap(({ ticker, symbol }) => {
    const d = byTicker.get(ticker)
    const price = num(d?.[0])
    if (!d || price == null)
      return []
    const change: IndexQuote['change'] = {}
    PERIODS.forEach((p, i) => {
      change[p] = round2(d[3 + i])
    })
    return [{ symbol, price, change }]
  })
  const p = probe ? byTicker.get(probe) : undefined
  const day = num(p?.[2])
  const session = p
    ? { live: p[1] === 'market', tradeDate: day == null ? null : new Date(day * 1000).toISOString().slice(0, 10) }
    : null
  return { indices, session }
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

/** Ids of the market's universes a listing belongs to, given its reference-data symbol and name. */
export type Membership = (symbol: string, name: string) => string[]

export async function fetchMembership(src: Source): Promise<Membership> {
  const lists = await Promise.all(Object.entries(src.membership).map(async ([id, { set, min }]) => {
    const json = await scan(src.scanner, {
      symbols: { symbolset: [set] },
      // Same language as the reference data, so name keys line up.
      options: { lang: src.lang },
      columns: ['name', 'description', 'is_primary'],
      range: [0, 1000],
    })
    if (json.data!.length < min)
      throw new Error(`${set}: only ${json.data!.length} members`)
    const keys = json.data!.flatMap(({ s, d: [name, description, primary] }) => {
      const symbol = str(name, symbolOf(s))
      // Name matching is only for secondary share classes; distinct companies can share a name ("First Bancorp").
      return primary === false && typeof description === 'string' ? memberKeys(symbol, description) : memberKeys(symbol)
    })
    return [id, new Set(keys)] as const
  }))
  if (!lists.length)
    return () => []
  return (symbol, name) => {
    const keys = memberKeys(symbol, name)
    return lists.filter(([, set]) => keys.some(k => set.has(k))).map(([id]) => id)
  }
}
