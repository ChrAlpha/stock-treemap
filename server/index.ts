import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import worker from '../worker/index'
import { staticAssets } from './assets'
import { listener } from './http'
import { fileKv } from './kv'

// Self-hosted runtime: the Worker's own request handler, run on Node. Workers
// KV becomes an in-memory store mirrored to DATA_DIR and Static Assets become
// the client build on disk. Nothing caches in front unless you put something
// there; upstream still sees at most one refresh per market per expiry,
// because the store's expiry check and single flight live in the handler.
// Getting it onto the internet (reverse proxy, tunnel, port forward) is up to you.

const port = Number(process.env.PORT || 3000)
const host = process.env.HOST || '127.0.0.1'
const dataDir = process.env.DATA_DIR || 'data'

const kv = fileKv(dataDir)
// Only the members the handler touches are provided: getWithMetadata/put and fetch.
const env = {
  STORE: kv,
  ASSETS: staticAssets(join(dirname(fileURLToPath(import.meta.url)), '../client')),
} as unknown as Env

// No `request.cf` off Cloudflare; the handler doesn't read it.
type WorkerRequest = Parameters<typeof worker.fetch>[0]
const server = createServer(listener(request => worker.fetch(request as WorkerRequest, env)))
server.listen(port, host, () => console.log(`stock-treemap listening on http://${host}:${port}, data in ${dataDir}`))

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  // Finish in-flight requests and pending writes, but don't outlast `docker stop`.
  process.once(signal, () => {
    setTimeout(() => process.exit(0), 8000).unref()
    server.close(() => kv.flush().then(() => process.exit(0)))
  })
}
