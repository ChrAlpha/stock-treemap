import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { constants, createBrotliCompress, createGzip } from 'node:zlib'

// Node's http server ↔ the Fetch API handler shared with the Worker. On
// Cloudflare the edge compresses responses; here this adapter does.

type Handler = (request: Request) => Promise<Response>

const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|manifest\+json|xml)|image\/svg\+xml)/

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined)
      continue
    const joined = Array.isArray(value) ? value.join(', ') : value
    // Compressed responses carry weak ETags; If-None-Match compares weakly anyway.
    headers.set(name, name === 'if-none-match' ? joined.replaceAll('W/', '') : joined)
  }
  // Only GET and HEAD are served, so request bodies are never read. The path is
  // appended rather than resolved so `//x` stays a path, not a host.
  const path = req.url?.startsWith('/') ? req.url : '/'
  return new Request(`http://localhost${path}`, { method: req.method, headers })
}

function encodingFor(req: IncomingMessage, headers: Headers): 'br' | 'gzip' | null {
  if (headers.has('content-encoding') || headers.get('cache-control')?.includes('no-transform'))
    return null
  const accepted = new Map<string, number>()
  for (const part of String(req.headers['accept-encoding'] ?? '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    const q = params.map(p => p.trim().match(/^q=([\d.]+)$/)?.[1]).find(Boolean)
    accepted.set(name!, q === undefined ? 1 : Number(q))
  }
  if ((accepted.get('br') ?? 0) > 0)
    return 'br'
  if ((accepted.get('gzip') ?? 0) > 0)
    return 'gzip'
  return null
}

async function send(req: IncomingMessage, res: ServerResponse, response: Response) {
  const headers = new Headers(response.headers)
  const compressible = (response.status === 200 || response.status === 304) && COMPRESSIBLE.test(headers.get('content-type') ?? '')
  const encoding = compressible ? encodingFor(req, headers) : null
  if (compressible)
    headers.append('vary', 'accept-encoding')
  if (encoding) {
    headers.set('content-encoding', encoding)
    headers.delete('content-length')
    const etag = headers.get('etag')
    if (etag && !etag.startsWith('W/'))
      headers.set('etag', `W/${etag}`)
  }
  res.writeHead(response.status, Object.fromEntries(headers))

  if (!response.body || req.method === 'HEAD') {
    await response.body?.cancel()
    res.end()
    return
  }
  // Same object at runtime; the Workers and Node typings just disagree.
  const body = Readable.fromWeb(response.body as unknown as NodeReadableStream)
  if (encoding === 'br')
    await pipeline(body, createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }), res)
  else if (encoding === 'gzip')
    await pipeline(body, createGzip(), res)
  else
    await pipeline(body, res)
}

export function listener(handle: Handler) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    let request: Request | undefined
    let response: Response
    try {
      request = toRequest(req)
      response = await handle(request)
    }
    catch (err) {
      // The Fetch API refuses some methods (TRACE, CONNECT) outright.
      if (!request) {
        response = new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
      }
      else {
        console.error('request failed', req.method, req.url, err)
        response = new Response('Internal Server Error', { status: 500 })
      }
    }
    try {
      await send(req, res, response)
    }
    catch (err) {
      // Clients hanging up mid-response are routine.
      if ((err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE')
        console.error('response failed', req.method, req.url, err)
      res.destroy()
    }
  }
}
