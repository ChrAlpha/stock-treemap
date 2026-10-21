import type { Ref } from 'vue'
import type { MarketId } from '~shared/markets'
import type { Snapshot, WireMeta, WireQuotes } from '~shared/snapshot'
import { useDocumentVisibility } from '@vueuse/core'
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { marketClock } from '~shared/clock'
import { MARKETS } from '~shared/markets'
import { joinSnapshot } from '~shared/snapshot'

export type LoadState = 'loading' | 'ready' | 'error'

// Markets load lazily: only the one on screen is fetched and polled. Others
// keep whatever they last had in memory, so switching back is instant, and
// are only asked again once their data has turned over and they're on screen.

// Upper bound between polls; most of the time the data's own expiry comes first.
const MAX_WAIT = { regular: 60_000, pre: 120_000, post: 120_000, break: 600_000, closed: 600_000 } as const
// The edge may hand back the previous response while it refreshes; look again shortly.
const STALE_RECHECK = 5_000
const MAX_RECHECKS = 3
// Flicking through the market list shouldn't request every market on the way.
const SWITCH_SETTLE = 250

interface Cached<T> { tag: string | null, data: T }

interface Entry {
  meta: Cached<WireMeta> | null
  quotes: Cached<WireQuotes> | null
  snapshot: Snapshot | null
  checkedAt: number
}

async function get<T>(path: string, prev: Cached<T> | null, signal: AbortSignal): Promise<Cached<T>> {
  // no-cache: the browser revalidates with If-None-Match; an unchanged response comes back as a 304.
  const res = await fetch(path, { cache: 'no-cache', headers: { accept: 'application/json' }, signal })
  if (!res.ok)
    throw new Error(`${path}: HTTP ${res.status}`)
  const tag = res.headers.get('etag')
  if (prev && tag && tag === prev.tag)
    return prev
  return { tag, data: await res.json() as T }
}

export function useSnapshot(market: Ref<MarketId>) {
  const snapshot = shallowRef<Snapshot | null>(null)
  const state = ref<LoadState>('loading')
  /** The latest poll failed; what's on screen is from an earlier one. */
  const offline = ref(false)
  /** When the server last answered. */
  const checkedAt = ref(0)

  const entries = new Map<MarketId, Entry>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastPoll = 0
  let rechecks = 0
  let current: { market: MarketId, ctl: AbortController } | null = null

  function entryOf(m: MarketId) {
    let e = entries.get(m)
    if (!e)
      entries.set(m, (e = { meta: null, quotes: null, snapshot: null, checkedAt: 0 }))
    return e
  }

  function plan(ms: number) {
    clearTimeout(timer)
    timer = setTimeout(load, Math.max(ms, 200))
  }

  function nextDelay(m: MarketId, q: WireQuotes) {
    const now = Date.now()
    const cap = MAX_WAIT[marketClock(MARKETS[m]).phase]
    if (now > q.expiresAt + 10_000 && rechecks < MAX_RECHECKS) {
      rechecks++
      return STALE_RECHECK
    }
    rechecks = 0
    // Just after the data is due to turn over, with a little jitter so tabs don't move in lockstep.
    return Math.min(Math.max(q.expiresAt - now, 0) + 2_000 + Math.random() * 3_000, cap)
  }

  async function load() {
    const m = market.value
    if (current?.market === m)
      return
    current?.ctl.abort()
    const me = (current = { market: m, ctl: new AbortController() })
    lastPoll = Date.now()
    const e = entryOf(m)
    try {
      const metaDue = !e.meta || Date.now() > e.meta.data.expiresAt
      const [meta, quotes] = await Promise.all([
        metaDue ? get<WireMeta>(`/api/${m}/meta`, e.meta, me.ctl.signal) : Promise.resolve(e.meta!),
        get<WireQuotes>(`/api/${m}/quotes`, e.quotes, me.ctl.signal),
      ])
      if (meta !== e.meta || quotes !== e.quotes || !e.snapshot) {
        e.meta = meta
        e.quotes = quotes
        e.snapshot = joinSnapshot(meta.data, quotes.data)
      }
      e.checkedAt = Date.now()
      if (current !== me)
        return
      snapshot.value = e.snapshot
      state.value = 'ready'
      offline.value = false
      checkedAt.value = e.checkedAt
      plan(nextDelay(m, quotes.data))
    }
    catch {
      // Superseded by a switch to another market: that load owns the screen now.
      if (current !== me)
        return
      offline.value = true
      if (!snapshot.value)
        state.value = 'error'
      plan(20_000)
    }
    finally {
      if (current === me)
        current = null
    }
  }

  // Sync, so the map never renders one market's spec over another's data.
  watch(market, (m) => {
    clearTimeout(timer)
    current?.ctl.abort()
    current = null
    rechecks = 0
    const e = entries.get(m)
    snapshot.value = e?.snapshot ?? null
    state.value = e?.snapshot ? 'ready' : 'loading'
    offline.value = false
    checkedAt.value = e?.checkedAt ?? 0
    if (e?.quotes && Date.now() < e.quotes.data.expiresAt)
      plan(nextDelay(m, e.quotes.data))
    else
      plan(SWITCH_SETTLE)
  }, { flush: 'sync' })

  const visibility = useDocumentVisibility()
  watch(visibility, (v) => {
    const q = entries.get(market.value)?.quotes
    if (v === 'hidden')
      clearTimeout(timer)
    else if (Date.now() - lastPoll > 30_000)
      load()
    else if (q)
      plan(nextDelay(market.value, q.data))
  })

  load()
  onBeforeUnmount(() => {
    clearTimeout(timer)
    current?.ctl.abort()
  })

  return { snapshot, state, offline, checkedAt, reload: load }
}
