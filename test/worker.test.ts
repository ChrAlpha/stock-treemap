import { beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../worker/index'
import { load } from '../worker/store'
import { baseTicker, memberKeys } from '../worker/tradingview'

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
  kv.data.set('quotes:v1', { value: '{}', metadata: { fetchedAt: Date.now(), expiresAt: Date.now() + 60_000, source: 'tradingview', count: 0 } })
  const env = { STORE: kv, ASSETS: { fetch: async () => new Response('asset') } } as unknown as Env
  const call = (path: string, method = 'GET') =>
    worker.fetch!(new Request(`https://example.test${path}`, { method }) as never, env, {} as ExecutionContext)

  it('serves the data the page needs, same-origin only', async () => {
    for (const path of ['/api/quotes', '/api/status']) {
      const res = await call(path)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('access-control-allow-origin'), path).toBeNull()
    }
  })

  it('offers no public API: no directory, derived views or preflight', async () => {
    for (const path of ['/api/v1', '/api/v1/quotes', '/api/v1/meta', '/api/v1/stocks', '/api/v1/sectors', '/api/stocks', '/api/sectors'])
      expect((await call(path)).status, path).toBe(404)
    expect((await call('/api/quotes', 'OPTIONS')).status).toBe(405)
  })
})
