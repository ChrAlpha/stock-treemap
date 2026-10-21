import type { MarketId } from '../shared/markets'
import { marketClock } from '../shared/clock'
import { isMarketId, MARKETS } from '../shared/markets'
import { loadMeta, loadQuotes, peek } from './store'

// No cron, no background polling: upstream is touched only when a request
// arrives and the stored data has expired. Every market has its own paths,
// cache entries and KV keys, so opening one market refreshes that market only.
//
// Workers Caching (wrangler.jsonc → cache.enabled) sits in front of this
// handler. Repeat requests are answered from Cloudflare's tiered cache without
// invoking the Worker, concurrent misses are collapsed into one invocation,
// and `stale-while-revalidate` lets visitors get the previous response while
// the refresh runs. The edge TTL follows the data's own expiry.
//
// These endpoints exist only to feed this site's own page. They send no CORS
// headers and are not a public API: the upstream data is not ours to
// redistribute.

interface CachePolicy {
  /** Longest a browser may reuse a response without revalidating. */
  browser: number
  /** How long the edge may keep serving it stale while refreshing. */
  swr: number
}

const QUOTES_POLICY: CachePolicy = { browser: 30, swr: 1800 }
const META_POLICY: CachePolicy = { browser: 3600, swr: 86400 }
// Upstream failed: hold the old data briefly, then try again.
const STALE_RETRY = 30

function headersFor(expiresAt: number, policy: CachePolicy, stale?: string): Record<string, string> {
  const remaining = stale ? STALE_RETRY : Math.min(Math.max(Math.round((expiresAt - Date.now()) / 1000), 5), 3600)
  return {
    'cache-control': `public, max-age=${Math.min(remaining, policy.browser)}`,
    // Edge-only; Cloudflare strips it before the response leaves.
    'cloudflare-cdn-cache-control': `public, max-age=${remaining}, stale-while-revalidate=${policy.swr}`,
  }
}

function respond(request: Request, body: ReadableStream | string, etag: string, headers: Record<string, string>) {
  const all = { 'content-type': 'application/json; charset=utf-8', etag, ...headers }
  const notModified = request.headers.get('if-none-match')?.split(/\s*,\s*/).includes(etag) ?? false
  if (notModified || request.method === 'HEAD') {
    if (body instanceof ReadableStream)
      void body.cancel()
    return new Response(null, { status: notModified ? 304 : 200, headers: all })
  }
  return new Response(body, { headers: all })
}

function problem(status: number, error: string, message: string, maxAge = 3600) {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${maxAge}` },
  })
}

/** Diagnostics for whoever is debugging a response; the page itself reads the body. */
function dataHeaders(info: { fetchedAt: number, expiresAt: number, source?: string }, stale?: string): Record<string, string> {
  const h: Record<string, string> = {
    'x-data-fetched-at': new Date(info.fetchedAt).toISOString(),
    'x-data-expires-at': new Date(info.expiresAt).toISOString(),
  }
  if (info.source)
    h['x-data-source'] = info.source
  if (stale)
    h['x-data-stale'] = stale.slice(0, 200)
  return h
}

async function quotes(request: Request, env: Env, market: MarketId) {
  let loaded
  try {
    loaded = await loadQuotes(env.STORE, market)
  }
  catch {
    return problem(503, 'unavailable', '行情源暂时不可用，稍后重试', 15)
  }
  const { body, info, stale } = loaded
  return respond(request, body, `"q${info.fetchedAt}"`, {
    ...headersFor(info.expiresAt, QUOTES_POLICY, stale),
    ...dataHeaders(info, stale),
  })
}

async function meta(request: Request, env: Env, market: MarketId) {
  let loaded
  try {
    loaded = await loadMeta(env.STORE, market)
  }
  catch {
    return problem(503, 'unavailable', '基础数据暂时不可用，稍后重试', 15)
  }
  const { body, info, stale } = loaded
  return respond(request, body, `"m${info.updatedAt}"`, {
    ...headersFor(info.expiresAt, META_POLICY, stale),
    ...dataHeaders({ fetchedAt: info.updatedAt, expiresAt: info.expiresAt }, stale),
  })
}

async function status(env: Env, market: MarketId) {
  const { quotes: q, meta: m } = await peek(env.STORE, market)
  const now = Date.now()
  return new Response(JSON.stringify({
    market,
    phase: marketClock(MARKETS[market], new Date(now)).phase,
    quotes: q && { ...q, ageSeconds: Math.round((now - q.fetchedAt) / 1000), fresh: now < q.expiresAt },
    meta: m && { ...m, ageSeconds: Math.round((now - m.updatedAt) / 1000), fresh: now < m.expiresAt },
  }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=15',
      'cloudflare-cdn-cache-control': 'public, max-age=15',
    },
  })
}

const ROUTE = /^\/api\/([a-z]{2})\/(quotes|meta|status)$/

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return problem(405, 'method_not_allowed', '只支持 GET')

  const match = url.pathname.replace(/\/$/, '').match(ROUTE)
  const market = match?.[1]
  if (!match || !isMarketId(market))
    return problem(404, 'not_found', '没有这个接口')
  // One URL per resource keeps the cache key space small: random query strings can't bust it.
  if (url.search)
    return problem(400, 'bad_request', '不接受查询参数')
  switch (match[2]) {
    case 'quotes': return quotes(request, env, market)
    case 'meta': return meta(request, env, market)
    default: return status(env, market)
  }
}

export default {
  async fetch(request, env) {
    if (!new URL(request.url).pathname.startsWith('/api/'))
      return env.ASSETS.fetch(request)
    return handle(request, env)
  },
} satisfies ExportedHandler<Env>
