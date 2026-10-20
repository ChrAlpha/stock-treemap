import type { Period, QuoteRow, QuoteSource, WireMeta, WireQuotes } from '../shared/snapshot'
import type { Membership } from './tradingview'
import { lastSessionDate, metaExpiry, quotesExpiry } from '../shared/market'
import { MEMBER, PERIODS, QUOTE_FIELDS } from '../shared/snapshot'
import { fetchNasdaqQuotes } from './nasdaq'
import { fetchIndices, fetchMembership, fetchQuotes, fetchReference, memberKeys } from './tradingview'

// On-demand data: nothing is fetched until a request needs it. A request that
// finds stored data past its expiry refreshes it from upstream, writes it back
// to KV and serves it; Workers Caching in front collapses concurrent requests,
// so a burst of visitors still produces one upstream call per data centre tier.

const QUOTES_KEY = 'quotes:v1'
const META_KEY = 'meta:v1'

export interface QuotesInfo {
  fetchedAt: number
  expiresAt: number
  source: QuoteSource
  count: number
}

export interface MetaInfo {
  updatedAt: number
  expiresAt: number
  count: number
}

export interface Loaded<I> {
  body: ReadableStream | string
  info: I
  /** Set when upstream failed and older data is being served instead. */
  stale?: string
}

// ── Single flight ───────────────────────────────────────────────

const inflight = new Map<string, Promise<unknown>>()
const lastFailure = new Map<string, number>()
// After a failed refresh, serve stored data for a while instead of retrying on every request.
const RETRY_AFTER = 30_000

function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  let p = inflight.get(key) as Promise<T> | undefined
  if (!p) {
    p = run()
      .catch((err) => {
        lastFailure.set(key, Date.now())
        throw err
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, p)
  }
  return p
}

export async function load<I extends { expiresAt: number }>(
  kv: KVNamespace,
  key: string,
  refresh: (previous: I | null) => Promise<{ body: string, info: I }>,
): Promise<Loaded<I>> {
  const stored = await kv.getWithMetadata<I>(key, { type: 'stream', cacheTtl: 30 })
  const now = Date.now()
  if (stored.value && stored.metadata && now < stored.metadata.expiresAt)
    return { body: stored.value, info: stored.metadata }

  if (stored.value && stored.metadata && now - (lastFailure.get(key) ?? 0) < RETRY_AFTER)
    return { body: stored.value, info: stored.metadata, stale: 'upstream recently failed' }

  try {
    const fresh = await once(key, async () => {
      const result = await refresh(stored.metadata)
      // Serve fresh data even if the write is rejected (KV allows ~1 write/s per key).
      await kv.put(key, result.body, { metadata: result.info }).catch(err => console.error('KV put failed', key, String(err)))
      return result
    })
    await stored.value?.cancel()
    return fresh
  }
  catch (err) {
    console.error('refresh failed', key, String(err))
    if (stored.value && stored.metadata)
      return { body: stored.value, info: stored.metadata, stale: String(err) }
    throw err
  }
}

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

function validateQuotes(rows: QuoteRow[], previous: QuotesInfo | null, source: QuoteSource) {
  const n = rows.length
  if (n < 1000)
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

function packQuotes(source: QuoteSource, rows: QuoteRow[], indices: WireQuotes['indices'], fetchedAt: number, expiresAt: number) {
  const wire: WireQuotes = {
    v: 1,
    source,
    fetchedAt,
    expiresAt,
    periods: availablePeriods(rows),
    fields: QUOTE_FIELDS,
    rows,
    indices,
  }
  const info: QuotesInfo = { fetchedAt, expiresAt, source, count: rows.length }
  return { body: JSON.stringify(wire), info }
}

async function refreshQuotes(previous: QuotesInfo | null) {
  const now = Date.now()
  try {
    const [rows, indices] = await Promise.all([
      fetchQuotes(),
      fetchIndices().catch((err) => {
        console.error('index quotes failed', String(err))
        return []
      }),
    ])
    validateQuotes(rows, previous, 'tradingview')
    return packQuotes('tradingview', rows, indices, now, quotesExpiry(now))
  }
  catch (err) {
    // Stale TradingView data from the latest session beats Nasdaq's end-of-day table.
    const held = previous && lastSessionDate(new Date(previous.fetchedAt))
    if (held && held >= lastSessionDate(new Date(now)))
      throw err
    const backup = await fetchNasdaqQuotes()
    if (held && (!backup.asOf || backup.asOf <= held))
      throw err
    validateQuotes(backup.rows, null, 'nasdaq')
    // Try the primary source again soon.
    return packQuotes('nasdaq', backup.rows, [], now, now + 10 * 60_000)
  }
}

export const loadQuotes = (kv: KVNamespace) => load<QuotesInfo>(kv, QUOTES_KEY, refreshQuotes)

// ── Reference data ──────────────────────────────────────────────

function memberBits(m: Membership | null, symbol: string, name: string) {
  if (!m)
    return 0
  const keys = memberKeys(symbol, name)
  const has = (set: Set<string>) => keys.some(k => set.has(k))
  return (has(m.sp500) ? MEMBER.sp500 : 0) | (has(m.ndx) ? MEMBER.ndx : 0) | (has(m.dji) ? MEMBER.dji : 0)
}

async function refreshMeta(previous: MetaInfo | null) {
  const [{ rows, delay }, membership] = await Promise.all([
    fetchReference(),
    fetchMembership().catch((err) => {
      console.error('index membership failed', String(err))
      return null
    }),
  ])
  if (rows.length < 1000)
    throw new Error(`only ${rows.length} reference rows`)
  // Keep yesterday's membership rather than publish a map with no index universes.
  if (!membership && previous)
    throw new Error('index membership unavailable')

  const sectors: string[] = []
  const industries: string[] = []
  const index = (list: string[], map: Map<string, number>, key: string) => {
    let i = map.get(key)
    if (i === undefined) {
      i = list.push(key) - 1
      map.set(key, i)
    }
    return i
  }
  const sectorIdx = new Map<string, number>()
  const industryIdx = new Map<string, number>()
  const now = Date.now()
  const wire: WireMeta = {
    v: 1,
    updatedAt: now,
    expiresAt: metaExpiry(now),
    delay,
    sectors,
    industries,
    fields: ['symbol', 'exchange', 'name', 'sector', 'industry', 'members'],
    rows: rows.map(r => [
      r.symbol,
      r.exchange,
      r.name,
      index(sectors, sectorIdx, r.sector),
      index(industries, industryIdx, r.industry),
      memberBits(membership, r.symbol, r.name),
    ]),
  }
  const info: MetaInfo = { updatedAt: now, expiresAt: wire.expiresAt, count: rows.length }
  return { body: JSON.stringify(wire), info }
}

export const loadMeta = (kv: KVNamespace) => load<MetaInfo>(kv, META_KEY, refreshMeta)

/** Metadata only; never triggers a refresh. */
export async function peek(kv: KVNamespace) {
  const read = async <I>(key: string) => {
    const { value, metadata } = await kv.getWithMetadata<I>(key, 'stream')
    await value?.cancel()
    return metadata
  }
  const [quotes, meta] = await Promise.all([read<QuotesInfo>(QUOTES_KEY), read<MetaInfo>(META_KEY)])
  return { quotes, meta }
}
