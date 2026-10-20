import type { Snapshot, WireMeta, WireQuotes } from '~shared/snapshot'
import { useDocumentVisibility } from '@vueuse/core'
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { marketClock } from '~shared/market'
import { joinSnapshot } from '~shared/snapshot'

export type LoadState = 'loading' | 'ready' | 'error'

// Upper bound between polls; most of the time the data's own expiry comes first.
const MAX_WAIT = { regular: 60_000, pre: 120_000, post: 120_000, closed: 600_000 } as const
// The edge may hand back the previous response while it refreshes; look again shortly.
const STALE_RECHECK = 5_000
const MAX_RECHECKS = 3

interface Cached<T> { tag: string | null, data: T }

async function get<T>(path: string, prev: Cached<T> | null): Promise<Cached<T>> {
  // no-cache: the browser revalidates with If-None-Match; an unchanged response comes back as a 304.
  const res = await fetch(path, { cache: 'no-cache', headers: { accept: 'application/json' } })
  if (!res.ok)
    throw new Error(`${path}: HTTP ${res.status}`)
  const tag = res.headers.get('etag')
  if (prev && tag && tag === prev.tag)
    return prev
  return { tag, data: await res.json() as T }
}

export function useSnapshot() {
  const snapshot = shallowRef<Snapshot | null>(null)
  const state = ref<LoadState>('loading')
  /** The latest poll failed; what's on screen is from an earlier one. */
  const offline = ref(false)
  /** When the server last answered. */
  const checkedAt = ref(0)

  let meta: Cached<WireMeta> | null = null
  let quotes: Cached<WireQuotes> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastPoll = 0
  let rechecks = 0
  let inflight = false

  function plan(ms: number) {
    clearTimeout(timer)
    timer = setTimeout(load, Math.max(ms, 1_000))
  }

  function nextDelay(q: WireQuotes) {
    const now = Date.now()
    const cap = MAX_WAIT[marketClock().phase]
    if (now > q.expiresAt + 10_000 && rechecks < MAX_RECHECKS) {
      rechecks++
      return STALE_RECHECK
    }
    rechecks = 0
    // Just after the data is due to turn over, with a little jitter so tabs don't move in lockstep.
    return Math.min(Math.max(q.expiresAt - now, 0) + 2_000 + Math.random() * 3_000, cap)
  }

  async function load() {
    if (inflight)
      return
    inflight = true
    lastPoll = Date.now()
    try {
      const metaDue = !meta || Date.now() > meta.data.expiresAt
      const [m, q] = await Promise.all([
        metaDue ? get<WireMeta>('/api/meta', meta) : Promise.resolve(meta!),
        get<WireQuotes>('/api/quotes', quotes),
      ])
      if (m !== meta || q !== quotes) {
        meta = m
        quotes = q
        snapshot.value = joinSnapshot(m.data, q.data)
        // A listing newer than our reference data: pick up fresh meta on the next poll.
        if (snapshot.value.unmatched > 25)
          meta = { ...m, data: { ...m.data, expiresAt: 0 } }
      }
      state.value = 'ready'
      offline.value = false
      checkedAt.value = Date.now()
      plan(nextDelay(q.data))
    }
    catch {
      offline.value = true
      if (!snapshot.value)
        state.value = 'error'
      plan(20_000)
    }
    finally {
      inflight = false
    }
  }

  const visibility = useDocumentVisibility()
  watch(visibility, (v) => {
    if (v === 'hidden')
      clearTimeout(timer)
    else if (Date.now() - lastPoll > 30_000)
      load()
    else if (quotes)
      plan(nextDelay(quotes.data))
  })

  load()
  onBeforeUnmount(() => clearTimeout(timer))

  return { snapshot, state, offline, checkedAt, reload: load }
}
