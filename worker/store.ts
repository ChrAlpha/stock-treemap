import type { MarketId } from '../shared/markets'
import type { MetaInfo, QuotesInfo, Refreshed } from './refresh'
import { refreshMeta, refreshQuotes } from './refresh'

// On-demand data: nothing is fetched until a request needs it, and each market
// is stored and refreshed on its own. A request that finds a market's stored
// data past its expiry refreshes that market alone from upstream, writes it
// back to KV and serves it; Workers Caching in front collapses concurrent
// requests, so a burst of visitors still produces one upstream call per data
// centre tier.

const quotesKey = (m: MarketId) => `quotes:${m}:v2`
const metaKey = (m: MarketId) => `meta:${m}:v2`

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
      .then((result) => {
        lastFailure.delete(key)
        return result
      }, (err) => {
        lastFailure.set(key, Date.now())
        throw err
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, p)
  }
  return p
}

/**
 * The value stored under `key` while it's fresh; otherwise a refresh, stored
 * and returned. If the refresh fails, the stored value is served marked stale.
 */
export async function load<I extends { expiresAt: number }>(
  kv: KVNamespace,
  key: string,
  refresh: (previous: I | null) => Promise<Refreshed<I>>,
): Promise<Loaded<I>> {
  const stored = await kv.getWithMetadata<I>(key, { type: 'stream', cacheTtl: 30 })
  const held = stored.value && stored.metadata ? { body: stored.value, info: stored.metadata } : null
  const now = Date.now()
  if (held && now < held.info.expiresAt)
    return held

  if (held && now - (lastFailure.get(key) ?? 0) < RETRY_AFTER)
    return { ...held, stale: 'upstream recently failed' }

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
    if (held)
      return { ...held, stale: String(err) }
    await stored.value?.cancel()
    throw err
  }
}

export const loadQuotes = (kv: KVNamespace, id: MarketId) => load<QuotesInfo>(kv, quotesKey(id), prev => refreshQuotes(id, prev))

export const loadMeta = (kv: KVNamespace, id: MarketId) => load<MetaInfo>(kv, metaKey(id), prev => refreshMeta(id, prev))

/** Metadata only; never triggers a refresh. */
export async function peek(kv: KVNamespace, id: MarketId) {
  const read = async <I>(key: string) => {
    const { value, metadata } = await kv.getWithMetadata<I>(key, 'stream')
    await value?.cancel()
    return metadata
  }
  const [quotes, meta] = await Promise.all([read<QuotesInfo>(quotesKey(id)), read<MetaInfo>(metaKey(id))])
  return { quotes, meta }
}
