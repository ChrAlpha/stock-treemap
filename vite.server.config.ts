import { defineConfig } from 'vite'

// Self-hosted server: server/ plus the worker/ and shared/ code it runs, as a
// single ESM file with no runtime dependencies. Run after `pnpm build`, which
// produces the client files it serves (dist/client).
export default defineConfig({
  publicDir: false,
  ssr: { noExternal: true },
  build: {
    ssr: 'server/index.ts',
    outDir: 'dist/server',
    emptyOutDir: true,
    target: 'node24',
    rolldownOptions: { output: { entryFileNames: 'index.mjs' } },
  },
})
