import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { withShareOrigin } from '../shared/site'

// Serves the client build the way Workers Static Assets does for this project:
// `_headers` rules, single-page-application fallback and ETag revalidation.
// The build is a handful of files, so they are read once at startup.

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

// Workers' cache policy for assets that no `_headers` rule covers.
const DEFAULT_CACHE = 'public, max-age=0, must-revalidate'
// Platform files that configure the server rather than being served.
const HIDDEN = new Set(['/_headers', '/_redirects', '/.assetsignore'])

interface Rule {
  pattern: RegExp
  headers: [name: string, value: string][]
}

/** Path rules from a `_headers` file; `*` and `:name` wildcards. Host-qualified rules never match here. */
export function parseHeaders(text: string): Rule[] {
  const rules: Rule[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#'))
      continue
    if (!/^\s/.test(line)) {
      const source = trimmed.startsWith('/')
        ? trimmed.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/:\w+/g, '[^/]+')
        : '(?!)'
      rules.push({ pattern: new RegExp(`^${source}$`), headers: [] })
      continue
    }
    const header = trimmed.match(/^([^:]+):\s*(.*)$/)
    if (header)
      rules.at(-1)?.headers.push([header[1]!.trim().toLowerCase(), header[2]!])
  }
  return rules
}

function headersFor(path: string, body: Buffer, rules: Rule[]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const rule of rules) {
    if (!rule.pattern.test(path))
      continue
    // Like Workers: a header set by several matching rules keeps every value.
    for (const [name, value] of rule.headers)
      headers[name] = headers[name] ? `${headers[name]}, ${value}` : value
  }
  return {
    'cache-control': DEFAULT_CACHE,
    ...headers,
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    'etag': `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`,
  }
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory())
      yield* walk(path)
    else if (entry.isFile())
      yield path
  }
}

/** `origin`: the site's public origin, for share-card links in the HTML. */
export function staticAssets(root: string, { origin }: { origin?: string } = {}) {
  if (!existsSync(join(root, 'index.html')))
    throw new Error(`No client build at ${root}; run \`pnpm build\` first`)
  const rulesFile = join(root, '_headers')
  const rules = existsSync(rulesFile) ? parseHeaders(readFileSync(rulesFile, 'utf8')) : []

  const files = new Map<string, { body: Buffer, headers: Record<string, string> }>()
  for (const file of walk(root)) {
    const path = `/${relative(root, file).split(sep).join('/')}`
    if (HIDDEN.has(path))
      continue
    let body = readFileSync(file)
    if (origin && extname(path) === '.html')
      body = Buffer.from(withShareOrigin(body.toString('utf8'), origin))
    files.set(path, { body, headers: headersFor(path, body, rules) })
  }

  return {
    async fetch(request: Request): Promise<Response> {
      if (request.method !== 'GET' && request.method !== 'HEAD')
        return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
      let path: string
      try {
        path = decodeURIComponent(new URL(request.url).pathname)
      }
      catch {
        return new Response('Bad Request', { status: 400 })
      }
      // Lookups only ever hit files found at startup, so `..` can't escape the root.
      const asset = files.get(path)
        ?? (path.endsWith('/') ? files.get(`${path}index.html`) : undefined)
        // Client-side routes have no extension; a missing file with one is a real 404.
        ?? (extname(path) ? undefined : files.get('/index.html'))
      if (!asset)
        return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
      if (request.headers.get('if-none-match')?.split(/\s*,\s*/).includes(asset.headers.etag!))
        return new Response(null, { status: 304, headers: asset.headers })
      return new Response(request.method === 'HEAD' ? null : asset.body, { headers: asset.headers })
    },
  }
}
