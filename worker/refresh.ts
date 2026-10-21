import type { MarketId, MarketSpec } from '../shared/markets'
import type { Period, QuoteRow, QuoteSource, WireMeta, WireQuotes } from '../shared/snapshot'
import type { SessionState } from './tradingview'
import { HOLIDAY_RECHECK, lastSessionDate, marketClock, metaExpiry, quotesExpiry } from '../shared/clock'
import { MARKETS } from '../shared/markets'
import { memberBits, PERIODS, QUOTE_FIELDS } from '../shared/snapshot'
import { SOURCES } from './sources'
import { fetchIndices, fetchMembership, fetchQuotes, fetchReference } from './tradingview'

// Builds one market's data from upstream: fetch, validate, pack into the wire
// format. Validation runs before anything is returned, so a bad response never
// replaces good stored data. Storage is worker/store.ts's concern.

/** KV metadata for stored quotes: enough to decide on a refresh without reading the body. */
export interface QuotesInfo {
  fetchedAt: number
  expiresAt: number
  source: QuoteSource
  count: number
}

/** KV metadata for stored reference data. */
export interface MetaInfo {
  updatedAt: number
  expiresAt: number
  count: number
}

export interface Refreshed<I> {
  body: string
  info: I
}

// The backup has no live session data; go back to the primary source soon.
const BACKUP_TTL = 10 * 60_000

// ── Quotes ──────────────────────────────────────────────────────

function availablePeriods(rows: QuoteRow[]): Period[] {
  // Extended-hours fields are sparse by nature; a fifth of the market is enough to show them.
  return PERIODS.filter((_, i) => {
    let n = 0
    for (const r of rows) {
      if (r[4 + i] != null)
        n++
    }
    return n >= rows.length * 0.2
  })
}

function validateQuotes(rows: QuoteRow[], previous: QuotesInfo | null, source: QuoteSource, minRows: number) {
  const n = rows.length
  if (n < minRows)
    throw new Error(`only ${n} quote rows`)
  if (previous?.source === source && n < previous.count * 0.8)
    throw new Error(`quote rows fell from ${previous.count} to ${n}`)
  let withChange = 0
  for (const r of rows) {
    if (r[4] != null)
      withChange++
  }
  if (withChange < n * 0.9)
    throw new Error(`daily change missing on ${n - withChange} of ${n} rows`)
}

interface Pack {
  source: QuoteSource
  rows: QuoteRow[]
  indices: WireQuotes['indices']
  session: SessionState | null
  fetchedAt: number
  /** Overrides the session-based expiry. */
  expiresAt?: number
}

function packQuotes(m: MarketSpec, { source, rows, indices, session, fetchedAt, expiresAt }: Pack): Refreshed<QuotesInfo> {
  const clock = marketClock(m, new Date(fetchedAt))
  // A weekday the calendar thinks is open, but the market hasn't printed a bar today
  // (given the delayed feed time to show the open).
  const holiday = clock.phase === 'regular' && clock.minutes >= m.sessions[0]!.open + m.delay + 5
    && !!session && !session.live && !!session.tradeDate && session.tradeDate < clock.date
  expiresAt ??= holiday ? Math.max(quotesExpiry(m, fetchedAt), fetchedAt + HOLIDAY_RECHECK) : quotesExpiry(m, fetchedAt)
  const wire: WireQuotes = {
    v: 2,
    market: m.id,
    source,
    fetchedAt,
    expiresAt,
    periods: availablePeriods(rows),
    tradeDate: session?.tradeDate ?? null,
    holiday,
    fields: QUOTE_FIELDS,
    rows,
    indices,
  }
  return { body: JSON.stringify(wire), info: { fetchedAt, expiresAt, source, count: rows.length } }
}

export async function refreshQuotes(id: MarketId, previous: QuotesInfo | null): Promise<Refreshed<QuotesInfo>> {
  const m = MARKETS[id]
  const src = SOURCES[id]
  const now = Date.now()
  try {
    const [rows, { indices, session }] = await Promise.all([
      fetchQuotes(src),
      fetchIndices(src).catch((err) => {
        console.error(id, 'index quotes failed', String(err))
        return { indices: [], session: null }
      }),
    ])
    validateQuotes(rows, previous, 'tradingview', src.minRows)
    return packQuotes(m, { source: 'tradingview', rows, indices, session, fetchedAt: now })
  }
  catch (err) {
    if (!src.backup)
      throw err
    // Stale TradingView data from the latest session beats the backup's end-of-day table.
    const held = previous && lastSessionDate(m, new Date(previous.fetchedAt))
    if (held && held >= lastSessionDate(m, new Date(now)))
      throw err
    const backup = await src.backup.fetch()
    if (held && (!backup.asOf || backup.asOf <= held))
      throw err
    validateQuotes(backup.rows, null, src.backup.source, src.minRows)
    return packQuotes(m, { source: src.backup.source, rows: backup.rows, indices: [], session: null, fetchedAt: now, expiresAt: now + BACKUP_TTL })
  }
}

// ── Reference data ──────────────────────────────────────────────

/** Interns strings into a list, so rows carry small indexes instead of repeated names. */
function interner() {
  const list: string[] = []
  const index = new Map<string, number>()
  return {
    list,
    of(key: string) {
      let i = index.get(key)
      if (i === undefined) {
        i = list.push(key) - 1
        index.set(key, i)
      }
      return i
    },
  }
}

export async function refreshMeta(id: MarketId, previous: MetaInfo | null): Promise<Refreshed<MetaInfo>> {
  const m = MARKETS[id]
  const src = SOURCES[id]
  const [{ rows, delay }, membership] = await Promise.all([
    fetchReference(src),
    fetchMembership(src).catch((err) => {
      console.error(id, 'index membership failed', String(err))
      return null
    }),
  ])
  if (rows.length < src.minRows)
    throw new Error(`only ${rows.length} reference rows`)
  // Keep yesterday's membership rather than publish a map with no index universes.
  if (!membership && previous)
    throw new Error('index membership unavailable')

  const sectors = interner()
  const industries = interner()
  const now = Date.now()
  const wire: WireMeta = {
    v: 2,
    market: id,
    updatedAt: now,
    expiresAt: metaExpiry(m, now),
    delay,
    sectors: sectors.list,
    industries: industries.list,
    fields: ['symbol', 'exchange', 'name', 'sector', 'industry', 'members'],
    rows: rows.map(r => [
      r.symbol,
      r.exchange,
      r.name,
      sectors.of(r.sector),
      industries.of(r.industry),
      membership ? memberBits(m, membership(r.symbol, r.name)) : 0,
    ]),
  }
  return { body: JSON.stringify(wire), info: { updatedAt: now, expiresAt: wire.expiresAt, count: rows.length } }
}
