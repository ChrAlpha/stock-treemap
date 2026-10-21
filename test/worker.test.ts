import type { WireQuotes } from '../shared/snapshot'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../worker/index'
import { SOURCES } from '../worker/sources'
import { load, loadQuotes } from '../worker/store'
import { baseTicker, fetchQuotes, memberKeys, resetThrottle } from '../worker/tradingview'

/** Just enough of KVNamespace for `load`. */
function memoryKv() {
  const data = new Map<string, { value: string, metadata: unknown }>()
  return {
    data,
    async getWithMetadata(key: string) {
      const hit = data.get(key)
      if (!hit)
        return { value: null, metadata: null }
      return { value: new Response(hit.value).body, metadata: hit.metadata }
    },
    async put(key: string, value: string, opts: { metadata: unknown }) {
      data.set(key, { value, metadata: opts.metadata })
    },
  } as unknown as KVNamespace & { data: typeof data }
}

const text = async (body: ReadableStream | string) => typeof body === 'string' ? body : new Response(body).text()

describe('on-demand load', () => {
  let kv: ReturnType<typeof memoryKv>
  let key: string
  beforeEach(() => {
    kv = memoryKv()
    // Fresh key per test: failure back-off is tracked per key at module level.
    key = `k${Math.random()}`
  })

  it('fetches once when nothing is stored, then serves from storage', async () => {
    const refresh = vi.fn(async () => ({ body: 'v1', info: { expiresAt: Date.now() + 60_000 } }))
    expect(await text((await load(kv, key, refresh)).body)).toBe('v1')
    expect(await text((await load(kv, key, refresh)).body)).toBe('v1')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('refreshes expired data and passes the previous info along', async () => {
    await kv.put(key, 'old', { metadata: { expiresAt: Date.now() - 1 } })
    const refresh = vi.fn(async (prev: { expiresAt: number } | null) => ({ body: `new after ${prev?.expiresAt ? 'old' : 'none'}`, info: { expiresAt: Date.now() + 60_000 } }))
    expect(await text((await load(kv, key, refresh)).body)).toBe('new after old')
    expect(kv.data.get(key)?.value).toBe('new after old')
  })

  it('collapses concurrent refreshes in one isolate', async () => {
    let calls = 0
    const refresh = async () => {
      calls++
      await new Promise(r => setTimeout(r, 20))
      return { body: 'v', info: { expiresAt: Date.now() + 60_000 } }
    }
    await Promise.all(Array.from({ length: 5 }, () => load(kv, key, refresh)))
    expect(calls).toBe(1)
  })

  it('serves stored data when upstream fails, and backs off before retrying', async () => {
    await kv.put(key, 'old', { metadata: { expiresAt: Date.now() - 1 } })
    const refresh = vi.fn(async () => {
      throw new Error('upstream down')
    })
    const first = await load(kv, key, refresh)
    expect(await text(first.body)).toBe('old')
    expect(first.stale).toContain('upstream down')
    const second = await load(kv, key, refresh)
    expect(await text(second.body)).toBe('old')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('surfaces the error when there is nothing to fall back to', async () => {
    await expect(load(kv, key, async () => {
      throw new Error('upstream down')
    })).rejects.toThrow('upstream down')
  })
})

describe('index membership keys', () => {
  it('matches share classes by ticker base', () => {
    expect(baseTicker('BRK.B')).toBe('BRK')
    expect(baseTicker('BF.A')).toBe('BF')
    expect(baseTicker('GOOGL')).toBe('GOOGL')
  })
  it('matches share classes by company name without the class suffix', () => {
    expect(memberKeys('GOOGL', 'Alphabet Inc. Class A')).toContain('name:Alphabet Inc.')
    expect(memberKeys('GOOG', 'Alphabet Inc.')).toContain('name:Alphabet Inc.')
  })
})

describe('routes', () => {
  // Fresh quotes already in KV, so nothing reaches upstream.
  const kv = memoryKv()
  kv.data.set('quotes:us:v2', { value: '{}', metadata: { fetchedAt: Date.now(), expiresAt: Date.now() + 60_000, source: 'tradingview', count: 0 } })
  kv.data.set('meta:us:v2', { value: '{}', metadata: { updatedAt: Date.now(), expiresAt: Date.now() + 60_000, count: 0 } })
  const env = { STORE: kv, ASSETS: { fetch: async () => new Response('asset') } } as unknown as Env
  const call = (path: string, method = 'GET') =>
    worker.fetch!(new Request(`https://example.test${path}`, { method }) as never, env, {} as ExecutionContext)

  it('serves the data the page needs, same-origin only', async () => {
    for (const path of ['/api/us/quotes', '/api/us/status', '/api/hk/status']) {
      const res = await call(path)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('access-control-allow-origin'), path).toBeNull()
    }
  })

  it('labels quotes and meta alike for debugging', async () => {
    for (const path of ['/api/us/quotes', '/api/us/meta']) {
      const res = await call(path)
      expect(res.headers.get('x-data-fetched-at'), path).toBeTruthy()
      expect(res.headers.get('x-data-expires-at'), path).toBeTruthy()
    }
  })

  it('revalidates with the ETag and answers HEAD without a body', async () => {
    const etag = (await call('/api/us/quotes')).headers.get('etag')!
    const revalidated = await worker.fetch!(new Request('https://example.test/api/us/quotes', { headers: { 'if-none-match': etag } }) as never, env, {} as ExecutionContext)
    expect(revalidated.status).toBe(304)
    const head = await call('/api/us/meta', 'HEAD')
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })

  it('knows only the listed markets', async () => {
    for (const path of ['/api/xx/quotes', '/api/US/quotes', '/api/usa/quotes', '/api/us/stocks'])
      expect((await call(path)).status, path).toBe(404)
  })

  it('rejects query strings, so the cache can\'t be busted', async () => {
    expect((await call('/api/us/quotes?t=1')).status).toBe(400)
  })

  it('offers no public API: no directory, derived views or preflight', async () => {
    for (const path of ['/api/v1', '/api/v1/quotes', '/api/quotes', '/api/meta', '/api/status', '/api/stocks', '/api/sectors'])
      expect((await call(path)).status, path).toBe(404)
    expect((await call('/api/us/quotes', 'OPTIONS')).status).toBe(405)
  })
})

// ── Upstream ─────────────────────────────────────────────────────

const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init })

/** A scanner that answers quote and index requests for one market. */
function scanner(opts: { rows: number, session: string, tradeDay: string }) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    if (body.symbols?.tickers) {
      const day = Date.parse(`${opts.tradeDay}T00:00:00Z`) / 1000
      return json({ totalCount: 1, data: body.symbols.tickers.map((s: string) => ({ s, d: [4000, opts.session, day, 0.5, null, null, 1, 2, 3, 4, 5] })) })
    }
    const data = Array.from({ length: opts.rows }, (_, i) => ({ s: `SSE:${600000 + i}`, d: [10, 1e10 - i, 1e8, 1.23, 2, 3, 4, 5, 6] }))
    return json({ totalCount: data.length, data })
  })
}

describe('upstream politeness', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetThrottle()
  })

  it('pauses every market after a 429, without asking again', async () => {
    const fetch = vi.fn(async () => json({}, { status: 429, headers: { 'retry-after': '60' } }))
    vi.stubGlobal('fetch', fetch)
    await expect(fetchQuotes(SOURCES.hk)).rejects.toThrow('429')
    await expect(fetchQuotes(SOURCES.cn)).rejects.toThrow('slow down')
    await expect(fetchQuotes(SOURCES.us)).rejects.toThrow('slow down')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps only a few requests in flight at once', async () => {
    let active = 0
    let peak = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      peak = Math.max(peak, ++active)
      await new Promise(r => setTimeout(r, 10))
      active--
      return json({ totalCount: 0, data: [] })
    }))
    await Promise.all(Array.from({ length: 10 }, () => fetchQuotes(SOURCES.de)))
    expect(peak).toBeLessThanOrEqual(4)
  })
})

describe('market quotes', () => {
  // Tuesday 10:30 in Shanghai: the calendar says the market is open.
  const NOW = Date.parse('2026-10-20T02:30:00Z')
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    resetThrottle()
  })

  const read = async (kv: KVNamespace) => JSON.parse(await text((await loadQuotes(kv, 'cn')).body)) as WireQuotes

  it('refreshes one market from its own scanner only', async () => {
    const fetch = scanner({ rows: 1300, session: 'market', tradeDay: '2026-10-20' })
    vi.stubGlobal('fetch', fetch)
    const q = await read(memoryKv())
    expect(q).toMatchObject({ market: 'cn', holiday: false, tradeDate: '2026-10-20', expiresAt: NOW + 10 * 60_000 })
    expect(q.periods).not.toContain('pre')
    expect(q.indices.map(i => i.symbol)).toEqual(['CSI300', 'SSEC', 'SZI', 'CHINEXT'])
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(Array.from({ length: 2 }, () => 'https://scanner.tradingview.com/china/scan'))
  })

  it('notices an unlisted holiday and backs off', async () => {
    vi.stubGlobal('fetch', scanner({ rows: 1300, session: 'out_of_session', tradeDay: '2026-10-19' }))
    const q = await read(memoryKv())
    expect(q).toMatchObject({ holiday: true, tradeDate: '2026-10-19', expiresAt: NOW + 30 * 60_000 })
  })

  it('refuses a truncated response', async () => {
    vi.stubGlobal('fetch', scanner({ rows: 200, session: 'market', tradeDay: '2026-10-20' }))
    await expect(read(memoryKv())).rejects.toThrow('only 200 quote rows')
  })
})

describe('backup source', () => {
  // Tuesday 11:00 in New York; the last stored quotes are from Friday.
  const NOW = Date.parse('2026-10-20T15:00:00Z')
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    resetThrottle()
  })

  it('takes over when TradingView has been down since before the latest session', async () => {
    const kv = memoryKv()
    kv.data.set('quotes:us:v2', { value: '{}', metadata: { fetchedAt: Date.parse('2026-10-16T21:00:00Z'), expiresAt: NOW - 1, source: 'tradingview', count: 1200 } })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('https://scanner.tradingview.com'))
        return json({}, { status: 500 })
      const rows = Array.from({ length: 1200 }, (_, i) => ({ symbol: `S${i}`, lastsale: '$10.00', marketCap: '2,000,000,000', pctchange: '1.5%' }))
      return json({ data: { asof: 'Last price as of Oct 19, 2026', table: { rows } } })
    }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const q = JSON.parse(await text((await loadQuotes(kv, 'us')).body)) as WireQuotes
    expect(q).toMatchObject({ source: 'nasdaq', periods: ['d1'], expiresAt: NOW + 10 * 60_000 })
    expect(q.rows).toHaveLength(1200)
  })
})
