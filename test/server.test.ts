import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseHeaders, staticAssets } from '../server/assets'
import { listener } from '../server/http'
import { fileKv } from '../server/kv'
import { siteOrigin, withShareOrigin } from '../shared/site'
import worker from '../worker/index'
import { load } from '../worker/store'

const tmp = () => mkdtempSync(join(tmpdir(), 'stock-treemap-'))
const text = async (body: ReadableStream | string | null) => body == null ? null : typeof body === 'string' ? body : new Response(body).text()

describe('file-backed KV', () => {
  it('returns what was put, as a stream with its metadata', async () => {
    const kv = fileKv(tmp())
    await kv.put('quotes:us:v2', '{"a":1}', { metadata: { expiresAt: 5 } })
    const got = await kv.getWithMetadata('quotes:us:v2', { type: 'stream' })
    expect(await text(got.value)).toBe('{"a":1}')
    expect(got.metadata).toEqual({ expiresAt: 5 })
  })

  it('reports a missing key as null', async () => {
    const got = await fileKv(tmp()).getWithMetadata('nope', 'stream')
    expect(got.value).toBeNull()
    expect(got.metadata).toBeNull()
  })

  it('survives a restart', async () => {
    const dir = tmp()
    await fileKv(dir).put('k', 'line one\nline two', { metadata: { n: 1 } })
    const got = await fileKv(dir).getWithMetadata('k', 'stream')
    expect(await text(got.value)).toBe('line one\nline two')
    expect(got.metadata).toEqual({ n: 1 })
  })

  it('refuses reads the Worker code never makes', async () => {
    await expect(fileKv(tmp()).getWithMetadata('k', 'text' as 'stream')).rejects.toThrow('stream reads only')
  })

  it('lets `load` skip upstream after a restart while data is fresh', async () => {
    const dir = tmp()
    const key = `k${Math.random()}`
    const refresh = vi.fn(async () => ({ body: 'v1', info: { expiresAt: Date.now() + 60_000 } }))
    await load(fileKv(dir) as unknown as KVNamespace, key, refresh)
    const again = await load(fileKv(dir) as unknown as KVNamespace, key, refresh)
    expect(await text(again.body)).toBe('v1')
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

describe('static assets', () => {
  const root = tmp()
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'index.html'), '<!doctype html><p>app</p>')
  writeFileSync(join(root, 'assets', 'app-abc.js'), 'console.log(1)')
  writeFileSync(join(root, '_headers'), [
    '/*',
    '  X-Frame-Options: DENY',
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
  ].join('\n'))
  const assets = staticAssets(root)
  const get = (path: string, init?: RequestInit) => assets.fetch(new Request(`http://localhost${path}`, init))

  it('applies `_headers` rules on top of the default cache policy', async () => {
    const page = await get('/')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(page.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    expect(page.headers.get('x-frame-options')).toBe('DENY')

    const script = await get('/assets/app-abc.js')
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(script.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await script.text()).toBe('console.log(1)')
  })

  it('falls back to the app for client routes but not for missing files', async () => {
    expect(await (await get('/some/route')).text()).toContain('app')
    expect((await get('/assets/missing.js')).status).toBe(404)
    expect((await get('/../package.json')).status).toBe(404)
  })

  it('never serves the rules file itself', async () => {
    expect(await (await get('/_headers')).text()).not.toContain('Cache-Control')
  })

  it('revalidates with the ETag', async () => {
    const etag = (await get('/')).headers.get('etag')!
    expect((await get('/', { headers: { 'if-none-match': etag } })).status).toBe(304)
  })

  it('serves GET and HEAD only', async () => {
    expect((await get('/', { method: 'POST' })).status).toBe(405)
    expect(await (await get('/', { method: 'HEAD' })).text()).toBe('')
  })

  it('points share-card images at the configured origin', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'index.html'), '<meta property="og:image" content="/og.png" />')
    const page = await staticAssets(dir, { origin: 'https://stock.example.com' }).fetch(new Request('http://localhost/'))
    expect(await page.text()).toBe('<meta property="og:image" content="https://stock.example.com/og.png" />')
  })

  it('parses wildcards and placeholders', () => {
    const [rule] = parseHeaders('/posts/:slug/*\n  X-Test: 1')
    expect(rule!.pattern.test('/posts/hello/img.png')).toBe(true)
    expect(rule!.pattern.test('/posts/a/b')).toBe(true)
    expect(rule!.pattern.test('/other')).toBe(false)
  })
})

describe('share card origin', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const images = (h: string) => [...h.matchAll(/<meta (?:property|name)="(?:og|twitter):image" content="([^"]*)"/g)].map(m => m[1])

  it('rewrites every image tag in the page template', () => {
    expect(images(html)).toEqual(['/og.png'])
    expect(images(withShareOrigin(html, 'https://stock.example.com'))).toEqual(['https://stock.example.com/og.png'])
  })

  it('replaces an origin set at build time', () => {
    const built = withShareOrigin(html, 'https://a.example.com')
    expect(images(withShareOrigin(built, 'http://127.0.0.1:3000'))).toEqual(['http://127.0.0.1:3000/og.png'])
  })

  it('takes the origin of a full http(s) URL and rejects anything else', () => {
    expect(siteOrigin('https://stock.example.com/some/path?q=1')).toBe('https://stock.example.com')
    expect(siteOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
    expect(() => siteOrigin('stock.example.com')).toThrow('SITE_URL must be a full URL')
    expect(() => siteOrigin('ftp://stock.example.com')).toThrow('SITE_URL must be a full URL')
  })
})

describe('node http adapter', () => {
  const seen: Request[] = []
  let handler = async (request: Request): Promise<Response> => {
    seen.push(request)
    return new Response(JSON.stringify({ hello: 'world'.repeat(50) }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'etag': '"q1"' },
    })
  }
  const server = createServer(listener(request => handler(request)))
  let base: string
  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

  /** Raw request so the test, not undici, controls Accept-Encoding and decoding. */
  function raw(path: string, options: { method?: string, headers?: Record<string, string> } = {}) {
    return new Promise<{ status: number, headers: Record<string, string | string[] | undefined>, body: Buffer }>((resolve, reject) => {
      const req = httpRequest(`${base}${path}`, { method: options.method ?? 'GET', headers: options.headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }))
      })
      req.on('error', reject)
      req.end()
    })
  }

  it('compresses JSON for clients that accept it and weakens the ETag', async () => {
    const res = await raw('/api/x', { headers: { 'accept-encoding': 'gzip' } })
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(res.headers.vary).toContain('accept-encoding')
    expect(res.headers.etag).toBe('W/"q1"')
    expect(JSON.parse(gunzipSync(res.body).toString()).hello).toMatch(/^world/)
  })

  it('prefers brotli and skips encodings refused with q=0', async () => {
    expect((await raw('/', { headers: { 'accept-encoding': 'gzip, br' } })).headers['content-encoding']).toBe('br')
    expect((await raw('/', { headers: { 'accept-encoding': 'br;q=0, gzip' } })).headers['content-encoding']).toBe('gzip')
    const plain = await raw('/')
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(plain.headers.etag).toBe('"q1"')
  })

  it('passes weak validators on as strong ones so the handler can answer 304', async () => {
    await raw('/', { headers: { 'if-none-match': 'W/"q1"' } })
    expect(seen.at(-1)!.headers.get('if-none-match')).toBe('"q1"')
  })

  it('keeps `//` in the path instead of reading it as a host', async () => {
    await raw('//evil.example/x')
    expect(new URL(seen.at(-1)!.url).pathname).toBe('//evil.example/x')
  })

  it('answers HEAD without a body and refuses TRACE', async () => {
    const head = await raw('/', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.body.length).toBe(0)
    expect((await raw('/', { method: 'TRACE' })).status).toBe(405)
  })

  it('turns a throwing handler into a 500', async () => {
    const previous = handler
    handler = async () => {
      throw new Error('boom')
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await raw('/')).status).toBe(500)
    }
    finally {
      handler = previous
      spy.mockRestore()
    }
  })
})

describe('worker handler on the self-hosted env', () => {
  it('answers a status request from the file-backed store', async () => {
    const env = { STORE: fileKv(tmp()), ASSETS: { fetch: () => new Response('asset') } } as unknown as Env
    const res = await worker.fetch(new Request('http://localhost/api/us/status') as Parameters<typeof worker.fetch>[0], env)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ market: 'us', quotes: null, meta: null })
  })
})
