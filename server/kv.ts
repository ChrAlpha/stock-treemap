import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The slice of Workers KV that worker/store.ts uses, held in memory and
// mirrored to one file per key so a restart doesn't refetch every market.
// One process owns the directory; there is no cross-process locking.

interface Entry {
  value: string
  metadata: unknown
}

export function fileKv(dir: string) {
  const memory = new Map<string, Promise<Entry | null>>()
  const writes = new Map<string, Promise<void>>()
  const ready = mkdir(dir, { recursive: true })
  const file = (key: string) => join(dir, `${encodeURIComponent(key)}.kv`)

  function read(key: string) {
    let entry = memory.get(key)
    if (!entry) {
      // File layout: metadata JSON on the first line, the value after it.
      entry = readFile(file(key), 'utf8').then(
        (raw) => {
          const nl = raw.indexOf('\n')
          return { metadata: JSON.parse(raw.slice(0, nl)), value: raw.slice(nl + 1) }
        },
        (err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT')
            console.error('KV read failed', key, String(err))
          return null
        },
      )
      memory.set(key, entry)
    }
    return entry
  }

  async function persist(key: string, entry: Entry) {
    await ready
    const tmp = `${file(key)}.${randomUUID()}.tmp`
    await writeFile(tmp, `${JSON.stringify(entry.metadata)}\n${entry.value}`)
    await rename(tmp, file(key))
  }

  return {
    async getWithMetadata(key: string, options: 'stream' | { type: 'stream' }) {
      const type = typeof options === 'string' ? options : options.type
      if (type !== 'stream')
        throw new Error(`fileKv supports stream reads only, got ${String(type)}`)
      const entry = await read(key)
      return { value: entry && new Response(entry.value).body, metadata: entry?.metadata ?? null, cacheStatus: null }
    },

    async put(key: string, value: string, options?: { metadata?: unknown }) {
      if (typeof value !== 'string')
        throw new TypeError('fileKv stores strings only')
      const entry = { value, metadata: options?.metadata ?? null }
      memory.set(key, Promise.resolve(entry))
      // Writes to one key land in call order.
      const done = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(() => persist(key, entry))
      writes.set(key, done)
      await done
    },

    /** Resolves once every write issued so far is on disk. */
    async flush() {
      await Promise.allSettled(writes.values())
    },
  }
}
